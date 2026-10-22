// Connections: recorded follows and replies, grouped when the population is large.
// Nothing is inferred from stance similarity; edges exist only where the engine
// wrote a relationship row.
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphNode, GraphResponse } from "../types";
import * as api from "../api";
import { EmptyState, Spinner } from "../common";

interface NetNode extends GraphNode {
  val: number;
  color: string;
  degree: number;
  members?: string[];
}
interface NetLink { source: string | NetNode; target: string | NetNode; weight: number }

const stanceColor = (v: number) =>
  v > 0.15 ? "#2EBBA8" : v < -0.15 ? "#F0883A" : "#8D99AA";
const NODE_TEXT = "rgba(128,137,148,0.95)";
const LINK_COLOR = "rgba(141,153,170,0.45)";

export default function NetworkTab({ runId, ticks, bumpKey, onError, roundFilter, onSelectRound }: {
  runId: string;
  ticks: number;
  bumpKey: number;
  onError: (e: unknown) => void;
  roundFilter?: number | null;
  onSelectRound?: (round: number | null) => void;
}) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<"agents" | "groups" | "matrix">("agents");
  const [canvasW, setCanvasW] = useState(840);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const viewTouched = useRef(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCanvasW(Math.max(300, el.clientWidth - 2)));
    ro.observe(el);
    setCanvasW(Math.max(300, el.clientWidth - 2));
    return () => ro.disconnect();
  }, [graph, view]);

  useEffect(() => {
    const q = roundFilter == null ? "" : `?tick=${roundFilter}`;
    api.getGraph(runId, q).then(setGraph).catch((e) => onError(e));
  }, [runId, roundFilter, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSel(null);
    const fg = fgRef.current as unknown as { d3Force?: (name: string) => { strength?: (n: number) => void; distance?: (n: number) => void } } | undefined;
    fg?.d3Force?.("charge")?.strength?.(-180);
    fg?.d3Force?.("link")?.distance?.(55);
  }, [view, graph]);

  useEffect(() => {
    if (!graph || viewTouched.current) return;
    setView(graph.nodes.length > 100 ? "matrix" : graph.nodes.length > 25 ? "groups" : "agents");
  }, [graph]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of graph?.edges ?? []) {
      d.set(e.src, (d.get(e.src) ?? 0) + 1);
      d.set(e.dst, (d.get(e.dst) ?? 0) + 1);
    }
    return d;
  }, [graph]);

  const nodes: NetNode[] = useMemo(() => (graph?.nodes ?? []).map((n) => ({
    ...n,
    val: 2 + Math.min(4, Math.abs(n.mean_stance) * 4),
    color: stanceColor(n.mean_stance),
    degree: degree.get(n.id) ?? 0,
  })), [graph, degree]);

  const links = useMemo(() => (graph?.edges ?? [])
    .filter((e) => e.weight > 0 || e.follows)
    .map((e) => ({ source: e.src, target: e.dst, weight: e.weight })), [graph]);

  const groupStats = useMemo(() => {
    const m = new Map<string, { name: string; members: string[]; sum: number; n: number }>();
    for (const n of nodes) {
      const g = n.group || "unassigned";
      const e = m.get(g) ?? { name: g, members: [], sum: 0, n: 0 };
      e.members.push(n.id);
      e.sum += n.mean_stance;
      e.n += 1;
      m.set(g, e);
    }
    return [...m.values()].sort((a, b) => b.members.length - a.members.length);
  }, [nodes]);

  const groupNodes: NetNode[] = useMemo(() => groupStats.map((g) => ({
    id: `group:${g.name}`,
    handle: g.name,
    name: g.name,
    archetype: null,
    group: g.name,
    mean_stance: g.n ? g.sum / g.n : 0,
    val: 4 + Math.log2(g.members.length + 1) * 3,
    color: stanceColor(g.n ? g.sum / g.n : 0),
    degree: g.members.length,
    members: g.members,
  })), [groupStats]);

  const groupLinks: NetLink[] = useMemo(() => {
    const m = new Map<string, { source: string; target: string; weight: number }>();
    const groupOf = new Map(nodes.map((n) => [n.id, n.group || "unassigned"]));
    for (const e of graph?.edges ?? []) {
      const a = groupOf.get(e.src);
      const b = groupOf.get(e.dst);
      if (!a || !b || a === b) continue;
      const key = `${a}|${b}`;
      const cur = m.get(key) ?? { source: `group:${a}`, target: `group:${b}`, weight: 0 };
      cur.weight += e.weight || 0.1;
      m.set(key, cur);
    }
    return [...m.values()];
  }, [graph, nodes]);

  const displayNodes = view === "groups" ? groupNodes : nodes;
  const displayLinks = view === "groups" ? groupLinks : links;
  const selNode = useMemo(() => displayNodes.find((n) => n.id === sel) ?? null, [displayNodes, sel]);
  const neighbours = useMemo(() => {
    if (!sel) return null;
    const ids = new Set<string>([sel]);
    for (const e of displayLinks) {
      const src = typeof e.source === "object" ? (e.source as NetNode).id : e.source;
      const dst = typeof e.target === "object" ? (e.target as NetNode).id : e.target;
      if (src === sel) ids.add(dst);
      if (dst === sel) ids.add(src);
    }
    return ids;
  }, [displayLinks, sel]);

  if (!graph) return <Spinner label="Building connections…" />;
  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        title="No connections yet"
        body="The graph is built from relationships the engine records during a run. Start the simulation to seed agents and connections."
      />
    );
  }

  const topFive = new Set([...nodes].sort((a, b) => b.degree - a.degree).slice(0, 5).map((n) => n.id));
  const selectedAgent = selNode && !selNode.id.startsWith("group:") ? selNode : null;
  const selectedGroup = selNode && selNode.id.startsWith("group:") ? selNode : null;
  const selectedEdges = (graph.edges ?? []).filter((e) => e.src === sel || e.dst === sel);
  const groupEdgeCount = (a: string, b: string) =>
    (graph.edges ?? []).filter((e) => {
      const ga = nodes.find((n) => n.id === e.src)?.group || "unassigned";
      const gb = nodes.find((n) => n.id === e.dst)?.group || "unassigned";
      return ga === a && gb === b;
    }).length;

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="panel">
        <div className="panel-head flex-wrap">
          <h2 className="t-h3">Connections</h2>
          <div className="flex flex-wrap items-center gap-2">
            {roundFilter != null ? (
              <span className="badge">ROUND {String(roundFilter).padStart(2, "0")}</span>
            ) : <span className="badge">LATEST</span>}
            {roundFilter != null && onSelectRound && (
              <button className="btn btn-ghost btn-sm" onClick={() => onSelectRound(null)}>Latest</button>
            )}
            {graph.nodes.length > 25 && (
              <div className="seg" role="group" aria-label="Connection view">
                <button className="seg-btn" aria-pressed={view === "groups"}
                        onClick={() => { viewTouched.current = true; setView("groups"); }}>Groups</button>
                <button className="seg-btn" aria-pressed={view === "agents"}
                        onClick={() => { viewTouched.current = true; setView("agents"); }}>Agents</button>
                <button className="seg-btn" aria-pressed={view === "matrix"}
                        onClick={() => { viewTouched.current = true; setView("matrix"); }}>Matrix</button>
              </div>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => fgRef.current?.zoomToFit(400, 60)}
                    title="Fit the graph to the view">
              <Maximize2 size={13} /> Reset view
            </button>
          </div>
        </div>
        <div className="panel-body">
          <p className="t-meta mb-3">
            Only relationships the engine recorded. Edge width is trust weight; agents are grouped
            for large populations. Nothing is inferred from stance similarity.
            {graph.nodes.length > 25 && " The group view is the default above 25 agents; the matrix is available above 100."}
          </p>

          {graph.edges.length === 0 ? (
            <div className="empty" style={{ padding: "36px 20px" }}>
              <p className="t-h3">No interactions recorded yet</p>
              <p className="t-meta" style={{ maxWidth: 380 }}>
                Connections appear once agents reply to or mention each other. The seed creates an
                initial follow graph; if it is empty, the run has not started or has no agents.
              </p>
            </div>
          ) : view === "matrix" ? (
            <Matrix groups={groupStats} count={groupEdgeCount} />
          ) : (
            <>
              <div ref={boxRef} className="mb-3"
                   style={{ border: "1px solid var(--line-1)", borderRadius: "var(--r-2)",
                            overflow: "hidden", background: "var(--bg-0)" }}>
                <ForceGraph2D
                  ref={fgRef}
                  graphData={{ nodes: displayNodes as never, links: displayLinks as never }}
                  nodeRelSize={4}
                  nodeVal={((n: NetNode) => n.val) as never}
                  nodeColor={((n: NetNode) => n.color) as never}
                  nodeLabel={((n: NetNode) => n.id.startsWith("group:")
                    ? `${n.name} — ${n.members?.length ?? 0} agents`
                    : `${n.handle ?? n.id} — stance ${n.mean_stance.toFixed(2)}`) as never}
                  nodeCanvasObjectMode={() => "replace" as never}
                  nodeCanvasObject={((node: NetNode & { x?: number; y?: number },
                                      ctx: CanvasRenderingContext2D, globalScale: number) => {
                    const isGroup = node.id.startsWith("group:");
                    const r = (isGroup ? 7 + Math.log2((node.members?.length ?? 1) + 1) * 3
                      : Math.max(4.2, 3.4 + node.val * 1.2)) / globalScale;
                    ctx.globalAlpha = neighbours && !neighbours.has(node.id) ? 0.16 : 1;
                    ctx.beginPath();
                    if (isGroup || node.mean_stance > 0.15) {
                      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
                    } else if (node.mean_stance < -0.15) {
                      ctx.moveTo(node.x ?? 0, (node.y ?? 0) - r);
                      ctx.lineTo((node.x ?? 0) + r, node.y ?? 0);
                      ctx.lineTo(node.x ?? 0, (node.y ?? 0) + r);
                      ctx.lineTo((node.x ?? 0) - r, node.y ?? 0);
                    } else {
                      ctx.rect((node.x ?? 0) - r, (node.y ?? 0) - r, r * 2, r * 2);
                    }
                    ctx.fillStyle = node.color;
                    ctx.fill();
                    if (sel === node.id) {
                      ctx.strokeStyle = "#6CA6FF";
                      ctx.lineWidth = 2 / globalScale;
                      ctx.stroke();
                    }
                    const showLabel = isGroup || graph.nodes.length <= 25 ||
                      topFive.has(node.id) || globalScale > 1.5;
                    if (showLabel) {
                      ctx.font = `600 ${(isGroup ? 12 : 10) / globalScale}px "IBM Plex Sans", sans-serif`;
                      ctx.fillStyle = NODE_TEXT;
                      ctx.textAlign = "center";
                      ctx.fillText(isGroup ? (node.name ?? "") : (node.handle ?? ""),
                                   node.x ?? 0, (node.y ?? 0) + r + (isGroup ? 14 : 12) / globalScale);
                    }
                    ctx.globalAlpha = 1;
                  }) as never}
                  onNodeClick={((n: NetNode) => {
                    setSel((cur) => (cur === n.id ? null : n.id));
                  }) as never}
                  linkWidth={((l: NetLink) => 0.6 + Math.max(0, l.weight) * 2.4) as never}
                  linkColor={((l: NetLink) => {
                    if (!neighbours) return LINK_COLOR;
                    const src = typeof l.source === "object" ? (l.source as NetNode).id : l.source;
                    const dst = typeof l.target === "object" ? (l.target as NetNode).id : l.target;
                    return src === sel || dst === sel ? LINK_COLOR : "rgba(141,153,170,0.10)";
                  }) as never}
                  linkDirectionalParticles={displayLinks.length > 300 ? 0 : 2}
                  linkDirectionalParticleWidth={1.2}
                  width={canvasW}
                  height={canvasW < 520 ? 360 : 480}
                  backgroundColor="rgba(0,0,0,0)"
                  onEngineStop={() => fgRef.current?.zoomToFit(400, 60)}
                  cooldownTicks={200}
                />
              </div>
              <div className="t-meta flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#2EBBA8" }} /> supports (circle)</span>
                <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#8D99AA" }} /> undecided (square)</span>
                <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#F0883A" }} /> opposes (diamond)</span>
                <span className="flex items-center gap-1.5">
                  <svg width={26} height={8} aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke={LINK_COLOR} strokeWidth="1.5" /></svg>
                  recorded relationship (width = trust)
                </span>
                <span className="ml-auto">{view === "groups" ? `${groupStats.length} groups` : `${nodes.length} agents`}</span>
              </div>
              <div className="mt-3">
                <input type="range" min={1} max={Math.max(1, ticks)} step={1}
                       value={roundFilter ?? Math.max(1, ticks)}
                       onChange={(e) => onSelectRound?.(Number(e.target.value))}
                       className="w-full" aria-label="Connections round" />
                <div className="mono flex justify-between" style={{ fontSize: 10, color: "var(--fg-4)" }}>
                  <span>round 01</span>
                  <span>{roundFilter == null ? "latest recorded state" : `state at round ${roundFilter}`}</span>
                  <span>round {String(ticks).padStart(2, "0")}</span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="t-h3">{selectedGroup ? "Selected group" : selectedAgent ? "Selected agent" : "Selection"}</h2>
          {selNode && <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)}>Clear</button>}
        </div>
        <div className="panel-body">
          {!selNode ? (
            <p className="t-meta">
              Click a node to inspect the connections recorded at {roundFilter == null ? "the latest state" : `round ${roundFilter}`}.
              Node shape and colour encode stance; edge width is the recorded trust weight.
            </p>
          ) : selectedGroup ? (
            <div>
              <p style={{ fontWeight: 600 }}>{selectedGroup.name}</p>
              <p className="t-meta">{selectedGroup.members?.length ?? 0} agents · mean stance {selectedGroup.mean_stance.toFixed(2)}</p>
              <div className="divider my-3" />
              <p className="eyebrow mb-1.5">Members</p>
              <ul className="m-0 flex max-h-[44vh] list-none flex-col gap-1 overflow-y-auto p-0 text-xs">
                {(selectedGroup.members ?? []).map((id) => {
                  const n = nodes.find((x) => x.id === id);
                  return (
                    <li key={id} className="panel-2 flex items-center gap-2 p-2">
                      <span className="mono min-w-0 truncate">@{n?.handle ?? id}</span>
                      <span className="ml-auto mono" style={{ color: "var(--fg-3)" }}>{n?.mean_stance.toFixed(2)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div>
              <p style={{ fontWeight: 600 }}>{selectedAgent?.name}</p>
              <p className="t-meta mono">@{selectedAgent?.handle} · stance {selectedAgent?.mean_stance.toFixed(2)}</p>
              <p className="t-meta">{selectedAgent?.group ?? "unassigned"} · {selectedAgent?.degree ?? 0} recorded relationships</p>
              <div className="divider my-3" />
              <p className="eyebrow mb-1.5">Connections at {roundFilter == null ? "latest" : `round ${roundFilter}`} — {selectedEdges.length}</p>
              {selectedEdges.length === 0 ? (
                <p className="t-meta">No recorded connections for this agent yet.</p>
              ) : (
                <ul className="m-0 flex max-h-[46vh] list-none flex-col gap-1 overflow-y-auto p-0 text-xs">
                  {selectedEdges.map((e, i) => (
                    <li key={i} className="panel-2 flex min-w-0 items-center gap-2 p-2">
                      <span className="mono flex-none" style={{ color: "var(--fg-3)" }}>
                        {e.src === sel ? "→ follows" : "← followed by"}
                      </span>
                      <span className="mono min-w-0 truncate">
                        {graph.nodes.find((n) => n.id === (e.src === sel ? e.dst : e.src))?.handle ?? "?"}
                      </span>
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

function Matrix({ groups, count }: {
  groups: { name: string; members: string[] }[];
  count: (a: string, b: string) => number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="tbl" style={{ minWidth: Math.max(420, groups.length * 78 + 160) }}>
        <thead>
          <tr>
            <th>From / to</th>
            {groups.map((g) => <th key={g.name} className="r">{g.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.name}>
              <td style={{ fontWeight: 500 }}>{g.name}</td>
              {groups.map((h) => (
                <td key={h.name} className="r mono" style={{ color: g.name === h.name ? "var(--fg-4)" : "var(--fg-1)" }}>
                  {g.name === h.name ? "—" : count(g.name, h.name)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="t-meta px-4 py-3">
        Cell values are recorded directed relationships from the row group to the column group.
        The matrix is the readable default for 100+ agents; the group graph remains available.
      </p>
    </div>
  );
}
