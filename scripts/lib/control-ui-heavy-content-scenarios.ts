import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { projectAgentToolActivity } from "../../src/infra/agent-activity-events.js";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createHeavyContentImageSources } from "./control-ui-heavy-content-images.ts";
import type { InteractionScenario } from "./control-ui-interaction-scenarios.ts";

const sessionKey = "agent:main:interaction-a";
const pane = ".chat-pane-cache__pane--active";
const runs = new WeakMap<Page, string>();
let nativeImageSources: string[] | undefined;
type WorkerObservation = {
  starts: number;
  replies: number;
  errors: number;
  terminations: number;
  active: number;
};
declare global {
  interface Window {
    /** Installed before startup in the isolated heavy-content fixture. */
    heavyContentWorkers: WorkerObservation;
  }
}
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsHeERQyjAWRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0B06OyaOxP7RwAAAAASUVORK5CYII=";

/** Sizes intentionally exercise both sides of the existing 40,000-character parse limit. */
const heavyContentFixtures = [
  {
    id: "code",
    text: `\`\`\`ts\n${"let x;\n".repeat(5_000)}\`\`\``,
    code: "let x;\n".repeat(5_000),
    kind: "code",
  },
  {
    id: "auto-code",
    text: `\`\`\`\n${"x+=1;\n".repeat(5_000)}\`\`\``,
    code: "x+=1;\n".repeat(5_000),
    kind: "code",
  },
  {
    id: "unsupported-code",
    text: `\`\`\`sql\n${"-- x\n".repeat(5_000)}\`\`\``,
    kind: "code",
  },
  {
    id: "diff",
    text: `\`\`\`diff\n${Array.from({ length: 10 }, (_, file) => `--- a/f${file}\n+++ b/f${file}\n@@ -1,250 +1,250 @@\n${"-old\n+new\n".repeat(250)}`).join("")}\`\`\``,
    kind: "code",
  },
  {
    id: "oversized-code",
    text: `\`\`\`ts\n${"const item = { value: 1 };\n".repeat(5_000)}\`\`\``,
    kind: "fallback",
  },
  {
    id: "table",
    text: `|${Array.from({ length: 12 }, (_, i) => `C${i}`).join("|")}|\n|${"---|".repeat(12)}\n${Array.from({ length: 300 }, (_, row) => `|${Array.from({ length: 12 }, (_cell, col) => `${row}-${col}`).join("|")}|`).join("\n")}`,
    kind: "table",
  },
  { id: "tool-diff", text: "@@\n" + "-old\n+new\n".repeat(2_500), kind: "tool" },
  { id: "tool-diff-error", text: "@@\n" + "-old\n+new\n".repeat(2_500), kind: "tool" },
  { id: "terminal", text: "ok\n".repeat(5_000), kind: "tool" },
  {
    id: "json",
    text: JSON.stringify(Array.from({ length: 5_000 }, (_, i) => i)),
    kind: "tool",
  },
  {
    id: "json-format",
    text: JSON.stringify(Array.from({ length: 1_900 }, (_, i) => i)),
    kind: "tool",
  },
  {
    id: "images",
    text: Array.from(
      { length: 40 },
      (_, i) => `![Synthetic image ${i}](data:image/png;base64,${png})`,
    ).join("\n\n"),
    kind: "images",
  },
  {
    id: "large-images",
    text: "Forty distinct 1-megapixel synthetic images.",
    kind: "native-images",
  },
] as const;
type Fixture = (typeof heavyContentFixtures)[number];

function rawToolOutput(fixture: Fixture) {
  if (fixture.id === "tool-diff-error") {
    return "Patch context did not match";
  }
  return fixture.id === "terminal" || fixture.id.startsWith("json")
    ? JSON.stringify([{ type: "input_text", text: fixture.text }])
    : fixture.text;
}

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function workerObservation(page: Page) {
  return page.evaluate(() => {
    // SAFETY: The heavy-content init script owns this page-local observation.
    return {
      ...window.heavyContentWorkers,
    };
  });
}

function codeSource(fixture: Fixture) {
  return fixture.text.slice(fixture.text.indexOf("\n") + 1, -3);
}

async function settleCode(page: Page, fixture: Fixture, full = false) {
  const code = page.locator(`${pane} .chat-bubble`).last().locator("pre code");
  if (fixture.id === "auto-code" || fixture.id === "unsupported-code") {
    // A no-op reply has no visible syntax marker, so observe the worker's real completion.
    await page.waitForLoadState("networkidle");
    await frames(page);
    if ((await code.getAttribute("data-code-highlight")) !== null) {
      await page.waitForFunction(() => {
        // SAFETY: Installed by this fixture before application startup.
        const workers = window.heavyContentWorkers;
        return workers.starts > 0 && workers.active === 0;
      });
    }
  } else {
    const selector = fixture.id === "code" ? ".hljs-keyword" : "span";
    const minimum = full ? (fixture.id === "code" ? 5_000 : 5_030) : 7;
    await page.waitForFunction(
      ({ codeSelector, tokenMinimum, rootSelector }) => {
        const block = [...document.querySelectorAll(`${rootSelector} .chat-bubble`)].at(-1);
        return (
          (block?.querySelector("pre code")?.querySelectorAll(codeSelector).length ?? 0) >=
          tokenMinimum
        );
      },
      { codeSelector: selector, tokenMinimum: minimum, rootSelector: pane },
    );
  }
  if ((await code.textContent()) !== codeSource(fixture)) {
    throw new Error("Syntax decoration changed the complete source text");
  }
  const observed = await workerObservation(page);
  if (observed.errors) {
    throw new Error("The highlighting worker reported an error");
  }
  if (observed.starts > 0) {
    await page.waitForFunction(() => {
      // SAFETY: Installed by this fixture before application startup.
      return window.heavyContentWorkers.active === 0;
    });
  }
}

async function prepare(page: Page, gateway: MockGatewayControls) {
  const input = page.locator(`${pane} .agent-chat__composer-combobox textarea`);
  await input.fill("Render the synthetic heavy-content fixture.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const request = await gateway.waitForRequest("chat.send");
  const runId = isRecord(request.params) ? request.params.idempotencyKey : undefined;
  if (typeof runId !== "string") {
    throw new Error("The synthetic chat.send request did not include its run ID");
  }
  runs.set(page, runId);
}

async function deliver(
  page: Page,
  gateway: MockGatewayControls,
  fixture: Fixture,
  stream: boolean,
  readiness: "raw" | "preview" = "preview",
) {
  const runId = runs.get(page)!;
  if (fixture.kind === "native-images") {
    await gateway.emitGatewayEvent("chat", {
      sessionKey,
      runId,
      state: "final",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: fixture.text },
          ...nativeImageSources!.map((url, index) => ({
            type: "image",
            url,
            alt: `Synthetic large image ${index + 1}`,
            width: 1_024,
            height: 1_024,
          })),
        ],
        timestamp: Date.now(),
      },
    });
    await page.waitForFunction((rootSelector) => {
      const images = document.querySelectorAll<HTMLImageElement>(
        `${rootSelector} .chat-message-image`,
      );
      return (
        images.length === 40 &&
        [...images].every(
          (image) =>
            image.complete && image.naturalWidth === 1_024 && image.naturalHeight === 1_024,
        )
      );
    }, pane);
    await frames(page);
    return;
  }
  if (fixture.kind === "tool") {
    const isPatch = fixture.id.startsWith("tool-diff");
    const isError = fixture.id === "tool-diff-error";
    const name = isPatch ? "apply_patch" : "exec";
    const args = isPatch
      ? { changes: [{ path: "synthetic.ts", kind: { type: "update" }, diff: fixture.text }] }
      : { input: "text(await tools.exec_command({cmd: 'synthetic-fixture'}));" };
    await gateway.emitGatewayEvent("agent", {
      sessionKey,
      runId,
      seq: 1,
      stream: "item",
      ts: Date.now(),
      data: projectAgentToolActivity({ phase: "start", toolCallId: "heavy-output", name, args }),
    });
    const output = rawToolOutput(fixture);
    const chunks = stream ? 20 : 1;
    for (let index = 1; index <= chunks; index++) {
      await gateway.emitGatewayEvent("agent", {
        sessionKey,
        runId,
        seq: index + 1,
        stream: "item",
        ts: Date.now(),
        data: projectAgentToolActivity({
          phase: index === chunks ? "result" : "update",
          toolCallId: "heavy-output",
          name,
          args,
          ...(isError ? { isError } : {}),
          result: {
            content: [
              {
                type: "text",
                text: output.slice(0, Math.ceil((output.length * index) / chunks)),
              },
            ],
          },
        }),
      });
      if (stream) {
        await frames(page);
      }
    }
    const message = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "heavy-output", name, arguments: args },
        {
          type: "toolResult",
          id: "heavy-output",
          name,
          text: output,
          isError,
          ...(isPatch
            ? {}
            : {
                __openclaw: {
                  toolOutput: { source: "provider-response", modelInput: "unverified" },
                },
              }),
        },
      ],
      timestamp: Date.now(),
      __openclaw: { id: "heavy-result", seq: 2, runId, runTerminal: true },
    };
    await gateway.emitGatewayEvent("session.message", {
      sessionKey,
      runId,
      message,
      messageId: "heavy-result",
      messageSeq: 2,
    });
    await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "final", message });
    await page
      .locator(`${pane} .chat-activity-group__summary, ${pane} .chat-tool-msg-summary`)
      .first()
      .waitFor();
    return;
  }
  if (stream) {
    for (let index = 1; index <= 20; index++) {
      const start = Math.ceil((fixture.text.length * (index - 1)) / 20);
      const end = Math.ceil((fixture.text.length * index) / 20);
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "delta",
        deltaText: fixture.text.slice(start, end),
        message: {
          role: "assistant",
          content: [{ type: "text", text: fixture.text.slice(0, end) }],
        },
      });
      await frames(page);
    }
  }
  await gateway.emitChatFinal({ sessionKey, runId, text: fixture.text });
  const bubble = page.locator(`${pane} .chat-bubble`).last();
  await bubble.waitFor();
  if (fixture.kind === "code") {
    await bubble.locator(".code-block-expand").waitFor();
    if (readiness === "preview") {
      await settleCode(page, fixture);
    }
  }
  if (fixture.kind === "table") {
    await bubble.locator("table tbody tr").last().waitFor();
  }
  if (fixture.kind === "images") {
    await bubble.locator("img").last().waitFor();
  }
  if (readiness !== "raw" || fixture.kind !== "code") {
    await frames(page);
  }
  if ((await bubble.getAttribute("data-message-text")) !== fixture.text) {
    throw new Error("Full source message was not retained");
  }
  if (fixture.kind === "code") {
    const actual = await bubble.locator("pre code").textContent();
    const expected = codeSource(fixture);
    if (actual !== expected) {
      throw new Error(`Code content mismatch: ${actual?.length} != ${expected.length}`);
    }
  }
  if (fixture.kind === "table" && (await bubble.locator("tbody tr").count()) !== 300) {
    throw new Error("Expected all 300 table rows");
  }
  if (fixture.kind === "images" && (await bubble.locator(".chat-text img").count()) !== 40) {
    throw new Error("Expected all 40 synthetic images");
  }
  if (
    fixture.kind === "fallback" &&
    !((await bubble.textContent()) ?? "").includes("const item = { value: 1 };")
  ) {
    throw new Error("Oversized fallback did not render");
  }
}

async function openTool(page: Page) {
  const group = page.locator(`${pane} .chat-activity-group__summary`).last();
  if ((await group.isVisible()) && (await group.getAttribute("aria-expanded")) !== "true") {
    await group.click();
  }
  const summary = page
    .locator(
      `${pane} .chat-tool-row__toggle:not(:disabled), ${pane} button.chat-tool-msg-summary:not(:disabled)`,
    )
    .last();
  await summary.waitFor();
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.press("Enter");
  }
  await page.locator(`${pane} .chat-tool-msg-body`).last().waitFor();
  await page.waitForLoadState("networkidle");
  await frames(page);
}

async function evidence(page: Page, fixture: Fixture) {
  return {
    ...(await page.evaluate(
      ({ selector, chars, kind }) => {
        const root = document.querySelector(selector)!;
        return {
          fixtureChars: chars,
          codeBlocks: root.querySelectorAll(".code-block-wrapper").length,
          highlightedSpans: root.querySelectorAll("code span").length,
          codeTextChars: [...root.querySelectorAll("pre code")].reduce(
            (sum, node) => sum + (node.textContent?.length ?? 0),
            0,
          ),
          tableRows: root.querySelectorAll("tbody tr").length,
          images: root.querySelectorAll("img").length,
          loadedImagePixels: [
            ...root.querySelectorAll<HTMLImageElement>(".chat-message-image"),
          ].reduce((total, image) => total + image.naturalWidth * image.naturalHeight, 0),
          diffRows: root.querySelectorAll(".chat-diff__row").length,
          contentIsFallback:
            kind === "fallback" && root.querySelectorAll(".code-block-wrapper").length === 0,
          domElements: root.querySelectorAll("*").length,
        };
      },
      { selector: pane, chars: fixture.text.length, kind: fixture.kind },
    )),
    ...(fixture.kind === "native-images"
      ? {
          encodedImageBytes: nativeImageSources!.reduce(
            (total, source) => total + source.length,
            0,
          ),
        }
      : {}),
    ...(await workerObservation(page)),
  };
}

export const heavyContentScenarios: InteractionScenario[] = heavyContentFixtures.flatMap(
  (fixture) => {
    const shared = {
      route: controlUiSessionPath(sessionKey),
      fixture: { heavyContent: true },
      resourceOnly: true,
      setup: async (page: Page) => {
        if (fixture.kind === "native-images") {
          // Generate once outside the measured interval; every arm receives identical bytes.
          nativeImageSources ??= createHeavyContentImageSources();
        }
        await page.addInitScript(() => {
          const observation: WorkerObservation = {
            starts: 0,
            replies: 0,
            errors: 0,
            terminations: 0,
            active: 0,
          };
          // SAFETY: This synthetic fixture owns its page and observation property.
          window.heavyContentWorkers = observation;
          const NativeWorker = window.Worker;
          const observed = new WeakSet<Worker>();
          window.Worker = class extends NativeWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              if (!String(url).includes("markdown-code-highlight")) {
                return;
              }
              observed.add(this);
              observation.starts++;
              observation.active++;
              this.addEventListener("message", () => observation.replies++);
              this.addEventListener("error", () => observation.errors++);
            }
            override terminate() {
              if (observed.delete(this)) {
                observation.terminations++;
                observation.active--;
              }
              super.terminate();
            }
          };
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text: string) => {
                // SAFETY: This scenario owns the page-local clipboard observation.
                (window as Window & { heavyContentCopied?: string }).heavyContentCopied = text;
              },
            },
          });
        });
      },
    };
    // Native image cards publish with the final message; Markdown images also stream.
    const streams = fixture.kind === "native-images" ? [false] : [false, true];
    const scenarios: InteractionScenario[] = streams.map((stream) => ({
      route: shared.route,
      fixture: shared.fixture,
      resourceOnly: shared.resourceOnly,
      setup: shared.setup,
      id: `heavy-${fixture.id}-${stream ? "stream" : "arrival"}`,
      expected: `${fixture.id}: complete ${fixture.text.length}-character synthetic content ${stream ? "streams in 20 frame-separated chunks" : "arrives in one event"}; raw content remains available.`,
      prepare,
      run: async (page, gateway) => {
        await deliver(page, gateway, fixture, stream);
        return evidence(page, fixture);
      },
    }));
    if (fixture.kind === "code") {
      for (const stream of [false, true]) {
        scenarios.push({
          ...shared,
          id: `heavy-${fixture.id}-raw-${stream ? "stream" : "arrival"}`,
          expected: "Complete source text is readable before deferred syntax decoration finishes.",
          prepare,
          run: async (page, gateway) => {
            await deliver(page, gateway, fixture, stream, "raw");
            return evidence(page, fixture);
          },
        });
        scenarios.push({
          ...shared,
          id: `heavy-${fixture.id}-full-${stream ? "stream" : "arrival"}`,
          expected:
            "Immediate expansion preserves the full source and finishes all syntax decoration.",
          prepare,
          run: async (page, gateway) => {
            await deliver(page, gateway, fixture, stream, "raw");
            await page.locator(`${pane} .code-block-expand`).last().click();
            await settleCode(page, fixture, true);
            return evidence(page, fixture);
          },
        });
      }
    }
    if (fixture.kind === "code" || fixture.kind === "tool") {
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-expand`,
        expected: "The existing disclosure reveals the complete heavy content.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
        },
        run: async (page) => {
          if (fixture.kind === "tool") {
            await openTool(page);
            if (fixture.id === "tool-diff-error") {
              const raw = page.getByRole("tab", { name: "Raw", exact: true });
              if ((await raw.getAttribute("aria-selected")) !== "true") {
                throw new Error("Rejected patch did not default to its Raw output");
              }
              const output = page.locator(`${pane} [id$="-raw-panel"] code`);
              if ((await output.textContent()) !== rawToolOutput(fixture)) {
                throw new Error("Rejected patch did not show its complete error output");
              }
            }
          } else {
            await page.locator(`${pane} .code-block-expand`).last().click();
            await page.locator(`${pane} .code-block-wrapper.is-expanded`).last().waitFor();
            await settleCode(page, fixture, true);
          }
          return evidence(page, fixture);
        },
      });
    }
    if (fixture.kind === "tool") {
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-collapse`,
        expected: "The existing tool disclosure collapses after rendering the full output.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
          await openTool(page);
        },
        run: async (page) => {
          await page
            .locator(`${pane} .chat-tool-row__toggle, ${pane} button.chat-tool-msg-summary`)
            .last()
            .press("Enter");
          await page.locator(`${pane} .chat-tool-msg-body`).last().waitFor({ state: "hidden" });
          return evidence(page, fixture);
        },
      });
    }
    scenarios.push({
      ...shared,
      id: `heavy-${fixture.id}-scroll`,
      expected: "Native scrolling traverses every viewport band across the heavy content.",
      prepare: async (page, gateway) => {
        await prepare(page, gateway);
        await deliver(page, gateway, fixture, false);
        if (fixture.kind === "tool") {
          await openTool(page);
        }
        if (fixture.kind === "code") {
          await page.locator(`${pane} .code-block-expand`).last().click();
          await settleCode(page, fixture, true);
        }
      },
      run: async (page) => {
        const thread = page.locator(`${pane} .chat-thread`);
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await frames(page);
        const geometry = await thread.evaluate((element) => ({
          height: element.clientHeight,
          travel: element.scrollHeight - element.clientHeight,
        }));
        if (geometry.height <= 0) {
          throw new Error("The content scroll fixture has no visible scroll viewport");
        }
        const distance = geometry.height * 0.75;
        const scrollSteps = Math.ceil(geometry.travel / distance);
        // Traverse viewport bands; a single jump skips intermediate paint and image work.
        for (let step = 0; step < scrollSteps; step++) {
          await page.mouse.wheel(0, distance);
          await frames(page);
        }
        return { ...(await evidence(page, fixture)), scrollSteps };
      },
    });
    if (fixture.id === "tool-diff") {
      scenarios.push({
        ...shared,
        id: "heavy-tool-diff-tab-roundtrip",
        expected:
          "Diff to Raw to Diff preserves the existing bounded preview for 5,000 input lines.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
          await openTool(page);
        },
        run: async (page) => {
          await page.getByRole("tab", { name: "Raw", exact: true }).click();
          await page.locator(`${pane} .chat-tool-card__block-content`).last().waitFor();
          await page.getByRole("tab", { name: "Diff", exact: true }).click();
          await page.locator(`${pane} .chat-diff`).waitFor();
          await page.waitForLoadState("networkidle");
          await frames(page);
          const rows = await page.locator(`${pane} .chat-diff__row`).count();
          if (rows < 400 || rows > 402) {
            throw new Error(`Expected the existing 400-line preview cap, received ${rows} rows`);
          }
          return { ...(await evidence(page, fixture)), diffRows: rows };
        },
      });
    }
    if (fixture.kind === "tool") {
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-copy`,
        expected: "Opening full output and copying preserves every original character.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
          await openTool(page);
          await page.locator(`${pane} .chat-tool-card__action-btn`).last().click();
          await page.locator(".chat-tool-output__actions").waitFor();
        },
        run: async (page) => {
          await page
            .locator(".chat-tool-output__actions")
            .getByRole("button", { name: "Copy available output", exact: true })
            .click();
          const copied = await page.evaluate(() => {
            // SAFETY: The scenario's init script installs this clipboard observation.
            return (window as Window & { heavyContentCopied?: string }).heavyContentCopied;
          });
          if (copied !== rawToolOutput(fixture)) {
            throw new Error(
              `Tool copy mismatch: ${copied?.length} != ${rawToolOutput(fixture).length}`,
            );
          }
          return { ...(await evidence(page, fixture)), copiedChars: copied.length };
        },
      });
    }
    if (fixture.kind === "tool" && !fixture.id.startsWith("tool-diff")) {
      const openOutput = async (page: Page) => {
        await openTool(page);
        await page.locator(`${pane} .chat-tool-card__action-btn`).last().click();
        await page.locator(".chat-tool-output__text").waitFor();
      };
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-output-open`,
        expected: "The full tool-output sidebar formats all output.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
          await openTool(page);
        },
        run: async (page) => {
          await page.locator(`${pane} .chat-tool-card__action-btn`).last().click();
          await page.locator(".chat-tool-output__text").waitFor();
          const shown = (await page.locator(".chat-tool-output__text").textContent()) ?? "";
          const expected =
            fixture.id === "json-format"
              ? JSON.stringify(JSON.parse(fixture.text), null, 2)
              : fixture.text;
          if (shown !== expected) {
            throw new Error("Full output display did not preserve the fixture");
          }
          return {
            ...(await evidence(page, fixture)),
            outputChars: shown.length,
          };
        },
      });
      if (fixture.id.startsWith("json")) {
        scenarios.push({
          ...shared,
          id: `heavy-${fixture.id}-raw-toggle`,
          expected:
            "Raw JSON mounts only on disclosure, remains complete, and unmounts on collapse.",
          prepare: async (page, gateway) => {
            await prepare(page, gateway);
            await deliver(page, gateway, fixture, false);
            await openOutput(page);
          },
          run: async (page) => {
            const toggle = page.locator(".chat-tool-output .chat-tool-card__raw-toggle");
            await toggle.click();
            const raw = page.locator(".chat-tool-output .chat-tool-card__raw-body code");
            if ((await raw.textContent()) !== rawToolOutput(fixture)) {
              throw new Error("Raw output mismatch");
            }
            await toggle.click();
            await raw.waitFor({ state: "hidden" });
            return evidence(page, fixture);
          },
        });
      }
    }
    if (fixture.kind === "code") {
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-copy`,
        expected: "The copy action supplies every source character, including the collapsed tail.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
        },
        run: async (page) => {
          await page.locator(`${pane} .code-block-copy`).last().click();
          const copied = await page.evaluate(() => {
            // SAFETY: The scenario's init script installs this clipboard observation.
            return (window as Window & { heavyContentCopied?: string }).heavyContentCopied;
          });
          const source =
            "code" in fixture
              ? fixture.code
              : fixture.text.slice(fixture.text.indexOf("\n") + 1, -3);
          const expected = source.replace(/\n$/, "");
          if (copied !== expected) {
            throw new Error(`Copy mismatch: ${copied?.length} != ${expected.length}`);
          }
          return { ...(await evidence(page, fixture)), copiedChars: copied.length };
        },
      });
      if (fixture.id === "code") {
        scenarios.push({
          ...shared,
          id: "heavy-code-retirement-gc",
          diagnostic: "Forced-GC component-retirement probe; not CPU or latency acceptance.",
          expected:
            "Ten replacements of one canonical message retire every code island and worker; post-clear heap samples expose retention.",
          prepare: async () => {},
          run: async (page, gateway) => {
            const cdp = await page.context().newCDPSession(page);
            const session = await gateway.getSessionRow(sessionKey);
            const heapPoints: number[] = [];
            const report: Record<string, number | boolean> = {};
            const publish = async (text: string) => {
              const message = {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
                __openclaw: { id: "heavy-retirement-result", seq: 1 },
              };
              await gateway.setMethodResponse("chat.history", {
                sessionId: session.sessionId,
                messages: [message],
              });
              // A bodyless committed-message event requests an authoritative history refresh.
              // Replacing an already-persisted live row is not the live append contract.
              await gateway.emitGatewayEvent("sessions.changed", {
                sessionKey,
                phase: "message",
              });
              await page.waitForFunction(
                ({ rootSelector, expectedText }) =>
                  [...document.querySelectorAll(`${rootSelector} .chat-bubble`)].some(
                    (bubble) => bubble.getAttribute("data-message-text") === expectedText,
                  ),
                { rootSelector: pane, expectedText: text },
              );
            };
            try {
              await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
              for (let round = 0; round < 10; round++) {
                const previous = await workerObservation(page);
                const code = `let ${round % 2 ? "b" : "a"};\n`.repeat(5_000);
                const next: typeof fixture = { ...fixture, code, text: `\`\`\`ts\n${code}\`\`\`` };
                await publish(next.text);
                const block = page.locator(`${pane} .code-block-wrapper`).last();
                await block.waitFor();
                if (round < 2) {
                  await block.locator(".code-block-expand").click();
                  await settleCode(page, next, true);
                } else if (
                  (await block.locator("pre code").getAttribute("data-code-highlight")) !== null
                ) {
                  await page.waitForFunction(
                    (priorStarts) => window.heavyContentWorkers.starts > priorStarts,
                    previous.starts,
                  );
                }
                await publish("Retired synthetic code content.");
                await page.locator(`${pane} .code-block-wrapper`).waitFor({ state: "detached" });
                await page.waitForFunction(() => window.heavyContentWorkers.active === 0);
                await page.waitForLoadState("networkidle");
                await frames(page);
                await cdp.send("HeapProfiler.collectGarbage");
                const measured: { metrics: Array<{ name: string; value: number }> } =
                  await cdp.send("Performance.getMetrics");
                const heapBytes = measured.metrics.find(
                  ({ name }) => name === "JSHeapUsedSize",
                )?.value;
                if (heapBytes === undefined) {
                  throw new Error("The forced-GC probe did not receive a heap sample");
                }
                heapPoints.push(heapBytes);
                report[`heapAfterClear${round + 1}Bytes`] = heapBytes;
              }
              const observed = await workerObservation(page);
              if (observed.active || observed.errors || observed.starts !== observed.terminations) {
                throw new Error("Retired code left an active or failed highlighting worker");
              }
              const settled = heapPoints.slice(2);
              return {
                ...(await evidence(page, fixture)),
                ...report,
                forcedGcRounds: heapPoints.length,
                postWarmupHeapMinBytes: Math.min(...settled),
                postWarmupHeapMaxBytes: Math.max(...settled),
                postWarmupHeapChangeBytes: settled.at(-1)! - settled[0]!,
              };
            } finally {
              await cdp.detach();
            }
          },
        });
        scenarios.push({
          ...shared,
          id: "heavy-code-selection",
          expected:
            "Selecting pending source preserves the selection; complete syntax resumes after it clears.",
          prepare: async (page, gateway) => {
            await prepare(page, gateway);
            await deliver(page, gateway, fixture, false);
          },
          run: async (page) => {
            const selected = await page.evaluate((rootSelector) => {
              const block = [
                ...document.querySelectorAll(`${rootSelector} .code-block-wrapper`),
              ].at(-1)!;
              const code = block.querySelector("pre code")!;
              block.querySelector<HTMLButtonElement>(".code-block-expand")!.click();
              const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
              const range = document.createRange();
              let offset = 0;
              let node: Node | null;
              while ((node = walker.nextNode())) {
                const end = offset + (node.textContent?.length ?? 0);
                if (offset <= 2_000 && end > 2_000) {
                  range.setStart(node, 2_000 - offset);
                }
                if (offset < 2_070 && end >= 2_070) {
                  range.setEnd(node, 2_070 - offset);
                  break;
                }
                offset = end;
              }
              const selection = window.getSelection()!;
              selection.removeAllRanges();
              selection.addRange(range);
              return selection.toString();
            }, pane);
            if (selected !== codeSource(fixture).slice(2_000, 2_070)) {
              throw new Error("Selection setup did not select the requested source substring");
            }
            await page.evaluate(async () => {
              for (let frame = 0; frame < 8; frame++) {
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => resolve());
                });
              }
            });
            const after = await page.evaluate(() => window.getSelection()?.toString());
            if (after !== selected) {
              throw new Error(
                `Syntax decoration changed selected text from ${selected.length} to ${after?.length ?? 0} characters`,
              );
            }
            const code = page.locator(`${pane} .chat-bubble`).last().locator("pre code");
            if ((await code.textContent()) !== codeSource(fixture)) {
              throw new Error("Selection pause changed the complete source text");
            }
            await page.evaluate(() => window.getSelection()?.removeAllRanges());
            await settleCode(page, fixture, true);
            const highlightedSelection = await page.evaluate((rootSelector) => {
              const keyword = document.querySelector(`${rootSelector} pre code .hljs-keyword`)!;
              const range = document.createRange();
              range.selectNodeContents(keyword);
              const selection = window.getSelection()!;
              selection.removeAllRanges();
              selection.addRange(range);
              return selection.toString();
            }, pane);
            if (highlightedSelection !== "let") {
              throw new Error("Completed syntax did not retain native keyword selection");
            }
            return {
              ...(await evidence(page, fixture)),
              selectedChars: selected.length,
              finalHighlightedSelectionChars: highlightedSelection.length,
            };
          },
        });
        scenarios.push({
          ...shared,
          id: "heavy-code-sequential",
          expected:
            "Three sequential complete 5,000-line blocks retain their text and finish each worker before the next arrives.",
          prepare,
          run: async (page, gateway) => {
            for (const [index, name] of ["a", "b", "c"].entries()) {
              if (index > 0) {
                await prepare(page, gateway);
              }
              const code = `let ${name};\n`.repeat(5_000);
              const next: typeof fixture = { ...fixture, code, text: `\`\`\`ts\n${code}\`\`\`` };
              await deliver(page, gateway, next, false, "raw");
              await page.locator(`${pane} .code-block-expand`).last().click();
              await settleCode(page, next, true);
            }
            const complete = await evidence(page, fixture);
            if (complete.codeBlocks !== 3 || complete.codeTextChars !== 105_000) {
              throw new Error("Sequential blocks did not retain their complete source");
            }
            return complete;
          },
        });
      }
    }
    if (fixture.kind === "table") {
      scenarios.push({
        ...shared,
        id: "heavy-table-copy",
        expected: "The table copy action preserves every header and cell as tab-separated text.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
        },
        run: async (page) => {
          await page.locator(`${pane} .markdown-table__copy`).last().click();
          const copied = await page.evaluate(() => {
            // SAFETY: Installed by this fixture's clipboard init script.
            return (window as Window & { heavyContentCopied?: string }).heavyContentCopied;
          });
          const expected = [
            Array.from({ length: 12 }, (_, column) => `C${column}`).join("\t"),
            ...Array.from({ length: 300 }, (_, row) =>
              Array.from({ length: 12 }, (_cell, column) => `${row}-${column}`).join("\t"),
            ),
          ].join("\n");
          if (copied !== expected) {
            throw new Error(`Table copy mismatch: ${copied?.length} != ${expected.length}`);
          }
          return { ...(await evidence(page, fixture)), copiedChars: copied.length };
        },
      });
    }
    return scenarios;
  },
);
