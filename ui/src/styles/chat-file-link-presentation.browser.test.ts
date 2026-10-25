import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("chat-file-link-presentation-");
function expectEvery<T>(samples: T[], predicate: (sample: T) => boolean) {
  expect(samples.filter((sample) => !predicate(sample))).toEqual([]);
}

// File-link labels match except for glyph spacing owned by the outer anchor.
const CHIP_PROPERTIES =
  "backgroundColor borderTopWidth borderTopStyle borderTopColor borderTopLeftRadius paddingTop paddingLeft fontFamily fontSize color";
const GLYPH_PROPERTIES = "fontSize height maskImage paddingInlineStart position width";
const LONG_REFERENCE = "organization-with-a-long-name/repository-with-a-long-name#987654";

// Match styles/chat.ts: sidebar-markdown must load after chat/text.
function chatDocument(body: string, theme: "dark" | "light") {
  return styleDocument(
    readStyles(
      "styles/base",
      "styles/chat/startup-layout",
      "styles/chat/text",
      "styles/sidebar-markdown",
    ),
    body,
    theme === "light" ? 'data-theme="light" data-theme-mode="light"' : 'data-theme="dark"',
  );
}

const links = (prefix: string) => `<p>
  <a id="${prefix}from-text" class="markdown-file-link" data-file-kind="code" data-file-path="src/app.ts">app.ts</a>
  <a id="${prefix}from-code" class="markdown-file-link" data-file-kind="code" data-file-path="ui/app.ts"><code>app.ts</code></a>
  <code id="${prefix}plain-code">npm run dev</code></p>`;
// Short references stay atomic; qualified labels may wrap within their chip.
const LINK_FORMS = (
  [
    ["issue", "issue", "#123309", "then follow-up tracked in ", true],
    ["pull", "pull", "#3434", "then the fix is in ", true],
    ["repository-ref", "pull", LONG_REFERENCE, "then see ", false],
    ["repository-ref-rtl", "pull", LONG_REFERENCE, "then see ", false],
    ["bare-url", "", "text.css", "then the owning rule lives at ", true],
    ["authored", "", "the sibling chip rule", "then see ", false],
  ] as const
).map(([id, kind, label, lead, bare]) => ({
  id,
  kind,
  label,
  lead,
  className: [bare && "markdown-bare-url", "markdown-github-link", kind && "markdown-github-item"]
    .filter(Boolean)
    .join(" "),
}));

const githubMarkup = LINK_FORMS.map(
  ({ className, kind, id, label, lead }) => `
    <div class="chat-text" id="column-${id}" ${id.startsWith("repository-ref") ? `style="font-size:28px" dir="${id.endsWith("rtl") ? "rtl" : "ltr"}"` : ""}>Reproduce the failing run and read the notes
      first, ${lead}<a id="${id}" class="${className}" ${kind ? `data-github-kind="${kind}"` : ""} href="https://github.com/openclaw/openclaw"
      >${label}</a> before landing the fix.</div>`,
).join("");

const presentationMarkup = `<div class="chat-text">${links("")}</div>
  <article class="sidebar-markdown">${links("panel-")}</article>`;

// CSS wraps rendered labels, not parser metadata; include suffixes in the label.
const SEPARATION_LABELS = {
  short: "app.ts",
  unbroken: "superlongfilenamewithoutanyslashesordashesorspacesatalljustonebigword.ts",
  fullPath: "packages/gateway-protocol/src/session-transport-envelope.ts",
  enormous: `${"abcdefghij".repeat(24)}.ts:7`,
  cjk: "文档/会话传输封装规范化适配器/协议架构第十七版/规范化器.ts:88",
};

// The panel does not inherit chat-text's wrapping and clips horizontal overflow.
const WRAP_CONTAINERS = ["chat-text", "sidebar-markdown"] as const;
type WrapContainer = (typeof WRAP_CONTAINERS)[number];

const WRAP_CASES = (["light", "dark"] as const).flatMap((themeMode) =>
  WRAP_CONTAINERS.map((container) => ({ container, themeMode })),
);

function wrapFixtureDocument(themeMode: "dark" | "light", container: WrapContainer): string {
  const separationLinks = Object.entries(SEPARATION_LABELS)
    .map(
      ([id, label]) =>
        `<p><a id="${id}" class="markdown-file-link" data-file-kind="code" data-file-path="src/app.ts">${label}</a></p>`,
    )
    .join("\n");
  return chatDocument(
    `
    ${presentationMarkup}<div class="${container}" id="column">
      <ol><li>Reproduce the failing run, then read the harness entry point
        (<a id="wrap-chip" class="markdown-file-link" data-file-kind="code"
          data-file-path="test/harness.ts" data-file-line="182">harness.ts:182</a>)
        before landing the fix.</li></ol>
      ${separationLinks}
    </div>${githubMarkup}`,
    themeMode,
  );
}

// One range probe owns the shared width sweep; each assertion keeps its own contract.
async function probeWrap(themeMode: "dark" | "light", container: WrapContainer) {
  return fixture.withPage(
    `${themeMode}-${container}`,
    wrapFixtureDocument(themeMode, container),
    (page) =>
      page.evaluate(
        ({ caseIds, githubIds, properties, glyphProperties }) => {
          const resolve = (selector: string) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) {
              throw new Error(`Missing link fixture: ${selector}`);
            }
            return element;
          };
          const read = (selector: string, names = properties, pseudo: string | null = null) => {
            const css = getComputedStyle(resolve(selector), pseudo);
            return Object.fromEntries(
              names
                .split(" ")
                .map((name) => [
                  name,
                  css.getPropertyValue(
                    name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
                  ),
                ]),
            );
          };
          const measure = (id: string, columnId: string, min: number, max: number) => {
            const element = resolve("#" + id),
              column = resolve("#" + columnId);
            const text = element.firstChild;
            if (!text) {
              throw new Error(`Missing label: ${id}`);
            }
            const range = document.createRange(),
              samples = [];
            for (let width = min; width <= max; width += 4) {
              column.style.width = `${width}px`;
              const rect = element.getBoundingClientRect(),
                first = element.getClientRects()[0]!;
              range.setStart(text, 0);
              range.setEnd(text, 1);
              const labelTop = range.getBoundingClientRect().top;
              range.selectNodeContents(element);
              const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
              samples.push({
                atomic: element.getClientRects().length === 1,
                labelAtomic: range.getClientRects().length === 1,
                fits: rect.width <= width + 0.5,
                overflows: column.scrollWidth > column.clientWidth,
                startsWithIcon: Math.abs(labelTop - first.top) < 2,
                line: Math.round(first.top),
                attached: labelTop - rect.top <= lineHeight / 2,
                labelFits:
                  range.getBoundingClientRect().right <= column.getBoundingClientRect().right + 0.5,
                wrapped: rect.height > lineHeight * 1.3,
              });
            }
            return samples;
          };
          return {
            presentation: {
              chatGlyph: read("#from-text", glyphProperties, "::before"),
              fromCode: read("#from-code > code"),
              fromText: read("#from-text"),
              panelFromCode: read("#panel-from-code > code"),
              panelFromText: read("#panel-from-text"),
              panelGlyph: read("#panel-from-text", glyphProperties, "::before"),
              plainCode: read("#plain-code"),
            },
            samples: measure("wrap-chip", "column", 220, 900),
            separation: Object.fromEntries(
              caseIds.map(
                (id) => [id, measure(id, "column", 40, id === "fullPath" ? 900 : 320)] as const,
              ),
            ),
            github: Object.fromEntries(
              githubIds.map((id) => [id, measure(id, "column-" + id, 200, 900)] as const),
            ),
          };
        },
        {
          caseIds: Object.keys(SEPARATION_LABELS),
          githubIds: LINK_FORMS.map((row) => row.id),
          properties: CHIP_PROPERTIES,
          glyphProperties: GLYPH_PROPERTIES,
        },
      ),
  );
}

const wrapping = new Map<string, ReturnType<typeof probeWrap>>();
function observation(theme: "dark" | "light", container: WrapContainer = "chat-text") {
  const key = `${theme}/${container}`;
  if (!wrapping.has(key)) {
    wrapping.set(key, probeWrap(theme, container));
  }
  return wrapping.get(key)!;
}

fixture.describe("chat file link presentation", () => {
  it.each(WRAP_CASES)(
    "paints and wraps file links without clipping or separating glyphs in $container/$themeMode",
    async ({ container, themeMode }) => {
      const { presentation, samples, separation } = await observation(themeMode, container);
      if (container === "chat-text") {
        const {
          fromCode,
          fromText,
          panelFromText,
          panelFromCode,
          chatGlyph,
          panelGlyph,
          plainCode,
        } = presentation;
        // The anchor reserves glyph space; nested code must not reserve it again.
        expect(fromCode).toEqual({ ...fromText, paddingLeft: "0px" });
        expect([panelFromText, panelFromCode, panelGlyph]).toEqual([fromText, fromCode, chatGlyph]);
        expect(panelGlyph.maskImage).toContain("svg");
        expect(chatGlyph).toMatchObject({
          position: "absolute",
          width: chatGlyph.fontSize,
          height: chatGlyph.fontSize,
          paddingInlineStart: "0px",
        });
        expect(plainCode.backgroundColor).not.toBe(fromText.backgroundColor);
        expect(plainCode.borderTopWidth).not.toBe("0px");
        expect(fromText).toMatchObject({
          borderTopWidth: "0px",
          backgroundColor: "rgba(0, 0, 0, 0)",
        });
      }
      // Prove the sweep actually changes lines.
      expect(new Set(samples.map((sample) => sample.line)).size).toBeGreaterThan(1);
      expectEvery(samples, (sample) => sample.atomic);
      expectEvery(Object.values(separation).flat(), (sample) => sample.labelFits);
      // The outer rect cannot detect an internally stranded glyph.
      for (const caseSamples of Object.values(separation)) {
        expectEvery(caseSamples, (sample) => sample.fits && sample.atomic);
        expect(caseSamples.length).toBeGreaterThan(0);
        // Each fixture must wrap; otherwise the attachment check is vacuous.
        expect(caseSamples.some((sample) => sample.wrapped)).toBe(true);
        expectEvery(caseSamples, (sample) => sample.attached);
      }
    },
  );
});

function withFixture<T>(theme: "dark" | "light", run: (page: Page) => Promise<T>) {
  return fixture.withPage(theme, wrapFixtureDocument(theme, "chat-text"), run);
}

const interactionPaint = (chip: Locator) =>
  chip.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    decoration: getComputedStyle(element).textDecorationLine,
  }));

fixture.describe("chat GitHub link presentation", () => {
  it.each(["light", "dark"] as const)(
    "keeps GitHub icons with their labels and reference chips contained at every column width in %s",
    async (themeMode) => {
      const samples = (await observation(themeMode)).github;
      for (const { id, kind } of LINK_FORMS) {
        const collected = samples[id] ?? [];
        // Prove the sweep actually changes lines.
        expect(new Set(collected.map((sample) => sample.line)).size).toBeGreaterThan(1);
        expectEvery(collected, (sample) => sample.startsWithIcon);
        if (kind) {
          // Qualified labels may exceed the column; short references remain unbroken.
          expectEvery(
            collected,
            (sample) =>
              sample.atomic &&
              !sample.overflows &&
              (id.startsWith("repository-ref") || sample.labelAtomic),
          );
          if (id.startsWith("repository-ref")) {
            expectEvery(collected, (sample) => sample.fits);
            expect(collected.some((sample) => sample.wrapped)).toBe(true);
          }
        } else {
          // Non-item links fill their starting line instead of moving whole.
          expect(
            collected.some((sample) => !sample.atomic),
            id,
          ).toBe(true);
        }
      }
    },
  );

  it.each(["light", "dark"] as const)(
    "paints distinct kind icons and visible hover and keyboard focus states in %s",
    async (themeMode) => {
      await withFixture(themeMode, async (page) => {
        const masks: string[] = [];
        for (const id of ["issue", "pull"]) {
          const chip = page.locator(`#${id}`);
          const idle = await chip.evaluate((element) => {
            const style = getComputedStyle(element);
            const icon = getComputedStyle(element, "::before");
            return {
              background: style.backgroundColor,
              decoration: style.textDecorationLine,
              iconColor: icon.backgroundColor,
              color: style.color,
              mask: icon.maskImage,
            };
          });
          expect(idle).toMatchObject({
            decoration: "none",
            iconColor: idle.color,
            mask: expect.stringContaining("data:image/svg+xml"),
          });
          masks.push(idle.mask);
          await chip.hover();
          const hover = await interactionPaint(chip);
          expect(hover.background).not.toBe(idle.background);
          expect(hover.decoration).toBe("underline");
          await page.mouse.move(0, 0);
          await page.keyboard.press("Tab");
          await chip.focus();
          expect(await chip.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
          expect(await interactionPaint(chip)).toEqual(hover);
          await chip.evaluate((element) => element.blur());
        }
        const genericMask = await page
          .locator("#authored")
          .evaluate((element) => getComputedStyle(element, "::before").maskImage);
        expect(new Set([...masks, genericMask]).size).toBe(3);
      });
    },
  );
});
