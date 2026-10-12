import { BoardsView } from "@/components/cockpit/boards-view";

// Boards tab — the sidebar board (pulse / needs me / runs w/ receipts)
// promoted to a full surface. Same /api/board vault read as the sidebar.
export default function BoardsPage() {
  return <BoardsView />;
}
