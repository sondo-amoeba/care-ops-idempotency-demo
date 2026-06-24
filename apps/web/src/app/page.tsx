"use client";

import { useCallback, useEffect, useState } from "react";
import {
  careOpsApi,
  type EligibilityRule,
  type InteractionSummary,
  type ThreadDetail,
} from "@/lib/api";
import { CoordinatorPane } from "@/components/CoordinatorPane";

const DEFAULT_PROGRAM = "behavioral-health-outreach";

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

  const pushLog = (line: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${line}`, ...prev].slice(0, 12));

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
    }
  }, [selectedId]);

  useEffect(() => {
    refresh().catch((err) => pushLog(`Refresh failed: ${err.message}`));
  }, [refresh]);

  async function createThread() {
    setBusy(true);
    try {
      const created = await careOpsApi.createInteraction(patientId, DEFAULT_PROGRAM);
      setSelectedId(created.id);
      pushLog(`Created interaction ${created.id.slice(0, 8)}…`);
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

  async function replayInbound() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const sid = "SM_INBOUND_DEMO_FIXED";
      const payload = {
        MessageSid: sid,
        Body: "YES — confirm appointment",
        interactionId: selectedId,
      };
      const first = await careOpsApi.replayInbound(payload);
      const second = await careOpsApi.replayInbound(payload);
      pushLog(`Inbound replay #1 duplicate=${String(first.duplicate)} confirmed=${String(first.confirmed ?? false)}`);
      pushLog(`Inbound replay #2 duplicate=${String(second.duplicate)}`);
      await refresh();
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
        `Status callback → updated=${String(res.updated)} status=delivered sid=${latestOutbound.twilioMessageSid.slice(0, 12)}…`,
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
      }
      pushLog(`Replay storm: 50 triggers, ${dupCount} blocked as duplicates`);
      await refresh();
    } finally {
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
        <p className="text-sm font-medium text-primary">Sanitized public demo</p>
        <h1 className="text-2xl font-semibold">Care-Ops SMS Idempotency Lab</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          NestJS + TypeORM + PostgreSQL + Redis API with a care-agent UI. Illustrates
          replay-safe Twilio inbound webhooks, outbound idempotency keys, eligibility
          gates, and agent-workflow triggers — patterns from private HIPAA care-ops work.
        </p>
        <p className="mt-2 text-xs text-slate-500">{metrics}</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card space-y-3 lg:col-span-1">
          <h2 className="font-semibold">Interactions</h2>
          <label className="label" htmlFor="patientId">
            Patient ID
          </label>
          <input
            id="patientId"
            className="input"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
          />
          <button className="btn w-full" disabled={busy} onClick={createThread}>
            New care thread
          </button>
          <ul className="max-h-64 space-y-2 overflow-auto text-sm">
            {interactions.map((item) => (
              <li key={item.id}>
                <button
                  className={`w-full rounded-md border px-3 py-2 text-left ${
                    selectedId === item.id ? "border-primary bg-blue-50" : "border-border"
                  }`}
                  onClick={() => setSelectedId(item.id)}
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

        <section className="card space-y-4 lg:col-span-2">
          <h2 className="font-semibold">Thread detail</h2>
          {!thread ? (
            <p className="text-sm text-slate-500">Select or create an interaction.</p>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="space-y-4">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="badge-blue">thread: {thread.careThread?.status}</span>
                <span className="badge-amber">voice: {thread.voiceSession?.status}</span>
                <span className="badge-green">booking: {thread.booking?.status}</span>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="label" htmlFor="templateId">
                    Template
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
                    Care-agent send
                  </button>
                  <button
                    className="btn-secondary flex-1"
                    disabled={busy}
                    onClick={() => sendSms("agent_workflow")}
                  >
                    Agent workflow
                  </button>
                </div>
              </div>

              <label className="label" htmlFor="messageBody">
                Message body
              </label>
              <textarea
                id="messageBody"
                className="input min-h-24"
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
              />

              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" disabled={busy} onClick={replayInbound}>
                  Replay inbound webhook
                </button>
                <button className="btn-secondary" disabled={busy} onClick={simulateDelivery}>
                  Simulate delivery callback
                </button>
                <button className="btn-secondary" disabled={busy} onClick={runStorm}>
                  50× replay storm
                </button>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold">Messages</h3>
                <ul className="max-h-48 space-y-2 overflow-auto text-sm">
                  {thread.messages.map((msg) => (
                    <li key={msg.id} className="rounded-md border border-border p-2">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{msg.direction}</span>
                        <span className="text-xs text-slate-500">{msg.status}</span>
                      </div>
                      <p>{msg.body}</p>
                      <p className="text-xs text-slate-500">
                        {msg.source ?? "n/a"} · {msg.twilioMessageSid.slice(0, 16)}…
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
              </div>

              <CoordinatorPane
                interactionId={selectedId}
                disabled={busy}
                onLog={pushLog}
                onRefresh={refresh}
              />
            </div>
          )}
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 font-semibold">Eligibility rules</h2>
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
        </section>

        <section className="card">
          <h2 className="mb-2 font-semibold">Activity log</h2>
          <ul className="max-h-48 space-y-1 overflow-auto font-mono text-xs text-slate-600">
            {log.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
