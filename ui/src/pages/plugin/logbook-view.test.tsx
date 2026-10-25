import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createLogbook } from "./logbook-state.ts";
import { Logbook } from "./logbook-view.tsx";
import { logbookClient, logbookStatus, logbookTimeline } from "./logbook.test-support.ts";
const neverRetired = new Promise<void>(() => {});

function mountLogbook(request: Parameters<typeof logbookClient>[0]) {
  return mountSolid(() => (
    <Logbook initialClient={logbookClient(request)} getRetired={() => neverRetired} />
  ));
}

async function advance(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

function dayResponse(method: string, day: string, title: string) {
  return method === "logbook.status" ? logbookStatus(day) : logbookTimeline(day, [{ title }], 1);
}

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Logbook view", () => {
  it("renders timeline clocks in the capture host timezone and preserves detail text", async () => {
    vi.spyOn(i18n, "getLocale").mockReturnValue("en");
    const day = "2026-01-01";
    const status = logbookStatus(day, { timeZone: "America/Los_Angeles" });
    const timeline = logbookTimeline(day, [
      {
        startMs: Date.UTC(2026, 0, 2, 0, 30),
        endMs: Date.UTC(2026, 0, 2, 1, 30),
        detail: "  API_TOKEN = computeToken()  ",
      },
    ]);
    const request = vi.fn(async (method: string) =>
      structuredClone(method === "logbook.status" ? status : timeline),
    );
    const { container } = mountLogbook(request);
    const detail = () => container.querySelector(".logbook-card__detail")?.textContent;
    await waitForSolid(() =>
      expect(container.querySelector(".logbook-card__header")).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>(".logbook-card__header")!.click();
    flush();

    expect(container.querySelector(".logbook-card__time")?.textContent?.trim()).toBe(
      "04:30 PM–05:30 PM",
    );
    expect(container.querySelector(".logbook-card__duration")?.textContent?.trim()).toBe("1h");
    expect(detail()).toBe("API_TOKEN = computeToken()");
  });

  it("keeps action focus and capture toggle state current across refreshes", async () => {
    vi.useFakeTimers();
    const day = "2026-01-01";
    let serverStatus = logbookStatus(day, { captureEnabled: false, todayCards: 0 });
    const timeline = logbookTimeline(day);
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "logbook.capture.set") {
        serverStatus = { ...serverStatus, capturePaused: (params as { paused: boolean }).paused };
        return serverStatus;
      }
      if (method === "logbook.status") {
        return serverStatus;
      }
      if (method === "logbook.timeline") {
        return timeline;
      }
      throw new Error(`Unexpected Logbook request: ${method}`);
    });
    const view = mountLogbook(request);
    await waitForSolid(() => expect(view.queryByRole("button", { name: "Pause" })).not.toBeNull());
    const toggle = view.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    const analyze = view.getByRole("button", { name: "Analyze now" });
    analyze.focus();
    expect(document.activeElement).toBe(analyze);

    serverStatus = { ...serverStatus, captureEnabled: true };
    await advance(30_000);
    expect(view.getByRole("button", { name: "Pause" })).toBe(toggle);
    expect(toggle.disabled).toBe(false);
    expect(view.getByRole("button", { name: "Analyze now" })).toBe(analyze);
    expect(document.activeElement).toBe(analyze);

    for (const paused of [true, false]) {
      toggle.click();
      await advance();
      expect(view.getByRole("button", { name: paused ? "Resume" : "Pause" })).toBe(toggle);
      expect(toggle.disabled).toBe(false);
      expect(request).toHaveBeenCalledWith("logbook.capture.set", { paused });
    }

    serverStatus = { ...serverStatus, captureEnabled: false };
    await advance(30_000);
    expect(toggle.disabled).toBe(true);
  });
});

function pendingRefresh(title?: string) {
  const status = createDeferred<unknown>();
  const timeline = createDeferred<unknown>();
  const pending = new Map([
    ["logbook.status", status],
    ["logbook.timeline", timeline],
  ]);
  const request = vi.fn((method: string) => {
    if (method === "logbook.analyze.now") {
      return Promise.resolve({ started: true });
    }
    const response = pending.get(method);
    if (response) {
      pending.delete(method);
      return response.promise;
    }
    if (title === undefined) {
      throw new Error(`Unexpected refresh request: ${method}`);
    }
    return Promise.resolve(dayResponse(method, "2026-07-04", title));
  });
  return {
    request,
    resolve: (settledTitle: string) => {
      status.resolve(logbookStatus("2026-07-04"));
      timeline.resolve(dayResponse("logbook.timeline", "2026-07-04", settledTitle));
    },
  };
}

describe("Logbook request ownership", () => {
  const disposals: Array<() => void> = [];
  const createModel = (request: Parameters<typeof logbookClient>[0]) => {
    const model = createRoot((dispose) => {
      disposals.push(dispose);
      return Object.assign(createLogbook(logbookClient(request)), { dispose });
    });
    flush();
    return model;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 4, 12));
  });

  afterEach(() => {
    for (const dispose of disposals.splice(0)) {
      dispose();
    }
    vi.useRealTimers();
  });

  it("does not poll from a render discarded before settlement", () => {
    const request = vi.fn(async () => null);
    const dispose = createRoot((disposeRoot) => {
      disposals.push(disposeRoot);
      createLogbook(logbookClient(request));
      return disposeRoot;
    });
    vi.advanceTimersByTime(30_000);
    expect(request).not.toHaveBeenCalled();
    dispose();
    vi.advanceTimersByTime(30_000);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["poll", "analysis", "queued analysis", "disposed"] as const)(
    "serializes %s refreshes and admits only live results",
    async (mode) => {
      const { request, resolve } = pendingRefresh(mode === "disposed" ? undefined : "Resumed poll");
      const model = createModel(request);
      const state = model.state;
      if (mode === "analysis") {
        await model.analyze();
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(request).toHaveBeenCalledTimes(2);
      }
      if (mode === "queued analysis" || mode === "disposed") {
        await model.analyze();
      }
      const initialCalls = mode === "poll" ? 2 : 3;
      expect(request).toHaveBeenCalledTimes(initialCalls);
      if (mode === "disposed") {
        model.dispose();
      }
      await vi.advanceTimersByTimeAsync(
        mode === "poll" ? 90_000 : mode === "analysis" ? 60_000 : 0,
      );
      expect(request).toHaveBeenCalledTimes(initialCalls);
      resolve("First refresh");
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "disposed") {
        expect(request).toHaveBeenCalledTimes(3);
        expect(state.timeline).toBeNull();
        return;
      }
      if (mode !== "queued analysis") {
        expect(state.timeline?.cards[0]?.title).toBe("First refresh");
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(request).toHaveBeenCalledTimes(initialCalls + 2);
      expect(state.timeline?.cards[0]?.title).toBe("Resumed poll");
    },
  );

  it("keeps analysis locked until its request settles", async () => {
    const newAnalysis = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "logbook.analyze.now") {
        return newAnalysis.promise;
      }
      return Promise.resolve(dayResponse(method, state.day, "Current analysis"));
    });
    const model = createModel(request);
    const state = model.state;
    const newRequest = model.analyze();

    expect(state.actionPending).toBe(true);
    await model.analyze();
    expect(request).toHaveBeenCalledTimes(1);

    newAnalysis.resolve({ started: true });
    await newRequest;
    expect(state.actionPending).toBe(false);
  });

  it("discards a capture result after its polling owner retires", async () => {
    const pending = createDeferred<unknown>();
    const model = createModel(() => pending.promise);
    const request = model.setCapturePaused(true);
    model.dispose();
    pending.resolve(logbookStatus("2026-07-04"));
    await request;
    expect(model.state.status).toBeNull();
  });

  it("does not let an older day load overwrite a newer selection", async () => {
    const { request: oldRequest, resolve } = pendingRefresh();
    const newerRequest = vi.fn(async (method: string) =>
      dayResponse(method, "2026-07-05", "New day"),
    );

    let read: (method: string, params: unknown) => Promise<unknown> = oldRequest;
    const model = createModel((method, params) => read(method, params));
    const state = model.state;
    const olderLoad = model.load({ day: "2026-07-04" });
    expect(oldRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-04" });

    read = newerRequest;
    await model.load({ day: "2026-07-05" });
    expect(newerRequest).toHaveBeenCalledWith("logbook.timeline", { day: "2026-07-05" });
    expect(state.timeline?.cards[0]?.title).toBe("New day");

    resolve("Old day");
    await olderLoad;

    expect(state).toMatchObject({
      day: "2026-07-05",
      status: { today: "2026-07-05" },
      loading: false,
    });
    expect(state.timeline?.cards[0]?.title).toBe("New day");
  });

  it.each(["standup", "ask"] as const)(
    "discards a %s response after the selected day changes",
    async (action) => {
      const pending = createDeferred<unknown>();
      const model = createModel((method) =>
        method === "logbook.status" || method === "logbook.timeline"
          ? Promise.resolve(dayResponse(method, "2026-07-05", "Next day"))
          : pending.promise,
      );
      const state = model.state;
      const request = action === "standup" ? model.standup(false) : model.ask("What did I do?");

      await model.load({ day: "2026-07-05" });
      pending.resolve(
        action === "standup"
          ? { day: "2026-07-04", text: "Old day", updatedMs: 1 }
          : { answer: "Old day" },
      );
      await request;

      expect(action === "standup" ? state.standup : state.askAnswer).toBeNull();
    },
  );
});
