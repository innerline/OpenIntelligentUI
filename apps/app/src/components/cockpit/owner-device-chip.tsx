"use client";

import { useEffect, useRef, useState } from "react";
import {
  detectOwnerDevice,
  getOwnerDeviceOverride,
  OWNER_DEVICES,
  OWNER_DEVICE_CHANGED_EVENT,
  setOwnerDeviceOverride,
  type OwnerDevice,
} from "@/lib/owner-device";

// Manual device override chip (kanban/device-input-matrix, owner
// refinement 2026-10-18): the heuristic tagged the owner "studio" while
// he sat at his laptop — his laptop reaches the cockpit through a
// loopback-shaped path, and no browser-side guess can tell which desk a
// desktop is at. This chip shows the tag CURRENTLY BEING SENT (what the
// engine believes) and lets the owner pin the truth: phone / ipad /
// laptop / studio. The pin persists at owner-device-override and beats
// the heuristic everywhere (detectOwnerDevice reads it first); "auto"
// drops the pin and returns to the guess. Additive by P1 law: one small
// control in the chat head, existing structure untouched.

export function OwnerDeviceChip() {
  const [device, setDevice] = useState<OwnerDevice>(() => detectOwnerDevice());
  const [override, setOverride] = useState<OwnerDevice | null>(() =>
    getOwnerDeviceOverride(),
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The chip, engine-chat's send tag and the provider's properties all
  // re-read the detector when the pin changes — one event, no remount.
  useEffect(() => {
    const onChange = () => {
      setDevice(detectOwnerDevice());
      setOverride(getOwnerDeviceOverride());
    };
    window.addEventListener(OWNER_DEVICE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(OWNER_DEVICE_CHANGED_EVENT, onChange);
  }, []);

  // Close on outside press or Escape — a picker, not a modal.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pin = (choice: OwnerDevice | null) => {
    setOwnerDeviceOverride(choice);
    setOpen(false);
  };

  return (
    <div className="owner-device-chip" ref={rootRef}>
      <button
        type="button"
        className="owner-device-chip-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Owner device: ${device}${override ? " (pinned)" : " (auto)"}`}
        title="Where the engine thinks you are — click to pin this browser's device"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={override ? "owner-device-dot pinned" : "owner-device-dot"}
          aria-hidden
        />
        {device}
        {!override && <span className="owner-device-auto">auto</span>}
      </button>
      {open && (
        <div className="owner-device-menu" role="menu" aria-label="Pin this browser's device">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={override === null}
            className="owner-device-option"
            onClick={() => pin(null)}
          >
            <span className="owner-device-mark" aria-hidden>
              {override === null ? "•" : ""}
            </span>
            auto — guess from this browser
          </button>
          {OWNER_DEVICES.map((d) => (
            <button
              type="button"
              key={d}
              role="menuitemradio"
              aria-checked={override === d}
              className="owner-device-option"
              onClick={() => pin(d)}
            >
              <span className="owner-device-mark" aria-hidden>
                {override === d ? "•" : ""}
              </span>
              {d}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
