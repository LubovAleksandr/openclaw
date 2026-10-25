import { streamSimpleAnthropic } from "@openclaw/ai/internal/anthropic";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createCapturedPluginRegistration,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { MINIMAX_OAUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHangingLoopbackServer } from "../test-support/hanging-loopback-server.js";
import { cancelTrackedTextResponse } from "../test-support/streaming-error-response.js";
import minimaxPlugin from "./index.js";
import { loginMiniMaxPortalOAuth } from "./oauth.js";

const m31Model: Model<"anthropic-messages"> = {
  id: "MiniMax-M3.1-Flash-Preview",
  name: "MiniMax M3.1 Flash Preview",
  provider: "minimax",
  api: "anthropic-messages",
  baseUrl: "https://api.minimaxi.com/anthropic",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_000_000,
  maxTokens: 131072,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const signedThought = { type: "thinking" as const, thinking: "reason", thinkingSignature: "sig" };
const replayedThought = { type: "thinking", thinking: "reason", signature: "sig" };

const globalApi = "https://api.minimax.io/anthropic";
const cnApi = "https://api.minimaxi.com/anthropic";
const currentCnApi = "https://api.minimax.cn/anthropic";
const globalToken = "https://account.minimax.io/oauth2/token";
const cnToken = "https://account.minimaxi.com/oauth2/token";
function modelConfig(
  baseUrl: string,
  provider = "minimax-portal",
  extra: Partial<ModelProviderConfig> = {},
) {
  return { models: { providers: { [provider]: { baseUrl, models: [], ...extra } } } };
}
const portalOutcome = (profileId: string | undefined, status: "ready" | "unavailable") => [
  { provider: "minimax-portal", profileId, status },
];
function catalogContext(overrides: Partial<ProviderCatalogContext> = {}): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    ...overrides,
  };
}

function expectCatalogHeaders(key: string | null, bearer: string | null) {
  const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
  expect([headers.get("x-api-key"), headers.get("authorization")]).toEqual([key, bearer]);
}

async function registeredProviders(baseUrl?: string) {
  const { api, providers } = createCapturedPluginRegistration({ id: "minimax", name: "MiniMax" });
  if (baseUrl !== undefined) {
    api.runtime.config.current = () => modelConfig(baseUrl);
  }
  minimaxPlugin.register(api);
  return {
    apiProvider: requireRegisteredProvider(providers, "minimax"),
    portalProvider: requireRegisteredProvider(providers, "minimax-portal"),
  };
}

const selectedProfile = "minimax-portal:selected";
type CatalogKey = ReturnType<ProviderCatalogContext["resolveProviderApiKey"]>;
type CatalogAuth = ReturnType<ProviderCatalogContext["resolveProviderAuth"]>;
const key = (overrides: Partial<CatalogKey> = {}): CatalogKey => ({
  apiKey: "MINIMAX_OAUTH_TOKEN",
  profileId: selectedProfile,
  ...overrides,
});
const profile = (overrides: Partial<CatalogAuth> = {}): CatalogAuth => ({
  ...key(),
  source: "profile",
  mode: "token",
  discoveryApiKey: "chosen",
  ...overrides,
});
const apiKey = "MINIMAX_API_KEY";
const oauth = { apiKey: MINIMAX_OAUTH_MARKER, mode: "oauth" as const };
const oauthKey = key({ ...oauth, discoveryApiKey: "chosen" });
const otherOAuth = profile({ ...oauth, profileId: "other", discoveryApiKey: "wrong" });
const unselected = { profileId: undefined };

function payloadStream(payload: Record<string, unknown>): StreamFn {
  return (model, _context, options) => {
    options?.onPayload?.(payload, model);
    return createAssistantMessageEventStream();
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

describe("minimax provider hooks", () => {
  let apiProvider: ProviderPlugin;
  let portalProvider: ProviderPlugin;
  beforeEach(async () => {
    ({ apiProvider, portalProvider } = await registeredProviders());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ id: "MiniMax-M3" }] })),
    );
  });

  it.each([
    [" ", undefined, "https://api.minimaxi.com/anthropic/v1/models"],
    ["https://api.minimax.io/v1", "openai-completions", "https://api.minimax.io/v1/models"],
  ] as const)(
    "discovers configured endpoint %s/%s ahead of the CN environment",
    async (baseUrl, api, expectedEndpoint) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
        input === expectedEndpoint
          ? Response.json({ data: [{ id: "MiniMax-M3" }] })
          : new Response(null, { status: 401 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await runProviderCatalog({
        provider: apiProvider,
        ...catalogContext({
          config: {
            models: {
              providers: {
                ...modelConfig(baseUrl, "minimax", { api }).models.providers,
                ...modelConfig("https://other-account.example.com/anthropic").models.providers,
              },
            },
          },
          env: { MINIMAX_API_HOST: "https://api.minimaxi.com" },
          resolveProviderApiKey: () => ({
            apiKey: "MINIMAX_API_KEY",
            discoveryApiKey: "selected-api-key",
            profileId: "minimax:selected",
          }),
        }),
      });

      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(expectedEndpoint);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectCatalogHeaders(api ? null : "selected-api-key", api ? "Bearer selected-api-key" : null);
      expect(result).toMatchObject({
        provider: { api: api ?? "anthropic-messages" },
        outcomes: [{ provider: "minimax", profileId: "minimax:selected", status: "ready" }],
      });
    },
  );

  it.each([
    ["explicit", key({ apiKey: undefined }), profile(oauth), "explicit-key"],
    ["legacy", key({ apiKey }), profile({ apiKey }), apiKey],
    ["selected OAuth", oauthKey, otherOAuth, MINIMAX_OAUTH_MARKER],
    ["different profiles", key(), profile({ profileId: "other" }), undefined],
    ["unknown profiles", key(unselected), profile(unselected), undefined],
    ["different modes", key({ mode: "api_key" }), profile(), undefined],
  ] as const)("selects portal credentials: %s", async (name, selected, resolved, expectedKey) => {
    const explicit = name === "explicit";
    const ctx = catalogContext({
      config: explicit ? modelConfig(globalApi, "minimax-portal", { apiKey: expectedKey }) : {},
      resolveProviderApiKey: () => selected,
      resolveProviderAuth: () => resolved,
    });
    const result = explicit
      ? await portalProvider.catalog?.run(ctx)
      : await runProviderCatalog({ provider: portalProvider, ...ctx });
    if (!expectedKey) {
      expect(result).toEqual({
        providers: {},
        outcomes: portalOutcome(selected.profileId, "unavailable"),
      });
      expect(fetch).not.toHaveBeenCalled();
      return;
    }
    const provider = result && "provider" in result ? result.provider : undefined;
    expect(provider?.apiKey).toBe(expectedKey);
    if (explicit) {
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(globalApi + "/v1/models");
    } else {
      expect(result).toHaveProperty("outcomes", portalOutcome(selectedProfile, "ready"));
    }
    expectCatalogHeaders(explicit ? "explicit-key" : null, explicit ? null : "Bearer chosen");
  });

  it.each([
    ["minimax", "MiniMax-M3", "adaptive"],
    ["minimax", "MiniMax-M2.7", "off"],
    ["minimax-portal", m31Model.id, "max"],
  ])("defaults %s/%s thinking to %s", (providerId, modelId, defaultLevel) => {
    const provider = providerId === "minimax" ? apiProvider : portalProvider;
    expect(provider.resolveThinkingProfile?.({ provider: provider.id, modelId })).toMatchObject({
      defaultLevel,
    });
  });

  it("discovers and resolves M3.1 on both auth routes", async () => {
    for (const provider of [apiProvider, portalProvider]) {
      const ref = { provider: provider.id, modelId: m31Model.id };
      const catalog = await provider.staticCatalog?.run({ env: {}, config: {} } as never);
      const models =
        catalog && "providers" in catalog ? catalog.providers[provider.id]?.models : [];
      expect(models?.find((model) => model.id === m31Model.id)).toMatchObject({
        compat: { codeMode: "preferred" },
      });
      expect(provider.resolveThinkingProfile?.(ref)?.levels).toEqual(
        ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      );
      expect(
        provider.resolveDynamicModel?.({
          ...ref,
          modelId: ref.modelId.toLowerCase(),
          providerConfig: {},
        } as never),
      ).toMatchObject({ id: "MiniMax-M3.1-Flash-Preview", api: "anthropic-messages" });
    }
  });

  it.each([
    ["minimax", "wrapStreamFn", undefined, "max", m31Model.maxTokens, 500],
    ["minimax-portal", "wrapSimpleCompletionStreamFn", "low", "low", m31Model.maxTokens, 500],
    ["minimax", "wrapSimpleCompletionStreamFn", "high", "high", 128, 500],
    ["minimax-portal", "wrapStreamFn", "adaptive", "max", 128, undefined],
  ] as const)(
    "shapes M3.1 via %s/%s with effort %s",
    async (providerId, hook, thinkingLevel, effort, modelMaxTokens, requestedMaxTokens) => {
      const provider = providerId === "minimax" ? apiProvider : portalProvider;
      const model = {
        ...m31Model,
        maxTokens: modelMaxTokens,
        provider: provider.id,
        api: hook === "wrapStreamFn" ? "anthropic-messages" : "openclaw-provider-simple:synthetic",
      };
      let payload: unknown;
      const wrapped = provider[hook]?.({
        provider: provider.id,
        modelId: model.id,
        sourceApi: "anthropic-messages",
        thinkingLevel,
        streamFn: (runtimeModel, context, options) =>
          streamSimpleAnthropic({ ...runtimeModel, api: "anthropic-messages" }, context, options),
      });
      if (!wrapped) {
        throw new Error(`MiniMax did not register ${hook}`);
      }
      const stream = await wrapped(
        model,
        {
          messages: [
            { role: "user", content: "Hi", timestamp: 0 },
            makeAgentAssistantMessage({
              api: "anthropic-messages",
              provider: provider.id,
              model: m31Model.id,
              content: [signedThought, { type: "text", text: "Hello." }],
              timestamp: 1,
            }),
            { role: "user", content: "Continue.", timestamp: 2 },
          ],
        },
        {
          apiKey: "synthetic-minimax-key",
          maxTokens: requestedMaxTokens,
          reasoning: thinkingLevel === "adaptive" ? undefined : thinkingLevel,
          // M3.1 uses adaptive effort; manual budgets must not disable signed replay.
          thinkingBudgets:
            modelMaxTokens === m31Model.maxTokens
              ? { low: 0, medium: 0, high: 0, max: 0 }
              : undefined,
          onPayload: (value) => {
            payload = value;
            throw new Error("stop before network");
          },
        },
      );
      expect(await stream.result()).toMatchObject({ errorMessage: "stop before network" });
      expect(payload).toMatchObject({
        thinking: { type: "adaptive" },
        max_tokens: Math.min(requestedMaxTokens ?? m31Model.maxTokens, modelMaxTokens),
        output_config: { effort },
      });
      expect(payload).not.toHaveProperty("thinking.budget_tokens");
      expect(payload).toHaveProperty("messages.1.content.0", replayedThought);
    },
  );

  it("preserves M3.1 output configuration and resolves effort per call", async () => {
    const payload: Record<string, unknown> = { output_config: { format: { type: "json_schema" } } };
    const wrapped = apiProvider.wrapStreamFn?.({
      provider: "minimax",
      modelId: m31Model.id,
      thinkingLevel: "high",
      streamFn: payloadStream(payload),
    });
    for (const reasoning of ["low", "max", undefined] as const) {
      void wrapped?.(m31Model, { messages: [] }, { reasoning });
      expect(payload.output_config).toEqual({
        format: { type: "json_schema" },
        effort: reasoning ?? "high",
      });
    }
    payload.thinking = { type: "disabled" };
    const unchanged = structuredClone(payload);
    void wrapped?.({ ...m31Model, api: "openai-completions" }, { messages: [] }, {});
    expect(payload).toEqual(unchanged);
  });

  it("owns ultrafast stream wrapping for MiniMax transports", async () => {
    for (const provider of [apiProvider, portalProvider]) {
      const model = { ...m31Model, id: "MiniMax-M2.7", provider: provider.id };
      const streamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
      const wrapped = provider.wrapStreamFn?.({
        provider: provider.id,
        modelId: model.id,
        extraParams: { fastMode: "ultrafast" },
        streamFn,
      });
      void wrapped?.(model, { messages: [] }, {});
      expect(streamFn.mock.calls[0]?.[0].id).toBe("MiniMax-M2.7-highspeed");
    }
  });

  it("prefers minimax-portal oauth when resolving MiniMax usage auth", async () => {
    const resolveOAuthToken = vi.fn(async (params?: { provider?: string }) =>
      params?.provider === "minimax-portal" ? { token: "portal-oauth-token" } : null,
    );
    const resolveApiKeyCandidatesFromConfigAndStore = vi.fn(async () => []);

    await expect(
      apiProvider.resolveUsageAuth?.({
        provider: "minimax",
        config: {},
        env: {},
        resolveOAuthToken,
        resolveApiKeyCandidatesFromConfigAndStore,
      } as never),
    ).resolves.toEqual({ token: "portal-oauth-token" });

    expect(resolveApiKeyCandidatesFromConfigAndStore).not.toHaveBeenCalled();
  });

  it("uses the configured MiniMax base URL for usage snapshots", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://api.minimax.io/v1/token_plan/remains");
      return Response.json({});
    });

    await apiProvider.fetchUsageSnapshot?.({
      provider: "minimax",
      config: modelConfig(globalApi, "minimax"),
      env: {},
      token: "key",
      timeoutMs: 5000,
      fetchFn: fetchFn as typeof fetch,
    } as never);

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    [cnApi, globalApi, cnToken, true],
    [currentCnApi, globalApi, cnToken, true],
    [globalApi, undefined, globalToken, true],
    ["https://proxy.example.com/anthropic", undefined, globalToken, true],
    [globalApi, undefined, undefined, false],
    [cnApi, globalApi, globalToken, false],
    [currentCnApi, globalApi, globalToken, false],
    [globalApi, cnApi, cnToken, false],
  ] as const)(
    "binds portal OAuth refresh for %s (runtime: %s, issuer: %s, allowed: %s)",
    async (baseUrl, runtimeBaseUrl, tokenEndpoint, allowed) => {
      const scoped = await registeredProviders(runtimeBaseUrl ?? baseUrl);
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const fetchMock = stubOAuthFetch(
        tokenResponse({
          access_token: "fresh-access",
          refresh_token: "rotated-refresh",
          expired_in: 7200,
        }),
      );

      const result = scoped.portalProvider.refreshOAuth?.(
        expiredPortalCredential(tokenEndpoint),
        runtimeBaseUrl ? modelConfig(baseUrl) : undefined,
      );
      if (!allowed) {
        await expect(result).rejects.toThrow(
          "openclaw models auth login --provider minimax-portal",
        );
        expect(fetchMock).not.toHaveBeenCalled();
        return;
      }
      await expect(result).resolves.toEqual({
        ...expiredPortalCredential(tokenEndpoint),
        access: "fresh-access",
        refresh: "rotated-refresh",
        expires: 1_700_007_200_000,
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      expect(url).toBe(tokenEndpoint);
      expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
        grant_type: "refresh_token",
        client_id: "78257093-7e40-4613-99e0-527b14b39113",
        refresh_token: "stored-refresh",
      });
    },
  );
});

function expiredPortalCredential(tokenEndpoint: string | undefined) {
  return {
    type: "oauth" as const,
    provider: "minimax-portal",
    access: "expired-access",
    refresh: "stored-refresh",
    expires: 1,
    authFlow: "device-code",
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
  };
}

type FetchResponder =
  | Response
  | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>);

function authResponse(init?: RequestInit, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    user_code: "CODE",
    verification_uri: "https://example.com/device",
    expired_in: Date.now() + 10_000,
    state: new URLSearchParams(String(init?.body)).get("state"),
    ...overrides,
  });
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    status: "success",
    access_token: "access",
    refresh_token: "refresh",
    expired_in: 3600,
    ...overrides,
  });
}

function stubOAuthFetch(...responders: FetchResponder[]) {
  let responseIndex = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const responder = responders[responseIndex++];
    if (!responder) {
      throw new Error(`unexpected MiniMax OAuth fetch #${responseIndex}`);
    }
    return typeof responder === "function" ? await responder(input, init) : responder;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function loginMiniMax(overrides: Partial<Parameters<typeof loginMiniMaxPortalOAuth>[0]> = {}) {
  return loginMiniMaxPortalOAuth({
    openUrl: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    progress: { update: vi.fn(), stop: vi.fn() },
    ...overrides,
  });
}

describe("loginMiniMaxPortalOAuth", () => {
  it("rejects malformed token expiry through the OAuth flow", async () => {
    stubOAuthFetch((_input, init) => authResponse(init), tokenResponse({ expired_in: "3600s" }));

    await expect(loginMiniMax()).rejects.toThrow("invalid token expiry");
  });

  it.each([
    ["authorization code", "/device-code", 0],
    ["token polling", "/token", 1],
  ] as const)(
    "times out %s HTTP requests against a hanging loopback server",
    async (_phase, path, fetchIndex) => {
      const realFetch = fetch;
      const server = await startHangingLoopbackServer();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let loginPromise: Promise<unknown> | undefined;

      try {
        const hangingResponse: FetchResponder = async (_input, init) =>
          await realFetch(`${server.origin}${path}`, init);
        const fetchMock =
          fetchIndex === 0
            ? stubOAuthFetch(hangingResponse)
            : stubOAuthFetch((_input, init) => authResponse(init), hangingResponse);

        loginPromise = loginMiniMax();
        loginPromise.catch(() => undefined);

        await server.waitForRequestCount(1);
        await vi.advanceTimersByTimeAsync(30_000);
        vi.useRealTimers();
        await expect(
          withTimeout(loginPromise, 2_000, {
            message: "MiniMax OAuth did not settle within the test deadline",
          }),
        ).rejects.toHaveProperty("name", expect.stringMatching(/^(AbortError|TimeoutError)$/));
        expect(server.requests).toContain(path);
        expect(fetchMock.mock.calls[fetchIndex]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      } finally {
        await server.close();
        await loginPromise?.catch(() => undefined);
      }
    },
  );

  it.each([
    ["authorization", false, 503],
    ["token", true, 503],
    ["HTTP 200 token", true, 200],
  ] as const)("bounds %s bodies without using response.text()", async (name, token, status) => {
    const malformed = status === 200;
    const chunk = malformed ? '{"status":"error","detail":"' : `minimax ${name} unavailable `;
    const message = malformed
      ? "MiniMax OAuth failed to parse response."
      : expect.stringContaining(
          token
            ? "minimax token unavailable"
            : "MiniMax OAuth authorization failed: minimax authorization unavailable",
        );
    const tracked = cancelTrackedTextResponse(`${chunk.repeat(malformed ? 512 : 1024)}tail`, {
      status,
      headers: { "Content-Type": status === 200 ? "application/json" : "text/plain" },
    });
    if (token) {
      stubOAuthFetch((_input, init) => authResponse(init), tracked.response);
    } else {
      stubOAuthFetch(tracked.response);
    }
    const error = await loginMiniMax().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toEqual(message);
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
  });

  it.each([
    ["global", "https://account.minimax.io", globalApi],
    ["cn", "https://account.minimaxi.com", cnApi],
  ] as const)("records %s OAuth credentials and config", async (region, host, baseUrl) => {
    const assertCurrent = vi.fn();
    const deviceCode = vi.fn(async () => {});
    const fetchMock = stubOAuthFetch(
      (_input, init) => {
        expect(assertCurrent).toHaveBeenCalled();
        return authResponse(init);
      },
      () => {
        expect(deviceCode).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ code: "CODE", expiresInMinutes: 1 }),
        );
        return tokenResponse();
      },
    );
    const { portalProvider } = await registeredProviders();
    const method = portalProvider.auth.find(
      ({ id }) => id === (region === "cn" ? "oauth-cn" : "oauth"),
    );
    if (!method) {
      throw new Error("missing regional OAuth method");
    }
    const result = await method.run({
      prompter: {
        deviceCode,
        progress: () => ({ update: vi.fn(), stop: vi.fn() }),
        note: vi.fn(async () => undefined),
      },
      openUrl: vi.fn(async () => undefined),
      assertCurrent,
    } as never);
    const expected = { baseUrl, api: "anthropic-messages", authHeader: true, models: [] };
    expect(result.configPatch?.models?.providers?.["minimax-portal"]).toEqual(expected);
    expect(result.profiles[0]?.credential).toMatchObject({
      type: "oauth",
      provider: "minimax-portal",
      authFlow: "device-code",
      tokenEndpoint: host + "/oauth2/token",
    });
    expect(
      fetchMock.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input))),
    ).toEqual([host + "/oauth2/device/code", host + "/oauth2/token"]);
  });

  it("rejects Date-invalid authorization expiries before formatting instructions", async () => {
    stubOAuthFetch((_input, init) => authResponse(init, { expired_in: 8_700_000_000_000_000 }));
    const note = vi.fn(async () => undefined);

    await expect(loginMiniMax({ note })).rejects.toThrow("invalid expired_in");
    expect(note).not.toHaveBeenCalled();
  });

  it.each([
    ["caps oversized poll intervals", MAX_TIMER_TIMEOUT_MS + 10_000, MAX_TIMER_TIMEOUT_MS, true],
    ["does not sleep past authorization expiry", 10_000, 10_000, false],
  ] as const)("%s before scheduling", async (_name, expiresIn, delay, succeeds) => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    stubOAuthFetch(
      (_input, init) =>
        authResponse(init, {
          expired_in: Date.now() + expiresIn,
          interval: Number.MAX_SAFE_INTEGER,
        }),
      Response.json({ status: "pending" }),
      ...(succeeds ? [tokenResponse()] : []),
    );

    const result = loginMiniMax();

    await vi.waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), delay);
    });

    const outcome = succeeds
      ? expect(result).resolves.toMatchObject({ access: "access", refresh: "refresh" })
      : expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(delay);
    await outcome;
  });
});
