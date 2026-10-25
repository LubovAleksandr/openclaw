import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";

/** Approval upgrades share the subscribe method but do not read initial history. */
export async function getInitialHistoryRequests(gateway: MockGatewayControls, key?: string) {
  const requests = await gateway.getRequests(
    "sessions.messages.subscribe",
    key === undefined ? undefined : { key },
  );
  return requests.filter(
    ({ params }) => params !== null && typeof params === "object" && "initialHistory" in params,
  );
}
