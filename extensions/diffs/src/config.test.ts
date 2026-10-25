import fs from "node:fs";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { diffsPluginConfigSchema, resolveDiffsPluginDefaults } from "./config.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: JsonSchemaObject };
const requireRecord = createRequireRecord("object", "expected-label");
function parse(value: unknown) {
  return requireRecord(diffsPluginConfigSchema.safeParse?.(value), "parse result");
}
function parseData(value: unknown) {
  const parsed = parse(value);
  expect(parsed.success).toBe(true);
  return requireRecord(parsed.data, "parse data");
}

describe("resolveDiffsPluginDefaults", () => {
  it("accepts image* config aliases for backward compatibility", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: {
          imageFormat: "pdf",
          imageQuality: "hq",
          imageScale: 2.2,
          imageMaxWidth: 1024,
        },
      }),
    ).toMatchObject({
      fileFormat: "pdf",
      fileQuality: "hq",
      fileScale: 2.2,
      fileMaxWidth: 1024,
    });
  });
});

describe("diffs plugin schema surfaces", () => {
  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    expect(diffsPluginConfigSchema.jsonSchema).toEqual(manifest.configSchema);
  });

  it("rejects invalid viewerBaseUrl values at manifest-validation time too", () => {
    const validate = (viewerBaseUrl: string) =>
      validateJsonSchemaValue({
        cacheKey: "diffs.manifest.config.test",
        schema: manifest.configSchema,
        value: { viewerBaseUrl },
        applyDefaults: true,
      }).ok;

    expect(validate("javascript:alert(1)")).toBe(false);
    expect(validate("https://example.com/openclaw?x=1")).toBe(false);
    expect(validate("https://example.com/openclaw#frag")).toBe(false);
    expect(validate("https://example.com/openclaw/")).toBe(true);
  });

  it("preserves defaults and security for direct safeParse callers", () => {
    expect(
      parseData({
        viewerBaseUrl: "https://example.com/openclaw/",
        defaults: { theme: "light", ttlSeconds: 21_600 },
        security: { allowRemoteViewer: true },
      }),
    ).toMatchObject({
      viewerBaseUrl: "https://example.com/openclaw",
      security: { allowRemoteViewer: true },
      defaults: {
        fontFamily: "Fira Code",
        fontSize: 15,
        lineSpacing: 1.6,
        layout: "unified",
        showLineNumbers: true,
        diffIndicators: "bars",
        wordWrap: true,
        background: true,
        theme: "light",
        fileFormat: "png",
        fileQuality: "standard",
        fileScale: 2,
        fileMaxWidth: 960,
        mode: "both",
        ttlSeconds: 21_600,
      },
    });
  });

  it("resolves deprecated aliases before safeParse applies runtime defaults", () => {
    expect(parseData({ defaults: { format: "pdf", imageQuality: "hq" } }).defaults).toMatchObject({
      fileFormat: "pdf",
      fileQuality: "hq",
      fileScale: 2.5,
      fileMaxWidth: 1200,
    });
  });

  it("rejects invalid viewerBaseUrl config values", () => {
    const parsed = parse({ viewerBaseUrl: "javascript:alert(1)" });
    expect(parsed.success).toBe(false);
    expect(requireRecord(parsed.error, "parse error").issues).toMatchObject([
      {
        path: ["viewerBaseUrl"],
        message: "viewerBaseUrl must use http or https: javascript:alert(1)",
      },
    ]);
  });
});

describe("diffs viewer URL helpers", () => {
  it("resolves explicit, plugin, public, then bind-aware viewer bases", () => {
    const viewerPath = "/plugins/diffs/view/id/token";
    const build = (overrides: Partial<Parameters<typeof buildViewerUrl>[0]> = {}) =>
      buildViewerUrl({
        config: { gateway: { publicOrigin: "https://public.example.com" } },
        viewerPath,
        ...overrides,
      });
    const viewerBaseUrl = "https://plugin.example.com/viewer";
    expect(build({ baseUrl: "https://explicit.example.com/review", viewerBaseUrl })).toBe(
      `https://explicit.example.com/review${viewerPath}`,
    );
    expect(build({ viewerBaseUrl })).toBe(`https://plugin.example.com/viewer${viewerPath}`);
    expect(build()).toBe(`https://public.example.com${viewerPath}`);
    expect(
      build({
        config: {
          gateway: {
            bind: "custom",
            customBindHost: "gateway.example.com",
            port: 443,
            tls: { enabled: true },
          },
        },
      }),
    ).toBe(`https://gateway.example.com${viewerPath}`);
  });

  it("rejects base URLs with query/hash", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1")).toThrow(
      "baseUrl must not include query/hash",
    );
    expect(() => normalizeViewerBaseUrl("https://example.com#frag")).toThrow(
      "baseUrl must not include query/hash",
    );
  });
});
