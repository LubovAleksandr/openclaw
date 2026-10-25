import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { wake } from "./wake.js";

function createState(jobs: CronJob[] = []) {
  const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
  const deferSessionEvent = vi.fn<NonNullable<CronServiceDeps["deferSessionEvent"]>>();
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "unused-wake-receiver-store",
    nowMs: () => 10_000,
    cronEnabled: true,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    enqueueSessionEvent,
    deferSessionEvent,
    resolveSessionEventTarget: (opts) => ({
      agentId: opts?.agentId ?? "main",
      sessionKey: opts?.sessionKey ?? `agent:${opts?.agentId ?? "main"}:main`,
    }),
  });
  state.store = { version: 1, jobs };
  return {
    state,
    enqueueSessionEvent,
    deferSessionEvent,
  };
}

function receiverJob(overrides: Partial<CronJob>) {
  return makeCronJob({
    id: "scheduled-session",
    createdAtMs: 0,
    updatedAtMs: 0,
    payload: { kind: "agentTurn", message: "check pending work" },
    sessionTarget: "main",
    wakeMode: "now",
    state: { nextRunAtMs: 60_000 },
    ...overrides,
  });
}

function expectDeferred(fixture: ReturnType<typeof createState>, job: CronJob, at = 60_000) {
  expect(fixture.deferSessionEvent).toHaveBeenCalledExactlyOnceWith(
    "ping",
    job,
    undefined,
    expect.any(Function),
    at,
    undefined,
    undefined,
  );
  expect(fixture.enqueueSessionEvent).not.toHaveBeenCalled();
}

describe("wake (cron timer)", () => {
  it.each([
    { name: "empty text", mode: "now", text: "   ", expected: { ok: false } },
    {
      name: "no scheduled receiver",
      mode: "next-heartbeat",
      text: "ping",
      expected: {
        ok: false,
        reason: expect.stringContaining("No enabled ordinary scheduled session job"),
      },
    },
    {
      name: "subagent target",
      mode: "now",
      text: "ping",
      sessionKey: "agent:main:subagent:worker",
      expected: { ok: false, reason: "unwakeable-session-key" },
    },
  ] as const)(
    "rejects $name without enqueueing or waking",
    async ({ expected, name: _name, ...opts }) => {
      const { state, enqueueSessionEvent, deferSessionEvent } = createState();
      expect(await wake(state, opts)).toEqual(expected);
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
      expect(deferSessionEvent).not.toHaveBeenCalled();
    },
  );

  it("threads sessionKey into ordinary session admission on mode=now", async () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(
      await wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:telegram:dm:42",
      }),
    ).toEqual({ ok: true });
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("ping", {
      sessionKey: "agent:main:telegram:dm:42",
    });
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it.each([
    { name: "recurring", schedule: { kind: "every", everyMs: 60_000 } },
    { name: "one-shot", schedule: { kind: "at", at: new Date(60_000).toISOString() } },
    {
      name: "all-day one-shot",
      schedule: { kind: "at", at: new Date(60_000).toISOString() },
      activeHours: { start: "00:00", end: "24:00", timezone: "UTC" },
    },
    {
      name: "conditional recurring",
      schedule: { kind: "every", everyMs: 60_000 },
      trigger: { script: "return false" },
      activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
    },
  ] satisfies Array<{ name: string } & Pick<CronJob, "schedule" | "trigger" | "activeHours">>)(
    "defers untargeted next-heartbeat work to an enabled $name session job",
    async (receiver) => {
      const job = receiverJob(receiver);
      const fixture = createState([{ ...job, id: "other-owner", agentId: "other" }, job]);
      expect(await wake(fixture.state, { mode: "next-heartbeat", text: "ping" })).toEqual({
        ok: true,
      });
      expectDeferred(fixture, job);
    },
  );

  it("does not accept deferred notices onto a one-shot with restricted active hours", async () => {
    const job = receiverJob({
      id: "conditional-one-shot",
      schedule: { kind: "at", at: new Date(60_000).toISOString() },
      name: "Conditional one-shot",
      activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
    });
    const fixture = createState([job]);
    const { state, enqueueSessionEvent, deferSessionEvent } = fixture;
    expect(await wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({
      ok: false,
      reason: expect.stringContaining("No enabled ordinary scheduled session job"),
    });
    expect(deferSessionEvent).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).not.toHaveBeenCalled();

    const unconditional: CronJob = {
      ...job,
      id: "later-one-shot",
      trigger: undefined,
      activeHours: undefined,
      schedule: { kind: "at", at: new Date(120_000).toISOString() },
      state: { nextRunAtMs: 120_000 },
    };
    state.store!.jobs.push(unconditional);
    expect(await wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({ ok: true });
    expectDeferred(fixture, unconditional, 120_000);
  });

  it("returns the ordinary admission refusal instead of reporting a lost wake as accepted", async () => {
    const { state, enqueueSessionEvent } = createState();
    enqueueSessionEvent.mockResolvedValueOnce({ ok: false, error: "session was replaced" });
    await expect(wake(state, { mode: "now", text: "pending reminder" })).resolves.toEqual({
      ok: false,
      reason: "session was replaced",
    });
  });

  it("rechecks requester authority after resolving the origin route", async () => {
    const { state, enqueueSessionEvent } = createState();
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    state.deps.resolveOriginDeliveryContext = async () => {
      entered.resolve();
      await release.promise;
      return undefined;
    };
    const pending = wake(state, {
      mode: "now",
      text: "pending reminder",
      sessionKey: "agent:main:project:notes",
      commitGuard: () => {
        if (!current) {
          throw new Error("requester authority revoked");
        }
      },
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "Wake skipped route resolution");
      current = false;
      release.resolve();
      await expect(pending).rejects.toThrow("requester authority revoked");
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  });
});
