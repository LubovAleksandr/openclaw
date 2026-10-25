import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Command } from "commander";
import { clearConfigCache } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPolicyCli } from "./cli.js";
import { createPolicyAttestation } from "./policy-state.js";

let workspaceDir: string;
const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

async function runPolicyCli(args: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const capture = (stream: string[], chunk: unknown) => {
    stream.push(String(chunk));
    return true;
  };
  const stdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => capture(stdout, chunk));
  const stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => capture(stderr, chunk));
  const consoleError = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    capture(stderr, `${values.map(String).join(" ")}\n`);
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command().name("openclaw");
    registerPolicyCli(program);
    await program.parseAsync(["policy", ...args], { from: "user" });
    const lastOutput = stdout.at(-1) ?? "";
    const parsed = /^[{[]/.test(lastOutput.trimStart()) ? JSON.parse(lastOutput) : {};
    return {
      exitCode: process.exitCode ?? 0,
      parsed,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  } finally {
    process.exitCode = previousExitCode;
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    consoleError.mockRestore();
  }
}

async function runPolicyCheckJson(...args: string[]) {
  return runPolicyCli(["check", "--json", ...args]);
}

async function runPolicyWatchJson(...args: string[]) {
  return runPolicyCli(["watch", "--json", "--once", ...args]);
}

function workspacePath(value: string): string {
  return isAbsolute(value) ? value : join(workspaceDir, value);
}

async function writeFixture(path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf-8");
}

async function runPolicyCompareJson(options: { baseline: string; policy?: string }) {
  return runPolicyCli([
    "compare",
    "--json",
    "--baseline",
    workspacePath(options.baseline),
    ...(options.policy === undefined ? [] : ["--policy", workspacePath(options.policy)]),
  ]);
}

async function writeConfig(config: object, policyConfig: object = {}) {
  const configPath = join(workspaceDir, "openclaw.jsonc");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  await writeFixture(configPath, {
    plugins: {
      entries: { policy: { enabled: true, config: { enabled: true, ...policyConfig } } },
    },
    ...config,
  });
}

const deniedTelegram = {
  channels: { denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }] },
};
const staleAttestation = { expectedAttestationHash: "sha256:not-current" };
const execHosts = (...allowHosts: string[]) => ({ tools: { exec: { allowHosts } } });
const agentScope = (...hosts: string[]) => ({ agentIds: ["main"], ...execHosts(...hosts) });
const scopedBaseline = { scopes: { release: agentScope("sandbox") } };
const approvalAllowlist = (expected: unknown[], extra: object = {}) => ({
  execApprovals: { agents: { ...extra, allowlist: { expected } } },
});
const partialFindings = (...findings: object[]) => findings.map((f) => expect.objectContaining(f));
function expectIncludedFindings(actual: unknown, ...findings: object[]) {
  expect(actual).toEqual(expect.arrayContaining(partialFindings(...findings)));
}
const routingProbe = (matchedBy = ["binding.peer"], peerId = "private-peer") => ({
  id: "family-dm",
  route: { channel: "imessage", peer: { kind: "direct", id: peerId } },
  expect: { agentId: "family", matchedBy },
});
const invalidScopeFinding = (scope: string) => ({
  checkId: "policy/policy-conformance-invalid",
  requirement: `oc://policy.jsonc/scopes/${scope}/tools/exec/allowHosts`,
  target: `oc://policy.jsonc/scopes/${scope}/tools/exec/allowHosts`,
});
type AttestationInput = Parameters<typeof createPolicyAttestation>[0];
function reattest(
  report: {
    attestation: { checkedAt: string; policy: { hash: string } };
    evidence: AttestationInput["evidence"];
  },
  findings: AttestationInput["findings"],
) {
  return createPolicyAttestation({
    ok: false,
    checkedAt: report.attestation.checkedAt,
    policyPath: "policy.jsonc",
    policyHash: report.attestation.policy.hash,
    evidence: report.evidence,
    findings,
  });
}

async function runPolicyCompareFixture(baseline: unknown, policy: unknown = {}) {
  await writeFixture(join(workspaceDir, "baseline.policy.jsonc"), baseline);
  await writeFixture(join(workspaceDir, "policy.jsonc"), policy);
  return runPolicyCompareJson({ baseline: "baseline.policy.jsonc" });
}

async function writeExplicitFleetConfig() {
  const alphaWorkspace = join(workspaceDir, "alpha-workspace");
  const betaWorkspace = join(workspaceDir, "beta-workspace");
  await Promise.all(
    [alphaWorkspace, betaWorkspace].map((path) => fs.mkdir(path, { recursive: true })),
  );
  await writeConfig(
    {
      agents: {
        ownership: "explicit",
        entries: {
          alpha: { workspace: alphaWorkspace },
          beta: { workspace: betaWorkspace },
        },
      },
    },
    { path: "policy.jsonc" },
  );
  clearConfigCache();
  return { alphaWorkspace, betaWorkspace };
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-cli-"));
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
});

afterEach(async () => {
  if (originalStdoutTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutTTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
  vi.unstubAllEnvs();
  clearConfigCache();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

it("checks authored routing probes without exposing route identifiers", async () => {
  const peerId = "+15555550123-private";
  await writeConfig({
    agents: { entries: { main: {} } },
    channels: { imessage: { enabled: false } },
    bindings: [],
  });
  await writeFixture(join(workspaceDir, "policy.jsonc"), {
    routing: {
      requireBindings: true,
      requireConfiguredChannels: true,
      probes: [routingProbe(["binding.peer"], peerId)],
    },
  });

  const { exitCode, stdout, stderr } = await runPolicyCheckJson();
  expect(exitCode).toBe(1);
  expect(stdout).not.toContain(peerId);
  expect(stderr).not.toContain(peerId);
});

it.each([
  [{ channels: { denyRules: [{ when: {} }] } }, "channels/denyRules/#0"],
  [{ tools: [] }, "tools"],
] as const)("reports malformed policy %j", async (policy, path) => {
  const target = `oc://policy.jsonc/${path}`;
  await writeFixture(join(workspaceDir, "policy.jsonc"), policy);
  const { exitCode, parsed } = await runPolicyCheckJson();
  expect(exitCode).toBe(1);
  expect(parsed).toMatchObject({
    ok: false,
    findings: [{ checkId: "policy/policy-jsonc-invalid", target }],
  });
});

it("links policy findings to evidence and policy requirement refs", async () => {
  await writeConfig({ channels: { telegram: { enabled: true } } });
  await writeFixture(join(workspaceDir, "policy.jsonc"), deniedTelegram);
  const { exitCode, parsed } = await runPolicyCheckJson();
  expect(exitCode).toBe(1);
  const channel = "oc://openclaw.config/channels/telegram";
  expect(parsed.evidence.channels).toEqual(partialFindings({ id: "telegram", source: channel }));
  expect(parsed.findings).toMatchObject([
    {
      checkId: "policy/channels-denied-provider",
      ocPath: channel,
      target: channel,
      requirement: "oc://policy.jsonc/channels/denyRules/#0",
      policy: { fixRecommendation: { fixClass: "automatic" } },
    },
  ]);
  const attestedFinding = { ...parsed.findings[0] };
  expect(attestedFinding.policy).toBeDefined();
  delete attestedFinding.policy;
  const attestedOutput = reattest(parsed, [attestedFinding]);
  const reportedOutput = reattest(parsed, parsed.findings);
  expect(parsed.attestation.findingsHash).toBe(attestedOutput.findingsHash);
  expect(parsed.attestation.findingsHash).not.toBe(reportedOutput.findingsHash);
});

it("attests underlying policy findings when the accepted attestation is stale", async () => {
  await writeConfig({ channels: { telegram: { enabled: true } } }, staleAttestation);
  await writeFixture(join(workspaceDir, "policy.jsonc"), deniedTelegram);
  const { exitCode, parsed } = await runPolicyCheckJson();
  expect(exitCode).toBe(1);
  expect(parsed.findings).toEqual(partialFindings({ checkId: "policy/attestation-hash-mismatch" }));
  const emptyOutput = reattest(parsed, []);
  expect(parsed.attestation.findingsHash).not.toBe(emptyOutput.findingsHash);
  expect(parsed.attestation.attestationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
});

it.each([
  [{ channels: { denyRules: [] } }, "stale", "policy/attestation-hash-mismatch"],
  ["{ channels: ", "findings", "policy/policy-jsonc-invalid"],
] as const)("watches policy status %s", async (policy, status, checkId) => {
  await writeConfig({}, staleAttestation);
  await writeFixture(join(workspaceDir, "policy.jsonc"), policy);
  const { exitCode, parsed } = await runPolicyWatchJson();
  expect(exitCode).toBe(1);
  expect(parsed).toMatchObject({
    status,
    expectedAttestationHash: "sha256:not-current",
    findings: [{ checkId }],
  });
});

it("rejects partial policy watch intervals before evaluating policy", async () => {
  const { exitCode, stderr } = await runPolicyWatchJson("--interval-ms", "500ms");
  expect(exitCode).toBe(2);
  expect(stderr).toContain("--interval-ms must be an integer >= 250.");
});

describe.each([
  { mode: "explicit JSON", stdoutIsTTY: true, jsonArgs: ["--json"] },
  { mode: "piped output", stdoutIsTTY: false, jsonArgs: [] },
])("$mode failures", ({ stdoutIsTTY, jsonArgs }) => {
  it.each([
    [
      ["check", "--severity-min", "warnng"],
      "Invalid --severity-min value. Expected one of: info, warning, error.",
    ],
    [["watch", "--once", "--interval-ms", "0"], "--interval-ms must be an integer >= 250."],
    [["compare", "--baseline", " "], "Missing required --baseline value."],
  ] as const)("returns a JSON error on stdout for %j", async (args, message) => {
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutIsTTY, configurable: true });

    const result = await runPolicyCli([...args, ...jsonArgs]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { type: "cli_error", message },
    });
    expect(result.stderr).toBe(`${message}\n`);
  });
});

it("keeps terminal failures on stderr without JSON", async () => {
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

  const result = await runPolicyCli(["check", "--severity-min", "warnng"]);

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Invalid --severity-min value. Expected one of: info, warning, error.\n",
  );
});

it("fails closed when the OpenClaw config is invalid", async () => {
  const configPath = join(workspaceDir, "openclaw.jsonc");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  await writeFixture(configPath, "{");
  const { exitCode, parsed } = await runPolicyCheckJson();
  expect(exitCode).toBe(1);
  expect(parsed.attestation).toBeUndefined();
  expect(parsed.findings).toEqual(
    partialFindings({ checkId: "policy/config-invalid", severity: "error" }),
  );
});

const approvalPolicy = approvalAllowlist(
  ["status", { pattern: "calendar-cli", argPattern: "^sync\\b" }],
  { allowAutoAllowSkills: false },
);
const globals = (requireDmScope: string) => ({
  ...approvalPolicy,
  ingress: { session: { requireDmScope } },
  models: { providers: { allow: ["openai"] } },
  network: { privateNetwork: { allow: false } },
});
const routing = (...probes: object[]) => ({ routing: { requireBindings: true, probes } });
const mention = { ingress: { channels: { requireMentionInGroups: true } } };
const scoped = (scopes: object) => ({ scopes });
const endpoints = (id: string) => ({ gateway: { http: { denyEndpoints: [id] } } });
const clean = { ok: true, findings: [] };
const invalid = (...targets: string[]) => ({
  ok: false,
  findings: expect.arrayContaining(
    partialFindings(
      ...targets.map((target) => ({ checkId: "policy/policy-conformance-invalid", target })),
    ),
  ),
});
const badScope = (scope: string) => ({
  ok: false,
  findings: partialFindings(invalidScopeFinding(scope)),
});
const sandbox = agentScope("sandbox");
const relaxed = agentScope("sandbox", "node");
type Report = { ok: boolean; findings: unknown; rulesChecked?: number };
it.each<[string, unknown, unknown, Report]>([
  [
    "global strictness and approval arguments",
    globals("per-peer"),
    globals("per-channel-peer"),
    clean,
  ],
  [
    "narrower routing and extra probes",
    routing(routingProbe(["binding.peer", "binding.account"])),
    routing(routingProbe(), {
      id: "group-fallback",
      route: { channel: "imessage", peer: { kind: "group", id: "private-group" } },
      expect: { agentId: "groups", matchedBy: ["binding.channel"] },
    }),
    clean,
  ],
  [
    "unsupported approval keys",
    approvalAllowlist([{ pattern: "deploy", argpattern: "^--prod$" }]),
    approvalAllowlist([{ pattern: "deploy", argPattern: "^--prod$" }]),
    {
      ...invalid("oc://baseline.policy.jsonc/execApprovals/agents/allowlist/expected/#0"),
      rulesChecked: 0,
    },
  ],
  [
    "invalid scope selectors",
    scoped({
      missingSelector: execHosts("sandbox"),
      wrongSelector: { channelIds: ["telegram"], ...execHosts("sandbox") },
    }),
    {},
    invalid(
      ...["missingSelector", "wrongSelector"].map(
        (scope) => `oc://baseline.policy.jsonc/scopes/${scope}/tools/exec/allowHosts`,
      ),
    ),
  ],
  [
    "endpoint casing",
    endpoints("chatCompletions"),
    endpoints("chatcompletions"),
    invalid("oc://policy.jsonc/gateway/http/denyEndpoints/#0"),
  ],
  [
    "global satisfies scoped",
    scoped({ ...scopedBaseline.scopes, telegram: { channelIds: ["telegram"], ...mention } }),
    { ...execHosts("sandbox"), ...mention },
    clean,
  ],
  [
    "weaker scoped override",
    scopedBaseline,
    { ...execHosts("sandbox"), ...scoped({ release: relaxed }) },
    badScope("release"),
  ],
  ["stricter later overlay", scopedBaseline, scoped({ team: relaxed, lockdown: sandbox }), clean],
  [
    "weaker duplicate scope",
    scopedBaseline,
    scoped({ ...scopedBaseline.scopes, relaxed }),
    badScope("relaxed"),
  ],
])("compares policies: %s", async (_name, baseline, policy, report) => {
  const { exitCode, parsed } = await runPolicyCompareFixture(baseline, policy);
  expect(exitCode).toBe(report.ok ? 0 : 1);
  expect(parsed).toMatchObject({
    baselinePath: "baseline.policy.jsonc",
    policyPath: "policy.jsonc",
    ...report,
  });
  if (report.ok) {
    expect(parsed.rulesChecked).toBeGreaterThan(0);
  }
});

it("reports missing and weaker policy file conformance rules", async () => {
  await writeFixture(join(workspaceDir, "baseline.policy.jsonc"), {
    channels: { denyRules: [{ when: { provider: "telegram" } }] },
    network: { privateNetwork: { allow: false } },
    gateway: { auth: { requireAuth: true } },
    secrets: { denySources: ["env"] },
  });
  await writeFixture(join(workspaceDir, "candidate.policy.jsonc"), {
    channels: { denyRules: [{ when: { provider: "Telegram" } }] },
    network: { privateNetwork: { allow: true } },
    secrets: { denySources: [] },
  });

  const { exitCode, parsed } = await runPolicyCompareJson({
    baseline: "baseline.policy.jsonc",
    policy: "candidate.policy.jsonc",
  });
  expect(exitCode).toBe(1);
  expectIncludedFindings(
    parsed.findings,
    ...[
      ["weaker", "channels/denyRules"],
      ["weaker", "network/privateNetwork/allow"],
      ["missing", "gateway/auth/requireAuth"],
      ["weaker", "secrets/denySources"],
    ].map(([kind, path]) => ({
      checkId: `policy/policy-conformance-${kind}`,
      requirement: `oc://baseline.policy.jsonc/${path}`,
    })),
  );
});

it("returns JSON findings for missing policy compare files", async () => {
  await writeFixture(join(workspaceDir, "policy.jsonc"), {});

  const { exitCode, parsed } = await runPolicyCompareJson({
    baseline: "missing.policy.jsonc",
  });
  expect(exitCode).toBe(1);
  expect(parsed).toMatchObject({
    ok: false,
    rulesChecked: 0,
    findings: [
      {
        checkId: "policy/policy-conformance-invalid",
        target: "oc://missing.policy.jsonc",
      },
    ],
  });
});

it("watches the explicitly selected workspace without inspecting the first agent", async () => {
  const { alphaWorkspace, betaWorkspace } = await writeExplicitFleetConfig();
  await writeFixture(join(alphaWorkspace, "policy.jsonc"), "{");
  await writeFixture(join(betaWorkspace, "policy.jsonc"), {});

  const { exitCode, parsed } = await runPolicyWatchJson("--agent", "beta");
  expect(exitCode).toBe(0);
  expect(parsed).toMatchObject({
    status: "clean",
    ok: true,
    attestation: { policy: { path: "policy.jsonc" } },
    findings: [],
  });
});

it("resolves a relative compare policy from the explicitly selected workspace", async () => {
  const { alphaWorkspace, betaWorkspace } = await writeExplicitFleetConfig();
  const baselinePath = join(workspaceDir, "baseline.policy.jsonc");
  await writeFixture(baselinePath, { network: { privateNetwork: { allow: false } } });
  await writeFixture(join(alphaWorkspace, "policy.jsonc"), {
    network: { privateNetwork: { allow: true } },
  });
  await writeFixture(join(betaWorkspace, "policy.jsonc"), {
    network: { privateNetwork: { allow: false } },
  });

  const { exitCode, parsed } = await runPolicyCli([
    "compare",
    "--agent",
    "beta",
    "--baseline",
    baselinePath,
    "--json",
  ]);
  expect(exitCode).toBe(0);
  expect(parsed).toMatchObject({ ok: true, policyPath: "policy.jsonc", findings: [] });
});

it.each([
  [["check", "--json"], "policy check has no explicit owner"],
  [
    ["compare", "--baseline", "baseline.policy.jsonc", "--json"],
    "policy compare has no explicit owner",
  ],
] as const)("requires an owner for %j", async (args, expected) => {
  await writeExplicitFleetConfig();
  await writeFixture(join(workspaceDir, "baseline.policy.jsonc"), {});

  const { exitCode, stderr } = await runPolicyCli(args);
  expect(exitCode).toBe(2);
  expect(stderr).toContain(expected);
  expect(stderr).toContain("Pass --agent <id>.");
});

it("rejects an unknown explicit owner with profile-aware guidance", async () => {
  await writeExplicitFleetConfig();
  vi.stubEnv("OPENCLAW_PROFILE", "testprof");
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");

  const { exitCode, stderr } = await runPolicyCli(["check", "--agent", "ghost", "--json"]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain(
    'Unknown agent id "ghost". Run openclaw --profile testprof agents list to see configured agents.',
  );
});
