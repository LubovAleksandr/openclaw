import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultActionOptions,
  discordConfig,
  expectDiscordActionCall,
  handleDiscordActionMock,
  handleDiscordMessageAction,
} from "./handle-action.test-support.js";
const {
  beginDiscordActiveTurnThreadRoute,
  notifyDiscordActiveTurnThreadCreated,
  notifyDiscordActiveTurnThreadReplyDelivered,
} = await import("../active-turn-thread-route.js");
const { discordInboundEventDelivery } = await import("../inbound-event-delivery.js");

const sessionKey = "agent:main:discord:channel:channel-1";
const sourceRoute = {
  accountId: "account-1",
  sourceChannelId: "channel-1",
  sourceMessageId: "message-1",
};
const threadContext = { accountId: sourceRoute.accountId, sessionKey };
const discordContext = { currentChannelProvider: "discord" };
const foreignRequester = {
  requesterSenderId: "telegram-user-id",
  toolContext: { currentChannelProvider: "telegram" },
};
function runAction(
  action: Parameters<typeof handleDiscordMessageAction>[0]["action"],
  params: Record<string, unknown>,
  context: Partial<
    Omit<Parameters<typeof handleDiscordMessageAction>[0], "action" | "params">
  > = {},
) {
  return handleDiscordMessageAction({ cfg: discordConfig(), ...context, action, params });
}

async function expectAction(
  action: Parameters<typeof runAction>[0],
  params: Record<string, unknown>,
  payload: Record<string, unknown>,
  context: Parameters<typeof runAction>[2] = {},
  options?: unknown,
) {
  const cfg = context.cfg ?? discordConfig();
  await runAction(action, params, { ...context, cfg });
  expectDiscordActionCall({ payload: { accountId: undefined, ...payload }, cfg, options });
}

async function expectRejected(error: string | RegExp, ...args: Parameters<typeof runAction>) {
  await expect(runAction(...args)).rejects.toThrow(error);
  expect(handleDiscordActionMock).not.toHaveBeenCalled();
}

function threadAction(action: "thread-create" | "thread-reply", params: Record<string, unknown>) {
  return runAction(action, params, { cfg: discordConfig({ threads: true }), ...threadContext });
}

const cleanupRoutes: Array<() => void> = [];
function cleanup() {
  for (const end of cleanupRoutes.splice(0)) {
    end();
  }
}
function beginRoute(
  options: Partial<Parameters<typeof beginDiscordActiveTurnThreadRoute>[1]> = {},
) {
  const route = {
    ...sourceRoute,
    onThreadAdopted: vi.fn(),
    onThreadReplyDelivered: vi.fn(),
    ...options,
  };
  cleanupRoutes.push(beginDiscordActiveTurnThreadRoute(sessionKey, route));
  return route;
}
function mockResult(details: Record<string, unknown> = { ok: true }) {
  const result = { content: [], details };
  handleDiscordActionMock.mockResolvedValueOnce(result);
  return result;
}
const threadParams = {
  channelId: "channel-1",
  messageId: "message-1",
  threadName: "investigation",
};

describe("handleDiscordMessageAction", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });
  afterEach(cleanup);

  it.each([
    [
      "timeout",
      { moderation: true, channels: false },
      { guildId: "guild-1", userId: "user-2", durationMin: 5 },
      {
        action: "timeout",
        guildId: "guild-1",
        userId: "user-2",
        durationMinutes: 5,
        until: undefined,
        reason: undefined,
        deleteMessageDays: undefined,
      },
    ],
    [
      "channel-delete",
      { moderation: false, channels: true },
      { channelId: "channel-1" },
      { action: "channelDelete", channelId: "channel-1" },
    ],
  ] as const)(
    "uses trusted sender identity for %s, ignoring spoofed params",
    async (action, actions, params, payload) => {
      await expectAction(
        action,
        { ...params, senderUserId: "spoofed-admin-id" },
        { ...payload, senderUserId: "trusted-sender-id" },
        {
          cfg: discordConfig(actions),
          requesterSenderId: "trusted-sender-id",
          toolContext: discordContext,
        },
      );
    },
  );

  it.each([
    [
      "timeout",
      { guildId: "guild-1", userId: "user-2", durationMin: 5.5 },
      { moderation: true },
      "durationMin must be a non-negative integer",
    ],
    [
      "thread-create",
      { ...threadParams, autoArchiveMin: 999 },
      { threads: true },
      "autoArchiveMin must be one of 60, 1440, 4320, or 10080 minutes",
    ],
  ] as const)(
    "rejects invalid numeric parameters for %s before runtime",
    async (action, params, actions, error) => {
      await expectRejected(error, action, params, {
        cfg: discordConfig(actions),
        requesterSenderId: "trusted-sender-id",
        toolContext: discordContext,
      });
    },
  );

  it.each([
    ["channel-delete", { channelId: "channel-1" }, { channels: true }],
    ["timeout", { guildId: "guild-1", userId: "user-2", durationMin: 5 }, { moderation: true }],
  ] as const)("rejects foreign requester identities for %s", async (action, params, actions) => {
    await expectRejected("trusted Discord sender identity", action, params, {
      cfg: discordConfig(actions),
      ...foreignRequester,
    });
  });

  it("keeps no-context Discord guild admin actions on the manual runtime path", async () => {
    await expectAction(
      "channel-delete",
      { channelId: "channel-1" },
      { action: "channelDelete", channelId: "channel-1" },
      { cfg: discordConfig({ channels: true }), senderIsOwner: true },
    );
  });

  it("rejects no-context Discord guild admin actions without owner trust", async () => {
    const cfg = discordConfig({ channels: true });
    await expectRejected(
      "trusted Discord sender identity",
      "channel-delete",
      { channelId: "channel-1" },
      { cfg },
    );
  });

  it.each([
    ["member-info", "memberInfo", { userId: "user-1", guildId: "guild-1" }],
    ["role-info", "roleInfo", { guildId: "guild-1" }],
    ["channel-info", "channelInfo", { channelId: "channel-1" }],
    ["channel-list", "channelList", { guildId: "guild-1" }],
    ["voice-status", "voiceStatus", { guildId: "guild-1", userId: "user-1" }],
    ["event-list", "eventList", { guildId: "guild-1" }],
  ] as const)(
    "keeps %s available from non-Discord requesters",
    async (action, runtimeAction, params) => {
      await expectAction(
        action,
        params,
        { action: runtimeAction, ...params },
        { cfg: discordConfig({ channelInfo: true }), ...foreignRequester },
      );
    },
  );

  it("falls back to Discord toolContext.currentChannelId for reaction targets", async () => {
    await expectAction(
      "react",
      { emoji: "ok" },
      { action: "react", channelId: "user:U1", messageId: "9001", emoji: "ok", remove: undefined },
      {
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "user:U1",
          currentMessageId: "9001",
        },
      },
      defaultActionOptions(),
    );
  });

  it("forwards attested current-conversation context to Discord channel info", async () => {
    await expectAction(
      "channel-info",
      { channelId: "123" },
      { action: "channelInfo", accountId: "ops", channelId: "123" },
      {
        cfg: discordConfig({ channelInfo: true }),
        accountId: "ops",
        requesterAccountId: "ops",
        conversationReadOrigin: "delegated",
        toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:123" },
      },
      {
        conversationReadOrigin: "delegated",
        readContext: {
          requesterAccountId: "ops",
          currentChannelProvider: "discord",
          currentChannelId: "channel:123",
        },
      },
    );
  });

  it.each([
    ["send", { to: "channel:channel-1", message: "hello" }],
    ["upload-file", { to: "channel:channel-1", filePath: "/tmp/image.png" }],
    ["sticker", { to: "channel:channel-1", stickerId: ["sticker-1"] }],
    ["thread-reply", { threadId: "channel-1", message: "thread update" }],
    ["thread-create", threadParams],
  ] as const)(
    "records room-event delivery only after %s receives a positive receipt",
    async (action, params) => {
      for (const ok of [false, true]) {
        const markDelivered = vi.fn();
        cleanupRoutes.push(
          discordInboundEventDelivery.begin(
            sessionKey,
            {
              outboundTo: "channel:channel-1",
              outboundAccountId: "default",
              markInboundEventDelivered: markDelivered,
            },
            { inboundEventKind: "room_event" },
          ),
        );
        const route = action === "thread-create" ? beginRoute({ accountId: "default" }) : undefined;
        mockResult({
          ok,
          ...(ok ? {} : { error: "delivery failed" }),
          ...(action === "thread-create" ? { thread: { id: "thread-1" } } : {}),
        });

        try {
          const result = await handleDiscordMessageAction({
            action,
            params,
            cfg: discordConfig({ threads: true, polls: true, stickers: true }),
            accountId: "default",
            sessionKey,
            inboundEventKind: "room_event",
          });

          expect(result.details).toMatchObject({ ok });
          expect(markDelivered).toHaveBeenCalledTimes(ok ? 1 : 0);
          if (route) {
            expect(route.onThreadAdopted).toHaveBeenCalledTimes(ok ? 1 : 0);
          }
        } finally {
          cleanup();
        }
      }
    },
  );

  it.each([
    [{}, /upload-file requires filePath, path, or media/i],
    [
      {
        filename: "report.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from("report").toString("base64"),
      },
      'Use action: "send" for base64 buffer attachments; upload-file requires filePath, path, or media.',
    ],
  ] as const)("rejects upload-file without a file source: %j", async (params, error) => {
    await expectRejected(error, "upload-file", { to: "channel:123", ...params });
  });

  it.each(["thread-reply", "send"] as const)(
    "classifies %s only in the active adopted thread",
    async (action) => {
      const { onThreadAdopted, onThreadReplyDelivered } = beginRoute();
      expect(notifyDiscordActiveTurnThreadReplyDelivered(threadContext)).toBe(false);
      mockResult({ ok: true, thread: { id: "thread-1" } });
      await threadAction("thread-create", threadParams);
      expect(onThreadAdopted).toHaveBeenCalledWith("thread-1");
      mockResult();
      const deliver = (threadId: string, message: string) =>
        action === "send"
          ? runAction("send", { to: `channel:${threadId}`, message }, threadContext)
          : threadAction(action, { threadId, message });
      const mismatchedResult = await deliver("thread-2", "unrelated");
      expect(mismatchedResult.details).toEqual({ ok: true });
      expect(onThreadReplyDelivered).not.toHaveBeenCalled();
      mockResult();
      const result = await deliver("thread-1", "done");
      expect(result.details).toEqual({ ok: true, sourceReplyRoute: "current-source" });
      expect(onThreadReplyDelivered).toHaveBeenCalledWith("thread-1");
    },
  );

  it("confirms only the matching adopted thread across concurrent routes", async () => {
    const { onThreadReplyDelivered: firstReplyDelivered } = beginRoute();
    const { onThreadReplyDelivered: secondReplyDelivered } = beginRoute({
      sourceMessageId: "message-2",
    });
    await notifyDiscordActiveTurnThreadCreated({
      sessionKey,
      ...sourceRoute,
      threadId: "thread-1",
    });
    await notifyDiscordActiveTurnThreadCreated({
      sessionKey,
      ...sourceRoute,
      sourceMessageId: "message-2",
      threadId: "thread-2",
    });
    expect(
      notifyDiscordActiveTurnThreadReplyDelivered({ ...threadContext, threadId: "thread-2" }),
    ).toBe(true);
    expect(firstReplyDelivered).not.toHaveBeenCalled();
    expect(secondReplyDelivered).toHaveBeenCalledWith("thread-2");
  });

  it("keeps a successful thread-create result when progress migration fails", async () => {
    const onThreadAdoptionError = vi.fn();
    beginRoute({
      accountId: undefined,
      onThreadAdopted: async () => {
        throw new Error("preview move failed");
      },
      onThreadAdoptionError,
    });
    const expectedResult = mockResult({ ok: true, thread: { id: "thread-1" } });
    const result = await runAction("thread-create", threadParams, {
      cfg: discordConfig({ threads: true }),
      sessionKey,
    });
    expect(result).toBe(expectedResult);
    expect(onThreadAdoptionError).toHaveBeenCalledWith(expect.any(Error));
  });

  it.each([
    ["send", { message: "hello" }, { currentChannelId: "channel:123" }],
    ["react", { emoji: "ok" }, { currentChannelId: "user:U1", currentMessageId: "9001" }],
  ] as const)(
    "does not use another provider's current target for Discord %s",
    async (action, params, target) => {
      await expectRejected(/channel target is required/i, action, params, {
        toolContext: { currentChannelProvider: "telegram", ...target },
      });
    },
  );

  it("rejects reactions when no message id source is available", async () => {
    await expectRejected(/messageId required/i, "react", { channelId: "123", emoji: "ok" });
  });

  it("preserves a successful send when route-only target parsing rejects the target", async () => {
    const result = await runAction("send", { to: "@alice", message: "hello" });

    expect(result.details).toEqual({ ok: true });
  });

  it("downgrades oversized table presentations to complete text", async () => {
    const cfg = discordConfig();
    const authoredText = `${"x".repeat(1997)}AUTHORED_TAIL`;

    await runAction(
      "send",
      {
        to: "channel:123",
        presentation: {
          title: authoredText,
          blocks: [
            { type: "text", text: authoredText },
            { type: "context", text: authoredText },
            {
              type: "buttons",
              buttons: [{ label: `${"x".repeat(80)}LABEL_TAIL`, value: "choice" }],
            },
            {
              type: "table",
              caption: "Large pipeline",
              headers: ["Account", "Stage"],
              rows: Array.from({ length: 900 }, (_entry, index) => [
                `account-${String(index)}-${"x".repeat(80)}`,
                "Review",
              ]),
            },
          ],
        },
      },
      { cfg },
    );

    const [call] = handleDiscordActionMock.mock.calls;
    const payload = call?.[0] as Record<string, unknown> | undefined;
    expect(payload?.components).toBeUndefined();
    expect(payload?.content).toEqual(expect.stringContaining("account-0-"));
    expect(payload?.content).toEqual(expect.stringContaining("account-899-"));
    expect(String(payload?.content).split("AUTHORED_TAIL")).toHaveLength(4);
    expect(payload?.content).toEqual(expect.stringContaining("LABEL_TAIL"));
  });

  const paddedCaption = "    example();\n";
  it.each([
    [{ message: "", caption: "caption text" }, ""],
    [{ caption: paddedCaption }, paddedCaption],
    [{ message: paddedCaption, caption: "caption text" }, paddedCaption],
    [{ content: paddedCaption, caption: "caption text" }, paddedCaption],
  ] as const)(
    "preserves upload-file caption precedence and whitespace: %j",
    async (params, expected) => {
      const mediaReadFile = vi.fn(async () => Buffer.from("image"));
      const cfg = discordConfig();
      const mediaAccess = { localRoots: ["/tmp/agent-root"], readFile: mediaReadFile };

      await runAction(
        "upload-file",
        { target: "channel:123", media: "/tmp/agent-root/chart.png", ...params },
        { cfg, mediaAccess, mediaLocalRoots: ["/tmp/agent-root"], mediaReadFile },
      );

      expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
      const [call] = handleDiscordActionMock.mock.calls;
      expect(call?.[0]).toMatchObject({
        action: "sendMessage",
        to: "channel:123",
        mediaUrl: "/tmp/agent-root/chart.png",
        content: expected,
      });
      expect(call?.[1]).toBe(cfg);
      expect(call?.[2]).toEqual({
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile,
      });
    },
  );
});
