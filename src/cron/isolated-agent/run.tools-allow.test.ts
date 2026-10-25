import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "../../secrets/runtime-web-tools-state.js";
import type { CronStoredJob } from "../types.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadModelCatalogMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveConfiguredModelRefMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const options = { timeout: 300_000 };
const command = "Command to run:\n- command: python3 scripts/check_mail.py";
const commandInDirectory = `${command}\n- workdir: /srv/openclaw`;
const externalOrigin = { kind: "external", channel: "whatsapp" } as const;
const automaticSnapshot = { toolsAllowIsDefault: true };
const conditionTrigger = { trigger: { script: "return { fire: true }" } };
const policy: NonNullable<CronStoredJob["scheduledToolPolicy"]> = {
  version: 1,
  mode: "account",
  ownerSessionKey: "agent:main:whatsapp:group:team",
  ownerAccountId: "default",
};

function runTurn(
  toolsAllow: string[],
  payload: Partial<Extract<CronStoredJob["payload"], { kind: "agentTurn" }>> = {},
  job: Partial<CronStoredJob> = {},
  cfg: OpenClawConfig = {},
) {
  return runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      cfg,
      message: "check allowed tools",
      sessionKey: "cron:tools-allow",
      job: {
        id: "tools-allow",
        delivery: { mode: "none" },
        owner: { agentId: "main", sessionKey: policy.ownerSessionKey, accountId: "default" },
        scheduledToolPolicy: policy,
        toolsAllowProvenance: {
          version: 1,
          source: "final-executable-surface",
          callerOrigin: externalOrigin,
        },
        payload: { kind: "agentTurn", message: "check allowed tools", toolsAllow, ...payload },
        ...job,
      },
    }),
  );
}

describe("runCronIsolatedAgentTurn toolsAllow", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });
  beforeEach(() => {
    clearActiveRuntimeWebToolsMetadata();
    mockRunCronFallbackPassthrough();
  });
  afterEach(clearActiveRuntimeWebToolsMetadata);

  it("preserves local provenance for scheduled message tools", options, async () => {
    await runTurn(["message"], automaticSnapshot, {
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "local" },
      },
    });
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]?.scheduledToolPolicy).toEqual({
      ...policy,
      ownerOrigin: { kind: "local" },
    });
  });

  it.each<[string, Partial<CronStoredJob>]>([
    ["without owner policy", { owner: { agentId: "main", sessionKey: policy.ownerSessionKey } }],
    ["behind a condition trigger", conditionTrigger],
  ])("keeps an automatic creator snapshot %s", options, async (_label, job) => {
    await runTurn(["message", "read"], automaticSnapshot, job);
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]?.toolsAllow).toEqual(["message", "read"]);
  });

  it.each<[string[], boolean, boolean, string]>([
    [["terminal", "node_exec", "node_process"], false, false, commandInDirectory],
    [[" "], false, false, commandInDirectory],
    [["exec", "read"], false, true, commandInDirectory],
    [["process"], false, true, command],
    [["message", "read"], true, true, command],
  ])(
    "preflights command cap %j (automatic=%s, allowed=%s)",
    options,
    async (toolsAllow, automatic, allowed, message) => {
      const result = await runTurn(toolsAllow, { message, toolsAllowIsDefault: automatic });
      if (allowed) {
        expect(result.status).toBe("ok");
        const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
        expect(call?.toolsAllow).toEqual(automatic ? ["*"] : toolsAllow);
        expect(call?.scheduledToolPolicy).toEqual({ ...policy, ownerOrigin: externalOrigin });
      } else {
        expect(result).toMatchObject({
          status: "error",
          admissionDisposition: "rejected",
          error: expect.stringContaining(
            "openclaw automations edit tools-allow --tools exec,process",
          ),
          diagnostics: {
            summary: expect.stringContaining("No command was executed"),
            entries: [expect.objectContaining({ source: "cron-preflight", severity: "error" })],
          },
        });
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(resolveConfiguredModelRefMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["plugin", "native", "automatic"] as const)(
    "does not warn when web_search comes from %s policy",
    options,
    async (source) => {
      const cfg: OpenClawConfig = {};
      if (source === "plugin") {
        setActiveRuntimeWebToolsMetadata({
          search: {
            providerSource: "auto-detect",
            selectedProvider: "brave",
            selectedProviderKeySource: "config",
            diagnostics: [],
          },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        });
      }
      if (source === "native") {
        resolveConfiguredModelRefMock.mockReturnValue({ provider: "gateway", model: "gpt-5.5" });
        loadModelCatalogMock.mockResolvedValue([
          { id: "gpt-5.5", name: "GPT-5.5", provider: "gateway", api: "openai-chatgpt-responses" },
        ]);
        cfg.tools = {
          web: { search: { enabled: true, openaiCodex: { enabled: true, mode: "cached" } } },
        };
      }
      const automatic = source === "automatic";
      const result = await runTurn(
        automatic ? ["read", "web_search"] : ["web_search"],
        automatic ? automaticSnapshot : {},
        automatic ? conditionTrigger : {},
        cfg,
      );
      expect([result.status, result.diagnostics]).toEqual(["ok", undefined]);
    },
  );

  it("keeps missing web_search provider diagnostics when the run aborts", options, async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: { result: { payloads: [], meta: { aborted: true, agentMeta: {} } } },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });
    const result = await runTurn(["web_search"], {}, { deleteAfterRun: true });
    expect(result).toMatchObject({ status: "error", error: "cron isolated agent run aborted" });
    expect(result.diagnostics?.entries.map((entry) => entry.message)).toEqual([
      "web_search tool requested in toolsAllow but no web search provider is selected. Configure one with: openclaw configure --section web, or set tools.web.search.provider.",
      "cron isolated agent run aborted",
    ]);
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "cron-preflight",
      severity: "warn",
      toolName: "web_search",
      ts: expect.any(Number),
    });
  });
});
