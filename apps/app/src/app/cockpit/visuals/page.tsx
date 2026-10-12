import { redirect } from "next/navigation";

// The Visuals tab is gone (owner directive 2026-10-12: visuals live as a
// large right sidebar on the chat surfaces). Old links land on Honey with
// the sidebar forced open, so nothing breaks.
export default function VisualsRedirectPage() {
  redirect("/cockpit/honey?visuals=1");
}
