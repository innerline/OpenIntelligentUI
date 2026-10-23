"use client";

import { useEffect, useState } from "react";
import { honeyuiFileUrl } from "@/lib/honeyui-proxy";
import type { PulseEvent } from "@/lib/pulse";
import "./cockpit.css";

// The dashboard section of the visuals sidebar (THE REDO J07 — the
// k-plex dashboard's stage-04 content in the J01 viewer): the platform
// pulse — what moved lately, one row per shipped run, each tappable to
// its receipt note through the cockpit's honeyui file proxy (same
// reader as the board's click-through, new tab). Read-only; light
// auto-refresh rides the board's pattern (60s poll + refetch on tab
// visibility).

type Payload = { events: PulseEvent[]; generated: string };

const REFRESH_MS = 60_000;

export function PulsePanel() {
  const [events, setEvents] = useState<PulseEvent[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/cockpit/pulse", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((p: Payload) => {
          if (!cancelled) {
            setEvents(p.events ?? []);
            setError("");
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const iv = setInterval(load, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <section className="sidebar-pulse" aria-label="platform pulse — what moved lately">
      <div className="sidebar-board-head">
        <b>dashboard · pulse</b>
        {events !== null && <span className="board-count">{events.length} runs</span>}
      </div>
      {events === null && !error && (
        <p className="board-hint">reading the pulse feed…</p>
      )}
      {error && <p className="board-hint board-error">pulse unreadable ({error})</p>}
      {events?.length === 0 && (
        <p className="board-hint">no runs yet — the feed starts at each ship.</p>
      )}
      <ul>
        {events?.map((ev) => (
          <li key={ev.file}>
            <span className="pulse-chips">
              {ev.event && <i className="pulse-chip pulse-event" data-event={ev.event}>{ev.event}</i>}
              {ev.seat && <i className="pulse-chip pulse-seat">{ev.seat}</i>}
              <time className="pulse-date">{ev.date}</time>
            </span>
            {ev.receipt ? (
              <a
                href={honeyuiFileUrl(ev.receipt)}
                target="_blank"
                rel="noopener"
                title={ev.receipt}
                className="pulse-title"
              >
                {ev.title} ↗
              </a>
            ) : (
              <span className="pulse-title">{ev.title}</span>
            )}
            {ev.body && <p className="pulse-body">{ev.body}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
