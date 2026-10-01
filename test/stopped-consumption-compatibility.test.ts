import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as runnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof runnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { type RunResult, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { EventBus } from "../src/cross-extension-rpc.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { ctx, flush, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let env: ReturnType<typeof hermeticDir>;
let manager: AgentManager;
let booted: ReturnType<typeof makePi>;
let events: EventBus;

beforeEach(async () => {
  env = hermeticDir({
    settings: { schedulingEnabled: false, worktreeIsolation: false, outputTranscript: false },
    agentFiles: { disposable: "---\ndispose_on_consume: true\noutput_transcript: false\n---\nNo model calls." },
  });
  registerAgents(loadCustomAgents(env.dir));
  manager = new AgentManager();
  booted = makePi();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  events = {
    on(event, handler) {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => { handlers.delete(handler); };
    },
    emit(event, data) { for (const handler of listeners.get(event) ?? []) handler(data); },
  };
  booted.pi.events = events;
  subagentsExtension(booted.pi);
  await booted.lifecycle.get("session_start")({}, ctx());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  await booted.lifecycle.get("session_shutdown")();
  await manager.dispose();
  vi.useRealTimers();
  env.restore();
  vi.clearAllMocks();
});

function pendingRun() {
  const child = { messages: [], dispose: vi.fn(), abort: vi.fn() } as unknown as AgentSession;
  let release!: (result: RunResult) => void;
  vi.mocked(runAgent).mockImplementationOnce((_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(child);
    return new Promise(resolve => { release = resolve; });
  });
  return {
    child,
    finish: () => release({ session: child, responseText: "late output", aborted: false, steered: false }),
  };
}

it.each([false, true])("manager stopped consumption preserves disposeOnConsume=%s policy", async (optIn) => {
  const run = pendingRun();
  const id = manager.spawn(booted.pi, ctx(), optIn ? "disposable" : "general-purpose", "question", {
    description: "stopped worker", isBackground: true, isolation: "off",
  });
  const record = manager.getRecord(id)!;
  try {
    expect(await manager.consumeResult(id)).toBe(false); // Running behavior is unchanged.
    expect(manager.abort(id)).toBe(true);
    expect(record.abortController?.signal.aborted).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.runSettled).toBe(false);
    expect(await manager.consumeResult(id)).toBe(!optIn);
    expect(record.resultConsumed === true).toBe(!optIn);
    expect(run.child.dispose).not.toHaveBeenCalled();
  } finally {
    run.finish();
    await record.promise;
  }
  expect(record.status).toBe("stopped");
  expect(await manager.consumeResult(id)).toBe(true);
  expect(vi.mocked(run.child.dispose).mock.calls).toHaveLength(optIn ? 1 : 0);
});

it.each([false, true])("real RPC stopped consumption preserves disposeOnConsume=%s policy and suppresses late notification", async (optIn) => {
  const run = pendingRun();
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as AgentManager;
  const id = registry.spawn(booted.pi, ctx(), optIn ? "disposable" : "general-purpose", "question", {
    description: "stopped RPC worker", isBackground: true, isolation: "off",
  });
  const record = registry.getRecord(id)!;
  const reply = vi.fn();
  events.on("subagents:rpc:consume:reply:stopped", reply);
  events.emit("subagents:rpc:stop", { requestId: "stop", agentId: id });
  try {
    expect(record.status).toBe("stopped");
    expect(record.runSettled).toBe(false);
    events.emit("subagents:rpc:consume", { requestId: "stopped", agentId: id });
    await flush();
    expect(reply).toHaveBeenCalledWith(optIn
      ? { success: false, error: "Agent not found or still running" }
      : { success: true });
    expect(record.resultConsumed === true).toBe(!optIn);
    expect(run.child.dispose).not.toHaveBeenCalled();
  } finally {
    run.finish();
    await record.promise;
  }
  if (optIn) {
    events.emit("subagents:rpc:consume", { requestId: "stopped", agentId: id });
    await flush();
  }
  expect(reply).toHaveBeenLastCalledWith({ success: true });
  await vi.advanceTimersByTimeAsync(250);
  expect(booted.pi.sendMessage).not.toHaveBeenCalled();
  expect(vi.mocked(run.child.dispose).mock.calls).toHaveLength(optIn ? 1 : 0);
});

it.each([false, true])("top-level stopped wait returns before settlement only for disposeOnConsume=%s default-off", async (optIn) => {
  const run = pendingRun();
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as AgentManager;
  const id = registry.spawn(booted.pi, ctx(), optIn ? "disposable" : "general-purpose", "question", {
    description: "stopped result worker", isBackground: true, isolation: "off",
  });
  const record = registry.getRecord(id)!;
  events.emit("subagents:rpc:stop", { requestId: "stop", agentId: id });
  let returned = false;
  const pending = booted.tools.get("get_subagent_result").execute("get", { agent_id: id, wait: true }, undefined, undefined, ctx())
    .then((result: unknown) => { returned = true; return result; });
  try {
    await flush();
    expect(record.status).toBe("stopped");
    expect(record.runSettled).toBe(false);
    expect(returned).toBe(!optIn);
    expect(record.resultConsumed === true).toBe(!optIn);
    expect(run.child.dispose).not.toHaveBeenCalled();
  } finally {
    run.finish();
    await record.promise;
    await pending;
  }
  expect(textOf(await pending)).toContain("stopped");
  expect(record.resultConsumed).toBe(true);
  expect(vi.mocked(run.child.dispose).mock.calls).toHaveLength(optIn ? 1 : 0);
  await vi.advanceTimersByTimeAsync(250);
  expect(booted.pi.sendMessage).not.toHaveBeenCalled();
});

it.each([false, true])("nested stopped wait preserves disposeOnConsume=%s wait and consumption policy", async (optIn) => {
  const run = pendingRun();
  const id = manager.spawn(booted.pi, ctx(), optIn ? "disposable" : "general-purpose", "question", {
    description: "stopped nested worker", isBackground: true, parentAgentId: "parent", isolation: "off",
  });
  const record = manager.getRecord(id)!;
  manager.abort(id);
  const tool = createNestedSubagentTools({ manager, pi: booted.pi, parentAgentId: "parent", depth: 1,
    maxSubagentDepth: 2, allowedSubagents: "all", configCwd: env.dir }).find(tool => tool.name === "get_subagent_result")!;
  let returned = false;
  const pending = tool.execute("get", { agent_id: id, wait: true }, undefined, undefined, ctx())
    .then(result => { returned = true; return result; });
  try {
    await flush();
    expect(record.status).toBe("stopped");
    expect(record.runSettled).toBe(false);
    expect(returned).toBe(!optIn);
    expect(record.resultConsumed).not.toBe(true); // Ordinary nested reads never auto-consume.
    expect(run.child.dispose).not.toHaveBeenCalled();
  } finally {
    run.finish();
    await record.promise;
    await pending;
  }
  expect(textOf(await pending)).toContain("STOPPED BY THE USER");
  expect(record.resultConsumed === true).toBe(optIn);
  expect(vi.mocked(run.child.dispose).mock.calls).toHaveLength(optIn ? 1 : 0);
});

it.each([false, true])("running nonblocking diagnostic is scoped to disposeOnConsume=%s", async (optIn) => {
  const run = pendingRun();
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as AgentManager;
  const id = registry.spawn(booted.pi, ctx(), optIn ? "disposable" : "general-purpose", "question", {
    description: "running diagnostic worker", isBackground: true, isolation: "off",
  });
  const record = registry.getRecord(id)!;
  try {
    const response = await booted.tools.get("get_subagent_result").execute("get", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(response)).toContain("Agent is still running.");
    expect(textOf(response).includes("Agent is still settling")).toBe(optIn);
    expect(record.resultConsumed).not.toBe(true);
    expect(run.child.dispose).not.toHaveBeenCalled();
  } finally {
    run.finish();
    await record.promise;
  }
});
