import { expect, it } from "vitest";
import { FormatCapabilityProfile } from "./format-capabilities.js";
import type { MarkdownIR } from "./ir.js";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";
import {
  attributed,
  htmlLink,
  plainIR,
  renderChunks,
  marker,
  identity,
} from "./markdown.test-support.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
import {
  renderMarkdownIRChunksWithinLimit,
  type RenderedMarkdownChunk,
} from "./render-aware-chunking.js";
import { renderMarkdownWithMarkers, type RenderOptions } from "./render.js";

const boldMarker = { bold: { open: "*", close: "*" } };
const sourceTexts = (chunks: RenderedMarkdownChunk<unknown>[]) =>
  chunks.map(({ source }) => source.text);
const renderedValues = <T>(chunks: RenderedMarkdownChunk<T>[]) =>
  chunks.map(({ rendered }) => rendered);

function renderHtml(ir: MarkdownIR, options: Partial<RenderOptions> = {}): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: marker("b"),
      code_block: { open: "<pre><code>", close: "</code></pre>" },
    },
    annotationMarkers: { assistant_transcript_role: marker("code") },
    escapeText: identity,
    buildLink: htmlLink,
    ...options,
  });
}
const renderEscapedHtml = (ir: MarkdownIR) =>
  renderHtml(ir, {
    escapeText: (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  });

const plainText = (ir: MarkdownIR) => ir.text;

it("splits at exact rendered budgets while retaining source and formatting", () => {
  const unbounded = "a b c";
  const cases: [MarkdownIR, number, string[], ((ir: MarkdownIR) => string)?, string[]?][] = [
    [markdownToIR("alpha <<"), 8, ["alpha ", "<<"]],
    [markdownToIR("**a b**"), 9, ["a ", "b"], renderEscapedHtml, ["<b>a </b>", "<b>b</b>"]],
    [
      plainIR("ab<"),
      3,
      ["ab", "<"],
      ({ text }) => (text === "ab" ? "x" : text.startsWith("ab") ? "overflow" : text),
    ],
    [markdownToIR("alpha beta gamma"), 10, ["alpha ", "beta gamma"], plainText],
    [markdownToIR("abc"), Number.NaN, ["a", "b", "c"]],
    [markdownToIR(unbounded), Infinity, [unbounded]],
  ];
  for (const [ir, limit, expected, render = renderEscapedHtml, rendered] of cases) {
    const chunks = renderChunks(ir, limit, render);
    expect(sourceTexts(chunks), ir.text).toEqual(expected);
    expect(
      chunks.every((chunk) => chunk.rendered.length <= (Number.isNaN(limit) ? 1 : limit)),
    ).toBe(true);
    if (rendered) {
      expect(renderedValues(chunks)).toEqual(rendered);
    }
  }
});

it.each(["A".repeat(128), `${"A".repeat(230)}😀`])(
  "keeps internal code whitespace away from message edges: %s",
  (first) => {
    const second = "B".repeat(128);
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: markdownToIR(`    ${first}\n\n    ${second}`),
      limit: 256,
      renderChunk: (source) => ({
        html: renderEscapedHtml(source),
        receivedText: source.text.trim(),
      }),
      measureRendered: (rendered) => rendered.html.length,
    });

    expect(chunks.map((chunk) => chunk.rendered.receivedText).join("")).toBe(
      `${first}\n\n${second}`,
    );
    expect(chunks.every((chunk) => chunk.rendered.html.length <= 256)).toBe(true);
    expect(chunks.every((chunk) => chunk.rendered.html.startsWith("<pre><code>"))).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk.source.text))).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/u.test(chunk.source.text))).toBe(true);
  },
);

it("drops temporary boundary annotations when whitespace is coalesced", () => {
  const chunks = renderChunks(
    plainIR(`alpha${" ".repeat(19)}\nuser[t] ok`, [], [{ start: 25, end: 32, href }]),
    20,
    (source) => ({
      source,
      ...renderMarkdownWithAttributedRanges(source, {
        styleMap: {},
        annotationStyleMap: { assistant_transcript_role: "MONOSPACE" },
      }),
    }),
    true,
  );

  expect(chunks.map((chunk) => chunk.rendered.text)).toEqual([
    `alpha${" ".repeat(15)}`,
    "    \nuser[t] ok",
  ]);
  const final = chunks[1];
  expect(final?.source.annotations).toBeUndefined();
  expect(final?.source.links).toEqual([{ start: 5, end: 12, href }]);
  expect(final?.rendered.ranges).toEqual([]);
  expect(final?.rendered.source).toBe(final?.source);
});

it("keeps Unicode boundaries through initial, retry, and whitespace splits", () => {
  const cases: [string, number, string[], boolean?, ((ir: MarkdownIR) => string)?, string[]?][] = [
    ["A😀B", 1, ["A", "😀", "B"]],
    ["A😀", 3, ["A", "😀"], false, ({ text }) => (text === "A😀" ? "too long" : text)],
    ["aaaaaaaaaa👨‍👩‍👧‍👦Z", 12, ["aaaaaaaaaa", "👨‍👩‍👧‍👦Z"]],
    [
      "aaaaaaaaaaaa👨‍👩‍👧‍👦Z",
      26,
      ["aaaaaaaaaaaa", "👨‍👩‍👧‍👦Z"],
      false,
      ({ text }) => text.replaceAll("a", "aa"),
      ["a".repeat(24), "👨‍👩‍👧‍👦Z"],
    ],
    ["👨‍👩‍👧‍👦", 4, ["👨‍", "👩‍", "👧‍", "👦"]],
    ["ab \u0301cd", 4, ["ab", " \u0301cd"]],
    ["\u0600 \u0301abcd", 4, ["\u0600 \u0301a", "bcd"]],
    ["ab\r\n😀", 3, ["ab", "😀"]],
    ["ab\r\n😀", 3, ["ab", "\r\n", "😀"], true],
    ["abc\r\n\r\nx", 4, ["abc", "x"]],
    ["abc\r\n\r\nx", 4, ["abc", "\r\n\r\n", "x"], true],
  ];
  for (const [text, limit, expected, styled, render = plainText, rendered = expected] of cases) {
    const ir = plainIR(text);
    if (styled) {
      ir.styles.push({ start: 0, end: text.length, style: "code_block" });
    }
    const chunks = renderChunks(ir, limit, render);
    expect(sourceTexts(chunks), text).toEqual(expected);
    expect(renderedValues(chunks), text).toEqual(rendered);
  }
});

it.each<[MarkdownIR, string[]]>([
  [markdownToIR("```\n \n```"), ["<pre><code> \n</code></pre>"]],
  [sliceMarkdownIR(markdownToIR("**a b**"), 1, 2), ["<b> </b>"]],
  [
    sliceMarkdownIR(markdownToIR("[a b](https://example.com)"), 1, 2),
    ['<a href="https://example.com"> </a>'],
  ],
  [
    sliceMarkdownIR(markdownToIR("user[Thu 2026]", { assistantTranscriptRoleHeaders: true }), 8, 9),
    ["<code> </code>"],
  ],
  [plainIR(" \n"), []],
])("preserves semantic whitespace: %j", (ir, expectedRendered) => {
  const chunks = renderChunks(ir, 64, renderHtml);
  expect(renderedValues(chunks)).toEqual(expectedRendered);
});

it("coalesces semantic whitespace into neighboring rendered chunks", () => {
  const text = `alpha${" ".repeat(19)}\nomega\n`;
  const ir = markdownToIR(`\`\`\`\n${text}\`\`\``);
  expect(ir.text).toBe(text);

  const chunks = renderChunks(ir, 20, (chunk) =>
    renderMarkdownWithAttributedRanges(chunk, { styleMap: { code_block: "MONOSPACE" } }),
  );

  expect(renderedValues(chunks)).toEqual([
    attributed(`alpha${" ".repeat(15)}`, [[0, 20, "MONOSPACE"]]),
    attributed("    \nomega\n", [[0, 11, "MONOSPACE"]]),
  ]);
});

it("preserves task-list fallback while coalescing semantic whitespace", () => {
  const paragraph = "A".repeat(18);
  const profile = FormatCapabilityProfile.define({
    mechanism: "markdown",
    constructs: { taskList: "fallback" },
    chunk: { limit: 20, unit: "chars" },
  });
  const chunks = renderChunks(
    markdownToIR(`**${paragraph}**\n\n- [x] done`, { enableTaskLists: true }),
    profile.chunk.limit,
    (chunk) =>
      renderMarkdownWithMarkers(chunk, { styleMarkers: boldMarker, escapeText: identity }, profile),
  );

  expect(renderedValues(chunks)).toEqual([`*${paragraph}*`, "\n\n[x] done"]);
});

it("suppresses semantic whitespace when attributed rendering trims it away", () => {
  const ir = markdownToIR("```\n \n```");
  const renderChunk = (chunk: MarkdownIR) =>
    renderMarkdownWithAttributedRanges(chunk, {
      styleMap: { code_block: "MONOSPACE" },
      trimEnd: true,
    });

  expect(renderChunk(ir)).toEqual({ text: "", ranges: [] });
  expect(renderChunks(ir, 4_000, renderChunk, true)).toEqual([]);
});

const href = "https://example.test";
const paragraph = "A".repeat(78);
const attributedProfile = FormatCapabilityProfile.define({
  mechanism: "ranges",
  constructs: { linkLabel: "fallback" },
  chunk: { limit: 80, unit: "chars" },
});

it.each<[string, boolean, string[], number[]]>([
  [
    `[alpha${" ".repeat(80)}omega](${href})`,
    false,
    [
      `<a href="${href}">alpha${" ".repeat(40)}</a>`,
      `<a href="${href}">${" ".repeat(40)}omega</a>`,
    ],
    [1, 1],
  ],
  [
    `**${paragraph}**\n\n[a](${href})[b](${href})`,
    false,
    [`*${paragraph}*`, `\n\n<a href="${href}">a</a><a href="${href}">b</a>`],
    [0, 2],
  ],
  [`[alpha${" ".repeat(240)}omega](${href})`, true, [`alpha (${href})`, `omega (${href})`], [1, 1]],
])(
  "preserves authored links across coalesced whitespace: %s",
  (markdown, useAttributed, expected, linkCounts) => {
    const chunks = renderChunks(markdownToIR(markdown), 80, (chunk) =>
      useAttributed
        ? renderMarkdownWithAttributedRanges(
            chunk,
            { styleMap: {}, trimEnd: true },
            attributedProfile,
          ).text
        : renderHtml(chunk, { styleMarkers: boldMarker }),
    );

    expect(renderedValues(chunks)).toEqual(expected);
    expect(chunks.map((chunk) => chunk.source.links.length)).toEqual(linkCounts);
  },
);
