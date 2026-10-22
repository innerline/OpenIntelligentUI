import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { BoardPanel } from "@/components/cockpit/board-panel";
import { VisualsSidebar } from "@/components/cockpit/visuals-sidebar";
import type { BoardGroup } from "@/lib/kanban";

// The sidebar's board section (kanban-restructure S3): the unfinished
// kanban as a compact grouped list — groups with counts, cards with
// owner chips, read-only except the ONE click-through (the honeyui
// keyed reader, same-origin proxied, new tab). Light auto-refresh: a
// 60s poll rides the same fetch lane.

vi.mock("next/navigation", () => ({
  usePathname: () => "/cockpit/honey",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}));

const GROUPS: BoardGroup[] = [
  {
    status: "running",
    note: "claimed, work in progress",
    cards: [
      {
        file: "unified-honey.md",
        path: "kanban/unified-honey.md",
        title: "Unified Honey",
        status: "running",
        owner: "honey",
        tags: [],
        updated: "2026-10-22T00:00:00Z",
      },
      {
        file: "kanban-restructure.md",
        path: "kanban/kanban-restructure.md",
        title: "Kanban restructure",
        status: "running",
        owner: "opencode",
        tags: [],
        updated: "2026-10-21T00:00:00Z",
      },
    ],
  },
  {
    status: "doing",
    note: "",
    cards: [
      {
        file: "device-input-matrix.md",
        path: "kanban/device-input-matrix.md",
        title: "Device input matrix",
        status: "doing",
        owner: null,
        tags: [],
        updated: "2026-10-20T00:00:00Z",
      },
    ],
  },
];

function stubBoard() {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/cockpit/board");
    return Response.json({ groups: GROUPS, generated: "2026-10-22T00:00:00Z" });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("cockpit:visuals-open", "1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("renders the groups, counts, and owner chips from the board route", async () => {
  stubBoard();
  render(<BoardPanel />);

  expect(await screen.findByText(/3 unfinished/)).toBeInTheDocument();
  const board = screen.getByLabelText("the current kanban board");
  const running = board.querySelector('[data-status="running"]');
  expect(running).not.toBeNull();
  expect(running!.querySelector(".board-status")?.textContent).toBe("running 2");
  // cards with their owner chips, newest-first as the route sorted them
  const rows = running!.querySelectorAll("a");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("Unified Honey");
  expect(rows[0]).toHaveTextContent("honey");
  expect(rows[1]).toHaveTextContent("Kanban restructure");
  expect(screen.getByText("Device input matrix")).toBeInTheDocument();
});

it("click-through is the ONE interaction: the honeyui keyed reader, new tab", async () => {
  stubBoard();
  render(<BoardPanel />);

  const card = (await screen.findByText("Unified Honey")).closest("a") as HTMLAnchorElement;
  expect(card.getAttribute("href")).toBe(
    "/api/cockpit/honeyui/?file=kanban%2Funified-honey.md",
  );
  expect(card.getAttribute("target")).toBe("_blank");
  expect(card.getAttribute("rel")).toBe("noopener");
  expect(card.getAttribute("title")).toBe("kanban/unified-honey.md");
});

it("auto-refreshes on the 60s poll — the fetch lane fires again", async () => {
  vi.useFakeTimers();
  const fetchMock = stubBoard();
  render(<BoardPanel />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("shows the unreadable line when the route fails — never a fake-clear board", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("boom", { status: 503 })),
  );
  render(<BoardPanel />);
  await waitFor(() =>
    expect(screen.getByText(/board unreadable/)).toBeInTheDocument(),
  );
  expect(screen.queryByText(/nothing unfinished/)).not.toBeInTheDocument();
});

it("mounts inside the visuals sidebar, below the pointing surface", async () => {
  // the board lane plus the plex walk's own lane — the latter answers
  // empty so the walk renders quiet
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/cockpit/board")
        return Response.json({ groups: GROUPS, generated: "now" });
      return Response.json({}, { status: 404 });
    }),
  );
  render(<VisualsSidebar />);

  const board = await screen.findByLabelText("the current kanban board");
  const pointed = screen.getByLabelText("what the answer points at");
  // slice-2 law holds: the pointing surface stays FIRST, board second
  expect(pointed.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(await screen.findByText("Unified Honey")).toBeInTheDocument();
});
