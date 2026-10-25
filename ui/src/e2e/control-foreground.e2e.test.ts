import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors } from "../test-helpers/rendered-colors.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  configSchema,
  configSnapshot,
  objectSchema,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control foreground hierarchy" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const appearances = captureProof
  ? ([
      ["claw", "light", "light"],
      ["claw", "dark", "dark"],
      ["absolutely", "light", "absolutely-light"],
      ["absolutely", "dark", "absolutely"],
      ["tide", "dark", "tide"],
      ["crt", "dark", "crt"],
      ["beacon", "dark", "beacon"],
    ] as const)
  : ([["claw", "light", "light"]] as const);
const sessionKey = "agent:main:foreground-proof";

async function color(locator: Locator) {
  const value = await locator.evaluate((element) => getComputedStyle(element).color);
  return (await locator.page().evaluate(resolveRenderedColors, { value })).value;
}

async function roleColor(target: Locator, token: string) {
  const value = await target.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    token,
  );
  return (await target.page().evaluate(resolveRenderedColors, { value })).value;
}

async function capture(page: Page, name: string, targets: Locator[]) {
  if (!captureProof) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), targets, {
    animations: "disabled",
    elements: targets,
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
  for (const [index, element] of frame.elements.entries()) {
    await writeFile(path.join(suite.artifactDir, `${name}-${index}.png`), element.png);
  }
  const measurements = await page.evaluate(() => {
    const selectors = [
      'a[href="https://docs.openclaw.ai/install/update-troubleshooting"]',
      ".settings-theme-import__external",
      ".config-diff__summary",
      ".config-accordion-group__item--active",
      ".chat-pane__workspace-chip",
      ".chat-pane__crumb-sep",
      ".chat-pane__session-title-text",
      ".chat-details-toggle",
      ".chat-details-toggle svg",
      ".chat-pane__sharing-trigger svg",
      ".chat-send-btn--voice > svg",
      ".sidebar-region__panels-toggle .chat-pane__panels-toggle",
      ".side-panel__frame-action",
      ".session-panel-rail__button",
      ".session-panel-rail__button svg",
      ".sidebar-issues-panel__action",
      ".sidebar-session-toolbar__button",
      ".sidebar-session-group-actions",
      ".chat-controls__permission-icon",
      ".chat-controls__trigger-provider-icon",
      ".chat-controls__effort-gauge",
      ".chat-send-btn",
      ".context-ring__track",
      ".context-ring__fill",
    ];
    return {
      hoverCapable: matchMedia("(hover: hover)").matches,
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.themeMode,
      modelLabel: document.querySelector(".chat-controls__model-trigger")?.textContent?.trim(),
      themeSheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
        .filter((link) => link.href.includes("/themes/"))
        .map((link) => ({ href: link.href, loaded: Boolean(link.sheet) })),
      controls: selectors.flatMap((selector) =>
        [...document.querySelectorAll<HTMLElement>(selector)]
          .filter((element) => element.checkVisibility({ checkOpacity: true }))
          .map((element) => {
            const style = getComputedStyle(element);
            return {
              selector,
              color: style.color,
              background: style.backgroundColor,
              border: style.border,
              shadow: style.boxShadow,
              stroke: style.stroke,
              opacity: style.opacity,
              expanded: element.getAttribute("aria-expanded"),
              disabled: element.hasAttribute("disabled"),
              bounds: element.getBoundingClientRect().toJSON(),
            };
          }),
      ),
    };
  });
  await writeFile(
    path.join(suite.artifactDir, `${name}.json`),
    JSON.stringify(measurements, null, 2),
  );
}

suite.define(() => {
  it.each(
    appearances.flatMap(([theme, mode, resolved]) =>
      [false, true].map((hasTouch) => ({ theme, mode, resolved, hasTouch })),
    ),
  )(
    "keeps selected controls neutral in $theme $mode (touch=$hasTouch)",
    async ({ theme, mode, resolved, hasTouch }) => {
      await suite.withPage(
        {
          colorScheme: mode,
          hasTouch,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 900 },
        },
        async ({ page }) => {
          await seedChatSettings(page, suite.server.baseUrl, {
            theme,
            themeMode: mode,
            sidebarSessionLayouts: { [sessionKey]: { columns: [], open: false, expanded: false } },
          });
          const gateway = await installMockGateway(page, {
            sessionKey,
            workspace: "/workspace",
            workspaceGit: true,
            sessions: [
              {
                key: sessionKey,
                kind: "direct",
                sharingRole: "admin",
                visibility: "shared",
                label: "Prepare the field notes",
                updatedAt: 1,
                spawnedCwd: "/workspace/field-notes",
                model: "demo-model",
                modelProvider: "example",
                contextTokens: 100_000,
                totalTokens: 14_000,
                totalTokensFresh: true,
              },
            ],
            models: [
              { id: "demo-model", provider: "example", name: "Demo model", contextWindow: 100_000 },
            ],
            agentModel: "example/demo-model",
            historyMessages: [
              {
                role: "assistant",
                content:
                  "The draft is ready to review. Check the source notes and share the next steps with your team.",
              },
            ],
            methodResponses: {
              "config.get": themeConfigResponse(theme, mode),
              "sessions.files.list": {
                browser: { path: "", entries: [] },
                files: [],
                root: "/workspace/field-notes",
                sessionKey,
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const header = page.locator(".chat-pane__header").filter({ visible: true }).first();
          const composer = page.locator(".agent-chat__input").filter({ visible: true }).first();
          await composer.waitFor();
          await expect
            .poll(() => composer.locator(".chat-controls__model-trigger").textContent())
            .toContain("Demo model");
          await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(resolved);
          if (theme !== "claw") {
            await expect
              .poll(() =>
                page.evaluate(
                  (family) =>
                    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].some(
                      (link) => link.href.includes(`/themes/${family}.css`) && Boolean(link.sheet),
                    ),
                  theme,
                ),
              )
              .toBe(true);
          }
          await header.locator(".chat-pane__workspace-chip").waitFor();
          await header.locator(".chat-pane__crumb-sep").waitFor();
          await header.locator(".chat-pane__sharing-trigger").waitFor();
          const details = header.locator(".chat-details-toggle");
          const panels = page
            .locator(".sidebar-region__panels-toggle .chat-pane__panels-toggle")
            .filter({ visible: true });
          await page.mouse.move(700, 500);
          await capture(page, `${resolved}-rest`, [
            header,
            panels,
            composer,
            page.locator(".sidebar-rail"),
          ]);
          const resting = await color(panels.locator("svg"));
          const headerInk = await roleColor(header, "--icon-interactive");
          expect
            .soft(
              await color(details.locator("svg")),
              "resting Details uses the header role for both pointer types",
            )
            .toEqual(headerInk);
          expect
            .soft(
              await color(header.locator(".chat-pane__sharing-trigger svg").first()),
              "private sharing uses the resting header role",
            )
            .toEqual(headerInk);
          const permissionIcon = composer.locator(".chat-controls__permission-icon");
          expect
            .soft(await color(permissionIcon), "permission uses the approved interactive role")
            .toEqual(await roleColor(composer, "--icon-interactive"));
          await details.click();
          await expect.poll(() => details.getAttribute("aria-expanded")).toBe("true");
          await page.mouse.move(700, 500);
          const selected = await color(details.locator("svg"));
          const strongValue = await header.evaluate((element) =>
            getComputedStyle(element).getPropertyValue("--text-strong"),
          );
          const strong = (await page.evaluate(resolveRenderedColors, { value: strongValue })).value;
          expect.soft(selected, "selected Details uses neutral strong foreground").toEqual(strong);
          expect
            .soft(selected, "selection is distinct from the resting glyph")
            .not.toEqual(resting);
          await capture(page, `${resolved}-details-active`, [header, panels, composer]);
          await details.click();
          await panels.click();
          await expect.poll(() => panels.getAttribute("aria-expanded")).toBe("true");
          await page.mouse.move(700, 500);
          expect
            .soft(
              await color(panels.locator("svg")),
              "external Panels shares the active header foreground",
            )
            .toEqual(strong);
          await capture(page, `${resolved}-panels-active`, [header, panels, composer]);
          await openChatSidePanelType(page, "Files");
          const rail = page.locator(".session-panel-rail").filter({ visible: true }).first();
          const railGlyph = rail.locator(".session-panel-rail__button:not(:disabled) svg").first();
          await railGlyph.waitFor();
          await page.mouse.move(700, 500);
          expect
            .soft(await color(railGlyph), "panel actions use the approved interactive role")
            .toEqual(await roleColor(rail, "--icon-interactive"));
          if (captureProof) {
            const side = page
              .locator('[data-region-header="side"]')
              .filter({ visible: true })
              .first();
            await capture(page, `${resolved}-files`, [header, side, composer]);
            await openChatSidePanelType(page, "Review");
            await capture(page, `${resolved}-review`, [header, side, composer]);
            const ring = page.locator(".context-ring").filter({ visible: true });
            for (const [index, percent] of [85, 95, 14].entries()) {
              await gateway.emitGatewayEvent("sessions.changed", {
                sessionKey,
                reason: "patch",
                totalTokens: percent * 1000,
                contextTokens: 100_000,
                totalTokensFresh: true,
                updatedAt: index + 2,
              });
              await expect.poll(() => ring.getAttribute("aria-label")).toContain(`${percent}%`);
              await capture(page, `${resolved}-context-${percent}`, [composer, ring]);
            }
            await gateway.setMethodResponse("session.members.listEvidence", {
              sessionKey,
              members: [],
              identities: [],
              role: "admin",
              allowedVisibilities: ["shared", "draft"],
              publicShare: { token: "v1.synthetic-foreground-proof", createdAt: 1 },
            });
            await gateway.emitGatewayEvent("sessions.changed", {
              sessionKey,
              agentId: "main",
              reason: "sharing",
            });
            const publicSharing = header.locator('.chat-pane__sharing-trigger[data-public="true"]');
            await publicSharing.waitFor();
            await capture(page, `${resolved}-public`, [header, publicSharing]);
            await composer.locator(".chat-controls__permission-trigger").click();
            await page.locator('[data-chat-permission-option="full"]').click();
            await composer.locator(".chat-controls__permission-trigger--full").waitFor();
            await capture(page, `${resolved}-full-access`, [composer]);
            await page.locator(".sidebar-issues-button").click();
            const inbox = page.locator("#sidebar-issues-panel");
            await inbox.waitFor();
            await capture(page, `${resolved}-inbox`, [inbox, header, composer]);
            await page.keyboard.press("Escape");
            await details.hover();
            await capture(page, `${resolved}-hover`, [header, composer]);
            await page.mouse.move(700, 500);
            await details.focus();
            await capture(page, `${resolved}-focus`, [header, composer]);
            await page.setViewportSize({ width: 390, height: 844 });
            const input = page.getByRole("textbox", { name: "Chat composer", exact: true });
            await input.click();
            await capture(page, `${resolved}-mobile`, [composer]);
            const microphone = composer.locator(
              ".chat-mobile-dictation-action .chat-send-btn--voice:not(:disabled)",
            );
            await microphone.waitFor();
            expect
              .soft(
                await color(microphone.locator("svg")),
                "mobile microphone inherits its approved button role",
              )
              .toEqual(await color(microphone));
          }
        },
      );
    },
    120_000,
  );

  it.each(["light", "dark"] as const)(
    "keeps settings links and selected copy legible in %s",
    async (mode) => {
      await suite.withPage(
        {
          colorScheme: mode,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 1000 },
        },
        async ({ page }) => {
          const config = {
            ui: { prefs: { theme: "claw", themeMode: mode } },
            meta: { note: "Before" },
          };
          await seedChatSettings(page, suite.server.baseUrl, { theme: "claw", themeMode: mode });
          await installMockGateway(page, {
            agentModel: "example/demo-model",
            models: [{ id: "demo-model", provider: "example", name: "Demo model" }],
            historyMessages: [
              {
                role: "assistant",
                content: "Read the [project guide](https://example.test/guide).",
              },
            ],
            methodResponses: {
              "config.get": configSnapshot(config, "foreground-settings", true),
              "config.schema": configSchema(
                objectSchema("", {
                  meta: objectSchema("Meta", { note: { type: "string", title: "Note" } }),
                }),
              ),
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const chatLink = page.locator('.chat-text a[href="https://example.test/guide"]');
          await chatLink.waitFor();
          const linkInk = await color(chatLink);
          await page.goto(`${suite.server.baseUrl}settings/updates`);
          const genericLink = page.locator(
            'a[href="https://docs.openclaw.ai/install/update-troubleshooting"]',
          );
          await genericLink.waitFor();
          await genericLink.scrollIntoViewIfNeeded();
          expect
            .soft(
              await color(genericLink),
              "settings help and transcript links share readable foreground",
            )
            .toEqual(linkInk);
          await capture(page, `settings-${mode}-generic-link`, [genericLink]);
          await page.goto(`${suite.server.baseUrl}settings/appearance`);
          await page.locator(".settings-theme-card--custom").click();
          const external = page.locator(".settings-theme-import__external");
          await external.waitFor();
          await external.scrollIntoViewIfNeeded();
          expect(await external.getAttribute("href")).toBe("https://tweakcn.com/editor/theme");
          await page.mouse.move(10, 10);
          await capture(page, `settings-${mode}-external-rest`, [external]);
          await external.hover();
          await capture(page, `settings-${mode}-external-hover`, [external]);
          await page.mouse.move(10, 10);
          await external.focus();
          await capture(page, `settings-${mode}-external-focus`, [external]);
          await page.goto(`${suite.server.baseUrl}settings/advanced?section=meta`);
          const active = page.locator(".config-accordion-group__item--active");
          await active.waitFor();
          await active.scrollIntoViewIfNeeded();
          await page.mouse.move(10, 10);
          const heading = page.locator(".settings-sidebar__title");
          expect
            .soft(await color(active), "current section uses neutral heading foreground")
            .toEqual(await color(heading));
          await capture(page, `settings-${mode}-section-active`, [active]);
          await page.getByRole("button", { name: "Raw", exact: true }).click();
          await page
            .locator(".config-raw-field textarea")
            .fill(JSON.stringify({ ...config, meta: { note: "After" } }, null, 2));
          const summary = page.locator(".config-diff__summary");
          await summary.waitFor();
          await summary.scrollIntoViewIfNeeded();
          expect
            .soft(
              await color(summary),
              "pending changes disclosure uses neutral heading foreground",
            )
            .toEqual(await color(heading));
          await capture(page, `settings-${mode}-pending-changes`, [summary]);
          const disclosure = page.locator(".config-diff");
          if ((await disclosure.getAttribute("open")) === null) {
            await summary.click();
          }
          await page.locator(".config-diff__item").first().waitFor();
          await capture(page, `settings-${mode}-pending-changes-open`, [disclosure]);
        },
      );
    },
    120_000,
  );
});
