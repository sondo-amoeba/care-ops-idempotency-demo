"use client";

import { useState } from "react";
import type { CoordinatorTraceEvent } from "@/lib/api";
import { traceLabel } from "@/lib/trace-label";

type TraceEventLogProps = {
  events: CoordinatorTraceEvent[];
  defaultOpen?: boolean;
  variant?: "light" | "dark";
};

export function TraceEventLog({
  events,
  defaultOpen = false,
  variant = "dark",
}: TraceEventLogProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (events.length === 0) return null;

  const isDark = variant === "dark";

  return (
    <div className={isDark ? "border-t border-slate-700/80 pt-3" : "border-t border-border pt-3"}>
      <button
        type="button"
        className={`text-xs font-semibold ${isDark ? "text-slate-400 hover:text-slate-200" : "text-slate-600"}`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} {events.length} trace events — show detail
      </button>
      {open ? (
        <ol
          className={`mt-2 max-h-36 space-y-1 overflow-auto font-mono text-xs ${
            isDark ? "text-slate-300" : "text-slate-600"
          }`}
        >
          {events.map((event) => (
            <li
              key={event.id}
              className={`rounded px-2 py-1 ${
                isDark ? "border border-slate-700 bg-slate-900/60" : "border border-border bg-white"
              }`}
            >
              <span className={isDark ? "text-sky-400" : "text-primary"}>{event.eventType}</span> ·{" "}
              {traceLabel(event)}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
