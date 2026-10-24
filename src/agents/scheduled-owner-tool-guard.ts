/**
 * Owner-only tools on a scheduled run whose owner bit comes from a requester.
 * The run's tools are built once, so each call rechecks that requester before
 * the tool runs: a revoked owner is refused at its next owner-only effect.
 */
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import { wrapAgentToolExecutionContext } from "./agent-tool-metadata.js";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";
import type { AnyAgentTool } from "./tools/common.js";

const OWNER_ONLY_TOOLS: ReadonlySet<string> = new Set(GATEWAY_OWNER_ONLY_CORE_TOOLS);

// The automations tool keeps its own self-scoped grant, which non-owners also hold.
function isGuardedOwnerTool(tool: AnyAgentTool): boolean {
  return OWNER_ONLY_TOOLS.has(tool.name) && !isAutomationsToolName(tool.name);
}

function guardOwnerTool<T extends AnyAgentTool>(tool: T, assertOwnerCurrent: () => void): T {
  const run = async <R>(operation: () => Promise<R>): Promise<R> => {
    assertOwnerCurrent();
    return await operation();
  };
  const originalExecute = tool.execute;
  return wrapAgentToolExecutionContext(
    tool,
    ((...args: Parameters<typeof originalExecute>) =>
      run(() => originalExecute(...args))) as typeof originalExecute,
    run,
    (source) => guardOwnerTool(source, assertOwnerCurrent),
  );
}

/** Rechecks the scheduled requester's owner status before each owner-only tool call. */
export function guardScheduledOwnerOnlyTools(
  tools: AnyAgentTool[],
  assertOwnerCurrent: (() => void) | undefined,
): AnyAgentTool[] {
  if (!assertOwnerCurrent) {
    return tools;
  }
  return tools.map((tool) =>
    isGuardedOwnerTool(tool) ? guardOwnerTool(tool, assertOwnerCurrent) : tool,
  );
}
