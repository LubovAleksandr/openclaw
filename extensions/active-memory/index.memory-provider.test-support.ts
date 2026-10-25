import type { MemorySearchHit } from "openclaw/plugin-sdk/memory-host-search";
import { expect, it, vi, type Mock } from "vitest";

type MemoryProviderTestParams = {
  memoryCapability: {
    deterministicRecallToolName: string | undefined;
    recallToolNames: readonly string[] | undefined;
  };
  getActiveMemoryProvider: Mock;
  getActiveMemorySearchManager: Mock;
  /** Selects a slot owner that registers the provider-neutral runtime. */
  useNativeProvider: () => void;
  runEmbeddedAgent: Mock;
  registerPluginConfig: (overrides: Record<string, unknown>) => void;
  runPromptBuild: (
    event: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  writeUsableMemoryTranscript: (sessionFile: string, text: string) => Promise<void>;
  seedSession: (sessionKey: string, sessionId: string, updatedAt?: number) => void;
  expectPrependContextContains: (result: unknown, text: string) => void;
  lastRuntimeEmbeddedRunParams: () => Record<string, unknown>;
};

function triggerProvider(hits: MemorySearchHit[] = []) {
  return {
    provider: {
      search: vi.fn(async () => ({ hits: [] })),
      capabilities: { candidates: ["trigger"] },
      candidates: vi.fn(async () => ({ hits })),
      close: vi.fn(),
    },
  };
}

/** Registers legacy and provider-neutral Active Memory recall, cache, authority, and tool-selection coverage. */
export function registerActiveMemoryProviderTests(params: MemoryProviderTestParams): void {
  const prompt = "what did I order last time?";
  const ownerAudience = { kind: "owner-private", agentId: "main" } as const;
  const ownerContext = {
    sessionKey: "agent:main:telegram:direct:owner",
    sessionId: "owner-session",
    messageProvider: "telegram",
    channelId: "owner",
  };
  function nativeProvider(config: Record<string, unknown>) {
    params.useNativeProvider();
    params.registerPluginConfig(config);
    const lookup = triggerProvider();
    params.getActiveMemoryProvider.mockResolvedValue(lookup);
    return lookup.provider.search;
  }
  function recallSummaries(next: () => string) {
    params.runEmbeddedAgent.mockImplementation(async (run: { sessionFile: string }) => {
      const text = next();
      await params.writeUsableMemoryTranscript(run.sessionFile, text);
      return { payloads: [{ text }] };
    });
  }
  it("does not reuse trigger candidates or recall summaries across memory audiences", async () => {
    const search = nativeProvider({ mode: "always", cacheTtlMs: 1_000 });
    let recall = 0;
    recallSummaries(() => (++recall === 1 ? "owner-private memory" : "conversation memory"));
    const { sessionKey, sessionId } = ownerContext;
    const event = {
      prompt,
      currentUserMessage: prompt,
      currentUserMessageId: "same-request",
    };
    const context = {
      runId: "run-audience-cache",
      ...ownerContext,
    };
    params.seedSession(sessionKey, sessionId);

    const ownerResult = await params.runPromptBuild(event, {
      ...context,
      memoryAudience: ownerAudience,
    });
    const conversationResult = await params.runPromptBuild(event, {
      ...context,
      memoryAudience: { kind: "conversation", agentId: "main", sessionKey, sessionId },
    });

    params.expectPrependContextContains(ownerResult, "owner-private memory");
    params.expectPrependContextContains(conversationResult, "conversation memory");
    expect(params.getActiveMemoryProvider).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(params.runEmbeddedAgent).toHaveBeenCalledTimes(2);
  });

  it("does not publish or cache recall after the turn's memory audience goes stale", async () => {
    params.useNativeProvider();
    params.registerPluginConfig({ mode: "always", cacheTtlMs: 1_000 });
    let audienceCurrent = true;
    const assertMemoryAudienceCurrent = () => {
      if (!audienceCurrent) {
        throw new Error("memory audience is no longer current");
      }
    };
    let recall = 0;
    recallSummaries(() => {
      const summary = ++recall === 1 ? "stale private memory" : "current private memory";
      if (recall === 1) {
        audienceCurrent = false;
      }
      return summary;
    });
    const { sessionKey, sessionId } = ownerContext;
    params.seedSession(sessionKey, sessionId);
    const turn = (runId: string) =>
      params.runPromptBuild(
        { prompt },
        {
          runId,
          ...ownerContext,
          memoryAudience: ownerAudience,
          assertMemoryAudienceCurrent,
        },
      );

    await expect(turn("run-stale-audience")).resolves.toBeUndefined();

    audienceCurrent = true;
    params.expectPrependContextContains(
      await turn("run-current-audience"),
      "current private memory",
    );
    expect(params.runEmbeddedAgent).toHaveBeenCalledTimes(2);
  });

  it("does not recall historical text for an explicit empty request", async () => {
    const search = nativeProvider({ mode: "always" });
    await params.runPromptBuild({
      prompt: "What do you remember about my preferences?",
      currentUserMessage: " \n ",
      currentUserMessageId: "empty-admission",
      messages: [{ role: "user", content: "What do you remember about my preferences?" }],
    });
    expect(search).not.toHaveBeenCalled();
    expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("reuses one trigger admission across history changes and keeps authority separate", async () => {
    const search = nativeProvider({ mode: "escalate" });
    for (const [history, fingerprint, admission] of [
      ["old history", "authority-a", "same-admission"],
      ["rebuilt history", "authority-a", "same-admission"],
      ["rebuilt history", "authority-b", "same-admission"],
      ["rebuilt history", "authority-b", "new-admission"],
    ] as const) {
      await params.runPromptBuild(
        {
          prompt: history,
          currentUserMessage: "ok",
          currentUserMessageId: admission,
          messages: [{ role: "user", content: history }],
        },
        {
          runId: "trigger-rebuild",
          toolAuthority: {
            fingerprint,
            allows: () => true,
            assertActive: () => undefined,
          },
        },
      );
    }
    expect(search).toHaveBeenCalledTimes(3);
    expect(params.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("passes the parent turn's memory audience to the deep-recall child", async () => {
    const memoryAudience = {
      kind: "conversation",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "s-main",
    } as const;
    await params.runPromptBuild(
      { prompt: "what wings should i order?" },
      { sessionKey: "agent:main:main", sessionId: "s-main", memoryAudience },
    );
    expect(params.lastRuntimeEmbeddedRunParams().memoryAudience).toBe(memoryAudience);
  });

  it("serves native trigger recall under the turn's session authority and audience", async () => {
    params.useNativeProvider();
    const assertMemoryAudienceCurrent = vi.fn();
    params.getActiveMemoryProvider.mockResolvedValueOnce(
      triggerProvider([
        {
          reference: { providerId: "records", id: "travel" },
          score: 1,
          excerpt: "Prefer aisle seats.",
          citations: [{ label: "Travel preference" }],
          automaticRecall: { eligible: true, triggers: "booking a flight" },
        },
      ]),
    );

    const result = await params.runPromptBuild(
      { prompt: "Help when booking a flight" },
      {
        ...ownerContext,
        memoryAudience: ownerAudience,
        assertMemoryAudienceCurrent,
      },
    );

    params.expectPrependContextContains(result, "Prefer aisle seats. (Source: Travel preference)");
    expect(params.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(params.getActiveMemoryProvider.mock.calls[0]?.[0].context.authority).toEqual({
      kind: "session",
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: "owner-session",
      sandboxed: false,
      audience: ownerAudience,
    });
    expect(assertMemoryAudienceCurrent).toHaveBeenCalled();
  });

  it("skips native trigger recall when tool policy denies a declared recall tool", async () => {
    params.memoryCapability.recallToolNames = ["record_find", "record_get"];
    params.useNativeProvider();
    await params.runPromptBuild(
      { prompt: "Help when booking a flight" },
      {
        ...ownerContext,
        toolAuthority: {
          fingerprint: "record-find-denied",
          allows: (toolName: string) => toolName !== "record_find",
          assertActive: () => undefined,
        },
      },
    );
    expect(params.getActiveMemoryProvider).not.toHaveBeenCalled();
  });

  it.each([["denies the deterministic recall tool", "memory_search", "memory_search"]])(
    "skips legacy trigger recall when the owner %s",
    async (_label, toolName, denied) => {
      params.memoryCapability.deterministicRecallToolName = toolName;
      await params.runPromptBuild(
        { prompt: "Help when booking a flight" },
        {
          sessionKey: "agent:main:telegram:direct:owner",
          sessionId: "owner-session",
          messageProvider: "telegram",
          channelId: "owner",
          toolAuthority: {
            fingerprint: "legacy-policy",
            allows: (name: string) => name !== denied,
            assertActive: () => undefined,
          },
        },
      );
      expect(params.getActiveMemorySearchManager).not.toHaveBeenCalled();
      expect(params.getActiveMemoryProvider).not.toHaveBeenCalled();
    },
  );
}
