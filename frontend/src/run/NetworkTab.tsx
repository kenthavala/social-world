// Connections: a selectable view of the relationships the engine recorded.
//
// The graph is never the only way to reach an entity: a synchronized list beside it
// offers the same agents and groups as buttons, so selection works without precise
// clicking on a canvas and without a mouse. Nothing here is inferred from stance
// similarity — an edge exists only where the engine wrote a relationship row.
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus, Search, X } from "lucide-react";
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

type Selection =
  | { kind: "agent"; id: string }
  | { kind: "group"; name: string }
  | { kind: "edge"; src: string; dst: string }
  | null;

const stanceColor = (v: number) =>
  v > 0.15 ? "#2EBBA8" : v < -0.15 ? "#F0883A" : "#8D99AA";
// Canvas fills can be vivid; text must use the accessible -fg tokens, which are
// tuned per theme (the raw stance hexes fail 4.5:1 on the light background).
const stanceTextColor = (v: number) =>
  v > 0.15 ? "var(--pro-fg)" : v < -0.15 ? "var(--con-fg)" : "var(--fg-2)";
const NODE_TEXT = "rgba(128,137,148,0.95)";
const LINK_COLOR = "rgba(141,153,170,0.45)";

const linkEnds = (l: NetLink): [string, string] => [
  typeof l.source === "object" ? (l.source as NetNode).id : l.source,
  typeof l.target === "object" ? (l.target as NetNode).id : l.target,
];

export default function NetworkTab({ runId, ticks, bumpKey, onError, roundFilter, onSelectRound }: {
  runId: string;
  ticks: number;
  bumpKey: number;
  onError: (e: unknown) => void;
  roundFilter?: number | null;
  onSelectRound?: (round: number | null) => void;
}) {
  // Selection is user intent, so it must survive a tab switch (which unmounts and
  // remounts this component). Stored per run, restored on mount, cleared only when
  // the entity genuinely no longer exists at the selected round.
  const SEL_KEY = `tsw-net-sel-${runId}`;
  const PICK_KEY = `tsw-net-picked-${runId}`;
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [sel, setSel] = useState<Selection>(() => {
    try { return JSON.parse(sessionStorage.getItem(SEL_KEY) || "null") as Selection; }
    catch { return null; }
  });
  const [picked, setPicked] = useState<string[]>(() => {
    try {
      const v = JSON.parse(sessionStorage.getItem(PICK_KEY) || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { sessionStorage.setItem(SEL_KEY, JSON.stringify(sel)); } catch { /* ignore */ }
  }, [sel, SEL_KEY]);
  useEffect(() => {
    try { sessionStorage.setItem(PICK_KEY, JSON.stringify(picked)); } catch { /* ignore */ }
  }, [picked, PICK_KEY]);
  const [view, setView] = useState<"agents" | "groups" | "matrix">("agents");
  const [panel, setPanel] = useState<"detail" | "list">("list");
  const [query, setQuery] = useState("");
  const [stanceFilter, setStanceFilter] = useState<"all" | "pro" | "con" | "neu">("all");
  const [linkFilter, setLinkFilter] = useState<"all" | "strong" | "weak">("all");
  const [scope, setScope] = useState<"all" | "same" | "cross">("all");
  const [canvasW, setCanvasW] = useState(840);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const viewTouched = useRef(false);
  const fitted = useRef(false);

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
    fitted.current = false;
    api.getGraph(runId, q).then(setGraph).catch((e) => onError(e));
  }, [runId, roundFilter, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Force layout tuning. NOTE: this must NOT clear the selection — the previous
  // implementation did, which made selection appear to vanish at random whenever
  // the graph refreshed.
  useEffect(() => {
    const fg = fgRef.current as unknown as {
      d3Force?: (name: string) => {
        strength?: (n: number) => void; distance?: (n: number) => void;
      };
    } | undefined;
    fg?.d3Force?.("charge")?.strength?.(-180);
    fg?.d3Force?.("link")?.distance?.(55);
  }, [view, graph]);

  useEffect(() => {
    if (!graph || viewTouched.current) return;
    setView(graph.nodes.length > 100 ? "matrix" : graph.nodes.length > 25 ? "groups" : "agents");
  }, [graph]);

  // Fit again after the canvas has its final width: the first fit can run before
  // the ResizeObserver has applied the real dimensions, which left the graph
  // bunched into a corner of an oversized canvas.
  useEffect(() => {
    if (!graph || view === "matrix") return;
    const t = window.setTimeout(() => fit(), 900);
    return () => window.clearTimeout(t);
  }, [graph, canvasW, view]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const groupOf = useMemo(
    () => new Map(nodes.map((n) => [n.id, n.group || "unassigned"])),
    [nodes]);

  const links = useMemo(() => {
    let rows = (graph?.edges ?? []).filter((e) => e.weight > 0 || e.follows);
    if (linkFilter === "strong") rows = rows.filter((e) => e.weight >= 0.5);
    if (linkFilter === "weak") rows = rows.filter((e) => e.weight < 0.5);
    if (scope !== "all") {
      rows = rows.filter((e) => {
        const same = groupOf.get(e.src) === groupOf.get(e.dst);
        return scope === "same" ? same : !same;
      });
    }
    return rows.map((e) => ({ source: e.src, target: e.dst, weight: e.weight }));
  }, [graph, linkFilter, scope, groupOf]);

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
    for (const e of links) {
      const [s, t] = linkEnds(e);
      const a = groupOf.get(s);
      const b = groupOf.get(t);
      if (!a || !b || a === b) continue;
      const key = `${a}|${b}`;
      const cur = m.get(key) ?? { source: `group:${a}`, target: `group:${b}`, weight: 0 };
      cur.weight += e.weight || 0.1;
      m.set(key, cur);
    }
    return [...m.values()];
  }, [links, groupOf]);

  // Stance + search filtering applies to the list; the graph dims non-matches.
  const visibleAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes.filter((n) => {
      if (stanceFilter === "pro" && n.mean_stance <= 0.15) return false;
      if (stanceFilter === "con" && n.mean_stance >= -0.15) return false;
      if (stanceFilter === "neu" && Math.abs(n.mean_stance) >= 0.15) return false;
      if (!q) return true;
      return `${n.handle ?? ""} ${n.name ?? ""} ${n.group ?? ""}`.toLowerCase().includes(q);
    }).sort((a, b) => b.degree - a.degree);
  }, [nodes, stanceFilter, query]);

  const matchIds = useMemo(() => new Set(visibleAgents.map((n) => n.id)), [visibleAgents]);

  const displayNodes = view === "groups" ? groupNodes : nodes;
  const displayLinks = view === "groups" ? groupLinks : links;

  // Selection is resolved against the CURRENT data; it is only dropped when the
  // selected entity no longer exists (e.g. the round slider moved past it).
  useEffect(() => {
    if (!sel) return;
    if (sel.kind === "agent" && !nodes.some((n) => n.id === sel.id)) setSel(null);
    if (sel.kind === "group" && !groupStats.some((g) => g.name === sel.name)) setSel(null);
    if (sel.kind === "edge") {
      const exists = (graph?.edges ?? []).some(
        (e) => e.src === sel.src && e.dst === sel.dst);
      if (!exists) setSel(null);
    }
  }, [nodes, groupStats, graph, sel]);

  const selAgent = sel?.kind === "agent" ? nodes.find((n) => n.id === sel.id) ?? null : null;
  const selGroup = sel?.kind === "group"
    ? groupStats.find((g) => g.name === sel.name) ?? null : null;
  const selEdge = sel?.kind === "edge"
    ? (graph?.edges ?? []).find((e) => e.src === sel.src && e.dst === sel.dst) ?? null : null;

  const neighbours = useMemo(() => {
    if (!sel || sel.kind === "edge") return null;
    const focus = sel.kind === "agent" ? sel.id : `group:${sel.name}`;
    const ids = new Set<string>([focus]);
    for (const e of displayLinks) {
      const [s, t] = linkEnds(e);
      if (s === focus) ids.add(t);
      if (t === focus) ids.add(s);
    }
    return ids;
  }, [displayLinks, sel]);

  const agentEdges = useMemo(
    () => (sel?.kind === "agent"
      ? (graph?.edges ?? []).filter((e) => e.src === sel.id || e.dst === sel.id)
      : []),
    [graph, sel]);

  function fit() {
    fgRef.current?.zoomToFit(400, 60);
  }

  function pick(id: string) {
    // Ticking is a comparison gesture: keep the list visible so a second agent can
    // be ticked. The list offers an explicit "Compare" control once two are chosen.
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    setPicked(next);
    setSel({ kind: "agent", id });
  }

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
  const pickedAgents = nodes.filter((n) => picked.includes(n.id));

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------- toolbar ---------------- */}
      <div className="panel">
        <div className="panel-head flex-wrap gap-2">
          <h2 className="t-h3">Connections</h2>
          <div className="flex flex-wrap items-center gap-2">
            {roundFilter != null
              ? <span className="badge">ROUND {String(roundFilter).padStart(2, "0")}</span>
              : <span className="badge">LATEST</span>}
            {roundFilter != null && onSelectRound && (
              <button className="btn btn-ghost btn-sm" onClick={() => onSelectRound(null)}>Latest</button>
            )}
            {graph.nodes.length > 25 && (
              <div className="seg" role="group" aria-label="Connection view">
                {(["groups", "agents", "matrix"] as const).map((v) => (
                  <button key={v} className="seg-btn" aria-pressed={view === v}
                          onClick={() => { viewTouched.current = true; setView(v); }}>
                    {v[0].toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
            )}
            <button className="btn btn-ghost btn-sm" onClick={fit} title="Fit the graph to the view">
              <Maximize2 size={13} /> Fit
            </button>
            {sel && (
              <button className="btn btn-ghost btn-sm" onClick={() => { setSel(null); setPicked([]); }}>
                <X size={13} /> Clear selection
              </button>
            )}
          </div>
        </div>
        <div className="panel-body">
          <div className="flex flex-wrap items-end gap-3">
            <label className="field" style={{ minWidth: 200, flex: "1 1 200px" }}>
              <span className="label">Search agents or groups</span>
              <span className="flex items-center gap-2">
                <Search size={14} style={{ color: "var(--fg-3)" }} />
                <input className="input" value={query} placeholder="name, handle or group…"
                       onChange={(e) => setQuery(e.target.value)} />
              </span>
            </label>
            <label className="field">
              <span className="label">Stance</span>
              <select className="input" value={stanceFilter}
                      onChange={(e) => setStanceFilter(e.target.value as typeof stanceFilter)}>
                <option value="all">All</option>
                <option value="pro">Support</option>
                <option value="neu">Undecided</option>
                <option value="con">Oppose</option>
              </select>
            </label>
            <label className="field">
              <span className="label">Relationship</span>
              <select className="input" value={linkFilter}
                      onChange={(e) => setLinkFilter(e.target.value as typeof linkFilter)}>
                <option value="all">All</option>
                <option value="strong">Strong (≥ 0.5)</option>
                <option value="weak">Weak (&lt; 0.5)</option>
              </select>
            </label>
            <label className="field">
              <span className="label">Group scope</span>
              <select className="input" value={scope}
                      onChange={(e) => setScope(e.target.value as typeof scope)}>
                <option value="all">All</option>
                <option value="same">Same group</option>
                <option value="cross">Cross group</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      {/* ---------------- graph + panel ---------------- */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* On small screens the list and detail panel come first: the canvas is a
            large, imprecise target and should not push the accessible controls
            below the fold. */}
        <div className="order-2 panel lg:order-1">
          <div className="panel-head flex-wrap">
            <h3 className="t-h4">
              {view === "groups" ? "Stakeholder group network" : "Agent network"}
            </h3>
            <div className="flex items-center gap-1">
              <button className="btn btn-ghost btn-icon btn-sm" aria-label="Zoom in"
                      onClick={() => fgRef.current?.zoom((fgRef.current?.zoom?.() ?? 1) * 1.3, 300)}>
                <Plus size={13} />
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" aria-label="Zoom out"
                      onClick={() => fgRef.current?.zoom((fgRef.current?.zoom?.() ?? 1) / 1.3, 300)}>
                <Minus size={13} />
              </button>
              <button className="btn btn-ghost btn-sm" onClick={fit} aria-label="Fit graph">Fit</button>
            </div>
          </div>
          <div className="panel-body">
            {view === "matrix" ? (
              <Matrix groups={groupStats} edges={graph.edges ?? []} groupOf={groupOf} />
            ) : graph.edges.length === 0 ? (
              <div className="empty" style={{ padding: "36px 20px" }}>
                <p className="t-h3">No interactions recorded yet</p>
                <p className="t-meta" style={{ maxWidth: 380 }}>
                  Connections appear once agents reply to or mention each other. The seed creates an
                  initial follow graph; if it is empty, the run has not started or has no agents.
                </p>
              </div>
            ) : (
              <>
                <div ref={boxRef}
                     style={{ border: "1px solid var(--line-1)", borderRadius: "var(--r-2)",
                              overflow: "hidden", background: "var(--bg-0)" }}>
                  <ForceGraph2D
                    ref={fgRef}
                    graphData={{ nodes: displayNodes as never, links: displayLinks as never }}
                    nodeRelSize={4}
                    nodeVal={((n: NetNode) => n.val) as never}
                    nodeColor={((n: NetNode) => n.color) as never}
                    nodeLabel={((n: NetNode) => n.id.startsWith("group:")
                      ? `${n.name} — ${n.members?.length ?? 0} agents · stance ${n.mean_stance.toFixed(2)}`
                      : `${n.handle ?? n.id} — ${n.group} · stance ${n.mean_stance.toFixed(2)}`) as never}
                    nodeCanvasObjectMode={() => "replace" as never}
                    nodeCanvasObject={((node: NetNode & { x?: number; y?: number },
                                        ctx: CanvasRenderingContext2D, globalScale: number) => {
                      const isGroup = node.id.startsWith("group:");
                      const r = (isGroup ? 7 + Math.log2((node.members?.length ?? 1) + 1) * 3
                        : Math.max(4.2, 3.4 + node.val * 1.2)) / globalScale;
                      const dimmed = (neighbours && !neighbours.has(node.id))
                        || (query.trim() && !isGroup && !matchIds.has(node.id));
                      ctx.globalAlpha = dimmed ? 0.14 : 1;
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
                      const isSel = (sel?.kind === "agent" && sel.id === node.id)
                        || (sel?.kind === "group" && sel.name === node.group && isGroup);
                      if (isSel || picked.includes(node.id)) {
                        ctx.strokeStyle = "#6CA6FF";
                        ctx.lineWidth = 2.5 / globalScale;
                        ctx.stroke();
                      }
                      const showLabel = isGroup || graph.nodes.length <= 25 ||
                        topFive.has(node.id) || globalScale > 1.5 || picked.includes(node.id);
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
                      if (n.id.startsWith("group:")) {
                        setSel({ kind: "group", name: n.name ?? "" });
                        setPanel("detail");
                      } else {
                        setSel({ kind: "agent", id: n.id });
                        setPanel("detail");
                      }
                    }) as never}
                    onLinkClick={((l: NetLink) => {
                      const [s, t] = linkEnds(l);
                      setSel({ kind: "edge", src: s, dst: t });
                      setPanel("detail");
                    }) as never}
                    onBackgroundClick={() => { setSel(null); }}
                    linkWidth={((l: NetLink) => {
                      const [s, t] = linkEnds(l);
                      const active = sel?.kind === "agent" && (s === sel.id || t === sel.id);
                      return (active ? 2.2 : 0.6) + Math.max(0, l.weight) * 2.4;
                    }) as never}
                    linkColor={((l: NetLink) => {
                      const [s, t] = linkEnds(l);
                      if (sel?.kind === "edge") {
                        return (sel.src === s && sel.dst === t) ? "#6CA6FF" : "rgba(141,153,170,0.12)";
                      }
                      if (!neighbours) return LINK_COLOR;
                      return neighbours.has(s) && neighbours.has(t) ? LINK_COLOR : "rgba(141,153,170,0.10)";
                    }) as never}
                    linkDirectionalParticles={displayLinks.length > 300 ? 0 : 2}
                    linkDirectionalParticleWidth={1.2}
                    width={canvasW}
                    height={canvasW < 520 ? 380 : 520}
                    backgroundColor="rgba(0,0,0,0)"
                    onEngineStop={() => {
                      // Re-fit once the layout settles so nodes use the canvas
                      // instead of clustering in a corner.
                      if (!fitted.current) { fitted.current = true; fit(); }
                    }}
                    cooldownTicks={200}
                  />
                </div>
                <div className="t-meta mt-2 flex flex-wrap items-center gap-3">
                  <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#2EBBA8" }} /> supports (circle)</span>
                  <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#8D99AA" }} /> undecided (square)</span>
                  <span className="flex items-center gap-1.5"><span className="dot" style={{ background: "#F0883A" }} /> opposes (diamond)</span>
                  <span className="ml-auto">
                    {view === "groups" ? `${groupStats.length} groups` : `${nodes.length} agents`}
                    {" · "}{links.length} relationship{links.length === 1 ? "" : "s"} shown
                  </span>
                </div>
                <div className="mt-3">
                  <input type="range" min={1} max={Math.max(1, ticks)} step={1}
                         value={roundFilter ?? Math.max(1, ticks)}
                         onChange={(e) => onSelectRound?.(Number(e.target.value))}
                         className="w-full" aria-label="Connections round" />
                  <div className="mono flex justify-between" style={{ fontSize: 10, color: "var(--fg-3)" }}>
                    <span>round 01</span>
                    <span>{roundFilter == null ? "latest recorded state" : `state at round ${roundFilter}`}</span>
                    <span>round {String(ticks).padStart(2, "0")}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ---------------- side panel ---------------- */}
        <div className="order-1 panel lg:order-2">
          <div className="panel-head flex-wrap">
            <div className="seg" role="group" aria-label="Panel">
              <button className="seg-btn" aria-pressed={panel === "list"} onClick={() => setPanel("list")}>
                List
              </button>
              <button className="seg-btn" aria-pressed={panel === "detail"} onClick={() => setPanel("detail")}>
                Detail
              </button>
            </div>
            {sel && (
              <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)} aria-label="Clear selection">
                <X size={12} />
              </button>
            )}
          </div>
          <div className="panel-body">
            {panel === "list" ? (
              <EntityList
                agents={visibleAgents}
                groups={groupStats}
                picked={picked}
                selected={sel}
                onPick={pick}
                onCompare={() => setPanel("detail")}
                onGroup={(name) => { setSel({ kind: "group", name }); setPanel("detail"); }}
              />
            ) : (
              <DetailPanel
                sel={sel} agent={selAgent} group={selGroup} edge={selEdge}
                nodes={nodes} edges={agentEdges}
                pickedAgents={pickedAgents}
                roundFilter={roundFilter}
                onSelectAgent={(id) => { setSel({ kind: "agent", id }); }}
                onSelectEdge={(src, dst) => setSel({ kind: "edge", src, dst })}
                onPick={pick}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EntityList({ agents, groups, picked, selected, onPick, onGroup, onCompare }: {
  agents: NetNode[];
  groups: { name: string; members: string[] }[];
  picked: string[];
  selected: Selection;
  onPick: (id: string) => void;
  onGroup: (name: string) => void;
  onCompare: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {picked.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="t-meta">{picked.length} agents ticked</span>
          <button className="btn btn-primary btn-sm" onClick={onCompare}>
            Compare {picked.length} selected
          </button>
        </div>
      )}
      <div>
        <div className="eyebrow mb-2">Stakeholder groups ({groups.length})</div>
        <div className="flex flex-col gap-1">
          {groups.map((g) => {
            const active = selected?.kind === "group" && selected.name === g.name;
            return (
              <button key={g.name} className="list-row" onClick={() => onGroup(g.name)}
                      aria-pressed={active} style={{ padding: "7px 9px", fontWeight: active ? 600 : 400 }}>
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="t-meta">{g.members.length}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="eyebrow mb-2">Agents ({agents.length})</div>
        <div className="flex max-h-[42vh] flex-col gap-1 overflow-y-auto">
          {agents.length === 0 && <p className="t-meta">No agent matches the search.</p>}
          {agents.map((a) => {
            const active = selected?.kind === "agent" && selected.id === a.id;
            return (
              <label key={a.id} className="list-row"
                     style={{ padding: "6px 8px", cursor: "pointer",
                              background: active ? "var(--bg-2)" : undefined }}>
                <input type="checkbox" checked={picked.includes(a.id)}
                       onChange={() => onPick(a.id)}
                       aria-label={`Select ${a.handle ?? a.id}`} />
                <span className="min-w-0 flex-1 truncate">@{a.handle ?? a.id}</span>
                <span className="t-meta truncate" style={{ maxWidth: 90 }}>{a.group}</span>
                <span className="mono flex-none" style={{ fontSize: 11, color: stanceTextColor(a.mean_stance) }}>
                  {a.mean_stance.toFixed(2)}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ sel, agent, group, edge, nodes, edges, pickedAgents, roundFilter,
  onSelectAgent, onSelectEdge, onPick }: {
  sel: Selection;
  agent: NetNode | null;
  group: { name: string; members: string[]; n: number; sum: number } | null;
  edge: { src: string; dst: string; follows: boolean; weight: number; interactions?: number } | null;
  nodes: NetNode[];
  edges: { src: string; dst: string; follows: boolean; weight: number; interactions?: number }[];
  pickedAgents: NetNode[];
  roundFilter?: number | null;
  onSelectAgent: (id: string) => void;
  onSelectEdge: (src: string, dst: string) => void;
  onPick: (id: string) => void;
}) {
  // Comparison is an agent mode: an explicit group or edge selection takes
  // precedence, so clicking a group never shows a stale comparison table.
  if (pickedAgents.length > 1 && sel?.kind === "agent") {
    const meanStance = pickedAgents.reduce((s, a) => s + a.mean_stance, 0) / pickedAgents.length;
    const groups = [...new Set(pickedAgents.map((a) => a.group))];
    return (
      <div className="flex flex-col gap-3">
        <div>
          <div className="eyebrow">Comparison</div>
          <p className="t-h3 mt-1">{pickedAgents.length} agents selected</p>
          <p className="t-meta">Mean stance {meanStance.toFixed(2)} · {groups.length} group(s)</p>
        </div>
        <table className="tbl">
          <thead>
            <tr><th>Agent</th><th>Group</th><th className="r">Stance</th><th className="r">Links</th></tr>
          </thead>
          <tbody>
            {pickedAgents.map((a) => (
              <tr key={a.id}>
                <td className="truncate">@{a.handle ?? a.id}</td>
                <td className="truncate">{a.group}</td>
                <td className="r mono" style={{ color: stanceTextColor(a.mean_stance) }}>{a.mean_stance.toFixed(2)}</td>
                <td className="r mono">{a.degree}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="t-meta">Select a single agent to see its connections, or untick to narrow the comparison.</p>
      </div>
    );
  }

  if (!sel) {
    return (
      <p className="t-meta">
        Pick an agent, a stakeholder group, or a connection. Every entity is reachable from the
        list as well as the graph, so nothing depends on clicking a small node.
      </p>
    );
  }

  if (sel.kind === "agent" && agent) {
    const outgoing = edges.filter((e) => e.src === agent.id);
    const incoming = edges.filter((e) => e.dst === agent.id);
    const strong = [...edges].sort((a, b) => b.weight - a.weight).slice(0, 5);
    const handleOf = (id: string) => nodes.find((n) => n.id === id)?.handle ?? id;
    return (
      <div className="flex flex-col gap-3">
        <div>
          <div className="eyebrow">Agent</div>
          <p className="t-h3 mt-1">{agent.name ?? agent.id}</p>
          <p className="t-meta mono">@{agent.handle ?? agent.id}</p>
          <dl className="kv mt-2" style={{ gridTemplateColumns: "96px minmax(0,1fr)", fontSize: 12.5 }}>
            <dt>Group</dt><dd>{agent.group}</dd>
            <dt>Stance</dt><dd className="mono" style={{ color: stanceTextColor(agent.mean_stance) }}>
              {agent.mean_stance.toFixed(2)}</dd>
            <dt>Connections</dt><dd className="mono">{edges.length}</dd>
            <dt>Archetype</dt><dd>{agent.archetype ?? "—"}</dd>
          </dl>
        </div>

        <div>
          <div className="eyebrow mb-1">
            Connections at {roundFilter == null ? "latest" : `round ${roundFilter}`}
          </div>
          {edges.length === 0 ? (
            <p className="t-meta">No recorded connections for this agent yet.</p>
          ) : (
            <div className="flex max-h-[36vh] flex-col gap-1 overflow-y-auto">
              {edges.slice(0, 40).map((e) => {
                const outgoingEdge = e.src === agent.id;
                const other = outgoingEdge ? e.dst : e.src;
                return (
                  <button key={`${e.src}-${e.dst}`} className="list-row"
                          onClick={() => onSelectEdge(e.src, e.dst)}
                          style={{ padding: "6px 8px" }}>
                    <span className="mono flex-none" style={{ fontSize: 10, color: "var(--fg-3)" }}>
                      {outgoingEdge ? "→" : "←"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{handleOf(other)}</span>
                    <span className="mono flex-none" style={{ fontSize: 11, color: "var(--fg-3)" }}>
                      {e.weight.toFixed(2)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {strong.length > 0 && (
          <div>
            <div className="eyebrow mb-1">Strongest relationships</div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {strong.map((e) => (
                <li key={`s-${e.src}-${e.dst}`} className="t-meta">
                  {handleOf(e.src)} → {handleOf(e.dst)} · trust {e.weight.toFixed(2)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-sm" onClick={() => onPick(agent.id)}>
            Add to comparison
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => onSelectAgent(agent.id)}>
            Stay on agent
          </button>
        </div>
        <p className="t-meta">
          Direction is who follows whom as recorded by the engine. Interaction counts are stored per
          edge; issue-by-issue attribution of an edge is not recorded, so it is not shown.
        </p>
      </div>
    );
  }

  if (sel.kind === "group" && group) {
    const members = nodes.filter((n) => group.members.includes(n.id));
    const mean = members.length ? members.reduce((s, a) => s + a.mean_stance, 0) / members.length : 0;
    const pro = members.filter((m) => m.mean_stance > 0.15).length;
    const con = members.filter((m) => m.mean_stance < -0.15).length;
    const mostConnected = [...members].sort((a, b) => b.degree - a.degree).slice(0, 5);
    return (
      <div className="flex flex-col gap-3">
        <div>
          <div className="eyebrow">Stakeholder group</div>
          <p className="t-h3 mt-1">{group.name}</p>
          <p className="t-meta">Mean stance {mean.toFixed(2)} · {members.length} agents</p>
        </div>
        <div>
          <div className="eyebrow mb-1">Stance distribution</div>
          <div className="flex h-2 w-full overflow-hidden" style={{ borderRadius: 99, background: "var(--bg-0)" }}>
            <span style={{ width: `${(pro / Math.max(1, members.length)) * 100}%`, background: "var(--pro)" }} />
            <span style={{ width: `${((members.length - pro - con) / Math.max(1, members.length)) * 100}%`, background: "var(--neu)" }} />
            <span style={{ width: `${(con / Math.max(1, members.length)) * 100}%`, background: "var(--con)" }} />
          </div>
          <p className="t-meta mt-1">{pro} support · {members.length - pro - con} undecided · {con} oppose</p>
        </div>
        <div>
          <div className="eyebrow mb-1">Most connected agents</div>
          <div className="flex flex-col gap-1">
            {mostConnected.map((m) => (
              <button key={m.id} className="list-row" style={{ padding: "5px 8px" }}
                      onClick={() => onSelectAgent(m.id)}>
                <span className="min-w-0 flex-1 truncate">@{m.handle ?? m.id}</span>
                <span className="mono t-meta">{m.degree}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="eyebrow mb-1">Members</div>
          <div className="flex max-h-[28vh] flex-col gap-1 overflow-y-auto">
            {members.map((m) => (
              <button key={m.id} className="list-row" style={{ padding: "5px 8px" }}
                      onClick={() => onSelectAgent(m.id)}>
                <span className="min-w-0 flex-1 truncate">@{m.handle ?? m.id}</span>
                <span className="mono" style={{ fontSize: 11, color: stanceTextColor(m.mean_stance) }}>
                  {m.mean_stance.toFixed(2)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (sel.kind === "edge" && edge) {
    const handleOf = (id: string) => nodes.find((n) => n.id === id)?.handle ?? id;
    const srcNode = nodes.find((n) => n.id === edge.src);
    const dstNode = nodes.find((n) => n.id === edge.dst);
    return (
      <div className="flex flex-col gap-3">
        <div>
          <div className="eyebrow">Connection</div>
          <p className="t-h3 mt-1">{handleOf(edge.src)} → {handleOf(edge.dst)}</p>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: "130px minmax(0,1fr)", fontSize: 12.5 }}>
          <dt>Source</dt><dd>@{handleOf(edge.src)} ({srcNode?.group ?? "—"})</dd>
          <dt>Target</dt><dd>@{handleOf(edge.dst)} ({dstNode?.group ?? "—"})</dd>
          <dt>Relationship</dt><dd>{edge.follows ? "follow" : "interaction only"}</dd>
          <dt>Trust weight</dt><dd className="mono">{edge.weight.toFixed(2)}</dd>
          <dt>Interactions</dt><dd className="mono">{edge.interactions ?? 0}</dd>
          <dt>Direction</dt><dd>source → target (recorded)</dd>
          <dt>Issue context</dt><dd className="fg-3">not recorded per edge</dd>
        </dl>
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-sm" onClick={() => onSelectAgent(edge.src)}>
            Inspect source
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => onSelectAgent(edge.dst)}>
            Inspect target
          </button>
        </div>
        <p className="t-meta">
          The engine records the direction and strength of a relationship but not which issue each
          interaction concerned, so no issue attribution is shown rather than a guessed one.
        </p>
      </div>
    );
  }

  return <p className="t-meta">That selection is no longer present at this round.</p>;
}

function Matrix({ groups, edges, groupOf }: {
  groups: { name: string; members: string[] }[];
  edges: { src: string; dst: string; weight: number }[];
  groupOf: Map<string, string>;
}) {
  const count = (a: string, b: string) =>
    edges.filter((e) => groupOf.get(e.src) === a && groupOf.get(e.dst) === b).length;
  return (
    <div className="overflow-x-auto" tabIndex={0} role="group"
         aria-label="Group-to-group relationships — scrollable table">
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
                <td key={h.name} className="r mono"
                    style={{ color: g.name === h.name ? "var(--fg-4)" : "var(--fg-1)" }}>
                  {g.name === h.name ? "—" : count(g.name, h.name)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="t-meta px-4 py-3">
        Cell values are recorded directed relationships from the row group to the column group.
      </p>
    </div>
  );
}
