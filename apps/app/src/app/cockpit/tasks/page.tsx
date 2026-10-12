import { redirect } from "next/navigation";

// The standalone Tasks tab is gone (owner directive 2026-10-12: tasks are
// split into the two chat surfaces). Old links land on Honey, whose panel
// carries the real MWP kanban tasks.
export default function TasksRedirectPage() {
  redirect("/cockpit/honey");
}
