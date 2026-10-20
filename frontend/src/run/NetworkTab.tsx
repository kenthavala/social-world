// Network: follow-graph at a chosen tick (edge_history), legend, node inspector.
// Edges are only the interactions the backend recorded — nothing inferred.
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphNode, GraphResponse } from "../types";
import * as api from "../api";
import { Spinner } from "../common";

interface NetNode extends GraphNode { val: number; color: string }
interface NetLink { source: string | NetNode; target: string | NetNode; weight: number }

// Canvas context can't read CSS vars — concrete hexes only here.
const stanceColor = (v: number) =>
  v > 0.15 ? "#14B8A6" : v < -0.15 ? "#F59E0B" : "#8A939E";
const NODE_TEXT = "rgba(243,245,247,0.85)";

export default function NetworkTab({ runId, ticks, bumpKey, onError }: {
  runId: string;
  ticks: number;
  bumpKey: number;
  onError: (e: unknown) => void;
}) {
  const [tick, setTick] = useState<number | null>(null); // null = latest
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [canvasW, setCanvasW] = useState(840);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);

  // the canvas needs a concrete width; track the panel's real width (mobile-friendly)
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCanvasW(Math.max(300, el.clientWidth - 2)));
    ro.observe(el);
    setCanvasW(Math.max(300, el.clientWidth - 2));
    return () => ro.disconnect();
  }, [graph]);

  useEffect(() => {
    const q = tick === null ? "" : `?tick=${tick}`;
    api.getGraph(runId, q).then(setGraph).catch((e) => onError(e));
  }, [runId, tick, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const nodes = useMemo(() => (graph?.nodes ?? []).map((n) => ({
    ...n,
    val: 2 + Math.min(4, Math.abs(n.mean_stance) * 4),
    color: stanceColor(n.mean_stance),
  })), [graph]);

  const links = useMemo(() => (graph?.edges ?? [])
    .filter((e) => e.follows)
    .map((e) => ({ source: e.src, target: e.dst, weight: e.weight })), [graph]);

  const selNode = useMemo(
    () => (graph?.nodes ?? []).find((n) => n.id === sel) ?? null,
    [graph, sel]);
  const selEdges = useMemo(
    () => (graph?.edges ?? []).filter((e) => e.src === sel || e.dst === sel),
    [graph, sel]);

  if (!graph) return <Spinner label="Building network…" />;

  const maxTick = ticks;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="panel p-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h2 className="t-h2">Follow graph</h2>
          <span className="chip">{tick === null ? "LATEST" : `tick ${tick}`}</span>
        </div>

        <p className="mb-3 text-xs" style={{ color: "var(--fg-3)" }}>
          Only relationships the engine actually recorded. An arrow <code>a → b</code> means
          &nbsp;a follows b — built from replies and engagement, never inferred from stance similarity.
          Drag to pan, scroll to zoom.
        </p>

        <div
          ref={boxRef}
          className="mb-3"
          style={{ border: "1px solid var(--line-1)", borderRadius: "var(--r-2)", overflow: "hidden" }}
        >
          <ForceGraph2D
            ref={fgRef}
            graphData={{ nodes: nodes as never, links: links as never }}
            nodeRelSize={4}
            nodeVal={((n: NetNode) => n.val) as never}
            nodeColor={((n: NetNode) => n.color) as never}
            nodeLabel={((n: NetNode) => `${n.handle ?? n.id} — stance ${n.mean_stance.toFixed(2)}`) as never}
            nodeCanvasObjectMode={() => "replace" as never}
            nodeCanvasObject={((node: NetNode & { x?: number; y?: number }, ctx: CanvasRenderingContext2D, globalScale: number) => {
              const r = Math.max(2.6, 2.2 + node.val * 0.9);
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, r / globalScale, 0, 2 * Math.PI);
              ctx.fillStyle = node.color;
              ctx.fill();
              if (sel === node.id) {
                ctx.strokeStyle = "#6CA6FF";
                ctx.lineWidth = 2 / globalScale;
                ctx.stroke();
              }
              if (globalScale > 1.5) {
                ctx.font = `${4.5 / globalScale}px IBM Plex Mono`;
                ctx.fillStyle = NODE_TEXT;
                ctx.textAlign = "center";
                ctx.fillText(node.handle ?? "", node.x ?? 0, (node.y ?? 0) + r / globalScale + 5 / globalScale);
              }
            }) as never}
            onNodeClick={((n: NetNode) => setSel((cur) => (cur === (n as GraphNode).id ? null : (n as GraphNode).id))) as never}
            linkWidth={((l: NetLink) => 0.4 + Math.max(0, l.weight) * 2.2) as never}
            linkColor={() => "rgba(138,147,158,0.5)"}
            linkDirectionalParticles={2}
            linkDirectionalParticleWidth={1.2}
            width={canvasW}
            height={480}
            backgroundColor="rgba(0,0,0,0)"
            onEngineStop={() => { fgRef.current?.zoomToFit(400, 60); }}
            cooldownTicks={120}
          />
        </div>

        {/* legend */}
        <div className="flex flex-wrap items-center gap-3 text-xs" style={{ color: "var(--fg-3)" }}>
          <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "var(--pro)" }} /> pro stance</span>
          <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "var(--neu)" }} /> neutral</span>
          <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "var(--con)" }} /> con stance</span>
          <span className="flex items-center gap-1.5">
            <svg width={26} height={8} aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="rgba(138,147,158,0.7)" strokeWidth="1.5" /></svg>
            follows (edge weight = trust)
          </span>
          <span className="ml-auto">size = |mean stance|</span>
        </div>

        {/* tick ruler */}
        <div className="mt-3">
          <input
            type="range"
            min={0}
            max={maxTick}
            step={1}
            value={tick ?? maxTick}
            onChange={(e) => setTick(Number(e.target.value))}
            onDoubleClick={() => setTick(null)}
            className="w-full"
            style={{ accentColor: "var(--ac)" }}
            aria-label="Graph tick"
          />
          <div className="mono flex justify-between text-[10px]" style={{ color: "var(--fg-4)" }}>
            <span>tick 0</span>
            <span>{tick === null ? "double-click ruler → back to latest" : `state at tick ${tick}`}</span>
            <span>tick {maxTick} (latest)</span>
          </div>
        </div>
      </div>

      {/* selection panel */}
      <div className="panel p-4">
        <h2 className="eyebrow mb-2">Selected agent</h2>
        {!selNode ? (
          <p className="text-sm" style={{ color: "var(--fg-3)" }}>
            Click a node to inspect its recorded connections at this tick.
          </p>
        ) : (
          <div className="text-sm">
            <p style={{ fontWeight: 600 }}>{selNode.name}</p>
            <p className="mono text-xs" style={{ color: "var(--fg-3)" }}>
              @{selNode.handle} · stance {selNode.mean_stance.toFixed(2)}
            </p>
            <div className="divider my-3" />
            <p className="eyebrow mb-1.5">Connections at {tick === null ? "latest" : `t${tick}`} — {selEdges.length}</p>
            <ul className="flex max-h-[46vh] flex-col gap-1 overflow-y-auto text-xs">
              {selEdges.map((e, i) => (
                <li key={i} className="panel-2 flex min-w-0 items-center gap-2 p-2">
                  <span className="mono flex-none" style={{ color: "var(--fg-3)" }}>
                    {e.src === sel ? "→ follows" : "← followed by"}
                  </span>
                  <span className="mono min-w-0 truncate">{e.src === sel ? shortHandle(e.dst, graph) : shortHandle(e.src, graph)}</span>
                  <span className="num flex-none" style={{ color: "var(--fg-4)" }}>
                    w {e.weight.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function shortHandle(id: string, graph: GraphResponse): string {
  return graph.nodes.find((n) => n.id === id)?.handle ?? id.slice(0, 10);
}
