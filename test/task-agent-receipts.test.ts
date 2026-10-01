import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
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
vi.mock("../src/env.js", () => ({ detectEnv: vi.fn(async () => ({ isGitRepo: true, branch: "task-fixture", platform: "linux" })) }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(), isWorktreeIsolationEnabled: () => true,
  setWorktreeIsolationEnabled: vi.fn(), pruneWorktrees: vi.fn(async () => {}),
}));

import type * as codingAgent from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import extension from "../src/index.js";
import { captureTaskSource, retainedCheckoutRoot, taskProfileFingerprint } from "../src/task-assignment.js";
import { snapshotTaskPlan, type TaskProjection, TaskReviewSchema } from "../src/task-plan.js";
import type { AgentReceipt, AgentRecord, Immutable } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { journalKey } from "../src/workflow/journal.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import { MAX_SCRIPT_LENGTH, runWorkflow } from "../src/workflow/runtime.js";
import { completeWorkflowTask, createWorkflowTask } from "../src/workflow/task.js";
import { createWorktree } from "../src/worktree.js";
import { flush, makePi, textOf } from "./helpers/boot-extension.js";
import { taskFixture, taskModel } from "./helpers/task-fixture.js";

type SessionOptions = Parameters<typeof codingAgent.createAgentSession>[0];
function deferred() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function childSession() {
  const messages: AgentSession["messages"] = [];
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const child = {
    messages, model: taskModel, thinkingLevel: "off", sessionId: "sdk-fixture-session",
    isIdle: true, isCompacting: false, isBashRunning: false,
    sessionManager: { getCwd: () => "", getSessionFile: () => undefined },
    waitForIdle: vi.fn(async () => {}), setSessionName: vi.fn(), bindExtensions: vi.fn(async () => {}),
    getAllTools: () => [], getActiveToolNames: () => [], setActiveToolsByName: vi.fn(), agent: {},
    extensionRunner: { hasHandlers: () => false, emit: vi.fn(async () => {}) },
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    dispose: vi.fn(() => { listeners.clear(); }), steer: vi.fn(async () => {}), abort: vi.fn(async () => {}),
    prompt: vi.fn(async (prompt: string) => {
      messages.push({ role: "user", content: prompt, timestamp: 0 });
      const message = { role: "assistant", content: [{ type: "text", text: "task answer" }], stopReason: "stop",
        usage: { input: 12, output: 7, cacheWrite: 2, cacheRead: 4, cost: { total: 0.5 } }, timestamp: 0 } as AgentSession["messages"][number];
      messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message } as AgentSessionEvent);
    }),
  };
  sdk.create.mockImplementationOnce(async (options: SessionOptions) => {
    child.sessionManager.getCwd = () => options.cwd!;
    return { session: child };
  });
  return child;
}
interface Registry {
  spawn: AgentManager["spawn"];
  getRecord(id: string): (Partial<AgentRecord> & { receipt?: Immutable<AgentReceipt> }) | undefined;
  getReceipt: AgentManager["getReceipt"];
  waitForAll: AgentManager["waitForAll"];
  hasRunning: AgentManager["hasRunning"];
}

describe("task-bound manager receipts and entrypoints", () => {
  let fixture: ReturnType<typeof taskFixture>;
  let manager: AgentManager;
  let shutdown: (() => Promise<void>) | undefined;
  beforeEach(() => {
    vi.clearAllMocks(); sdk.create.mockReset();
    fixture = taskFixture();
    manager = new AgentManager();
  });
  afterEach(async () => {
    await shutdown?.(); shutdown = undefined;
    await manager.dispose();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    fixture.restore(); vi.useRealTimers();
  });
  const options = () => ({ description: "assigned task", taskAssignment: fixture.assignment });
  async function completed(background = true) {
    const child = childSession();
    const id = manager.spawn(makePi().pi, fixture.context, "task-worker", "task prompt", { ...options(), isBackground: background });
    const record = manager.getRecord(id)!;
    await record.promise;
    return { child, id, record };
  }
  async function boot() {
    const booted = makePi();
    const listeners = new Map<string, ((data: unknown) => void)[]>();
    booted.pi.events = {
      on(event: string, handler: (data: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return () => listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== handler));
      },
      emit(event: string, data: unknown) { for (const handler of listeners.get(event) ?? []) handler(data); },
    };
    extension(booted.pi);
    await booted.lifecycle.get("session_start")({}, fixture.context);
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as Registry;
    return { ...booted, registry };
  }

  it("records actual retained SDK identity, candidate, evidence and per-attempt usage without changing consumption lifetime", async () => {
    const { id, child, record } = await completed();
    const receipt = manager.getReceipt(id)!;
    expect(receipt).toMatchObject({ version: 1, assignment: fixture.assignment, attempt: 1,
      effective: { model: "task-stub/task-model", thinking: "off", cwd: fixture.cwd, configCwd: fixture.cwd },
      execution: { status: "completed", settled: true, consumed: false, error: null, settlementError: null },
      sdk: { allocated: true, quiescent: true, sessionId: "sdk-fixture-session", disposition: "retained", cleanupError: null },
      usage: { input: 12, output: 7, cacheWrite: 2, cacheRead: 4, cost: 0.5 } });
    expect(receipt.candidate.fingerprint).toBe(captureTaskSource(fixture.cwd).fingerprint);
    expect(receipt.evidence.transcript).toBe(record.outputFile);
    expect(receipt.evidence.required).toEqual(fixture.assignment.evidence);
    fixture.assignment.allowedPaths.push("outside");
    expect(receipt.assignment.allowedPaths).toEqual(["src"]);
    expect(Object.isFrozen(receipt.sdk)).toBe(true);
    expect(await manager.consumeResult(id)).toBe(true);
    expect(manager.getReceipt(id)?.execution.consumed).toBe(true);
    expect(receipt.execution.consumed).toBe(false);
    expect(child.dispose).not.toHaveBeenCalled();
  });

  it.each(["profile", "fallback", "model", "thinking", "restrictions", "cwd", "isolation", "nested"])("fails closed for %s contradictions before any SDK or worktree startup", kind => {
    const assignment = structuredClone(fixture.assignment);
    if (kind === "profile") assignment.configuration.profileFingerprint = "a".repeat(64);
    if (kind === "model") assignment.configuration.model = "missing/model";
    if (kind === "thinking") assignment.configuration.thinking = "max";
    if (kind === "restrictions") assignment.configuration.maxTurns = 90;
    expect(() => manager.spawn(makePi().pi, fixture.context, kind === "fallback" ? "missing" : "task-worker", "never prompt", {
      description: "contradiction", taskAssignment: assignment,
      ...(kind === "cwd" ? { cwd: "/tmp" } : {}), ...(kind === "isolation" ? { isolation: "worktree" as const } : {}),
      ...(kind === "nested" ? { parentAgentId: "parent" } : {}),
    })).toThrow(/Task|fallback/);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("refuses unavailable models and disabled exact profiles rather than ordinary fallback", () => {
    const context = { ...fixture.context, modelRegistry: { ...fixture.context.modelRegistry, getAvailable: () => [] } };
    expect(() => manager.spawn(makePi().pi, context, "task-worker", "go", options())).toThrow("unavailable");
    getAgentConfig("task-worker")!.enabled = false;
    expect(() => manager.spawn(makePi().pi, fixture.context, "task-worker", "go", options())).toThrow("exact enabled profile");
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each(["source", "profile"])("revalidates queued %s drift and reports not-created instead of false cleanup success", async kind => {
    await manager.dispose(); manager = new AgentManager(undefined, 1);
    const hold = deferred();
    const holder = childSession(); holder.prompt.mockImplementationOnce(() => hold.promise);
    const holderId = manager.spawn(makePi().pi, fixture.context, "task-worker", "holder", { description: "ordinary holder", isBackground: true, cwd: "/tmp" });
    const id = manager.spawn(makePi().pi, fixture.context, "task-worker", "queued", { ...options(), isBackground: true });
    expect(manager.getRecord(id)?.status).toBe("queued");
    if (kind === "source") writeFileSync(join(fixture.cwd, "src", "allowed.ts"), "queued drift");
    else getAgentConfig("task-worker")!.systemPrompt += " changed";
    hold.release(); await manager.getRecord(holderId)!.promise; await flush();
    const receipt = manager.getReceipt(id)!;
    expect(receipt.execution).toMatchObject({ status: "error", settled: true });
    expect(receipt.execution.error).toContain(kind === "source" ? "source fingerprint" : "profile configuration");
    expect(receipt.sdk).toMatchObject({ allocated: false, disposition: "not-created", sessionId: null });
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it.each(["running", "queued", "stopped"])("blocks an ordinary %s subdirectory writer before Task allocation", async status => {
    if (status === "queued") { await manager.dispose(); manager = new AgentManager(undefined, 1); }
    const held = deferred();
    const holder = childSession(); holder.prompt.mockImplementationOnce(() => held.promise);
    const cwd = join(fixture.cwd, "src");
    const first = manager.spawn(makePi().pi, fixture.context, "task-worker", "ordinary", { description: "ordinary", isBackground: true, cwd: status === "queued" ? "/tmp" : cwd });
    await flush();
    if (status === "queued") manager.spawn(makePi().pi, fixture.context, "task-worker", "queued", { description: "queued", isBackground: true, cwd });
    if (status === "stopped") manager.abort(first);
    try {
      expect(() => manager.spawn(makePi().pi, fixture.context, "task-worker", "never", options())).toThrow(/unsettled writer|checkout/);
      expect(sdk.create).toHaveBeenCalledOnce();
    } finally { manager.abortAll(); held.release(); await manager.getRecord(first)!.promise; }
  });
  it("canonical checkout identity follows symlink/subdirectories without conflating distinct roots", async () => {
    mkdirSync(join(fixture.cwd, "ignored")); const alias = join(fixture.cwd, "ignored/alias"); symlinkSync(join(fixture.cwd, "src"), alias);
    expect(retainedCheckoutRoot(alias)).toBe(fixture.cwd);
    expect(retainedCheckoutRoot(join(fixture.cwd, ".pi"))).toBe(fixture.cwd);
    const held = deferred(); const child = childSession(); child.prompt.mockImplementationOnce(() => held.promise);
    const id = manager.spawn(makePi().pi, fixture.context, "task-worker", "ordinary", { description: "ordinary alias", cwd: alias });
    await flush();
    try {
      expect(() => manager.assertTaskCheckoutIdle(fixture.cwd)).toThrow("unsettled writer");
      // This assigned source is already a Git worktree; no fixture worktree allocation is needed.
      const checkout = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
      const distinct = retainedCheckoutRoot(checkout)!; expect(distinct).not.toBe(fixture.cwd);
      expect(() => manager.assertTaskCheckoutIdle(distinct)).not.toThrow(); expect(sdk.create).toHaveBeenCalledOnce();
    } finally { manager.abort(id); held.release(); await manager.getRecord(id)!.promise; }
  });
  it("SDK-busy ordinary terminal records block Task allocation", async () => {
    const child = childSession(); const id = manager.spawn(makePi().pi, fixture.context, "task-worker", "ordinary", { description: "ordinary", cwd: join(fixture.cwd, "src") });
    await manager.getRecord(id)!.promise; child.isBashRunning = true;
    expect(() => manager.spawn(makePi().pi, fixture.context, "task-worker", "never", options())).toThrow("unsettled writer");
    expect(sdk.create).toHaveBeenCalledOnce(); child.isBashRunning = false;
  });
  it("Task resume refuses a newly active ordinary checkout writer before provider prompt", async () => {
    const { id, child } = await completed();
    const held = deferred(); const ordinary = childSession(); ordinary.prompt.mockImplementationOnce(() => held.promise);
    const writer = manager.spawn(makePi().pi, fixture.context, "task-worker", "ordinary", { description: "ordinary", cwd: join(fixture.cwd, "src") });
    await flush(); const prompts = child.prompt.mock.calls.length;
    try {
      await expect(manager.resume(id, "never", undefined, { taskAssignment: { ...fixture.assignment, attemptId: "blocked-resume" } })).rejects.toThrow(/unsettled writer|checkout/);
      expect(child.prompt).toHaveBeenCalledTimes(prompts);
    } finally { manager.abort(writer); held.release(); await manager.getRecord(writer)!.promise; }
  });
  it("checks source again after asynchronous allocation and before the provider prompt", async () => {
    const child = childSession();
    sdk.create.mockReset();
    sdk.create.mockImplementationOnce(async (sessionOptions: SessionOptions) => {
      writeFileSync(join(fixture.cwd, "src", "allowed.ts"), "allocation drift");
      child.sessionManager.getCwd = () => sessionOptions.cwd!;
      return { session: child };
    });
    const id = manager.spawn(makePi().pi, fixture.context, "task-worker", "never prompt", options());
    await manager.getRecord(id)!.promise;
    expect(child.prompt).not.toHaveBeenCalled();
    expect(manager.getReceipt(id)?.sdk.allocated).toBe(true);
    expect(manager.getReceipt(id)?.execution.error).toContain("initial source fingerprint");
  });

  it("stopped is not SDK-idle: consumption, eviction, writer reuse, wait and shutdown respect settlement", async () => {
    const prompt = deferred(); const idle = deferred();
    const child = childSession();
    child.prompt.mockImplementationOnce(() => prompt.promise);
    child.waitForIdle.mockImplementation(() => idle.promise);
    child.isIdle = false;
    const id = manager.spawn(makePi().pi, fixture.context, "task-worker", "active", { ...options(), isBackground: true });
    await flush(); manager.abort(id);
    const record = manager.getRecord(id)!;
    expect(manager.getReceipt(id)?.execution).toMatchObject({ status: "stopped", settled: false });
    expect(await manager.consumeResult(id)).toBe(false);
    expect(() => manager.spawn(makePi().pi, fixture.context, "task-worker", "other author", {
      ...options(), taskAssignment: { ...fixture.assignment, attemptId: "other" },
    })).toThrow("unsettled writer");
    record.completedAt = Date.now() - 700_000;
    manager.clearCompleted();
    expect(manager.getRecord(id)).toBe(record);
    expect(manager.hasRunning()).toBe(true);
    const wait = manager.waitForAll(); const waited = vi.fn(); void wait.then(waited);
    const disposal = manager.dispose(); const disposed = vi.fn(); void disposal.then(disposed);
    prompt.release(); await flush();
    expect(waited).not.toHaveBeenCalled(); expect(disposed).not.toHaveBeenCalled();
    expect(child.dispose).not.toHaveBeenCalled();
    child.isIdle = true; idle.release();
    await wait; await disposal;
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it.each(["Bash", "compaction", "agent", "barrier"])("reports unobservable/active %s as unconfirmed, not settled", async kind => {
    const child = childSession();
    const waitForIdle = child.waitForIdle;
    if (kind === "Bash") child.isBashRunning = true;
    if (kind === "compaction") child.isCompacting = true;
    if (kind === "agent") child.isIdle = false;
    if (kind === "barrier") Object.defineProperty(child, "waitForIdle", { value: undefined, writable: true });
    const id = manager.spawn(makePi().pi, fixture.context, "task-worker", "answer", options());
    await manager.getRecord(id)!.promise;
    const receipt = manager.getReceipt(id)!;
    expect(receipt.execution).toMatchObject({ status: "completed", settled: false, consumed: false });
    expect(receipt.execution.settlementError).toContain(kind === "barrier" ? "idle barrier" : "Bash work");
    expect(receipt.sdk.disposition).toBe("unconfirmed");
    await expect(manager.waitForAll()).rejects.toThrow("SDK settlement is unconfirmed");
    expect(await manager.consumeResult(id)).toBe(false);
    child.isBashRunning = false; child.isCompacting = false; child.isIdle = true;
    child.waitForIdle = waitForIdle;
  });

  it("session reference clearing never proves successful SDK release", async () => {
    const { id, record, child } = await completed();
    record.session = undefined;
    // Normal eviction calls the real release path; keep the receipt observed in its callback.
    manager.clearCompleted();
    expect(record.sessionCleanupError).toContain("reference is missing");
    expect(child.dispose).not.toHaveBeenCalled();
    child.dispose();
    expect(manager.getReceipt(id)).toBeUndefined();
  });

  it.each(["success", "dispose", "handler", "missing"])("one-shot %s release preserves answer/status/usage and projects actual disposition", async kind => {
    fixture.restore(); fixture = taskFixture(true);
    const child = childSession();
    if (kind === "dispose") child.dispose.mockImplementation(() => { throw new Error("fixture disposal failure"); });
    if (kind === "handler") {
      child.extensionRunner.hasHandlers = () => true;
      child.extensionRunner.emit.mockRejectedValue(new Error("fixture handler failure"));
    }
    if (kind === "missing") Object.defineProperty(child, "dispose", { value: undefined });
    const { id, record } = await manager.spawnAndWait(makePi().pi, fixture.context, "task-worker", "answer", options());
    const receipt = manager.getReceipt(id)!;
    expect(record).toMatchObject({ result: "task answer", status: "completed", resultConsumed: true });
    expect(receipt.usage.output).toBe(7);
    expect(receipt.sdk.disposition).toBe(kind === "success" ? "released" : "unconfirmed");
    expect(receipt.sdk.cleanupError === null).toBe(kind === "success");
    expect(receipt.execution.settled).toBe(true);
    expect(await manager.resume(id, "never")).toBeUndefined();
    if (kind !== "success") await expect(manager.consumeResult(id)).rejects.toThrow(/session/);
    if (kind !== "missing") expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("resumes with fresh immutable attempt identities and per-attempt usage, never stale promise settlement or changed model/profile", async () => {
    const { id, record, child } = await completed();
    const previous = manager.getReceipt(id)!;
    await expect(manager.resume(id, "missing")).rejects.toThrow("fresh attemptId");
    await expect(manager.resume(id, "same", undefined, options())).rejects.toThrow("fresh");
    const assignment = { ...fixture.assignment, attemptId: "attempt-2" };
    await expect(manager.resume(id, "wide", undefined, { taskAssignment: { ...assignment, allowedPaths: ["src", "outside"] } })).rejects.toThrow("contract");
    const prompt = deferred(); const start = child.prompt.getMockImplementation()!;
    child.prompt.mockImplementationOnce(async text => { await prompt.promise; await start(text); });
    const resuming = manager.resume(id, "continue", undefined, { taskAssignment: assignment });
    const currentPromise = record.promise;
    expect(manager.getReceipt(id)?.execution).toMatchObject({ settled: false, consumed: false });
    expect(manager.getReceipt(id)?.assignment.attemptId).toBe("attempt-2");
    expect(currentPromise).toBeDefined();
    manager.abort(id);
    expect(record.abortController?.signal.aborted).toBe(true);
    prompt.release(); await resuming; await currentPromise;
    expect(record.status).toBe("stopped");
    expect(manager.getReceipt(id)).toMatchObject({ attempt: 2, usage: { input: 12, output: 7 }, execution: { settled: true, consumed: true } });
    expect(previous.attempt).toBe(1);
    Object.defineProperty(child, "model", { value: { ...taskModel, id: "different" }, configurable: true });
    await expect(manager.resume(id, "wrong", undefined, { taskAssignment: { ...assignment, attemptId: "attempt-3" } })).rejects.toThrow("model mismatch");
    Object.defineProperty(child, "model", { value: taskModel });
    getAgentConfig("task-worker")!.systemPrompt += " different";
    await expect(manager.resume(id, "wrong profile", undefined, { taskAssignment: { ...assignment, attemptId: "attempt-3" } })).rejects.toThrow("profile configuration");
  });

  it("pre-aborted task resume never prompts and settles a fresh attempt through the SDK idle barrier", async () => {
    const { id, record, child } = await completed(false);
    const previousPromise = record.promise;
    const previousReceipt = manager.getReceipt(id)!;
    const idle = deferred();
    child.prompt.mockClear();
    child.waitForIdle.mockImplementationOnce(() => idle.promise);
    const cancellation = new AbortController(); cancellation.abort();
    const resuming = manager.resume(id, "must not execute", cancellation.signal, {
      taskAssignment: { ...fixture.assignment, attemptId: "cancelled-attempt-2" },
    });
    const currentPromise = record.promise;
    try {
      expect(child.prompt).not.toHaveBeenCalled();
      expect(record.abortController?.signal.aborted).toBe(true);
      expect(currentPromise).not.toBe(previousPromise);
      expect(manager.getReceipt(id)).toMatchObject({ attempt: 2,
        execution: { status: "stopped", settled: false, consumed: false },
        sdk: { allocated: true, disposition: "retained", quiescent: null } });
      expect(await manager.consumeResult(id)).toBe(false);
      expect(manager.hasRunning()).toBe(true);
    } finally {
      idle.release(); await resuming;
    }
    expect(await resuming).toBe(record);
    expect(await currentPromise).toBe("");
    await manager.waitForAll();
    expect(manager.hasRunning()).toBe(false);
    expect(manager.getReceipt(id)).toMatchObject({ attempt: 2,
      assignment: { attemptId: "cancelled-attempt-2" },
      execution: { status: "stopped", settled: true, consumed: true, error: null, settlementError: null },
      sdk: { allocated: true, disposition: "retained", quiescent: true, cleanupError: null },
      usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } });
    expect(previousReceipt.attempt).toBe(1);
    expect(child.prompt).not.toHaveBeenCalled();
    expect(sdk.create).toHaveBeenCalledOnce();
    expect(child.dispose).not.toHaveBeenCalled();
    expect(record.outputCleanup).toBeUndefined();
  });

  it.each([true, false])("task transcripts enabled=%s use assigned cwd, flush the final tail, and do not duplicate on resume", async enabled => {
    fixture.restore(); fixture = taskFixture(false, enabled);
    const { id, record, child } = await completed();
    await manager.resume(id, "continue", undefined, { taskAssignment: { ...fixture.assignment, attemptId: "attempt-2" } });
    if (enabled) {
      const entries = readFileSync(record.outputFile!, "utf-8").trim().split("\n").map(line => JSON.parse(line) as { type: string; cwd: string });
      expect(entries.map(entry => entry.type)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(entries.every(entry => entry.cwd === fixture.cwd)).toBe(true);
    } else expect(record.outputFile).toBeUndefined();
    // Two run listeners per attempt, plus exactly one transcript subscription per enabled attempt.
    expect(child.subscribe).toHaveBeenCalledTimes(enabled ? 6 : 4);
    expect(record.outputCleanup).toBeUndefined();
  });

  it("Task retention spans the ten-minute sweep without changing ordinary cleanup or immortalizing receipts", async () => {
    await manager.dispose(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); manager = new AgentManager();
    const { id, record, child } = await completed();
    childSession(); const ordinary = manager.spawn(makePi().pi, fixture.context, "task-worker", "ordinary", { description: "ordinary" });
    await manager.getRecord(ordinary)!.promise;
    manager.retainTaskRecord(id, "long-task");
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(id)).toBe(record); expect(manager.getReceipt(id)?.sdk.disposition).toBe("retained");
    expect(child.dispose).not.toHaveBeenCalled(); expect(manager.getRecord(ordinary)).toBeUndefined();
    manager.clearCompleted(); expect(manager.getRecord(id)).toBe(record);
    manager.releaseTaskRecords("long-task"); await vi.advanceTimersByTimeAsync(60_000); await flush();
    expect(manager.getRecord(id)).toBeUndefined(); expect(child.dispose).toHaveBeenCalledOnce();
    expect(() => manager.retainTaskRecord(id, "expired")).toThrow("current Manager");
  });
  it("active Task author retention survives long checks and review, then ordinary cleanup resumes", async () => {
    await manager.dispose(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); manager = new AgentManager();
    const builder = getAgentConfig("task-worker")!; const reviewer = { ...builder, name: "task-reviewer", isolated: false, builtinToolNames: ["read", "grep", "find", "ls"] };
    registerAgents(new Map([[builder.name, builder], [reviewer.name, reviewer]]));
    const parent = SessionManager.inMemory(fixture.cwd); fixture.context = { ...fixture.context, sessionManager: parent };
    const pi = makePi().pi; pi.appendEntry.mockImplementation((type: string, data: unknown) => parent.appendCustomEntry(type, data));
    const plan = snapshotTaskPlan({ version: 1, builder: fixture.assignment, reviewer: { ...fixture.assignment, role: "Reviewer", profile: reviewer.name,
      allowedPaths: [], allowedActions: ["read"], approvedChecks: [], configuration: { ...fixture.assignment.configuration, isolated: false, profileFingerprint: taskProfileFingerprint(reviewer) } } });
    const host = createWorkflowHost({ pi, ctx: fixture.context, manager, workflowId: "long-check-review", taskPlan: plan });
    const author = childSession(); let authorId!: string;
    pi.exec.mockImplementationOnce(async () => {
      authorId = manager.listAgents().find(record => record.type === "task-worker")!.id;
      await vi.advanceTimersByTimeAsync(11 * 60_000); manager.clearCompleted();
      expect(manager.getRecord(authorId)).toBeDefined(); expect(author.dispose).not.toHaveBeenCalled();
      return { stdout: "long check settled", stderr: "", code: 0, killed: false };
    });
    const reader = childSession(); reader.sessionId = "fresh-reviewer-session";
    sdk.create.mockReset();
    sdk.create.mockImplementationOnce(async (options: SessionOptions) => { author.sessionManager.getCwd = () => options.cwd!; return { session: author }; });
    sdk.create.mockImplementationOnce(async (options: SessionOptions) => {
      reader.sessionManager.getCwd = () => options.cwd!;
      reader.prompt.mockImplementationOnce(async () => {
        await vi.advanceTimersByTimeAsync(11 * 60_000); manager.clearCompleted();
        expect(manager.getRecord(authorId)).toBeDefined(); expect(author.dispose).not.toHaveBeenCalled();
        const verdict = { version: 1, status: "COMPLETE", candidateFingerprint: host.taskProjection!().candidate!.fingerprint, verdict: "PASS", findings: [], summary: "scripted review" };
        await options.customTools!.find(tool => tool.name === "StructuredOutput")!.execute("review", verdict, undefined, undefined, fixture.context);
      });
      return { session: reader };
    });
    const result = await runWorkflow({ host, args: { schema: JSON.parse(JSON.stringify(TaskReviewSchema)) }, script: 'export const meta = {name:"long-task",description:"scripted SDK; virtual elapsed time"}; const b = await task.prepare("builder"); await agent("build",{agentType:b.profile,taskAssignment:b}); await task.check("fixture-check"); await task.freeze(); const r = await task.prepare("reviewer"); const v = await agent("review",{agentType:r.profile,taskAssignment:r,schema:args.schema}); return await task.recordReview(v);' });
    expect(result).toMatchObject({ status: "completed", taskProjection: { safeStep: "reviewed", ownership: { state: "released" } } });
    expect(result.taskProjection!.review!.receipt.sdk.sessionId).not.toBe(result.taskProjection!.attempts[0].receipt!.sdk.sessionId);
    expect(author.dispose).not.toHaveBeenCalled(); manager.clearCompleted(); await flush(); expect(author.dispose).toHaveBeenCalledOnce();
  }, 15_000);
  it.each([
    ["control character", "clear"], ["control character", "sweep"],
    ["oversized scriptPath", "clear"], ["oversized scriptPath", "sweep"],
  ])("rejected public recovery with %s leaves no lease blocking %s after valid recovery", async (invalid, cleanup) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    writeFileSync(join(fixture.cwd, ".pi/agents/task-reviewer.md"), '---\nextensions: false\nskills: false\nisolated: false\ninherit_context: false\nthinking: off\nmax_turns: 4\npersist_session: false\noutput_transcript: false\ntools: read,grep,find,ls\n---\nReview only; do not author source.');
    const parent = SessionManager.inMemory(fixture.cwd); fixture.context = { ...fixture.context, sessionManager: parent };
    const retention = vi.spyOn(AgentManager.prototype, "retainTaskRecord");
    try {
      const { pi, tools } = await boot();
      pi.appendEntry.mockImplementation((type: string, data: unknown) => parent.appendCustomEntry(type, data));
      const source = captureTaskSource(fixture.cwd);
      const builder = { ...fixture.assignment, binding: { ...fixture.assignment.binding, sourceFingerprint: source.fingerprint } };
      const reviewer = getAgentConfig("task-reviewer")!;
      const plan = snapshotTaskPlan({ version: 1, builder, reviewer: { ...builder, role: "Reviewer", profile: reviewer.name,
        allowedPaths: [], allowedActions: ["read"], approvedChecks: [], configuration: { ...builder.configuration, isolated: false, profileFingerprint: taskProfileFingerprint(reviewer) } } });
      const author = childSession();
      const frozen = new Promise<{ details: { taskProjection: TaskProjection } }>(resolve => pi.sendMessage.mockImplementation(resolve));
      const tool = tools.get("SubagentWorkflow");
      await tool.execute("freeze", { taskPlan: plan,
        script: 'export const meta = {name:"lease-freeze",description:"scripted SDK"}; const a = await task.prepare("builder"); await agent("build",{agentType:a.profile,taskAssignment:a}); await task.check("fixture-check"); return await task.freeze();',
      }, undefined, undefined, fixture.context);
      const projection = (await frozen).details.taskProjection;
      expect(projection).toMatchObject({ safeStep: "frozen", ownership: { state: "released" } });
      const checkpoint = projection.checkpoint!.id;
      const authorId = projection.attempts[0].agentId!;
      const publicManager = retention.mock.contexts[0] as AgentManager;
      expect(publicManager.getRecord(authorId)).toBeDefined();
      const script = 'export const meta = {name:"lease-reject",description:"valid meta"}; return true;';
      const oversizedPath = join(fixture.cwd, "ignored/rejected.workflow.js");
      if (invalid === "oversized scriptPath") { mkdirSync(join(fixture.cwd, "ignored")); writeFileSync(oversizedPath, script + " ".repeat(MAX_SCRIPT_LENGTH)); }
      const failed = new Promise<{ details: { error: string } }>(resolve => pi.sendMessage.mockImplementation(resolve));
      const rejected = await tool.execute("reject", { taskPlan: plan, recoveryCheckpointId: checkpoint,
        ...(invalid === "control character" ? { script: script + "\u0000" } : { scriptPath: oversizedPath }),
      }, undefined, undefined, fixture.context);
      // Exercise public error delivery, then observe real Manager cleanup rather
      // than treating a failed notification or a later recovery as lease release.
      const error = rejected.details?.taskId ? (await failed).details.error : textOf(rejected);
      expect(error).toContain(invalid === "control character" ? "control characters" : "over the limit");
      expect(sdk.create).toHaveBeenCalledOnce();
      const recovered = new Promise<{ details: { status: string; taskProjection: TaskProjection } }>(resolve => pi.sendMessage.mockImplementation(resolve));
      await tool.execute("recover", { taskPlan: plan, recoveryCheckpointId: checkpoint,
        script: 'export const meta = {name:"lease-recover",description:"valid recovery"}; return true;',
      }, undefined, undefined, fixture.context);
      expect((await recovered).details).toMatchObject({ status: "completed", taskProjection: { safeStep: "frozen", ownership: { state: "released" } } });
      expect(sdk.create).toHaveBeenCalledOnce();
      expect(author.dispose).not.toHaveBeenCalled();
      if (cleanup === "clear") publicManager.clearCompleted();
      else await vi.advanceTimersByTimeAsync(11 * 60_000);
      await flush();
      expect(publicManager.getRecord(authorId)).toBeUndefined();
      expect(publicManager.getReceipt(authorId)).toBeUndefined();
      expect(author.dispose).toHaveBeenCalledOnce();
    } finally { retention.mockRestore(); }
  }, 15_000);
  it("ordinary programmatic dispatch has no task receipt/transcript and consumption still retains resumability", async () => {
    const child = childSession();
    const id = manager.spawn(makePi().pi, fixture.context, "task-worker", "ordinary", { description: "ordinary" });
    await manager.getRecord(id)!.promise;
    expect(manager.getReceipt(id)).toBeUndefined();
    expect(manager.getRecord(id)?.outputFile).toBeUndefined();
    expect(await manager.consumeResult(id)).toBe(true);
    expect(child.dispose).not.toHaveBeenCalled();
    await expect(manager.resume(id, "cannot add task", undefined, options())).rejects.toThrow("ordinary agent");
    expect((await manager.resume(id, "ordinary resume"))?.result).toBe("task answer");
  });

  it("Agent/get-result/events/session entries and registry snapshots carry additive host receipts, not live SDK capabilities", async () => {
    const { tools, pi, registry } = await boot();
    const child = childSession();
    const completedEvent = vi.fn(); pi.events.on("subagents:completed", completedEvent);
    const response = await tools.get("Agent").execute("task", { prompt: "answer", description: "task", subagent_type: "task-worker",
      task_assignment: fixture.assignment, run_in_background: false }, undefined, undefined, fixture.context);
    const id = response.details.agentId;
    expect(response.details.receipt.execution).toMatchObject({ status: "completed", settled: true, consumed: true });
    expect(completedEvent.mock.calls[0][0].receipt).toMatchObject({ agentId: id, version: 1 });
    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({ receipt: expect.objectContaining({ agentId: id }) }));
    const snapshot = registry.getRecord(id)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).not.toHaveProperty("session");
    expect(snapshot).not.toHaveProperty("promise");
    expect(registry.getReceipt(id)?.sdk.disposition).toBe("retained");
    const read = await tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, fixture.context);
    expect(read.details.receipt.agentId).toBe(id);
    expect(textOf(read)).toContain("task answer");
    expect(child.dispose).not.toHaveBeenCalled();
  });

  it("retains assigned tools cwd separately from the parent configuration root", async () => {
    const child = childSession();
    const context = { ...fixture.context, cwd: join(fixture.cwd, "src") };
    const id = manager.spawn(makePi().pi, context, "task-worker", "answer", options());
    await manager.getRecord(id)!.promise;
    expect(sdk.loader).toHaveBeenCalledWith(expect.objectContaining({ cwd: context.cwd }));
    expect(manager.getReceipt(id)?.effective).toMatchObject({ cwd: fixture.cwd, configCwd: context.cwd });
    expect(child.sessionManager.getCwd()).toBe(fixture.cwd);
  });

  it("SubagentWorkflow completion notifications retain runtime receipts without changing the result", async () => {
    const { pi, tools } = await boot(); childSession();
    const notified = new Promise<unknown>(resolve => pi.sendMessage.mockImplementation(resolve));
    await tools.get("SubagentWorkflow").execute("workflow", {
      script: 'export const meta = { name: "binding", description: "binding" }; return await agent("answer", { agentType: "task-worker", taskAssignment: args.assignment });',
      args: { assignment: fixture.assignment },
    }, undefined, undefined, fixture.context);
    const notification = await notified;
    expect(notification).toMatchObject({ details: { status: "completed", resultPreview: "task answer", receipts: [
      { assignment: fixture.assignment, execution: { settled: true, consumed: true }, sdk: { disposition: "retained" } },
    ] } });
  });

  it("RPC spawn and consume return receipt data without changing protocol-2 ordinary envelopes", async () => {
    const { pi, registry } = await boot(); childSession();
    const spawned = vi.fn(); pi.events.on("subagents:rpc:spawn:reply:task", spawned);
    pi.events.emit("subagents:rpc:spawn", { requestId: "task", type: "task-worker", prompt: "answer", options: options() });
    await flush(); await registry.waitForAll();
    const id = spawned.mock.calls[0][0].data.id;
    expect(spawned.mock.calls[0][0]).toMatchObject({ success: true, data: { taskAssignment: fixture.assignment, receipt: { version: 1 } } });
    const consumed = vi.fn(); pi.events.on("subagents:rpc:consume:reply:task", consumed);
    pi.events.emit("subagents:rpc:consume", { requestId: "task", agentId: id }); await flush();
    expect(consumed.mock.calls[0][0]).toMatchObject({ success: true, data: { receipt: { execution: { consumed: true }, sdk: { disposition: "retained" } } } });
    const fallback = vi.fn(); pi.events.on("subagents:rpc:spawn:reply:fallback", fallback);
    pi.events.emit("subagents:rpc:spawn", { requestId: "fallback", type: "missing", prompt: "answer", options: options() }); await flush();
    expect(fallback.mock.calls[0][0]).toMatchObject({ success: false, error: expect.stringContaining("fallback") });
  });

  it("workflow propagates assignment/receipt without changing text/schema/null results or reusing task journal answers", async () => {
    childSession();
    const host = createWorkflowHost({ pi: makePi().pi, ctx: fixture.context, manager, workflowId: "wf-task" });
    const result = await runWorkflow({
      script: 'export const meta = { name: "task", description: "task receipt" }; return await agent("answer", { label: "binding", agentType: "task-worker", taskAssignment: args.assignment });',
      args: { assignment: fixture.assignment }, host,
      journal: { entries: [{ index: 0, key: journalKey({ prompt: "answer", label: "binding", agentType: "task-worker", taskAssignment: fixture.assignment }), ok: true, text: "do not replay" }] },
    });
    expect(result).toMatchObject({ status: "completed", value: "task answer", replayedCount: 0 });
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts?.[0].assignment).toEqual(fixture.assignment);
    expect(Object.isFrozen(result.receipts?.[0].sdk)).toBe(true);
    const task = createWorkflowTask({ id: "wf-task", script: "fixture" });
    completeWorkflowTask(task, result);
    expect(task.receipts).toEqual(result.receipts);
    expect(Object.isFrozen(task.receipts?.[0].sdk)).toBe(true);
    expect(task.value).toBe("task answer");
    expect(await host.spawnAgent({ agentId: "unapproved", index: 1, label: "bad gate", agentType: "task-worker", prompt: "no",
      taskAssignment: { ...fixture.assignment, attemptId: "other" }, gate: "unapproved-command" })).toMatchObject({ ok: false, error: "Task gate is not an approved check." });
    const schema = compileJsonSchema({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] });
    if (!schema.ok) throw new Error(schema.message);
    fixture.restore(); fixture = taskFixture(true);
    expect(await createWorkflowHost({ pi: makePi().pi, ctx: fixture.context, manager }).spawnAgent({ agentId: "schema", index: 1,
      label: "schema", agentType: "task-worker", prompt: "no", taskAssignment: { ...fixture.assignment, attemptId: "schema-attempt" }, schema: schema.compiled }))
      .toMatchObject({ ok: false, error: expect.stringContaining("Structured output/schema") });
    expect(sdk.create).toHaveBeenCalledOnce();
  });
});
