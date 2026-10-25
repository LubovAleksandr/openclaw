import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { AgentEntryConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveCronModelSelection } from "./model-selection.js";
import { resolveCronAgentConfig } from "./run-config.js";

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

  it.each<{ name: string; defaults: AgentDefaultsConfig; worker: AgentEntryConfig }>([
    {
      name: "model catalog",
      defaults: { models: { "openai/test": { params: { topP: 0.6, thinking: "high" } } } },
      worker: { models: { "openai/test": { params: { thinking: "low" } } } },
    },
    {
      name: "request parameters",
      defaults: { params: { temperature: 0.1 } },
      worker: { params: { temperature: 0.4 } },
    },
    {
      name: "sandbox",
      defaults: {
        sandbox: {
          mode: "all",
          workspaceAccess: "rw",
          docker: {
            network: "none",
            dangerouslyAllowContainerNamespaceJoin: true,
            dangerouslyAllowExternalBindSources: true,
          },
          browser: { enabled: true, autoStart: false },
          prune: { maxAgeDays: 7 },
        },
      },
      worker: { sandbox: { docker: { image: "sandbox:custom" } } },
    },
    {
      name: "memory",
      defaults: {},
      worker: { memory: { search: { rememberAcrossConversations: true } } },
    },
  ])("leaves $name merging to its agent-aware owner", ({ defaults, worker }) => {
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
      const snapshot = (workspaceDir: string, model: string) => ({
        ...createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "cron-model-policy",
              modelIdNormalization: {
                providers: {
                  custom: { aliases: { legacy: model } },
                  [DEFAULT_PROVIDER]: { aliases: { legacy: model } },
                },
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
          modelPolicy: { allow: ["custom/legacy", `${DEFAULT_PROVIDER}/legacy`] },
        },
        {
          agentDir: "/tmp/cron-agent",
          workspace: metadataSnapshot.workspaceDir,
          ...(source === "agent" ? { model: "custom/legacy" } : {}),
        },
      );
      if (source === "hook") {
        cfg.hooks = { gmail: { model: "legacy" } };
      }
      for (const ambient of [metadataSnapshot, snapshot("/tmp/other-owner", "other")]) {
        expect(
          await withPluginRuntimeGenerationScope({ metadataSnapshot: ambient }, () =>
            selectModel(cfg, metadataSnapshot, source === "hook"),
          ),
        ).toMatchObject({
          ok: true,
          provider: source === "hook" ? DEFAULT_PROVIDER : "custom",
          model: "selected",
          modelSource: source,
        });
      }
    },
  );
});
