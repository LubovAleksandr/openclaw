/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { openSubmenu, selectMenuValue } from "../../test-helpers/session-menu.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createContext,
  createGateway,
  createLiveSessionContext,
  createManagedSessions,
  createRenderedPage,
  openRowMenu,
  selectRows,
  sessionRow,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: vi.fn(),
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

function commandSession(handlers: Record<string, () => unknown>) {
  return createLiveSessionContext(
    createTestGatewayClient((method) => {
      if (!Object.hasOwn(handlers, method)) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return handlers[method]!();
    }),
  );
}

describe("sessions page lifecycle", () => {
  it("presents owner-started refreshes without replacing controls or rows", async () => {
    const target = sessionRow("retained", { sessionId: "retained-generation" });
    const initial = sessionsResult([target], 1);
    const managed = createManagedSessions();
    const context = createContext(createGateway().gateway, managed.sessions);
    const page = await createRenderedPage(context, initial);
    const pending = createDeferred();
    const searchInput = () =>
      page.querySelector<HTMLInputElement>(".sessions-filter-popover__search input")!;
    try {
      const [query] = managed.subscribeList.mock.calls[0]!;
      const input = searchInput();
      const row = page.querySelector("tbody tr");
      selectRows(page, target);
      await page.updateComplete;
      const refresh = () => page.querySelector<HTMLButtonElement>(".sessions-toolbar__refresh")!;
      const publish = (loading: boolean, error: string | null = null) =>
        managed.publish(query, { result: initial, agentId: "main", loading, error });

      const failure = "Synthetic background refresh failure";
      for (const [loading, error] of [
        [true, null],
        [false, failure],
        [true, null],
        [false, null],
      ] as const) {
        publish(loading, error);
        await vi.waitFor(() => {
          expect(refresh().disabled).toBe(false);
          expect(searchInput()).toBe(input);
          expect(page.querySelector("tbody tr")).toBe(row);
          expect(page.selectedSessions.has(target.key)).toBe(true);
          if (error) {
            expect(page.textContent).toContain(error);
          } else if (!loading) {
            expect(page.querySelector(".sessions-error")).toBeNull();
          }
        });
      }

      managed.refreshList.mockImplementationOnce(async () => {
        publish(true);
        await pending.promise;
        publish(false);
      });
      refresh().click();
      await vi.waitFor(() => expect(refresh().disabled).toBe(true));
      pending.resolve();
      await vi.waitFor(() => expect(refresh().disabled).toBe(false));
      expect(page.querySelector("tbody tr")).toBe(row);
    } finally {
      pending.resolve();
      page.remove();
    }
  });

  it("shows command progress while the session owner holds its follow-up roster read", async () => {
    const target = sessionRow("held-command", { label: "Before edit" });
    const refreshed = createDeferred<ReturnType<typeof sessionsResult>>();
    const readStarted = createDeferred();
    let edited = false;
    const { context, sessions } = commandSession({
      "sessions.list": () => {
        if (edited) {
          readStarted.resolve();
          return refreshed.promise;
        }
        return sessionsResult([target], 1);
      },
      "sessions.describe": () => ({ session: target }),
      "sessions.patch": () => {
        edited = true;
        return { ok: true, path: "", key: target.key, entry: { sessionId: target.sessionId } };
      },
    });
    const page = await createRenderedPage(context, sessionsResult([target], 1), "all");
    const next = sessionsResult([{ ...target, label: "After edit" }], 2);
    try {
      page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
      await waitForFast(() =>
        expect(
          page.querySelector<HTMLInputElement>(".session-overrides-grid input")?.disabled,
        ).toBe(false),
      );
      const label = page.querySelector<HTMLInputElement>(".session-overrides-grid input")!;
      label.value = "After edit";
      label.dispatchEvent(new Event("change", { bubbles: true }));
      await readStarted.promise;
      await waitForFast(() => expect(page.textContent).toContain("Working…"));
      refreshed.resolve(next);
      await waitForFast(() => expect(page.textContent).not.toContain("Working…"));
      expect(page.textContent).toContain("After edit");
    } finally {
      refreshed.resolve(next);
      page.remove();
      sessions.dispose();
    }
  });

  it("clears failed command feedback on Refresh and retry while retaining roster read errors", async () => {
    const target = sessionRow("retry-command", { label: "Retry command fixture" });
    let rows = [target];
    let deletionAttempts = 0;
    let readFails = false;
    const { context } = commandSession({
      "sessions.list": () => {
        if (readFails) {
          throw new Error("Roster unavailable. Refresh to recover.");
        }
        return sessionsResult(rows, 1);
      },
      "sessions.delete": () => {
        if (++deletionAttempts < 3) {
          throw new Error("Deletion unavailable. Try again.");
        }
        rows = [];
        readFails = true;
        return { deleted: true };
      },
    });
    const page = await createRenderedPage(context, sessionsResult(rows, 1), "all");
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const deletionError = "Deletion unavailable. Try again.";
    const rosterError = "Roster unavailable. Refresh to recover.";
    const remove = async () => {
      const menu = await openRowMenu(page, target);
      await openSubmenu(menu, "Advanced");
      await selectMenuValue(menu, "delete");
    };
    const refresh = () => page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
    await remove();
    await waitForFast(() => expect(page.textContent).toContain(deletionError));
    refresh().click();
    await waitForFast(() => expect(page.textContent).not.toContain(deletionError));
    await remove();
    await waitForFast(() => expect(page.textContent).toContain(deletionError));
    await remove();
    await waitForFast(() => expect(page.textContent).toContain(rosterError));
    expect(page.textContent).not.toContain(deletionError);
    readFails = false;
    refresh().click();
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).toBeNull());
  });
});
