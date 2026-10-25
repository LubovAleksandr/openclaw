import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, render } from "@solidjs/web";
import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import {
  createLoadedWorkboardState,
  createWorkboardRenderProps,
  createWorkboardView,
  openCardMenu,
  requireButton,
} from "./view.test-support.ts";
import { WorkboardView } from "./view.tsx";

it("keeps one menu and its controls while switching cards in either layout", () => {
  for (const viewMode of ["board", "list"] as const) {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = viewMode;
    state.cards = [
      createWorkboardCard({ id: "first", title: "First card" }),
      createWorkboardCard({ id: "second", title: "Second card" }),
    ];
    renderView();
    const rows = container.querySelectorAll(".workboard-card");
    const first = expectDefined(rows[0], "first card");
    const second = expectDefined(rows[1], "second card");
    const parked = expectDefined(
      container.querySelector(".workboard-card__action-menu-panel"),
      "eager menu",
    );
    const controls = [...parked.querySelectorAll("button, select")];
    expect(controls.length).toBeGreaterThan(0);
    const panel = openCardMenu(first);
    expect(panel).toBe(parked);
    expect(container.querySelectorAll(".workboard-card__action-menu-panel")).toHaveLength(1);
    expect(openCardMenu(second)).toBe(panel);
    expect(first.querySelector(".workboard-card__action-menu-panel")).toBeNull();
    const movedControls = [...panel.querySelectorAll("button, select")];
    expect(movedControls).toHaveLength(controls.length);
    controls.forEach((control, index) => expect(movedControls[index]).toBe(control));
    expect(panel.querySelector("select")?.getAttribute("aria-label")).toBe("Status: Second card");
    requireButton(panel, "Edit card").click();
    expect(state.editingCardId).toBe("second");
  }
});

it("retires a filtered card's menu before another card can receive its actions", () => {
  const { state, container, renderView } = createWorkboardView({ canWrite: true });
  state.cards = [
    createWorkboardCard({ id: "first", title: "First card" }),
    createWorkboardCard({ id: "second", title: "Second card" }),
  ];
  renderView();
  const panel = openCardMenu(container);
  const hide = vi.spyOn(panel, "hidePopover");
  state.query = "Second card";
  renderView();
  expect(hide).toHaveBeenCalled();
  expect(panel.isConnected).toBe(true);
  expect(panel.closest(".workboard-card")).toBeNull();
  expect(panel.parentElement?.style.display).toBe("contents");
  expect(state.draftOpen).toBe(false);
  expect(openCardMenu(container)).toBe(panel);
  requireButton(panel, "Edit card").click();
  expect(state.editingCardId).toBe("second");
});

it("owns separate menus for simultaneous views and removes a moved panel on disposal", () => {
  const first = createLoadedWorkboardState();
  const firstContainer = document.createElement("div");
  document.body.append(firstContainer);
  const second = createWorkboardView({ canWrite: true });
  first.state.cards = [createWorkboardCard({ id: "same", title: "First view" })];
  second.state.cards = [createWorkboardCard({ id: "same", title: "Second view" })];
  const dispose = render(
    () =>
      createComponent(WorkboardView, createWorkboardRenderProps(first.host, { canWrite: true })),
    firstContainer,
  );
  onTestFinished(() => {
    dispose();
    firstContainer.remove();
  });
  flush();
  second.renderView();
  const firstPanel = openCardMenu(firstContainer);
  const secondPanel = openCardMenu(second.container);
  expect(firstPanel).not.toBe(secondPanel);
  requireButton(secondPanel, "Edit card").click();
  expect(second.state.draftOpen).toBe(true);
  expect(first.state.draftOpen).toBe(false);
  dispose();
  expect(firstPanel.isConnected).toBe(false);
  expect(firstContainer.querySelector(".workboard-card__action-menu-panel")).toBeNull();
  expect(second.state.editingCardId).toBe("same");
});
