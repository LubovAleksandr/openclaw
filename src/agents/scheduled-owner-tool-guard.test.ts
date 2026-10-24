import { afterEach, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "./operational-run-instance.js";

// The pairing calls stand in for the Gateway; each dispatch first runs the caller
// fence the in-process Gateway request evaluates before its effect.
const gateway = vi.hoisted(() => ({
  owner: true,
  dispatched: [] as string[],
}));
vi.mock("./tools/gateway.js", async (importOriginal) => {
  const { captureGatewayToolCallerAssertion } = await import("./tools/gateway-caller-context.js");
  return {
    ...(await importOriginal<typeof import("./tools/gateway.js")>()),
    callGatewayTool: async (method: string) => {
      captureGatewayToolCallerAssertion()?.(method);
      gateway.dispatched.push(method);
      if (method === "node.pair.list") {
        // The requester stops being an owner while the tool awaits this list.
        gateway.owner = false;
        return { pending: [{ requestId: "req-1", requiredApproveScopes: ["operator.pairing"] }] };
      }
      return { ok: true };
    },
  };
});

const { createNodesTool } = await import("./tools/nodes-tool.js");
const { withGatewayToolCallerIdentity } = await import("./tools/gateway-caller-context.js");
const { guardScheduledOwnerOnlyTools } = await import("./scheduled-owner-tool-guard.js");

afterEach(() => {
  gateway.owner = true;
  gateway.dispatched = [];
});

const assertOwnerCurrent = () => {
  if (!gateway.owner) {
    throw new Error("The requester that authorized this automation is no longer an owner.");
  }
};

// The nodes tool as a scheduled run's owner-only surface carries it.
function guardedNodes(assert: () => void) {
  const [nodes] = guardScheduledOwnerOnlyTools([createNodesTool({})], assert);
  if (!nodes) {
    throw new Error("guard dropped the nodes tool");
  }
  return nodes;
}

// Runs the tool as an admitted scheduled run's Gateway caller would.
function asScheduledRun<T>(run: () => Promise<T>) {
  return withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: "agent:main:cron:job-1:run:s1",
      operationalRunInstance: createOperationalRunInstanceRef("run-1"),
      receiptAuthority: () => true,
    },
    run,
  );
}

it("refuses a pairing approval when the requester loses ownership during the awaited list", async () => {
  const nodes = guardedNodes(assertOwnerCurrent);
  await expect(
    asScheduledRun(() => nodes.execute("call", { action: "approve", requestId: "req-1" })),
  ).rejects.toThrow();
  expect(gateway.dispatched).toEqual(["node.pair.list"]);
});

it("lets the same approval through while the requester stays an owner", async () => {
  const nodes = guardedNodes(() => {});
  await asScheduledRun(() => nodes.execute("call", { action: "approve", requestId: "req-1" }));
  expect(gateway.dispatched).toEqual(["node.pair.list", "node.pair.approve"]);
});

it("without the guard, the approval still dispatches after the requester is revoked", async () => {
  // Control for the first case: an entry-only check would not stop this effect.
  const nodes = createNodesTool({});
  await asScheduledRun(() => nodes.execute("call", { action: "approve", requestId: "req-1" }));
  expect(gateway.owner).toBe(false);
  expect(gateway.dispatched).toEqual(["node.pair.list", "node.pair.approve"]);
});
