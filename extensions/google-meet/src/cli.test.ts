import { afterEach, expect, it, vi } from "vitest";
import type { GoogleMeetRuntime } from "./runtime.js";
import * as cli from "./test-support/cli-harness.js";
import { MEET_URL, meetSession } from "./test-support/fixtures.test-helpers.js";

const { run, output, json } = cli.useCli();

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("prints local doctor output (json=%s)", async (asJson) => {
  const calls: string[] = [];
  const status = vi.fn<GoogleMeetRuntime["status"]>(async (id) => {
    calls.push("local");
    return { found: id !== "meet_missing" };
  });
  await run(["doctor", "meet_missing", ...(asJson ? ["--json"] : [])], {
    runtime: { status },
    callGatewayFromCli: async () => {
      calls.push("gateway");
      throw Object.assign(new Error("unknown method: googlemeet.status"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        retryable: false,
      });
    },
  });
  expect(calls).toEqual(["gateway", "local"]);
  if (asJson) {
    expect(json()).toEqual({ found: false });
  } else {
    expect(output()).toBe("Google Meet session: not found\n");
  }
});

it("preserves the original gateway doctor error without output", async () => {
  const error = new Error("gateway failed");
  await expect(
    run(["doctor", "meet_missing"], {
      runtime: { status: vi.fn().mockRejectedValue(error) },
      callGatewayFromCli: vi.fn().mockRejectedValue(error),
    }),
  ).rejects.toBe(error);
  expect(output()).toBe("");
});

it.each([
  { command: "resolve-space", explicit: true, json: false },
  { command: "resolve-space", explicit: false, json: true },
  { command: "preflight", explicit: true, json: true },
  { command: "preflight", explicit: false, json: false },
])(
  "resolves $command (explicit=$explicit, json=$json)",
  async ({ command, explicit, json: asJson }) => {
    const meeting = explicit ? "spaces/explicit" : "spaces/configured";
    const space = { name: meeting, meetingCode: "abc-defg-hij" };
    const fetchMock = cli.stubJsonRoutes({ [`https://meet.googleapis.com/v2/${meeting}`]: space });
    await run(
      [
        command,
        ...(explicit ? ["--meeting", "  spaces/explicit  "] : []),
        ...(asJson ? ["--json"] : []),
      ],
      {
        config: {
          defaults: { meeting: "spaces/configured" },
          oauth: { accessToken: "fixture-token", expiresAt: Date.now() + 3_600_000 },
        },
      },
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fixture-token",
    });
    if (asJson) {
      expect(json()).toMatchObject(
        command === "resolve-space" ? space : { input: meeting, resolvedSpaceName: meeting },
      );
    } else {
      cli.expectText(
        output(),
        `input: ${meeting}\n`,
        "meeting code: abc-defg-hij\n",
        "token source: cached-access-token\n",
      );
    }
  },
);

it.each(["resolve-space", "preflight"])(
  "rejects missing %s meeting before OAuth",
  async (command) => {
    vi.stubEnv("OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(run([command])).rejects.toThrow(
      "Meeting input is required. Pass a URL/meeting code or configure defaults.meeting.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output()).toBe("");
  },
);

it.each(["chrome-node", "twilio"] as const)(
  "prints %s session doctor output",
  async (transport) => {
    const chrome = transport === "chrome-node";
    const session = meetSession({
      transport,
      chrome: {
        health: {
          lastCaptionSpeaker: "Alice",
          lastCaptionText: "Hello",
          audioInputActive: true,
          audioOutputActive: false,
        },
      },
      ...(!chrome && {
        chrome: undefined,
        twilio: {
          dialInNumber: "+15551234567",
          pinProvided: true,
          voiceCallId: "call-1",
          dtmfSent: true,
          introSent: true,
        },
      }),
    });
    if (!chrome) {
      session.chrome = undefined;
    }
    await run(["doctor", "meet_1"], {
      runtime: { status: async () => ({ found: true, session }) },
    });
    if (chrome) {
      cli.expectText(
        output(),
        "last caption text: Alice: Hello",
        "audio input active: yes",
        "audio output active: no",
      );
    } else {
      cli.expectText(
        output(),
        "twilio dial-in: +15551234567",
        "voice call id: call-1",
        "dtmf sent: yes",
        "intro sent: yes",
      );
      expect(output()).not.toContain("audio input active:");
    }
  },
);

const tokenUrl = "https://oauth2.googleapis.com/token";
const spacesUrl = "https://meet.googleapis.com/v2/spaces";
it.each([
  ["success", undefined],
  ["oauth-token", tokenUrl],
  ["meet-spaces-get", `${spacesUrl}/existing`],
  ["meet-spaces-create", spacesUrl],
])("reports OAuth doctor %s without leaking credentials", async (id, failedUrl) => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (![tokenUrl, spacesUrl, `${spacesUrl}/existing`].includes(url)) {
      throw new Error(`Unexpected OAuth doctor URL: ${url}`);
    }
    if (url === failedUrl) {
      throw new Error(
        "access_token=fixture-access refresh_token=fixture-refresh client_secret=fixture-secret",
      );
    }
    return cli.jsonResponse(
      url === tokenUrl
        ? { access_token: "fixture-access", expires_in: 3600, token_type: "Bearer" }
        : { name: "spaces/fixture", meetingUri: MEET_URL },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  await run(["doctor", "--oauth", "--meeting", "spaces/existing", "--create-space", "--json"], {
    config: {
      oauth: {
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        refreshToken: "fixture-refresh",
      },
    },
  });
  const report = json();
  expect(report).toMatchObject({ ok: !failedUrl, configured: true });
  if (failedUrl) {
    expect(report.checks).toEqual(
      expect.arrayContaining([
        {
          id,
          ok: false,
          message:
            id === "oauth-token"
              ? "Google Meet OAuth refresh transport failed"
              : "access_token=[redacted] refresh_token=[redacted] client_secret=[redacted]",
        },
      ]),
    );
  } else {
    expect(report).toMatchObject({
      tokenSource: "refresh-token",
      createdSpace: "spaces/fixture",
      meetingUri: MEET_URL,
    });
    expect(fetchMock.mock.calls.find(([url]) => url === spacesUrl)?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer fixture-access" },
    });
  }
  expect(report.checks).toHaveLength(id === "oauth-token" ? 2 : 4);
  expect(fetchMock).toHaveBeenCalledTimes(id === "oauth-token" ? 1 : 3);
  for (const secret of ["fixture-access", "fixture-refresh", "fixture-secret"]) {
    expect(output()).not.toContain(secret);
  }
});

it("recovers and summarizes an existing Meet tab", async () => {
  const message = "Admit the OpenClaw browser participant in Google Meet.";
  await run(["recover-tab"], {
    config: { defaultTransport: "chrome-node" },
    runtime: {
      recoverCurrentTab: async () => ({
        transport: "chrome-node",
        nodeId: "node-1",
        found: true,
        targetId: "tab-1",
        tab: { targetId: "tab-1", url: MEET_URL },
        browser: {
          inCall: false,
          manualAction: { reason: "meet-admission-required", message },
          browserUrl: MEET_URL,
        },
        message,
      }),
    },
  });
  cli.expectText(
    output(),
    "Google Meet current tab: found",
    "target: tab-1",
    "manual reason: meet-admission-required",
  );
});

const session = meetSession({ id: "meet_gateway", transport: "chrome-node" });
const runSetup = (ok: boolean, id: string, message: string, args: string[]) =>
  run(args, { runtime: { setupStatus: async () => ({ ok, checks: [{ id, ok, message }] }) } });

type Result = Awaited<ReturnType<GoogleMeetRuntime["speak"]>> & { browserLeft?: boolean };
type Case = ["leave" | "speak", Result, string | Error];
const blocked = (message: string) =>
  meetSession({ chrome: { health: { speechBlockedMessage: message } } });
const cases: Case[] = [
  ["leave", { found: false, spoken: false }, new Error("session not found")],
  ["leave", { found: true, spoken: false }, "left meet_1\n"],
  [
    "leave",
    { found: true, spoken: false, browserLeft: false },
    "left meet_1, but the browser participant may still be in the call; check session notes\n",
  ],
  [
    "speak",
    { found: false, spoken: false, session: blocked("blocked") },
    new Error("session not found"),
  ],
  [
    "speak",
    { found: true, spoken: false, session: blocked("microphone muted") },
    new Error("microphone muted"),
  ],
  [
    "speak",
    { found: true, spoken: false },
    new Error("session has no active realtime audio bridge"),
  ],
  ["speak", { found: true, spoken: true }, "speaking on meet_1\n"],
];

it.each(cases)("%s returns %j", async (command, result, expected) => {
  const operation = vi.fn(async () => result);
  const parsed = run([command, "meet_1", ...(command === "speak" ? ["hello meeting"] : [])], {
    runtime: { [command]: operation },
  });
  if (expected instanceof Error) {
    await expect(parsed).rejects.toEqual(expected);
  } else {
    await parsed;
  }
  expect(output()).toBe(expected instanceof Error ? "" : expected);
  expect(operation.mock.calls).toEqual(
    command === "leave" ? [["meet_1"]] : [["meet_1", "hello meeting"]],
  );
});

it("prints setup checks as text and JSON", async () => {
  await runSetup(true, "audio-bridge", "audio ready", ["setup"]);
  expect(output()).toContain("Google Meet setup: OK");
  expect(output()).toContain("[ok] audio-bridge: audio ready");
  expect(output()).not.toContain('"checks"');

  await runSetup(false, "twilio-voice-call-plugin", "missing", ["setup", "--json"]);
  expect(json()).toMatchObject({
    ok: false,
    checks: [{ id: "twilio-voice-call-plugin", ok: false }],
  });
  expect(process.exitCode).toBe(1);
});

it("accepts --json on session status", async () => {
  const sessions = [
    meetSession({ transport: "twilio", participantIdentity: "Twilio PSTN participant" }),
  ];
  await run(["status", "--json"], { runtime: { status: async () => ({ found: true, sessions }) } });
  expect(json()).toMatchObject({
    found: true,
    sessions: [{ id: "meet_1", transport: "twilio" }],
  });
});

it("prints cursor-based transcripts from the gateway-owned runtime", async () => {
  const callGatewayFromCli = vi.fn(async () => ({
    found: true,
    sessionId: "meet_gateway",
    startIndex: 3,
    nextIndex: 4,
    droppedLines: 2,
    lines: [{ at: "2026-07-12T06:00:00.000Z", speaker: "Alice", text: "fourth line" }],
  }));

  await run(["transcript", "meet_gateway", "--since", "3"], { callGatewayFromCli });
  expect(callGatewayFromCli).toHaveBeenCalledWith(
    "googlemeet.transcript",
    expect.anything(),
    { sessionId: "meet_gateway", sinceIndex: 3 },
    expect.anything(),
  );
  cli.expectText(
    output(),
    "# 2 earlier lines dropped by the transcript cap",
    "Alice: fourth line",
    "# nextIndex: 4",
  );
});

it.each([
  ["join", "chrome-node", "realtime", { id: "meet_gateway", transport: "chrome-node" }],
  ["test-speech", "chrome", "bidi", { createdSession: true, session: { mode: "bidi" } }],
] as const)(
  "delegates %s to the gateway-owned runtime",
  async (command, transport, mode, expected) => {
    const result = {
      session: { ...session, transport, mode },
      ...(command === "test-speech" ? { createdSession: true } : {}),
    };
    const callGatewayFromCli = vi.fn(async () => result);
    const ensureRuntime = vi.fn(async () => {
      throw new Error("local runtime should not be loaded");
    });
    await run(
      [command, MEET_URL, "--transport", transport, "--mode", mode, "--message", "Hello meeting"],
      { callGatewayFromCli, ensureRuntime },
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      command === "join" ? "googlemeet.join" : "googlemeet.testSpeech",
      expect.anything(),
      expect.objectContaining({
        url: MEET_URL,
        transport,
        mode,
        message: "Hello meeting",
      }),
      expect.anything(),
    );
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(json()).toMatchObject(expected);
  },
);

it("runs a listen-first health probe", async () => {
  const testListen = vi.fn(async () => ({
    createdSession: true,
    inCall: true,
    manualAction: undefined,
    listenVerified: true,
    listenTimedOut: false,
    captioning: true,
    captionsEnabledAttempted: true,
    transcriptLines: 1,
    lastCaptionAt: undefined,
    lastCaptionSpeaker: undefined,
    lastCaptionText: undefined,
    recentTranscript: [],
    session: meetSession({ transport: "chrome-node", mode: "transcribe" }),
  }));

  await run(["test-listen", MEET_URL, "--transport", "chrome-node", "--timeout-ms", "30000"], {
    runtime: { testListen },
  });
  expect(testListen).toHaveBeenCalledWith({
    url: MEET_URL,
    transport: "chrome-node",
    timeoutMs: 30000,
  });
  expect(json()).toMatchObject({ listenVerified: true, transcriptLines: 1 });
});

it.each([
  ["setup --mode agnt", /mode must be/],
  ["setup --transport bad", /transport must be/],
  [
    "transcript meet_gateway --since 9007199254740992",
    /--since must be a non-negative safe integer/,
  ],
  [`test-listen ${MEET_URL} --timeout-ms 0x10`, /timeout-ms must be a positive number/],
  ["auth login --client-id client-id --timeout-sec 0", /timeout-sec must be a positive number/],
] satisfies Array<[string, RegExp]>)(
  "rejects invalid arguments %j before delegation",
  async (args, message) => {
    const operation = vi.fn();
    const callGatewayFromCli = vi.fn();
    await expect(
      run(args.split(" "), {
        runtime: { setupStatus: operation, testListen: operation },
        callGatewayFromCli,
      }),
    ).rejects.toThrow(message);
    expect(operation).not.toHaveBeenCalled();
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  },
);
