import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js";
import { AgentManager } from "../src/agent-manager.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import extension from "../src/index.js";
import { assertTaskCheckoutOwnership, captureTaskSource, immutableSnapshot, sameTaskContract, taskProfileFingerprint } from "../src/task-assignment.js";
import { snapshotTaskPlan, snapshotTaskReview, type TaskPlan, type TaskProjection, type TaskReview, TaskReviewSchema, taskBytesFingerprint } from "../src/task-plan.js";
import type { AgentReceipt, AgentRecord, Immutable, TaskAssignment } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { runWorkflow, type WorkflowHost } from "../src/workflow/runtime.js";
import { completeWorkflowTask, createWorkflowTask, resolveResumeTarget } from "../src/workflow/task.js";
import { TASK_CHECKPOINT_ENTRY } from "../src/workflow/task-plan.js";
import { flush, makePi, textOf } from "./helpers/boot-extension.js";
import { taskFixture } from "./helpers/task-fixture.js";

/** Mechanical bridge fixture: actual Git, parent SessionManager and worker VM;
 * worker execution/receipts are scripted, not provider/full-loop qualification. */
describe("opt-in sequential TaskPlan bridge", () => {
  let fixture: ReturnType<typeof taskFixture>;
  let manager: AgentManager;
  let parent: SessionManager;
  let plan: TaskPlan;
  let host: WorkflowHost;
  let pi: ReturnType<typeof makePi>["pi"];
  let records: Map<string, AgentRecord>;
  let receipts: Map<string, Immutable<AgentReceipt>>;
  let mutate: (() => void) | undefined;
  let verdict: TaskReview | undefined;
  let nextId: number;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    fixture = taskFixture(false, false);
    writeFileSync(join(fixture.cwd, "protected.txt"), "protected pre-existing dirty work\n");
    fixture.source = captureTaskSource(fixture.cwd);
    fixture.assignment.binding.sourceFingerprint = fixture.source.fingerprint;
    fixture.assignment.protectedBaseline["protected.txt"] = fixture.source.entries["protected.txt"];
    const builder = getAgentConfig("task-worker")!;
    const reviewer = { ...builder, name: "task-reviewer", isolated: false, builtinToolNames: ["read", "grep", "find", "ls"], systemPrompt: "Review only; do not author source." };
    registerAgents(new Map([[builder.name, builder], [reviewer.name, reviewer]]));
    plan = { version: 1, builder: structuredClone(fixture.assignment), reviewer: { ...structuredClone(fixture.assignment),
      role: "Reviewer", profile: reviewer.name, allowedPaths: [], allowedActions: ["read"], approvedChecks: [],
      configuration: { ...fixture.assignment.configuration, isolated: false, profileFingerprint: taskProfileFingerprint(reviewer) } } };
    parent = SessionManager.inMemory(fixture.cwd);
    fixture.context = { ...fixture.context, sessionManager: parent };
    pi = makePi().pi;
    pi.appendEntry.mockImplementation((type: string, data: unknown) => { parent.appendCustomEntry(type, data); });
    records = new Map(); receipts = new Map(); nextId = 0; mutate = undefined; verdict = undefined;
    manager = new AgentManager();
    vi.spyOn(manager, "getRecord").mockImplementation(id => records.get(id));
    vi.spyOn(manager, "getReceipt").mockImplementation(id => receipts.get(id));
    vi.spyOn(manager, "listAgents").mockImplementation(() => [...records.values()]);
    vi.spyOn(manager, "spawnAndWait").mockImplementation(async (_pi, _ctx, type, _prompt, options, onSpawned) => {
      const id = `mechanical-${++nextId}`;
      const assignment = options!.taskAssignment!;
      const record: AgentRecord = { id, type, description: "mechanical", status: "running", toolUses: 0, startedAt: 1,
        lifetimeUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }, compactionCount: 0, runSettled: false,
        taskAssignment: assignment, session: { isIdle: true, isCompacting: false, isBashRunning: false } as AgentSession };
      records.set(id, record); onSpawned?.(id);
      mutate?.(); mutate = undefined;
      record.status = "completed"; record.runSettled = true; record.result = "builder text";
      if (type === plan.reviewer.profile && verdict) { record.structuredJson = JSON.stringify(verdict); record.result = record.structuredJson; }
      const receipt: AgentReceipt = { version: 1, agentId: id, assignment, attempt: 1, profile: type,
        effective: { model: assignment.configuration.model, thinking: assignment.configuration.thinking, cwd: assignment.binding.workspace, configCwd: fixture.context.cwd },
        candidate: { fingerprint: captureTaskSource(assignment.binding.workspace).fingerprint, observedAt: 2, error: null },
        evidence: { required: assignment.evidence, transcript: null, sessionFile: null },
        execution: { status: "completed", settled: true, consumed: true, error: null, settlementError: null },
        sdk: { scope: "owned-sdk-session", allocated: true, sessionId: `sdk-${id}`, quiescent: true, disposition: "retained", cleanupError: null },
        usage: record.lifetimeUsage };
      receipts.set(id, immutableSnapshot(receipt));
      return { id, record };
    });
    vi.spyOn(manager, "resume").mockImplementation(async (id, _prompt, _signal, options) => {
      const assignment = options!.taskAssignment!;
      const record = records.get(id)!;
      mutate?.(); mutate = undefined;
      const previous = receipts.get(id)!;
      receipts.set(id, immutableSnapshot({ ...previous, assignment, attempt: previous.attempt + 1,
        candidate: { ...previous.candidate, fingerprint: captureTaskSource(fixture.cwd).fingerprint } }));
      return record;
    });
    host = createHost();
  });
  afterEach(async () => {
    await shutdown?.(); shutdown = undefined;
    vi.restoreAllMocks(); await manager.dispose(); fixture.restore();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    vi.useRealTimers();
  });
  function createHost(recoveryCheckpointId?: string) {
    return createWorkflowHost({ pi, ctx: fixture.context, manager, workflowId: "wf_mechanical", taskPlan: snapshotTaskPlan(plan), recoveryCheckpointId });
  }
  async function call(method: string, payload: unknown = null) { return await host.taskCall!(method, payload); }
  async function build() {
    const assignment = await call("prepare", { role: "builder" }) as Immutable<TaskAssignment>;
    const result = await host.spawnAgent({ agentId: "wf-agent-0", index: 0, label: "build", prompt: "mechanical only", agentType: assignment.profile, taskAssignment: assignment });
    expect(result).toMatchObject({ ok: true, text: "builder text", cwd: plan.builder.binding.workspace });
    return assignment;
  }
  async function freeze() { await build(); await call("check", "fixture-check"); return await call("freeze") as TaskProjection; }
  async function review(kind: "PASS" | "REJECT" = "PASS") {
    const fingerprint = host.taskProjection!().candidate!.fingerprint;
    verdict = { version: 1, status: "COMPLETE", candidateFingerprint: fingerprint, verdict: kind,
      findings: kind === "PASS" ? [] : [{ id: "F1", severity: "P1", path: "src/allowed.ts", description: "mechanical rejection" }], summary: "mechanical verdict" };
    const assignment = await call("prepare", { role: "reviewer" }) as Immutable<TaskAssignment>;
    await host.spawnAgent({ agentId: `review-${nextId}`, index: nextId, label: "review", agentType: assignment.profile,
      prompt: "mechanical review", taskAssignment: assignment });
    return await call("recordReview", verdict) as TaskProjection;
  }

  it.each(["missing", "authority", "scope", "role", "context", "profile", "configuration", "model", "effort", "path"])("rejects malformed/unbound %s before starting a worker", kind => {
    const changed = structuredClone(plan);
    if (kind === "missing") expect(() => snapshotTaskPlan({ version: 1, builder: plan.builder })).toThrow("TaskPlan");
    if (kind === "authority") changed.reviewer.authorityRef = "unrelated";
    if (kind === "scope") changed.reviewer.allowedPaths = ["outside"];
    if (kind === "role") changed.reviewer.allowedActions.push("write");
    if (kind === "context") changed.reviewer.configuration.inheritContext = true;
    if (kind === "profile") changed.builder.configuration.profileFingerprint = "a".repeat(64);
    if (kind === "configuration") changed.builder.configuration.maxTurns = 50;
    if (kind === "model") changed.builder.configuration.model = "missing/model";
    if (kind === "effort") changed.builder.configuration.thinking = "max";
    if (kind === "path") changed.builder.allowedPaths = ["../escape"];
    if (kind !== "missing") expect(() => createWorkflowHost({ pi, ctx: fixture.context, manager, taskPlan: snapshotTaskPlan(changed) })).toThrow(/task/i);
    expect(manager.spawnAndWait).not.toHaveBeenCalled();
  });
  it("has no facade on ordinary hosts and refuses mutable-task journal replay", async () => {
    const ordinary = createWorkflowHost({ pi, ctx: fixture.context, manager });
    expect(ordinary.taskCall).toBeUndefined();
    expect(await runWorkflow({ script: 'export const meta = { name: "ordinary", description: "ordinary" }; return typeof task;', host: ordinary })).toMatchObject({ value: "undefined" });
    await expect(runWorkflow({ script: 'export const meta = { name: "bound", description: "bound" }; return 1;', host,
      journal: { entries: [{ index: 0, key: "old", ok: true, text: "old writes" }] } })).rejects.toThrow("generic journal replay");
    const prior = createWorkflowTask({ id: "wf_old", script: "fixture", taskPlan: snapshotTaskPlan(plan), journalPath: "/unused" });
    prior.status = "completed";
    expect(resolveResumeTarget(prior.id, new Map([[prior.id, prior]]))).toMatchObject({ ok: false, message: expect.stringContaining("TaskPlan") });
  });
  it("worker facade round-trips realm-native assignment/checkpoint data and preserves text and budgets", async () => {
    const result = await runWorkflow({ host, args: { command: "fixture-check" }, script: 'export const meta = { name: "bridge", description: "mechanical" }; const a = await task.prepare("builder"); const text = await agent("mechanical", {label:"build",agentType:a.profile,taskAssignment:a}); const check = await task.check(args.command); const f = await task.freeze(); return {text,check:check.ok,native:a instanceof Object,step:f.safeStep,spent:budget.spent(),node:typeof process};' });
    expect(result).toMatchObject({ status: "completed", value: { text: "builder text", check: true, native: true, step: "frozen", spent: 2, node: "undefined" }, replayedCount: 0 });
    expect(result.receipts).toHaveLength(1);
    expect(result.taskProjection?.safeStep).toBe("frozen");
    expect(manager.spawnAndWait).toHaveBeenCalledWith(pi, fixture.context, "task-worker", "mechanical", expect.objectContaining({
      maxTurns: 4, isolated: true, inheritContext: false, thinkingLevel: "off" }), expect.any(Function));
  });
  it("runs only exact approved checks in canonical retained cwd; retains full private diagnostics on failing/killed checks", async () => {
    await expect(call("check", "fixture-check")).rejects.toThrow("author candidate");
    await build();
    await expect(call("check", "fixture-check ")).rejects.toThrow("exact approved");
    pi.exec.mockResolvedValueOnce({ stdout: "x".repeat(20_000), stderr: "real failure", code: 7, killed: false });
    const failed = await call("check", "fixture-check") as TaskProjection["checks"][number];
    expect(failed).toMatchObject({ ok: false, code: 7, killed: false });
    expect(failed.diagnostics).toHaveLength(8_000);
    expect(readFileSync(failed.artifact.path, "utf-8")).toContain("x".repeat(20_000));
    expect(lstatSync(failed.artifact.path).mode & 0o777).toBe(0o600);
    expect(pi.exec).toHaveBeenLastCalledWith("sh", ["-c", "fixture-check"], expect.objectContaining({ cwd: fixture.cwd, timeout: 600_000, signal: expect.any(AbortSignal) }));
    await expect(call("freeze")).rejects.toThrow("every approved check");
    await expect(call("check", "fixture-check")).rejects.toThrow("bounded reopen");
    await call("reopen", "repair failed check"); await build();
    pi.exec.mockResolvedValueOnce({ stdout: "", stderr: "timeout", code: 0, killed: true });
    expect(await call("check", "fixture-check")).toMatchObject({ ok: false, killed: true, diagnostics: "timeout" });
  });
  it("cancels an unawaited facade check through exec's signal without reporting a safe checkpoint", async () => {
    let cancelled = false;
    pi.exec.mockImplementationOnce(async (_shell: string, _args: string[], options: { signal: AbortSignal }) => {
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return { stdout: "", stderr: "cancelled", code: 0, killed: true };
    });
    const result = await runWorkflow({ host, script: 'export const meta = {name:"unawaited",description:"mechanical"}; const a = await task.prepare("builder"); await agent("mechanical",{agentType:a.profile,taskAssignment:a}); task.check("fixture-check"); return true;' });
    expect(result.status).toBe("failed"); expect(result.error).toContain("unawaited"); expect(cancelled).toBe(true);
    expect(result.taskProjection?.safeStep).toBe("checking");
    expect(() => createHost(result.taskProjection!.checkpoint!.id)).toThrow("interrupted/unknown writer");
  });
  it.each(["return true;", "throw new Error('script failed');", "abort"])("drains Task check after abort delivery before public terminal state: %s", async ending => {
    let release!: () => void; let aborted!: () => void;
    const received = new Promise<void>(resolve => { aborted = resolve; });
    const termination = new Promise<void>(resolve => { release = resolve; });
    const cancellation = new AbortController();
    pi.exec.mockImplementationOnce(async (_shell: string, _args: string[], options: { signal: AbortSignal }) => {
      options.signal.addEventListener("abort", aborted, { once: true });
      if (ending === "abort") cancellation.abort();
      await termination;
      writeFileSync(join(fixture.cwd, "src/allowed.ts"), "late check effect before settlement\n");
      return { stdout: "late diagnostics", stderr: "", code: 0, killed: true };
    });
    const publicTask = createWorkflowTask({ id: "wf_drain", script: "fixture", taskPlan: snapshotTaskPlan(plan) });
    const running = runWorkflow({ host, signal: cancellation.signal, script: `export const meta = {name:"drain",description:"mechanical"}; const a = await task.prepare("builder"); await agent("mechanical",{agentType:a.profile,taskAssignment:a}); task.check("fixture-check"); ${ending === "abort" ? "await new Promise(() => {});" : ending}` });
    void running.then(result => completeWorkflowTask(publicTask, result));
    try {
      await received; await new Promise(resolve => setTimeout(resolve, 100));
      expect(publicTask.status).toBe("running");
      expect(host.taskProjection!().safeStep).toBe("checking");
    } finally { release(); await running; }
    expect(readFileSync(join(fixture.cwd, "src/allowed.ts"), "utf-8")).toContain("late check effect");
    expect(publicTask.status).toBe(ending === "abort" ? "killed" : "failed");
    const calls = pi.exec.mock.calls.length; await flush(); expect(pi.exec.mock.calls).toHaveLength(calls);
  });
  it("drains a delayed Task author stop rather than treating abort as settlement", async () => {
    const spawn = vi.mocked(manager.spawnAndWait).getMockImplementation()!;
    let release!: () => void; let started!: () => void;
    const allocation = new Promise<void>(resolve => { started = resolve; });
    const termination = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(manager.spawnAndWait).mockImplementationOnce(async (...args) => {
      started(); await termination; return await spawn(...args);
    });
    const abort = vi.spyOn(manager, "abort");
    const publicTask = createWorkflowTask({ id: "wf_author", script: "fixture", taskPlan: snapshotTaskPlan(plan) });
    const running = runWorkflow({ host, script: 'export const meta = {name:"author",description:"mechanical"}; const a = await task.prepare("builder"); agent("mechanical",{agentType:a.profile,taskAssignment:a}); return true;' });
    void running.then(result => completeWorkflowTask(publicTask, result));
    try { await allocation; await new Promise(resolve => setTimeout(resolve, 100)); expect(publicTask.status).toBe("running"); }
    finally { release(); await running; }
    expect(publicTask.status).toBe("failed");
    // The pending startup had no id when aborted; task cancellation must also
    // reach that route, and no unrelated Manager work is drained.
    expect(abort.mock.calls.every(([id]) => id.startsWith("mechanical-"))).toBe(true);
  });
  it.each(["prepare", "admit", "check"])("blocks ordinary same-checkout ancestor/child/sibling workers at %s", async stage => {
    const sibling = join(fixture.cwd, ".pi");
    for (const [workspace, otherCwd] of [[join(fixture.cwd, "src"), fixture.cwd], [fixture.cwd, join(fixture.cwd, "src")], [join(fixture.cwd, "src"), sibling]]) {
      const source = captureTaskSource(workspace);
      for (const assignment of [plan.builder, plan.reviewer]) assignment.binding = { ...assignment.binding, workspace, sourceFingerprint: source.fingerprint };
      host = createHost(); records.clear(); receipts.clear();
      let assignment: Immutable<TaskAssignment> | undefined;
      if (stage === "check") await build();
      if (stage === "admit") assignment = await call("prepare", { role: "builder" }) as Immutable<TaskAssignment>;
      records.set("ordinary", { id: "ordinary", type: "task-worker", description: "ordinary", status: "stopped", runSettled: false,
        toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
        session: { sessionManager: { getCwd: () => otherCwd } } as AgentSession });
      const spawns = vi.mocked(manager.spawnAndWait).mock.calls.length; const commands = pi.exec.mock.calls.length;
      if (stage === "admit") await expect(host.spawnAgent({ agentId: "conflict", index: 1, label: "bad", prompt: "never", agentType: assignment!.profile, taskAssignment: assignment })).rejects.toThrow(/workspace|checkout/);
      else await expect(call(stage, stage === "prepare" ? { role: "builder" } : "fixture-check")).rejects.toThrow(/workspace|checkout/);
      expect(manager.spawnAndWait).toHaveBeenCalledTimes(spawns); expect(pi.exec).toHaveBeenCalledTimes(commands);
    }
  });
  it("retains diagnostics from an actual failing local command without asking a verification model", async () => {
    const command = "node -e 'process.stderr.write(\"repair diagnostics\"); process.exit(7)'";
    plan.builder.approvedChecks = [command]; host = createHost();
    pi.exec.mockImplementation(async (shell: string, args: string[], options: { cwd: string; timeout: number }) => {
      const result = spawnSync(shell, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf-8" });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? -1, killed: result.signal !== null };
    });
    await build();
    expect(await call("check", command)).toMatchObject({ ok: false, code: 7, killed: false, diagnostics: "repair diagnostics" });
    expect(manager.spawnAndWait).toHaveBeenCalledOnce();
  });
  it.each(["source", "index", "untracked", "mode", "symlink", "protected"])("invalidates checks/freeze/review on %s drift", async kind => {
    await freeze();
    if (kind === "source") writeFileSync(join(fixture.cwd, "src/allowed.ts"), "changed");
    if (kind === "index") fixture.git("add", "--", "src/allowed.ts", "protected.txt");
    if (kind === "untracked") writeFileSync(join(fixture.cwd, "src/new.ts"), "new");
    if (kind === "mode") chmodSync(join(fixture.cwd, "src/allowed.ts"), 0o755);
    if (kind === "symlink") symlinkSync("allowed.ts", join(fixture.cwd, "src/link.ts"));
    if (kind === "protected") writeFileSync(join(fixture.cwd, "protected.txt"), "forbidden drift");
    await expect(call("prepare", { role: "reviewer" })).rejects.toThrow(/source moved|protected baseline/);
  });
  it("a mutating check cannot green-light its output or a later unverified candidate", async () => {
    await build();
    pi.exec.mockImplementationOnce(async () => { writeFileSync(join(fixture.cwd, "src/allowed.ts"), "check mutated source"); return { stdout: "mutated", stderr: "", code: 0, killed: false }; });
    const check = await call("check", "fixture-check") as TaskProjection["checks"][number];
    expect(check.ok).toBe(false); expect(check.before).not.toBe(check.after);
    await expect(call("freeze")).rejects.toThrow("source moved");
  });
  it.each(["stopped", "unsettled", "missing", "sdk", "wrong-cwd"])("refuses %s current writer rather than infer idle", async kind => {
    await build();
    const id = "mechanical-1";
    const previous = receipts.get(id)!;
    if (kind === "missing") receipts.delete(id);
    if (kind === "stopped") receipts.set(id, immutableSnapshot({ ...previous, execution: { ...previous.execution, status: "stopped" } }));
    if (kind === "unsettled") receipts.set(id, immutableSnapshot({ ...previous, execution: { ...previous.execution, settled: false } }));
    if (kind === "sdk") Object.defineProperty(records.get(id)!.session!, "isBashRunning", { value: true });
    if (kind === "wrong-cwd") receipts.set(id, immutableSnapshot({ ...previous, effective: { ...previous.effective, cwd: "/tmp" } }));
    await expect(call("check", "fixture-check")).rejects.toThrow(/receipt|SDK|binding/);
    expect(pi.exec).not.toHaveBeenCalled();
  });
  it("accepts settled/quiescent steered authors without relabelling the receipt", async () => {
    await build(); const previous = receipts.get("mechanical-1")!;
    records.get("mechanical-1")!.status = "steered";
    receipts.set("mechanical-1", immutableSnapshot({ ...previous, execution: { ...previous.execution, status: "steered" } }));
    expect(await call("check", "fixture-check")).toMatchObject({ ok: true });
    expect((await call("freeze") as TaskProjection).candidate).not.toBeNull();
    expect(receipts.get("mechanical-1")!.execution.status).toBe("steered");
  });
  it("actual SDK exec/local Node SIGTERM delay cannot write after public completion", async () => {
    mkdirSync(join(fixture.cwd, "ignored"));
    const program = join(fixture.cwd, "src/cancel.cjs"); const ready = join(fixture.cwd, "ignored/ready");
    writeFileSync(program, 'const fs = require("node:fs"); process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync("src/allowed.ts", "late SDK effect\\n"); process.exit(0); }, 150)); fs.writeFileSync("ignored/ready", "ready"); setTimeout(() => process.exit(2), 2000);');
    const source = captureTaskSource(fixture.cwd); const command = `exec "${process.execPath}" "${program}"`;
    for (const assignment of [plan.builder, plan.reviewer]) assignment.binding.sourceFingerprint = source.fingerprint;
    plan.builder.approvedChecks = [command]; host = createHost();
    pi.exec.mockImplementation((shell: string, args: string[], options: { cwd: string; signal: AbortSignal; timeout: number }) => execCommand(shell, args, options.cwd, options));
    const cancellation = new AbortController(); let terminal = false;
    const running = runWorkflow({ host, signal: cancellation.signal, args: { command }, script: 'export const meta = {name:"sdk-exec",description:"mechanical author; actual SDK exec"}; const a = await task.prepare("builder"); await agent("mechanical",{agentType:a.profile,taskAssignment:a}); await task.check(args.command);' });
    void running.then(() => { terminal = true; });
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2500, interval: 10 });
      cancellation.abort(); await new Promise(resolve => setTimeout(resolve, 50)); expect(terminal).toBe(false);
    } finally { cancellation.abort(); await running; }
    expect(await running).toMatchObject({ status: "killed", taskProjection: { ownership: { state: "released" } } });
    expect(readFileSync(join(fixture.cwd, "src/allowed.ts"), "utf-8")).toBe("late SDK effect\n");
    await new Promise(resolve => setTimeout(resolve, 200)); expect(readFileSync(join(fixture.cwd, "src/allowed.ts"), "utf-8")).toBe("late SDK effect\n");
  });
  it("rejects pending preparation, wrong cwd and unprepared ordinary downgrade", async () => {
    const assignment = await call("prepare", { role: "builder" }) as Immutable<TaskAssignment>;
    await expect(call("check", "fixture-check")).rejects.toThrow("pending");
    await expect(host.spawnAgent({ agentId: "bad", index: 0, label: "bad", prompt: "bad", agentType: assignment.profile, taskAssignment: assignment, cwd: "/tmp" })).rejects.toThrow("prepared role contract");
    await expect(host.spawnAgent({ agentId: "bad", index: 0, label: "bad", prompt: "bad", agentType: "general-purpose" })).rejects.toThrow("prepared role contract");
    expect(manager.spawnAndWait).not.toHaveBeenCalled();
  });
  it("binds the actual fresh COMPLETE Reviewer output; plain SUCCESS and fake/stale verdicts cannot pass", async () => {
    await freeze(); await review();
    expect(host.taskProjection!().review?.verdict.verdict).toBe("PASS");
    expect(() => snapshotTaskReview({ status: "SUCCESS" })).toThrow("COMPLETE");
    await expect(call("reopen", "unnecessary")).rejects.toThrow("rejection");
  });
  it.each(["fake", "stale", "incomplete", "author-session", "resumed-reviewer"])("rejects %s Reviewer evidence", async kind => {
    await freeze();
    const fingerprint = host.taskProjection!().candidate!.fingerprint;
    verdict = { version: 1, status: "COMPLETE", candidateFingerprint: fingerprint, verdict: "PASS", findings: [], summary: "actual" };
    const assignment = await call("prepare", { role: "reviewer" }) as Immutable<TaskAssignment>;
    await host.spawnAgent({ agentId: "review", index: 1, label: "review", agentType: assignment.profile, prompt: "review", taskAssignment: assignment });
    if (kind === "fake") verdict.summary = "not actual output";
    if (kind === "stale") verdict.candidateFingerprint = "a".repeat(64);
    if (kind === "incomplete") records.get("mechanical-2")!.structuredJson = undefined;
    if (kind === "author-session" || kind === "resumed-reviewer") {
      const receipt = receipts.get("mechanical-2")!;
      receipts.set("mechanical-2", immutableSnapshot({ ...receipt, ...(kind === "author-session" ? { sdk: { ...receipt.sdk, sessionId: "sdk-mechanical-1" } } : { attempt: 2 }) }));
    }
    await expect(call("recordReview", verdict)).rejects.toThrow(/verdict|fresh|evidence drifted/);
  });
  it("bounds repairs across fresh workers; Builder resume preserves initial contract except attemptId", async () => {
    await freeze(); await review("REJECT");
    await call("reopen", "address F1");
    expect(host.taskProjection!()).toMatchObject({ remediations: 1, checks: [], candidate: null, review: null });
    const original = receipts.get("mechanical-1")!.assignment;
    const assignment = await call("prepare", { role: "builder", resume: "build" }) as Immutable<TaskAssignment>;
    expect(sameTaskContract(original, assignment)).toBe(true); expect(assignment.attemptId).not.toBe(original.attemptId);
    mutate = () => writeFileSync(join(fixture.cwd, "src/allowed.ts"), "repair\n");
    expect(await host.resumeAgent!("wf-agent-0", "repair", undefined, assignment)).toMatchObject({ ok: true });
    await call("check", "fixture-check"); await call("freeze"); await review("REJECT");
    await call("reopen", "second correction"); await build(); await call("check", "fixture-check"); await call("freeze"); await review("REJECT");
    await expect(call("reopen", "would exceed bound")).rejects.toThrow("maxRemediations");
  }, 30_000);
  it("recovers only the latest known-safe selected-branch projection without replaying completed writes", async () => {
    await freeze(); const reviewed = await review();
    const checkpoint = reviewed.checkpoint!.id;
    const calls = vi.mocked(manager.spawnAndWait).mock.calls.length;
    host = createHost(checkpoint);
    expect(host.taskProjection!()).toMatchObject({ safeStep: "reviewed", remediations: 0, review: { verdict: { verdict: "PASS" } } });
    expect(vi.mocked(manager.spawnAndWait).mock.calls).toHaveLength(calls);
    // The SDK-selected branch excludes the entry after branch selection.
    parent.branch(parent.getBranch().find(entry => entry.type === "custom" && entry.customType === TASK_CHECKPOINT_ENTRY)!.id);
    expect(() => createHost(checkpoint)).toThrow("selected session branch");
  });
  it.each(["legacy", "blank", "source", "count", "tampered"])("refuses %s reopened remediation context before preparing a new worker", async kind => {
    await freeze(); await review("REJECT");
    const reason = "Address only actual F1: mechanical rejection";
    const reopened = await call("reopen", reason) as TaskProjection;
    expect(reopened.remediation).toEqual({ reason, sourceFingerprint: reopened.sourceFingerprint, remediations: 1 });
    const checkpoint = reopened.checkpoint!;
    const entry = parent.getBranch().find(entry => entry.type === "custom" && entry.customType === TASK_CHECKPOINT_ENTRY
      && (entry.data as { id: string }).id === checkpoint.id)!;
    const data = entry.data as { artifact: { path: string; sha256: string } };
    const projection = JSON.parse(readFileSync(checkpoint.artifact.path, "utf-8")) as TaskProjection;
    if (kind === "legacy") delete projection.remediation;
    if (kind === "blank") projection.remediation!.reason = " ";
    if (kind === "source") projection.remediation!.sourceFingerprint = "a".repeat(64);
    if (kind === "count") projection.remediation!.remediations = 0;
    if (kind === "tampered") projection.remediation!.reason = "substituted context";
    const bytes = Buffer.from(JSON.stringify(projection) + "\n");
    writeFileSync(checkpoint.artifact.path, bytes);
    // A valid enclosing artifact models a legacy/malformed observation;
    // unauthenticated byte tampering must independently fail its hash check.
    if (kind !== "tampered") data.artifact.sha256 = taskBytesFingerprint(bytes);
    const workers = nextId;
    expect(() => createHost(checkpoint.id)).toThrow(kind === "tampered" ? /artifact bytes drifted/ : /remediation context/);
    expect(nextId).toBe(workers);
  });
  it.each(["missing-writer", "interrupted", "source", "artifact", "stale", "cross-session", "instructions", "configuration"])("refuses %s checkpoint continuation", async kind => {
    await freeze();
    const checkpoint = host.taskProjection!().checkpoint!;
    if (kind === "missing-writer") receipts.clear();
    if (kind === "interrupted") { await call("prepare", { role: "reviewer" }); }
    if (kind === "source") writeFileSync(join(fixture.cwd, "src/allowed.ts"), "checkpoint drift");
    if (kind === "artifact") writeFileSync(host.taskProjection!().checks[0].artifact.path, "tampered");
    if (kind === "stale") await call("checkpoint");
    if (kind === "cross-session") fixture.context = { ...fixture.context, sessionManager: SessionManager.inMemory(fixture.cwd) };
    if (kind === "instructions") writeFileSync(join(fixture.cwd, "AGENTS.md"), "changed instructions");
    if (kind === "configuration") writeFileSync(join(fixture.cwd, ".pi", "settings.json"), "{}");
    expect(() => createHost(checkpoint.id)).toThrow(/receipt|stale|source moved|artifact|session branch|foreign/);
  });
  function bootPublic() {
    // Inert worker plumbing on the actual registered public tool's own Manager.
    const profileFile = join(fixture.cwd, ".pi/agents/task-reviewer.md");
    writeFileSync(profileFile, '---\nextensions: false\nskills: false\nisolated: false\ninherit_context: false\nthinking: off\nmax_turns: 4\npersist_session: false\noutput_transcript: false\ntools: read,grep,find,ls\n---\nReview only; do not author source.');
    const booted = makePi(); extension(booted.pi); shutdown = () => booted.lifecycle.get("session_shutdown")();
    booted.pi.appendEntry.mockImplementation((type: string, data: unknown) => { parent.appendCustomEntry(type, data); });
    plan.reviewer.configuration.profileFingerprint = taskProfileFingerprint(getAgentConfig("task-reviewer")!);
    const source = captureTaskSource(fixture.cwd);
    for (const assignment of [plan.builder, plan.reviewer]) assignment.binding.sourceFingerprint = source.fingerprint;
    for (const method of ["getRecord", "getReceipt", "listAgents", "spawnAndWait", "resume"] as const) {
      // Preserve types of each signature rather than erasing the public seam.
      if (method === "getRecord") vi.spyOn(AgentManager.prototype, method).mockImplementation(id => records.get(id));
      if (method === "getReceipt") vi.spyOn(AgentManager.prototype, method).mockImplementation(id => receipts.get(id));
      if (method === "listAgents") vi.spyOn(AgentManager.prototype, method).mockImplementation(() => [...records.values()]);
      if (method === "spawnAndWait") vi.spyOn(AgentManager.prototype, method).mockImplementation(vi.mocked(manager.spawnAndWait).getMockImplementation()!);
      if (method === "resume") vi.spyOn(AgentManager.prototype, method).mockImplementation(vi.mocked(manager.resume).getMockImplementation()!);
    }
    return { booted, tool: booted.tools.get("SubagentWorkflow") };
  }
  it("public recovery uses a new run ID and selected parent branch, then a fresh structured Reviewer", async () => {
    const { booted, tool } = bootPublic();
    let notified!: (value: { details: { id: string; taskProjection: TaskProjection } }) => void;
    const first = new Promise<{ details: { id: string; taskProjection: TaskProjection } }>(resolve => { notified = resolve; });
    booted.pi.sendMessage.mockImplementation(notified);
    const started = await tool.execute("first", { taskPlan: plan, script: 'export const meta = {name:"public-freeze",description:"inert worker plumbing"}; const a = await task.prepare("builder"); await agent("mechanical",{agentType:a.profile,taskAssignment:a}); await task.check("fixture-check"); return await task.freeze();' }, undefined, undefined, fixture.context);
    const frozen = (await first).details;
    expect(frozen.taskProjection).toMatchObject({ safeStep: "frozen", ownership: { state: "released" } });
    expect(frozen.id).toBe(started.details.taskId);
    const calls = vi.mocked(manager.spawnAndWait).mock.calls.length; // Public owns a different Manager; map is shared, not its call counter.
    const workers = nextId;
    const checkpoint = frozen.taskProjection.checkpoint!.id;
    expect(parent.getBranch().some(entry => entry.type === "custom" && entry.customType === TASK_CHECKPOINT_ENTRY && (entry.data as { id?: string }).id === checkpoint)).toBe(true);
    verdict = { version: 1, status: "COMPLETE", candidateFingerprint: frozen.taskProjection.candidate!.fingerprint, verdict: "PASS", findings: [], summary: "inert public review" };
    const second = new Promise<{ details: { id: string; taskProjection: TaskProjection } }>(resolve => { notified = resolve; });
    booted.pi.sendMessage.mockImplementation(notified);
    const resumed = await tool.execute("second", { taskPlan: plan, recoveryCheckpointId: checkpoint, args: { schema: JSON.parse(JSON.stringify(TaskReviewSchema)) },
      script: 'export const meta = {name:"public-recover",description:"inert recovery"}; const a = await task.prepare("reviewer"); const v = await agent("mechanical review",{agentType:a.profile,taskAssignment:a,schema:args.schema}); const p = await task.recordReview(v); return {candidate:p.candidate.fingerprint,verdict:p.review.verdict.verdict};' }, undefined, undefined, fixture.context);
    expect(resumed.details.taskId).not.toBe(started.details.taskId);
    const reviewed = (await second).details;
    expect(reviewed).not.toHaveProperty("error", expect.any(String));
    expect(reviewed.taskProjection).toMatchObject({ runId: frozen.id, safeStep: "reviewed", review: { verdict: { verdict: "PASS" }, receipt: { attempt: 1 } }, ownership: { state: "released" } });
    expect(nextId).toBe(workers + 1); expect(manager.spawnAndWait).toHaveBeenCalledTimes(calls);
    expect(reviewed.taskProjection.attempts.at(-1)!.receipt!.sdk.sessionId).not.toBe(frozen.taskProjection.attempts[0].receipt!.sdk.sessionId);
  }, 15_000);
  it("public tool retains same-checkout ownership until check termination, including subdirectory re-admission", async () => {
    const { booted, tool } = bootPublic(); let release!: () => void; let aborted!: () => void;
    const received = new Promise<void>(resolve => { aborted = resolve; }); const termination = new Promise<void>(resolve => { release = resolve; });
    booted.pi.exec.mockImplementationOnce(async (_shell: string, _args: string[], options: { signal: AbortSignal }) => {
      options.signal.addEventListener("abort", aborted, { once: true }); await termination;
      return { stdout: "settled", stderr: "", code: 0, killed: true };
    });
    const notified = new Promise<{ details: { taskProjection: TaskProjection } }>(resolve => booted.pi.sendMessage.mockImplementation(resolve));
    await tool.execute("first", { taskPlan: plan, script: 'export const meta = {name:"public-held",description:"inert plumbing"}; const a = await task.prepare("builder"); await agent("mechanical",{agentType:a.profile,taskAssignment:a}); task.check("fixture-check"); return true;' }, undefined, undefined, fixture.context);
    try {
      await received; await new Promise(resolve => setTimeout(resolve, 100)); expect(booted.pi.sendMessage).not.toHaveBeenCalled();
      const subplan = structuredClone(plan); const source = captureTaskSource(join(fixture.cwd, "src"));
      for (const assignment of [subplan.builder, subplan.reviewer]) assignment.binding = { ...assignment.binding, workspace: source.workspace, sourceFingerprint: source.fingerprint };
      const refused = await tool.execute("overlap", { taskPlan: subplan, script: 'export const meta = {name:"never",description:"never"}; return true;' }, undefined, undefined, fixture.context);
      expect(textOf(refused)).toContain("owner"); expect(refused.details?.taskId).toBeUndefined();
    } finally { release(); await notified; }
    expect((await notified).details.taskProjection.ownership?.state).toBe("released");
  }, 15_000);
  it("public Task timeout retains ownership across branch selection and rejects re-admission even after late settlement", async () => {
    const { booted, tool } = bootPublic(); let release!: () => void; let aborted!: () => void;
    const received = new Promise<void>(resolve => { aborted = resolve; }); const termination = new Promise<void>(resolve => { release = resolve; });
    let operation!: Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
    booted.pi.exec.mockImplementationOnce((_shell: string, _args: string[], options: { signal: AbortSignal }) => {
      options.signal.addEventListener("abort", aborted, { once: true });
      operation = termination.then(() => ({ stdout: "late termination", stderr: "", code: 0, killed: true })); return operation;
    });
    const notified = new Promise<{ details: { error: string; taskProjection: TaskProjection } }>(resolve => booted.pi.sendMessage.mockImplementation(resolve));
    await tool.execute("timeout", { taskPlan: plan, script: 'export const meta = {name:"public-timeout",description:"inert plumbing"}; const a = await task.prepare("builder"); await agent("mechanical",{agentType:a.profile,taskAssignment:a}); task.check("fixture-check"); return true;' }, undefined, undefined, fixture.context);
    try {
      await received; const result = (await notified).details;
      expect(result.error).toContain("settlement timed out"); expect(result.taskProjection.ownership?.state).toBe("unconfirmed");
      const originalBranch = parent.getBranch(); parent.branch(originalBranch[0].id);
      expect(parent.getBranch().some(entry => entry.type === "custom" && entry.customType === "subagents:task-ownership-unconfirmed")).toBe(false);
      expect(() => assertTaskCheckoutOwnership(fixture.context, fixture.cwd)).toThrow("Human-owned settlement");
      const workers = nextId;
      const refused = await tool.execute("blocked", { taskPlan: plan, script: 'export const meta = {name:"never",description:"never"}; return true;' }, undefined, undefined, fixture.context);
      expect(textOf(refused)).toContain("ownership is unconfirmed"); expect(refused.details?.taskId).toBeUndefined(); expect(nextId).toBe(workers);
    } finally { release(); await operation; await flush(); }
    expect(host.taskProjection!().ownership?.state).toBe("held"); // Unrelated host owns no effects of this public run.
    expect(() => assertTaskCheckoutOwnership(fixture.context, fixture.cwd)).toThrow("ownership is unconfirmed");
  }, 15_000);
  it("finish refuses current SDK activity despite a formerly settled author receipt", async () => {
    await build(); records.get("mechanical-1")!.session!.isBashRunning = true;
    const result = await runWorkflow({ host, script: 'export const meta = {name:"sdk-busy",description:"mechanical"}; return true;' });
    expect(result).toMatchObject({ status: "failed", taskProjection: { ownership: { state: "unconfirmed" } } });
    expect(result.error).toContain("actual SDK settlement/quiescence is unconfirmed");
    expect(() => createHost()).toThrow("ownership is unconfirmed");
    Object.defineProperty(records.get("mechanical-1")!.session!, "isBashRunning", { value: false });
  });
  it("Task finish does not drain or stop unrelated Manager work", async () => {
    records.set("unrelated", { id: "unrelated", type: "ordinary", description: "outside checkout", status: "running", runSettled: false,
      toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
      session: { sessionManager: { getCwd: () => "/tmp" } } as AgentSession, promise: new Promise(() => {}) });
    const abort = vi.spyOn(manager, "abort"); const wait = vi.spyOn(manager, "waitForAll");
    expect(await runWorkflow({ host, script: 'export const meta = {name:"owned-only",description:"mechanical"}; return true;' })).toMatchObject({ status: "completed", taskProjection: { ownership: { state: "released" } } });
    expect(abort).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled(); expect(records.get("unrelated")!.status).toBe("running");
    records.delete("unrelated");
  });
  it("tool registration opts in, refuses generic replay/recovery downgrade and reports malformed plans without starting", async () => {
    const booted = makePi();
    extension(booted.pi); shutdown = () => booted.lifecycle.get("session_shutdown")();
    const tool = booted.tools.get("SubagentWorkflow");
    expect(tool.parameters.properties).toHaveProperty("taskPlan");
    expect(tool.parameters.properties).toHaveProperty("recoveryCheckpointId");
    expect(textOf(await tool.execute("bad", { taskPlan: {}, script: "not run" }, undefined, undefined, fixture.context))).toContain("TaskPlan");
    expect(textOf(await tool.execute("bad", { taskPlan: plan, resumeFromRunId: "wf_old" }, undefined, undefined, fixture.context))).toContain("refuse");
    expect(textOf(await tool.execute("bad", { recoveryCheckpointId: "unknown" }, undefined, undefined, fixture.context))).toContain("requires");
    expect(TaskReviewSchema.properties.status.const).toBe("COMPLETE");
  });
});
