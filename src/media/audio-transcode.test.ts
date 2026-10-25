import syncFs, { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";

const runFfmpegMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("./ffmpeg-exec.js", () => ({
  runFfmpeg: runFfmpegMock,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

let transcodeAudioBuffer: typeof import("./audio-transcode.js").transcodeAudioBuffer;
let transcodeAudioBufferToOpus: typeof import("./audio-transcode.js").transcodeAudioBufferToOpus;

beforeAll(async () => {
  vi.resetModules();
  ({ transcodeAudioBuffer, transcodeAudioBufferToOpus } = await import("./audio-transcode.js"));
});

afterAll(() => {
  vi.doUnmock("./ffmpeg-exec.js");
  vi.resetModules();
});

describe("transcodeAudioBufferToOpus", () => {
  afterEach(() => {
    runFfmpegMock.mockReset();
  });

  type OpusOptions = Omit<Parameters<typeof transcodeAudioBufferToOpus>[0], "audioBuffer">;
  it.each<{ name: string; options: OpusOptions; input: string; output: string }>([
    {
      name: "48k mono defaults",
      options: { inputExtension: "mp3", tempPrefix: "tts-test-", timeoutMs: 1234 },
      input: "input.mp3",
      output: "voice.opus",
    },
    {
      name: "unsafe input extension",
      options: { inputExtension: "../bad" },
      input: "input.audio",
      output: "voice.opus",
    },
    {
      name: "duration limit",
      options: { maxDurationSeconds: 300 },
      input: "input.audio",
      output: "voice.opus",
    },
    ...(
      [
        ["../escape.opus", "escape.opus"],
        [String.raw`C:\Users\Ada\Downloads\reply.opus`, "reply.opus"],
      ] as const
    ).map(([outputFileName, output]) => ({
      name: `output leaf ${outputFileName}`,
      options: { inputFileName: "voice.wav", outputFileName, tempPrefix: "../bad-prefix" },
      input: "input.wav",
      output,
    })),
  ])("stages, transcodes and cleans up: $name", async ({ options, input, output }) => {
    using sync = vi.spyOn(syncFs, "fsyncSync");
    let inputPath = "";
    let outputPath = "";
    runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
      inputPath = args[args.indexOf("-i") + 1];
      outputPath = args.at(-1) ?? "";
      expect(path.basename(inputPath)).toBe(input);
      expect(path.basename(outputPath)).toContain(output);
      expect(path.basename(outputPath)).toMatch(/\.part$/);
      await expect(readFile(inputPath)).resolves.toEqual(Buffer.from("source-mp3"));
      await writeFile(outputPath, Buffer.from("opus-output"));
    });
    await expect(
      transcodeAudioBufferToOpus({ audioBuffer: Buffer.from("source-mp3"), ...options }),
    ).resolves.toEqual(Buffer.from("opus-output"));
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    expect(mockCall(runFfmpegMock)).toStrictEqual([
      [
        ..."-hide_banner -loglevel error -y -i".split(" "),
        inputPath,
        ..."-vn -sn -dn".split(" "),
        ...(options.maxDurationSeconds === undefined
          ? []
          : ["-t", String(options.maxDurationSeconds)]),
        ..."-c:a libopus -b:a 64k -ar 48000 -ac 1 -f opus".split(" "),
        outputPath,
      ],
      { timeoutMs: options.timeoutMs },
    ]);
    const tempRoot = realpathSync(resolvePreferredOpenClawTmpDir());
    const prefix = options.tempPrefix === "tts-test-" ? options.tempPrefix : "";
    expect(inputPath.startsWith(path.join(tempRoot, prefix))).toBe(true);
    expect([existsSync(inputPath), existsSync(outputPath)]).toEqual([false, false]);
    expect(sync).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maximum duration %s before ffmpeg",
    async (maxDurationSeconds) => {
      await expect(
        transcodeAudioBufferToOpus({ audioBuffer: Buffer.from("source"), maxDurationSeconds }),
      ).rejects.toThrow("maxDurationSeconds must be a positive finite number");
      expect(runFfmpegMock).not.toHaveBeenCalled();
    },
  );
});

describe("transcodeAudioBuffer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runCommandWithTimeoutMock.mockReset();
    runFfmpegMock.mockReset();
  });

  it("returns a failure and cleans its workspace when input staging fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    let workspaceDir: string | undefined;
    const lstat = syncFs.lstatSync;
    vi.spyOn(syncFs, "lstatSync").mockImplementation((...args) => {
      const [filePath] = args;
      if (typeof filePath === "string" && path.basename(filePath) === "in.mp3") {
        workspaceDir = path.dirname(filePath);
        throw Object.assign(new Error("input exceeds bounded staging limit"), { code: "EFBIG" });
      }
      return lstat(...args);
    });

    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: "caf",
    });

    expect(result).toEqual({
      ok: false,
      reason: "transcoder-failed",
      detail: "input exceeds bounded staging limit",
    });
    expect(workspaceDir).toBeDefined();
    expect(workspaceDir ? existsSync(workspaceDir) : true).toBe(false);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it.each([
    ["mp3", ".mp3", "noop-same-container"],
    ["mp3", "flac", "no-recipe"],
    ["", "caf", "invalid-extension"],
    ["mp3", "", "invalid-extension"],
    ["../etc/passwd", "caf", "invalid-extension"],
  ])("converting %j to %j returns %s", async (sourceExtension, targetExtension, reason) => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension,
      targetExtension,
    });
    expect(result).toEqual({ ok: false, reason });
  });

  it("returns platform-unsupported off-Darwin without invoking afconvert", async () => {
    if (process.platform === "darwin") {
      return;
    }
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: "caf",
    });
    expect(result).toEqual({ ok: false, reason: "platform-unsupported" });
  });
});
