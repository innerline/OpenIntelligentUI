import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PointedVisual } from "@/components/cockpit/pointed-visual";
import { publishVisual, writeVisualSlot } from "@/lib/visual-pointer";

// Honey's pointing surface (kanban/device-input-matrix slice 2): the
// sidebar section that renders whatever the latest answer's VISUAL line
// pointed at. map/plex embed the honeyui render through the cockpit
// proxy and click through to the SAME URL full-page; file previews via
// the keyed receipt reader and clicks through to the /vault viewer; no
// pointer rests at a hint instead of lingering on an older artifact.

// The REAL lane the chat surface uses — publishVisual writes the slot
// (which dispatches the storage event the section subscribes to).
function publish(agent: "honey" | "larry", visual: Parameters<typeof publishVisual>[1]) {
  act(() => {
    publishVisual(agent, visual);
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders a pointed map as the proxied honeyui iframe with click-through", async () => {
  render(<PointedVisual agent="honey" />);

  publish("honey", {
    kind: "map",
    path: "Vision/Agent Visuals/example.excalidraw.md",
  });

  const frame = (await screen.findByTitle(
    "excalidraw render of Vision/Agent Visuals/example.excalidraw.md",
  )) as HTMLIFrameElement;
  expect(frame.tagName).toBe("IFRAME");
  expect(frame.getAttribute("src")).toBe(
    "/api/cockpit/honeyui/?map=Vision%2FAgent%20Visuals%2Fexample.excalidraw.md",
  );

  // click-through: same URL, full page, new tab
  const open = screen.getByTestId("pointed-open") as HTMLAnchorElement;
  expect(open.getAttribute("href")).toBe(frame.getAttribute("src"));
  expect(open.getAttribute("target")).toBe("_blank");
  expect(open.getAttribute("rel")).toBe("noopener");
});

it("renders a pointed plex through the same lane", async () => {
  render(<PointedVisual agent="honey" />);
  publish("honey", { kind: "plex", path: "K-Plex/Mind Map.md" });
  const frame = await screen.findByTitle("k-plex render of K-Plex/Mind Map.md");
  expect(frame.getAttribute("src")).toBe(
    "/api/cockpit/honeyui/?plex=K-Plex%2FMind%20Map.md",
  );

  // click-through (owner directive 2026-10-22): a plex item opens the
  // K-Plex walk view of that exact note, full page, new tab — the
  // same-origin proxied honeyui render (?plex=<note path>, auth
  // inlined server-side). Same URL as the embed, target _blank.
  const open = screen.getByTestId("pointed-open") as HTMLAnchorElement;
  expect(open.getAttribute("href")).toBe(
    "/api/cockpit/honeyui/?plex=K-Plex%2FMind%20Map.md",
  );
  expect(open.getAttribute("href")).toBe(frame.getAttribute("src"));
  expect(open.getAttribute("target")).toBe("_blank");
  expect(open.getAttribute("rel")).toBe("noopener");
});

it("previews a pointed file via the keyed reader and clicks through to /vault", async () => {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/board/receipt?file=kanban%2Fdevice-input-matrix.md")) {
      return new Response("# Device input matrix\nbody", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);

  render(<PointedVisual agent="honey" />);
  publish("honey", { kind: "file", path: "kanban/device-input-matrix.md" });

  await waitFor(() =>
    expect(screen.getByText(/Device input matrix/)).toBeInTheDocument(),
  );
  const open = screen.getByTestId("pointed-open") as HTMLAnchorElement;
  expect(open.getAttribute("href")).toBe(
    "/vault?file=kanban%2Fdevice-input-matrix.md",
  );
  expect(open.getAttribute("target")).toBe("_blank");
});

it("restores the slot from storage on mount", () => {
  writeVisualSlot("honey", { kind: "plex", path: "Plex/Mind Map.md" });
  render(<PointedVisual agent="honey" />);
  expect(
    screen.getByTitle("k-plex render of Plex/Mind Map.md"),
  ).toBeInTheDocument();
});

it("ignores pointers published for the other persona", async () => {
  render(<PointedVisual agent="honey" />);
  publish("larry", { kind: "map", path: "l.excalidraw.md" });
  // give the (wrong-key) store a beat to prove nothing re-renders
  await new Promise((r) => setTimeout(r, 25));
  expect(
    screen.getByText(/answers point their visuals here/),
  ).toBeInTheDocument();
});

it("clears the slot it rests on when the persona points at nothing", async () => {
  publish("honey", { kind: "map", path: "a.excalidraw.md" });
  render(<PointedVisual agent="honey" />);
  expect(screen.getByTitle(/render of a\.excalidraw\.md/)).toBeInTheDocument();
  publish("honey", null);
  await waitFor(() =>
    expect(
      screen.getByText(/answers point their visuals here/),
    ).toBeInTheDocument(),
  );
});
