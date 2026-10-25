import { expect, it } from "vitest";
import { scanPolicySandboxPosture } from "./policy-state-sandbox.js";
import { scanPolicyToolPosture } from "./policy-state-tool-posture.js";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
} from "./policy-state.js";

const scanPolicyChannels = (cfg: Record<string, unknown>) => collectPolicyEvidence(cfg).channels;

const scanPolicyTools = (...lines: string[]) =>
  collectPolicyEvidence({}, { toolsRaw: ["## Tools", ...lines].join("\n") }).tools ?? [];

const scanPolicyExecApprovals = (config: Record<string, unknown>) =>
  collectPolicyEvidence({}, { execApprovalsRaw: JSON.stringify(config) }).execApprovals ?? [];

const partial = (value: Record<string, unknown>) => expect.objectContaining(value);
function expectIncludes(actual: unknown, ...entries: Record<string, unknown>[]) {
  expect(actual).toEqual(expect.arrayContaining(entries.map((entry) => partial(entry))));
}
const agentSource = "oc://openclaw.config/agents/entries/guest";
const execSource = "oc://openclaw.config/agents/entries/reviewer/tools/exec";
function execEntry(kind: "Security" | "Ask", value: string, source: string, explicit?: true) {
  return {
    id: `reviewer-exec-${kind.toLowerCase()}`,
    kind: `exec${kind}`,
    value,
    source,
    ...(explicit === undefined ? {} : { explicit }),
  };
}
const approvalEntry = (index: number, pattern: string, sourceIndex: number) =>
  partial({
    id: `agent:main:allowlist:${index}`,
    kind: "allowlist",
    agentId: "main",
    pattern,
    source: `oc://exec-approvals.json/agents/main/allowlist/#${sourceIndex}`,
  });

const guest = {
  models: { "openai/gpt-5.6-luna": {} },
  sandbox: { mode: "all", workspaceAccess: "none" },
  tools: { deny: ["exec"], elevated: { enabled: false } },
};
it.each([
  { agents: { entries: { malformed: null, guest } }, source: agentSource },
  {
    agents: { list: [null, { id: "guest", ...guest }] },
    source: "oc://openclaw.config/agents/list/#1",
  },
])(
  "scans configured agents without renumbering malformed entries ($source)",
  ({ agents, source }) => {
    const evidence = collectPolicyEvidence({
      tools: { elevated: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "off" } }, ...agents },
    });
    const entry = (path: string, fields: object) => ({
      scope: "agent",
      agentId: "guest",
      source: `${source}/${path}`,
      ...fields,
    });
    expectIncludes(evidence.sandboxPosture, entry("sandbox/mode", { kind: "mode", value: "all" }));
    expectIncludes(evidence.toolPosture, entry("tools/elevated/enabled", { value: false }));
    expectIncludes(evidence.agentWorkspace, entry("sandbox/workspaceAccess", { value: "none" }));
    const workspaces = evidence.agentWorkspace?.filter((item) => item.scope === "agent");
    expect(new Set(workspaces?.map((item) => item.agentId))).toEqual(new Set(["guest"]));
    expect(evidence.modelRefs).toContainEqual({
      ref: "openai/gpt-5.6-luna",
      provider: "openai",
      model: "gpt-5.6-luna",
      source: `${source}/models/"openai/gpt-5.6-luna"`,
    });
  },
);

it("keeps attestations stable across keyed entry order", () => {
  const model = { models: { "openai/gpt-5.6-luna": {} } };
  const first = { alpha: model, omega: model };
  const attestationHash = (entries: Record<string, unknown>) =>
    createPolicyAttestation({
      ok: true,
      checkedAt: new Date(0).toISOString(),
      policyPath: "policy.jsonc",
      policyHash: policyDocumentHash({}),
      evidence: collectPolicyEvidence({ agents: { entries } }),
      findings: [],
    }).attestationHash;

  expect(attestationHash(first)).toBe(attestationHash({ omega: first.omega, alpha: first.alpha }));
});

it("normalizes an explicit Podman backend", () => {
  expectIncludes(
    scanPolicySandboxPosture({
      agents: { defaults: { sandbox: { backend: "Podman" } } },
    }),
    { kind: "backend", value: "podman" },
  );
});

it("keeps scanning later agents after a disabled sandbox browser", () => {
  const evidence = scanPolicySandboxPosture({
    agents: {
      entries: {
        alpha: { sandbox: { browser: { enabled: false } } },
        beta: {
          sandbox: { browser: { enabled: true, cdpSourceRange: "172.21.0.1/32" } },
        },
      },
    },
  });

  expectIncludes(
    evidence,
    { agentId: "alpha", kind: "browserCdpSourceRange", value: false },
    { agentId: "beta", kind: "browserCdpSourceRange", value: "172.21.0.1/32" },
    {
      agentId: "beta",
      kind: "containerNetwork",
      networkSurface: "browser",
      value: "openclaw-sandbox-browser",
    },
  );
});
it("resolves explicit exec mode and inherited mode with a local legacy override", () => {
  const evidence = scanPolicyToolPosture({
    tools: { exec: { mode: "auto" } },
    agents: {
      entries: {
        reviewer: { tools: { exec: { mode: "ask" } } },
        legacy: { tools: { exec: { ask: "always" } } },
      },
    },
  });
  expectIncludes(
    evidence,
    execEntry("Security", "allowlist", `${execSource}/mode`, true),
    execEntry("Ask", "on-miss", `${execSource}/mode`, true),
    {
      id: "legacy-exec-security",
      kind: "execSecurity",
      value: "allowlist",
      source: "oc://openclaw.config/tools/exec/mode",
    },
    {
      id: "legacy-exec-ask",
      kind: "execAsk",
      value: "always",
      source: "oc://openclaw.config/agents/entries/legacy/tools/exec/ask",
    },
  );
});

it("ignores reserved channel config namespaces", () => {
  expect(
    scanPolicyChannels({
      channels: {
        defaults: { provider: "telegram" },
        modelByChannel: { telegram: "openai/gpt-5.5" },
        telegram: { enabled: true },
      },
    }),
  ).toEqual([
    {
      enabled: true,
      id: "telegram",
      provider: "telegram",
      source: "oc://openclaw.config/channels/telegram",
    },
  ]);
});
it("is opt-in so existing evidence and attestations remain stable", () => {
  const cfg = { channels: { imessage: {} }, bindings: [] };
  expect(collectPolicyEvidence(cfg)).not.toHaveProperty("routing");
  expect(collectPolicyEvidence(cfg, { routing: {} })).toHaveProperty("routing");
});
it("normalizes bullet tool names and parses their metadata", () => {
  expect(scanPolicyTools("- deploy_tool: risk: critical")).toEqual([
    partial({ id: "deploy-tool", risk: "critical" }),
  ]);
});

it("does not carry metadata across repeated Tools section boundaries", () => {
  const evidence = scanPolicyTools(
    "### deploy risk: high",
    "## Tools",
    "owner: ops",
    "### inspect risk: low owner: support",
  );
  expect(evidence).toEqual([
    partial({ id: "deploy", risk: "high" }),
    partial({ id: "inspect", owner: "support" }),
  ]);
  expect(evidence[0]).not.toHaveProperty("owner");
});

it("keeps longer fences open across shorter delimiter runs", () => {
  expect(scanPolicyTools("````markdown", "```", "- SSH: home-server", "````")).toEqual([]);
});

it("scans a migrated legacy Tools section after its document heading", () => {
  expect(
    scanPolicyTools(
      "### Local notes (migrated from TOOLS.md)",
      "# TOOLS.md",
      "## Tools",
      "### deploy risk: high sensitivity: restricted owner: ops",
    ),
  ).toEqual([partial({ id: "deploy", risk: "high", owner: "ops" })]);
});

it("scans redacted exec approvals posture and allowlist metadata", () => {
  const evidence = scanPolicyExecApprovals({
    version: 1,
    socket: { path: "/tmp/openclaw.sock", token: "secret-token" },
    defaults: { security: "full", ask: "off", askFallback: "full", autoAllowSkills: true },
    agents: {
      sebby: {
        security: "allowlist",
        ask: "on-miss",
        allowlist: [
          {
            pattern: "deploy",
            argPattern: "^--prod$",
            source: "allow-always",
            commandText: "deploy --prod",
            lastUsedCommand: "deploy --prod",
          },
          { pattern: "inspect", source: "free-form text that must not leak" },
        ],
      },
    },
  });

  expect(evidence).toEqual([
    partial({ id: "defaults", kind: "defaults", security: "full", autoAllowSkills: true }),
    partial({ agentId: "sebby", security: "allowlist", ask: "on-miss" }),
    partial({ pattern: "deploy", argPattern: "^--prod$", entrySource: "allow-always" }),
    expect.not.objectContaining({ entrySource: "free-form text that must not leak" }),
  ]);
  expect(JSON.stringify(evidence)).not.toContain("secret-token");
  expect(JSON.stringify(evidence)).not.toContain("deploy --prod");
  expect(JSON.stringify(evidence)).not.toContain("free-form text that must not leak");
});

it("omits malformed exec approval mode fields", () => {
  expect(
    scanPolicyExecApprovals({
      version: 1,
      defaults: { security: "bogus", ask: "bad", askFallback: "nope" },
      agents: { sebby: { security: "bogus", ask: "bad", askFallback: "nope" } },
    }),
  ).toEqual([
    expect.not.objectContaining({ security: expect.any(String) }),
    expect.not.objectContaining({ security: expect.any(String) }),
  ]);
});

it("retains source indices across invalid approval entries", () => {
  const evidence = scanPolicyExecApprovals({
    version: 1,
    agents: {
      main: {
        allowlist: [
          null,
          { id: "entry-1", pattern: "legacy" },
          "not-an-approval-entry",
          { pattern: " " },
          { id: "entry-2", pattern: "doctor" },
        ],
      },
    },
  });
  expect(evidence.filter((entry) => entry.kind === "allowlist")).toEqual([
    approvalEntry(0, "legacy", 1),
    approvalEntry(1, "doctor", 4),
  ]);
});
