import { M_POLL_KIND_DISCLOSED, M_POLL_KIND_UNDISCLOSED } from "matrix-js-sdk/lib/@types/polls.js";
import { PollResponseEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollResponseEvent.js";
import { PollStartEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollStartEvent.js";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors.js";
import { describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import { buildHttpError } from "../sdk/event-helpers.js";
import { editMatrixMessage, readMatrixMessages } from "./messages.js";
import type { MatrixMessageSummary } from "./types.js";

const ROOM = "!room:example.org";

const MATRIX_ACTION_TEST_CFG = { channels: { matrix: {} } };
type RawEvent = Record<string, unknown>;
const ALICE = "@alice:example.org";

function rawEvent(
  event_id: string,
  type: string,
  content: RawEvent,
  origin_server_ts = 1,
  sender = ALICE,
): RawEvent {
  return { event_id, type, content, origin_server_ts, sender };
}

function installMatrixActionTestRuntime(): void {
  setMatrixRuntime({
    config: { current: () => ({}) },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "code",
        resolveTextChunkLimit: () => 4_000,
        convertMarkdownTables: (text: string) => text,
      },
    },
  } as unknown as import("openclaw/plugin-sdk/plugin-runtime").PluginRuntime);
}

function createPollResponseEvent(): RawEvent {
  return rawEvent(
    "$vote",
    "m.poll.response",
    {
      "m.poll.response": { answers: ["a1"] },
      "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
    },
    20,
    "@bob:example.org",
  );
}

function createPollStartEvent(content: RawEvent = {}): RawEvent {
  return rawEvent("$poll", "m.poll.start", {
    "m.poll.start": {
      question: { "m.text": "Favorite fruit?" },
      answers: [{ id: "a1", "m.text": "Apple" }],
      ...content,
    },
  });
}

function message(
  eventId: string,
  body: string,
  timestamp: number,
  params: { sender?: string; threadId?: string; replaces?: string; omitNewContent?: boolean } = {},
): RawEvent {
  const content: RawEvent = { msgtype: "m.text", body };
  if (params.threadId) {
    content["m.relates_to"] = { rel_type: "m.thread", event_id: params.threadId };
  }
  if (params.replaces) {
    content.body = `* ${body}`;
    content["m.relates_to"] = { rel_type: "m.replace", event_id: params.replaces };
    if (!params.omitNewContent) {
      content["m.new_content"] = { msgtype: "m.text", body };
    }
  }
  return rawEvent(eventId, "m.room.message", content, timestamp, params.sender);
}

function createMessagesClient(params: {
  chunk?: RawEvent[];
  hydratedChunk?: RawEvent[];
  pollRoot?: RawEvent;
  pollRelations?: RawEvent[];
  threadRelations?: RawEvent[];
}) {
  const doRequest = vi.fn(async () => ({
    chunk: params.chunk ?? [],
    start: "start-token",
    end: "end-token",
  }));
  const hydrateEvents = vi.fn(
    async (_roomId: string, _events: RawEvent[]) => (params.hydratedChunk ?? _events) as unknown,
  );
  const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
    params.pollRoot?.event_id === eventId ? params.pollRoot : null,
  );
  const getRelations = vi.fn(
    async (
      _roomId: string,
      _eventId: string,
      relType: string,
    ): Promise<{
      events: RawEvent[];
      nextBatch: string | null;
      prevBatch: string | null;
    }> => ({
      events:
        relType === "m.thread"
          ? (params.threadRelations ?? params.pollRelations ?? [])
          : (params.pollRelations ?? []),
      nextBatch: null,
      prevBatch: null,
    }),
  );

  const client = { doRequest, hydrateEvents, getEvent, getRelations, stop: vi.fn() };
  return { ...client, client: client as unknown as MatrixClient };
}

function createEditClient(originalContent: Record<string, unknown>) {
  installMatrixActionTestRuntime();
  const sendMessage = vi.fn().mockResolvedValue("evt-edit");
  const client = {
    getEvent: vi.fn().mockResolvedValue({ content: originalContent }),
    getRelations: vi.fn().mockResolvedValue({ events: [], nextBatch: null }),
    getJoinedRoomMembers: vi.fn().mockResolvedValue([]),
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    sendMessage,
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
  } as unknown as MatrixClient;

  return { client, sendMessage };
}

const readHistory = (opts: Parameters<typeof readMatrixMessages>[1]) =>
  readMatrixMessages("room:!room:example.org", opts);
const readThread = (client: MatrixClient, before?: string) =>
  readHistory({ client, threadId: "$thread-root", limit: 1, before });

async function expectHistory(
  chunk: RawEvent[],
  expected: MatrixMessageSummary[],
  opts: Parameters<typeof readHistory>[0] = {},
) {
  const { client } = createMessagesClient({ chunk });
  expect((await readHistory({ client, ...opts })).messages).toMatchObject(expected);
}

function threadPage(root = message("$thread-root", "thread root", 10)) {
  return createMessagesClient({
    pollRoot: root,
    threadRelations: [message("$thread-reply", "thread reply", 20, { threadId: "$thread-root" })],
  });
}

function threadRequest(threadId: string, limit: number, from?: string) {
  return [ROOM, threadId, "m.thread", undefined, { dir: "b", from, limit }] as const;
}

describe("matrix message actions", () => {
  it("rejects whitespace-only Matrix edits", async () => {
    await expect(
      editMatrixMessage(ROOM, "$original", "   \n  ", { cfg: MATRIX_ACTION_TEST_CFG }),
    ).rejects.toThrow("Matrix edit requires content");
  });

  it("returns the edit receipt while notifying only newly added mentions", async () => {
    const text = "hello @alice:example.org and @bob:example.org";
    const { client, sendMessage } = createEditClient({
      body: "hello @alice:example.org",
      "m.mentions": { user_ids: ["@alice:example.org"] },
    });
    const result = await editMatrixMessage(ROOM, "$original", text, {
      cfg: MATRIX_ACTION_TEST_CFG,
      client,
    });
    expect(result).toEqual({ eventId: "evt-edit" });
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      ROOM,
      expect.objectContaining({
        "m.mentions": { user_ids: ["@bob:example.org"] },
        "m.new_content": expect.objectContaining({
          body: text,
          "m.mentions": { user_ids: ["@alice:example.org", "@bob:example.org"] },
        }),
      }),
    );
  });

  it.each([
    { kind: M_POLL_KIND_DISCLOSED.name, disclosed: true },
    { kind: M_POLL_KIND_UNDISCLOSED.name, disclosed: false },
  ])("preserves $kind results in room and thread history", async ({ kind, disclosed }) => {
    const poll = PollStartEvent.from("Favorite fruit?", ["Apple", "Strawberry"], kind);
    const pollRoot = {
      ...poll.serialize(),
      event_id: "$poll",
      sender: "@alice:example.org",
      origin_server_ts: 1,
    };
    const vote = {
      ...PollResponseEvent.from(
        poll.answers.slice(0, 1).map((answer) => answer.id),
        "$poll",
      ).serialize(),
      event_id: "$vote",
      sender: "@bob:example.org",
      origin_server_ts: 20,
    };
    const { client } = createMessagesClient({
      chunk: [vote],
      pollRoot,
      pollRelations: [vote],
      threadRelations: [],
    });

    for (const threadId of [undefined, "$poll"]) {
      const result = await readHistory({ client, threadId });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.body).toBe(
        disclosed
          ? "[Poll]\nFavorite fruit?\n\n1. Apple (1 vote)\n2. Strawberry (0 votes)\n\nTotal voters: 1"
          : "[Poll]\nFavorite fruit?\n\n1. Apple\n2. Strawberry\n\nResponses are hidden until the poll closes.",
      );
    }
  });

  it("hydrates history before deduping multiple events for the same poll", async () => {
    const encrypted = rawEvent("$enc", "m.room.encrypted", {}, 20, "@bob:example.org");
    const { client, getEvent, hydrateEvents } = createMessagesClient({
      chunk: [encrypted],
      hydratedChunk: [createPollResponseEvent(), createPollStartEvent()],
      pollRoot: createPollStartEvent(),
      pollRelations: [],
    });

    const result = await readHistory({ client });

    expect(result.messages).toMatchObject([
      { eventId: "$poll", body: expect.stringContaining("[Poll]") },
    ]);
    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(hydrateEvents).toHaveBeenNthCalledWith(1, ROOM, [encrypted]);
  });

  it.each([
    { direction: "backward", after: undefined },
    { direction: "forward", after: "previous-page" },
  ])("collapses valid Matrix replacements in $direction history", async ({ after }) => {
    const chronological = [
      message("$original", "original text", 10),
      message("$edit-old", "intermediate text", 20, { replaces: "$original" }),
      message("$edit-new", "final text", 30, { replaces: "$original" }),
    ];
    const chunk = after ? chronological : chronological.toReversed();
    const { client } = createMessagesClient({ chunk });

    const result = await readHistory({ client, after });

    expect(result.messages).toEqual([
      {
        eventId: "$original",
        sender: "@alice:example.org",
        body: "final text",
        msgtype: "m.text",
        attachment: undefined,
        timestamp: 10,
        relatesTo: undefined,
      },
    ]);
  });

  it("uses the Matrix event-id tie-break for equally timed replacements", async () => {
    const winner = message("$edit-z", "winning tie", 20, { replaces: "$original" });
    const content = winner.content as Record<string, unknown>;
    (content["m.new_content"] as Record<string, unknown>)["m.relates_to"] = {
      rel_type: "m.thread",
      event_id: "$forged-thread",
    };
    await expectHistory(
      [
        message("$edit-a", "earlier tie", 20, { replaces: "$original" }),
        winner,
        message("$original", "original text", 10),
      ],
      [{ eventId: "$original", body: "winning tie", relatesTo: undefined }],
    );
  });

  it("ignores malformed and cross-sender Matrix replacements", async () => {
    await expectHistory(
      [
        message("$forged", "forged text", 40, {
          replaces: "$original",
          sender: "@mallory:example.org",
        }),
        message("$malformed", "malformed text", 30, {
          replaces: "$original",
          omitNewContent: true,
        }),
        message("$original", "original text", 10),
      ],
      [{ eventId: "$original", body: "original text" }],
    );
  });

  it("preserves a valid edit when its original is on another history page", async () => {
    await expectHistory(
      [message("$edit", "cross-page final text", 20, { replaces: "$original" })],
      [
        {
          eventId: "$edit",
          body: "cross-page final text",
          relatesTo: { relType: "m.replace", eventId: "$original" },
        },
      ],
      { after: "previous-page" },
    );
  });

  it("does not revive a redacted original through a replacement event", async () => {
    const redactedOriginal = message("$original", "redacted original", 10);
    redactedOriginal.unsigned = { redacted_because: {} };
    const { client } = createMessagesClient({
      chunk: [message("$edit", "redacted edit", 20, { replaces: "$original" }), redactedOriginal],
    });
    expect((await readHistory({ client })).messages).toEqual([]);
  });

  it("applies bundled Matrix replacements to first-page thread roots", async () => {
    const threadRoot = message("$thread-root", "original root", 10);
    threadRoot.unsigned = {
      "m.relations": {
        "m.replace": message("$thread-edit", "edited root", 20, {
          replaces: "$thread-root",
        }),
      },
    };
    const { client } = createMessagesClient({ pollRoot: threadRoot });

    const result = await readHistory({ client, threadId: "$thread-root" });

    expect(result.messages).toMatchObject([{ eventId: "$thread-root", body: "edited root" }]);
  });

  it("filters Matrix thread events out of main-room reads", async () => {
    const { client } = createMessagesClient({
      chunk: [
        message("$thread-reply", "thread reply", 20, { threadId: "$thread-root" }),
        message("$main", "main room", 10),
      ],
    });

    const result = await readHistory({ client });

    expect(result.messages.map((event) => event.eventId)).toEqual(["$main"]);
  });

  it("filters threaded poll roots out of main-room reads", async () => {
    const threadedPollRoot = createPollStartEvent();
    const threadedPollContent = threadedPollRoot.content as Record<string, unknown>;
    threadedPollRoot.content = {
      ...threadedPollContent,
      "m.relates_to": { rel_type: "m.thread", event_id: "$thread-root" },
    };
    const { client, getEvent } = createMessagesClient({
      chunk: [createPollResponseEvent()],
      pollRoot: threadedPollRoot,
      pollRelations: [createPollResponseEvent()],
    });

    const result = await readHistory({ client });

    expect(getEvent).toHaveBeenCalledWith(ROOM, "$poll");
    expect(result.messages).toEqual([]);
  });

  it("includes poll snapshots from threaded reads", async () => {
    const { client, getEvent, getRelations } = createMessagesClient({
      pollRoot: createPollStartEvent({
        kind: "m.poll.disclosed",
        max_selections: 1,
        answers: [
          { id: "a1", "m.text": "Apple" },
          { id: "a2", "m.text": "Strawberry" },
        ],
      }),
      pollRelations: [createPollResponseEvent()],
    });

    const result = await readHistory({ client, threadId: "$thread-root", limit: 5 });

    expect(getRelations).toHaveBeenCalledWith(...threadRequest("$thread-root", 5));
    expect(getEvent).toHaveBeenCalledWith(ROOM, "$poll");
    expect(result.messages[0]?.body).toContain("1. Apple (1 vote)");
  });

  it("does not summarize non-start poll events as thread roots", async () => {
    const { client, getRelations } = createMessagesClient({
      pollRoot: createPollResponseEvent(),
      threadRelations: [message("$thread-reply", "thread reply", 20, { threadId: "$vote" })],
    });

    const result = await readHistory({ client, threadId: "$vote", limit: 5 });

    expect(getRelations).toHaveBeenCalledWith(...threadRequest("$vote", 5));
    expect(result.messages.map((event) => event.eventId)).toEqual(["$thread-reply"]);
  });

  it("counts the thread root toward the requested first-page limit", async () => {
    const { client, doRequest, getEvent, getRelations } = threadPage();

    const result = await readThread(client);

    expect(getRelations).toHaveBeenLastCalledWith(...threadRequest("$thread-root", 1));
    expect(doRequest).not.toHaveBeenCalled();
    expect(getEvent).toHaveBeenCalledWith(ROOM, "$thread-root");
    expect(result.messages.map((event) => event.eventId)).toEqual(["$thread-root"]);
    expect(result.nextBatch).toEqual(
      expect.stringContaining("openclaw.matrix.thread-relations-start:"),
    );

    const next = await readThread(client, result.nextBatch ?? undefined);

    expect(getRelations).toHaveBeenLastCalledWith(...threadRequest("$thread-root", 1));
    expect(next.messages.map((event) => event.eventId)).toEqual(["$thread-reply"]);
  });

  it("forwards a noncanonical synthetic thread cursor as an opaque Matrix token", async () => {
    const firstPage = threadPage();
    const first = await readThread(firstPage.client);
    const cursor = first.nextBatch;
    if (!cursor) {
      throw new Error("Expected a synthetic thread cursor");
    }
    const nonCanonicalCursor = `${cursor}!`;
    const nextPage = createMessagesClient({});

    await readThread(nextPage.client, nonCanonicalCursor);

    expect(nextPage.getRelations).toHaveBeenLastCalledWith(
      ...threadRequest("$thread-root", 1, nonCanonicalCursor),
    );
  });

  it("does not reserve first-page thread capacity for a redacted root", async () => {
    const { client, doRequest, getEvent, getRelations } = threadPage({
      ...message("$thread-root", "", 10),
      unsigned: { redacted_because: {} },
      content: {},
    });

    const result = await readThread(client);

    expect(getRelations).toHaveBeenLastCalledWith(...threadRequest("$thread-root", 1));
    expect(doRequest).not.toHaveBeenCalled();
    expect(getEvent).toHaveBeenCalledWith(ROOM, "$thread-root");
    expect(result.messages.map((event) => event.eventId)).toEqual(["$thread-reply"]);
    expect(result.nextBatch).toBeNull();
  });

  it.each([
    {
      page: "room history",
      threadId: undefined,
      serverText: "invalid digit found in string",
      failure: buildHttpError(
        500,
        JSON.stringify({ errcode: "M_UNKNOWN", error: "invalid digit found in string" }),
      ),
    },
    {
      page: "thread relations",
      threadId: "$thread-root",
      serverText: "'from' parameter is invalid",
      failure: new MatrixError(
        { errcode: "M_INVALID_PARAM", error: "'from' parameter is invalid" },
        400,
      ),
    },
  ])(
    "names the cursor contract when the homeserver rejects a $page cursor",
    async ({ threadId, serverText, failure }) => {
      const { client, doRequest, getRelations } = createMessagesClient({});
      (threadId ? getRelations : doRequest).mockRejectedValueOnce(failure);

      const error = await readHistory({ client, threadId, after: "$event-id" }).catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(serverText);
      expect((error as Error).message).toContain("nextBatch or prevBatch, not an event id");
      expect((error as Error).cause).toBe(failure);
    },
  );

  it("leaves first-page and non-cursor read failures unchanged", async () => {
    const serverError = buildHttpError(
      500,
      JSON.stringify({ errcode: "M_UNKNOWN", error: "boom" }),
    );
    const firstPage = createMessagesClient({});
    firstPage.doRequest.mockRejectedValueOnce(serverError);
    await expect(readHistory({ client: firstPage.client })).rejects.toBe(serverError);

    const forbidden = buildHttpError(403, JSON.stringify({ errcode: "M_FORBIDDEN", error: "no" }));
    const pagedRead = createMessagesClient({});
    pagedRead.doRequest.mockRejectedValueOnce(forbidden);
    await expect(readHistory({ client: pagedRead.client, before: "t1" })).rejects.toBe(forbidden);
  });

  it("rejects before and after together instead of paging one token in the other direction", async () => {
    const { client, doRequest, getRelations } = createMessagesClient({});

    await expect(readHistory({ client, before: "t1", after: "t2" })).rejects.toThrow(
      "Matrix read accepts either before or after, not both.",
    );
    expect(doRequest).not.toHaveBeenCalled();
    expect(getRelations).not.toHaveBeenCalled();
  });
});
