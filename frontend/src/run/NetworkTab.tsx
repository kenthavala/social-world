// Network: follow-graph at a chosen tick (edge_history), legend, node inspector.
// Edges are only the interactions the backend recorded — nothing inferred.
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphNode, GraphResponse } from "../types";
import * as api from "../api";
import { Spinner } from "../common";

interface NetNode extends GraphNode { val: number; color: string }
interface NetLink { source: string | NetNode; target: string | NetNode; weight: number }

// Canvas context can't read CSS vars — concrete hexes only here (same values as tokens.css).
const stanceColor = (v: number) =>
  v > 0.15 ? "#2EBBA8" : v < -0.15 ? "#F0883A" : "#8D99AA";
const NODE_TEXT = "rgba(232,235,239,0.85)";
const LINK_COLOR = "rgba(141,153,170,0.5)";

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

  // Focus mode: selecting a node dims everything outside its recorded neighbourhood.
  const neighbours = useMemo(() => {
    if (!sel) return null;
    const ids = new Set<string>([sel]);
    for (const e of graph?.edges ?? []) {
      if (e.src === sel) ids.add(e.dst);
      if (e.dst === sel) ids.add(e.src);
    }
    return ids;
  }, [graph, sel]);

  if (!graph) return <Spinner label="Building network…" />;
  if (graph.nodes.length === 0) {
    return (
      <div className="empty panel">
        <span className="empty-ic">
          <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <circle cx="4" cy="8" r="2" /><circle cx="12" cy="4" r="2" /><circle cx="12" cy="12" r="2" />
            <path d="M6 7l4-2M6 9l4 2" />
          </svg>
        </span>
        <p className="t-h3">No network yet</p>
        <p className="t-meta" style={{ maxWidth: 340 }}>
          The follow graph is built from relationships the engine records during the run.
          Start the simulation to seed agents and connections.
        </p>
      </div>
    );
  }

  const maxTick = ticks;
  const resetView = () => fgRef.current?.zoomToFit(400, 60);

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="panel">
        <div className="panel-head">
          <h2 className="t-h3">Follow graph</h2>
          <div className="flex items-center gap-2">
            <span className="badge">{tick === null ? "LATEST" : `TICK ${String(tick).padStart(2, "0")}`}</span>
            {tick !== null && (
              <button className="btn btn-ghost btn-sm" onClick={() => setTick(null)} title="Back to the latest state">
                Latest
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={resetView} title="Fit the graph to the view">
              <Maximize2 size={13} /> Reset view
            </button>
          </div>
        </div>
        <div className="panel-body">
          <p className="t-meta mb-3">
            Only relationships the engine actually recorded. An arrow <code className="mono">a → b</code> means
            a follows b — built from replies and engagement, never inferred from stance similarity.
            Drag to pan, scroll to zoom.
          </p>

          <div
            ref={boxRef}
            className="mb-3"
            style={{ border: "1px solid var(--line-1)", borderRadius: "var(--r-2)", overflow: "hidden", background: "var(--bg-0)" }}
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
                ctx.globalAlpha = neighbours && !neighbours.has(node.id) ? 0.16 : 1;
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
                ctx.globalAlpha = 1;
              }) as never}
              onNodeClick={((n: NetNode) => setSel((cur) => (cur === (n as GraphNode).id ? null : (n as GraphNode).id))) as never}
              linkWidth={((l: NetLink) => 0.4 + Math.max(0, l.weight) * 2.2) as never}
              linkColor={((l: NetLink) => {
                if (!neighbours) return LINK_COLOR;
                const src = typeof l.source === "object" ? (l.source as NetNode).id : l.source;
                const dst = typeof l.target === "object" ? (l.target as NetNode).id : l.target;
                return src === sel || dst === sel ? LINK_COLOR : "rgba(141,153,170,0.10)";
              }) as never}
              linkDirectionalParticles={links.length > 300 ? 0 : 2}
              linkDirectionalParticleWidth={1.2}
              width={canvasW}
              height={canvasW < 520 ? 360 : 480}
              backgroundColor="rgba(0,0,0,0)"
              onEngineStop={() => { fgRef.current?.zoomToFit(400, 60); }}
              cooldownTicks={120}
            />
          </div>

          {/* legend */}
          <div className="t-meta flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#2EBBA8" }} /> pro stance</span>
            <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#8D99AA" }} /> neutral</span>
            <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#F0883A" }} /> con stance</span>
            <span className="flex items-center gap-1.5">
              <svg width={26} height={8} aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke={LINK_COLOR} strokeWidth="1.5" /></svg>
              follows (edge weight = trust)
            </span>
            <span className="ml-auto">size = |mean stance|</span>
          </div>

          {/* tick scrubber */}
          <div className="mt-3">
            <input
              type="range"
              min={0}
              max={Math.max(1, maxTick)}
              step={1}
              value={tick ?? maxTick}
              onChange={(e) => setTick(Number(e.target.value))}
              onDoubleClick={() => setTick(null)}
              className="w-full"
              aria-label="Graph tick"
            />
            <div className="mono flex justify-between" style={{ fontSize: 10, color: "var(--fg-4)" }}>
              <span>tick 0</span>
              <span>{tick === null ? "double-click ruler → back to latest" : `state at tick ${tick}`}</span>
              <span>tick {maxTick} (latest)</span>
            </div>
          </div>
        </div>
      </div>

      {/* selection panel */}
      <div className="panel">
        <div className="panel-head">
          <h2 className="t-h3">Selected agent</h2>
          {selNode && <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)}>Clear</button>}
        </div>
        <div className="panel-body">
          {!selNode ? (
            <p className="t-meta">
              Click a node to inspect its recorded connections at this tick. Node color is the
              agent's mean stance; edge width is the recorded trust weight.
            </p>
          ) : (
            <div>
              <p style={{ fontWeight: 600 }}>{selNode.name}</p>
              <p className="t-meta mono">
                @{selNode.handle} · stance {selNode.mean_stance.toFixed(2)}
              </p>
              <div className="divider my-3" />
              <p className="eyebrow mb-1.5">Connections at {tick === null ? "latest" : `t${tick}`} — {selEdges.length}</p>
              {selEdges.length === 0 ? (
                <p className="t-meta">No recorded connections for this agent yet.</p>
              ) : (
                <ul className="m-0 flex max-h-[46vh] list-none flex-col gap-1 overflow-y-auto p-0 text-xs">
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
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function shortHandle(id: string, graph: GraphResponse): string {
  return graph.nodes.find((n) => n.id === id)?.handle ?? id.slice(0, 10);
}
