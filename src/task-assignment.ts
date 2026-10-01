/** Task-opt-in binding observations. These checks neither approve work nor confine tools. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentConfig, Immutable, TaskAssignment } from "./types.js";

/** Safety observations survive branch selection; they are not recovery authority. */
export const TASK_OWNERSHIP_ENTRY = "subagents:task-ownership-unconfirmed";
export function assertTaskCheckoutOwnership(ctx: ExtensionContext, repositoryRoot: string): void {
  const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TASK_OWNERSHIP_ENTRY) continue;
    const data = entry.data as { repositoryRoot?: unknown; error?: unknown } | undefined;
    if (!data || data.repositoryRoot === repositoryRoot) throw new Error(`Task checkout ownership is unconfirmed; Human-owned settlement/handoff required: ${String(data?.error ?? "unknown binding")}`);
  }
}

const text = Type.String({ minLength: 1, pattern: "\\S" });
const fingerprint = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const TaskAssignmentSchema = Type.Object({
  version: Type.Literal(1),
  taskId: text, attemptId: text, authorityRef: text, role: text, profile: text,
  configuration: Type.Object({
    model: text,
    thinking: Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => Type.Literal(level))),
    profileFingerprint: fingerprint,
    maxTurns: Type.Integer({ minimum: 0 }),
    isolated: Type.Boolean(), inheritContext: Type.Boolean(),
  }, { additionalProperties: false }),
  binding: Type.Object({
    repository: text, repositoryRoot: text, workspace: text, branch: text,
    head: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
    sourceFingerprint: fingerprint,
  }, { additionalProperties: false }),
  allowedPaths: Type.Array(text, { uniqueItems: true }),
  allowedActions: Type.Array(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("check")]), { minItems: 1, uniqueItems: true }),
  protectedBaseline: Type.Record(Type.String(), Type.Union([fingerprint, Type.Null()])),
  instructions: Type.Array(text, { minItems: 1, uniqueItems: true }),
  evidence: Type.Array(text, { minItems: 1, uniqueItems: true }),
  approvedChecks: Type.Array(text, { uniqueItems: true }),
  maxRemediations: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

/** Clone before freezing: callers retain their own mutable input, never a host reference. */
export function immutableSnapshot<T>(value: T): Immutable<T> {
  const copy = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object") return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(copy);
  return copy as Immutable<T>;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return entry;
  });
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function taskProfileFingerprint(profile: AgentConfig): string {
  return hash(stableJson({ profile, source: profile.sourcePath ? hash(readFileSync(profile.sourcePath)) : null }));
}

/** Checkout identity only: subdirectories/symlinks coincide, separate worktrees do not. */
export function retainedCheckoutRoot(cwd: string): string | null {
  try {
    return realpathSync(execFileSync("git", ["-C", realpathSync(cwd), "rev-parse", "--show-toplevel"], {
      encoding: "utf-8", timeout: 5_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"],
    }).trim());
  } catch { return null; }
}

/** Exact source observation; index entries are stable Git data, never index stat bytes. */
export interface TaskSourceSnapshot {
  repository: string;
  repositoryRoot: string;
  workspace: string;
  branch: string;
  head: string;
  fingerprint: string;
  entries: Record<string, string>;
}

export function captureTaskSource(workspace: string): TaskSourceSnapshot {
  const cwd = realpathSync(workspace);
  let gitCwd = cwd;
  const git = (...args: string[]) => execFileSync("git", ["-C", gitCwd, ...args], {
    encoding: "utf-8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const repositoryRoot = realpathSync(git("rev-parse", "--show-toplevel").trim());
  gitCwd = repositoryRoot;
  const repository = git("remote", "get-url", "origin").trim();
  const branch = git("symbolic-ref", "--short", "HEAD").trim();
  const head = git("rev-parse", "HEAD").trim();
  const index = new Map<string, string[]>();
  for (const entry of git("ls-files", "--stage", "-z", "--full-name").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    const metadata = entry.slice(0, tab);
    if (metadata.startsWith("160000 ")) throw new Error(`Task source fingerprint does not support submodules: ${path}`);
    const stages = index.get(path) ?? [];
    stages.push(metadata);
    index.set(path, stages);
  }
  const paths = [...new Set([...index.keys(), ...git("ls-files", "--others", "--exclude-standard", "-z", "--full-name").split("\0").filter(Boolean)])].sort();
  const entries: Record<string, string> = Object.create(null);
  for (const path of paths) {
    const absolute = resolve(repositoryRoot, path);
    // Never follow a replaced directory symlink to content outside the repository.
    for (let parent = dirname(absolute); parent !== repositoryRoot; parent = dirname(parent)) {
      if (parent === dirname(parent) || !parent.startsWith(repositoryRoot + sep)) throw new Error(`Invalid Git source path: ${path}`);
      try {
        if (lstatSync(parent).isSymbolicLink()) throw new Error(`Task source has a symlink ancestor: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let working: unknown = { type: "missing" };
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) working = { type: "symlink", target: readlinkSync(absolute) };
      else if (stat.isFile()) working = { type: "file", mode: stat.mode & 0o777, content: hash(readFileSync(absolute)) };
      else throw new Error(`Task source is not a file or symlink: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    entries[path] = hash(stableJson({ index: index.get(path) ?? [], working }));
  }
  const identity = { repository, repositoryRoot, workspace: cwd, branch, head };
  return { ...identity, entries, fingerprint: hash(stableJson({ version: 1, ...identity, entries })) };
}

function sourcePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\\\x00-\x1f*?[\]]/.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

export function snapshotTaskAssignment(value: unknown): Immutable<TaskAssignment> {
  if (!Value.Check(TaskAssignmentSchema, value)) throw new Error("Invalid TaskAssignment v1: required fields, types or unknown fields.");
  const assignment = value as TaskAssignment;
  for (const path of [...assignment.allowedPaths, ...Object.keys(assignment.protectedBaseline)]) {
    if (!sourcePath(path)) throw new Error(`Invalid task source scope path: ${path}`);
  }
  if (assignment.allowedActions.includes("write") && assignment.allowedPaths.length === 0) throw new Error("Task write action requires allowedPaths.");
  if (assignment.approvedChecks.length > 0 && !assignment.allowedActions.includes("check")) throw new Error("Task approvedChecks requires the check action.");
  for (const path of [assignment.binding.workspace, assignment.binding.repositoryRoot]) {
    if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error(`Task binding path must be canonical and absolute: ${path}`);
  }
  for (const path of assignment.instructions) {
    if (!isAbsolute(path) || !lstatSync(path).isFile()) throw new Error(`Task instruction must be an explicit absolute file: ${path}`);
  }
  return immutableSnapshot(assignment);
}

/** Resume may change only the attempt identity, never widen the stored contract. */
export function sameTaskContract(a: Immutable<TaskAssignment>, b: Immutable<TaskAssignment>): boolean {
  return stableJson({ ...a, attemptId: "" }) === stableJson({ ...b, attemptId: "" });
}

export function validateTaskSource(
  assignment: Immutable<TaskAssignment>,
  baseline?: TaskSourceSnapshot,
): TaskSourceSnapshot {
  const current = captureTaskSource(assignment.binding.workspace);
  const binding = assignment.binding;
  for (const key of ["repository", "repositoryRoot", "workspace", "branch", "head"] as const) {
    if (current[key] !== binding[key]) throw new Error(`Task binding ${key} mismatch: expected ${binding[key]}, observed ${current[key]}.`);
  }
  const within = relative(current.repositoryRoot, current.workspace);
  if (within.startsWith("..") || isAbsolute(within)) throw new Error("Task workspace is outside its repository root.");
  if (baseline === undefined && current.fingerprint !== binding.sourceFingerprint) throw new Error("Task initial source fingerprint mismatch.");
  for (const [path, expected] of Object.entries(assignment.protectedBaseline)) {
    if ((current.entries[path] ?? null) !== expected) throw new Error(`Task protected baseline drift: ${path}`);
  }
  if (baseline !== undefined) {
    for (const path of new Set([...Object.keys(baseline.entries), ...Object.keys(current.entries)])) {
      if (baseline.entries[path] === current.entries[path]) continue;
      if (!assignment.allowedActions.includes("write") || !assignment.allowedPaths.some(allowed => path === allowed || path.startsWith(allowed + "/"))) {
        throw new Error(`Task source changed outside allowedPaths: ${path}`);
      }
    }
  }
  return current;
}
