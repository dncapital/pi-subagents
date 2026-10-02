import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

interface Job {
  if?: string;
  "timeout-minutes": number;
  steps: { name?: string; uses?: string; run?: string; with?: Record<string, unknown> }[];
}
interface Workflow extends Record<string, unknown> {
  on: {
    pull_request: { branches: string[]; paths: string[] };
    workflow_dispatch: { inputs: { compatibility: { type: string; default: boolean } } };
  };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  env: Record<string, string>;
  jobs: Record<string, Job>;
}

const yaml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workflow = parseFrontmatter<Workflow>(`---\n${yaml}\n---\n`).frontmatter;

describe("lightweight CI policy", () => {
  it("runs one PR workflow without duplicate pushes or schedules, with explicit manual compatibility", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(workflow.on.pull_request.branches).toEqual(["master"]);
    expect(workflow.on.workflow_dispatch.inputs.compatibility).toMatchObject({ type: "boolean", default: false });
    expect(Object.entries(workflow.jobs).filter(([, job]) => job.if === undefined).map(([name]) => name)).toEqual(["build"]);
    for (const name of ["compat-floor-pi", "compat-latest-pi"]) {
      expect(workflow.jobs[name].if).toBe("github.event_name == 'workflow_dispatch' && inputs.compatibility == true");
    }
  });

  it("uses current checkout and setup-node actions in every job", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.steps.filter(step => step.uses?.startsWith("actions/checkout@")).map(step => step.uses)).toEqual(["actions/checkout@v7"]);
      expect(job.steps.filter(step => step.uses?.startsWith("actions/setup-node@")).map(step => step.uses)).toEqual(["actions/setup-node@v7"]);
    }
  });

  it("cancels superseded work and bounds runner cost without token write permission", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    expect(workflow.concurrency.group).toContain("github.workflow");
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number || github.ref");
    for (const job of Object.values(workflow.jobs)) {
      expect(job["timeout-minutes"]).toBe(10);
      expect(job.steps.find(step => step.uses === "actions/setup-node@v7")?.with?.cache).toBe("npm");
    }
  });

  it("preserves the full provider-free baseline gate, rather than replacing it with smoke coverage", () => {
    expect(workflow.env.PI_OFFLINE).toBe("1");
    expect(workflow.env.PI_E2E_LIVE).toBe("");
    expect(workflow.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
    for (const job of Object.values(workflow.jobs)) {
      const state = job.steps.find(step => step.name === "Private Pi state")?.run;
      expect(state).toContain('mkdir -p "$RUNNER_TEMP/pi-subagents-ci"');
      expect(state).toContain('chmod 700 "$RUNNER_TEMP/pi-subagents-ci"');
      expect(state).toContain("printf 'PI_CODING_AGENT_DIR=%s\\n'");
      expect(state).toContain('>> "$GITHUB_ENV"');
    }
    const runs = workflow.jobs.build.steps.map(step => step.run).filter(Boolean);
    expect(runs).toContain("npm ci");
    expect(runs).toContain("npm run lint");
    expect(runs).toContain("npm run typecheck");
    expect(runs).toContain("npm run test -- --reporter=verbose --maxWorkers=2");
  });

  it("includes source, tests, dependencies, examples and CI configuration in PR filtering", () => {
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining([
      "src/**", "test/**", "examples/**", "package.json", "package-lock.json",
      "tsconfig*.json", "vitest.config.*", "biome.json", ".npmignore", ".github/workflows/**",
    ]));
  });
});
