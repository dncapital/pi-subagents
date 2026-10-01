/** Narrow run-local observations on the existing Manager/parent-session owners. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { resolveEffectiveMaxTurns } from "../agent-runner.js";
import { getAgentConfig } from "../agent-types.js";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import { sessionTaskDir } from "../output-file.js";
import { assertTaskCheckoutOwnership, captureTaskSource, immutableSnapshot, sameTaskContract, snapshotTaskAssignment, TASK_OWNERSHIP_ENTRY, taskProfileFingerprint, validateTaskSource } from "../task-assignment.js";
import { snapshotTaskPlan, snapshotTaskReview, type TaskArtifact, type TaskAttempt, type TaskCheck, type TaskPlan, type TaskProjection, taskBytesFingerprint, taskFingerprint, taskInputsFingerprint } from "../task-plan.js";
import type { Immutable } from "../types.js";
import type { WorkflowSpawnRequest } from "./runtime.js";

export const TASK_CHECKPOINT_ENTRY = "subagents:task-checkpoint";
export interface TaskCheckExecution { stdout: string; stderr: string; code: number; killed: boolean }
interface TaskPlanHostOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  runId: string;
  plan: Immutable<TaskPlan>;
  recoveryCheckpointId?: string;
  signal?: AbortSignal;
  executeCheck(command: string, cwd: string): Promise<TaskCheckExecution>;
}

/** Used by the tool before detaching, as well as by prepare and recovery. */
export function validateTaskPlanConfiguration(plan: Immutable<TaskPlan>, ctx: ExtensionContext): void {
  for (const assignment of [plan.builder, plan.reviewer]) {
    const config = assignment.configuration;
    const profile = getAgentConfig(assignment.profile);
    if (!profile || profile.enabled === false || profile.name !== assignment.profile
      || taskProfileFingerprint(profile) !== config.profileFingerprint) throw new Error("TaskPlan exact profile/configuration drift.");
    // Exact available model only: never the ordinary fuzzy/fallback path.
    const model = ctx.modelRegistry.getAvailable().find(model => `${model.provider}/${model.id}` === config.model);
    if (!model || !getSupportedThinkingLevels(model).includes(config.thinking)) throw new Error("TaskPlan model/effort is unavailable or unsupported.");
    const resolved = resolveAgentInvocationConfig(profile, { max_turns: config.maxTurns,
      isolated: config.isolated, inherit_context: config.inheritContext });
    if ((resolveEffectiveMaxTurns(assignment.profile, resolved.maxTurns) ?? 0) !== config.maxTurns
      || resolved.isolated !== config.isolated || resolved.inheritContext !== config.inheritContext
      || resolved.isolation === "worktree") throw new Error("TaskPlan profile restrictions contradict the declared configuration.");
  }
}

function configurationFingerprint(ctx: ExtensionContext): string {
  return taskFingerprint({ configCwd: realpathSync(ctx.cwd), agentDir: realpathSync(getAgentDir()),
    files: [join(ctx.cwd, ".pi", "settings.json"), join(ctx.cwd, ".pi", "subagents.json"),
      join(getAgentDir(), "settings.json"), join(getAgentDir(), "subagents.json")]
      .map(path => [path, existsSync(path) ? taskBytesFingerprint(readFileSync(path)) : null]) });
}

/** Data-only facade. Nothing here allocates SDK sessions or grants authority. */
export class WorkflowTaskPlan {
  private state: TaskProjection;
  private busy = false;
  private readonly directory: string;
  private readonly configuration: string;

  constructor(private readonly deps: TaskPlanHostOptions) {
    const plan = snapshotTaskPlan(deps.plan);
    assertTaskCheckoutOwnership(deps.ctx, plan.builder.binding.repositoryRoot);
    validateTaskPlanConfiguration(plan, deps.ctx);
    this.configuration = configurationFingerprint(deps.ctx);
    this.directory = realpathSync(sessionTaskDir(deps.ctx.cwd, deps.ctx.sessionManager.getSessionId()));
    const baseline = deps.recoveryCheckpointId === undefined ? validateTaskSource(plan.builder) : captureTaskSource(plan.builder.binding.workspace);
    const within = relative(plan.builder.binding.repositoryRoot, this.directory);
    if (within === "" || (!within.startsWith("..") && !isAbsolute(within))) throw new Error("Task artifacts must be outside source.");
    this.state = { version: 1, runId: deps.runId, parentSessionId: deps.ctx.sessionManager.getSessionId(),
      configCwd: realpathSync(deps.ctx.cwd), plan, inputsFingerprint: this.inputs(), baseline,
      sourceFingerprint: baseline.fingerprint, ownership: { state: "held", error: null }, safeStep: "initial", remediations: 0, attempts: [], checks: [], candidate: null, review: null, checkpoint: null };
    if (deps.recoveryCheckpointId !== undefined) {
      this.recover(deps.recoveryCheckpointId);
      for (const attempt of this.state.attempts) if (attempt.agentId) deps.manager.retainTaskRecord(attempt.agentId, deps.runId);
    }
  }

  private inputs(): string {
    return taskFingerprint({ task: taskInputsFingerprint(this.deps.plan), configuration: configurationFingerprint(this.deps.ctx) });
  }
  private current() {
    if (this.deps.signal?.aborted) throw new Error("Task workflow aborted; no continuation is authorized by a checkpoint.");
    if (this.deps.ctx.sessionManager.getSessionId() !== this.state.parentSessionId
      || realpathSync(this.deps.ctx.cwd) !== this.state.configCwd) throw new Error("Human-owned handoff required: parent session/configuration root changed.");
    if (this.state.checkpoint && !this.deps.ctx.sessionManager.getBranch().some(entry => entry.type === "custom"
      && entry.customType === TASK_CHECKPOINT_ENTRY && (entry.data as { id?: unknown } | undefined)?.id === this.state.checkpoint?.id)) {
      throw new Error("Task checkpoint left the selected session branch; Human-owned handoff required.");
    }
    validateTaskPlanConfiguration(this.state.plan, this.deps.ctx);
    if (this.configuration !== configurationFingerprint(this.deps.ctx) || this.inputs() !== this.state.inputsFingerprint) {
      throw new Error("TaskPlan instruction/configuration/authority-reference inputs drifted.");
    }
    try { return validateTaskSource(this.state.plan.builder, this.state.baseline); }
    catch (error) { this.state.checks = []; this.state.candidate = null; this.state.review = null; throw error; }
  }
  private idle(): void {
    for (const attempt of this.state.attempts) {
      if (attempt.agentId === null) throw new Error("Task has a pending or unknown interrupted worker; Human-owned handoff/reassignment required.");
      // Resume overwrites that record's receipt; inspect its latest attempt only.
      if (this.state.attempts.some(later => later.agentId === attempt.agentId && later !== attempt
        && this.state.attempts.indexOf(later) > this.state.attempts.indexOf(attempt))) continue;
      const receipt = this.deps.manager.getReceipt(attempt.agentId);
      if (!receipt || !sameTaskContract(receipt.assignment, attempt.assignment)
        || receipt.assignment.attemptId !== attempt.assignment.attemptId) throw new Error("Human-owned handoff/reassignment required: current Manager worker receipt is missing, expired or foreign.");
      const record = this.deps.manager.getRecord(attempt.agentId);
      if (!record || receipt.sdk.disposition === "retained" && (!record.session || record.session.isIdle !== true
        || record.session.isCompacting !== false || record.session.isBashRunning !== false)) throw new Error("Task current SDK quiescence is unknown or active; Human-owned settlement required.");
      if (attempt.receipt && (receipt.sdk.sessionId !== attempt.receipt.sdk.sessionId
        || receipt.candidate.fingerprint !== attempt.receipt.candidate.fingerprint
        || taskFingerprint(receipt.usage) !== taskFingerprint(attempt.receipt.usage))) throw new Error("Task current Manager attempt evidence drifted.");
      if (!receipt.execution.settled || (receipt.execution.status !== "completed" && receipt.execution.status !== "steered") || receipt.execution.settlementError !== null
        || !receipt.sdk.allocated || receipt.sdk.quiescent !== true
        || (receipt.sdk.disposition !== "retained" && receipt.sdk.disposition !== "released") || receipt.sdk.cleanupError !== null) {
        throw new Error("Task worker is stopped, active or SDK-unsettled; Human-owned settlement required.");
      }
      if (receipt.effective.configCwd !== this.state.configCwd || receipt.effective.cwd !== attempt.assignment.binding.workspace
        || receipt.effective.model !== attempt.assignment.configuration.model || receipt.effective.thinking !== attempt.assignment.configuration.thinking
        || receipt.profile !== attempt.assignment.profile || receipt.candidate.error !== null) throw new Error("Task actual worker binding/configuration/candidate mismatch.");
    }
    this.deps.manager.assertTaskCheckoutIdle(this.state.plan.builder.binding.repositoryRoot);
  }
  private author(): TaskAttempt {
    const author = [...this.state.attempts].reverse().find(attempt => attempt.role === "builder" && attempt.receipt !== null);
    if (!author || author.agentId === null || !author.receipt) throw new Error("Task checks/freeze require the actual current author receipt.");
    return author;
  }
  private unchanged(): string {
    const source = this.current();
    if (source.fingerprint !== this.state.sourceFingerprint) {
      this.state.checks = []; this.state.candidate = null; this.state.review = null;
      throw new Error("Task source moved; previous checks/freeze/review are invalid.");
    }
    return source.fingerprint;
  }
  private artifact(value: unknown): TaskArtifact {
    const path = join(this.directory, `${this.deps.runId}.task-${randomUUID()}.json`);
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    return { path, sha256: taskBytesFingerprint(bytes) };
  }
  private verifyArtifact(artifact: TaskArtifact): Buffer {
    if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !artifact.path.startsWith(this.directory + "/") || realpathSync(artifact.path) !== artifact.path
      || !lstatSync(artifact.path).isFile()) throw new Error("Task artifact missing, foreign or malformed.");
    const bytes = readFileSync(artifact.path);
    if (taskBytesFingerprint(bytes) !== artifact.sha256) throw new Error("Task artifact bytes drifted.");
    return bytes;
  }
  private verifyCheck(check: TaskCheck): void {
    const result = JSON.parse(this.verifyArtifact(check.artifact).toString("utf-8")) as TaskCheckExecution & { command: string; cwd: string; before: string; after: string };
    if (!this.state.plan.builder.approvedChecks.includes(check.command) || result.command !== check.command
      || result.cwd !== this.state.plan.builder.binding.workspace || result.before !== check.before || result.after !== check.after
      || result.code !== check.code || result.killed !== check.killed
      || check.ok !== (!result.killed && result.code === 0 && result.before === result.after)) throw new Error("Task check artifact does not match its source-bound outcome.");
  }
  private save(): Immutable<TaskProjection> {
    // Historical data is never substituted for current quiescence on recovery.
    const id = randomUUID();
    const artifact = this.artifact({ ...this.state, checkpoint: null });
    this.deps.pi.appendEntry(TASK_CHECKPOINT_ENTRY, { version: 1, id, runId: this.state.runId,
      parentSessionId: this.state.parentSessionId, inputsFingerprint: this.state.inputsFingerprint, artifact });
    this.state.checkpoint = { id, artifact };
    return this.projection();
  }
  projection(): Immutable<TaskProjection> { return immutableSnapshot(this.state); }

  private recover(id: string): void {
    // Selected branch only. Tree-wide entries would resurrect discarded work.
    const entries = this.deps.ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === TASK_CHECKPOINT_ENTRY);
    const matching = entries.find(entry => entry.type === "custom" && (entry.data as { id?: unknown } | undefined)?.id === id);
    if (!matching || matching.type !== "custom") throw new Error("Checkpoint is absent from the selected session branch; Human-owned handoff required.");
    const entry = matching.data as { version?: unknown; id: string; runId: string; parentSessionId: string; inputsFingerprint: string; artifact: TaskArtifact };
    if (entry.version !== 1 || entry.parentSessionId !== this.state.parentSessionId || entry.inputsFingerprint !== this.state.inputsFingerprint) {
      throw new Error("Checkpoint task/authority/configuration or parent session is foreign; Human-owned handoff required.");
    }
    if (entries.some(later => entries.indexOf(later) > entries.indexOf(matching) && later.type === "custom"
      && (later.data as { runId?: unknown } | undefined)?.runId === entry.runId)) throw new Error("Checkpoint is stale: later observations exist on the selected branch.");
    const restored = JSON.parse(this.verifyArtifact(entry.artifact).toString("utf-8")) as TaskProjection;
    if (restored.version !== 1 || restored.runId !== entry.runId || restored.parentSessionId !== this.state.parentSessionId
      || restored.inputsFingerprint !== this.state.inputsFingerprint || restored.configCwd !== this.state.configCwd
      || taskFingerprint(restored.plan) !== taskFingerprint(this.state.plan)
      || !Number.isInteger(restored.remediations) || restored.remediations < 0 || restored.remediations > this.state.plan.builder.maxRemediations
      || !["built", "checked", "frozen", "reviewed", "reopened"].includes(restored.safeStep)
      || !Array.isArray(restored.attempts) || restored.attempts.length === 0 || !Array.isArray(restored.checks)) {
      throw new Error("Checkpoint is malformed or has an interrupted/unknown writer; Human-owned handoff required.");
    }
    const { fingerprint: baselineFingerprint, ...baseline } = restored.baseline;
    if (baselineFingerprint !== this.state.plan.builder.binding.sourceFingerprint
      || taskFingerprint({ version: 1, ...baseline }) !== baselineFingerprint) throw new Error("Checkpoint approved baseline drifted.");
    this.state = { ...restored, ownership: { state: "held", error: null }, checkpoint: { id, artifact: entry.artifact } };
    this.idle(); this.unchanged();
    if (restored.safeStep === "reopened" && (!restored.remediation || typeof restored.remediation.reason !== "string"
      || !restored.remediation.reason.trim() || restored.remediation.sourceFingerprint !== restored.sourceFingerprint
      || restored.remediation.remediations !== restored.remediations || restored.remediations < 1)) {
      throw new Error("Task reopened checkpoint remediation context is missing or invalid; Human-owned handoff required.");
    }
    for (const attempt of restored.attempts) {
      for (const artifact of attempt.artifacts) {
        const evidence = JSON.parse(this.verifyArtifact(artifact).toString("utf-8")) as { path: string; sha256: string; bytes: string };
        if (taskBytesFingerprint(Buffer.from(evidence.bytes, "base64")) !== evidence.sha256) throw new Error("Task worker evidence snapshot is malformed.");
        const latest = restored.attempts.filter(other => other.agentId === attempt.agentId).at(-1);
        if (latest === attempt && (evidence.path !== attempt.receipt?.evidence.transcript && evidence.path !== attempt.receipt?.evidence.sessionFile
          || taskBytesFingerprint(readFileSync(evidence.path)) !== evidence.sha256)) throw new Error("Task current worker evidence artifact bytes drifted.");
      }
    }
    for (const check of restored.checks) this.verifyCheck(check);
    if (restored.candidate) {
      const source = JSON.parse(this.verifyArtifact(restored.candidate.artifact).toString("utf-8")) as { fingerprint: string };
      if (source.fingerprint !== restored.candidate.fingerprint || source.fingerprint !== restored.sourceFingerprint
        || !restored.plan.builder.approvedChecks.every(command => restored.checks.some(check => check.command === command && check.ok
          && check.before === source.fingerprint && check.after === source.fingerprint))) throw new Error("Task frozen candidate/check evidence is stale or incomplete.");
    }
    if (restored.review) {
      this.verifyArtifact(restored.review.artifact);
      const verdict = snapshotTaskReview(restored.review.verdict);
      const attempt = restored.attempts.at(-1);
      const output = attempt?.agentId ? this.deps.manager.getRecord(attempt.agentId)?.structuredJson : undefined;
      if (attempt?.role !== "reviewer" || !attempt.receipt || !output || !restored.candidate
        || verdict.candidateFingerprint !== restored.candidate.fingerprint
        || taskFingerprint(JSON.parse(output)) !== taskFingerprint(verdict)
        || taskFingerprint(attempt.receipt) !== taskFingerprint(restored.review.receipt)
        || attempt.receipt.attempt !== 1 || attempt.receipt.assignment.configuration.inheritContext
        || restored.attempts.some(builder => builder.role === "builder" && builder.receipt?.sdk.sessionId === attempt.receipt?.sdk.sessionId)) {
        throw new Error("Task recovery review is not the actual fresh independent candidate verdict.");
      }
    }
    // Keep the original run lineage; the new run cannot reset the repair bound.
  }

  async call(method: string, payload: unknown): Promise<unknown> {
    if (this.busy) throw new Error("Task operation already pending; sequential work only.");
    this.busy = true;
    try {
      this.current();
      if (method === "prepare") {
        const request = payload as { role?: unknown; resume?: unknown };
        if (!request || (request.role !== "builder" && request.role !== "reviewer")
          || (request.resume !== undefined && (request.role !== "builder" || typeof request.resume !== "string" || !request.resume.trim()))) throw new Error("task.prepare requires builder/reviewer; only Builder may resume.");
        this.idle(); this.unchanged();
        if (request.role === "builder" && !["initial", "reopened"].includes(this.state.safeStep)
          || request.role === "reviewer" && (this.state.safeStep !== "frozen" || !this.state.candidate)) throw new Error("Task prepare would bypass checks/freeze or bounded reopen.");
        if (request.role === "reviewer") {
          this.verifyArtifact(this.state.candidate!.artifact);
          for (const check of this.state.checks) this.verifyCheck(check);
        }
        const previous = request.resume === undefined ? undefined : this.author();
        const declared = previous?.assignment ?? this.state.plan[request.role];
        const assignment = snapshotTaskAssignment({ ...declared, attemptId: randomUUID(),
          binding: { ...declared.binding, sourceFingerprint: previous ? declared.binding.sourceFingerprint : this.state.sourceFingerprint } });
        this.state.attempts.push({ role: request.role, assignment, resume: typeof request.resume === "string" ? request.resume : null,
          runtimeId: null, agentId: null, receipt: null, artifacts: [] });
        this.state.safeStep = "prepared"; this.save();
        return assignment;
      }
      if (method === "check") return await this.check(payload);
      if (method === "freeze") {
        this.idle(); const fingerprint = this.unchanged(); this.author();
        if (this.state.safeStep !== "checked" || !this.state.plan.builder.approvedChecks.every(command =>
          this.state.checks.some(check => check.command === command && check.ok && check.before === fingerprint && check.after === fingerprint))) throw new Error("Task freeze requires every approved check on exactly the current author candidate.");
        for (const check of this.state.checks) this.verifyCheck(check);
        this.state.candidate = { fingerprint, artifact: this.artifact(this.current()) }; this.state.review = null;
        this.state.safeStep = "frozen"; return this.save();
      }
      if (method === "recordReview") {
        this.idle(); const fingerprint = this.unchanged();
        const attempt = this.state.attempts[this.state.attempts.length - 1];
        if (!this.state.candidate || this.state.safeStep !== "frozen" || attempt?.role !== "reviewer" || !attempt.receipt || !attempt.agentId) throw new Error("Task review requires the actual fresh independent Reviewer on a frozen candidate.");
        this.verifyArtifact(this.state.candidate.artifact);
        for (const check of this.state.checks) this.verifyCheck(check);
        const receipt = this.deps.manager.getReceipt(attempt.agentId)!;
        const builders = this.state.attempts.filter(attempt => attempt.role === "builder");
        if (receipt.attempt !== 1 || receipt.assignment.configuration.inheritContext || receipt.assignment.allowedActions.includes("write")
          || builders.some(builder => builder.agentId === receipt.agentId || builder.receipt?.sdk.sessionId === receipt.sdk.sessionId)
          || receipt.assignment.binding.sourceFingerprint !== fingerprint || receipt.candidate.fingerprint !== fingerprint) throw new Error("Task Reviewer is not fresh, independent and bound to this candidate.");
        const verdict = snapshotTaskReview(payload);
        const output = this.deps.manager.getRecord(attempt.agentId)?.structuredJson;
        if (!output || taskFingerprint(JSON.parse(output)) !== taskFingerprint(verdict) || verdict.candidateFingerprint !== fingerprint) throw new Error("Task verdict is missing, stale or not the actual structured Reviewer output.");
        this.state.review = { verdict, receipt, artifact: this.artifact({ verdict, receipt }) };
        this.state.safeStep = "reviewed"; return this.save();
      }
      if (method === "reopen") {
        if (typeof payload !== "string" || !payload.trim()) throw new Error("task.reopen requires a bounded remediation reason.");
        this.idle(); this.unchanged(); this.author();
        const rejected = this.state.safeStep === "reviewed" && this.state.review?.verdict.verdict === "REJECT";
        const failed = this.state.safeStep === "checked" && this.state.checks.some(check => !check.ok);
        if (!rejected && !failed) throw new Error("Task reopen requires a failed check or COMPLETE Reviewer rejection.");
        if (this.state.remediations >= this.state.plan.builder.maxRemediations) throw new Error("Task maxRemediations exhausted; Human-owned decision required.");
        this.state.remediations++; this.state.checks = []; this.state.candidate = null; this.state.review = null;
        this.state.remediation = { reason: payload, sourceFingerprint: this.state.sourceFingerprint, remediations: this.state.remediations };
        this.state.safeStep = "reopened"; return this.save();
      }
      if (method === "checkpoint") { this.idle(); this.unchanged(); this.author(); return this.save(); }
      throw new Error(`Unknown task method: ${method}`);
    } finally { this.busy = false; }
  }

  private async check(command: unknown): Promise<TaskCheck> {
    if (typeof command !== "string" || !this.state.plan.builder.allowedActions.includes("check")
      || !this.state.plan.builder.approvedChecks.includes(command)) throw new Error("Task check is not an exact approved command.");
    this.idle(); const before = this.unchanged();
    if (!["built", "checked"].includes(this.state.safeStep) || this.author().receipt?.candidate.fingerprint !== before) throw new Error("Task check requires the current settled author candidate.");
    if (this.state.checks.some(check => check.command === command && !check.ok)) throw new Error("Failed task check requires bounded reopen before retry.");
    this.state.safeStep = "checking"; this.save();
    let result: TaskCheckExecution;
    try { result = await this.deps.executeCheck(command, this.state.plan.builder.binding.workspace); }
    catch (error) { result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1, killed: this.deps.signal?.aborted === true }; }
    let after: string;
    try { after = this.current().fingerprint; this.idle(); }
    catch (error) {
      // Preserve full diagnostics even if source/settlement validation fails.
      this.artifact({ command, cwd: this.state.plan.builder.binding.workspace, ...result, before, after: null,
        observationError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n") || (result.killed ? "Check killed or timed out." : `Check exit: ${result.code}`);
    const check: TaskCheck = { command, ok: !result.killed && result.code === 0 && before === after,
      code: result.code, killed: result.killed, diagnostics: diagnostics.slice(-8_000), before, after,
      artifact: this.artifact({ command, cwd: this.state.plan.builder.binding.workspace, ...result, before, after }) };
    if (before !== after) { this.state.checks = []; this.state.candidate = null; this.state.review = null; }
    this.state.checks = [...this.state.checks.filter(previous => previous.command !== command), check];
    this.state.safeStep = "checked"; this.save(); return check;
  }

  /** Called after owned effect promises settle, not merely after abort delivery. */
  releaseOwnership(): void {
    if (this.state.ownership?.state === "unconfirmed") throw new Error(this.state.ownership.error ?? "Task ownership unconfirmed.");
    if (this.busy) throw new Error("Task check operation has not settled.");
    for (const attempt of this.state.attempts) {
      if (!attempt.runtimeId) continue; // Prepared but never admitted: no effect.
      if (!attempt.agentId) throw new Error("Task admitted worker has no current Manager identity.");
      const record = this.deps.manager.getRecord(attempt.agentId);
      const receipt = this.deps.manager.getReceipt(attempt.agentId);
      if (!record || !receipt?.execution.settled || receipt.execution.settlementError !== null
        || receipt.sdk.cleanupError !== null || receipt.sdk.disposition === "unconfirmed" || receipt.sdk.disposition === "releasing"
        || receipt.sdk.allocated && (receipt.sdk.quiescent !== true || receipt.sdk.disposition === "retained"
          && (!record.session || record.session.isIdle !== true || record.session.isCompacting !== false || record.session.isBashRunning !== false))) {
        throw new Error(`Task worker ${attempt.agentId} actual SDK settlement/quiescence is unconfirmed.`);
      }
    }
    this.state.ownership = { state: "released", error: null };
    this.deps.manager.releaseTaskRecords(this.deps.runId);
  }
  retainUnconfirmedOwnership(error: string): void {
    this.state.ownership = { state: "unconfirmed", error };
    this.deps.pi.appendEntry(TASK_OWNERSHIP_ENTRY, { version: 1, runId: this.deps.runId,
      parentSessionId: this.state.parentSessionId, repositoryRoot: this.state.plan.builder.binding.repositoryRoot, error });
  }

  /** Called only on the host's actual spawn/resume path, never by the script. */
  admit(request: Pick<WorkflowSpawnRequest, "agentId" | "taskAssignment" | "agentType" | "model" | "effort" | "cwd" | "isolation" | "gate">, resume = false): void {
    if (this.busy) throw new Error("Task operation pending; cannot overlap a worker.");
    this.current(); this.unchanged();
    const attempt = this.state.attempts[this.state.attempts.length - 1];
    const assignment = request.taskAssignment === undefined ? undefined : snapshotTaskAssignment(request.taskAssignment);
    if (this.state.safeStep !== "prepared" || !attempt || attempt.agentId !== null || !assignment
      || !sameTaskContract(assignment, attempt.assignment) || assignment.attemptId !== attempt.assignment.attemptId
      || resume !== (attempt.resume !== null) || !resume && request.agentType !== assignment.profile
      || request.cwd !== undefined && request.cwd !== assignment.binding.workspace
      || request.model !== undefined && request.model !== assignment.configuration.model
      || request.effort !== undefined && request.effort !== assignment.configuration.thinking
      || request.isolation !== undefined || request.gate !== undefined) throw new Error("Task worker must use its prepared role contract; no widening, ordinary downgrade, gate or isolation.");
    this.deps.manager.assertTaskCheckoutIdle(assignment.binding.repositoryRoot);
    if (resume && this.author().runtimeId !== request.agentId) throw new Error("Task Builder resume is not the current author's runtime handle.");
    attempt.runtimeId = request.agentId; this.state.safeStep = "working"; this.save();
  }
  started(runtimeId: string, agentId: string): void {
    const attempt = this.state.attempts[this.state.attempts.length - 1];
    if (!attempt || attempt.runtimeId !== runtimeId) throw new Error("Task worker start is unbound.");
    attempt.agentId = agentId;
    this.deps.manager.retainTaskRecord(agentId, this.deps.runId);
    this.save();
  }
  settled(runtimeId: string): void {
    const attempt = this.state.attempts[this.state.attempts.length - 1];
    if (!attempt || attempt.runtimeId !== runtimeId || !attempt.agentId) throw new Error("Task worker settlement is unbound or missing; Human-owned handoff required.");
    attempt.receipt = this.deps.manager.getReceipt(attempt.agentId) ?? null;
    if (!attempt.receipt) throw new Error("Task current Manager receipt missing.");
    attempt.artifacts = [attempt.receipt.evidence.transcript, attempt.receipt.evidence.sessionFile]
      .filter((path): path is string => path !== null).map(path => {
        const bytes = readFileSync(path);
        return this.artifact({ path, sha256: taskBytesFingerprint(bytes), bytes: bytes.toString("base64") });
      });
    this.idle();
    const source = this.current();
    if (attempt.receipt.candidate.fingerprint !== source.fingerprint) throw new Error("Task source moved after actual worker settlement.");
    if (attempt.role === "builder") {
      this.state.sourceFingerprint = source.fingerprint; this.state.safeStep = "built";
      this.state.checks = []; this.state.candidate = null; this.state.review = null;
    } else { this.unchanged(); this.state.safeStep = "frozen"; }
    this.save();
  }
}
