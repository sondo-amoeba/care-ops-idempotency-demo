"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  careOpsApi,
  type CoordinatorRun,
  type EligibilityRule,
  type InteractionSummary,
  type ThreadDetail,
} from "@/lib/api";
import { CoordinatorPane } from "@/components/CoordinatorPane";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { WalkthroughGuide, deriveWalkthroughState } from "@/components/WalkthroughGuide";
import {
  HeroVisualizationPanel,
  type HeroVizMode,
} from "@/components/visualization/HeroVisualizationPanel";
import type { StormTick } from "@/components/visualization/ReplayStormViz";
import type { CoordinatorTraceEvent } from "@/lib/api";

const DEFAULT_PROGRAM = "behavioral-health-outreach";

function statusLabel(kind: string, status: string | undefined): string {
  if (!status) return "unknown";
  const plain: Record<string, Record<string, string>> = {
    thread: { open: "awaiting patient", resolved: "patient confirmed" },
    voice: { scheduled: "visit scheduled", completed: "visit completed" },
    booking: { pending: "needs confirmation", confirmed: "confirmed" },
  };
  return plain[kind]?.[status] ?? status;
}

export default function CareAgentConsole() {
  const [interactions, setInteractions] = useState<InteractionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [rules, setRules] = useState<EligibilityRule[]>([]);
  const [metrics, setMetrics] = useState<string>("");
  const [patientId, setPatientId] = useState("patient-demo-001");
  const [templateId, setTemplateId] = useState("appointment-reminder");
  const [messageBody, setMessageBody] = useState(
    "Hi — your behavioral health intake appointment is tomorrow at 10:00 AM. Reply YES to confirm.",
  );
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [coordinatorRun, setCoordinatorRun] = useState<CoordinatorRun | null>(null);
  const [coordinatorTrace, setCoordinatorTrace] = useState<CoordinatorTraceEvent[]>([]);
  const [stormCompleted, setStormCompleted] = useState(false);
  const [stormRunning, setStormRunning] = useState(false);
  const [stormTicks, setStormTicks] = useState<StormTick[]>([]);
  const bootstrapped = useRef(false);

  const pushLog = (line: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${line}`, ...prev].slice(0, 16));

  const refresh = useCallback(async () => {
    const [list, ruleList, dup] = await Promise.all([
      careOpsApi.listInteractions(),
      careOpsApi.listRules(),
      careOpsApi.duplicateMetrics(),
    ]);
    setInteractions(list);
    setRules(ruleList);
    setMetrics(
      `Outbound rows: ${dup.totalOutbound} · Outbox keys: ${dup.distinctKeys} · Dup rate: ${(dup.duplicateRate * 100).toFixed(2)}%`,
    );
    if (selectedId) {
      setThread(await careOpsApi.getThread(selectedId));
    } else {
      setThread(null);
    }
  }, [selectedId]);

  useEffect(() => {
    refresh().catch((err) => pushLog(`Refresh failed: ${err.message}`));
  }, [refresh]);

  useEffect(() => {
    if (selectedId || interactions.length === 0) return;
    setSelectedId(interactions[0].id);
  }, [interactions, selectedId]);

  useEffect(() => {
    if (bootstrapped.current) return;
    if (interactions.length > 0) {
      bootstrapped.current = true;
      return;
    }
    bootstrapped.current = true;
    createThread().catch((err) => pushLog(`Auto-start failed: ${err.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap once when list empty
  }, [interactions.length]);

  const coordinatorApproved = useMemo(() => {
    if (coordinatorRun?.status === "completed") return true;
    if (coordinatorRun?.proposal?.status === "approved") return true;
    return (
      thread?.messages.some(
        (msg) => msg.direction === "outbound" && msg.source === "ai_coordinator",
      ) ?? false
    );
  }, [coordinatorRun, thread?.messages]);

  const patientConfirmed = thread?.careThread?.status === "resolved";

  const inboundProposalReady = useMemo(() => {
    if (coordinatorRun?.signalType !== "inbound") return false;
    return Boolean(
      coordinatorRun.proposal || coordinatorRun.status === "awaiting_approval",
    );
  }, [coordinatorRun]);

  const walkthrough = deriveWalkthroughState({
    hasThread: Boolean(thread),
    coordinatorStarted: Boolean(coordinatorRun),
    coordinatorApproved,
    stormCompleted,
    patientConfirmed,
    inboundProposalReady,
  });

  const heroMode: HeroVizMode =
    walkthrough.current === 4 || stormRunning
      ? "storm"
      : walkthrough.current === 5 || walkthrough.current === 6
        ? "supervisor"
        : coordinatorRun
          ? "graph"
          : "idle";

  const supervisorPath =
    walkthrough.current === 6 ? "inbound_reschedule" : "inbound_confirm";

  const supervisorHitlWaiting =
    walkthrough.current === 6 &&
    coordinatorRun?.signalType === "inbound" &&
    coordinatorRun.status === "awaiting_approval";

  async function createThread() {
    setBusy(true);
    try {
      const created = await careOpsApi.createInteraction(patientId, DEFAULT_PROGRAM);
      setSelectedId(created.id);
      setCoordinatorRun(null);
      setCoordinatorTrace([]);
      setStormCompleted(false);
      setStormTicks([]);
      pushLog(`Started patient episode ${created.id.slice(0, 8)}…`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function sendSms(source: "care_agent" | "agent_workflow") {
    if (!selectedId) return;
    setBusy(true);
    try {
      const payload = {
        interactionId: selectedId,
        patientId,
        programId: DEFAULT_PROGRAM,
        templateId,
        body: messageBody,
        windowStart: new Date().toISOString(),
      };
      const res =
        source === "care_agent"
          ? await careOpsApi.sendSms(payload)
          : await careOpsApi.triggerAgentSms(payload);
      pushLog(
        `${source} send → duplicate=${String(res.duplicate)} sid=${res.message?.twilioMessageSid?.slice(0, 12) ?? "n/a"}…`,
      );
      await refresh();
    } catch (err) {
      pushLog(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function replayInbound(body: string, options?: { proveReplay?: boolean }) {
    if (!selectedId) return;
    setBusy(true);
    try {
      const sid = body.startsWith("YES") ? "SM_INBOUND_DEMO_FIXED" : "SM_INBOUND_RESCHEDULE_DEMO";
      const payload = { MessageSid: sid, Body: body, interactionId: selectedId };
      const first = await careOpsApi.replayInbound(payload);
      if (options?.proveReplay !== false) {
        const second = await careOpsApi.replayInbound(payload);
        pushLog(`Inbound #2 duplicate=${String(second.duplicate)} (SID replay blocked)`);
      }
      if (first.coordinatorRun) {
        setCoordinatorRun(first.coordinatorRun);
        const traceResult = await careOpsApi.getCoordinatorTrace(first.coordinatorRun.id);
        setCoordinatorTrace(traceResult.events);
      }
      pushLog(
        `Inbound → duplicate=${String(first.duplicate)} confirmed=${String(first.confirmed ?? false)} intent=${first.intent ?? "n/a"}`,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function simulateVisitEnded() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const res = await careOpsApi.completeVoiceLifecycle(selectedId);
      if (res.coordinatorRun) setCoordinatorRun(res.coordinatorRun);
      pushLog(
        `Voice visit ended → coordinator status=${res.coordinatorRun?.status ?? "n/a"}`,
      );
      await refresh();
    } catch (err) {
      pushLog(`Visit ended failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function simulateDelivery() {
    if (!thread) return;
    const latestOutbound = [...thread.messages]
      .reverse()
      .find((msg) => msg.direction === "outbound");
    if (!latestOutbound) {
      pushLog("No outbound message to update");
      return;
    }
    setBusy(true);
    try {
      const res = await careOpsApi.updateStatus({
        MessageSid: latestOutbound.twilioMessageSid,
        MessageStatus: "delivered",
      });
      pushLog(
        `Delivery callback → updated=${String(res.updated)} (same row, no duplicate insert)`,
      );
      await refresh();
    } catch (err) {
      pushLog(`Status callback failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runStorm() {
    if (!selectedId) return;
    setBusy(true);
    setStormRunning(true);
    setStormTicks([]);
    try {
      let dupCount = 0;
      const windowStart = new Date().toISOString();
      for (let i = 0; i < 50; i++) {
        const res = await careOpsApi.triggerAgentSms({
          interactionId: selectedId,
          patientId,
          programId: DEFAULT_PROGRAM,
          templateId: "storm-demo",
          body: "Storm test — should dedupe",
          windowStart,
        });
        if (res.duplicate) dupCount += 1;
        setStormTicks((prev) => [...prev, { index: i + 1, duplicate: res.duplicate }]);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      setStormCompleted(true);
      pushLog(`Replay storm: 50 triggers, ${dupCount} blocked as duplicates`);
      await refresh();
    } finally {
      setStormRunning(false);
      setBusy(false);
    }
  }

  async function toggleRule(rule: EligibilityRule) {
    await careOpsApi.upsertRule({ ...rule, enabled: !rule.enabled });
    pushLog(`Eligibility ${rule.action} → ${!rule.enabled ? "enabled" : "disabled"}`);
    await refresh();
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl p-6">
      <header className="mb-6">
        <p className="text-sm font-medium text-primary">Public invariant lab · no PHI</p>
        <h1 className="text-2xl font-semibold">Care coordinator console</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Clinical SMS fails when retries duplicate — agents make that worse. Dedupe first,
          intelligence second.
        </p>
        <p className="mt-2 text-xs text-slate-500">{metrics}</p>
      </header>

      <div className="mb-4">
        <WalkthroughGuide
          current={walkthrough.current}
          completed={walkthrough.completed}
          tier2Unlocked={walkthrough.tier2Unlocked}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card space-y-3 lg:col-span-1">
          <h2 className="font-semibold">Patient episodes</h2>
          <p className="text-xs text-slate-500">
            Step 1 — each episode links care thread, voice visit, booking, and SMS history.
          </p>
          <label className="label" htmlFor="patientId">
            Patient ID
          </label>
          <input
            id="patientId"
            className="input"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
          />
          <button
            className={`btn w-full ${walkthrough.current === 1 ? "ring-2 ring-primary ring-offset-2" : ""}`}
            disabled={busy}
            onClick={createThread}
          >
            New patient episode
          </button>
          <ul className="max-h-64 space-y-2 overflow-auto text-sm">
            {interactions.map((item) => (
              <li key={item.id}>
                <button
                  className={`w-full rounded-md border px-3 py-2 text-left ${
                    selectedId === item.id ? "border-primary bg-blue-50" : "border-border"
                  }`}
                  onClick={() => {
                    setSelectedId(item.id);
                    setCoordinatorRun(null);
                    setCoordinatorTrace([]);
                    setStormCompleted(false);
                    setStormTicks([]);
                  }}
                >
                  <div className="font-medium">{item.patientId}</div>
                  <div className="text-xs text-slate-500">
                    {item.messageCount} messages · {item.id.slice(0, 8)}…
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-4 lg:col-span-2">
          {!thread ? (
            <div className="card">
              <p className="text-sm text-slate-500">
                Select or create a patient episode to begin the walkthrough.
              </p>
            </div>
          ) : (
            <>
              <div className="card">
                <h2 className="mb-2 font-semibold">Episode status</h2>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="badge-blue">
                    care thread: {statusLabel("thread", thread.careThread?.status)}
                  </span>
                  <span className="badge-amber">
                    voice visit: {statusLabel("voice", thread.voiceSession?.status)}
                  </span>
                  <span className="badge-green">
                    booking: {statusLabel("booking", thread.booking?.status)}
                  </span>
                </div>
              </div>

              {thread ? (
                <HeroVisualizationPanel
                  mode={heroMode}
                  trace={coordinatorTrace}
                  runStatus={coordinatorRun?.status}
                  stormTicks={stormTicks}
                  stormRunning={stormRunning}
                  stormCompleted={stormCompleted}
                  supervisorPath={supervisorPath}
                  supervisorConfirmDone={patientConfirmed}
                  supervisorHitlWaiting={supervisorHitlWaiting}
                />
              ) : null}

              <CoordinatorPane
                interactionId={selectedId}
                disabled={busy}
                onLog={pushLog}
                onRefresh={refresh}
                onRunChange={setCoordinatorRun}
                onTraceChange={setCoordinatorTrace}
              />

              <div
                className={`card ${walkthrough.current === 4 ? "ring-2 ring-primary ring-offset-2" : ""}`}
              >
                <h2 className="font-semibold">Step 4 — replay storm</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Fire 50 identical workflow triggers. Idempotency keys collapse them to one
                  outbound row — watch the metrics above.
                </p>
                <button className="btn mt-3" disabled={busy || !selectedId} onClick={runStorm}>
                  Run 50× replay storm
                </button>
              </div>

              {walkthrough.tier2Unlocked ? (
                <>
                  <div
                    className={`card ${walkthrough.current === 5 ? "ring-2 ring-primary ring-offset-2" : ""}`}
                  >
                    <h2 className="font-semibold">Step 5 — patient confirms YES</h2>
                    <p className="mt-1 text-sm text-slate-600">
                      Care ops supervisor routes inbound SMS to the confirm handler — care thread,
                      voice visit, and booking badges should flip to confirmed.
                    </p>
                    <button
                      className="btn mt-3"
                      disabled={busy || !selectedId || patientConfirmed}
                      onClick={() => replayInbound("YES — confirm appointment")}
                    >
                      Patient replies YES (×2 SID replay)
                    </button>
                  </div>

                  <div
                    className={`card ${walkthrough.current === 6 ? "ring-2 ring-primary ring-offset-2" : ""}`}
                  >
                    <h2 className="font-semibold">Step 6 — patient asks to reschedule</h2>
                    <p className="mt-1 text-sm text-slate-600">
                      Inbound router classifies RESCHEDULE and dispatches to the outbound
                      coordinator — review the HITL proposal in the coordinator pane above.
                    </p>
                    <button
                      className="btn mt-3"
                      disabled={busy || !selectedId || !patientConfirmed || inboundProposalReady}
                      onClick={() =>
                        replayInbound("can we move to Thursday?", { proveReplay: false })
                      }
                    >
                      Patient asks to reschedule
                    </button>
                  </div>
                </>
              ) : null}

              <div className="card">
                <h2 className="mb-2 font-semibold">Message thread</h2>
                <ul className="max-h-48 space-y-2 overflow-auto text-sm">
                  {thread.messages.length === 0 ? (
                    <li className="text-slate-500">No messages yet — approve a draft to send.</li>
                  ) : (
                    thread.messages.map((msg) => (
                      <li key={msg.id} className="rounded-md border border-border p-2">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">
                            {msg.direction === "inbound" ? "Patient" : "Outbound"}
                          </span>
                          <span className="text-xs text-slate-500">{msg.status}</span>
                        </div>
                        <p>{msg.body}</p>
                        <p className="text-xs text-slate-500">
                          {msg.source ?? "n/a"} · {msg.twilioMessageSid.slice(0, 16)}…
                        </p>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </>
          )}
        </section>
      </div>

      <div className="mt-4 space-y-4">
        <CollapsibleSection
          title="Stretch lab (Tier 2)"
          subtitle="Lifecycle trigger and delivery callback — inbound YES/reschedule live in walkthrough steps 5–6."
        >
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" disabled={busy || !selectedId} onClick={simulateVisitEnded}>
              Simulate visit ended
            </button>
            <button className="btn-secondary" disabled={busy} onClick={simulateDelivery}>
              Simulate delivery callback
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Architecture lab"
          subtitle="Manual sends, workflow orchestrator trigger, eligibility gates — implementation probes, not the hero story."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label" htmlFor="templateId">
                Template key
              </label>
              <input
                id="templateId"
                className="input"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <button className="btn flex-1" disabled={busy} onClick={() => sendSms("care_agent")}>
                Care coordinator manual send
              </button>
              <button
                className="btn-secondary flex-1"
                disabled={busy}
                onClick={() => sendSms("agent_workflow")}
              >
                Workflow orchestrator trigger
              </button>
            </div>
          </div>

          <label className="label" htmlFor="messageBody">
            Message body
          </label>
          <textarea
            id="messageBody"
            className="input min-h-20"
            value={messageBody}
            onChange={(e) => setMessageBody(e.target.value)}
          />

          <div>
            <h3 className="mb-2 text-sm font-semibold">Eligibility rules</h3>
            <ul className="space-y-2 text-sm">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-center justify-between rounded-md border border-border p-2"
                >
                  <span>
                    {rule.programId} · {rule.channel}/{rule.action}
                  </span>
                  <button className="btn-secondary" onClick={() => toggleRule(rule)}>
                    {rule.enabled ? "Disable" : "Enable"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </CollapsibleSection>

        <section className="card">
          <h2 className="mb-2 font-semibold">Activity log</h2>
          <ul className="max-h-40 space-y-1 overflow-auto font-mono text-xs text-slate-600">
            {log.length === 0 ? (
              <li className="text-slate-400">Actions appear here as you walk through the lab.</li>
            ) : (
              log.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)
            )}
          </ul>
        </section>
      </div>
    </main>
  );
}
