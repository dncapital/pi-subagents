import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentSession, type ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { AgentManager } from "../../src/agent-manager.js";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import { loadCustomAgents } from "../../src/custom-agents.js";
import { ctx, hermeticDir, makePi } from "../helpers/boot-extension.js";

const template = readFileSync(resolve("examples/agents/research-reader.md"), "utf-8");
let environment: ReturnType<typeof hermeticDir> | undefined;
let manager: AgentManager | undefined;
afterEach(async () => {
  await manager?.dispose();
  environment?.restore();
  vi.restoreAllMocks();
});

it("real host SDK constructs a restricted in-memory session and disposes it before any provider prompt", async () => {
  environment = hermeticDir({ agentFiles: { "research-reader": template.replace("persist_session: false", "persist_session: true") } });
  const profiles = loadCustomAgents(environment.dir);
  registerAgents(profiles);
  expect(profiles.get("research-reader")?.builtinToolNames).toEqual(["read", "grep", "find", "ls"]);
  const { runtime, stream, model } = await stubRuntime(environment.dir);
  const context = ctx({ model, modelRegistry: { runtime, find: runtime.getModel.bind(runtime) } }) as ExtensionContext;
  const pi = makePi().pi;
  manager = new AgentManager();
  const cancellation = new AbortController();
  cancellation.abort();
  let child: AgentSession | undefined;
  let dispose: ReturnType<typeof vi.spyOn> | undefined;
  let prompt: ReturnType<typeof vi.spyOn> | undefined;
  let tools: string[] | undefined;
  let sessionFile: string | undefined;
  const { record } = await manager.spawnAndWait(pi, context, "research-reader", "bounded question", {
    description: "pre-prompt smoke", signal: cancellation.signal, isolated: true,
    onSessionCreated: session => {
      child = session;
      dispose = vi.spyOn(session, "dispose");
      prompt = vi.spyOn(session, "prompt");
      tools = session.getActiveToolNames();
      sessionFile = session.sessionManager.getSessionFile();
    },
  });
  expect(child).toBeDefined();
  expect(tools).toEqual(["read", "grep", "find", "ls"]);
  expect(sessionFile).toBeUndefined();
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("stopped");
  expect(record.resultConsumed).toBe(true);
  expect(record.session).toBeUndefined();
  expect(record.sessionCleanupError).toBeUndefined();
  expect(dispose).toHaveBeenCalledOnce();
  expect(prompt).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
  expect(await manager.resume(record.id, "cannot resume")).toBeUndefined();
  await expect(runAgent(context, "research-reader", "cannot reopen", { pi, resumeSessionFile: "/never-open.jsonl" }))
    .rejects.toThrow("One-shot agents cannot reopen");
});

async function stubRuntime(dir: string) {
  const runtime = await ModelRuntime.create({
    authPath: resolve(dir, "auth.json"), modelsPath: null,
    modelsStorePath: resolve(dir, "models-store.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const stream = vi.fn(() => { throw new Error("Pre-prompt smoke must not invoke provider"); });
  runtime.registerProvider("research-stub", {
    api: "openai-completions", baseUrl: "http://invalid.local", apiKey: "stub-only", streamSimple: stream,
    models: [{ id: "reader", name: "Reader stub", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
  });
  return { runtime, stream, model: runtime.getModel("research-stub", "reader")! };
}

it("captures actual SDK shutdown handler failures even though emit resolves", async () => {
  environment = hermeticDir();
  const fixture = resolve(environment.dir, "shutdown-error.ts");
  writeFileSync(fixture, 'export default function (pi) { pi.on("session_shutdown", () => { throw new Error("fixture shutdown failure"); }); }');
  registerAgents(new Map([["shutdown-reader", {
    name: "shutdown-reader", description: "shutdown fixture", systemPrompt: "No provider prompt",
    promptMode: "replace", extensions: [fixture], skills: false, disposeOnConsume: true,
  }]]));
  const { runtime, stream, model } = await stubRuntime(environment.dir);
  const context = ctx({ model, modelRegistry: { runtime, find: runtime.getModel.bind(runtime) } }) as ExtensionContext;
  manager = new AgentManager();
  const cancellation = new AbortController();
  cancellation.abort();
  let dispose: ReturnType<typeof vi.spyOn> | undefined;
  let prompt: ReturnType<typeof vi.spyOn> | undefined;
  const id = manager.spawn(makePi().pi, context, "shutdown-reader", "never prompt", {
    description: "SDK fixture", isBackground: true, signal: cancellation.signal,
    onSessionCreated: session => {
      dispose = vi.spyOn(session, "dispose");
      prompt = vi.spyOn(session, "prompt");
    },
  });
  const record = manager.getRecord(id)!;
  await record.promise;
  expect(record.error).toBeUndefined();
  expect(dispose).not.toHaveBeenCalled();
  await expect(manager.consumeResult(id)).rejects.toThrow("Child session shutdown failed: fixture shutdown failure");
  await expect(manager.consumeResult(id)).rejects.toThrow("Child session shutdown failed: fixture shutdown failure");
  expect(record.sessionCleanupError).toBe("Child session shutdown failed: fixture shutdown failure");
  expect(record.status).toBe("stopped");
  manager.clearCompleted();
  await manager.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  expect(prompt).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
});

it.each([false, true])("direct SDK host enforces restricted profile before prompt (workflow=%s)", async (workflow) => {
  environment = hermeticDir({ agentFiles: { "research-reader": template } });
  registerAgents(loadCustomAgents(environment.dir));
  const { runtime, stream, model } = await stubRuntime(environment.dir);
  const context = ctx({ model, modelRegistry: { runtime, find: runtime.getModel.bind(runtime) },
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "SECRET PARENT HISTORY" } }] },
  }) as ExtensionContext;
  let tools: string[] | undefined;
  let prompt: ReturnType<typeof vi.spyOn> | undefined;
  const output = await runAgent(context, "research-reader", "explicit question and repository instructions", {
    pi: makePi().pi, workflow, isolated: false, inheritContext: true, maxTurns: 999,
    model, thinkingLevel: "off",
    onSessionCreated: session => {
      tools = session.getActiveToolNames();
      prompt = vi.spyOn(session, "prompt").mockResolvedValue();
    },
  });
  try {
    expect(tools).toEqual(["read", "grep", "find", "ls"]);
    expect(output.session.getAllTools().map(tool => tool.name)).toEqual(["read", "grep", "find", "ls"]);
    expect(output.session.extensionRunner?.hasHandlers("session_start")).toBe(false);
    expect(prompt).toHaveBeenCalledWith("explicit question and repository instructions");
    expect(output.session.model).toBe(model);
    expect(output.session.thinkingLevel).toBe("off");
    expect(stream).not.toHaveBeenCalled();
  } finally {
    output.session.dispose();
  }
});
