import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof runnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(),
  isWorktreeIsolationEnabled: () => true, setWorktreeIsolationEnabled: vi.fn(), pruneWorktrees: vi.fn(async () => {}),
}));

import { AgentManager } from "../src/agent-manager.js";
import type * as runnerModule from "../src/agent-runner.js";
import { type RunResult, resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { createWorktree } from "../src/worktree.js";
import { ctx, flush, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const template = readFileSync(resolve("examples/agents/research-reader.md"), "utf-8");

function session() {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final evidence" }] }],
    dispose: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    extensionRunner: { hasHandlers: () => true, emit: vi.fn(async () => {}) },
  } as unknown as AgentSession;
}
function result(child: AgentSession, extra: Partial<RunResult> = {}): RunResult {
  return { session: child, responseText: "final evidence", aborted: false, steered: false, ...extra };
}
function bus() {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter(h => h !== handler));
    },
    emit(event: string, data: unknown) { for (const handler of listeners.get(event) ?? []) handler(data); },
  };
}

describe("dispose_on_consume one-shot lifetime", () => {
  let env: ReturnType<typeof hermeticDir>;
  let manager: AgentManager;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    env = hermeticDir({ settings: { schedulingEnabled: false }, agentFiles: { "research-reader": template } });
    registerAgents(loadCustomAgents(env.dir));
    manager = new AgentManager();
  });
  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    await manager.dispose();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    env.restore();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function completed(extra: Partial<RunResult> = {}, background = true) {
    const child = session();
    vi.mocked(runAgent).mockResolvedValueOnce(result(child, extra));
    const options = { description: "question" };
    const id = background
      ? manager.spawn(makePi().pi, ctx(), "research-reader", "question", { ...options, isBackground: true })
      : (await manager.spawnAndWait(makePi().pi, ctx(), "research-reader", "question", options)).id;
    const record = manager.getRecord(id)!;
    await record.promise;
    return { id, record, child };
  }

  it("loads the exact restricted template through existing discovery", () => {
    const profile = loadCustomAgents(env.dir).get("research-reader")!;
    expect(profile).toMatchObject({
      builtinToolNames: ["read", "grep", "find", "ls"], extensions: false, skills: false,
      isolated: true, isolation: "off", inheritContext: false, promptMode: "replace",
      maxTurns: 8, persistSession: false, outputTranscript: true, disposeOnConsume: true,
    });
    expect(profile.extSelectors).toBeUndefined();
    expect(profile.allowedSubagents).toBeUndefined();
    expect(profile.memory).toBeUndefined();
    expect(profile.model).toBeUndefined();
    expect(profile.thinking).toBeUndefined();
    expect(loadCustomAgents(env.dir).get("general-purpose")?.disposeOnConsume).not.toBe(true);
  });

  it.each([
    [{}, "completed"], [{ failure: "provider failed" }, "error"],
    [{ steered: true }, "steered"], [{ aborted: true }, "aborted"],
  ] as const)("retains honest terminal status %s / %s until and after consumption", async (extra, status) => {
    const { id, child, record } = await completed(extra);
    expect(record.status).toBe(status);
    expect(child.dispose).not.toHaveBeenCalled(); // Completion/preview is not consumption.
    record.outputFile = "/tmp/retained.output";
    record.invocation = { modelId: "stub/reader", thinking: "low" };
    record.lifetimeUsage.input = 12;
    expect(await manager.resume(id, "again")).toBeUndefined(); // Even before disposal.
    expect(await manager.consumeResult(id)).toBe(true);
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(record.session).toBeUndefined();
    expect(record).toMatchObject({ status, result: "final evidence", outputFile: "/tmp/retained.output",
      invocation: { modelId: "stub/reader", thinking: "low" }, lifetimeUsage: { input: 12 },
      conversation: "[Assistant]: final evidence", resultConsumed: true });
    expect(manager.getRecord(id)).toBe(record);
    expect(await manager.resume(id, "again")).toBeUndefined();
  });

  it("automatically consumes foreground success and provider rejection without deadlocking", async () => {
    const { child, record } = await completed({}, false);
    expect(record.resultConsumed).toBe(true);
    expect(child.dispose).toHaveBeenCalledOnce();
    const failed = session();
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(failed);
      throw new Error("scripted failure");
    });
    const response = await manager.spawnAndWait(makePi().pi, ctx(), "research-reader", "question", { description: "fail" });
    expect(response.record.status).toBe("error");
    expect(response.record.error).toBe("scripted failure");
    expect(failed.dispose).toHaveBeenCalledOnce();
  });

  it("rejects early consume and stopped-but-settling cancellation; GC cannot release live SDK work", async () => {
    await manager.dispose();
    vi.useFakeTimers();
    manager = new AgentManager();
    let finish!: (value: RunResult) => void;
    const child = session();
    vi.mocked(runAgent).mockImplementationOnce((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(child);
      return new Promise(resolveRun => { finish = resolveRun; });
    });
    const id = manager.spawn(makePi().pi, ctx(), "research-reader", "go", { description: "go", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(await manager.consumeResult(id)).toBe(false);
    manager.abort(id);
    expect(record.status).toBe("stopped");
    expect(await manager.consumeResult(id)).toBe(false);
    manager.clearCompleted();
    expect(manager.getRecord(id)).toBe(record);
    record.completedAt = Date.now() - 700_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(id)).toBe(record);
    vi.useRealTimers();
    expect(child.dispose).not.toHaveBeenCalled();
    const disposing = manager.dispose();
    let done = false;
    void disposing.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    expect(child.dispose).not.toHaveBeenCalled();
    finish(result(child));
    await disposing;
    expect(record.status).toBe("stopped");
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("shares one release across duplicate consumption, eviction and parent shutdown", async () => {
    const { id, record, child } = await completed();
    let release!: () => void;
    vi.mocked(child.extensionRunner!.emit).mockImplementationOnce(() => new Promise<void>(r => { release = r; }) as never);
    const first = manager.consumeResult(id);
    const second = manager.consumeResult(id);
    record.sessionFile = "/sessions/must-not-reopen.jsonl";
    manager.clearCompleted();
    const disposed = manager.dispose();
    let done = false;
    void disposed.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    expect(manager.listTombstones()).toEqual([]);
    expect(child.extensionRunner!.emit).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await disposed;
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("default-off sessions remain resumable after consuming", async () => {
    const child = session();
    vi.mocked(runAgent).mockResolvedValueOnce(result(child));
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "continued" });
    const id = manager.spawn(makePi().pi, ctx(), "general-purpose", "go", { description: "go", isBackground: true });
    await manager.getRecord(id)!.promise;
    expect(await manager.consumeResult(id)).toBe(true);
    expect(child.dispose).not.toHaveBeenCalled();
    expect((await manager.resume(id, "continue"))?.result).toBe("continued");
    expect(resumeAgent).toHaveBeenCalledOnce();
  });

  it("refuses reopen and snapshots policy despite profile registry replacement", async () => {
    expect(() => manager.spawn(makePi().pi, ctx(), "research-reader", "go", {
      description: "go", resumeSessionFile: "/sessions/history.jsonl",
    })).toThrow("One-shot agents cannot reopen");
    const { id, child } = await completed();
    registerAgents(new Map());
    await manager.consumeResult(id);
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it.each(["handler", "dispose", "timeout"])("reports unconfirmed %s cleanup and never retries release", async (kind) => {
    const { id, child, record } = await completed();
    if (kind === "handler") vi.mocked(child.extensionRunner!.emit).mockRejectedValueOnce(new Error("cleanup broke"));
    if (kind === "dispose") vi.mocked(child.dispose).mockImplementationOnce(() => { throw new Error("cleanup broke"); });
    if (kind === "timeout") {
      vi.useFakeTimers();
      vi.mocked(child.extensionRunner!.emit).mockImplementationOnce(() => new Promise(() => {}) as never);
    }
    const consumption = manager.consumeResult(id);
    const rejected = expect(consumption).rejects.toThrow(/Child session/);
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
    expect(record.sessionCleanupError).toBeTruthy();
    expect(record.status).toBe("completed");
    expect(record.resultConsumed).toBe(true);
    await expect(manager.consumeResult(id)).rejects.toThrow(/Child session/);
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("RPC replies only after shared cleanup; failures reach the envelope", async () => {
    const { id, child } = await completed();
    const events = bus();
    registerRpcHandlers({ events, pi: makePi().pi, getCtx: ctx, manager });
    const reply = vi.fn();
    events.on("subagents:rpc:consume:reply:one", reply);
    vi.mocked(child.dispose).mockImplementationOnce(() => { throw new Error("cannot dispose"); });
    events.emit("subagents:rpc:consume", { requestId: "one", agentId: id });
    await flush();
    expect(reply).toHaveBeenCalledWith({ success: false, error: "Child session disposal failed: cannot dispose" });
  });

  it("queued stop never starts SDK work and its result can be consumed", async () => {
    await manager.dispose();
    manager = new AgentManager(undefined, 1);
    let finish!: (value: RunResult) => void;
    const child = session();
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const holder = manager.spawn(makePi().pi, ctx(), "research-reader", "holder", { description: "holder", isBackground: true });
    const queued = manager.spawn(makePi().pi, ctx(), "research-reader", "queued", { description: "queued", isBackground: true });
    expect(manager.getRecord(queued)?.status).toBe("queued");
    expect(await manager.consumeResult(queued)).toBe(false);
    manager.abort(queued);
    expect(await manager.consumeResult(queued)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    finish(result(child));
    await manager.getRecord(holder)!.promise;
  });

  it("the real RPC facade suppresses previews and awaits release using a handle", async () => {
    const booted = makePi();
    const events = bus();
    booted.pi.events = events;
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    const child = session();
    let finish!: (value: RunResult) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const spawnReply = vi.fn();
    events.on("subagents:rpc:spawn:reply:spawn", spawnReply);
    events.emit("subagents:rpc:spawn", { requestId: "spawn", type: "research-reader", prompt: "question",
      options: { description: "reader", isBackground: true, disposeOnConsume: false } });
    await flush();
    const id = spawnReply.mock.calls[0][0].data.id;
    const consumeReply = vi.fn();
    events.on("subagents:rpc:consume:reply:consume", consumeReply);
    events.emit("subagents:rpc:consume", { requestId: "consume", agentId: id });
    await flush();
    expect(consumeReply).toHaveBeenLastCalledWith({ success: false, error: "Agent not found or still running" });
    events.on("subagents:completed", () => {
      events.emit("subagents:rpc:consume", { requestId: "consume", agentId: "research-reader" });
    });
    finish(result(child));
    await flush();
    expect(consumeReply).toHaveBeenLastCalledWith({ success: true });
    expect(child.dispose).toHaveBeenCalledOnce(); // Caller cannot forge default-off lifetime.
    await new Promise(r => setTimeout(r, 250));
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, false])("real RPC detached isBackground=%s retains session until explicit consume", async (isBackground) => {
    const booted = makePi();
    const events = bus();
    booted.pi.events = events;
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    const child = session();
    vi.mocked(runAgent).mockResolvedValueOnce(result(child));
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:detached", reply);
    events.emit("subagents:rpc:spawn", { requestId: "detached", type: "research-reader", prompt: "question",
      options: { description: "detached", isBackground } });
    await flush();
    const id = reply.mock.calls[0][0].data.id;
    expect(child.dispose).not.toHaveBeenCalled();
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as AgentManager;
    expect(registry.getRecord(id)?.resultConsumed).not.toBe(true);
    const consumed = vi.fn();
    events.on("subagents:rpc:consume:reply:detached", consumed);
    events.emit("subagents:rpc:consume", { requestId: "detached", agentId: id });
    await flush();
    expect(consumed).toHaveBeenCalledWith({ success: true });
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it.each([undefined, false])("registry detached isBackground=%s retains session until get-result", async (isBackground) => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    const child = session();
    vi.mocked(runAgent).mockResolvedValueOnce(result(child));
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as AgentManager;
    const id = registry.spawn(booted.pi, ctx(), "research-reader", "question", { description: "registry", isBackground });
    await registry.getRecord(id)!.promise;
    expect(registry.getRecord(id)?.resultConsumed).not.toBe(true);
    expect(child.dispose).not.toHaveBeenCalled();
    await booted.tools.get("get_subagent_result").execute("get", { agent_id: id }, undefined, undefined, ctx());
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it.each(["RPC", "workflow"])("%s cannot override restricted profile before worktree creation", async (path) => {
    const child = session();
    vi.mocked(runAgent).mockResolvedValueOnce(result(child));
    const overrides = { description: "boundary", isolation: "worktree" as const,
      isolated: false, inheritContext: true, maxTurns: 999 };
    if (path === "RPC") {
      const booted = makePi();
      const events = bus();
      booted.pi.events = events;
      subagentsExtension(booted.pi);
      await booted.lifecycle.get("session_start")({}, ctx());
      shutdown = () => booted.lifecycle.get("session_shutdown")();
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:boundary", reply);
      events.emit("subagents:rpc:spawn", { requestId: "boundary", type: "research-reader", prompt: "question", options: overrides });
      await flush();
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    } else {
      await manager.spawnAndWait(makePi().pi, ctx(), "research-reader", "question", { ...overrides, workflowId: "host-workflow" });
    }
    expect(createWorktree).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "research-reader", "question", expect.objectContaining({
      maxTurns: 8, isolated: true, inheritContext: false, worktreeBase: undefined,
    }));
  });

  it("trusted nested snapshot does not inherit parent registry restrictions", async () => {
    const child = session();
    vi.mocked(runAgent).mockResolvedValueOnce(result(child));
    const id = manager.spawn(makePi().pi, ctx(), "research-reader", "question", {
      description: "nested", parentAgentId: "parent", disposeOnConsume: false,
      maxTurns: 17, isolated: false, inheritContext: true,
    });
    await manager.getRecord(id)!.promise;
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "research-reader", "question", expect.objectContaining({
      disposeOnConsume: false, maxTurns: 17, isolated: false, inheritContext: true,
    }));
    expect(child.dispose).not.toHaveBeenCalled();
  });

  it("foreground tool returns honest cleanup failures without replacing partial status", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    const child = session();
    vi.mocked(child.dispose).mockImplementationOnce(() => { throw new Error("cannot dispose"); });
    vi.mocked(runAgent).mockResolvedValueOnce(result(child, { steered: true }));
    const response = await booted.tools.get("Agent").execute("launch", {
      subagent_type: "research-reader", description: "read", prompt: "question", run_in_background: false,
    }, undefined, undefined, ctx());
    expect(response.details.status).toBe("steered");
    expect(textOf(response)).toContain("Session cleanup not confirmed: Child session disposal failed: cannot dispose");
    expect(textOf(response)).toContain("final evidence");
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("cancelling get-result wait does not consume or dispose an opt-in running worker", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    const child = session();
    let finish!: (value: RunResult) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const launched = await booted.tools.get("Agent").execute("launch", {
      subagent_type: "research-reader", description: "read", prompt: "question", run_in_background: true,
    }, undefined, undefined, ctx());
    const id = launched.details.agentId;
    const cancellation = new AbortController();
    const getTool = booted.tools.get("get_subagent_result");
    const pending = getTool.execute("wait", { agent_id: id, wait: true }, cancellation.signal, undefined, ctx());
    const rejected = expect(pending).rejects.toThrow();
    cancellation.abort();
    await rejected;
    expect(child.dispose).not.toHaveBeenCalled();
    finish(result(child));
    await flush();
    expect(child.dispose).not.toHaveBeenCalled();
    await getTool.execute("get", { agent_id: id, wait: true }, undefined, undefined, ctx());
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("real registered get-result preserves verbose output and transcript on repeat reads", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    const child = session();
    vi.mocked(runAgent).mockResolvedValueOnce(result(child));
    const launched = await booted.tools.get("Agent").execute("launch", {
      subagent_type: "research-reader", description: "read", prompt: "bounded question", run_in_background: true,
    }, undefined, undefined, ctx());
    const id = launched.details.agentId;
    await flush();
    const get = () => booted.tools.get("get_subagent_result").execute("get", { agent_id: id, verbose: true }, undefined, undefined, ctx());
    expect(child.dispose).not.toHaveBeenCalled();
    const first = textOf(await get());
    const second = textOf(await get());
    expect(first).toContain("[Assistant]: final evidence");
    expect(first).toContain("Transcript:");
    expect(second).toContain("[Assistant]: final evidence");
    expect(child.dispose).toHaveBeenCalledOnce();
  });
});
