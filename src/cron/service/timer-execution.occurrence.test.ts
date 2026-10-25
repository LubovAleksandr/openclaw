import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import {
  unadmittedScheduledOccurrence,
  type ScheduledOccurrence,
} from "../scheduled-occurrence.js";
import type { CronStoredJob } from "../types.js";
import { executeJobCore } from "./timer-execution.js";

type PayloadKind = CronStoredJob["payload"]["kind"];
const PAYLOADS = {
  agentTurn: { kind: "agentTurn", message: "work" },
  systemEvent: { kind: "systemEvent", text: "check in" },
  command: { kind: "command", argv: ["true"] },
  script: { kind: "script", script: "return {}" },
} satisfies Record<PayloadKind, CronStoredJob["payload"]>;
const PAYLOAD_KINDS: readonly PayloadKind[] = ["agentTurn", "systemEvent", "command", "script"];
const SESSION_TARGETS: readonly CronStoredJob["sessionTarget"][] = [
  "isolated",
  "current",
  "session:agent:main:dashboard:parent",
  "main",
];
// Expected routes in SESSION_TARGETS order, independent of the dispatch implementation.
const EXECUTORS = {
  agentTurn: ["runIsolatedAgentJob", "runIsolatedAgentJob", "runSessionEvent", "runSessionEvent"],
  systemEvent: [undefined, undefined, undefined, "runSessionEvent"],
  command: ["runCommandJob", "runCommandJob", "runCommandJob", undefined],
  script: ["runScriptJob", "runScriptJob", "runScriptJob", "runScriptJob"],
} satisfies Record<PayloadKind, readonly (string | undefined)[]>;

function harness() {
  const admitted: ScheduledOccurrence[] = [];
  const release = vi.fn();
  const seen: Array<{ executor: string; occurrence: unknown }> = [];
  const record =
    (executor: string, result: Record<string, unknown> = { status: "ok" }) =>
    async (params: { occurrence?: unknown }) => {
      seen.push({ executor, occurrence: params.occurrence });
      return result as never;
    };
  const state = createCronRegressionState({
    storePath: "/tmp/cron-occurrence-matrix.json",
    admitScheduledOccurrence: vi.fn(async () => {
      const occurrence = { ...unadmittedScheduledOccurrence("matrix"), release };
      admitted.push(occurrence);
      return occurrence;
    }),
    evaluateCronTrigger: record("evaluateCronTrigger", { kind: "evaluated", fire: true }),
    runScriptJob: record("runScriptJob"),
    runIsolatedAgentJob: record("runIsolatedAgentJob"),
    runSessionEvent: record("runSessionEvent"),
    runCommandJob: record("runCommandJob"),
  });
  return { state, admitted, release, seen };
}

const MATRIX = PAYLOAD_KINDS.flatMap((kind) =>
  SESSION_TARGETS.flatMap((sessionTarget, index) =>
    [false, true].map((withTrigger) => ({
      kind,
      sessionTarget,
      withTrigger,
      executor: EXECUTORS[kind][index],
    })),
  ),
);

function matrixJob({ kind, sessionTarget, withTrigger }: (typeof MATRIX)[number]): CronStoredJob {
  return makeCronJob({
    payload: PAYLOADS[kind],
    sessionTarget,
    ...(withTrigger ? { trigger: { script: "return { fire: true }" } } : {}),
  });
}

describe("scheduled occurrence admission", () => {
  it.each(MATRIX)(
    "$kind on $sessionTarget (trigger: $withTrigger) runs every executor with one admitted occurrence",
    async (row) => {
      const { state, admitted, release, seen } = harness();
      await executeJobCore(state, matrixJob(row));
      expect(admitted).toHaveLength(1);
      expect(seen).toEqual(
        [
          ...(row.withTrigger ? ["evaluateCronTrigger"] : []),
          ...(row.executor ? [row.executor] : []),
        ].map((executor) => ({ executor, occurrence: admitted[0] })),
      );
      // The occurrence outlives every executor it admitted and is released once.
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("admits before trigger evaluation, so a trigger that does not fire still consumes it", async () => {
    const { state, admitted, release } = harness();
    state.deps.evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: false,
    }));
    await executeJobCore(state, {
      ...makeCronJob({ payload: PAYLOADS.agentTurn }),
      trigger: { script: "return { fire: false }" },
    });
    expect(admitted).toHaveLength(1);
    expect(state.deps.evaluateCronTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence: admitted[0] }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(MATRIX)(
    "a paused $kind occurrence on $sessionTarget (trigger: $withTrigger) runs nothing",
    async (row) => {
      const { kind, sessionTarget } = row;
      const { state, seen } = harness();
      const pause = {
        reason: "archived" as const,
        parentSessionKey: "agent:main:dashboard:parent",
      };
      state.deps.admitScheduledOccurrence = async () => ({
        ...unadmittedScheduledOccurrence("paused"),
        pause,
      });
      const result = await executeJobCore(state, matrixJob(row));
      if (kind === "command") {
        // Command jobs do not pause on a missing parent; they still run with the occurrence.
        expect(result).not.toHaveProperty("parentUnavailable");
        if (sessionTarget !== "main") {
          expect(seen.map((call) => call.executor)).toContain("runCommandJob");
        }
        return;
      }
      expect(seen).toEqual([]);
      expect(result).toMatchObject({
        status: "skipped",
        parentUnavailable: pause,
        executionStarted: false,
      });
    },
  );

  it("gives every run a fail context when no admitter is configured", async () => {
    const { state, seen } = harness();
    delete state.deps.admitScheduledOccurrence;
    await executeJobCore(state, makeCronJob({ payload: PAYLOADS.agentTurn }));
    const occurrence = seen[0]?.occurrence as ScheduledOccurrence;
    expect(
      occurrence.mint({
        cfg: {},
        agentId: "main",
        runId: "run",
        runSessionKey: "agent:main:cron:job",
        operatorAuthorityRestored: false,
      }).result,
    ).toEqual({ status: "fail", error: "occurrence admission is not configured" });
  });
});
