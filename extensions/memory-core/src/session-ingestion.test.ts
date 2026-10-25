import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  foreignSessionIngestionSource,
  scanSessionIngestionSource,
  sessionIngestionSourceFromCorpus,
} from "./session-ingestion.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function messageRecord(id: string, content: string, timestamp = "2026-04-05T18:00:00.000Z") {
  return { type: "message", id, timestamp, message: { role: "user", content, timestamp } };
}

function recordLine(...args: Parameters<typeof messageRecord>) {
  return JSON.stringify(messageRecord(...args)) + "\n";
}

async function createArchive() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-ingestion-"));
  tempDirs.push(dir);
  const archiveFile = path.join(dir, "archive.jsonl");
  const source = foreignSessionIngestionSource("main", archiveFile);
  const scan = (options: Partial<Parameters<typeof scanSessionIngestionSource>[0]> = {}) =>
    scanSessionIngestionSource({
      source,
      seenMessages: {},
      verifyContent: true,
      classifyDay: () => "include",
      ...options,
    });
  return { archiveFile, source, scan };
}

function checkpoint(scan: Awaited<ReturnType<typeof scanSessionIngestionSource>>) {
  if (!scan.fileState) {
    throw new Error("expected transcript checkpoint");
  }
  return scan.fileState;
}

describe("session ingestion", () => {
  it.each(["unknown"] as const)("excludes %s sessions from memory ingestion", (sessionKind) => {
    expect(
      sessionIngestionSourceFromCorpus(
        {
          agentId: "main",
          artifactKind: "active-session",
          transcriptSource: "sqlite",
          sessionFile: "synthetic-session",
          sessionId: "synthetic-session",
          sessionKind,
        },
        "backfill",
      ),
    ).toBeNull();
  });

  it("preserves file-backed scope identity for a session id ending in .jsonl", () => {
    const sessionId = "foo.jsonl";
    const source = sessionIngestionSourceFromCorpus(
      {
        agentId: "main",
        artifactKind: "active-session",
        sessionFile: path.join(os.tmpdir(), "foo.jsonl.jsonl"),
        sessionId,
        sessionKind: "interactive",
      },
      "backfill",
    );

    expect(source?.scope).toBe(`main:${sessionId}`);
    expect(source?.sessionOrigin).toEqual({ agentId: "main", sessionId });
  });

  it("verifies backfill content despite an unchanged size and mtime", async () => {
    const { archiveFile, scan } = await createArchive();
    const record = (content: string) => recordLine("message-1", content);
    const firstRaw = record("Alpha durable note.");
    const secondRaw = record("Bravo durable note.");
    expect(Buffer.byteLength(secondRaw)).toBe(Buffer.byteLength(firstRaw));
    const fixedTime = new Date("2026-04-06T00:00:00.000Z");
    await fs.writeFile(archiveFile, firstRaw);
    await fs.utimes(archiveFile, fixedTime, fixedTime);
    const previous = checkpoint(await scan());

    await fs.writeFile(archiveFile, secondRaw);
    await fs.utimes(archiveFile, fixedTime, fixedTime);
    const second = await scan({ previous });

    expect(second.candidates.map((candidate) => candidate.snippet)).toEqual([
      "User: Bravo durable note.",
    ]);
  });

  it("resumes an append after consuming one snapshot line", async () => {
    const { archiveFile, scan } = await createArchive();
    await fs.writeFile(
      archiveFile,
      recordLine("message-1", "Alpha durable note.", "2026-04-06T06:59:59.000Z") +
        recordLine("message-2", "Bravo durable note.", "2026-04-06T07:00:00.000Z"),
    );
    const classifiedDays: string[] = [];
    const classifyDay = (day: string) => {
      classifiedDays.push(day);
      return "include" as const;
    };
    const options = { timezone: "America/Los_Angeles", classifyDay };
    const first = await scan({ ...options, maxCandidates: 1 });
    const previous = checkpoint(first);
    expect(first.candidates.map((candidate) => candidate.day)).toEqual(["2026-04-05"]);
    expect(classifiedDays).toEqual(["2026-04-05"]);

    classifiedDays.length = 0;
    const unchanged = await scan({ ...options, previous });
    expect(unchanged.candidates.map((candidate) => candidate.snippet)).toEqual([
      "User: Bravo durable note.",
    ]);
    expect(classifiedDays).toEqual(["2026-04-06"]);

    await fs.appendFile(
      archiveFile,
      recordLine("message-3", "Charlie durable note.", "2026-04-06T07:30:00.000Z"),
    );
    classifiedDays.length = 0;
    const second = await scan({ ...options, previous });

    expect(second.candidates.map(({ snippet, day }) => ({ snippet, day }))).toEqual(
      ["User: Bravo durable note.", "User: Charlie durable note."].map((snippet) => ({
        snippet,
        day: "2026-04-06",
      })),
    );
    expect(classifiedDays).toEqual(["2026-04-06", "2026-04-06"]);
  });

  it.each(["text", "timestamp", "provenance", "ordinal", "truncation"] as const)(
    "rescans when the previous snapshot changes by %s",
    async (change) => {
      const { archiveFile, source, scan } = await createArchive();
      const firstRecord = messageRecord("message-1", "Alpha durable note.");
      const original = [firstRecord, messageRecord("message-2", "Bravo durable note.")];
      const writeRecords = (records: unknown[]) =>
        fs.writeFile(archiveFile, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      await writeRecords(original);
      const previous = checkpoint(await scan());
      let current: unknown[] = [...original, messageRecord("message-3", "Charlie durable note.")];
      if (change === "text") {
        current[0] = {
          ...firstRecord,
          message: { ...firstRecord.message, content: "Altered durable note." },
        };
      } else if (change === "timestamp") {
        current[0] = {
          ...firstRecord,
          message: { ...firstRecord.message, timestamp: "2026-04-05T18:01:00.000Z" },
        };
      } else if (change === "provenance") {
        source.buildOptions.sessionKind = "unknown";
      } else if (change === "ordinal") {
        current.unshift({ type: "custom", customType: "fixture-note", data: {} });
      } else {
        current = [firstRecord];
      }
      await writeRecords(current);
      const changed = await scan({ previous });
      expect(changed.candidates.map((candidate) => candidate.snippet)).toEqual(
        change === "truncation"
          ? ["User: Alpha durable note."]
          : [
              change === "text" ? "User: Altered durable note." : "User: Alpha durable note.",
              "User: Bravo durable note.",
              "User: Charlie durable note.",
            ],
      );
    },
  );
});
