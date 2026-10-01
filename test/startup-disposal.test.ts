import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as runnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof runnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(),
  isWorktreeIsolationEnabled: () => true, pruneWorktrees: vi.fn(async () => {}),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";
import { ctx, flush, makePi } from "./helpers/boot-extension.js";

let manager: AgentManager;
beforeEach(() => {
  registerAgents(new Map([["one-shot-tools", {
    name: "one-shot-tools", description: "startup qualification", disposeOnConsume: true,
    extensions: false, skills: false, systemPrompt: "No actual SDK calls", promptMode: "replace",
  }]]));
  manager = new AgentManager();
});
afterEach(async () => {
  await manager.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("parent disposal waits for allocation and stopped-startup cleanup; consume and GC retain unsettled work", async () => {
  await manager.dispose();
  vi.useFakeTimers();
  manager = new AgentManager();
  let allocate!: (value: { path: string; branch: string; baseSha: string; workPath: string }) => void;
  let cleanup!: (value: { hasChanges: boolean }) => void;
  vi.mocked(createWorktree).mockImplementationOnce(() => new Promise(resolve => { allocate = resolve; }));
  vi.mocked(cleanupWorktree).mockImplementationOnce(() => new Promise(resolve => { cleanup = resolve; }));
  const id = manager.spawn(makePi().pi, ctx(), "one-shot-tools", "never prompt", {
    description: "startup qualification", isBackground: true, isolation: "worktree",
  });
  const record = manager.getRecord(id)!;
  // Exercise the timer-driven GC before parent teardown clears its interval.
  manager.abort(id);
  record.completedAt = Date.now() - 700_000;
  manager.clearCompleted();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(manager.getRecord(id)).toBe(record);
  vi.useRealTimers();
  const shutdown = manager.dispose();
  let disposed = false;
  void shutdown.then(() => { disposed = true; });
  const worktree = { path: "/tmp/fake-task-worktree", branch: "fake-only", baseSha: "a".repeat(40), workPath: "/tmp/fake-task-worktree" };
  try {
    await flush();
    expect(record.status).toBe("stopped");
    expect(record.runSettled).toBe(false);
    expect(await manager.consumeResult(id)).toBe(false);
    expect(disposed).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    allocate(worktree);
    await flush();
    expect(cleanupWorktree).toHaveBeenCalledOnce();
    expect(record.runSettled).toBe(false);
    expect(await manager.consumeResult(id)).toBe(false);
    manager.clearCompleted();
    expect(manager.getRecord(id)).toBe(record);
    expect(disposed).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  } finally {
    allocate(worktree);
    await flush();
    cleanup({ hasChanges: false });
    await shutdown;
  }
  expect(record.runSettled).toBe(true);
  expect(manager.getRecord(id)).toBeUndefined();
  expect(cleanupWorktree).toHaveBeenCalledOnce();
  expect(runAgent).not.toHaveBeenCalled();
  expect(disposed).toBe(true);
});
