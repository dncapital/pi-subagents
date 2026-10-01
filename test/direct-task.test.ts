import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { type DirectTaskReport, type DirectTaskSelector, reportDirectTask, selectDirectTask } from "../src/direct-task.js";
import extension from "../src/index.js";
import { taskFingerprint } from "../src/task-plan.js";
import * as runtime from "../src/workflow/runtime.js";
import { makePi } from "./helpers/boot-extension.js";
import { taskFixture } from "./helpers/task-fixture.js";

/** Bridge transport is structural only; no CLI or authenticated-provider qualification. */
describe("document-backed Direct command", () => {
  let fixture: ReturnType<typeof taskFixture>;
  let boot: ReturnType<typeof makePi>;
  let output: string;
  let selectorPath: string;
  let selector: DirectTaskSelector;
  beforeEach(() => {
    fixture = taskFixture();
    writeFileSync(join(fixture.cwd, ".pi/agents/task-reviewer.md"), "---\nextensions: false\nskills: false\nisolated: false\ninherit_context: false\nmax_turns: 4\n---\nReview only.");
    registerAgents(loadCustomAgents(fixture.cwd));
    output = mkdtempSync(join(tmpdir(), "direct-command-")); chmodSync(output, 0o700);
    selectorPath = join(output, "selector.json");
    const configuration = { model: "task-stub/task-model", thinking: "off", maxTurns: 4, inheritContext: false } as const;
    selector = { version: 1, taskId: "synthetic-task", authorityRef: "fixture-only approval", record: join(fixture.cwd, "AGENTS.md"),
      instructions: join(fixture.cwd, "AGENTS.md"), workspace: fixture.cwd, outputDirectory: output, bridgeExecutable: "/usr/bin/true",
      instructionFiles: [], allowedPaths: ["src"], protectedPaths: ["protected.txt"], approvedChecks: ["fixture-check"], evidence: ["fixture evidence"], maxRemediations: 1,
      builder: { ...configuration, profile: "task-worker", isolated: true }, reviewer: { ...configuration, profile: "task-reviewer", isolated: false } };
    writeFileSync(selectorPath, JSON.stringify(selector));
    boot = makePi(); extension(boot.pi);
    boot.pi.exec.mockImplementation(async (_executable: string, args: string[]) => {
      const argument = (key: string) => args[args.indexOf(key) + 1];
      const destination = argument("--output");
      if (args[2] === "prepare") {
        const plan = JSON.parse(readFileSync(argument("--plan"), "utf-8"));
        const paths = [...new Set([...plan.builder.instructions, ...plan.reviewer.instructions, argument("--recipe")])] as string[];
        writeFileSync(destination, JSON.stringify({ bindings: paths.map(path => [path, taskFingerprint(readFileSync(path, "utf-8"))]),
          invocation: { scriptPath: argument("--recipe"), taskPlan: plan, args: { task: readFileSync(argument("--instructions"), "utf-8") } } }), { flag: "wx", mode: 0o600 });
      } else writeFileSync(destination, "Fixture report only", { flag: "wx", mode: 0o600 });
      return { code: 0, killed: false, stdout: "", stderr: "" };
    });
  });
  afterEach(async () => {
    await boot.lifecycle.get("session_shutdown")(); vi.restoreAllMocks(); fixture.restore(); rmSync(output, { recursive: true, force: true });
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  });
  const prepare = () => selectDirectTask(boot.pi, fixture.context, selectorPath, "prepare");
  const run = () => selectDirectTask(boot.pi, fixture.context, selectorPath, "run");
  const command = (action: string) => boot.commands.get("direct-task").handler(`${action} ${selectorPath}`, fixture.context);

  it("prepares without workers, refuses replay and preserves the sealed request", async () => {
    await command("prepare");
    expect(boot.pi.sendMessage).not.toHaveBeenCalled();
    const bytes = readFileSync(join(output, "request.json"));
    await run();
    expect(readFileSync(join(output, "request.json"))).toEqual(bytes);
    await expect(run()).rejects.toThrow("collision");
  });
  it.each(["unknown", "malformed", "role-unknown", "unsupported-model"])("refuses %s selection before CLI", async kind => {
    if (kind === "malformed") writeFileSync(selectorPath, "{");
    else writeFileSync(selectorPath, JSON.stringify(kind === "unknown" ? { ...selector, extra: true } : { ...selector, builder: { ...selector.builder, ...(kind === "role-unknown" ? { extra: true } : { model: "absent/model" }) } }));
    await command("prepare"); expect(boot.pi.exec).not.toHaveBeenCalled(); expect(fixture.context.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("refused"), "error");
  });
  it.each(["source", "profile", "selector", "instructions", "settings", "model"])("refuses prepared %s drift", async kind => {
    await prepare();
    if (kind === "source") writeFileSync(join(fixture.cwd, "src/allowed.ts"), "changed");
    if (kind === "profile") getAgentConfig("task-worker")!.systemPrompt += "changed";
    if (kind === "selector") writeFileSync(selectorPath, JSON.stringify({ ...selector, authorityRef: "different" }));
    if (kind === "instructions") writeFileSync(join(fixture.cwd, "AGENTS.md"), "changed");
    if (kind === "settings") writeFileSync(join(fixture.cwd, ".pi/settings.json"), "{}");
    if (kind === "model") fixture.context.modelRegistry.getAvailable = () => [];
    await expect(run()).rejects.toThrow(); expect(boot.pi.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["collision", "dangling", "selector-link", "directory-link", "public-directory"])("refuses %s boundary", async kind => {
    if (kind === "collision") writeFileSync(join(output, "projection.json"), "existing");
    if (kind === "dangling") symlinkSync(join(output, "missing"), join(output, "report.md"));
    if (kind === "selector-link") { selectorPath = join(output, "link.json"); symlinkSync(join(output, "selector.json"), selectorPath); }
    if (kind === "directory-link") { const target = join(output, "private"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(output, "linked")); writeFileSync(selectorPath, JSON.stringify({ ...selector, outputDirectory: join(output, "linked") })); }
    if (kind === "public-directory") chmodSync(output, 0o755);
    await expect(prepare()).rejects.toThrow(); expect(boot.pi.exec).not.toHaveBeenCalled();
  });
  it("refuses two-dot-named source output before any artifact or CLI publication", async () => {
    const inside = join(fixture.cwd, "..private"); mkdirSync(inside, { mode: 0o700 });
    writeFileSync(selectorPath, JSON.stringify({ ...selector, outputDirectory: inside }));
    await expect(prepare()).rejects.toThrow("Outputs must be outside source");
    expect(boot.pi.exec).not.toHaveBeenCalled();
    for (const name of ["plan.json", "host.json", "request.json"]) {
      expect(() => readFileSync(join(inside, name))).toThrow();
    }
  });
  it("refuses disabled/withdrawn workflow before preparation", async () => {
    boot.pi.setActiveTools([]); await command("prepare"); expect(boot.pi.exec).not.toHaveBeenCalled();
  });
  it("refuses foreign workflow collision before preparation", async () => {
    boot.pi.getAllTools.mockReturnValue([{ name: "Workflow", description: "foreign" }]);
    await command("prepare"); expect(boot.pi.exec).not.toHaveBeenCalled();
  });
  it("attaches reporting before immediate settlement, with no projection or parent continuation", async () => {
    vi.spyOn(runtime, "runWorkflow").mockRejectedValue(new Error("immediate fixture startup failure"));
    await command("prepare"); await command("run");
    await vi.waitFor(() => expect(boot.pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(boot.pi.sendMessage.mock.calls[0][0].content).toContain("projection missing");
    expect(boot.pi.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false });
    expect(boot.pi.exec.mock.calls.filter(call => call[1][2] === "report")).toHaveLength(0);
  });
  it.each(["nonzero", "timeout", "export"])("keeps %s report failure separate and never retries", async kind => {
    const selected = await prepare();
    const descriptor: DirectTaskReport = selected.report;
    if (kind === "export") symlinkSync(join(output, "missing"), descriptor.projectionPath);
    else boot.pi.exec.mockResolvedValue({ code: kind === "nonzero" ? 1 : 0, killed: kind === "timeout", stdout: "secret diagnostics", stderr: "secret diagnostics" });
    // The actual projection shape belongs to runtime; this negative only tests export/transport refusal.
    const result = await reportDirectTask(boot.pi, descriptor, { version: 1 } as never);
    expect(result).toContain("Workflow status is unchanged"); expect(result).not.toContain("secret diagnostics");
    expect(boot.pi.exec.mock.calls.filter(call => call[1][2] === "report")).toHaveLength(kind === "export" ? 0 : 1);
  });
});
