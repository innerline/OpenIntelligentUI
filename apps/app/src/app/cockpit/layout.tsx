import type { Metadata } from "next";
import { EngineStatusProvider } from "@/components/cockpit/engine-status";
import { CockpitNav } from "@/components/cockpit/cockpit-nav";

export const metadata: Metadata = {
  title: "Cockpit",
  description:
    "Five surfaces: Honey, Larry, Boards, Visuals, Tasks — the CopilotKit-suite cockpit over the MWP platform.",
};

export default function CockpitLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="cockpit-app">
      <EngineStatusProvider>
        <CockpitNav />
        <main className="cockpit-main">{children}</main>
      </EngineStatusProvider>
    </div>
  );
}
