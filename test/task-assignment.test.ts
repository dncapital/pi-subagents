import { chmodSync, mkdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentConfig } from "../src/agent-types.js";
import { captureTaskSource, sameTaskContract, snapshotTaskAssignment, taskProfileFingerprint, validateTaskSource } from "../src/task-assignment.js";
import { taskFixture } from "./helpers/task-fixture.js";

describe("TaskAssignment v1 binding observations", () => {
  let fixture: ReturnType<typeof taskFixture>;
  beforeEach(() => { fixture = taskFixture(); });
  afterEach(() => fixture.restore());

  it("snapshots deeply without freezing caller inputs, and changes only attempt identity on resume", () => {
    const assignment = snapshotTaskAssignment(fixture.assignment);
    fixture.assignment.allowedPaths.push("outside");
    expect(assignment.allowedPaths).toEqual(["src"]);
    expect(Object.isFrozen(assignment.binding)).toBe(true);
    expect(Object.isFrozen(assignment.protectedBaseline)).toBe(true);
    expect(() => Object.assign(assignment.binding, { head: "b".repeat(40) })).toThrow();
    expect(sameTaskContract(assignment, snapshotTaskAssignment({ ...assignment, attemptId: "attempt-2" }))).toBe(true);
    expect(sameTaskContract(assignment, snapshotTaskAssignment({ ...assignment, role: "Reviewer" }))).toBe(false);
  });

  it.each([
    ["schema", { version: 2 }], ["unknown", { accidentalAuthority: true }],
    ["scope", { allowedPaths: ["../outside"] }], ["glob", { allowedPaths: ["src/*"] }],
    ["git", { allowedPaths: [".git/config"] }], ["write", { allowedPaths: [] }],
    ["check", { allowedActions: ["read"] }], ["instructions", { instructions: [] }],
  ])("rejects malformed %s assignments", (_name, change) => {
    expect(() => snapshotTaskAssignment({ ...fixture.assignment, ...change })).toThrow(/Invalid|requires/);
  });

  it("rejects noncanonical workspace aliases and missing instruction files", () => {
    const alias = join(fixture.cwd, "alias");
    symlinkSync(fixture.cwd, alias, "dir");
    expect(() => snapshotTaskAssignment({ ...fixture.assignment, binding: { ...fixture.assignment.binding, workspace: alias } })).toThrow("canonical");
    expect(() => snapshotTaskAssignment({ ...fixture.assignment, instructions: [join(fixture.cwd, "missing.md")] })).toThrow();
  });

  it.each(["repository", "repositoryRoot", "workspace", "branch", "head"] as const)("refuses wrong canonical %s binding", key => {
    const wrong = key === "head" ? "b".repeat(40) : key === "repositoryRoot" ? "/tmp" : key === "workspace" ? "/tmp" : "wrong";
    expect(() => validateTaskSource({ ...fixture.assignment, binding: { ...fixture.assignment.binding, [key]: wrong } })).toThrow(/mismatch|git/);
  });

  it("accepts a retained subdirectory but fingerprints the entire repository", () => {
    const source = captureTaskSource(join(fixture.cwd, "src"));
    expect(source.repositoryRoot).toBe(fixture.cwd);
    expect(source.workspace).toBe(join(fixture.cwd, "src"));
    expect(source.entries).toHaveProperty("protected.txt");
    const assignment = { ...fixture.assignment, binding: { ...fixture.assignment.binding, workspace: source.workspace, sourceFingerprint: source.fingerprint } };
    expect(validateTaskSource(assignment).fingerprint).toBe(source.fingerprint);
  });

  it("observes tracked, staged, git-visible untracked, deleted, executable and symlink identities, not stat bytes or ignored artifacts", () => {
    const baseline = captureTaskSource(fixture.cwd);
    const path = join(fixture.cwd, "src", "allowed.ts");
    const stat = statSync(path);
    utimesSync(path, stat.atime, new Date(stat.mtimeMs + 1000));
    mkdirSync(join(fixture.cwd, "ignored"));
    writeFileSync(join(fixture.cwd, "ignored", "artifact"), "not source");
    expect(captureTaskSource(fixture.cwd).fingerprint).toBe(baseline.fingerprint);
    chmodSync(path, 0o755);
    const executable = captureTaskSource(fixture.cwd);
    expect(executable.fingerprint).not.toBe(baseline.fingerprint);
    fixture.git("add", "--", "src/allowed.ts");
    const staged = captureTaskSource(fixture.cwd);
    expect(staged.fingerprint).not.toBe(executable.fingerprint);
    fixture.git("update-index", "--refresh");
    expect(captureTaskSource(fixture.cwd).fingerprint).toBe(staged.fingerprint);
    writeFileSync(join(fixture.cwd, "src", "new.ts"), "new source");
    expect(captureTaskSource(fixture.cwd).fingerprint).not.toBe(staged.fingerprint);
    fixture.git("rm", "-f", "--", "src/allowed.ts");
    expect(captureTaskSource(fixture.cwd).entries["src/allowed.ts"]).toBeUndefined();
    symlinkSync("/outside/not-read", join(fixture.cwd, "src", "link"));
    expect(captureTaskSource(fixture.cwd).entries["src/link"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not follow a replaced directory symlink into external source", () => {
    fixture.git("mv", "src", "moved");
    renameSync(join(fixture.cwd, "moved"), join(fixture.cwd, "real-moved"));
    symlinkSync("/tmp", join(fixture.cwd, "moved"), "dir");
    expect(() => captureTaskSource(fixture.cwd)).toThrow("symlink ancestor: moved/allowed.ts");
  });

  it("allows only declared source changes after the exact initial baseline", () => {
    writeFileSync(join(fixture.cwd, "src", "allowed.ts"), "changed");
    expect(() => validateTaskSource(fixture.assignment)).toThrow("initial source fingerprint");
    expect(validateTaskSource(fixture.assignment, fixture.source).fingerprint).not.toBe(fixture.source.fingerprint);
    writeFileSync(join(fixture.cwd, "src-other.ts"), "not covered by prefix");
    expect(() => validateTaskSource(fixture.assignment, fixture.source)).toThrow("outside allowedPaths: src-other.ts");
  });

  it.each(["protected.txt", "never-create.txt"])("protects contents or absence at %s even inside allowed scope", path => {
    writeFileSync(join(fixture.cwd, path), "unexpected");
    const assignment = { ...fixture.assignment, allowedPaths: [path] };
    expect(() => validateTaskSource(assignment, fixture.source)).toThrow(`protected baseline drift: ${path}`);
  });

  it("read-only assignments reject source changes and profile fingerprints cover config plus file contents", () => {
    const profile = getAgentConfig("task-worker")!;
    const before = taskProfileFingerprint(profile);
    profile.systemPrompt += " changed";
    expect(taskProfileFingerprint(profile)).not.toBe(before);
    profile.systemPrompt = "Execute only the assigned task.";
    writeFileSync(profile.sourcePath!, "changed source definition");
    expect(taskProfileFingerprint(profile)).not.toBe(before);
    writeFileSync(join(fixture.cwd, "src", "allowed.ts"), "changed");
    expect(() => validateTaskSource({ ...fixture.assignment, allowedActions: ["read"], approvedChecks: [] }, fixture.source)).toThrow("outside allowedPaths");
  });
});
