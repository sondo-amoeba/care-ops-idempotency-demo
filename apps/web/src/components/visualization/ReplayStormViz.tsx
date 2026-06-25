"use client";

import { useMemo } from "react";

export type StormTick = {
  index: number;
  duplicate: boolean;
};

type ReplayStormVizProps = {
  ticks: StormTick[];
  running: boolean;
  completed: boolean;
};

export function ReplayStormViz({ ticks, running, completed }: ReplayStormVizProps) {
  const blocked = ticks.filter((t) => t.duplicate).length;
  const accepted = ticks.filter((t) => !t.duplicate).length;
  const summary = useMemo(
    () => ({ total: ticks.length, blocked, accepted }),
    [ticks.length, blocked, accepted],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Outbound idempotency · replay storm
          </p>
          <p className="mt-1 text-sm text-slate-300">
            50 identical workflow triggers · same idempotency key · one outbox row
          </p>
        </div>
        {summary.total > 0 ? (
          <div className="text-right">
            <p className="font-mono text-3xl font-bold text-emerald-400">
              {accepted} <span className="text-lg text-slate-500">/ {summary.total}</span>
            </p>
            <p className="text-xs text-slate-400">accepted · {blocked} blocked</p>
          </div>
        ) : null}
      </div>

      {ticks.length === 0 && !running ? (
        <p className="rounded-lg border border-dashed border-slate-600 bg-slate-900/50 px-4 py-8 text-center text-sm text-slate-400">
          Run the 50× replay storm below — watch duplicates collapse in real time.
        </p>
      ) : (
        <div className="grid grid-cols-10 gap-1.5 sm:grid-cols-10">
          {Array.from({ length: 50 }, (_, i) => {
            const tick = ticks.find((t) => t.index === i + 1);
            let cls =
              "aspect-square rounded-md border border-slate-700 bg-slate-800/50 transition-all duration-300";
            if (tick) {
              cls = tick.duplicate
                ? "aspect-square rounded-md border border-amber-500/60 bg-amber-950/60 shadow-[0_0_12px_rgba(251,191,36,0.25)] animate-storm-block"
                : "aspect-square rounded-md border border-emerald-500 bg-emerald-900/70 shadow-[0_0_16px_rgba(52,211,153,0.4)] scale-110";
            } else if (running && i < ticks.length + 3) {
              cls =
                "aspect-square rounded-md border border-sky-500/40 bg-sky-950/40 animate-pulse";
            }
            return (
              <div key={i} className={cls} title={tick ? (tick.duplicate ? "duplicate" : "accepted") : "pending"}>
                {tick ? (
                  <span className="flex h-full items-center justify-center text-[8px] font-mono text-slate-400">
                    {tick.duplicate ? "✕" : "✓"}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {completed && summary.total === 50 ? (
        <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/40 px-4 py-3 text-center">
          <p className="font-semibold text-emerald-300">
            {blocked} of 50 triggers blocked by idempotency key
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Outbox dedupe authority — INSERT ON CONFLICT DO NOTHING
          </p>
        </div>
      ) : running ? (
        <p className="text-center text-xs text-sky-400 animate-pulse">
          Firing triggers… {ticks.length}/50
        </p>
      ) : null}
    </div>
  );
}
