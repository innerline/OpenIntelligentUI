import type { Metadata } from "next";
import { EngineStatusProvider } from "@/components/cockpit/engine-status";
import { CockpitNav } from "@/components/cockpit/cockpit-nav";
import { VisualsSidebar } from "@/components/cockpit/visuals-sidebar";

export const metadata: Metadata = {
  title: "Cockpit",
  description:
    "Honey and Larry chats with their own task panels, the MWP kanban board, and the k-plex visuals docked as a right sidebar.",
};

export default function CockpitLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="cockpit-app">
      <EngineStatusProvider>
        <CockpitNav />
        <div className="cockpit-body">
          <main className="cockpit-main">{children}</main>
          <VisualsSidebar />
        </div>
      </EngineStatusProvider>
    </div>
  );
}
