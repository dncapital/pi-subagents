/** Transient operator selection and bridge observations; not an execution owner. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getAgentConfig } from "./agent-types.js";
import { checkModelScope } from "./model-scope.js";
import { captureTaskSource, taskProfileFingerprint } from "./task-assignment.js";
import { snapshotTaskPlan, type TaskPlan, type TaskProjection, taskFingerprint } from "./task-plan.js";
import type { Immutable } from "./types.js";
import { validateTaskPlanConfiguration } from "./workflow/task-plan.js";

const text = Type.String({ minLength: 1, maxLength: 8192, pattern: "\\S" });
const strings = Type.Array(text, { uniqueItems: true, maxItems: 64 });
const role = Type.Object({
  profile: text, model: text,
  thinking: Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => Type.Literal(level))),
  maxTurns: Type.Integer({ minimum: 0 }), isolated: Type.Boolean(), inheritContext: Type.Boolean(),
}, { additionalProperties: false });
export const DirectTaskSelectorSchema = Type.Object({
  version: Type.Literal(1), record: text, taskId: text, authorityRef: text,
  workspace: text, outputDirectory: text, bridgeExecutable: text, instructions: text,
  instructionFiles: strings, allowedPaths: strings, protectedPaths: strings,
  approvedChecks: strings, evidence: Type.Array(text, { minItems: 1, uniqueItems: true, maxItems: 64 }),
  maxRemediations: Type.Integer({ minimum: 0 }), builder: role, reviewer: role,
}, { additionalProperties: false });
export type DirectTaskSelector = Static<typeof DirectTaskSelectorSchema>;
export interface DirectTaskReport {
  bridgeExecutable: string;
  outputDirectory: string;
  requestPath: string;
  projectionPath: string;
  reportPath: string;
}
export interface DirectTaskInvocation { scriptPath: string; taskPlan: Immutable<TaskPlan>; args: { task: string } }
const recipe = fileURLToPath(new URL("../examples/workflows/direct-implementation.js", import.meta.url));
const MAX_BYTES = 4 * 1024 * 1024;

function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("Noncanonical input boundary.");
  for (let current = path; ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("Symlink input boundary.");
    if (current === dirname(current)) break;
  }
}
function readBounded(path: string): Buffer {
  canonical(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error("Input must be a bounded regular file.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd), current = lstatSync(path);
    if (size > MAX_BYTES || before.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.ino !== current.ino || before.dev !== current.dev) throw new Error("Input changed during read.");
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
function absent(path: string): void {
  canonical(dirname(path));
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Output collision.");
}
function publish(path: string, value: unknown): void {
  absent(path);
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Oversized output.");
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}
async function bridge(pi: ExtensionAPI, descriptor: DirectTaskReport, args: string[]): Promise<void> {
  canonical(descriptor.outputDirectory);
  readBounded(descriptor.bridgeExecutable);
  const result = await pi.exec(descriptor.bridgeExecutable, ["--json", "pi-bridge", ...args], { cwd: descriptor.outputDirectory, timeout: 30_000 });
  if (result.killed || result.code !== 0) throw new Error("Bridge validation/publication failed.");
}

/** Reobserve actual source/profile facts; selector hashes are never accepted. */
export async function selectDirectTask(pi: ExtensionAPI, ctx: ExtensionContext, selectorPath: string, action: "prepare" | "run"): Promise<{ invocation: DirectTaskInvocation; report: DirectTaskReport }> {
  const input: unknown = JSON.parse(readBounded(selectorPath).toString("utf-8"));
  if (!Value.Check(DirectTaskSelectorSchema, input)) throw new Error("Invalid selector.");
  const selected = input;
  canonical(selected.workspace); canonical(selected.outputDirectory);
  const directory = lstatSync(selected.outputDirectory);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw new Error("Output directory must be existing and private.");
  const source = captureTaskSource(selected.workspace);
  const within = relative(source.repositoryRoot, selected.outputDirectory);
  if (within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))) throw new Error("Outputs must be outside source.");
  const instructionFiles = [...new Set([selected.record, selected.instructions, selectorPath, ...selected.instructionFiles])];
  for (const path of [...instructionFiles, recipe, selected.bridgeExecutable]) readBounded(path);
  const { fingerprint: sourceFingerprint, entries, ...binding } = source;
  const protectedBaseline = Object.fromEntries(selected.protectedPaths.map(path => [path, entries[path] ?? null]));
  const assignments = (["builder", "reviewer"] as const).map(key => {
    const { profile: name, ...configuration } = selected[key];
    const profile = getAgentConfig(name);
    if (!profile || profile.enabled === false || profile.name !== name) throw new Error("Exact enabled profile required.");
    return { version: 1 as const, taskId: selected.taskId, authorityRef: selected.authorityRef,
      attemptId: `direct-${key}`, role: key === "builder" ? "Builder" : "Reviewer", profile: name,
      configuration: { ...configuration, profileFingerprint: taskProfileFingerprint(profile) },
      binding: { ...binding, sourceFingerprint }, protectedBaseline, allowedPaths: selected.allowedPaths,
      allowedActions: key === "builder" ? ["read", "write", "check"] : ["read"],
      instructions: instructionFiles, evidence: selected.evidence,
      approvedChecks: key === "builder" ? selected.approvedChecks : [], maxRemediations: selected.maxRemediations };
  });
  const plan = snapshotTaskPlan({ version: 1, builder: assignments[0], reviewer: assignments[1] });
  validateTaskPlanConfiguration(plan, ctx);
  for (const assignment of [plan.builder, plan.reviewer]) {
    const model = ctx.modelRegistry.getAvailable().find(model => `${model.provider}/${model.id}` === assignment.configuration.model);
    if (checkModelScope({ model, cwd: ctx.cwd, modelRegistry: ctx.modelRegistry, callerSupplied: true, agentLabel: assignment.profile }).kind === "error") throw new Error("Model scope refused.");
  }
  const host = { configCwd: realpathSync(ctx.cwd), agentDir: realpathSync(getAgentDir()),
    settings: [join(ctx.cwd, ".pi/settings.json"), join(ctx.cwd, ".pi/subagents.json"), join(getAgentDir(), "settings.json"), join(getAgentDir(), "subagents.json")].map(path => {
      try { return [path, taskFingerprint(readBounded(path).toString("utf-8"))]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, null]; throw error; }
    }) };
  const hostPath = join(selected.outputDirectory, "host.json");
  const report: DirectTaskReport = { bridgeExecutable: selected.bridgeExecutable, outputDirectory: selected.outputDirectory,
    requestPath: join(selected.outputDirectory, "request.json"), projectionPath: join(selected.outputDirectory, "projection.json"), reportPath: join(selected.outputDirectory, "report.md") };
  const planPath = join(selected.outputDirectory, "plan.json");
  const validationPath = join(selected.outputDirectory, "validation.json");
  const runPath = join(selected.outputDirectory, "run.json");
  for (const path of [report.projectionPath, report.reportPath, validationPath, runPath]) absent(path);
  if (action === "prepare") {
    absent(report.requestPath); absent(planPath); absent(hostPath);
    publish(planPath, plan);
    publish(hostPath, host);
  } else {
    if (taskFingerprint(JSON.parse(readBounded(hostPath).toString("utf-8"))) !== taskFingerprint(host)) throw new Error("Host configuration drift.");
    const prepared = snapshotTaskPlan(JSON.parse(readBounded(planPath).toString("utf-8")));
    if (taskFingerprint(prepared) !== taskFingerprint(plan)) throw new Error("Prepared source/profile/configuration drift.");
    readBounded(report.requestPath);
  }
  await bridge(pi, report, ["prepare", "--record", selected.record, "--task-ref", selected.taskId, "--authority-ref", selected.authorityRef,
    "--plan", planPath, "--recipe", recipe, "--instructions", selected.instructions, "--output", action === "prepare" ? report.requestPath : validationPath]);
  const request = readBounded(report.requestPath);
  if (action === "run" && !request.equals(readBounded(validationPath))) throw new Error("Sealed preparation drift.");
  const invocation: DirectTaskInvocation = { scriptPath: recipe, taskPlan: plan, args: { task: readBounded(selected.instructions).toString("utf-8") } };
  const envelope = JSON.parse(request.toString("utf-8")) as { invocation?: unknown };
  if (taskFingerprint(envelope.invocation) !== taskFingerprint(invocation)) throw new Error("Prepared invocation mismatch.");
  if (action === "run") publish(runPath, { request: report.requestPath });
  return { invocation, report };
}

/** Called once from the existing terminal workflow notification path. No replay. */
export async function reportDirectTask(pi: ExtensionAPI, descriptor: DirectTaskReport, projection: Immutable<TaskProjection> | undefined): Promise<string> {
  if (!projection) return "Report unavailable: final task projection missing.";
  try {
    publish(descriptor.projectionPath, projection);
    absent(descriptor.reportPath);
    await bridge(pi, descriptor, ["report", "--request", descriptor.requestPath, "--projection", descriptor.projectionPath, "--output", descriptor.reportPath]);
    readBounded(descriptor.reportPath);
    return `Observation report: ${descriptor.reportPath}. Link manually; no acceptance or approval.`;
  } catch { return "Report failed: projection export or bridge validation/publication was not confirmed. Workflow status is unchanged; no execution retry."; }
}
