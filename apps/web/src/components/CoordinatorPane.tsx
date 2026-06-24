"use client";

import { useCallback, useEffect, useState } from "react";
import {
  careOpsApi,
  type CoordinatorRun,
  type CoordinatorTraceEvent,
} from "@/lib/api";

type CoordinatorPaneProps = {
  interactionId: string | null;
  disabled: boolean;
  onLog: (line: string) => void;
  onRefresh: () => Promise<void>;
};

function traceLabel(event: CoordinatorTraceEvent): string {
  if (event.detail && "allowed" in event.detail) {
    return `${event.name} (allowed=${String(event.detail.allowed)})`;
  }
  if (event.detail && "policyKeys" in event.detail) {
    const keys = event.detail.policyKeys as string[];
    return `${event.name} [${keys.join(", ")}]`;
  }
  return event.name;
}

export function CoordinatorPane({
  interactionId,
  disabled,
  onLog,
  onRefresh,
}: CoordinatorPaneProps) {
  const [run, setRun] = useState<CoordinatorRun | null>(null);
  const [trace, setTrace] = useState<CoordinatorTraceEvent[]>([]);
  const [traceOpen, setTraceOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRun(null);
    setTrace([]);
  }, [interactionId]);

  const loadTrace = useCallback(async (runId: string) => {
    const result = await careOpsApi.getCoordinatorTrace(runId);
    setTrace(result.events);
  }, []);

  const subscribeTrace = useCallback(
    (runId: string) => {
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      const es = new EventSource(`/care-ops/coordinator/runs/${runId}/stream`);

      const appendFromPayload = (eventType: string, raw: MessageEvent) => {
        try {
          const payload = JSON.parse(raw.data) as CoordinatorTraceEvent;
          setTrace((prev) => {
            if (prev.some((item) => item.id === payload.id)) return prev;
            return [
              ...prev,
              {
                ...payload,
                runId,
                eventType: eventType === "proposal" ? "phase" : eventType,
              },
            ];
          });
        } catch {
          // ignore malformed SSE chunks
        }
      };

      for (const type of ["phase", "tool", "proposal", "interrupt", "complete"] as const) {
        es.addEventListener(type, (event) => appendFromPayload(type, event as MessageEvent));
      }

      es.onerror = () => {
        es.close();
        if (pollTimer) return;
        pollTimer = setInterval(() => {
          loadTrace(runId).catch(() => undefined);
        }, 500);
      };

      return () => {
        es.close();
        if (pollTimer) clearInterval(pollTimer);
      };
    },
    [loadTrace],
  );

  useEffect(() => {
    if (!run?.id) {
      setTrace([]);
      return;
    }
    loadTrace(run.id).catch(() => undefined);
    return subscribeTrace(run.id);
  }, [run?.id, loadTrace, subscribeTrace]);

  async function runCoordinator(signal: "manual" | "lifecycle") {
    if (!interactionId) return;
    setBusy(true);
    try {
      const started =
        signal === "lifecycle"
          ? (await careOpsApi.completeVoiceLifecycle(interactionId)).coordinatorRun
          : await careOpsApi.startCoordinatorRun(interactionId, signal);
      setRun(started);
      onLog(
        `Coordinator ${signal} → status=${started.status} model=${started.modelMode}${started.resumed ? " (resumed)" : ""}`,
      );
      await onRefresh();
    } catch (err) {
      onLog(`Coordinator failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!run) return;
    setBusy(true);
    try {
      const approved = await careOpsApi.approveCoordinatorRun(
        run.id,
        new Date().toISOString(),
      );
      setRun(approved);
      onLog(
        `Coordinator approved → duplicate=${String(approved.sendResult?.duplicate ?? false)}`,
      );
      await loadTrace(run.id);
      await onRefresh();
    } catch (err) {
      onLog(`Approve failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!run) return;
    setBusy(true);
    try {
      const rejected = await careOpsApi.rejectCoordinatorRun(run.id);
      setRun(rejected);
      onLog("Coordinator proposal rejected");
      await loadTrace(run.id);
    } catch (err) {
      onLog(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const isPending = run?.status === "awaiting_approval" && run.proposal?.status === "pending";
  const locked = disabled || busy;

  return (
    <div className="space-y-4 rounded-lg border border-dashed border-primary/30 bg-slate-50/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-primary">AI Coordinator</h3>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="badge-blue">{run?.graphEngine ?? "langgraph"}</span>
          <span className="badge-amber">model: {run?.modelMode ?? "—"}</span>
          {run?.checkpointReady ? (
            <span className="badge-green">checkpoint ready</span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn-secondary text-xs"
          disabled={!interactionId || locked}
          onClick={() => runCoordinator("manual")}
        >
          Run AI coordinator
        </button>
        <button
          className="btn-secondary text-xs"
          disabled={!interactionId || locked}
          onClick={() => runCoordinator("lifecycle")}
        >
          Simulate visit ended
        </button>
      </div>

      {!run ? (
        <p className="text-xs text-slate-500">
          Start a coordinator run to see proposal, trace, and approval gate.
        </p>
      ) : (
        <>
          <p className="text-xs text-slate-600">
            Run <span className="font-mono">{run.id.slice(0, 8)}…</span> ·{" "}
            {run.status}
            {run.ineligibleReason ? ` · ${run.ineligibleReason}` : ""}
          </p>

          {run.proposal ? (
            <div className="space-y-2 rounded-md border border-border bg-white p-3 text-sm">
              <div className="font-medium">Proposal · {run.proposal.templateId}</div>
              <p className="text-slate-700">{run.proposal.body}</p>
              <p className="text-xs text-slate-500">{run.proposal.rationale}</p>
              {isPending ? (
                <div className="flex gap-2 pt-1">
                  <button className="btn flex-1 text-xs" disabled={locked} onClick={approve}>
                    Approve
                  </button>
                  <button
                    className="btn-secondary flex-1 text-xs"
                    disabled={locked}
                    onClick={reject}
                  >
                    Reject
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <button
              className="mb-2 text-xs font-semibold text-slate-600"
              onClick={() => setTraceOpen((open) => !open)}
            >
              {traceOpen ? "▾" : "▸"} Coordinator trace ({trace.length})
            </button>
            {traceOpen ? (
              <ol className="max-h-48 space-y-1 overflow-auto font-mono text-xs text-slate-600">
                {trace.map((event) => (
                  <li key={event.id} className="rounded border border-border bg-white px-2 py-1">
                    <span className="text-primary">{event.eventType}</span> · {traceLabel(event)}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
