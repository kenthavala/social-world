// Shared run-room helpers: tab definitions, stance helpers, tick ruler, chunk cache.
import type { Post } from "../types";
import * as api from "../api";

export const RUN_TABS = [
  { key: "live", label: "Live" },
  { key: "agents", label: "Agents" },
  { key: "network", label: "Network" },
  { key: "events", label: "Events" },
  { key: "analysis", label: "Analysis" },
  { key: "log", label: "Log" },
] as const;

export type RunTabKey = (typeof RUN_TABS)[number]["key"];

// Migrate tab keys stored by earlier sessions (overview/feed → live, insights → analysis).
export function normalizeTab(t: string | null): RunTabKey {
  if (t === "overview" || t === "feed") return "live";
  if (t === "insights") return "analysis";
  return (RUN_TABS.some((x) => x.key === t) ? t : "live") as RunTabKey;
}

export function postOverallStance(p: Post): "pro" | "neu" | "con" {
  const vals = Object.values(p.stance || {}).map((s) => s?.value ?? 0);
  if (vals.length === 0) return "neu";
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean > 0.15) return "pro";
  if (mean < -0.15) return "con";
  return "neu";
}

export function stanceColor(v: number): string {
  if (v > 0.15) return "var(--pro-fg)";
  if (v < -0.15) return "var(--con-fg)";
  return "var(--neu-fg)";
}

// Deterministic hue from a string — used for the network canvas and small identity accents.
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name: string | null | undefined, handle: string | null | undefined): string {
  const src = (name || handle || "?").trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export interface RulerCell {
  n: number;                       // 1-based tick number
  pro: number; neu: number; con: number;   // post counts
  total: number;
  max: number;                     // global max across ticks (proportional heights)
  cls: string;                     // "tk is-current is-future …"
  ax: string;                      // axis label (sparse)
  axCls: string;
  tip: string;
}

// Posts per tick by stance, derived from the run's real posts (never fabricated).
// highlightTick = the in-progress tick (0 = none, e.g. a finished run).
export function buildRuler(posts: Post[], totalTicks: number, highlightTick: number): RulerCell[] {
  const counts = new Map<number, { pro: number; neu: number; con: number }>();
  for (const p of posts) {
    const c = counts.get(p.tick) ?? { pro: 0, neu: 0, con: 0 };
    c[postOverallStance(p)] += 1;
    counts.set(p.tick, c);
  }
  const nTicks = Math.max(1, totalTicks);
  let globalMax = 1;
  counts.forEach((c) => { globalMax = Math.max(globalMax, c.pro + c.neu + c.con); });
  const cells: RulerCell[] = [];
  const labelEvery = nTicks > 32 ? 8 : 4;
  for (let i = 1; i <= nTicks; i++) {
    const c = counts.get(i) ?? { pro: 0, neu: 0, con: 0 };
    const total = c.pro + c.neu + c.con;
    const cur = i === highlightTick;
    const fut = highlightTick > 0 && i > highlightTick;
    const cls = "tk" + (cur ? " is-current" : "") + (fut ? " is-future" : "");
    const label = String(i).padStart(2, "0");
    cells.push({
      n: i,
      ...c,
      total,
      max: globalMax,
      cls,
      ax: i === 1 || i === nTicks || i % labelEvery === 0 ? label : "",
      axCls: cur ? "cur" : "",
      tip: total > 0
        ? `Tick ${label}${cur ? " (in progress)" : ""} · ${total} post${total === 1 ? "" : "s"} — PRO ${c.pro} · NEUTRAL ${c.neu} · CON ${c.con}`
        : `Tick ${label} · not started`,
    });
  }
  return cells;
}

// Segment heights for one ruler cell (stacked con/neu/pro, proportional to the global max).
export function rulerSegs(cell: RulerCell): { cls: string; h: number }[] {
  return [
    { cls: "s-con", h: (cell.con / cell.max) * 100 },
    { cls: "s-neu", h: (cell.neu / cell.max) * 100 },
    { cls: "s-pro", h: (cell.pro / cell.max) * 100 },
  ].filter((s) => s.h > 0);
}

// ---- chunk cache: one fetch per chunk id per session ------------------------
export interface ChunkInfo { page: number | null; pageEnd: number | null; text: string | null }

const chunkCache = new Map<string, ChunkInfo>();
const chunkPending = new Map<string, Promise<ChunkInfo>>();
const chunkListeners = new Set<() => void>();

export function chunkInfo(chunkId: string): ChunkInfo | null {
  return chunkCache.get(chunkId) ?? null;
}

export function fetchChunk(sourceId: string, chunkId: string): Promise<ChunkInfo> {
  const cached = chunkCache.get(chunkId);
  if (cached) return Promise.resolve(cached);
  const pending = chunkPending.get(chunkId);
  if (pending) return pending;
  const prom = api.getChunk(sourceId, chunkId).then((c) => {
    const info: ChunkInfo = { page: c.page_start ?? null, pageEnd: c.page_end ?? null, text: c.text ?? null };
    chunkCache.set(chunkId, info);
    chunkPending.delete(chunkId);
    chunkListeners.forEach((fn) => fn());
    return info;
  }).catch(() => {
    const info: ChunkInfo = { page: null, pageEnd: null, text: null };
    chunkCache.set(chunkId, info);
    chunkPending.delete(chunkId);
    chunkListeners.forEach((fn) => fn());
    return info;
  });
  chunkPending.set(chunkId, prom);
  return prom;
}

// Prefetch pages/text for every cited chunk in a post list (feed + analysis).
export function prefetchChunks(sourceId: string | null, posts: Post[]): void {
  if (!sourceId) return;
  const ids = new Set<string>();
  posts.forEach((p) => p.cited_chunk_ids.forEach((c) => ids.add(c)));
  ids.forEach((id) => {
    if (!chunkCache.has(id) && !chunkPending.has(id)) void fetchChunk(sourceId, id);
  });
}

export function subscribeChunks(fn: () => void): () => void {
  chunkListeners.add(fn);
  return () => { chunkListeners.delete(fn); };
}

// Client-side derived stats — counted from posts, no new endpoints.
export interface DerivedStats {
  postsWithSource: number;
  distinctChunks: number;
  stanceMix: { pro: number; neu: number; con: number };
  avgPostsPerTick: number;
  postsByTick: { tick: number; pro: number; neu: number; con: number; total: number }[];
  postsByAgent: { agentId: string; name: string; handle: string | null; n: number; pro: number; neu: number; con: number }[];
}

export function deriveStats(posts: Post[]): DerivedStats {
  const byTick = new Map<number, { pro: number; neu: number; con: number }>();
  const byAgent = new Map<string, { name: string; handle: string | null; pro: number; neu: number; con: number }>();
  const chunks = new Set<string>();
  let cited = 0;
  let maxTick = 0;
  for (const p of posts) {
    const s = postOverallStance(p);
    const t = byTick.get(p.tick) ?? { pro: 0, neu: 0, con: 0 };
    t[s] += 1;
    byTick.set(p.tick, t);
    const a = byAgent.get(p.agent_id) ?? { name: p.name ?? p.agent_id, handle: p.handle, pro: 0, neu: 0, con: 0 };
    a[s] += 1;
    if (!a.name && p.name) a.name = p.name;
    byAgent.set(p.agent_id, a);
    if (p.cited_chunk_ids.length > 0) { cited += 1; p.cited_chunk_ids.forEach((c) => chunks.add(c)); }
    if (p.tick > maxTick) maxTick = p.tick;
  }
  const mix = { pro: 0, neu: 0, con: 0 };
  byTick.forEach((v) => { mix.pro += v.pro; mix.neu += v.neu; mix.con += v.con; });
  const postsByTick = [...byTick.entries()]
    .map(([tick, v]) => ({ tick, ...v, total: v.pro + v.neu + v.con }))
    .sort((a, b) => a.tick - b.tick);
  const postsByAgent = [...byAgent.entries()]
    .map(([agentId, v]) => ({ agentId, ...v, n: v.pro + v.neu + v.con }))
    .sort((a, b) => b.n - a.n);
  return {
    postsWithSource: cited,
    distinctChunks: chunks.size,
    stanceMix: mix,
    avgPostsPerTick: maxTick > 0 ? posts.length / maxTick : 0,
    postsByTick,
    postsByAgent,
  };
}
