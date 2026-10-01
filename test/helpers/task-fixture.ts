import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, registerAgents } from "../../src/agent-types.js";
import { loadCustomAgents } from "../../src/custom-agents.js";
import { captureTaskSource, taskProfileFingerprint } from "../../src/task-assignment.js";
import type { TaskAssignment } from "../../src/types.js";
import { ctx, hermeticDir } from "./boot-extension.js";

export const taskModel: Model<string> = {
  id: "task-model", name: "Task model", provider: "task-stub", api: "openai-completions",
  baseUrl: "http://invalid.local", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128,
};

/** Git writes occur only in this test-owned synthetic repository. */
export function taskFixture(oneShot = false, transcript = true) {
  const env = hermeticDir({ settings: { schedulingEnabled: false }, agentFiles: {
    "task-worker": `---\nextensions: false\nskills: false\nisolated: true\ninherit_context: false\nthinking: off\nmax_turns: 4\npersist_session: false\noutput_transcript: ${transcript}\ndispose_on_consume: ${oneShot}\n---\nExecute only the assigned task.`,
  } });
  const cwd = realpathSync(env.dir);
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "allowed.ts"), "export const value = 1;\n");
  writeFileSync(join(cwd, "protected.txt"), "other owner's changes\n");
  writeFileSync(join(cwd, "AGENTS.md"), "Only the assigned source scope.\n");
  writeFileSync(join(cwd, ".gitignore"), "ignored/\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "task-fixture");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.local", "add", "--", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.local", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "synthetic fixture");
  git("remote", "add", "origin", "https://invalid.local/task-fixture.git");
  registerAgents(loadCustomAgents(cwd));
  const source = captureTaskSource(cwd);
  const assignment: TaskAssignment = {
    version: 1, taskId: "synthetic-task", attemptId: "attempt-1", authorityRef: "fixture-only approval",
    role: "Builder", profile: "task-worker",
    configuration: { model: `${taskModel.provider}/${taskModel.id}`, thinking: "off",
      profileFingerprint: taskProfileFingerprint(getAgentConfig("task-worker")!), maxTurns: 4, isolated: true, inheritContext: false },
    binding: { repository: source.repository, repositoryRoot: source.repositoryRoot, workspace: source.workspace,
      branch: source.branch, head: source.head, sourceFingerprint: source.fingerprint },
    allowedPaths: ["src"], allowedActions: ["read", "write", "check"],
    protectedBaseline: { "protected.txt": source.entries["protected.txt"], "never-create.txt": null },
    instructions: [join(cwd, "AGENTS.md")], evidence: ["fixture checks and artifacts"], approvedChecks: ["fixture-check"], maxRemediations: 2,
  };
  const context = ctx({ cwd, model: taskModel, modelRegistry: { find: () => taskModel, getAvailable: () => [taskModel] } }) as ExtensionContext;
  return { ...env, cwd, git, source, assignment, context };
}
