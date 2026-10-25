import { afterEach, describe, expect, it, vi } from "vitest";

const buildMatrixQaConfig = vi.hoisted(() =>
  vi.fn(() => ({ channels: { matrix: { execApprovals: { enabled: true } } } })),
);
const runMatrixQaCanary = vi.hoisted(() =>
  vi.fn(async () => ({
    driverEventId: "$canary-driver",
    reply: { eventId: "$canary-reply" },
    token: "MATRIX_QA_CANARY",
  })),
);

vi.mock("../substrate/config.js", () => ({ buildMatrixQaConfig }));
vi.mock("./scenario-runtime-room.js", () => ({ runMatrixQaCanary }));

import { createMatrixQaScenarioEnvironment } from "./scenario-environment.js";

afterEach(() => {
  vi.useRealTimers();
});

function createEnvironment() {
  return createMatrixQaScenarioEnvironment({
    accountId: "sut",
    harness: { baseUrl: "http://127.0.0.1:8008", recording: {} } as never,
    observedEvents: [],
    provisioning: {
      observationAccounts: {
        driver: { accessToken: "driver-room-observation" },
        observer: { accessToken: "observer-room-observation" },
      },
      driver: { accessToken: "fixture", userId: "@driver:test" },
      observer: { accessToken: "fixture", userId: "@observer:test" },
      roomId: "!room:test",
      sut: { accessToken: "fixture", userId: "@sut:test" },
      topology: { rooms: [] },
    } as never,
  });
}

const gatewayPaths = {
  baseUrl: "http://127.0.0.1:12345",
  runtimeEnv: {},
  tempRoot: "/tmp/matrix-qa",
  workspaceDir: "/tmp/matrix-qa/workspace",
};

type Preparation = Parameters<ReturnType<typeof createEnvironment>["prepareFlow"]>[0];
const prepareInput = (gateway: Preparation["gateway"], overrides: Partial<Preparation> = {}) => ({
  config: {},
  gateway,
  outputDir: "/tmp/matrix-qa/output",
  scenarioId: "matrix-test",
  scenarioTitle: "Matrix test",
  timeoutMs: 8_000,
  waitForConfigRestartSettle: vi.fn(),
  ...overrides,
});
const appliedConfig = (hash = "patched-config-hash") => ({
  appliedConfigHash: hash,
  configRevisionHash: hash,
  hash,
});
const matrixAccounts = (accounts: Record<string, unknown>, enabled?: boolean) => ({
  channels: { matrix: { accounts, ...(enabled === undefined ? {} : { enabled }) } },
});
type CallOptions = { deadlineMs?: number; expectFinal?: boolean; timeoutMs?: number };
function gatewayFor(
  handlers: Record<string, (params?: unknown, opts?: CallOptions) => unknown>,
  onCall?: (method: string, opts?: CallOptions) => void,
) {
  return {
    ...gatewayPaths,
    call: vi.fn(async (method: string, params?: unknown, opts?: CallOptions) => {
      onCall?.(method, opts);
      const handler = handlers[method];
      if (!handler) {
        throw new Error(`unexpected gateway method ${method}`);
      }
      return handler(params, opts);
    }),
  };
}
function configReads(applied: (params?: unknown, opts?: CallOptions) => unknown) {
  return vi
    .fn()
    .mockReturnValueOnce({ config: {} })
    .mockReturnValueOnce({ hash: "config-hash" })
    .mockImplementation(applied);
}

function healthyMatrixStatus(lastStartAt: number) {
  return {
    channelAccounts: {
      matrix: [
        {
          accountId: "sut",
          connected: true,
          healthState: "healthy",
          lastStartAt,
          restartPending: false,
          running: true,
        },
      ],
    },
  };
}

describe("matrix scenario environment", () => {
  it("restores ordered override-heavy config to defaults from fresh current config", async () => {
    buildMatrixQaConfig.mockClear();
    const execApprovalOverrides = {
      agentFilter: ["main", "stale"],
      approvers: ["@driver:test", "@stale:test"],
      sessionFilter: ["matrix", "stale"],
    };
    const audioOverrides = {
      scope: {
        default: "deny" as const,
        rules: [{ action: "deny" as const }],
      },
    };
    const baselineConfig = matrixAccounts({ sut: { enabled: true } }, false);
    const firstTarget = {
      ...matrixAccounts({ sut: { enabled: true, execApprovals: execApprovalOverrides } }, true),
      tools: { media: { audio: audioOverrides } },
    };
    const preservedAccount = { deviceId: "CURRENT-DEVICE", lifecycleState: "preserve" };
    const preservedPlugin = {
      config: { preserve: "matrix-config" },
      hooks: { allowConversationAccess: true },
      llm: { allowModelOverride: true },
      subagent: { allowModelOverride: true },
    };
    const staleAllowlist = ["@driver:test", "@stale:test"];
    const currentConfig = {
      ...matrixAccounts({
        sibling: { enabled: true },
        sut: {
          ...preservedAccount,
          autoJoin: "allowlist",
          autoJoinAllowlist: staleAllowlist,
          dm: { allowFrom: staleAllowlist, sessionScope: "per-user" },
          execApprovals: execApprovalOverrides,
          groupAllowFrom: staleAllowlist,
          groups: {
            "!room:test": { tools: { allow: ["read", "write"], deny: ["shell", "network"] } },
          },
        },
        "qa-driver-bot-source": { enabled: true },
      }),
      messages: { groupChat: { mentionPatterns: ["@sut", "@sut"] } },
      plugins: { entries: { matrix: { ...preservedPlugin, enabled: false } } },
      tools: {
        media: {
          audio: {
            scope: {
              default: "deny",
              rules: [{ action: "allow" }, { action: "deny" }],
            },
          },
          models: [{ provider: "first" }, { provider: "stale" }],
        },
      },
      unrelated: { preserve: true },
    };
    const secondTarget = {
      ...matrixAccounts({
        sibling: { enabled: true },
        sut: {
          ...preservedAccount,
          autoJoinAllowlist: ["@driver:test"],
          dm: { allowFrom: ["@driver:test"] },
          groupAllowFrom: ["@driver:test"],
          groups: { "!room:test": { tools: { allow: ["read"], deny: ["shell"] } } },
        },
      }),
      messages: { groupChat: { mentionPatterns: ["@sut"] } },
      plugins: { entries: { matrix: { ...preservedPlugin, enabled: true } } },
      tools: {
        media: {
          audio: {
            scope: {
              rules: [{ action: "allow" }],
            },
          },
          models: [{ provider: "first" }],
        },
      },
      unrelated: { preserve: true },
    };
    buildMatrixQaConfig
      .mockReturnValueOnce(firstTarget as never)
      .mockReturnValueOnce(secondTarget as never);
    let configReadCount = 0;
    let patchCount = 0;
    let statusCount = 0;
    const gateway = gatewayFor({
      "config.get": () => {
        configReadCount += 1;
        const scenario = Math.ceil(configReadCount / 3);
        const phase = (configReadCount - 1) % 3;
        if (phase === 0) {
          return { config: scenario === 1 ? baselineConfig : currentConfig };
        }
        if (phase === 1) {
          return { hash: `base-${scenario}` };
        }
        return appliedConfig(`patched-${scenario}`);
      },
      "config.patch": () => {
        patchCount += 1;
        return { hash: `patched-${patchCount}`, changedPaths: ["channels.matrix"], ok: true };
      },
      "channels.status": () => {
        statusCount += 1;
        return healthyMatrixStatus(statusCount);
      },
    });
    const environment = createEnvironment();
    const input: Preparation = prepareInput(gateway, {
      config: {
        matrixConfigOverrides: {
          audio: audioOverrides,
          execApprovals: execApprovalOverrides,
        },
      } as Record<string, unknown>,
    });

    await environment.prepareFlow(input);
    input.config = {};
    await environment.prepareFlow(input);

    expect(buildMatrixQaConfig).toHaveBeenNthCalledWith(
      1,
      baselineConfig,
      expect.objectContaining({
        currentConfig: baselineConfig,
        overrides: {
          audio: audioOverrides,
          execApprovals: execApprovalOverrides,
        },
      }),
    );
    expect(buildMatrixQaConfig).toHaveBeenNthCalledWith(
      2,
      baselineConfig,
      expect.objectContaining({ currentConfig, overrides: undefined }),
    );
    const patchCalls = gateway.call.mock.calls.filter(([method]) => method === "config.patch");
    expect(patchCalls).toHaveLength(2);
    const secondPatchParams = patchCalls[1]?.[1] as {
      raw: string;
      replacePaths?: string[];
    };
    const secondPatch = JSON.parse(secondPatchParams.raw) as Record<string, unknown>;
    expect(secondPatch).toMatchObject({
      channels: {
        matrix: {
          accounts: {
            sut: {
              autoJoin: null,
              dm: { sessionScope: null },
              execApprovals: null,
            },
            "qa-driver-bot-source": null,
          },
        },
      },
    });
    expect(secondPatch).toMatchObject({
      tools: { media: { audio: { scope: { default: null } } } },
    });
    expect(
      (secondPatch.plugins as { entries?: Record<string, unknown> }).entries?.matrix as Record<
        string,
        unknown
      >,
    ).toEqual({ enabled: true });
    expect(secondPatchParams.replacePaths).toEqual([
      "channels.matrix.accounts.sut.autoJoinAllowlist",
      "channels.matrix.accounts.sut.dm.allowFrom",
      "channels.matrix.accounts.sut.execApprovals.agentFilter",
      "channels.matrix.accounts.sut.execApprovals.approvers",
      "channels.matrix.accounts.sut.execApprovals.sessionFilter",
      "channels.matrix.accounts.sut.groupAllowFrom",
      "channels.matrix.accounts.sut.groups.!room:test.tools.allow",
      "channels.matrix.accounts.sut.groups.!room:test.tools.deny",
      "messages.groupChat.mentionPatterns",
      "tools.media.audio.scope.rules",
      "tools.media.models",
    ]);
  });

  it("shares the preparation deadline and forwards gateway action options", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const callOrder: string[] = [];
    let revisionReadCount = 0;
    let statusReadCount = 0;
    const revisionTimeouts: number[] = [];
    const statusTimeouts: number[] = [];
    const gateway = gatewayFor(
      {
        "config.get": configReads((_params, opts) => {
          revisionReadCount += 1;
          revisionTimeouts.push(opts?.timeoutMs ?? -1);
          if (revisionReadCount === 1) {
            vi.setSystemTime(56_000);
          }
          return {
            appliedConfigHash: revisionReadCount === 1 ? "old-revision" : "new-revision",
            configRevisionHash: "new-revision",
            hash: "patched-config-hash",
          };
        }),
        "config.patch": () => ({
          hash: "patched-config-hash",
          changedPaths: ["channels.matrix"],
          ok: true,
        }),
        "channels.status": (_params, opts) => {
          statusReadCount += 1;
          statusTimeouts.push(opts?.timeoutMs ?? -1);
          if (statusReadCount === 2) {
            vi.setSystemTime(56_500);
          }
          return healthyMatrixStatus(statusReadCount < 3 ? 100 : 200);
        },
        "exec.approval.request": () => ({ id: "approval-1", status: "accepted" }),
      },
      (method, opts) => {
        callOrder.push(method);
        if (opts?.deadlineMs !== undefined && opts.deadlineMs <= Date.now()) {
          throw new Error("gateway RPC deadline expired");
        }
      },
    );
    const environment = createEnvironment();
    const waitForConfigRestartSettle = vi.fn(async () => {
      callOrder.push("config.settle");
    });

    const preparing = environment.prepareFlow(
      prepareInput(gateway, { waitForConfigRestartSettle }),
    );
    await vi.runAllTimersAsync();
    const prepared = await preparing;
    const scenarioContext = prepared.scenarioContext;
    await scenarioContext.gatewayCall?.(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );

    expect(statusReadCount).toBe(3);
    expect(callOrder).toEqual([
      "config.get",
      "channels.status",
      "config.get",
      "config.patch",
      "config.get",
      "config.get",
      "channels.status",
      "channels.status",
      "exec.approval.request",
    ]);
    expect(revisionTimeouts).toEqual([5_000, 4_000]);
    expect(statusTimeouts).toEqual([5_000, 4_000, 3_500]);
    expect(Date.now()).toBe(56_500);
    expect(scenarioContext.timeoutMs).toBe(8_000);
    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
    expect(gateway.call.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
    const patchCall = gateway.call.mock.calls.find(([method]) => method === "config.patch");
    expect(patchCall?.[1]).not.toHaveProperty("replacePaths");
    expect(gateway.call).toHaveBeenLastCalledWith(
      "exec.approval.request",
      { id: "approval-1" },
      { expectFinal: false, timeoutMs: 1_000 },
    );
  });

  it("surfaces a stale config patch without a second effect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let configReadCount = 0;
    const stale = new Error("config changed since last load");
    const gateway = gatewayFor({
      "config.get": () => {
        configReadCount += 1;
        if (configReadCount === 1) {
          return { config: {} };
        }
        return { hash: `base-${configReadCount}` };
      },
      "config.patch": () => {
        throw stale;
      },
      "channels.status": () => healthyMatrixStatus(100),
    });
    const environment = createEnvironment();

    await expect(environment.prepareFlow(prepareInput(gateway))).rejects.toBe(stale);

    expect(gateway.call.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "channels.status",
      "config.get",
      "config.patch",
    ]);
    expect(
      gateway.call.mock.calls.map((call) => (call[2] as { deadlineMs?: number }).deadlineMs),
    ).toEqual(Array.from({ length: gateway.call.mock.calls.length }, () => 60_000));
  });

  it("requires a fresh account after an effective Matrix token change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let statusReadCount = 0;
    const statusTimeouts: number[] = [];
    const gateway = gatewayFor({
      "config.get": configReads(() => {
        vi.setSystemTime(59_900);
        return appliedConfig();
      }),
      "config.patch": () => ({
        hash: "patched-config-hash",
        changedPaths: ["channels.matrix.accounts.sut.accessToken"],
        noop: false,
        ok: true,
      }),
      "channels.status": (params, opts) => {
        statusReadCount += 1;
        statusTimeouts.push(opts?.timeoutMs ?? -1);
        if (statusReadCount === 2) {
          expect((params as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(100);
          vi.setSystemTime(60_000);
        }
        if (statusReadCount === 3) {
          vi.setSystemTime(60_000);
        }
        return healthyMatrixStatus(100);
      },
    });
    const environment = createEnvironment();
    const waitForConfigRestartSettle = vi.fn();
    const preparing = environment.prepareFlow(
      prepareInput(gateway, { waitForConfigRestartSettle }),
    );
    const outcome = expect(preparing).rejects.toThrow('matrix account "sut" did not become ready');

    await vi.runAllTimersAsync();
    await outcome;

    expect(Date.now()).toBe(60_000);
    expect(statusTimeouts).toEqual([5_000, 100]);
    expect(
      gateway.call.mock.calls.map((call) => (call[2] as { deadlineMs?: number }).deadlineMs),
    ).toEqual(Array.from({ length: gateway.call.mock.calls.length }, () => 60_000));
    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
    expect(gateway.call.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
  });

  it("rejects a stale account start after a delayed failed pre-restart status read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let statusReadCount = 0;
    const mutateState = vi.fn(async () => undefined);
    const gateway = {
      ...gatewayFor({
        "config.get": configReads(() => appliedConfig("config-hash")),
        "config.patch": () => ({ hash: "config-hash", changedPaths: [], noop: true, ok: true }),
        "channels.status": () => {
          statusReadCount += 1;
          if (statusReadCount === 3) {
            vi.setSystemTime(1_500);
            throw new Error("status temporarily unavailable");
          }
          return healthyMatrixStatus(
            statusReadCount === 4 ? 1_200 : statusReadCount === 5 ? 1_500 : 1_600,
          );
        },
      }),
      restartAfterStateMutation: vi.fn(
        async (
          mutate: (context: {
            configPath: string;
            runtimeEnv: NodeJS.ProcessEnv;
            stateDir: string;
            tempRoot: string;
          }) => Promise<void>,
        ) => {
          await mutate({
            configPath: "/tmp/matrix-qa/config.json",
            runtimeEnv: {},
            stateDir: "/tmp/matrix-qa/state",
            tempRoot: "/tmp/matrix-qa",
          });
        },
      ),
    };
    const environment = createEnvironment();
    const prepared = await environment.prepareFlow(prepareInput(gateway, { timeoutMs: 2_000 }));

    const restarting = prepared.scenarioContext.restartGatewayAfterStateMutation?.(mutateState, {
      timeoutMs: 2_000,
    });
    await vi.runAllTimersAsync();
    await restarting;

    expect(mutateState).toHaveBeenCalledOnce();
    expect(statusReadCount).toBe(6);
  });
});
