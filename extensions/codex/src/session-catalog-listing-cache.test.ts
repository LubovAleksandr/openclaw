import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { catalogFactory } from "./session-catalog-resident.test-support.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControl as makeControl,
  idleThread,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

const native = (fields: Partial<CodexThread> = {}) => idleThread({ source: "cli", ...fields });
const rpc = commandRpcMocks.codexControlRequest;
const configs = () => rpc.mock.calls.map((call) => call[3]?.config);

it("rejects shared cold waiters and recovers on the next initialization", async () => {
  const held = createDeferred<unknown>();
  const started = createDeferred<void>();
  commandRpcMocks.codexControlRequest.mockImplementationOnce(() => {
    started.resolve();
    return held.promise;
  });
  const control = makeControl();
  let delivered = 0;
  const lists = [
    { limit: 1 },
    { limit: 2, searchTerm: "native" },
    { cwd: "/workspace/project" },
  ].map((query) => control.listPage(query).finally(() => delivered++));
  const listed = Promise.allSettled(lists);
  const initialized = Promise.allSettled([control.initialize(), control.initialize()]);
  try {
    await started.promise;
    await nextTurn();
    expect(delivered).toBe(0);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    const failure = new Error("native hydration failed");
    held.reject(failure);
    const rejected = { status: "rejected", reason: failure };
    expect(await initialized).toEqual([rejected, rejected]);
    expect(await listed).toEqual([rejected, rejected, rejected]);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [native({ id: "thread-recovered" })],
    });
    await control.initialize();
    await expect(control.listPage({ limit: 25 })).resolves.toMatchObject({
      sessions: [{ threadId: "thread-recovered" }],
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  } finally {
    held.resolve({ data: [] });
    await Promise.all([initialized, listed]);
  }
});

it.each([
  ["repeated", "cycle", /repeated.*cursor/, 2],
  ["oversized", "x".repeat(4097), "Codex catalog response contains an invalid cursor", 1],
] as const)("rejects a %s native cursor", async (_label, nextCursor, error, calls) => {
  rpc.mockResolvedValue({ data: nextCursor === "cycle" ? [native()] : [], nextCursor });
  await expect(makeControl().initialize()).rejects.toThrow(error);
  expect(rpc).toHaveBeenCalledTimes(calls);
});

it("captures the current runtime config for each request", async () => {
  const initial: OpenClawConfig = { agents: { defaults: { workspace: "/workspace/a" } } };
  let runtimeConfig = initial;
  commandRpcMocks.codexControlRequest.mockResolvedValue({ thread: idleThread() });
  const factory = catalogFactory({ getRuntimeConfig: () => runtimeConfig });
  await factory.forRequest("main").readThread("thread-1");
  runtimeConfig = { agents: { defaults: { workspace: "/workspace/b" } } };
  await factory.forRequest("main").readThread("thread-1");
  expect(configs()).toEqual([initial, runtimeConfig]);
});

it("keeps a title-search cursor chain on its initial App Server configuration", async () => {
  const plugin = (command: string) => ({ appServer: { command }, supervision: { enabled: true } });
  let pluginConfig = plugin("codex-initial");
  commandRpcMocks.codexControlRequest
    .mockImplementationOnce(async () => {
      pluginConfig = plugin("codex-reconfigured");
      return {
        data: [native({ id: "other", name: "Unrelated" })],
        nextCursor: "page-2",
      };
    })
    .mockResolvedValueOnce({
      data: [native({ id: "match", name: "Match" })],
    });
  const control = makeControl({ getPluginConfig: () => pluginConfig });

  await control.initialize();
  await expect(control.listPage({ limit: 1, searchTerm: "match" })).resolves.toMatchObject({
    sessions: [{ threadId: "match" }],
  });
  expect(
    commandRpcMocks.codexControlRequest.mock.calls.map(
      (call) => (call[3]?.startOptions as { command?: string } | undefined)?.command,
    ),
  ).toEqual(["codex-initial", "codex-initial"]);
});

it("keeps every Codex interactive source while omitting other custom sources", async () => {
  const sources: Array<[string, CodexThread["source"]]> = [
    ["cli", "cli"],
    ["vscode", "vscode"],
    ["atlas", { custom: "atlas" }],
    ["chatgpt", { custom: "chatgpt" }],
    ["exec", "exec"],
    ["app-server", "appServer"],
    ["subagent", { subAgent: "review" }],
    ["custom", { custom: "integration" }],
    ["unknown", "unknown"],
    ["missing", undefined],
  ];
  commandRpcMocks.codexControlRequest.mockResolvedValue({
    data: sources.map(([id, source], index) => idleThread({ id, source, recencyAt: 100 - index })),
  });
  const control = makeControl();

  await control.initialize();
  const page = await control.listPage({});

  expect(page.sessions.map(({ threadId, source }) => [threadId, source])).toEqual(
    ["cli", "vscode", "atlas", "chatgpt"].map((source) => [source, source]),
  );
});
