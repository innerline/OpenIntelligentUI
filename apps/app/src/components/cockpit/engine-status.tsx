"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

// Engine status for the cockpit — the Honey (:8126) / Larry (:8127) AG-UI
// adapters, probed server-side by /api/engine-status because they bind to
// Studio loopback. One poller for the whole cockpit (nav dots + chat
// banners read the same context).

export type EngineStatus = { ok: boolean; detail: string };
export type EngineStatuses = { honey: EngineStatus; larry: EngineStatus; pi: EngineStatus };

const EngineStatusContext = createContext<EngineStatuses | null>(null);

export function EngineStatusProvider({ children }: { children: React.ReactNode }) {
  const [statuses, setStatuses] = useState<EngineStatuses | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/engine-status", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<EngineStatuses>) : null))
        .then((d) => {
          if (alive) setStatuses(d);
        })
        .catch(() => {
          if (alive) setStatuses(null);
        });
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Re-render the whole cockpit only when a status actually CHANGED —
  // a fresh-but-identical object every 30s was re-rendering every consumer
  // mid-typing, which Safari punishes by killing dictation composition
  // (owner: "types ~20 characters then resets", 2026-10-12).
  const value = useMemo(() => statuses, [statuses?.honey.ok, statuses?.honey.detail, statuses?.larry.ok, statuses?.larry.detail, statuses?.pi.ok, statuses?.pi.detail]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <EngineStatusContext.Provider value={value}>{children}</EngineStatusContext.Provider>
  );
}

export const useEngineStatuses = () => useContext(EngineStatusContext);
