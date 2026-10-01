import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ create: vi.fn(), loader: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof codingAgent>("@earendil-works/pi-coding-agent");
  return { ...actual, createAgentSession: sdk.create, DefaultResourceLoader: class {
    constructor(options: unknown) { sdk.loader(options); }
    async reload() {}
    getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
  } };
});
vi.mock("../src/env.js", () => ({ detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })) }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(), isWorktreeIsolationEnabled: () => true,
  setWorktreeIsolationEnabled: vi.fn(), pruneWorktrees: vi.fn(async () => {}),
}));

import type * as codingAgent from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { detectEnv } from "../src/env.js";
import extension from "../src/index.js";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "../src/output-file.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import { createWorktree } from "../src/worktree.js";
import { ctx, flush, hermeticDir, makePi } from "./helpers/boot-extension.js";

const template = readFileSync(resolve("examples/agents/research-reader.md"), "utf-8");
const compiled = compileJsonSchema({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] });
if (!compiled.ok) throw new Error(compiled.message);
const schema = compiled.compiled;
type SessionOptions = Parameters<typeof codingAgent.createAgentSession>[0];

function childSession(mode: "success" | "failure" | "cancel" | "wrapup" = "success") {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event); };
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const messages: AgentSession["messages"] = [];
  const child = {
    messages,
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return vi.fn(() => listeners.delete(listener));
    }),
    setSessionName: vi.fn(), bindExtensions: vi.fn(async () => {}),
    setActiveToolsByName: vi.fn(), getAllTools: vi.fn(() => []), getActiveToolNames: vi.fn(() => []),
    agent: {},
    sessionManager: { getSessionFile: () => undefined },
    extensionRunner: { hasHandlers: () => false },
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => { finish?.(); }),
    dispose: vi.fn(() => { messages.length = 0; listeners.clear(); }),
    prompt: vi.fn(async (prompt: string) => {
      messages.push({ role: "user", content: prompt, timestamp: 0 });
      started();
      if (mode === "cancel") await new Promise<void>(r => { finish = r; });
      if (mode === "wrapup") {
        for (let i = 0; i < 8; i++) emit({ type: "turn_end" } as AgentSessionEvent);
      }
      messages.push({ role: "assistant", content: [{ type: "text", text: "retained final evidence" }],
        stopReason: mode === "failure" ? "error" : "stop", errorMessage: mode === "failure" ? "scripted provider failure" : undefined,
      } as AgentSession["messages"][number]);
      const tool = (sdk.create.mock.lastCall![0] as SessionOptions).customTools?.find(t => t.name === "StructuredOutput");
      if (tool) await tool.execute("schema", { answer: "retained final evidence" }, undefined, undefined, ctx());
      // Deliberately no turn_end: settlement must flush the final tail even on rejection.
      if (mode === "failure") throw new Error("scripted provider failure");
    }),
  };
  sdk.create.mockResolvedValue({ session: child });
  return { child: child as unknown as AgentSession, ready, listeners };
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

interface Registry {
  spawn: AgentManager["spawn"];
  getRecord(id: string): AgentRecord | undefined;
}

describe("one-shot entrypoint transcript and schema boundaries", () => {
  let env: ReturnType<typeof hermeticDir>;
  let manager: AgentManager;
  let shutdown: (() => Promise<void>) | undefined;
  let priorDefault: boolean;
  const files = new Set<string>();
  beforeEach(() => {
    priorDefault = getOutputTranscriptDefault();
    env = hermeticDir({ settings: { schedulingEnabled: false }, agentFiles: { "research-reader": template } });
    registerAgents(loadCustomAgents(env.dir));
    manager = new AgentManager();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    await manager.dispose();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    for (const file of files) rmSync(file, { force: true });
    files.clear();
    setOutputTranscriptDefault(priorDefault);
    env.restore();
    vi.useRealTimers();
  });
  function transcript(record: AgentRecord) {
    expect(record.outputFile).toBeTruthy();
    files.add(record.outputFile!);
    return readFileSync(record.outputFile!, "utf-8").trim().split("\n").map(line => JSON.parse(line));
  }
  async function boot() {
    const booted = makePi();
    const events = bus();
    booted.pi.events = events;
    extension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as Registry;
    return { booted, events, registry };
  }

  it.each([undefined, false])("real RPC isBackground=%s retains success and failure transcripts after consume and shutdown", async (isBackground) => {
    const { booted, events, registry } = await boot();
    for (const mode of ["success", "failure"] as const) {
      const { child } = childSession(mode);
      const reply = vi.fn();
      events.on(`subagents:rpc:spawn:reply:${mode}`, reply);
      events.emit("subagents:rpc:spawn", { requestId: mode, type: "research-reader", prompt: "bounded question",
        options: { description: mode, isBackground, rootSessionId: "../../forged", outputTranscript: false } });
      await flush();
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      const record = registry.getRecord(reply.mock.calls[0][0].data.id)!;
      await record.promise;
      expect(record.error).toBe(mode === "failure" ? "scripted provider failure" : undefined);
      expect(record.status).toBe(mode === "failure" ? "error" : "completed");
      expect(record.outputFile).toContain("/s1/tasks/");
      expect(child.dispose).not.toHaveBeenCalled();
      expect(transcript(record).map(entry => entry.type)).toEqual(["user", "assistant"]);
      const consumed = vi.fn();
      events.on(`subagents:rpc:consume:reply:${mode}`, consumed);
      events.emit("subagents:rpc:consume", { requestId: mode, agentId: record.id });
      await flush();
      expect(consumed).toHaveBeenCalledWith({ success: true });
      expect(child.dispose).toHaveBeenCalledOnce();
      expect(record.session).toBeUndefined();
      expect(transcript(record)[1].message.content[0].text).toBe("retained final evidence");
    }
    await shutdown!();
    shutdown = undefined;
    for (const file of files) expect(readFileSync(file, "utf-8")).toContain("retained final evidence");
    expect(booted.pi.exec).toHaveBeenCalledTimes(0);
  });

  it.each([false, true])("Agent-tool background=%s attaches only one transcript stream", async (background) => {
    const { booted, registry } = await boot();
    const { child } = childSession();
    await booted.tools.get("Agent").execute("launch", { subagent_type: "research-reader", prompt: "bounded question",
      description: "reader", run_in_background: background }, undefined, undefined, ctx());
    await flush();
    expect(sdk.create).toHaveBeenCalledOnce();
    // Three subscriptions: transcript, turn tracker, response collector. No extension scope in isolated mode.
    expect(child.subscribe).toHaveBeenCalledTimes(3);
    const entries = booted.pi.appendEntry.mock.calls.find(([kind]: [string]) => kind === "subagents:record");
    const record = registry.getRecord(entries[1].id)!;
    expect(record.error).toBeUndefined();
    expect(transcript(record).map(entry => entry.type)).toEqual(["user", "assistant"]);
    if (background) await booted.tools.get("get_subagent_result").execute("get", { agent_id: record.id }, undefined, undefined, ctx());
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(transcript(record)).toHaveLength(2);
  });

  it.each(["success", "failure", "cancel", "wrapup"] as const)("workflow host %s flushes before release and survives record eviction", async (mode) => {
    await manager.dispose();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    manager = new AgentManager();
    const { child, ready, listeners } = childSession(mode);
    let recordId = "";
    const host = createWorkflowHost({ pi: makePi().pi, ctx: ctx(), manager, workflowId: "wf-test" });
    const pending = host.spawnAgent({ agentId: "wf-agent-1", label: "reader", agentType: "research-reader", prompt: "bounded question",
      onResolved: info => { if (info.recordId) recordId = info.recordId; } });
    await ready;
    if (mode === "cancel") manager.abort(recordId);
    const output = await pending;
    const record = manager.getRecord(recordId)!;
    expect(record.error).toBe(mode === "failure" ? "scripted provider failure" : undefined);
    expect(record.status).toBe(mode === "failure" ? "error" : mode === "cancel" ? "stopped" : mode === "wrapup" ? "steered" : "completed");
    expect(output.ok).toBe(mode !== "failure" && mode !== "cancel");
    expect(output).not.toHaveProperty("sessionCleanupError");
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    const before = transcript(record);
    expect(before.map(entry => entry.type)).toEqual(["user", "assistant"]);
    expect(before[1].message.content[0].text).toBe("retained final evidence");
    if (mode === "failure") expect(before[1].message.errorMessage).toBe("scripted provider failure");
    await manager.consumeResult(recordId);
    record.completedAt = Date.now() - 700_000;
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    expect(manager.getRecord(recordId)).toBeUndefined();
    await manager.dispose();
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(transcript(record)).toEqual(before);
  });

  it.each(["handler", "dispose", "timeout"] as const)("workflow host preserves outcomes with unconfirmed %s cleanup", async (kind) => {
    for (const mode of ["success", "failure", "cancel"] as const) {
      const { child, ready } = childSession(mode);
      let recordId = "";
      const emit = vi.fn(async () => {});
      Object.defineProperty(child, "extensionRunner", { value: { hasHandlers: () => true, emit } });
      if (kind === "handler") emit.mockRejectedValueOnce(new Error("cleanup broke"));
      if (kind === "dispose") vi.mocked(child.dispose).mockImplementationOnce(() => { throw new Error("cleanup broke"); });
      if (kind === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        emit.mockImplementationOnce(() => new Promise(() => {}));
      }
      const host = createWorkflowHost({ pi: makePi().pi, ctx: ctx(), manager });
      const pending = host.spawnAgent({ agentId: `wf-${mode}`, index: 0, label: "reader", agentType: "research-reader", prompt: "question",
        onResolved: info => { if (info.recordId) recordId = info.recordId; } });
      await ready;
      if (mode === "cancel") manager.abort(recordId);
      await flush();
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(3_001);
      const output = await pending;
      vi.useRealTimers();
      const record = manager.getRecord(recordId)!;
      const warning = kind === "timeout" ? "Child session shutdown timed out"
        : `Child session ${kind === "dispose" ? "disposal" : "shutdown"} failed: cleanup broke`;
      expect(record.sessionCleanupError).toBe(warning);
      expect(output).toMatchObject({ ok: mode === "success", sessionCleanupError: warning });
      if (mode === "success") expect(output.text).toBe("retained final evidence");
      else expect(output.error).toBe(mode === "failure" ? "scripted provider failure" : "Stopped.");
      expect(output.skipped).toBe(mode === "cancel" ? true : undefined);
      expect(record.status).toBe(mode === "success" ? "completed" : mode === "failure" ? "error" : "stopped");
      expect(transcript(record)[1].message.content[0].text).toBe("retained final evidence");
      await expect(manager.consumeResult(recordId)).rejects.toThrow(warning);
      expect(child.dispose).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledOnce();
    }
  });

  it.each([true, false])("snapshots profile transcript=%s before registry/default changes", async (enabled) => {
    const profiles = loadCustomAgents(env.dir);
    profiles.get("research-reader")!.outputTranscript = enabled;
    registerAgents(profiles);
    setOutputTranscriptDefault(!enabled);
    const { child } = childSession();
    const id = manager.spawn(makePi().pi, ctx(), "research-reader", "bounded question", { description: "snapshot" });
    profiles.get("research-reader")!.outputTranscript = !enabled;
    registerAgents(profiles);
    setOutputTranscriptDefault(!enabled);
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.error).toBeUndefined();
    if (enabled) expect(transcript(record)).toHaveLength(2);
    else expect(record.outputFile).toBeUndefined();
    await manager.consumeResult(id);
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("default-off programmatic profiles do not acquire transcript wiring", async () => {
    childSession();
    const id = manager.spawn(makePi().pi, ctx(), "general-purpose", "bounded question", { description: "ordinary", isolated: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.error).toBeUndefined();
    expect(record.outputFile).toBeUndefined();
    expect(record.outputCleanup).toBeUndefined();
  });

  it.each(["RPC", "workflow", "manager", "direct"])("%s rejects schema before SDK/provider/worktree startup", async (route) => {
    childSession();
    if (route === "RPC") {
      const { events } = await boot();
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:schema", reply);
      events.emit("subagents:rpc:spawn", { requestId: "schema", type: "research-reader", prompt: "question",
        options: { structuredOutput: schema, isolation: "worktree", isolated: false } });
      await flush();
      expect(reply).toHaveBeenCalledWith({ success: false, error: expect.stringContaining("Structured output/schema") });
    } else if (route === "workflow") {
      const host = createWorkflowHost({ pi: makePi().pi, ctx: ctx(), manager });
      expect(await host.spawnAgent({ agentId: "wf-agent-1", label: "schema", agentType: "research-reader", prompt: "question",
        schema, isolation: "worktree" })).toMatchObject({ ok: false, error: expect.stringContaining("Structured output/schema") });
    } else if (route === "manager") {
      expect(() => manager.spawn(makePi().pi, ctx(), "research-reader", "question", { description: "schema", structuredOutput: schema,
        isolation: "worktree", isolated: false })).toThrow("Structured output/schema");
      expect(manager.listAgents()).toEqual([]);
    } else {
      await expect(runAgent(ctx(), "research-reader", "question", { pi: makePi().pi, structuredOutput: schema, isolated: false }))
        .rejects.toThrow("Structured output/schema");
    }
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.loader).not.toHaveBeenCalled();
    expect(detectEnv).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it.each([[false, true], [true, false]])("ordinary schema compatibility: dispose=%s isolated=%s", async (disposeOnConsume, isolated) => {
    writeFileSync(join(env.dir, ".pi/agents/compatible.md"), `---\nextensions: false\nskills: false\ndispose_on_consume: ${disposeOnConsume}\nisolated: ${isolated}\n---\nReturn evidence.`);
    registerAgents(loadCustomAgents(env.dir));
    const { child } = childSession();
    if (disposeOnConsume) vi.mocked(child.dispose).mockImplementationOnce(() => { throw new Error("schema cleanup broke"); });
    const host = createWorkflowHost({ pi: makePi().pi, ctx: ctx(), manager });
    const output = await host.spawnAgent({ agentId: "wf-agent-1", label: "schema", agentType: "compatible", prompt: "question", schema });
    expect(output).toMatchObject({ ok: true, text: '{"answer":"retained final evidence"}' });
    if (disposeOnConsume) {
      expect(output).toHaveProperty("sessionCleanupError", "Child session disposal failed: schema cleanup broke");
      expect(child.dispose).toHaveBeenCalledOnce();
    } else {
      expect(output).not.toHaveProperty("sessionCleanupError");
      expect(child.dispose).not.toHaveBeenCalled();
    }
    expect(sdk.create).toHaveBeenCalledOnce();
    expect(sdk.create.mock.calls[0][0].customTools.map((tool: { name: string }) => tool.name)).toEqual(["StructuredOutput"]);
    childSession();
    const { record: explicit } = await manager.spawnAndWait(makePi().pi, ctx(), "compatible", "question", {
      description: "explicit schema", isolated, structuredOutput: schema,
    });
    expect(explicit.error).toBeUndefined();
    expect(explicit.structuredJson).toBe('{"answer":"retained final evidence"}');
    childSession();
    const direct = await runAgent(ctx(), "compatible", "question", { pi: makePi().pi, isolated, structuredOutput: schema });
    expect(direct.failure).toBeUndefined();
    expect(direct.structuredJson).toBe('{"answer":"retained final evidence"}');
    direct.session.dispose();
    for (const record of manager.listAgents()) if (record.outputFile) files.add(record.outputFile);
  });

  it("nested effective policy is not replaced with the parent's same-named isolated profile", async () => {
    childSession();
    const id = manager.spawn(makePi().pi, ctx(), "research-reader", "question", { description: "nested", parentAgentId: "parent",
      disposeOnConsume: true, outputTranscript: false, isolated: false, structuredOutput: schema, configCwd: env.dir });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.error).toBeUndefined();
    expect(record.structuredJson).toBe('{"answer":"retained final evidence"}');
    expect(record.outputFile).toBeUndefined();
    expect(existsSync(join(env.dir, "forged.output"))).toBe(false);
  });
});
