import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
} from "openclaw/plugin-sdk/provider-auth";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";

const transcode = vi.hoisted(() => vi.fn());
const guardedFetch = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetch,
}));

// mock-isolation: Capture speech transcoding without invoking ffmpeg.
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcode,
}));

import { buildMinimaxMusicGenerationProvider } from "./music-generation-provider.js";
import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";

function seedMinimaxPortalProfile(agentDir: string) {
  const credential = { type: "token" as const, provider: "minimax-portal", token: "portal-token" };
  saveAuthProfileStore({ version: 1, profiles: { "minimax-portal:test": credential } }, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

const provider = buildMinimaxSpeechProvider({
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
});

function synthesize(overrides: Partial<Parameters<typeof provider.synthesize>[0]> = {}) {
  return provider.synthesize({
    text: "Test",
    cfg: {},
    providerConfig: { apiKey: "sk-test" },
    target: "audio-file",
    timeoutMs: 30000,
    ...overrides,
  });
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  guardedFetch.mockImplementation(actual.fetchWithSsrFGuard);
});
afterEach(() => {
  guardedFetch.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const { resolveConfig, parseDirectiveToken } = provider;
if (!resolveConfig || !parseDirectiveToken) {
  throw new Error("MiniMax speech provider must expose config and directive hooks");
}
const resolveProviderConfig = (rawConfig: Record<string, unknown>) =>
  resolveConfig({ rawConfig, cfg: {}, timeoutMs: 30000 });
const voice = "Chinese (Mandarin)_Warm_Girl";
const model = "speech-01-turbo";
const portalConfig = {
  models: {
    providers: { "minimax-portal": { baseUrl: "https://api.minimaxi.com/anthropic", models: [] } },
  },
};

it("keeps the configured TTS endpoint", () => {
  const baseUrl = "https://custom.api.com";
  expect(resolveProviderConfig({ providers: { minimax: { baseUrl } } }).baseUrl).toBe(baseUrl);
});

it("keeps trusted MINIMAX_API_HOST fallback for TTS baseUrl", () => {
  vi.stubEnv("MINIMAX_API_HOST", "https://api.minimax.io/anthropic");
  vi.stubEnv("MINIMAX_TTS_MODEL", model);
  vi.stubEnv("MINIMAX_TTS_VOICE_ID", "Chinese (Mandarin)_Gentle_Boy");
  expect(resolveProviderConfig({})).toMatchObject({
    baseUrl: "https://api.minimax.io",
    model,
    voiceId: "Chinese (Mandarin)_Gentle_Boy",
  });
});
const policy = createSpeechDirectivePolicy();

it.each([
  ["voice", voice, {}, { handled: true, overrides: { voiceId: voice } }],
  ["model", model, {}, { handled: true, overrides: { model } }],
  ["speed", "1.5", {}, { handled: true, overrides: { speed: 1.5 } }],
  ["vol", "10", {}, { handled: true, overrides: { vol: 10 } }],
  ["pitch", "-3", {}, { handled: true, overrides: { pitch: -3 } }],
  ["speed", "5.0", {}, { handled: true, warnings: [expect.any(String)] }],
  ["unknown_key", "whatever", {}, { handled: false }],
  ["voice", "test", { allowVoice: false }, { handled: true }],
  ["model", "test", { allowModelId: false }, { handled: true }],
] as const)("parses %s=%s under policy %j", (key, value, flags, expected) => {
  expect(parseDirectiveToken({ key, value, policy: { ...policy, ...flags } })).toEqual(expected);
});
describe("MiniMax auth and synthesis", () => {
  let stateDir: string;
  let agentDir: string;
  const fetchMock = vi.fn<typeof fetch>();
  function mockAudioResponse(audio = "audio") {
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { audio: Buffer.from(audio).toString("hex") } }),
    );
  }
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-minimax-tts-"));
    agentDir = path.join(stateDir, "agents", "main", "agent");
    await mkdir(agentDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    vi.stubEnv("MINIMAX_API_KEY", undefined);
    vi.stubEnv("MINIMAX_OAUTH_TOKEN", undefined);
    vi.stubEnv("MINIMAX_CODE_PLAN_KEY", undefined);
    vi.stubEnv("MINIMAX_CODING_API_KEY", undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    transcode.mockReset();
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    await rm(stateDir, { recursive: true, force: true });
  });

  it.each([false, true])("reports portal configured=%s", async (available) => {
    if (available) {
      seedMinimaxPortalProfile(agentDir);
    }
    await expect(
      provider.isConfiguredAsync?.({ providerConfig: {}, timeoutMs: 30000 }),
    ).resolves.toBe(available);
  });

  const firstFetchInit = () => fetchMock.mock.calls[0]?.[1];

  const firstFetchBody = (): unknown => JSON.parse(String(firstFetchInit()?.body));

  it("transcodes MiniMax MP3 to Opus for voice-note targets", async () => {
    mockAudioResponse("fake-mp3-data");
    transcode.mockResolvedValueOnce(Buffer.from("fake-opus-data"));

    const result = await synthesize({
      providerConfig: { apiKey: "sk-test", baseUrl: "https://api.minimaxi.com" },
      target: "voice-note",
    });

    expect(result).toMatchObject({
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
      audioBuffer: Buffer.from("fake-opus-data"),
    });
    expect(transcode).toHaveBeenCalledWith(
      expect.objectContaining({
        audioBuffer: Buffer.from("fake-mp3-data"),
        inputExtension: "mp3",
        timeoutMs: 30000,
      }),
    );
  });

  it.each([
    [
      "providerOverrides",
      { model, voiceId: "custom_voice", speed: 1.5, vol: 1.5, pitch: 0.5 },
      {
        model,
        voice_setting: { voice_id: "custom_voice", speed: 1.5, vol: 1.5, pitch: 0 },
      },
    ],
    [
      "providerConfig",
      { apiKey: "sk-test", speed: 3, vol: -1, pitch: 20 },
      { voice_setting: { speed: 1, vol: 1, pitch: 0 } },
    ],
  ] as const)("normalizes %s synthesis settings", async (field, settings, expected) => {
    mockAudioResponse();
    await synthesize(
      field === "providerOverrides"
        ? { providerOverrides: settings }
        : { providerConfig: settings },
    );
    expect(firstFetchBody()).toMatchObject(expected);
  });

  it.each([false, true])("uses portal profile=%s ahead of environment fallback", async (portal) => {
    vi.stubEnv(
      portal ? "MINIMAX_API_KEY" : "MINIMAX_CODING_API_KEY",
      portal ? "sk-env" : "sk-cp-env",
    );
    if (portal) {
      seedMinimaxPortalProfile(agentDir);
    }
    mockAudioResponse();
    await synthesize({ cfg: portal ? portalConfig : {}, providerConfig: {} });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      portal ? "https://api.minimaxi.com/v1/t2a_v2" : "https://api.minimax.io/v1/t2a_v2",
    );
    expect(firstFetchInit()?.headers).toEqual({
      Authorization: portal ? "Bearer portal-token" : "Bearer sk-cp-env",
      "Content-Type": "application/json",
    });
  });

  it("does not send a request for a blank environment API key", async () => {
    process.env.MINIMAX_API_KEY = "   ";

    await expect(synthesize({ providerConfig: {} })).rejects.toThrow("MiniMax TTS auth missing");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

it.each([
  ["success", '{"data":{"audio":"706f6e67"}}', undefined],
  ["http-error", "Unauthorized", "MiniMax TTS API error (401): Unauthorized"],
  [
    "envelope error #76904",
    '{"data":{"audio":"aa"},"base_resp":{"status_code":1002,"status_msg":"Quota exceeded"}}',
    "MiniMax TTS API error (1002): Quota exceeded",
  ],
  ["stalled-headers", "", undefined],
  ["stalled-body", '{"data":{"audio":"', undefined],
  ["null envelope", "null", "minimax.tts: malformed JSON response"],
  ["numeric audio", '{"data":{"audio":42}}', "MiniMax TTS API returned no audio data"],
  [
    "nonstring error message",
    '{"data":{"audio":"aa"},"base_resp":{"status_code":1002,"status_msg":{}}}',
    "MiniMax TTS API error (1002): unknown error",
  ],
  ["odd hex audio", '{"data":{"audio":"aaa"}}', "MiniMax TTS API returned malformed hex audio"],
] as const)("settles speech HTTP and its socket (%s)", async (mode, body, errorMessage) => {
  const received = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const requests: string[] = [];
  const handler: RequestListener = (request, response) => {
    requests.push(request.url ?? "");
    request.resume();
    request.socket.once("close", () => closed.resolve());
    if (mode !== "stalled-headers") {
      response.writeHead(mode === "http-error" ? 401 : 200, {
        "content-type": "application/json",
      });
      if (mode === "stalled-body") {
        response.write(body);
      } else {
        response.end(body);
      }
    }
    received.resolve();
  };
  await withServer(handler, async (baseUrl) => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = synthesize({
      providerConfig: { apiKey: "fixture-key", baseUrl },
      timeoutMs: mode === "success" ? Number.MAX_SAFE_INTEGER : 1_000,
    });
    void outcome.catch((error: unknown) => received.reject(error));
    try {
      await received.promise;
      // For the body deadline, wait until the real guarded request has received headers.
      if (mode !== "stalled-headers") {
        await guardedFetch.mock.results[0]?.value;
      }
      if (mode.startsWith("stalled")) {
        const settled = vi.fn();
        void outcome.then(settled, settled);
        await vi.advanceTimersByTimeAsync(999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(outcome).rejects.toBeInstanceOf(Error);
      } else if (errorMessage) {
        await expect(outcome).rejects.toThrow(errorMessage);
      } else {
        expect(guardedFetch.mock.calls[0]?.[0]).toMatchObject({
          timeoutMs: MAX_TIMER_TIMEOUT_MS,
        });
        await expect(outcome).resolves.toHaveProperty("audioBuffer", Buffer.from("pong"));
      }
      await closed.promise;
      expect(requests).toEqual(["/v1/t2a_v2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

type WireFixture = {
  provider?: "minimax" | "minimax-portal";
  frames: Array<{ status?: number | string; audio?: string } | "[DONE]">;
  mediaMaxMb?: number;
};

async function runFixture(fixture: WireFixture) {
  const body =
    fixture.frames
      .map((frame) =>
        frame === "[DONE]" ? "data: [DONE]" : `data: ${JSON.stringify(successBody(frame))}`,
      )
      .join("\n\n") + "\n\n";
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(body);
  });
  const port = await listenOnLoopback(server);
  vi.stubEnv("MINIMAX_API_KEY", "sk-test");
  guardedFetch.mockImplementation(async ({ init }) => ({
    response: await fetch(`http://127.0.0.1:${port}`, init),
    release: vi.fn(async () => {}),
  }));

  try {
    const providerId = fixture.provider ?? "minimax";
    const result = await buildMinimaxMusicGenerationProvider(providerId).generateMusic({
      provider: providerId,
      model: "music-2.6",
      prompt: "loopback fixture",
      cfg: { agents: { defaults: { mediaMaxMb: fixture.mediaMaxMb } } },
    });
    return result.tracks[0]?.buffer;
  } finally {
    await promisify(server.close.bind(server))();
  }
}

function successBody(data: unknown) {
  return { data, base_resp: { status_code: 0, status_msg: "success" } };
}

it.each([
  ["minimax", false],
  ["minimax-portal", true],
] as const)(
  "rejects incomplete %s music after its HTTP stream closes (DONE: %s)",
  async (providerId, done) => {
    const chunk = { status: 1, audio: "6162" };
    const frames: WireFixture["frames"] = done ? [chunk, "[DONE]"] : [chunk];
    await expect(runFixture({ provider: providerId, frames })).rejects.toThrow(
      "MiniMax music generation stream ended without completion",
    );
  },
);

it.each([
  ["2", undefined],
  [2, 0.000_001],
] as const)("validates terminal status %s (music limit: %s)", async (status, mediaMaxMb) => {
  const result = runFixture({ frames: [{ status, audio: "6162" }], mediaMaxMb });
  if (mediaMaxMb === undefined) {
    await expect(result).resolves.toEqual(Buffer.from("ab"));
  } else {
    await expect(result).rejects.toThrow("MiniMax generated music download exceeds 1 bytes");
  }
});
