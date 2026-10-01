/** Opt-in sequential task DTOs. External task truth remains the authority. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { immutableSnapshot, snapshotTaskAssignment, TaskAssignmentSchema, type TaskSourceSnapshot } from "./task-assignment.js";
import type { AgentReceipt, Immutable, TaskAssignment } from "./types.js";

export interface TaskPlan {
  version: 1;
  builder: TaskAssignment;
  reviewer: TaskAssignment;
}
export const TaskPlanSchema = Type.Object({
  version: Type.Literal(1), builder: TaskAssignmentSchema, reviewer: TaskAssignmentSchema,
}, { additionalProperties: false });

export interface TaskArtifact { path: string; sha256: string }
export interface TaskCheck {
  command: string;
  ok: boolean;
  code: number | null;
  killed: boolean;
  diagnostics: string;
  before: string;
  after: string;
  artifact: TaskArtifact;
}
export interface TaskReview {
  version: 1;
  status: "COMPLETE";
  candidateFingerprint: string;
  verdict: "PASS" | "REJECT";
  findings: { id: string; severity: "P0" | "P1" | "P2" | "P3"; path: string; description: string }[];
  summary: string;
}
const text = Type.String({ minLength: 1, pattern: "\\S" });
export const TaskReviewSchema = Type.Object({
  version: Type.Literal(1), status: Type.Literal("COMPLETE"),
  candidateFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  verdict: Type.Union([Type.Literal("PASS"), Type.Literal("REJECT")]),
  findings: Type.Array(Type.Object({
    id: text, severity: Type.Union(["P0", "P1", "P2", "P3"].map(value => Type.Literal(value))),
    path: text, description: text,
  }, { additionalProperties: false })), summary: text,
}, { additionalProperties: false });

export interface TaskAttempt {
  role: "builder" | "reviewer";
  assignment: Immutable<TaskAssignment>;
  resume: string | null;
  runtimeId: string | null;
  agentId: string | null;
  receipt: Immutable<AgentReceipt> | null;
  artifacts: TaskArtifact[];
}
/** Run-local observations, not another durable execution service or approval. */
export interface TaskProjection {
  version: 1;
  runId: string;
  parentSessionId: string;
  configCwd: string;
  plan: Immutable<TaskPlan>;
  inputsFingerprint: string;
  baseline: TaskSourceSnapshot;
  sourceFingerprint: string;
  /** Terminal workflow status does not release an unconfirmed checkout. */
  ownership?: { state: "held" | "released" | "unconfirmed"; error: string | null };
  safeStep: "initial" | "prepared" | "working" | "built" | "checking" | "checked" | "frozen" | "reviewed" | "reopened";
  remediations: number;
  /** Latest repair context; checkpoint bytes bind it to source and shared count. */
  remediation?: { reason: string; sourceFingerprint: string; remediations: number } | null;
  attempts: TaskAttempt[];
  checks: TaskCheck[];
  candidate: { fingerprint: string; artifact: TaskArtifact } | null;
  review: { verdict: TaskReview; receipt: Immutable<AgentReceipt>; artifact: TaskArtifact } | null;
  checkpoint: { id: string; artifact: TaskArtifact } | null;
}

export function taskFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return entry;
  })).digest("hex");
}
export function taskBytesFingerprint(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function taskInputsFingerprint(plan: Immutable<TaskPlan>): string {
  return taskFingerprint({ plan, instructions: [...new Set([...plan.builder.instructions, ...plan.reviewer.instructions])]
    .map(path => [path, taskBytesFingerprint(readFileSync(path))]) });
}

export function snapshotTaskPlan(value: unknown): Immutable<TaskPlan> {
  if (!Value.Check(TaskPlanSchema, value)) throw new Error("Invalid TaskPlan v1: declare both role contracts before execution.");
  const input = value as TaskPlan;
  const builder = snapshotTaskAssignment(input.builder);
  const reviewer = snapshotTaskAssignment(input.reviewer);
  if (builder.role !== "Builder" || reviewer.role !== "Reviewer"
    || !builder.allowedActions.includes("write") || !builder.allowedActions.includes("read")
    || !builder.allowedActions.includes("check") || builder.approvedChecks.length === 0
    || reviewer.allowedActions.includes("write") || !reviewer.allowedActions.includes("read")
    || reviewer.configuration.inheritContext) throw new Error("TaskPlan requires an authoring Builder and fresh non-authoring Reviewer with inheritContext:false.");
  if (builder.taskId !== reviewer.taskId || builder.authorityRef !== reviewer.authorityRef
    || taskFingerprint(builder.binding) !== taskFingerprint(reviewer.binding)
    || taskFingerprint(builder.protectedBaseline) !== taskFingerprint(reviewer.protectedBaseline)
    || builder.maxRemediations !== reviewer.maxRemediations
    || reviewer.allowedPaths.some(path => !builder.allowedPaths.some(allowed => path === allowed || path.startsWith(allowed + "/")))) {
    throw new Error("TaskPlan role contracts disagree on task/authority/baseline or widen source scope.");
  }
  return immutableSnapshot({ version: 1, builder, reviewer });
}

export function snapshotTaskReview(value: unknown): TaskReview {
  if (!Value.Check(TaskReviewSchema, value)) throw new Error("Task review requires a COMPLETE structured verdict and findings.");
  const review = structuredClone(value as TaskReview);
  if ((review.verdict === "PASS") !== (review.findings.length === 0)
    || new Set(review.findings.map(finding => finding.id)).size !== review.findings.length) {
    throw new Error("Task review verdict/findings are inconsistent.");
  }
  return review;
}
