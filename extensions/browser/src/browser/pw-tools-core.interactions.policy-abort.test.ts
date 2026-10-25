import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserObservedDialogBlockedError } from "./pw-session-contracts.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

// Load after the test harness registers the session module mocks.
const interactions = await import("./pw-tools-core.interactions.actions.js");

type NavigationGuardCall = {
  action: (url: string) => Promise<unknown>;
  onPolicyCheckStarted?: (check: Promise<void>) => void;
  page: { url: () => string };
  signal?: AbortSignal;
};

function policyCheckWithSignal(
  policy: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    return policy;
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? "aborted")),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    policy.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function interactionFixture({ hover = async () => {}, actionFirst = false, dialog = false } = {}) {
  const ctrl = new AbortController();
  const started = createDeferred<void>();
  const policy = createDeferred<void>();
  let policySignal: AbortSignal | undefined;
  let guardSettled = false;
  setPwToolsCoreCurrentPage({ url: vi.fn(() => "about:blank") });
  setPwToolsCoreCurrentRefLocator({ hover: vi.fn(hover) });
  getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
    async ({ action, onPolicyCheckStarted, page, signal }: NavigationGuardCall) => {
      policySignal = signal;
      const actionTask = action(page.url());
      const check = dialog ? policy.promise : policyCheckWithSignal(policy.promise, signal);
      onPolicyCheckStarted?.(check);
      started.resolve();
      try {
        if (actionFirst) {
          await actionTask;
        }
        await check;
        if (!actionFirst) {
          await actionTask;
        }
      } finally {
        guardSettled = true;
      }
    },
  );
  return {
    ctrl,
    started,
    policy,
    signal: () => policySignal,
    settled: () => guardSettled,
    run: () =>
      interactions.hoverViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
        signal: ctrl.signal,
      }),
  };
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  await run().finally(() => vi.useRealTimers());
}

installPwToolsCoreTestHooks();

describe("pw-tools-core interaction policy cancellation", () => {
  beforeEach(() => {
    getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockImplementation(
      () => false,
    );
  });

  it("does not leave caller cancellation pending behind a never-settling policy check", async () => {
    await withFakeTimers(async () => {
      const fixture = interactionFixture({ actionFirst: true });
      const { ctrl, started, policy } = fixture;

      const task = fixture.run();
      const settled = task.then(
        () => true,
        () => true,
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(250);

      try {
        const observeSettlement = async (): Promise<boolean> => {
          const observed = Promise.race([
            settled,
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), 1);
            }),
          ]);
          await vi.advanceTimersByTimeAsync(1);
          return await observed;
        };

        expect(await observeSettlement()).toBe(false);
        ctrl.abort(new Error("aborted while policy remained pending"));
        expect(fixture.signal()?.aborted).toBe(true);
        expect(await observeSettlement()).toBe(true);
      } finally {
        policy.resolve();
        await settled;
      }
    });
  });

  it("returns caller abort after an in-flight policy check observes cancellation", async () => {
    const hover = createDeferred<void>();
    const fixture = interactionFixture({ hover: () => hover.promise });
    const { ctrl, started } = fixture;
    const abortError = new Error("aborted while policy pending");

    const task = fixture.run();
    await started.promise;
    ctrl.abort(abortError);

    await expect(task).rejects.toBe(abortError);
    expect(fixture.signal()?.aborted).toBe(true);
    hover.resolve();
  });

  it("keeps policy work live when an observed dialog interrupts the interaction", async () => {
    await withFakeTimers(async () => {
      const dialogError = new BrowserObservedDialogBlockedError({
        dialogs: { pending: [], recent: [] },
      });
      const hover = createDeferred<void>();
      const fixture = interactionFixture({ hover: () => hover.promise, dialog: true });
      const { ctrl, started, policy } = fixture;
      getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);
      getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);

      const task = fixture.run();
      await started.promise;
      ctrl.abort(dialogError);
      policy.resolve();

      await expect(task).rejects.toBe(dialogError);
      expect(fixture.signal()?.aborted).toBe(false);
      expect(fixture.settled()).toBe(false);

      hover.resolve();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      expect(fixture.settled()).toBe(true);
    });
  });
});
