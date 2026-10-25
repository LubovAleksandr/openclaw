import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createDirectTextMediaOutbound,
  createScopedChannelMediaMaxBytesResolver,
} from "../outbound/direct-text-media.js";
import {
  installChannelOutboundPayloadContractSuite,
  type OutboundPayloadHarnessParams,
} from "./outbound-payload-testkit.js";
import { primeChannelOutboundSendMock } from "./test-helpers.js";

function createDirectTextMediaHarness(params: OutboundPayloadHarnessParams) {
  const sendFn = vi.fn();
  primeChannelOutboundSendMock(sendFn, { messageId: "m1" }, params.sendResults);
  const outbound = createDirectTextMediaOutbound({
    channel: "direct-text-media",
    resolveSender: () => sendFn,
    resolveMaxBytes: () => undefined,
    buildTextOptions: (opts) => opts as never,
    buildMediaOptions: (opts) => opts as never,
  });
  const ctx = { cfg: {}, to: "user1", text: "", payload: params.payload };
  const sendPayload = outbound.sendPayload;
  if (!sendPayload) {
    throw new Error("Expected direct text/media outbound sendPayload");
  }
  return {
    run: async () => await sendPayload(ctx),
    sendMock: sendFn,
    to: ctx.to,
  };
}

describe("outbound payload contracts: direct text/media", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "direct-text-media",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness: createDirectTextMediaHarness,
  });
});

const scopedMediaConfig: OpenClawConfig = {
  agents: { defaults: { mediaMaxMb: 4 } },
  channels: {
    "media-limit-fixture": {
      mediaMaxMb: 2,
      accounts: {
        default: { mediaMaxMb: 3 },
        office: { mediaMaxMb: 1 },
        "office-east": { mediaMaxMb: 5 },
        zero: { mediaMaxMb: 0 },
        nan: { mediaMaxMb: Number.NaN },
        text: { mediaMaxMb: "1" },
      },
    },
  },
};

const agentLimit = (mediaMaxMb: number): OpenClawConfig => ({
  agents: { defaults: { mediaMaxMb } },
});
const channelLimit = (mediaMaxMb: number | string, withDefault = true): OpenClawConfig => ({
  ...(withDefault ? agentLimit(4) : {}),
  channels: { "media-limit-fixture": { mediaMaxMb } },
});

// Programmatic inputs, not configuration-schema acceptance. Columns: name, config, account, bytes.
const mediaLimitCases: Array<
  [string, OpenClawConfig, string | null | undefined, number | undefined]
> = [
  ["no configured limit", {}, undefined, undefined],
  ["agent default only", agentLimit(4), undefined, 4194304],
  ["channel limit before agent default", scopedMediaConfig, "missing", 2097152],
  ["omitted account selects default", scopedMediaConfig, undefined, 3145728],
  ["null account selects default", scopedMediaConfig, null, 3145728],
  ["blank account selects default", scopedMediaConfig, "  ", 3145728],
  ["account limit before channel limit", scopedMediaConfig, "office", 1048576],
  ["trimmed lowercase account", scopedMediaConfig, " OFFICE ", 1048576],
  ["canonicalized account key", scopedMediaConfig, " Office / East ", 5242880],
  ["zero account limit falls through to agent default", scopedMediaConfig, "zero", 4194304],
  ["NaN account limit falls through to agent default", scopedMediaConfig, "nan", 4194304],
  ["non-number account limit falls through to channel", scopedMediaConfig, "text", 2097152],
  ["zero channel limit falls through to agent default", channelLimit(0), undefined, 4194304],
  [
    "NaN channel limit falls through to agent default",
    channelLimit(Number.NaN),
    undefined,
    4194304,
  ],
  ["zero agent default is absent", agentLimit(0), undefined, undefined],
  ["NaN agent default is absent", agentLimit(Number.NaN), undefined, undefined],
  [
    "non-record channel section falls through to agent default",
    { ...agentLimit(4), channels: { "media-limit-fixture": [] } },
    undefined,
    4194304,
  ],
  ["fractional channel limit retains byte conversion", channelLimit(0.5, false), undefined, 524288],
  [
    "non-number channel limit falls through to agent default",
    channelLimit("2"),
    undefined,
    4194304,
  ],
];

describe("scoped channel media limits", () => {
  it.each(mediaLimitCases)("%s", (_name, cfg, accountId, expected) => {
    const resolveLimit = createScopedChannelMediaMaxBytesResolver("media-limit-fixture");
    expect(resolveLimit({ cfg, accountId })).toBe(expected);
  });

  it("reads the configuration supplied to each call of the same resolver", () => {
    const resolveLimit = createScopedChannelMediaMaxBytesResolver("media-limit-fixture");
    for (const [limit, expected] of [
      [1, 1048576],
      [2, 2097152],
    ] as const) {
      expect(resolveLimit({ cfg: channelLimit(limit, false) })).toBe(expected);
    }
  });

  it("carries selected limits and unchanged text/media options to the sender", async () => {
    const cfg = scopedMediaConfig;
    const optionsByKind = { text: { kind: "text" }, media: { kind: "media" } };
    const send = vi.fn(async (_to: string, _text: string, _options: { kind: string }) => ({
      messageId: "fixture-message",
    }));
    type BuilderInput = Parameters<
      Parameters<typeof createDirectTextMediaOutbound>[0]["buildTextOptions"]
    >[0];
    const built: BuilderInput[] = [];
    const build = (kind: keyof typeof optionsByKind) => (options: BuilderInput) => {
      built.push(options);
      return optionsByKind[kind];
    };
    const outbound = createDirectTextMediaOutbound({
      channel: "media-limit-fixture",
      resolveSender: () => send,
      resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("media-limit-fixture"),
      buildTextOptions: build("text"),
      buildMediaOptions: build("media"),
    });
    const sendText = outbound.sendText;
    const sendMedia = outbound.sendMedia;
    if (!sendText || !sendMedia) {
      throw new Error("Expected direct text and media send operations");
    }
    const readFile = vi.fn(async () => Buffer.from("unused"));
    const legacyReadFile = vi.fn(async () => Buffer.from("unused-legacy"));
    const roots = ["/tmp/media-limit-canonical-fixture"];
    const legacyRoots = ["/tmp/media-limit-legacy-fixture"];
    const mediaAccess = { localRoots: roots, readFile, workspaceDir: "/tmp/media-limit-workspace" };
    const context = { cfg, to: "fixture-recipient", accountId: " OFFICE ", replyToId: "reply-1" };

    const commonOptions = {
      cfg,
      accountId: context.accountId,
      replyToId: "reply-1",
      maxBytes: 1048576,
    };
    for (const [text, suppliedAccess, expectedAccess] of [
      ["text", undefined, undefined],
      ["caption", mediaAccess, mediaAccess],
      ["legacy caption", undefined, { localRoots: legacyRoots, readFile: legacyReadFile }],
    ] as const) {
      const isText = text === "text";
      const mediaUrl = isText
        ? undefined
        : `https://example.test/${suppliedAccess ? "canonical" : "legacy"}.png`;
      const result = await (isText ? sendText : sendMedia)({
        ...context,
        text,
        mediaUrl,
        ...(!isText && {
          mediaAccess: suppliedAccess,
          mediaLocalRoots: legacyRoots,
          mediaReadFile: legacyReadFile,
        }),
      });
      const options = built.at(-1);
      expect(options).toStrictEqual({
        ...commonOptions,
        mediaUrl,
        mediaAccess: expectedAccess,
        mediaLocalRoots: expectedAccess?.localRoots,
        mediaReadFile: expectedAccess?.readFile,
      });
      expect(options?.cfg).toBe(cfg);
      if (suppliedAccess) {
        expect(options?.mediaAccess).toBe(suppliedAccess);
      }
      expect(options?.mediaLocalRoots).toBe(expectedAccess?.localRoots);
      const sentOptions = optionsByKind[isText ? "text" : "media"];
      expect(send.mock.calls.at(-1)).toStrictEqual(["fixture-recipient", text, sentOptions]);
      expect(send.mock.calls.at(-1)?.[2]).toBe(sentOptions);
      expect(result).toStrictEqual({
        channel: "media-limit-fixture",
        messageId: "fixture-message",
      });
    }
    expect(built).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(3);
    expect(readFile).not.toHaveBeenCalled();
    expect(legacyReadFile).not.toHaveBeenCalled();
  });
});
