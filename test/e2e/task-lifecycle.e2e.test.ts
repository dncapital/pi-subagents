import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { AgentManager } from "../../src/agent-manager.js";
import { getAgentConfig } from "../../src/agent-types.js";
import { captureTaskSource, taskProfileFingerprint } from "../../src/task-assignment.js";
import { makePi } from "../helpers/boot-extension.js";
import { taskFixture } from "../helpers/task-fixture.js";

let fixture: ReturnType<typeof taskFixture> | undefined;
let manager: AgentManager | undefined;
afterEach(async () => {
  await manager?.dispose(); fixture?.restore(); vi.restoreAllMocks();
});

it.each(["retained", "released", "unconfirmed"])("real SDK task sessions produce %s receipts with no provider prompt", async disposition => {
  fixture = taskFixture(disposition !== "retained");
  const { assignment, context } = fixture;
  const runtime = await ModelRuntime.create({
    authPath: join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), modelsPath: null,
    modelsStorePath: join(process.env.PI_CODING_AGENT_DIR!, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  const stream = vi.fn(() => { throw new Error("No provider calls permitted in lifecycle proof"); });
  runtime.registerProvider("task-stub", {
    api: "openai-completions", baseUrl: "http://invalid.local", apiKey: "stub-only", streamSimple: stream,
    models: [{ id: "task-model", name: "Task model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
  });
  const model = runtime.getModel("task-stub", "task-model")!;
  const sdkContext = { ...context, model, modelRegistry: { runtime, find: runtime.getModel.bind(runtime), getAvailable: () => [model] } };
  if (disposition === "unconfirmed") {
    const extensionPath = join(fixture.cwd, "src", "shutdown-failure.ts");
    writeFileSync(extensionPath, 'export default function (pi) { pi.on("session_shutdown", () => { throw new Error("task fixture shutdown failure"); }); }');
    const profile = getAgentConfig("task-worker")!;
    profile.extensions = [extensionPath]; profile.isolated = false;
    assignment.configuration.isolated = false;
    assignment.configuration.profileFingerprint = taskProfileFingerprint(profile);
    assignment.binding.sourceFingerprint = captureTaskSource(fixture.cwd).fingerprint;
  }
  manager = new AgentManager();
  const cancellation = new AbortController(); cancellation.abort();
  let session: AgentSession | undefined;
  let dispose: ReturnType<typeof vi.spyOn> | undefined;
  let prompt: ReturnType<typeof vi.spyOn> | undefined;
  const { id, record } = await manager.spawnAndWait(makePi().pi, sdkContext, "task-worker", "no prompt", {
    description: "task lifecycle proof", taskAssignment: assignment, signal: cancellation.signal,
    onSessionCreated: child => { session = child; dispose = vi.spyOn(child, "dispose"); prompt = vi.spyOn(child, "prompt"); },
  });
  expect(session).toBeDefined();
  expect(prompt).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
  expect(manager.getReceipt(id)).toMatchObject({
    version: 1, effective: { model: "task-stub/task-model", thinking: "off", cwd: fixture.cwd },
    execution: { status: "stopped", settled: true, consumed: true },
    sdk: { allocated: true, quiescent: true, disposition },
  });
  expect(manager.getReceipt(id)?.sdk.sessionId).toBe(session!.sessionId);
  expect(record.error).toBeUndefined();
  if (disposition === "retained") {
    expect(record.session).toBe(session); expect(dispose).not.toHaveBeenCalled();
    const previousPromise = record.promise;
    const previousReceipt = manager.getReceipt(id)!;
    const resumed = await manager.resume(id, "must not reach SDK prompt or provider", cancellation.signal, {
      taskAssignment: { ...assignment, attemptId: "pre-aborted-resume" },
    });
    expect(resumed).toBe(record);
    expect(record.promise).not.toBe(previousPromise);
    expect(await record.promise).toBe("");
    expect(prompt).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    expect(manager.getReceipt(id)).toMatchObject({ attempt: 2,
      assignment: { attemptId: "pre-aborted-resume" },
      execution: { status: "stopped", settled: true, consumed: true, error: null, settlementError: null },
      sdk: { allocated: true, quiescent: true, disposition: "retained", sessionId: session!.sessionId },
      usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } });
    expect(previousReceipt.attempt).toBe(1);
    await manager.waitForAll(); expect(manager.hasRunning()).toBe(false);
    expect(record.session).toBe(session); expect(dispose).not.toHaveBeenCalled();
    await manager.dispose(); expect(dispose).toHaveBeenCalledOnce();
  } else {
    expect(record.session).toBeUndefined(); expect(dispose).toHaveBeenCalledOnce();
    expect(manager.getReceipt(id)?.sdk.cleanupError).toBe(disposition === "unconfirmed" ? "Child session shutdown failed: task fixture shutdown failure" : null);
  }
});
