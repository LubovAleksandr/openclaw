import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { AgentEntryConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { CronJob } from "../types.js";
import { makeIsolatedAgentJobFixture } from "./job-fixtures.js";
import { resolveCronModelSelection } from "./model-selection.js";
import { resolveCronAgentConfig } from "./run-config.js";
import {
  prepareCronModelResolveInput,
  resolveCronPreflightCandidates,
} from "./run-fallback-policy.js";

function config(defaults: AgentDefaultsConfig, worker: AgentEntryConfig = {}): OpenClawConfig {
  return { agents: { defaults, entries: { worker } } };
}
function buildCronConfig(cfg: OpenClawConfig): OpenClawConfig {
  return resolveCronAgentConfig({
    config: cfg,
    agentConfigOverride: resolveAgentConfig(cfg, "worker"),
  }).cfgWithAgentDefaults;
}
function selectModel(
  cfg: OpenClawConfig,
  metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] }),
  isGmailHook = false,
) {
  const owner = {
    config: cfg,
    agentId: "worker",
    agentDir: "/tmp/cron-agent",
    workspaceDir: metadataSnapshot.workspaceDir ?? "/tmp/cron-owner",
    metadataSnapshot,
    modelCatalog: { entries: [], routeVariants: [] },
  };
  return resolveCronModelSelection({
    cfg,
    owner,
    agentConfigOverride: resolveAgentConfig(cfg, owner.agentId),
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    sessionEntry: {},
    isGmailHook,
  });
}

describe("resolveCronAgentConfig preserves agent-aware config", () => {
  it("keeps ACP harness models out of native defaults while preserving empty fallbacks", async () => {
    const fallbacks: string[] = [];
    const primary = "native/primary@native:test-profile";
    const cfg = config(
      { model: { primary, fallbacks: ["native/default-backup"] } },
      {
        runtime: { type: "acp" },
        model: { primary: "harness-only[reasoning=medium]", fallbacks },
      },
    );
    cfg.plugins = { enabled: false };
    expect(await selectModel(cfg)).toMatchObject({
      ok: true,
      provider: "native",
      model: "primary",
      modelSource: "default",
      configuredProfileId: "native:test-profile",
      cfgWithAgentDefaults: { agents: { defaults: { model: { primary, fallbacks } } } },
    });
  });

  it("leaves model, request, sandbox and memory scopes with their agent-aware owners", () => {
    const defaults: AgentDefaultsConfig = {
      models: { "openai/test": { params: { topP: 0.6, thinking: "high" } } },
      params: { temperature: 0.1 },
      sandbox: {
        mode: "all",
        docker: { network: "none" },
      },
    };
    const worker: AgentEntryConfig = {
      models: { "openai/test": { params: { thinking: "low" } } },
      params: { temperature: 0.4 },
      sandbox: { docker: { image: "sandbox:custom" } },
      memory: { search: { rememberAcrossConversations: true } },
    };
    const runCfg = buildCronConfig(config(defaults, worker));
    expect(runCfg.agents?.defaults).toEqual(defaults);
    expect(runCfg.agents?.entries?.worker).toEqual(worker);
  });

  it.each([false, true])("resolves per-agent allowlist override=%s", (override) => {
    const allowed = override ? "openai/gpt-5.6-sol" : "openai/gpt-5.5";
    const cronCfg = buildCronConfig(
      config(
        { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        { modelPolicy: override ? { allow: [allowed] } : {} },
      ),
    );
    expect(cronCfg.agents?.defaults?.modelPolicy).toEqual({ allow: [allowed] });
  });

  it.each(["agent", "hook"] as const)(
    "keeps the selected owner's metadata for the %s model",
    async (source) => {
      const provider = source === "hook" ? DEFAULT_PROVIDER : "custom";
      const snapshot = (workspaceDir: string, model: string) => ({
        ...createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "cron-model-policy",
              modelIdNormalization: {
                providers: { [provider]: { aliases: { legacy: model } } },
              },
            },
          ],
        }),
        workspaceDir,
      });
      const metadataSnapshot = snapshot("/tmp/cron-owner", "selected");
      const cfg = config(
        {
          model: { primary: "custom/baseline" },
          modelPolicy: { allow: [`${provider}/legacy`] },
        },
        source === "agent" ? { model: "custom/legacy" } : {},
      );
      if (source === "hook") {
        cfg.hooks = { gmail: { model: "legacy" } };
      }
      expect(
        await withPluginRuntimeGenerationScope(
          { metadataSnapshot: snapshot("/tmp/other-owner", "other") },
          () => selectModel(cfg, metadataSnapshot, source === "hook"),
        ),
      ).toMatchObject({
        ok: true,
        provider,
        model: "selected",
        modelSource: source,
      });
    },
  );
});

it.each([undefined, "cron", "event"] as const)(
  "classifies model routing as %s from the caller, not the hook session key",
  async (trigger) => {
    const { modelResolve } = await prepareCronModelResolveInput({
      cwd: "/tmp/event-model-routing",
      prompt: "Synthetic immediate event",
      cronSession: { sessionEntry: {} },
      job: { id: "caller-classification" },
      trigger,
      runSessionKey: "agent:main:hook:caller-classification",
      resolvedDelivery: {},
      messageChannel: undefined,
    });
    expect(modelResolve.context?.trigger).toBe(trigger ?? "cron");
  },
);

const job = (payload: Partial<Extract<CronJob["payload"], { kind: "agentTurn" }>> = {}) =>
  makeIsolatedAgentJobFixture({ payload: { kind: "agentTurn", message: "summarize", ...payload } });
const fallback = "openai/gpt-5.4";
const fallbackConfig: OpenClawConfig = {
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6", fallbacks: [fallback] } } },
};
const user = { sessionModelOverrideSource: "user" } as const;
const payloadModel = "google/gemini-2.0-flash";
type Case = [
  name: string,
  options: Partial<Parameters<typeof resolveCronPreflightCandidates>[0]>,
  fallbacks: string[],
];
it.each<Case>([
  [
    "unselected subagent",
    {
      cfg: {
        agents: {
          defaults: { ...fallbackConfig.agents?.defaults, subagents: { model: "kimi/kimi-code" } },
        },
      },
      useSubagentFallbacks: false,
    },
    [fallback],
  ],
  ["payload model over user selection", { job: job({ model: payloadModel }), ...user }, [fallback]],
  [
    "payload fallbacks over user selection",
    { job: job({ fallbacks: ["jobfallback/model-c"] }), ...user },
    ["jobfallback/model-c"],
  ],
])("preflights %s", (_name, options, fallbacks) => {
  expect(
    resolveCronPreflightCandidates({
      cfg: fallbackConfig,
      job: job(),
      agentId: "main",
      provider: "ollama",
      model: "qwen3:32b",
      ...options,
    }).map(({ provider, model }) => `${provider}/${model}`),
  ).toEqual(["ollama/qwen3:32b", ...fallbacks]);
});
