"use client";

import dynamic from "next/dynamic";
import type { CoordinatorTraceEvent } from "@/lib/api";
import { ReplayStormViz, type StormTick } from "./ReplayStormViz";
import { TraceEventLog } from "./TraceEventLog";
import type { SupervisorPath } from "./SupervisorGraphFlow";

const CoordinatorGraphFlow = dynamic(
  () => import("./CoordinatorGraphFlow").then((m) => m.CoordinatorGraphFlow),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[300px] items-center justify-center text-sm text-slate-400">
        Loading coordinator graph…
      </div>
    ),
  },
);

const SupervisorGraphFlow = dynamic(
  () => import("./SupervisorGraphFlow").then((m) => m.SupervisorGraphFlow),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[340px] items-center justify-center text-sm text-slate-400">
        Loading supervisor graph…
      </div>
    ),
  },
);

export type HeroVizMode = "idle" | "graph" | "storm" | "supervisor";

type HeroVisualizationPanelProps = {
  mode: HeroVizMode;
  trace: CoordinatorTraceEvent[];
  runStatus?: string | null;
  stormTicks: StormTick[];
  stormRunning: boolean;
  stormCompleted: boolean;
  supervisorPath?: SupervisorPath;
  supervisorConfirmDone?: boolean;
  supervisorHitlWaiting?: boolean;
};

const MODE_LABEL: Record<HeroVizMode, { title: string; subtitle: string }> = {
  idle: { title: "Coordinator graph view", subtitle: "LangGraph · SSE trace" },
  graph: { title: "Coordinator graph view", subtitle: "LangGraph · outbound coordinator" },
  storm: { title: "Replay storm view", subtitle: "LangGraph · outbox dedupe" },
  supervisor: { title: "Supervisor dispatch view", subtitle: "Care ops supervisor · inbound router" },
};

export function HeroVisualizationPanel({
  mode,
  trace,
  runStatus,
  stormTicks,
  stormRunning,
  stormCompleted,
  supervisorPath = "idle",
  supervisorConfirmDone = false,
  supervisorHitlWaiting = false,
}: HeroVisualizationPanelProps) {
  const label = MODE_LABEL[mode];

  return (
    <section className="overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-lg ring-1 ring-slate-800">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{label.title}</p>
        <p className="text-[10px] font-mono text-slate-500">{label.subtitle}</p>
      </div>

      <div className="px-2 py-3">
        {mode === "storm" ? (
          <ReplayStormViz ticks={stormTicks} running={stormRunning} completed={stormCompleted} />
        ) : mode === "supervisor" ? (
          <>
            <SupervisorGraphFlow
              path={supervisorPath}
              confirmDone={supervisorConfirmDone}
              hitlWaiting={supervisorHitlWaiting}
            />
            {supervisorHitlWaiting ? (
              <p className="mt-2 text-center text-xs font-medium text-amber-400 animate-pulse">
                ⏸ Inbound RESCHEDULE → outbound coordinator paused at HITL — approve in coordinator pane
              </p>
            ) : null}
          </>
        ) : mode === "graph" ? (
          <>
            <CoordinatorGraphFlow trace={trace} runStatus={runStatus} />
            {runStatus === "awaiting_approval" ? (
              <p className="mt-2 text-center text-xs font-medium text-amber-400 animate-pulse">
                ⏸ Waiting for care coordinator approval — graph checkpoint persisted
              </p>
            ) : null}
          </>
        ) : (
          <div className="flex h-[300px] flex-col items-center justify-center px-6 text-center">
            <p className="text-sm font-medium text-slate-300">Coordinator graph preview</p>
            <p className="mt-2 max-w-md text-xs text-slate-500">
              Run AI care coordinator to animate observe → plan → propose → HITL → execute → audit
              in sync with live trace events.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {["observe", "plan", "propose", "HITL", "execute", "audit"].map((step) => (
                <span
                  key={step}
                  className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-[10px] text-slate-500"
                >
                  {step}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {mode === "graph" && trace.length > 0 ? (
        <div className="px-4 pb-3">
          <TraceEventLog events={trace} defaultOpen={false} variant="dark" />
        </div>
      ) : null}
    </section>
  );
}
