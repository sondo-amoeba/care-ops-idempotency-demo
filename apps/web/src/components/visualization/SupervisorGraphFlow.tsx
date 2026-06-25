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
import type { GraphNodeState } from "@/lib/trace-label";

export type SupervisorPath = "idle" | "inbound_confirm" | "inbound_reschedule";

type PhaseNodeData = {
  label: string;
  subtitle?: string;
  state: GraphNodeState;
  kind: "phase" | "tool" | "terminal" | "subgraph";
};

function nodeShell(state: GraphNodeState, kind: PhaseNodeData["kind"]): string {
  const base =
    kind === "subgraph"
      ? "rounded-xl border-2 border-dashed px-3 py-2 text-[10px] font-semibold min-w-[130px] text-center transition-all duration-500"
      : kind === "tool"
        ? "rounded-lg border px-2 py-1.5 text-[10px] font-medium min-w-[100px] text-center transition-all duration-500"
        : "rounded-xl border-2 px-3 py-2 text-[11px] font-semibold min-w-[90px] text-center transition-all duration-500";

  switch (state) {
    case "active":
      return `${base} border-sky-400 bg-sky-950/80 text-sky-100 shadow-[0_0_20px_rgba(56,189,248,0.4)]`;
    case "hitl":
      return `${base} border-amber-400 bg-amber-950/70 text-amber-100 shadow-[0_0_24px_rgba(251,191,36,0.45)] animate-pulse`;
    case "done":
      return `${base} border-emerald-600/70 bg-emerald-950/50 text-emerald-200 opacity-90`;
    default:
      return `${base} border-slate-600 bg-slate-900/40 text-slate-500 opacity-55`;
  }
}

function PhaseNode({ data }: NodeProps<Node<PhaseNodeData>>) {
  return (
    <div className={nodeShell(data.state, data.kind)}>
      <Handle type="target" position={Position.Top} className="!bg-slate-500 !w-2 !h-2" />
      <Handle
        type="target"
        position={Position.Right}
        id="right-in"
        className="!bg-slate-500 !w-2 !h-2"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left-in"
        className="!bg-slate-500 !w-2 !h-2"
      />
      <div>{data.label}</div>
      {data.subtitle ? (
        <div className="mt-0.5 text-[9px] font-normal opacity-80">{data.subtitle}</div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500 !w-2 !h-2" />
      <Handle
        type="source"
        position={Position.Left}
        id="left-out"
        className="!bg-slate-500 !w-2 !h-2"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right-out"
        className="!bg-slate-500 !w-2 !h-2"
      />
    </div>
  );
}

const nodeTypes = { phase: PhaseNode };

function deriveSupervisorStates(
  path: SupervisorPath,
  confirmDone: boolean,
  hitlWaiting: boolean,
): Record<string, GraphNodeState> {
  const idle = (id: string): GraphNodeState => {
    void id;
    return "idle";
  };
  const states: Record<string, GraphNodeState> = {
    supervisor: "idle",
    outbound_coordinator: "idle",
    inbound_router: "idle",
    classify_intent: "idle",
    confirm_handler: "idle",
    status_update: "idle",
    coordinator_propose: "idle",
    await_approval: "idle",
  };

  if (path === "idle") return states;

  states.supervisor = confirmDone || hitlWaiting ? "done" : "active";
  states.inbound_router = path.startsWith("inbound") ? (confirmDone || hitlWaiting ? "done" : "active") : idle("inbound_router");
  states.outbound_coordinator =
    path === "inbound_reschedule" && hitlWaiting ? "done" : "idle";

  if (path === "inbound_confirm") {
    if (confirmDone) {
      for (const id of ["classify_intent", "confirm_handler", "status_update"]) {
        states[id] = "done";
      }
    } else {
      states.classify_intent = "active";
    }
    return states;
  }

  if (path === "inbound_reschedule") {
    if (hitlWaiting) {
      states.classify_intent = "done";
      states.coordinator_propose = "done";
      states.await_approval = "hitl";
    } else {
      states.classify_intent = "active";
    }
  }

  return states;
}

function buildNodes(states: Record<string, GraphNodeState>): Node<PhaseNodeData>[] {
  const n = (
    id: string,
    label: string,
    x: number,
    y: number,
    kind: PhaseNodeData["kind"],
    subtitle?: string,
  ) => ({
    id,
    type: "phase",
    position: { x, y },
    data: { label, subtitle, state: states[id] ?? "idle", kind },
    draggable: false,
    selectable: false,
  });

  return [
    n("supervisor", "care ops supervisor", 320, 0, "phase", "deterministic router"),
    n("outbound_coordinator", "outbound coordinator", 80, 100, "subgraph", "steps 2–3"),
    n("inbound_router", "inbound router", 520, 100, "subgraph", "steps 5–6"),
    n("classify_intent", "classify intent", 520, 200, "phase"),
    n("confirm_handler", "confirm handler", 340, 300, "phase", "CONFIRM"),
    n("status_update", "status badges", 340, 400, "terminal", "thread · voice · booking"),
    n("coordinator_propose", "propose SMS", 700, 300, "phase", "RESCHEDULE"),
    n("await_approval", "await approval", 700, 400, "phase", "HITL gate"),
  ];
}

const STATIC_EDGES: Edge[] = [
  {
    id: "e-sup-out",
    source: "supervisor",
    sourceHandle: "left-out",
    target: "outbound_coordinator",
    targetHandle: "right-in",
    markerEnd: { type: MarkerType.ArrowClosed },
  },
  {
    id: "e-sup-in",
    source: "supervisor",
    sourceHandle: "right-out",
    target: "inbound_router",
    targetHandle: "left-in",
    markerEnd: { type: MarkerType.ArrowClosed },
  },
  { id: "e-in-class", source: "inbound_router", target: "classify_intent", markerEnd: { type: MarkerType.ArrowClosed } },
  {
    id: "e-class-confirm",
    source: "classify_intent",
    target: "confirm_handler",
    markerEnd: { type: MarkerType.ArrowClosed },
  },
  {
    id: "e-confirm-status",
    source: "confirm_handler",
    target: "status_update",
    markerEnd: { type: MarkerType.ArrowClosed },
  },
  {
    id: "e-class-propose",
    source: "classify_intent",
    target: "coordinator_propose",
    markerEnd: { type: MarkerType.ArrowClosed },
  },
  {
    id: "e-propose-hitl",
    source: "coordinator_propose",
    target: "await_approval",
    markerEnd: { type: MarkerType.ArrowClosed },
  },
];

type SupervisorGraphFlowProps = {
  path: SupervisorPath;
  confirmDone: boolean;
  hitlWaiting: boolean;
};

export function SupervisorGraphFlow({ path, confirmDone, hitlWaiting }: SupervisorGraphFlowProps) {
  const states = useMemo(
    () => deriveSupervisorStates(path, confirmDone, hitlWaiting),
    [path, confirmDone, hitlWaiting],
  );
  const graphNodes = useMemo(() => buildNodes(states), [states]);

  const activeEdgeIds = useMemo(() => {
    const active = new Set<string>();
    if (path === "inbound_confirm") {
      active.add("e-sup-in");
      active.add("e-in-class");
      active.add("e-class-confirm");
      if (confirmDone) active.add("e-confirm-status");
    }
    if (path === "inbound_reschedule") {
      active.add("e-sup-in");
      active.add("e-in-class");
      active.add("e-class-propose");
      if (hitlWaiting) active.add("e-propose-hitl");
    }
    return active;
  }, [path, confirmDone, hitlWaiting]);

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
    <div className="h-[340px] w-full">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
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
