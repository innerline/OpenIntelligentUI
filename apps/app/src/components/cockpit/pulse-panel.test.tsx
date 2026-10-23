import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PulsePanel } from "@/components/cockpit/pulse-panel";
import type { PulseEvent } from "@/lib/pulse";

// The sidebar's dashboard section (THE REDO J07): the platform pulse —
// newest-first run rows with event/seat chips, receipts tappable
// through the honeyui keyed reader (same click-through lane as the
// board), read-only, 60s poll riding the board's pattern.

const EVENTS: PulseEvent[] = [
  {
    file: "2026-10-23-redo-p1.md",
    path: "Daily/pulse/2026-10-23-redo-p1.md",
    title: "P1 at the owner gate",
    date: "2026-10-23",
    event: "gate",
    seat: "opencode",
    project: "the redo",
    receipt: "kanban/the-redo.md",
    commit: "",
    body: "Cockpit increment receipt.",
  },
  {
    file: "2026-10-09-kplex-dashboard-stage-03.md",
    path: "Daily/pulse/2026-10-09-kplex-dashboard-stage-03.md",
    title: "k-plex dashboard stage-03 SHIPPED",
    date: "2026-10-09",
    event: "build",
    seat: "copilot",
    project: "k-plex dashboard",
    receipt: "copilot/projects/k-plex project/stage-03-build-receipt.md",
    commit: "a05dd80",
    body: "",
  },
  {
    file: "2026-10-22-bare.md",
    path: "Daily/pulse/2026-10-22-bare.md",
    title: "A bare run",
    date: "2026-10-22",
    event: "",
    seat: "",
    project: "",
    receipt: "",
    commit: "",
    body: "Short.",
  },
];

function stubPulse() {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/cockpit/pulse");
    return Response.json({ events: EVENTS, generated: "2026-10-23T00:00:00Z" });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("renders the feed newest-first with chips, counts, and bodies", async () => {
  stubPulse();
  render(<PulsePanel />);

  expect(await screen.findByText(/3 runs/)).toBeInTheDocument();
  const pulse = screen.getByLabelText("platform pulse — what moved lately");
  const rows = pulse.querySelectorAll("li");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("gate");
  expect(rows[0]).toHaveTextContent("opencode");
  expect(rows[0]).toHaveTextContent("P1 at the owner gate");
  expect(rows[0]).toHaveTextContent("Cockpit increment receipt.");
  expect(rows[1]).toHaveTextContent("k-plex dashboard stage-03 SHIPPED");
  // bare rows stay — no chips, no link, body still shown
  expect(rows[2]).toHaveTextContent("A bare run");
  expect(rows[2].querySelector("a")).toBeNull();
});

it("receipts are tappable through the honeyui keyed reader, new tab", async () => {
  stubPulse();
  render(<PulsePanel />);

  const link = (await screen.findByText("P1 at the owner gate ↗")).closest(
    "a",
  ) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(
    "/api/cockpit/honeyui/?file=kanban%2Fthe-redo.md",
  );
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener");
  const spaced = (await screen.findByText("k-plex dashboard stage-03 SHIPPED ↗"))
    .closest("a") as HTMLAnchorElement;
  expect(spaced.getAttribute("href")).toBe(
    "/api/cockpit/honeyui/?file=copilot%2Fprojects%2Fk-plex%20project%2Fstage-03-build-receipt.md",
  );
});

it("auto-refreshes on the 60s poll — the fetch lane fires again", async () => {
  vi.useFakeTimers();
  const fetchMock = stubPulse();
  render(<PulsePanel />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("shows the unreadable line when the route fails — never a fake-clear feed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("boom", { status: 503 })),
  );
  render(<PulsePanel />);
  await waitFor(() =>
    expect(screen.getByText(/pulse unreadable/)).toBeInTheDocument(),
  );
});
