import type { MusicGenerationRequest } from "openclaw/plugin-sdk/music-generation";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../test-support/streaming-error-response.js";
import {
  expectAllowPrivateNetworkPolicy,
  expectMinimaxGuardedFetchCall,
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxVideoGenerationProviderModule,
  loadMinimaxMusicGenerationProviderModule,
  mockCallArg,
} from "./provider-http.test-helpers.js";

const {
  resolveApiKeyForProviderMock: auth,
  postJsonRequestMock: post,
  fetchWithTimeoutMock: download,
  fetchWithTimeoutGuardedMock: guarded,
} = getMinimaxProviderHttpMocks();

let buildMinimaxVideoGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxVideoGenerationProviderModule>
>["buildMinimaxVideoGenerationProvider"];
let buildMinimaxMusicGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxMusicGenerationProviderModule>
>["buildMinimaxMusicGenerationProvider"];
beforeAll(async () => {
  ({ buildMinimaxVideoGenerationProvider } = await loadMinimaxVideoGenerationProviderModule());
  ({ buildMinimaxMusicGenerationProvider } = await loadMinimaxMusicGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

const requestOverrides = {
  allowPrivateNetwork: true,
  headers: { "X-MiniMax-Video-Policy": "enabled" },
};

function videoConfig(provider = "minimax", baseUrl = "https://api.minimax.io") {
  return mediaConfig(provider, baseUrl, requestOverrides);
}

function mockDownload(mimeType = "video/mp4", bytes = "mp4-bytes") {
  download.mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": mimeType } }));
}

function expectPolicyFetch(index: number, url: string) {
  const call = expectMinimaxGuardedFetchCall(index, url);
  expect((call.init.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
  expectAllowPrivateNetworkPolicy(call.options);
}

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  return buildMinimaxVideoGenerationProvider(overrides.provider).generateVideo({
    provider: "minimax",
    model: "MiniMax-Hailuo-2.3",
    prompt: "A fox",
    cfg: {},
    ...overrides,
  });
}

const videoUrl = "https://example.com/out.mp4";
const taskId = "task-123";
function mockVideoTask(completed: Record<string, unknown>): void {
  mockJson({ task_id: taskId });
  download.mockResolvedValueOnce(
    Response.json({
      status: "Success",
      ...completed,
    }),
  );
}

it.each([generateVideo, generateMusic])(
  "rejects invalid media origins before I/O",
  async (generate) => {
    const provider = "minimax-portal";
    await expect(
      generate({ provider, cfg: mediaConfig(provider, "https://[") }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(auth).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  },
);

describe("minimax video generation provider", () => {
  it("rejects a duration that rounds to zero before submission", async () => {
    await expect(generateVideo({ durationSeconds: 0.4 })).rejects.toThrow(
      "durationSeconds must be a positive duration",
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("preserves options without inherited model constraints", async () => {
    const model = "__proto__";
    mockVideoTask({ video_url: videoUrl });
    mockDownload("video/mp4", "synthetic-video");
    await generateVideo({ model, durationSeconds: 5, resolution: "720P" });
    expect(mockCallArg(post).body).toMatchObject({ model, duration: 5, resolution: "720P" });
  });

  it("downloads via file_id with a missing filename when status omits video_url", async () => {
    mockVideoTask({ file_id: "file-9" });
    download.mockResolvedValueOnce(
      Response.json({
        file: { file_id: "file-9", download_url: videoUrl },
        base_resp: { status_code: 0 },
      }),
    );
    mockDownload("video/webm", "webm-bytes");

    const result = await generateVideo({ cfg: videoConfig() });

    expectPolicyFetch(0, `https://api.minimax.io/v1/query/video_generation?task_id=${taskId}`);
    expectPolicyFetch(1, "https://api.minimax.io/v1/files/retrieve?file_id=file-9");
    expectAllowPrivateNetworkPolicy(expectMinimaxGuardedFetchCall(2, videoUrl).options);
    expect(result).toMatchObject({
      videos: [
        { buffer: Buffer.from("webm-bytes"), mimeType: "video/webm", fileName: "video-1.webm" },
      ],
      metadata: { taskId, fileId: "file-9" },
    });
    expect(result.videos).toHaveLength(1);
    expect(result.metadata?.videoUrl).toBeUndefined();
  });

  it("rejects oversized file_id metadata JSON before downloading", async () => {
    mockVideoTask({ file_id: "file-too-large" });
    download.mockResolvedValueOnce(
      createStreamingResponse({
        chunkCount: Infinity,
        chunkSize: 1024 * 1024,
      }).response,
    );

    await expect(generateVideo()).rejects.toThrow(
      "MiniMax generated video metadata: JSON response exceeds 16777216 bytes",
    );

    expectMinimaxGuardedFetchCall(
      1,
      "https://api.minimax.io/v1/files/retrieve?file_id=file-too-large",
    );
    expect(download).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["minimax-portal", "https://api.minimaxi.com", false],
    ["minimax", "https://api.minimax.io", true],
  ] as const)("generates %s video at %s (retry %s)", async (provider, origin, retry) => {
    if (retry) {
      download.mockRejectedValueOnce(new Error("request timeout"));
    }
    mockVideoTask({ video_url: videoUrl, file_id: "file-1" });
    mockDownload("video/webm", "webm-bytes");
    const result = await generateVideo({
      provider,
      durationSeconds: 5,
      resolution: "720P",
      cfg: {
        models: {
          providers: {
            minimax: { baseUrl: "https://wrong.example/anthropic", models: [] },
            ...videoConfig(provider, origin + "/anthropic").models.providers,
          },
        },
      },
    });
    expect(mockCallArg(auth).provider).toBe(provider);
    const request = mockCallArg(post);
    expect(request).toMatchObject({
      allowPrivateNetwork: true,
      url: origin + "/v1/video_generation",
      body: { duration: 6, resolution: "768P" },
    });
    expect((request.headers as Headers).get("x-minimax-video-policy")).toBe("enabled");
    for (let attempt = 0; attempt <= Number(retry); attempt++) {
      expectPolicyFetch(attempt, origin + "/v1/query/video_generation?task_id=" + taskId);
    }
    expectAllowPrivateNetworkPolicy(
      expectMinimaxGuardedFetchCall(Number(retry) + 1, videoUrl).options,
    );
    expect(result.videos).toHaveLength(1);
  });
});

function generateMusic(overrides: Partial<MusicGenerationRequest> = {}) {
  return buildMinimaxMusicGenerationProvider(overrides.provider).generateMusic({
    provider: "minimax",
    model: "music-2.6",
    prompt: "dance-pop",
    cfg: {},
    ...overrides,
  });
}

function mediaConfig(
  provider: string,
  baseUrl: string,
  request?: { allowPrivateNetwork: boolean; headers: Record<string, string> },
) {
  return { models: { providers: { [provider]: { baseUrl, models: [], request } } } };
}

function mockResponse(body: BodyInit, contentType = "text/event-stream"): void {
  post.mockResolvedValue({
    response: new Response(body, { headers: { "content-type": contentType } }),
    release: vi.fn(async () => {}),
  });
}

function mockJson(json: Record<string, unknown>): void {
  mockResponse(JSON.stringify({ base_resp: { status_code: 0 }, ...json }), "application/json");
}

function streamFrame(data: Record<string, unknown>, status_code = 0, status_msg?: string) {
  return `data: ${JSON.stringify({ data, base_resp: { status_code, status_msg } })}\n\n`;
}

describe("minimax music generation provider", () => {
  it("streams generated music chunks from MiniMax", async () => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_700_000_000_000);
    const chunkA = Buffer.from("ID3\x04\x00mp3-a");
    const chunkB = Buffer.from("mp3-b");
    mockResponse(
      streamFrame({ status: 1, audio: chunkA.toString("hex") }) +
        streamFrame({ status: 1, audio: chunkB.toString("hex") }) +
        streamFrame({ status: 2, audio: Buffer.concat([chunkA, chunkB]).toString("hex") }),
    );
    const result = await generateMusic({
      model: "",
      lyrics: "our city wakes",
      durationSeconds: 45,
      cfg: mediaConfig("minimax", "   "),
    });
    const request = mockCallArg(post);
    expect(request.url).toBe("https://api.minimax.io/v1/music_generation");
    expect(request.body).toMatchObject({
      model: "music-2.6",
      lyrics: "our city wakes",
      stream: true,
      output_format: "hex",
    });
    expect(request.timeoutMs).toBe(300000);
    expect((request.headers as Headers).get("content-type")).toBe("application/json");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.buffer).toEqual(Buffer.concat([chunkA, chunkB]));
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.metadata?.requestedLyrics).toBe(true);
    expect(result.metadata).not.toHaveProperty("requestedDurationSeconds");
  });

  it("cancels invalid music responses before releasing their guarded dispatcher", async () => {
    const tracked = cancelTrackedTextResponse('{"error":"still streaming"}', {
      headers: { "content-type": "application/json" },
    });
    let canceledAtRelease = false;
    const release = vi.fn(async () => {
      canceledAtRelease = tracked.wasCanceled();
    });
    const audioUrl = "https://example.com/invalid-open.mp3";
    mockJson({ data: { audio_url: audioUrl } });
    guarded.mockResolvedValueOnce({
      response: tracked.response,
      finalUrl: audioUrl,
      release,
    });

    await expect(generateMusic()).rejects.toThrow(
      "MiniMax generated music download: malformed audio response",
    );
    expect(canceledAtRelease).toBe(true);
  });

  it.each([
    [
      streamFrame({ status: 1, audio: "ZE==" }),
      "MiniMax music generation returned malformed hex audio",
    ],
    [
      streamFrame({}) + streamFrame({}, 2013, "render rejected"),
      "MiniMax music generation failed (2013): render rejected",
    ],
  ])("rejects invalid music stream %s", async (body, message) => {
    mockResponse(body);
    await expect(generateMusic()).rejects.toThrow(message);
  });

  it("rejects oversized inline music before decoding", async () => {
    mockJson({ data: { audio: Buffer.from("too-large").toString("hex") } });
    await expect(
      generateMusic({ cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } }),
    ).rejects.toThrow("MiniMax generated music download exceeds 1 bytes");
  });

  it.each([false, true])("downloads music URL output (portal: %s)", async (portal) => {
    const url = "https://example.com/track.mp3";
    const policy = { allowPrivateNetwork: true, headers: { "X-MiniMax-Music-Policy": "enabled" } };
    mockJson(
      portal
        ? { task_id: "task", audio_url: url }
        : {
            task_id: " task ",
            lyrics: "our city wakes",
            data: { audio: " " + url + " " },
          },
    );
    mockDownload("audio/mpeg", "mp3-bytes");
    const result = await generateMusic({
      provider: portal ? "minimax-portal" : "minimax",
      cfg: portal ? mediaConfig("minimax-portal", "https://api.minimaxi.com", policy) : {},
      lyrics: "our city wakes",
    });
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("mp3-bytes"));
    expect(result.metadata).toMatchObject({ taskId: "task", audioUrl: url });
    if (portal) {
      expectAllowPrivateNetworkPolicy(expectMinimaxGuardedFetchCall(0, url).options);
    } else {
      expect(download.mock.calls[0]?.[2]).toBeGreaterThan(119_000);
      expect(download.mock.calls[0]?.[2]).toBeLessThanOrEqual(120_000);
      expect(result.lyrics).toEqual(["our city wakes"]);
    }
  });

  it("applies explicit caller timeouts while reading streaming response bodies", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      mockResponse(stream);
      const generation = generateMusic({ timeoutMs: 50 });
      const expectation = expect(generation).rejects.toThrow(
        "MiniMax music generation timed out after 50ms",
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await expectation;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects instrumental requests that also include lyrics", async () => {
    await expect(
      generateMusic({ prompt: "driving techno", instrumental: true, lyrics: "do not sing this" }),
    ).rejects.toThrow("cannot use lyrics when instrumental=true");
  });
});
