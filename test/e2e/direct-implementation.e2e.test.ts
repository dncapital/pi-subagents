import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FauxContentBlock, type FauxResponseFactory, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js";
import { AgentManager } from "../../src/agent-manager.js";
import { getAgentConfig } from "../../src/agent-types.js";
import { type DirectTaskSelector } from "../../src/direct-task.js";
import extension from "../../src/index.js";
import { captureTaskSource, taskProfileFingerprint } from "../../src/task-assignment.js";
import { type TaskPlan, type TaskProjection, TaskReviewSchema } from "../../src/task-plan.js";
import type { WorkflowDialog } from "../../src/ui/workflow-dialog.js";
import { WorkflowTaskPlan } from "../../src/workflow/task-plan.js";
import { makePi } from "../helpers/boot-extension.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";
import { taskFixture } from "../helpers/task-fixture.js";

const recipePath = fileURLToPath(new URL("../../examples/workflows/direct-implementation.js", import.meta.url));
const recipe = readFileSync(recipePath, "utf-8");
const initial = 'module.exports = input => 0;\n';
const partial = 'module.exports = input => { const n = Number(input); if (!Number.isFinite(n) || n <= 0) throw new Error("limit"); return n; };\n';
const final = 'module.exports = input => { if ((typeof input !== "number" && typeof input !== "string") || (typeof input === "string" && !input.trim())) throw new Error("limit"); const n = Number(input); if (!Number.isFinite(n) || n <= 0) throw new Error("limit"); return n; };\n';
const instructions = "Implement a positive finite limit parser in src/limit.cjs; accept positive numbers/numeric strings, reject booleans, blank strings and nonfinite/nonpositive values. Preserve other source. No publication.";
type Notification = { details: { id: string; status: string; error?: string; resultPreview: string; taskProjection: TaskProjection } };

/** Actual saved script/public tool, worker VM, Manager, SDK child sessions,
 * built-in read/write/StructuredOutput and local exec. ExtensionAPI/context and
 * model registry/auth are structural fixture mocks; provider answers are faux,
 * not subscribed-provider qualification. No parent model is prompted. */
describe("saved Direct synthetic integrated qualification", () => {
  let fixture: ReturnType<typeof taskFixture>;
  let boot: ReturnType<typeof makePi>;
  let faux: ReturnType<typeof registerFauxProvider>;
  let plan: TaskPlan;
  let starts: ReturnType<typeof vi.spyOn<AgentManager, "spawnAndWait">>;
  let providerCalls: number;
  let builderTurns: number;
  let reviewerTurns: number;
  let reviewerOutputs: string[];
  let mode: "loop" | "recovery" | "check-recovery" | "reject-recovery" | "incomplete" | "malformed" | "null-builder";
  let baseline: ReturnType<typeof captureTaskSource>;
  let originalIndex: string;

  beforeEach(() => {
    fixture = taskFixture(false, true);
    writeFileSync(join(fixture.cwd, "src/limit.cjs"), initial);
    writeFileSync(join(fixture.cwd, "src/check.cjs"), 'const assert = require("node:assert/strict"); const limit = require("./limit.cjs"); assert.equal(limit(3), 3); assert.equal(limit("2.5"), 2.5); for (const v of [0, -1, Infinity, "Infinity", "no"]) assert.throws(() => limit(v)); console.log("positive finite check passed");\n');
    writeFileSync(join(fixture.cwd, "protected.txt"), "protected staged work\n");
    fixture.git("add", "--", "protected.txt"); // Test-owned Git only.
    writeFileSync(join(fixture.cwd, "protected.txt"), "protected staged plus dirty work\n");
    writeFileSync(join(fixture.cwd, "src/context.txt"), "protected git-visible untracked context\n");
    writeFileSync(join(fixture.cwd, ".pi/agents/task-reviewer.md"), '---\nextensions: false\nskills: false\nisolated: false\ninherit_context: false\nthinking: off\nmax_turns: 4\npersist_session: false\noutput_transcript: true\ntools: read,grep,find,ls\n---\nReview only; do not author source.');
    boot = makePi(); extension(boot.pi);
    const parent = SessionManager.inMemory(fixture.cwd);
    boot.pi.appendEntry.mockImplementation((type: string, data: unknown) => parent.appendCustomEntry(type, data));
    boot.pi.exec.mockImplementation((shell: string, args: string[], options: { cwd: string; signal: AbortSignal; timeout: number }) => execCommand(shell, args, options.cwd, options));
    faux = registerFauxProvider({ provider: "direct-faux", models: [{ id: "direct-model", contextWindow: 200_000 }] });
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    fixture.context = { ...fixture.context, model, sessionManager: parent,
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime } };
    baseline = captureTaskSource(fixture.cwd);
    originalIndex = fixture.git("ls-files", "--stage");
    const assignment = { ...fixture.assignment, binding: { ...fixture.assignment.binding, sourceFingerprint: baseline.fingerprint },
      protectedBaseline: { ...fixture.assignment.protectedBaseline, "protected.txt": baseline.entries["protected.txt"], "src/context.txt": baseline.entries["src/context.txt"] },
      allowedPaths: ["src/limit.cjs"], approvedChecks: ["node src/check.cjs", "node --check src/limit.cjs"],
      configuration: { ...fixture.assignment.configuration, model: `${model.provider}/${model.id}` } };
    plan = { version: 1, builder: assignment, reviewer: { ...structuredClone(assignment), role: "Reviewer", profile: "task-reviewer",
      allowedActions: ["read"], approvedChecks: [], configuration: { ...assignment.configuration, isolated: false,
        profileFingerprint: taskProfileFingerprint(getAgentConfig("task-reviewer")!) } } };
    starts = vi.spyOn(AgentManager.prototype, "spawnAndWait"); // Passive counter; execution is not stubbed.
    providerCalls = 0; builderTurns = 0; reviewerTurns = 0; reviewerOutputs = []; mode = "loop";
    faux.setResponses(Array.from({ length: 40 }, () => (context: Parameters<FauxResponseFactory>[0] & { tools?: readonly { name: string }[] }) => {
      providerCalls++;
      const seen = JSON.stringify(context.messages);
      // SDK84 supplies tools directly; SDK99 replays system-message tool deltas.
      // getCurrentTools is not exported by SDK84.
      const tools = new Set(context.tools?.map(tool => tool.name));
      for (const message of context.messages) {
        const state: { role: string; toolsAdded?: readonly { name: string }[]; toolsRemoved?: readonly { name: string }[] } = message;
        if (state.role !== "system") continue;
        for (const tool of state.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of state.toolsAdded ?? []) tools.add(tool.name);
      }
      const reviewer = tools.has("StructuredOutput");
      let block: FauxContentBlock;
      if (!reviewer) {
        if (mode === "null-builder") return fauxAssistantMessage([], { stopReason: "error", errorMessage: "scripted builder failure" });
        if (!context.messages.some(message => message.role === "toolResult" && message.toolName === "write")) {
          builderTurns++;
          const content = mode === "check-recovery" ? (seen.includes("Repair only these actual check failures:") && seen.includes("AssertionError") ? final : initial)
            : mode === "reject-recovery" ? (seen.includes("Address only the COMPLETE independent review findings:") && seen.includes("Boolean true is coerced to 1") ? final : partial)
            : mode === "recovery" ? final : builderTurns === 1 ? initial : builderTurns === 2 ? partial : final;
          block = fauxToolCall("write", { path: "src/limit.cjs", content });
        } else block = fauxText("Scoped implementation complete; checks remain host-owned.");
      } else if (!context.messages.some(message => message.role === "toolResult" && message.toolName === "read")) {
        reviewerTurns++;
        block = fauxToolCall("read", { path: "src/limit.cjs" });
      } else if (mode === "incomplete") {
        reviewerOutputs.push("incomplete");
        block = fauxText("SUCCESS (not a COMPLETE verdict)");
      } else if (!seen.includes("Recorded.")) {
        reviewerOutputs.push(mode === "malformed" ? "PARTIAL" : "COMPLETE");
        const reject = readFileSync(join(fixture.cwd, "src/limit.cjs"), "utf-8") === partial;
        block = fauxToolCall("StructuredOutput", { version: 1, status: mode === "malformed" ? "PARTIAL" : "COMPLETE",
          candidateFingerprint: captureTaskSource(fixture.cwd).fingerprint, verdict: reject ? "REJECT" : "PASS",
          findings: reject ? [{ id: "boolean", severity: "P1", path: "src/limit.cjs", description: "Boolean true is coerced to 1; reject boolean input." }] : [], summary: "Synthetic complete contract review" });
      } else block = fauxText("Review recorded.");
      return fauxAssistantMessage([block], { stopReason: block.type === "toolCall" ? "toolUse" : "stop" });
    }));
  });
  afterEach(async () => {
    await boot?.lifecycle.get("session_shutdown")();
    faux?.unregister(); vi.restoreAllMocks(); fixture?.restore();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  });

  async function invoke(options: { script?: string; checkpoint?: string } = {}) {
    let notify!: (value: Notification) => void;
    const completed = new Promise<Notification>(resolve => { notify = resolve; });
    boot.pi.sendMessage.mockImplementation(notify);
    const started = await boot.tools.get("SubagentWorkflow").execute("synthetic", {
      taskPlan: plan, ...(options.script ? { script: options.script } : { scriptPath: recipePath }),
      ...(options.checkpoint ? { recoveryCheckpointId: options.checkpoint } : {}),
      args: { task: instructions, ...(options.checkpoint ? { continueFromCheckpoint: true } : {}) },
    }, undefined, undefined, fixture.context);
    expect(started.details.taskId).toBeDefined();
    return { started, result: (await completed).details };
  }
  function protectedUnchanged() {
    const after = captureTaskSource(fixture.cwd);
    expect(after.head).toBe(baseline.head); expect(after.branch).toBe(baseline.branch);
    expect(fixture.git("ls-files", "--stage")).toBe(originalIndex);
    for (const path of ["protected.txt", "src/context.txt", "src/check.cjs"]) expect(after.entries[path]).toEqual(baseline.entries[path]);
    expect(fixture.git("diff", "--cached")).toContain("protected staged work");
  }

  it("failed checks -> scoped repair -> fresh REJECT -> repair/refreeze -> new PASS", async () => {
    const { result } = await invoke();
    expect(result.error).toBeUndefined();
    expect(result.resultPreview).toContain('"status": "locally-ready-for-human"');
    expect(result.resultPreview).toContain('"mergeApproval": false');
    expect(result.taskProjection).toMatchObject({ remediations: 2, safeStep: "reviewed" });
    const projection = result.taskProjection;
    expect(projection.attempts.map(attempt => attempt.role)).toEqual(["builder", "builder", "reviewer", "builder", "reviewer"]);
    expect(starts).toHaveBeenCalledTimes(5); expect(builderTurns).toBe(3); expect(reviewerTurns).toBe(2);
    expect(providerCalls).toBe(12); // 3*(write+text) + 2*(read+StructuredOutput+text).
    expect(reviewerOutputs).toEqual(["COMPLETE", "COMPLETE"]);
    expect(boot.pi.exec.mock.calls.filter((call: [string, string[]]) => call[0] === "sh")).toHaveLength(6); // Both approved checks on all 3 candidates; other calls observe Git environment.
    expect(projection.checks.every(check => check.ok && check.after === projection.candidate!.fingerprint)).toBe(true);
    const reviewers = projection.attempts.filter(attempt => attempt.role === "reviewer");
    expect(reviewers[0].assignment.binding.sourceFingerprint).not.toBe(reviewers[1].assignment.binding.sourceFingerprint);
    expect(new Set(projection.attempts.map(attempt => attempt.receipt!.sdk.sessionId)).size).toBe(5);
    expect(projection.review!.verdict.candidateFingerprint).toBe(projection.candidate!.fingerprint);
    for (const attempt of projection.attempts) {
      expect(attempt.receipt).toMatchObject({ attempt: 1, effective: { model: "direct-faux/direct-model", thinking: "off", cwd: fixture.cwd }, sdk: { allocated: true, quiescent: true, disposition: "retained" } });
      expect(attempt.artifacts.length).toBeGreaterThan(0);
    }
    const repairPrompts = starts.mock.calls.filter(call => call[4]?.taskAssignment?.role === "Builder").map(call => call[3]);
    expect(repairPrompts[1]).toContain("AssertionError"); expect(repairPrompts[2]).toContain("Boolean true");
    const schemas = starts.mock.calls.filter(call => call[4]?.taskAssignment?.role === "Reviewer").map(call => call[4]?.structuredOutput?.schema);
    expect(JSON.parse(JSON.stringify(schemas[0]))).toEqual(JSON.parse(JSON.stringify(TaskReviewSchema)));
    for (const call of starts.mock.calls.filter(call => call[4]?.taskAssignment?.role === "Reviewer")) {
      expect(call[3]).toContain(call[4]!.taskAssignment!.binding.sourceFingerprint);
      expect(call[4]).toMatchObject({ inheritContext: false });
      expect(call[4]!.taskAssignment!.allowedActions).not.toContain("write");
    }
    const edgeCheck = await execCommand("node", ["-e", 'const assert = require("node:assert/strict"); const limit = require("./src/limit.cjs"); for (const v of [true, false, "", " ", NaN, null, undefined, Infinity]) assert.throws(() => limit(v));'], fixture.cwd);
    expect(edgeCheck.code).toBe(0); // Separate qualification assertion, not an approved workflow check/model call.
    expect(projection.ownership?.state).toBe("released"); protectedUnchanged();
    console.info("Direct synthetic counts: child starts=5; child faux provider calls=12; parent/orchestrator model calls=0; public invocations=1; local checks=6.");
  }, 30_000);

  it.each(["complete", "cancel"] as const)("native command %s uses actual Manager/SDK/VM and reports the full settled projection exactly once without a parent nudge", async ending => {
    mode = "recovery";
    const output = mkdtempSync(join(tmpdir(), "direct-native-")); chmodSync(output, 0o700);
    const events: string[] = [];
    const snapshots = vi.spyOn(WorkflowTaskPlan.prototype, "projection");
    const release = join(output, "release");
    let dialog: WorkflowDialog | undefined;
    try {
      if (ending === "cancel") {
        const program = join(output, "check.cjs");
        writeFileSync(program, 'const fs = require("node:fs"); const [ready, stopped, release, settled] = process.argv.slice(2); process.on("SIGTERM", () => { fs.writeFileSync(stopped, "abort received"); const timer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(timer); fs.writeFileSync(settled, "final child effect"); process.exit(0); } }, 10); }); fs.writeFileSync(ready, "running"); setTimeout(() => process.exit(2), 5000);');
        plan.builder.approvedChecks = [`exec "${process.execPath}" "${program}" "${join(output, "ready")}" "${join(output, "stopped")}" "${release}" "${join(output, "settled")}"`];
      }
      boot.pi.sendMessage.mockImplementation(() => { events.push("notification"); });
      const instructionPath = join(output, "instructions.md"); writeFileSync(instructionPath, instructions);
      const selectorPath = join(output, "selector.json");
      const { profileFingerprint: _builderFingerprint, ...builderConfig } = plan.builder.configuration;
      const { profileFingerprint: _reviewerFingerprint, ...reviewerConfig } = plan.reviewer.configuration;
      const selector: DirectTaskSelector = { version: 1, taskId: plan.builder.taskId, authorityRef: plan.builder.authorityRef,
        record: join(fixture.cwd, "AGENTS.md"), instructions: instructionPath, instructionFiles: [], workspace: fixture.cwd,
        outputDirectory: output, bridgeExecutable: "/usr/bin/true", allowedPaths: plan.builder.allowedPaths,
        protectedPaths: Object.keys(plan.builder.protectedBaseline), approvedChecks: plan.builder.approvedChecks,
        evidence: plan.builder.evidence, maxRemediations: 1,
        builder: { profile: "task-worker", ...builderConfig }, reviewer: { profile: "task-reviewer", ...reviewerConfig } };
      writeFileSync(selectorPath, JSON.stringify(selector));
      // Structural bridge transport fixture only. Worker/check execution remains real.
      const execute = boot.pi.exec.getMockImplementation()!;
      boot.pi.exec.mockImplementation(async (executable: string, args: string[], options: unknown) => {
        if (executable !== "/usr/bin/true") {
          const result = await execute(executable, args, options);
          if (executable === "sh") events.push("check-settled");
          return result;
        }
        const argument = (key: string) => args[args.indexOf(key) + 1];
        if (args[2] === "prepare") writeFileSync(argument("--output"), JSON.stringify({ invocation: {
          scriptPath: argument("--recipe"), taskPlan: JSON.parse(readFileSync(argument("--plan"), "utf-8")), args: { task: readFileSync(argument("--instructions"), "utf-8") },
        } }), { flag: "wx", mode: 0o600 });
        else {
          events.push("report");
          writeFileSync(argument("--output"), "Synthetic transport report; not CLI qualification", { flag: "wx", mode: 0o600 });
        }
        return { code: 0, killed: false, stdout: "", stderr: "" };
      });
      await boot.commands.get("direct-task").handler(`prepare ${selectorPath}`, fixture.context);
      expect(starts).not.toHaveBeenCalled();
      await boot.commands.get("direct-task").handler(`run ${selectorPath}`, fixture.context);
      if (ending === "cancel") {
        await vi.waitFor(() => expect(existsSync(join(output, "ready"))).toBe(true), { timeout: 10_000 });
        let opened = false;
        fixture.context.ui.select = vi.fn(async (title: string, options: string[]) => {
          if (title !== "Agents" || opened) return undefined;
          opened = true; return options.find(option => /^Workflows \(\d+\)$/.test(option));
        });
        fixture.context.ui.custom = vi.fn(async (factory: (...args: unknown[]) => unknown) => {
          dialog = factory({ requestRender: () => {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => {}) as WorkflowDialog;
          return undefined;
        });
        await boot.commands.get("agents").handler("", fixture.context);
        expect(dialog).toBeDefined(); dialog!.handleInput("x"); dialog!.handleInput("x");
        await vi.waitFor(() => expect(existsSync(join(output, "stopped"))).toBe(true));
        // SIGTERM was delivered, but the actual exec promise is still owned.
        expect(events).toEqual([]); expect(existsSync(join(output, "projection.json"))).toBe(false);
        expect(boot.pi.sendMessage).not.toHaveBeenCalled();
        expect(boot.pi.exec.mock.calls.filter(call => call[0] === "/usr/bin/true" && call[1][2] === "report")).toHaveLength(0);
        expect(fixture.context.ui.notify.mock.calls.filter(([text]: [string]) => text.startsWith("Stopped workflow"))).toHaveLength(1);
        writeFileSync(release, "settle actual exec");
      }
      await vi.waitFor(() => expect(boot.pi.sendMessage).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      const projectionBytes = readFileSync(join(output, "projection.json"));
      const projection = JSON.parse(projectionBytes.toString("utf-8")) as TaskProjection;
      expect(projection).toEqual(snapshots.mock.results.at(-1)!.value);
      expect(projection.ownership).toEqual({ state: "released", error: null });
      if (ending === "complete") {
        expect(projection).toMatchObject({ safeStep: "reviewed", review: { verdict: { verdict: "PASS" } } });
        expect(projection.attempts).toHaveLength(2); expect(starts).toHaveBeenCalledTimes(2);
      } else {
        expect(readFileSync(join(output, "settled"), "utf-8")).toBe("final child effect");
        expect(projection).toMatchObject({ safeStep: "checking", checks: [], candidate: null, review: null });
        expect(projection.attempts).toHaveLength(1); expect(starts).toHaveBeenCalledTimes(1);
        expect(projection.attempts[0].receipt).toMatchObject({ execution: { settled: true }, sdk: { allocated: true, quiescent: true, disposition: "retained" } });
        expect(providerCalls).toBe(2); expect(reviewerTurns).toBe(0);
        expect(boot.pi.sendMessage.mock.calls[0][0]).toMatchObject({ customType: "direct-task-result", content: expect.stringContaining(": killed.") });
        expect(events).toEqual(["check-settled", "report", "notification"]);
        dialog!.handleInput("x");
        await boot.lifecycle.get("session_shutdown")();
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(boot.pi.sendMessage).toHaveBeenCalledTimes(1);
        expect(readFileSync(join(output, "projection.json"))).toEqual(projectionBytes);
        expect(events).toEqual(["check-settled", "report", "notification"]);
      }
      expect(boot.pi.exec.mock.calls.filter(call => call[0] === "/usr/bin/true" && call[1][2] === "report")).toHaveLength(1);
      expect(boot.pi.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false });
      expect(projection.plan.builder.instructions).toContain(selectorPath); protectedUnchanged();
    } finally { dialog?.dispose(); writeFileSync(release, "cleanup gate"); await boot.lifecycle.get("session_shutdown")(); rmSync(output, { recursive: true, force: true }); }
  }, 30_000);

  it("shared remediation exhaustion does not reset on fresh Builders", async () => {
    plan.builder.maxRemediations = 1; plan.reviewer.maxRemediations = 1;
    const { result } = await invoke();
    expect(result.error).toContain("maxRemediations exhausted");
    expect(result.resultPreview).not.toContain('"status": "locally-ready-for-human"'); expect(starts).toHaveBeenCalledTimes(3);
    expect(result.taskProjection.remediations).toBe(1); protectedUnchanged();
  }, 30_000);

  it.each(["incomplete", "malformed", "null-builder"] as const)("refuses %s worker output without fabricating readiness", async kind => {
    mode = kind;
    const { result } = await invoke();
    expect(result.status).toBe("error"); expect(result.resultPreview).not.toContain('"status": "locally-ready-for-human"');
    expect(result.taskProjection.review).toBeNull();
    expect(result.error).toMatch(/missing|malformed|stopped|unsettled|settlement/i);
    if (kind === "null-builder") {
      expect(reviewerTurns).toBe(0); expect(reviewerOutputs).toEqual([]);
    } else {
      expect(reviewerTurns).toBe(1);
      expect(reviewerOutputs.length).toBeGreaterThan(0);
      expect(reviewerOutputs.every(output => output === (kind === "incomplete" ? "incomplete" : "PARTIAL"))).toBe(true);
      console.info(`Direct negative branch proof: mode=${kind}; reviewer reads=${reviewerTurns}; outputs=${JSON.stringify(reviewerOutputs)}.`);
    }
    protectedUnchanged();
  }, 30_000);

  it("public NEW run continues an actual frozen checkpoint without duplicate Builder/check writes", async () => {
    mode = "recovery";
    const first = await invoke({ script: 'export const meta = {name:"freeze-fixture",description:"safe public fixture"}; const a = await task.prepare("builder"); await agent(args.task,{agentType:a.profile,taskAssignment:a}); await task.check("node src/check.cjs"); await task.check("node --check src/limit.cjs"); return await task.freeze();' });
    expect(first.result.taskProjection.safeStep).toBe("frozen");
    const checkpoint = first.result.taskProjection.checkpoint!.id;
    const recovered = await invoke({ checkpoint });
    expect(recovered.result.error).toBeUndefined();
    expect(recovered.started.details.taskId).not.toBe(first.started.details.taskId);
    expect(recovered.result.taskProjection.runId).toBe(first.started.details.taskId);
    expect(recovered.result.resultPreview).toContain('"status": "locally-ready-for-human"');
    expect(starts).toHaveBeenCalledTimes(2); expect(builderTurns).toBe(1); expect(boot.pi.exec.mock.calls.filter((call: [string, string[]]) => call[0] === "sh")).toHaveLength(2);
    expect(providerCalls).toBe(5); protectedUnchanged();
  }, 30_000);

  it.each(["check-recovery", "reject-recovery"] as const)("public NEW run recovers exact %s reason before a fresh Builder", async kind => {
    mode = kind;
    plan.builder.maxRemediations = 1; plan.reviewer.maxRemediations = 1;
    // End the actual recipe immediately after reopen, before preparing repair.
    const first = await invoke({ script: recipe.replaceAll("continue\n", "return state\n") });
    expect(first.result.error).toBeUndefined();
    const reopened = first.result.taskProjection;
    expect(reopened).toMatchObject({ safeStep: "reopened", remediations: 1, checks: [], candidate: null, review: null });
    const observations = fixture.context.sessionManager.getBranch()
      .filter(entry => entry.type === "custom" && entry.customType === "subagents:task-checkpoint")
      .map(entry => JSON.parse(readFileSync((entry.data as { artifact: { path: string } }).artifact.path, "utf-8")) as TaskProjection);
    const prior = observations.filter(state => state.safeStep === (kind === "check-recovery" ? "checked" : "reviewed")).at(-1)!;
    const reason = kind === "check-recovery"
      ? `Repair only these actual check failures:\n${JSON.stringify(prior.checks.filter(check => !check.ok))}`
      : `Address only the COMPLETE independent review findings:\n${JSON.stringify(prior.review!.verdict)}`;
    expect(reason).toContain(kind === "check-recovery" ? "AssertionError" : "Boolean true is coerced to 1");
    const priorStarts = starts.mock.calls.length;
    expect(priorStarts).toBe(kind === "check-recovery" ? 1 : 2);
    const recovered = await invoke({ checkpoint: reopened.checkpoint!.id });
    const repairPrompt = starts.mock.calls[priorStarts]?.[3];
    expect(repairPrompt).toBe(`${instructions}\nExecute only the prepared Builder contract. No publication, installation or cleanup.\n${reason}`);
    expect(recovered.result.error).toBeUndefined();
    expect(recovered.started.details.taskId).not.toBe(first.started.details.taskId);
    expect(recovered.result.taskProjection.runId).toBe(first.started.details.taskId);
    expect(recovered.result.taskProjection).toMatchObject({ remediations: 1, safeStep: "reviewed", review: { verdict: { verdict: "PASS" } } });
    expect(recovered.result.taskProjection.attempts.slice(0, priorStarts)).toEqual(reopened.attempts);
    expect(starts).toHaveBeenCalledTimes(priorStarts + 2); expect(builderTurns).toBe(2);
    expect(boot.pi.exec.mock.calls.filter((call: [string, string[]]) => call[0] === "sh")).toHaveLength(4);
    expect(new Set(recovered.result.taskProjection.attempts.map(attempt => attempt.receipt!.sdk.sessionId)).size).toBe(priorStarts + 2);
    protectedUnchanged();
  }, 30_000);

  it("missing current writer blocks public checkpoint continuation before any new worker", async () => {
    mode = "recovery";
    const first = await invoke({ script: 'export const meta = {name:"freeze-fixture",description:"safe public fixture"}; const a = await task.prepare("builder"); await agent(args.task,{agentType:a.profile,taskAssignment:a}); await task.check("node src/check.cjs"); await task.check("node --check src/limit.cjs"); return await task.freeze();' });
    vi.spyOn(AgentManager.prototype, "getReceipt").mockReturnValue(undefined); // Explicit missing-owner negative only.
    const refused = await invoke({ checkpoint: first.result.taskProjection.checkpoint!.id });
    expect(refused.result.status).toBe("error"); expect(refused.result.error).toMatch(/missing|expired|foreign/);
    expect(starts).toHaveBeenCalledTimes(1); protectedUnchanged();
  }, 30_000);

  it("recipe refuses an absent facade before spawning", async () => {
    expect(recipe).toContain("Direct implementation requires an approved TaskPlan");
    const refused = await boot.tools.get("SubagentWorkflow").execute("ordinary", { scriptPath: recipePath, args: { task: instructions } }, undefined, undefined, fixture.context);
    expect(refused.details.taskId).toBeDefined();
    await vi.waitFor(() => expect(boot.pi.sendMessage).toHaveBeenCalled());
    expect(boot.pi.sendMessage.mock.calls[0][0].details.error).toContain("approved TaskPlan");
    expect(starts).not.toHaveBeenCalled();
  });
});
