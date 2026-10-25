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

function job(
  kind: PayloadKind,
  sessionTarget: CronStoredJob["sessionTarget"] = "isolated",
  trigger = true,
) {
  return makeCronJob({
    payload: PAYLOADS[kind],
    sessionTarget,
    ...(trigger ? { trigger: { script: "return { fire: true }" } } : {}),
  });
}
type RouteCase = [PayloadKind, CronStoredJob["sessionTarget"], string?, boolean?];

describe("scheduled occurrence admission", () => {
  it.each<RouteCase>([
    ["agentTurn", "isolated", "runIsolatedAgentJob"],
    ["agentTurn", "current", "runIsolatedAgentJob", false],
    ["agentTurn", "session:agent:main:dashboard:parent", "runSessionEvent"],
    ["agentTurn", "main", "runSessionEvent"],
    ["systemEvent", "isolated"],
    ["systemEvent", "session:agent:main:dashboard:parent"],
    ["systemEvent", "main", "runSessionEvent"],
    ["command", "isolated", "runCommandJob"],
    ["command", "main"],
    ["script", "isolated", "runScriptJob"],
  ])(
    "admits %s on %s once for its trigger and executor",
    async (kind, target, executor, trigger = true) => {
      const { state, admitted, release, seen } = harness();
      await executeJobCore(state, job(kind, target, trigger));
      expect(admitted).toHaveLength(1);
      expect(seen).toEqual(
        [...(trigger ? ["evaluateCronTrigger"] : []), ...(executor ? [executor] : [])].map(
          (executorName) => ({ executor: executorName, occurrence: admitted[0] }),
        ),
      );
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("admits before evaluating a trigger that does not fire", async () => {
    const { state, admitted, release } = harness();
    state.deps.evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: false,
    }));
    await executeJobCore(state, job("agentTurn"));
    expect(admitted).toHaveLength(1);
    expect(state.deps.evaluateCronTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence: admitted[0] }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it.each<PayloadKind>(["agentTurn", "systemEvent", "script", "command"])(
    "a paused %s blocks trigger and payload except host commands",
    async (kind) => {
      const { state, seen } = harness();
      const pause = {
        reason: "archived" as const,
        parentSessionKey: "agent:main:dashboard:parent",
      };
      state.deps.admitScheduledOccurrence = async () => ({
        ...unadmittedScheduledOccurrence("paused"),
        pause,
      });
      const result = await executeJobCore(state, job(kind));
      if (kind === "command") {
        expect(result).not.toHaveProperty("parentUnavailable");
        expect(seen.map((call) => call.executor)).toEqual(["evaluateCronTrigger", "runCommandJob"]);
      } else {
        expect(seen).toEqual([]);
        expect(result).toMatchObject({
          status: "skipped",
          parentUnavailable: pause,
          executionStarted: false,
        });
      }
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
