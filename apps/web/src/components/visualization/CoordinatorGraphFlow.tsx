"use client";

import { useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CoordinatorTraceEvent } from "@/lib/api";
import { deriveNodeStates, type GraphNodeState } from "@/lib/trace-label";

type PhaseNodeData = {
  label: string;
  subtitle?: string;
  state: GraphNodeState;
  kind: "phase" | "tool" | "terminal";
};

function nodeShell(state: GraphNodeState, kind: PhaseNodeData["kind"]): string {
  const base =
    kind === "tool"
      ? "rounded-lg border px-3 py-2 text-[10px] font-medium min-w-[120px] text-center transition-all duration-500"
      : "rounded-xl border-2 px-4 py-3 text-xs font-semibold min-w-[100px] text-center transition-all duration-500";

  switch (state) {
    case "active":
      return `${base} border-sky-400 bg-sky-950/80 text-sky-100 shadow-[0_0_24px_rgba(56,189,248,0.45)] scale-105`;
    case "hitl":
      return `${base} border-amber-400 bg-amber-950/70 text-amber-100 shadow-[0_0_28px_rgba(251,191,36,0.5)] animate-pulse`;
    case "done":
      return `${base} border-emerald-600/70 bg-emerald-950/50 text-emerald-200 opacity-90`;
    default:
      return `${base} border-slate-600 bg-slate-900/40 text-slate-500 opacity-60`;
  }
}

function PhaseNode({ data }: NodeProps<Node<PhaseNodeData>>) {
  return (
    <div className={nodeShell(data.state, data.kind)}>
      <Handle type="target" position={Position.Left} className="!bg-slate-500 !w-2 !h-2" />
      <div>{data.label}</div>
      {data.subtitle ? <div className="mt-0.5 text-[9px] font-normal opacity-80">{data.subtitle}</div> : null}
      <Handle type="source" position={Position.Right} className="!bg-slate-500 !w-2 !h-2" />
    </div>
  );
}

const nodeTypes = { phase: PhaseNode };

function buildGraphNodes(states: Record<string, GraphNodeState>): Node<PhaseNodeData>[] {
  const n = (id: string, label: string, x: number, y: number, kind: PhaseNodeData["kind"], subtitle?: string) => ({
    id,
    type: "phase",
    position: { x, y },
    data: { label, subtitle, state: states[id] ?? "idle", kind },
    draggable: false,
    selectable: false,
  });

  return [
    n("observe", "observe", 0, 160, "phase"),
    n("retrieve_care_context", "retrieve_care_context", 80, 40, "tool", "RAG"),
    n("check_eligibility", "check_eligibility", 180, 280, "tool"),
    n("plan", "plan", 200, 160, "phase"),
    n("propose", "propose", 400, 160, "phase"),
    n("await_approval", "await approval", 580, 160, "phase", "HITL gate"),
    n("execute", "execute", 780, 160, "phase"),
    n("send_outbound_sms", "send_outbound_sms", 860, 40, "tool", "idempotent"),
    n("audit", "audit", 980, 160, "phase"),
    n("complete", "complete", 1160, 160, "terminal"),
  ];
}

const STATIC_EDGES: Edge[] = [
  { id: "e-obs-plan", source: "observe", target: "plan", animated: false, markerEnd: { type: MarkerType.ArrowClosed } },
  { id: "e-plan-prop", source: "plan", target: "propose", markerEnd: { type: MarkerType.ArrowClosed } },
  { id: "e-prop-wait", source: "propose", target: "await_approval", markerEnd: { type: MarkerType.ArrowClosed } },
  { id: "e-wait-exec", source: "await_approval", target: "execute", markerEnd: { type: MarkerType.ArrowClosed } },
  { id: "e-exec-audit", source: "execute", target: "audit", markerEnd: { type: MarkerType.ArrowClosed } },
  { id: "e-audit-done", source: "audit", target: "complete", markerEnd: { type: MarkerType.ArrowClosed } },
  { id: "e-obs-rag", source: "observe", target: "retrieve_care_context", style: { strokeDasharray: "4 4" } },
  { id: "e-plan-elig", source: "plan", target: "check_eligibility", style: { strokeDasharray: "4 4" } },
  { id: "e-exec-send", source: "execute", target: "send_outbound_sms", style: { strokeDasharray: "4 4" } },
];

type CoordinatorGraphFlowProps = {
  trace: CoordinatorTraceEvent[];
  runStatus?: string | null;
};

export function CoordinatorGraphFlow({ trace, runStatus }: CoordinatorGraphFlowProps) {
  const states = useMemo(() => deriveNodeStates(trace, runStatus), [trace, runStatus]);
  const graphNodes = useMemo(() => buildGraphNodes(states), [states]);

  const activeEdgeIds = useMemo(() => {
    const active = new Set<string>();
    const names = trace.map((e) => e.name);
    if (names.includes("observe")) active.add("e-obs-plan");
    if (names.includes("plan")) active.add("e-plan-prop");
    if (names.includes("propose")) active.add("e-prop-wait");
    if (names.includes("await_approval")) active.add("e-wait-exec");
    if (names.includes("execute")) active.add("e-exec-audit");
    if (names.includes("audit")) active.add("e-audit-done");
    if (names.includes("retrieve_care_context")) active.add("e-obs-rag");
    if (names.includes("check_eligibility")) active.add("e-plan-elig");
    if (names.includes("send_outbound_sms")) active.add("e-exec-send");
    return active;
  }, [trace]);

  const edges = useMemo(
    () =>
      STATIC_EDGES.map((edge) => ({
        ...edge,
        animated: activeEdgeIds.has(edge.id),
        style: {
          ...edge.style,
          stroke: activeEdgeIds.has(edge.id) ? "#38bdf8" : "#475569",
          strokeWidth: activeEdgeIds.has(edge.id) ? 2 : 1,
        },
      })),
    [activeEdgeIds],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(graphNodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(edges);

  useEffect(() => {
    setNodes(graphNodes);
  }, [graphNodes, setNodes]);

  useEffect(() => {
    setFlowEdges(edges);
  }, [edges, setFlowEdges]);

  return (
    <div className="h-[300px] w-full">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#334155" />
      </ReactFlow>
    </div>
  );
}
