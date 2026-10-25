import {
  createServer,
  request as httpRequest,
  IncomingMessage,
  ServerResponse,
  type ClientRequest,
} from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { PassThrough, Writable, type Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveSecretSentinel, sealSecretSentinel } from "../sentinel.js";
import { createSecretEgressBodyBudget, forwardSecretEgressRequest } from "./proxy-forward.js";

vi.mock("node:https", { spy: true });

type ForwardOptions = Parameters<typeof forwardSecretEgressRequest>[0];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function forwarding(
  request = new IncomingMessage(new Socket()),
  response = new ServerResponse(request),
) {
  request.on("error", () => {});
  const agent = new Agent();
  const resources: Array<Readable | Writable> = [];
  cleanups.push(() => {
    for (const resource of resources) {
      resource.destroy();
    }
    request.destroy();
    response.destroy();
    agent.destroy();
  });
  return {
    request,
    response,
    resources,
    run(overrides: Partial<ForwardOptions> = {}) {
      forwardSecretEgressRequest({
        request,
        response,
        host: "localhost",
        upstreamTlsAgent: agent,
        prepareRequest: () => ({
          target: new URL("https://localhost:1/"),
          headers: {},
          substituted: false,
        }),
        acquireBody: createSecretEgressBodyBudget(),
        isActive: () => true,
        ownResource: (resource) => {
          resources.push(resource);
          return resource;
        },
        releaseResponse() {},
        resolveSentinel() {
          return undefined;
        },
        audit() {},
        ...overrides,
      });
    },
  };
}

it.each([undefined, 0])(
  "releases body streams when upstream construction fails (length: %s)",
  async (length) => {
    const { request, response, resources, run } = forwarding();
    request.headers = length === undefined ? {} : { "content-length": String(length) };
    request.method = "POST";
    run({
      // A protected value can contain newlines. Node refuses this header
      // synchronously, before DNS, TLS or any upstream socket is opened.
      prepareRequest: () => ({
        target: new URL("https://localhost:1/"),
        headers: { "x-synthetic": "invalid\nheader" },
        substituted: true,
      }),
      ownResource: (resource) => {
        resources.push(resource);
        resource.on("error", () => resource.destroy());
        return resource;
      },
    });
    request.push(null);
    await setImmediate();
    response.emit("close");
    await setImmediate();
    expect(response.statusCode).toBe(502);
    expect(resources.every((resource) => resource.destroyed)).toBe(true);
  },
);

it.each([
  ["run revocation", "drain"],
  ["run revocation", "next turn"],
  ["client disconnect", "drain"],
  ["client disconnect", "next turn"],
] as const)("stops buffered submission after %s while waiting for %s", async (cause, wait) => {
  const secret = "synthetic-buffered-secret";
  const body = Buffer.concat([
    Buffer.alloc(128 * 1024, 120),
    Buffer.from(sealSecretSentinel(secret, { label: "buffered-cancellation" }) + "tail"),
  ]);
  const { request, response, run } = forwarding();
  request.headers = { "content-length": String(body.length) };
  request.method = "POST";
  const submitted: Buffer[] = [];
  let completeWrite: (error?: Error | null) => void = () => {};
  const started = createDeferredCore();
  // Real Writable backpressure controls transport admission without relying on
  // platform socket buffers or adding a test-only production hook.
  const upstream = new Writable({
    highWaterMark: wait === "drain" ? 1 : body.length + 1,
    write(chunk: Buffer, _encoding, callback) {
      submitted.push(Buffer.from(chunk));
      completeWrite = callback;
      started.resolve();
    },
  });
  vi.mocked(httpsRequest).mockReturnValueOnce(upstream as unknown as ClientRequest);
  const releaseBody = vi.fn();
  const audit = vi.fn();
  let active = true;
  run({
    acquireBody: () => releaseBody,
    isActive: () => active,
    resolveSentinel: resolveSecretSentinel,
    audit,
  });
  request.push(body);
  request.push(null);
  await started.promise;
  expect(releaseBody).not.toHaveBeenCalled();
  if (cause === "client disconnect") {
    response.emit("close");
  } else {
    active = false;
  }
  completeWrite();
  await setImmediate();
  await setImmediate();
  const sent = Buffer.concat(submitted);
  expect(sent.length).toBeLessThan(body.length);
  expect(sent.includes(secret)).toBe(false);
  expect(sent.includes("tail")).toBe(false);
  expect(upstream.destroyed).toBe(true);
  expect(upstream.writableEnded).toBe(false);
  expect(releaseBody).toHaveBeenCalledOnce();
  expect(audit).not.toHaveBeenCalled();
});

// Serves one real loopback request through the proxy forwarder. The upstream
// response is emitted on a later tick, like the real client, so a throw from
// writeHead would escape instead of landing in the forwarder's own try block.
it("closes a rejected bodyless head instead of framing a 502 body", async () => {
  vi.mocked(httpsRequest).mockImplementationOnce(((...args: unknown[]) => {
    const callback = args.find((entry) => typeof entry === "function") as (
      message: IncomingMessage,
    ) => void;
    const upstreamResponse = new IncomingMessage(new Socket());
    upstreamResponse.statusCode = 304;
    upstreamResponse.headers = { trailer: "Expires" };
    upstreamResponse.on("error", () => {});
    process.nextTick(() => {
      callback(upstreamResponse);
      if (!upstreamResponse.destroyed) {
        upstreamResponse.push("file");
        upstreamResponse.push(null);
      }
    });
    return new PassThrough() as unknown as ClientRequest;
  }) as never);
  const server = createServer((request, response) => forwarding(request, response).run());
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    // Rejection proves no head reached the client; Vitest catches uncaught callback errors.
    await expect(
      new Promise<IncomingMessage>((resolve, reject) => {
        httpRequest({ host: "127.0.0.1", port, path: "/", agent: false }, resolve)
          .on("error", reject)
          .end();
      }),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    await setImmediate();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
