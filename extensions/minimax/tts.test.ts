import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { promisify } from "node:util";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
} from "openclaw/plugin-sdk/provider-auth";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

const guardedFetch = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetch,
}));

import { buildMinimaxMusicGenerationProvider } from "./music-generation-provider.js";
import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";
const speech = buildMinimaxSpeechProvider({
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
});

async function tts(overrides: Partial<Parameters<typeof speech.synthesize>[0]> = {}) {
  const result = await speech.synthesize({
    text: "hello",
    cfg: {},
    providerConfig: { apiKey: "sk-test" },
    target: "audio-file",
    timeoutMs: 10_000,
    ...overrides,
  });
  return result.audioBuffer;
}

function mockTtsResponse(body: unknown) {
  guardedFetch.mockResolvedValue({
    response: Response.json(body),
    release: vi.fn(async () => undefined),
  });
}

afterEach(() => {
  guardedFetch.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("forwards the capped request timeout to the guarded transport", async () => {
  mockTtsResponse({ data: { audio: Buffer.from("audio").toString("hex") } });
  await expect(tts({ timeoutMs: Number.MAX_SAFE_INTEGER })).resolves.toEqual(Buffer.from("audio"));
  expect(guardedFetch.mock.calls[0]?.[0]).toMatchObject({
    timeoutMs: MAX_TIMER_TIMEOUT_MS,
  });
});

it("throws on base_resp envelope error even when data.audio is present (regression #76904)", async () => {
  mockTtsResponse({
    data: { audio: Buffer.from("placeholder").toString("hex") },
    base_resp: { status_code: 1002, status_msg: "Quota exceeded" },
  });
  await expect(tts()).rejects.toThrow("MiniMax TTS API error (1002): Quota exceeded");
});

it.each([
  ["success", '{"data":{"audio":"706f6e67"}}', undefined],
  ["http-error", "Unauthorized", "MiniMax TTS API error (401): Unauthorized"],
  ["stalled-headers", "", undefined],
  ["stalled-body", '{"data":{"audio":"', undefined],
  ["null envelope", "null", "minimax.tts: malformed JSON response"],
  ["numeric audio", '{"data":{"audio":42}}', "MiniMax TTS API returned no audio data"],
  [
    "nonstring error message",
    JSON.stringify({
      data: { audio: "706c616365686f6c646572" },
      base_resp: { status_code: 1002, status_msg: {} },
    }),
    "MiniMax TTS API error (1002): unknown error",
  ],
  [
    "odd hex audio",
    JSON.stringify(successBody({ audio: "666f6" })),
    "MiniMax TTS API returned malformed hex audio",
  ],
] as const)(
  "settles guarded speech transport and releases its socket (%s)",
  async (mode, body, errorMessage) => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    const ready = Promise.withResolvers<number>();
    const released = Promise.withResolvers<void>();
    const didRelease = vi.fn();
    const closed = Promise.withResolvers<void>();
    const sockets = new Set<Socket>();
    const requests: string[] = [];
    let receivedResponse: ServerResponse | undefined;
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      request.resume();
      request.socket.once("close", () => closed.resolve());
      receivedResponse = response;
      if (mode === "stalled-headers") {
        ready.resolve(0);
        return;
      }
      response.writeHead(mode === "http-error" ? 401 : 200, {
        "content-type": "application/json",
      });
      if (mode === "stalled-body") {
        response.write(body);
      } else {
        response.end(body);
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    let pending: Promise<unknown> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(claim.port, "127.0.0.1", resolve);
      });
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
        "openclaw/plugin-sdk/ssrf-runtime",
      );
      guardedFetch.mockImplementation(async (params) => {
        const result = await actual.fetchWithSsrFGuard(params);
        ready.resolve(result.response.status);
        return {
          ...result,
          release: async () => {
            await result.release();
            didRelease();
            released.resolve();
          },
        };
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const outcome = tts({
        providerConfig: { apiKey: "fixture-key", baseUrl: `http://127.0.0.1:${claim.port}` },
        timeoutMs: 1_000,
      }).then(
        (audio) => ({ ok: true as const, audio }),
        (error: unknown) => {
          ready.reject(error);
          return { ok: false as const, error };
        },
      );
      pending = outcome;
      const status = await ready.promise;
      if (mode.startsWith("stalled")) {
        expect(status).toBe(mode === "stalled-body" ? 200 : 0);
        const settled = vi.fn();
        void outcome.then(settled);
        await vi.advanceTimersByTimeAsync(999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toMatchObject({ ok: false, error: expect.any(Error) });
        expect(receivedResponse?.writableEnded).toBe(false);
      } else if (errorMessage) {
        const failure = await outcome;
        expect(failure).toMatchObject({ ok: false, error: expect.any(Error) });
        expect(failure).toHaveProperty("error.message", errorMessage);
      } else {
        expect(await outcome).toEqual({ ok: true, audio: Buffer.from("pong") });
      }
      if (mode !== "stalled-headers") {
        await released.promise;
        expect(didRelease).toHaveBeenCalledOnce();
      }
      await closed.promise;
      expect(requests).toEqual(["/v1/t2a_v2"]);
    } finally {
      vi.useRealTimers();
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            for (const socket of sockets) {
              socket.destroy();
            }
          });
        }
        await pending;
      } finally {
        await claim.release();
      }
    }
  },
);

type WireFixture = {
  provider?: "minimax" | "minimax-portal";
  frames?: Array<{ status?: number | string; audio?: string } | "[DONE]">;
  mediaMaxMb?: number;
};

async function runFixture(fixture: WireFixture) {
  const originalFetch = globalThis.fetch;
  const body =
    fixture.frames
      ?.map((frame) =>
        frame === "[DONE]" ? "data: [DONE]" : `data: ${JSON.stringify(successBody(frame))}`,
      )
      .join("\n\n") + "\n\n";
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(body);
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("MINIMAX_API_KEY", "sk-test");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const { dispatcher: _dispatcher, ...forwardedInit } = (init ?? {}) as RequestInit & {
      dispatcher?: unknown;
    };
    return originalFetch(`http://127.0.0.1:${port}`, forwardedInit);
  });
  guardedFetch.mockImplementation(async ({ url, init }) => ({
    response: await fetch(url, init),
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
  async (provider, done) => {
    const frames: WireFixture["frames"] = [
      { status: 1, audio: Buffer.from("partial-audio").toString("hex") },
      ...(done ? (["[DONE]"] as const) : []),
    ];
    await expect(runFixture({ provider, frames })).rejects.toThrow(
      "MiniMax music generation stream ended without completion",
    );
  },
);

it.each([
  ["2", "complete-audio", undefined],
  [2, "oversized", 0.000_001],
] as const)(
  "validates terminal status %s for %s (music limit: %s)",
  async (status, text, mediaMaxMb) => {
    const audio = Buffer.from(text);
    const result = runFixture({
      frames: [{ status, audio: audio.toString("hex") }],
      mediaMaxMb,
    });
    if (mediaMaxMb === undefined) {
      await expect(result).resolves.toEqual(audio);
    } else {
      await expect(result).rejects.toThrow("MiniMax generated music download exceeds 1 bytes");
    }
  },
);
