/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { selectMenuValue } from "../../test-helpers/session-menu.ts";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
  liveSessions,
  openRowMenu,
  selectRows,
  sessionRow,
  withNotifyingAgentSelection,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

async function setupArchivedPage(
  sessions: SessionCapability,
  expandedSessionKey: string | null = null,
) {
  const { gateway } = createGateway({} as GatewayBrowserClient);
  const { context, changeScope } = withNotifyingAgentSelection(
    createContext(gateway, sessions),
    "writer",
  );
  const page = await createRenderedPage(
    context,
    sessionsResult([archivedRow("agent:writer:old-1")], 1),
    "archived",
    expandedSessionKey,
  );
  return { page, context, changeScope };
}

const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
const archivedRow = (key: string): GatewaySessionRow => ({ key, kind: "direct", archived: true });
const deleted = (keys: string[] = []) => ({ deleted: keys, errors: [], preservedWorktrees: [] });
const archivedWriterRows = () => ({
  ...sessionsResult(writerKeys.map(archivedRow), 1),
  totalCount: writerKeys.length,
});

describe("sessions page agent-scope retirement", () => {
  it.each([
    [false, true],
    [true, true],
    [true, false],
  ])(
    "keeps placement outcomes in their captured agent scope (retired=%s, fails=%s)",
    async (retired, fails) => {
      const row: GatewaySessionRow = {
        key: "global",
        agentId: "writer",
        sessionId: "writer-global",
        kind: "direct",
        placement: {
          ...createActiveSessionPlacement({ environmentId: "worker:writer", activeOwnerEpoch: 7 }),
          state: "draining",
          generation: 2,
          updatedAtMs: 2,
          stateChangedAtMs: 2,
        },
        placementMove: {
          target: { kind: "gateway" },
          updatedAtMs: 2,
          error: "Sync failed",
          retry: {
            expected: { generation: 1, environmentId: "worker:writer", ownerEpoch: 7 },
            target: { kind: "gateway" },
          },
        },
      };
      const pending = createDeferred<unknown>();
      const request = vi.fn(async (method: string) =>
        method === "sessions.move" ? pending.promise : { profiles: [] },
      );
      const client = createTestGatewayClient(request);
      const clientRequest = vi.spyOn(client, "request");
      const connection = createGateway(client);
      connection.emit({
        hello: gatewayHelloForMethods(["sessions.move"], ["operator.read", "operator.write"]),
      });
      const reconcileMutation = vi
        .fn<SessionCapability["reconcileMutation"]>()
        .mockResolvedValue({ status: "refreshed" });
      const sessions = createSessions({ reconcileMutation });
      const { context, changeScope } = withNotifyingAgentSelection(
        createContext(connection.gateway, sessions),
        "writer",
      );
      const page = await createRenderedPage(context, sessionsResult([row], 1));
      await vi.waitFor(() => expect(page.loading).toBe(false));
      await selectMenuValue(await openRowMenu(page, row), "move-session");
      await vi.waitFor(() =>
        expect(clientRequest).toHaveBeenCalledWith("sessions.move", {
          key: "global",
          agentId: "writer",
          ...row.placementMove!.retry,
        }),
      );
      const moveIndex = clientRequest.mock.calls.findIndex(
        ([method]) => method === "sessions.move",
      );
      const result = clientRequest.mock.results[moveIndex]!.value;
      if (retired) {
        changeScope("main");
        changeScope("writer");
        await page.updateComplete;
        await vi.waitFor(() => expect(page.loading).toBe(false));
        page.error = "New foreground error.";
      }
      const failure = new Error("Old placement failed.");
      if (fails) {
        pending.reject(failure);
      } else {
        pending.resolve({ ok: true });
      }
      await Promise.resolve(result).catch(() => undefined);
      await page.updateComplete;
      if (retired) {
        expect(reconcileMutation).not.toHaveBeenCalled();
        expect(page.textContent).toContain("New foreground error.");
        expect(page.textContent).not.toContain("Old placement failed.");
      } else {
        await vi.waitFor(() => expect(page.error).toBe(failure));
        expect(reconcileMutation).toHaveBeenCalledWith("writer");
      }
    },
  );

  it.each(["enumeration", "confirmation"])(
    "retires pending %s after switching away and back",
    async (phase) => {
      const listResponse = createDeferred<SessionsListResult>();
      const confirmation = createDeferred<boolean>();
      const list = vi.fn<SessionCapability["list"]>().mockReturnValue(listResponse.promise);
      const deleteMany = vi.fn(async () => deleted(writerKeys));
      const sessions = createSessions({ list, deleteMany });
      const { page, changeScope } = await setupArchivedPage(sessions);
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
      if (phase === "confirmation") {
        listResponse.resolve({ ...archivedWriterRows(), hasMore: false, nextOffset: null });
      }
      const operation = page.deleteAllArchived();
      await vi.waitFor(() =>
        expect(phase === "enumeration" ? list : showConfirmDialog).toHaveBeenCalledOnce(),
      );
      const signal = vi.mocked(showConfirmDialog).mock.calls[0]?.[0].signal;
      if (phase === "confirmation") {
        expect(signal?.aborted).toBe(false);
      }
      changeScope("main");
      changeScope("writer");
      if (phase === "confirmation") {
        expect(signal?.aborted).toBe(true);
        await page.updateComplete;
        await vi.waitFor(() => expect(page.loading).toBe(false));
      }
      listResponse.resolve(archivedWriterRows());
      confirmation.resolve(true);
      await operation;
      if (phase === "enumeration") {
        expect(showConfirmDialog).not.toHaveBeenCalled();
      }
      expect(deleteMany).not.toHaveBeenCalled();
      expect(page.error).toBeNull();
    },
  );

  it("admits a new deep-link delete without letting old completion release it", async () => {
    const oldDelete = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const newDelete = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const deleteMany = vi
      .fn<SessionCapability["deleteMany"]>()
      .mockReturnValueOnce(oldDelete.promise)
      .mockReturnValueOnce(newDelete.promise)
      .mockResolvedValue(deleted());
    const sessions = createSessions({ deleteMany });
    const key = "agent:writer:old-1";
    const { page, changeScope } = await setupArchivedPage(sessions, key);
    const query = vi.mocked(sessions.subscribeList).mock.calls.at(-1)?.[0];
    expect(query).toMatchObject({ search: key, agentId: "writer" });
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const oldRequest = page.deleteSessionFromMenu(archivedRow(key));
    let newRequest: ReturnType<typeof page.deleteSessionFromMenu> | undefined;
    try {
      await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(1));
      changeScope("main");
      await page.updateComplete;
      await vi.waitFor(() => expect(page.loading).toBe(false));
      expect(vi.mocked(sessions.subscribeList).mock.calls.at(-1)?.[0]).toEqual(query);

      newRequest = page.deleteSessionFromMenu(archivedRow(key));
      await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(2));
      expect(deleteMany.mock.calls[1]?.[0]).toEqual([
        { key, agentId: undefined, archivedOnly: true },
      ]);

      oldDelete.resolve({
        ...deleted(),
        errors: [{ target: { key }, error: new Error("retired delete error") }],
      });
      await oldRequest;
      expect(page.error).toBeNull();
      changeScope("main");
      await page.deleteSessionFromMenu(archivedRow(key));
      expect(deleteMany).toHaveBeenCalledTimes(2);

      newDelete.resolve(deleted());
      await newRequest;
      await page.deleteSessionFromMenu(archivedRow(key));
      expect(deleteMany).toHaveBeenCalledTimes(3);
    } finally {
      oldDelete.resolve(deleted());
      newDelete.resolve(deleted());
      await Promise.all([oldRequest, newRequest]);
    }
  });
});

describe("session selection across roster refresh", () => {
  it.each(["replaced", "replacement without IDs during confirmation", "removed"] as const)(
    "deletes only still-selected session identities after a row is %s",
    async (change) => {
      const missingIds = change === "replacement without IDs during confirmation";
      const confirmation = createDeferred<boolean>();
      const rows = Array.from({ length: 27 }, (_, index) =>
        sessionRow(`selection-${index}`, {
          sessionId: index === 0 && missingIds ? undefined : `selected-generation-${index}`,
          updatedAt: 100 - index,
        }),
      );
      const [original, stable] = [rows[0]!, rows[1]!];
      let serverRows = rows;
      let revision = 0;
      const deletedTargets: SessionDeleteTarget[] = [];
      const { context, sessions } = liveSessions<SessionDeleteTarget>({
        "sessions.subscribe": () => ({ subscribed: true }),
        "sessions.list": () =>
          sessionsResult(
            serverRows.filter((row) => !row.archived),
            ++revision,
          ),
        "sessions.delete": (target) => {
          if (!target) {
            throw new Error("Missing delete target");
          }
          deletedTargets.push(target);
          serverRows = serverRows.filter((row) => row.key !== target.key);
          return { deleted: true };
        },
      });
      const subscribe = vi.spyOn(sessions, "subscribeList");
      const page = await createRenderedPage(context, sessionsResult(rows, revision));
      try {
        selectRows(page, original, stable);
        page.onPageChange(1);
        await page.updateComplete;
        expect(page.selectedSessions.size).toBe(2);
        expect(page.querySelector(".data-table-bulk-bar")?.textContent).toContain("2 selected");

        vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
        let deletion: ReturnType<typeof page.deleteSelected> | undefined;
        if (missingIds) {
          deletion = page.deleteSelected();
          expect(showConfirmDialog).toHaveBeenCalledOnce();
        }
        if (change === "removed") {
          serverRows = rows.slice(1);
        } else {
          serverRows = [
            {
              ...original,
              label: "Replacement session",
              sessionId: missingIds ? undefined : "replacement-generation",
            },
            ...rows.slice(1),
          ];
        }
        await sessions.refreshList({ ...subscribe.mock.calls[0]![0], force: true });
        await page.updateComplete;
        if (!missingIds) {
          deletion = page.deleteSelected();
        }
        confirmation.resolve(true);
        await deletion;
        expect(serverRows.some((row) => row.key === stable.key)).toBe(false);
        if (change !== "removed") {
          expect(serverRows.find((row) => row.key === original.key)?.label).toBe(
            "Replacement session",
          );
        }

        expect(deletedTargets).toMatchObject([
          { key: stable.key, expectedSessionId: stable.sessionId },
        ]);
      } finally {
        page.remove();
        sessions.dispose();
      }
    },
  );
});
