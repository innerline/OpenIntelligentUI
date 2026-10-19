"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEngineStatuses } from "./engine-status";
import "./cockpit.css";

// The cockpit surfaces after the 2026-10-12 redesign: Honey and Larry
// (chats with embedded task panels; the Visuals sidebar docks alongside
// them) and Boards (the MWP kanban mirror). Engine tabs carry a live
// status dot fed by the shared engine-status context (the adapters sit
// on Studio loopback; only the server can probe them). The dot is a
// light, not a gate.

const TABS = [
  { href: "/cockpit/honey", label: "Honey", engine: "honey" as const },
  { href: "/cockpit/larry", label: "Larry", engine: "larry" as const },
  { href: "/cockpit/pi", label: "Pi", engine: "pi" as const },
  { href: "/cockpit/boards", label: "Boards", engine: null },
];

export function CockpitNav() {
  const pathname = usePathname();
  const statuses = useEngineStatuses();

  return (
    <header className="cockpit-header">
      <span className="cockpit-brand">Cockpit</span>
      <nav className="cockpit-tabs" aria-label="Cockpit surfaces">
        {TABS.map((tab) => {
          const active = pathname?.startsWith(tab.href);
          const status = tab.engine ? statuses?.[tab.engine] : undefined;
          const dotClass = status === undefined ? "unknown" : status.ok ? "ok" : "off";
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="cockpit-tab"
              aria-current={active ? "page" : undefined}
              title={
                tab.engine && status
                  ? `${tab.label} engine: ${status.detail}`
                  : tab.label
              }
            >
              {tab.engine && <span className={`cockpit-tab-dot ${dotClass}`} aria-hidden />}
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <Link className="cockpit-home" href="/">
        ← chat
      </Link>
    </header>
  );
}
