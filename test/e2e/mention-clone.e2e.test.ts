import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentSession, type ExtensionContext, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { expect, it, vi } from "vitest";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

// Real loader, extension hooks, SDK prompt and tool dispatch; only auth/model
// plumbing and provider answers are structural/scripted, with no live requests.
it.each(["ordinary", "compacted", "branch"])("preserves the live prompt, %s history and single Agent capability through real SDK dispatch", async history => {
  const cwd = mkdtempSync(join(tmpdir(), "mention-clone-sdk-"));
  const faux = registerFauxProvider({ provider: "mention-clone-faux" });
  const dispose = vi.spyOn(AgentSession.prototype, "dispose");
  try {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const parent = SessionManager.inMemory(cwd);
    const kept = parent.appendMessage({ role: "user", content: "parent conversation sentinel", timestamp: 1 });
    if (history === "compacted") parent.appendCompaction("compaction summary sentinel", kept, 10);
    if (history === "branch") parent.branchWithSummary(kept, "branch summary sentinel");
    const entries = JSON.stringify(parent.getEntries());
    const livePrompt = "Exact parent instructions\nNo appended clone instructions.";
    const ctx = { cwd, model, thinkingLevel: "off", sessionManager: parent,
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      getSystemPrompt: () => livePrompt } as unknown as ExtensionContext;
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "started" }], details: {} }));
    const agentTool: ToolDefinition = { name: "Agent", label: "Agent", description: "Start the mentioned agent",
      parameters: Type.Object({}), execute };
    const requests: Array<{ messages: Parameters<FauxResponseFactory>[0]["messages"]; systemPrompt?: string; tools?: readonly { name: string }[] }> = [];
    const snapshot = (context: Parameters<FauxResponseFactory>[0]) => {
      // Older SDK contexts contain executable tool functions; snapshot only
      // the model-visible names, not those non-cloneable closures.
      const legacy = context as { systemPrompt?: string; tools?: readonly { name: string }[] };
      requests.push({ messages: structuredClone(context.messages), systemPrompt: legacy.systemPrompt,
        tools: legacy.tools?.map(tool => ({ name: tool.name })) });
    };
    faux.setResponses([context => {
      snapshot(context);
      return fauxAssistantMessage([fauxToolCall("Agent", {})], { stopReason: "toolUse" });
    }, context => {
      snapshot(context);
      return fauxAssistantMessage("done");
    }]);

    const result = await runMentionClone({ ctx, type: "Explore", message: "inspect", agentTool });
    expect(result, JSON.stringify(dispose.mock.instances[0]?.agent.state.messages)).toEqual({ spawned: true });
    expect(requests).toHaveLength(2);
    for (const context of requests) {
      const legacy = context as { systemPrompt?: string; tools?: readonly { name: string }[] };
      const system = context.messages.find(message => (message.role as string) === "system") as unknown as { content: string } | undefined;
      expect(legacy.systemPrompt ?? system?.content).toBe(livePrompt);
      const tools = new Set(legacy.tools?.map(tool => tool.name));
      for (const message of context.messages) {
        const delta = message as unknown as { role: string; toolsAdded?: readonly { name: string }[]; toolsRemoved?: readonly { name: string }[] };
        if (delta.role !== "system") continue;
        for (const tool of delta.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of delta.toolsAdded ?? []) tools.add(tool.name);
      }
      expect([...tools]).toEqual(["Agent"]);
      expect(JSON.stringify(context.messages)).toContain("parent conversation sentinel");
      if (history !== "ordinary") expect(JSON.stringify(context.messages)).toContain(`${history === "compacted" ? "compaction" : "branch"} summary sentinel`);
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]).toEqual([undefined, { run_in_background: true }, expect.anything(), expect.any(Function), expect.objectContaining({ cwd, sessionManager: parent })]);
    expect(JSON.stringify(parent.getEntries())).toBe(entries);
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    faux.unregister();
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  }
});
