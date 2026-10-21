// Live: the feed (post cards with real citations) + the activity rail + the
// evidence drawer. Every number is derived from recorded rows; the drawer says
// exactly what a citation is and what it is not.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, FileText, Heart, MessageCircle, Repeat2, X } from "lucide-react";
import type { Post, RunDetail } from "../types";
import * as api from "../api";
import { Spinner, StatusBadge } from "../common";
import {
  chunkInfo, deriveStats, fetchChunk, initials, postOverallStance, subscribeChunks,
} from "./helpers";
import { hrefFor } from "../router";

type Filter = "all" | "pro" | "neu" | "con";
const PER_TICK_CAP = 12;

export default function LiveTab({ run, posts, runId, connected, onError, bumpKey }: {
  run: RunDetail;
  posts: Post[];
  runId: string;
  connected: boolean;
  onError: (e: unknown) => void;
  bumpKey: number;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [cite, setCite] = useState<{ chunkId: string; post: Post } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const lastLen = useRef(posts.length);
  const atTop = useRef(true);

  const counts = useMemo(() => {
    const c = { all: posts.length, pro: 0, neu: 0, con: 0 };
    for (const p of posts) c[postOverallStance(p)] += 1;
    return c;
  }, [posts]);

  const shown = useMemo(
    () => (filter === "all" ? posts : posts.filter((p) => postOverallStance(p) === filter)),
    [posts, filter]);

  const groups = useMemo(() => {
    const m = new Map<number, Post[]>();
    for (const p of shown) {
      const arr = m.get(p.tick) ?? [];
      arr.push(p);
      m.set(p.tick, arr);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]); // newest tick first
  }, [shown]);

  // follow-live: prepend and keep the top in view, else count into a pill
  useEffect(() => {
    const grew = posts.length - lastLen.current;
    if (grew > 0) {
      if (follow && atTop.current) {
        feedRef.current?.scrollTo({ top: 0 });
      } else {
        setUnseen((n) => n + grew);
      }
    }
    lastLen.current = posts.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length, follow]);

  const jumpTop = useCallback(() => {
    feedRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setUnseen(0);
  }, []);

  const FILTERS: [Filter, string, string | null][] = [
    ["all", "All", null],
    ["pro", "PRO", "sg-pro"],
    ["neu", "NEU", "sg-neu"],
    ["con", "CON", "sg-con"],
  ];

  const isRunning = ["running", "seeding"].includes(run.status);
  const isPaused = run.status === "paused";

  return (
    <div className="flex h-full min-h-0 flex-wrap">
      {/* ---- feed ---- */}
      <section className="flex h-full min-h-0 min-w-0 flex-[999_1_560px] flex-col" style={{ borderRight: "1px solid var(--line-1)", background: "var(--bg-1)" }} aria-label="Live feed">
        <div className="flex flex-none flex-wrap items-center justify-between gap-3 px-4 py-2.5 md:px-5" style={{ borderBottom: "1px solid var(--line-1)" }}>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter posts by stance">
            {FILTERS.map(([key, label, sg]) => (
              <button
                key={key}
                className="chip"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {sg && <span className={`sg ${sg}`} />}
                {label}
                <span className="chip-n">{counts[key]}</span>
              </button>
            ))}
          </div>
          <label className="t-meta flex cursor-pointer items-center gap-2.5">
            <span>Follow live</span>
            <button
              className="switch"
              role="switch"
              aria-checked={follow}
              onClick={() => { setFollow(!follow); setUnseen(0); }}
              aria-label="Follow live posts"
            />
          </label>
        </div>

        <div
          ref={feedRef}
          className="scroll relative flex-1"
          onScroll={(e) => { atTop.current = (e.target as HTMLDivElement).scrollTop < 40; if (atTop.current) setUnseen(0); }}
        >
          {unseen > 0 && (
            <div className="sticky top-2 z-10 flex justify-center" style={{ height: 0 }}>
              <button className="btn btn-sm btn-primary" onClick={jumpTop} style={{ boxShadow: "var(--shadow-pop)", transform: "translateY(8px)" }}>
                <ArrowUp size={13} /> {unseen} new post{unseen === 1 ? "" : "s"}
              </button>
            </div>
          )}

          {isPaused && (
            <div className="banner banner-warn m-3 md:mx-5">
              <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden style={{ color: "var(--warn)" }}>
                <path d="M5.5 3.5v9M10.5 3.5v9" />
              </svg>
              <span className="flex-1">Paused at tick {String(run.last_completed_tick).padStart(2, "0")}. Calls already sent will finish; no new calls start until you resume.</span>
            </div>
          )}
          {["interrupted", "failed", "stopped"].includes(run.status) && (
            <div className="banner banner-mute m-3 md:mx-5">
              <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden style={{ color: "var(--fg-3)" }}>
                <rect x="4" y="4" width="8" height="8" rx="1" />
              </svg>
              <span className="flex-1">
                {run.status === "interrupted" ? "Run was interrupted" : run.status === "failed" ? "Run failed" : "Run stopped"} at tick {String(run.last_completed_tick).padStart(2, "0")}. All {run.posts} posts are kept and remain inspectable — resume continues from the next tick.
              </span>
            </div>
          )}

          {posts.length === 0 ? (
            <div className="empty">
              <span className="empty-ic">
                <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                  <circle cx="8" cy="8" r="1.5" />
                  <path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.1 3.1a7 7 0 0 0 0 9.8M12.9 3.1a7 7 0 0 1 0 9.8" />
                </svg>
              </span>
              <p className="t-h3">Nothing posted yet</p>
              <p className="t-meta" style={{ maxWidth: 320 }}>
                {isRunning
                  ? "Agents are being seeded and will start posting shortly — new posts stream in here."
                  : "Start the run and new posts will stream in here, each one citing the source chunk it drew from."}
              </p>
            </div>
          ) : (
            groups.map(([tick, tposts], gi) => (
              <TickGroup
                key={tick}
                tick={tick}
                posts={tposts}
                isCurrent={isRunning && gi === 0 && tick === Math.max(1, run.current_tick)}
                run={run}
                filterLabel={FILTERS.find((f) => f[0] === filter)?.[1] ?? "All"}
                onCite={(chunkId, post) => setCite({ chunkId, post })}
                allPosts={posts}
              />
            ))
          )}
          {posts.length > 0 && (
            <div className="px-4 py-4 text-center t-meta" style={{ borderTop: "1px solid var(--line-1)" }}>
              {posts.length} post{posts.length === 1 ? "" : "s"} recorded — the newest first.
            </div>
          )}
        </div>
      </section>

      {/* ---- activity rail ---- */}
      <LiveRail run={run} posts={posts} runId={runId} connected={connected} onError={onError} bumpKey={bumpKey} />

      {/* ---- evidence drawer ---- */}
      {cite && (
        <EvidenceDrawer
          run={run}
          posts={posts}
          chunkId={cite.chunkId}
          post={cite.post}
          onClose={() => setCite(null)}
          onError={onError}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ tick group

function TickGroup({ tick, posts, isCurrent, run, filterLabel, onCite, allPosts }: {
  tick: number;
  posts: Post[];
  isCurrent: boolean;
  run: RunDetail;
  filterLabel: string;
  onCite: (chunkId: string, post: Post) => void;
  allPosts: Post[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? posts : posts.slice(0, PER_TICK_CAP);
  const hidden = posts.length - visible.length;
  const scheduled = run.config?.writes_per_tick ?? 0;
  const label = String(tick).padStart(2, "0");

  return (
    <section aria-label={`Tick ${label}`}>
      <div className="sticky top-0 z-[5] flex flex-wrap items-center gap-3 px-4 py-2.5 md:px-5" style={{ background: "var(--bg-1)", borderBottom: "1px solid var(--line-1)", borderTop: "1px solid var(--line-1)" }}>
        <span className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".07em", color: "var(--fg-1)" }}>TICK {label}</span>
        {isCurrent ? (
          <span className="status status-running"><span className="dot dot-pulse" style={{ marginLeft: -1 }} />In progress</span>
        ) : (
          <span className="status status-completed">
            <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5 6.5 12 13 4.5" /></svg>
            Complete
          </span>
        )}
        <span className="t-meta">
          {posts.length} post{posts.length === 1 ? "" : "s"}{isCurrent && scheduled > 0 ? ` · ${Math.min(posts.length, scheduled)} of ${scheduled} agents posted` : ""}
        </span>
        {isCurrent && scheduled > 0 && (
          <div className="bar ml-auto" style={{ flex: 1, maxWidth: 160 }} aria-hidden>
            <i style={{ width: `${Math.min(100, (posts.length / scheduled) * 100)}%` }} />
          </div>
        )}
      </div>
      {visible.map((p, i) => (
        <PostCard key={p.id} p={p} newest={isCurrent && i === 0 && p === posts[0]} onCite={onCite} allPosts={allPosts} />
      ))}
      {posts.length === 0 && (
        <div className="t-meta px-5 py-5 text-center">No {filterLabel.toLowerCase() === "all" ? "" : `${filterLabel.toLowerCase()} `}posts in tick {label}.</div>
      )}
      {hidden > 0 && (
        <div className="flex justify-center px-4 pb-4 pt-3.5">
          <button className="btn btn-sm btn-ghost" onClick={() => setShowAll(true)}>
            Show {hidden} more from tick {label}
          </button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ post card

function PostCard({ p, newest, onCite, allPosts }: {
  p: Post;
  newest: boolean;
  onCite: (chunkId: string, post: Post) => void;
  allPosts: Post[];
}) {
  const overall = postOverallStance(p);
  const avCls = overall === "pro" ? "av-pro" : overall === "con" ? "av-con" : "av-neu";
  const stanceCls = `stance stance-${overall}`;
  const sgCls = `sg sg-${overall}`;
  const label = overall === "pro" ? "PRO" : overall === "con" ? "CON" : "NEUTRAL";
  const parent = p.parent_id ? allPosts.find((x) => x.id === p.parent_id) : null;

  return (
    <article className={`post ${newest ? "enter-a" : ""}`} aria-label={`Post by ${p.name ?? p.handle ?? p.agent_id}`}>
      <a className={`av ${avCls}`} href="#" onClick={(e) => e.preventDefault()} aria-label={p.name ?? "agent"} title={p.name ?? undefined}>
        {initials(p.name, p.handle)}
      </a>
      <div className="min-w-0">
        <div className="post-head">
          <span className="post-name">{p.name ?? p.agent_id}</span>
          <span className={stanceCls}><span className={sgCls} />{label}</span>
          {p.kind === "reply" && <span className="badge">reply</span>}
          {p.kind === "system" && <span className="badge">system</span>}
          {Boolean(p.is_fallback) && <span className="badge s-warn">fallback</span>}
          <span className="post-persona ellipsis">@{p.handle ?? p.agent_id}</span>
          <span className="post-time"><span className="tk-n">T{String(p.tick).padStart(2, "0")}</span></span>
        </div>
        {parent && (
          <p className="t-meta mt-1.5">
            ↳ replying to <span style={{ color: "var(--fg-2)" }}>{parent.name ?? parent.agent_id}</span> — “{parent.text.slice(0, 90)}{parent.text.length > 90 ? "…" : ""}”
          </p>
        )}
        <p className="post-body t-post">{p.text}</p>
        <div className="post-src">
          {p.cited_chunk_ids.length > 0 ? (
            <>
              <span className="eyebrow">Sources</span>
              {p.cited_chunk_ids.map((c) => <CiteChip key={c} chunkId={c} post={p} onOpen={onCite} />)}
            </>
          ) : (
            <span className="t-meta" style={{ fontSize: 11.5 }}>no source cited</span>
          )}
          <span className="t-meta mono ml-auto flex items-center gap-3" style={{ fontSize: 11 }}>
            <span className="inline-flex items-center gap-1"><Heart size={11} aria-hidden /> {p.likes}</span>
            <span className="inline-flex items-center gap-1"><Repeat2 size={11} aria-hidden /> {p.reposts}</span>
            <span className="inline-flex items-center gap-1"><MessageCircle size={11} aria-hidden /> {p.replies}</span>
          </span>
        </div>
      </div>
    </article>
  );
}

function CiteChip({ chunkId, post, onOpen }: { chunkId: string; post: Post; onOpen: (c: string, p: Post) => void }) {
  const [, force] = useState(0);
  useEffect(() => subscribeChunks(() => force((x) => x + 1)), []);
  const info = chunkInfo(chunkId);
  const short = chunkId.length > 10 ? chunkId.slice(0, 10) : chunkId;
  const pageLabel = info?.page != null
    ? info.pageEnd != null && info.pageEnd !== info.page
      ? `p. ${info.page}–${info.pageEnd}`
      : `p. ${info.page}`
    : null;
  return (
    <button
      className={`cite ${info && info.page == null && info.text == null ? "is-missing" : ""}`}
      onClick={() => onOpen(chunkId, post)}
      aria-label={`Source ${chunkId}${pageLabel ? `, ${pageLabel}` : ""}`}
    >
      <FileText className="ic-xs" aria-hidden />
      {pageLabel && <><span className="cite-p">{pageLabel}</span><span className="cite-sep">·</span></>}
      <span>{short}</span>
    </button>
  );
}

// ------------------------------------------------------------------ rail

function LiveRail({ run, posts, runId, connected, onError, bumpKey }: {
  run: RunDetail;
  posts: Post[];
  runId: string;
  connected: boolean;
  onError: (e: unknown) => void;
  bumpKey: number;
}) {
  const [calls, setCalls] = useState<Awaited<ReturnType<typeof api.getLLMCalls>>["calls"] | null>(null);
  const [totalChunks, setTotalChunks] = useState<number | null>(null);

  useEffect(() => {
    api.getLLMCalls(runId).then((r) => setCalls(r.calls)).catch(() => setCalls([]));
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!run.source_id) return;
    api.listChunks(run.source_id).then((r) => setTotalChunks(r.count)).catch(() => setTotalChunks(null));
  }, [run.source_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => deriveStats(posts), [posts]);
  const currentTick = Math.max(1, run.current_tick || run.last_completed_tick || 1);
  const tickPosts = useMemo(() => posts.filter((p) => p.tick === currentTick), [posts, currentTick]);
  const scheduled = run.config?.writes_per_tick ?? 0;
  const failed = calls?.filter((c) => c.status !== "ok").length ?? null;
  const total = stats.stanceMix.pro + stats.stanceMix.neu + stats.stanceMix.con;

  return (
    <aside className="scroll h-full min-h-0 min-w-0 flex-[1_1_340px]" aria-label="Run activity">
      <section style={{ borderBottom: "1px solid var(--line-1)" }}>
        <div className="flex items-center justify-between px-5 pb-2.5 pt-3.5">
          <h2 className="t-h3">Agents this tick</h2>
          <span className="t-meta mono">
            {tickPosts.length} posted{["running", "seeding", "paused"].includes(run.status) && scheduled > 0 ? ` · ${scheduled} scheduled` : ""}
          </span>
        </div>
        {tickPosts.length === 0 ? (
          <p className="t-meta px-5 pb-4">
            {["running", "seeding"].includes(run.status) ? "Waiting for the first posts of this tick…" : `No posts in tick ${String(currentTick).padStart(2, "0")}.`}
          </p>
        ) : (
          <ul className="m-0 list-none px-2 pb-2.5">
            {tickPosts.map((p) => {
              const overall = postOverallStance(p);
              return (
                <li key={p.id}>
                  <div className="list-row" style={{ padding: "6px 12px", gap: 10, borderBottom: 0, borderRadius: "var(--r-2)" }}>
                    <span className={`sg sg-${overall}`} />
                    <span className="ellipsis" style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{p.name ?? p.agent_id}</span>
                    <span className="t-meta inline-flex items-center gap-1.5" style={{ color: "var(--fg-2)" }}>
                      <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5 6.5 12 13 4.5" /></svg>
                      posted
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 px-5 py-3.5" style={{ borderBottom: "1px solid var(--line-1)" }}>
        <h2 className="t-h3">Run health</h2>
        <dl className="kv m-0" style={{ gridTemplateColumns: "104px minmax(0,1fr)", gap: "10px 12px", fontSize: 12.5 }}>
          <dt>Event stream</dt>
          <dd className="flex items-center gap-2">
            <span className={`dot ${connected ? "dot-ok" : "dot-warn"}`} />
            {connected ? "connected" : "reconnecting…"}
          </dd>
          <dt>Provider</dt>
          <dd className="flex items-center gap-2">
            <span className={`dot ${run.provider?.name ? "dot-ok" : "dot-idle"}`} />
            {run.provider?.name ? <>{run.provider.name}{run.provider.model ? <span className="mono fg-3">· {run.provider.model}</span> : null}</> : "not recorded"}
          </dd>
          <dt>Failed calls</dt>
          <dd>{failed == null ? "…" : failed === 0 ? "0" : <>{failed} <span className="fg-3">· all attempts logged in the Log tab</span></>}</dd>
          <dt>Budget</dt>
          <dd className="mono">
            {run.max_llm_calls != null ? `${run.llm_calls_used} / ${run.max_llm_calls} calls` : `${run.llm_calls_used} calls`}
          </dd>
        </dl>
      </section>

      <section className="flex flex-col gap-3 px-5 py-3.5">
        <h2 className="t-h3">Generated so far</h2>
        <dl className="kv m-0" style={{ gridTemplateColumns: "1fr auto", gap: "10px 12px", fontSize: 12.5 }}>
          <dt>Posts with a source</dt>
          <dd className="mono" style={{ textAlign: "right" }}>{stats.postsWithSource} / {posts.length}</dd>
          <dt>Distinct chunks cited</dt>
          <dd className="mono" style={{ textAlign: "right" }}>
            {stats.distinctChunks}{totalChunks != null ? ` / ${totalChunks}` : ""}
          </dd>
          <dt>Avg posts per tick</dt>
          <dd className="mono" style={{ textAlign: "right" }}>{stats.avgPostsPerTick.toFixed(1)}</dd>
        </dl>
        {total > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="t-meta">Posts by stance</span>
            <div className="stack-bar" role="img" aria-label={`Posts by stance: PRO ${stats.stanceMix.pro}, NEUTRAL ${stats.stanceMix.neu}, CON ${stats.stanceMix.con}`}>
              <i className="s-pro" style={{ flex: stats.stanceMix.pro }} />
              <i className="s-neu" style={{ flex: stats.stanceMix.neu }} />
              <i className="s-con" style={{ flex: stats.stanceMix.con }} />
            </div>
            <div className="t-meta mono flex justify-between">
              <span>PRO {stats.stanceMix.pro}</span><span>NEU {stats.stanceMix.neu}</span><span>CON {stats.stanceMix.con}</span>
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}

// ------------------------------------------------------------------ evidence drawer

function EvidenceDrawer({ run, posts, chunkId, post, onClose, onError }: {
  run: RunDetail;
  posts: Post[];
  chunkId: string;
  post: Post;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const [info, setInfo] = useState(chunkInfo(chunkId));
  const [doc, setDoc] = useState<{ filename: string; pages: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (!run.source_id) return;
    api.getSource(run.source_id)
      .then((s) => setDoc({ filename: s.filename, pages: s.pages }))
      .catch((e) => onError(e));
    fetchChunk(run.source_id, chunkId).then(setInfo).catch(() => undefined);
  }, [run.source_id, chunkId]); // eslint-disable-line react-hooks/exhaustive-deps

  const others = useMemo(
    () => posts.filter((p) => p.id !== post.id && p.cited_chunk_ids.includes(chunkId)),
    [posts, chunkId, post.id]);

  const overall = postOverallStance(post);
  const avCls = overall === "pro" ? "av-pro" : overall === "con" ? "av-con" : "av-neu";

  function copyId() {
    navigator.clipboard?.writeText(chunkId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => undefined);
  }

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close source" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="ev-title">
        <div className="drawer-head">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="eyebrow">Source</span>
            <h2 id="ev-title" className="t-h2">{doc?.filename ?? "Loading document…"}</h2>
            <span className="t-meta mono">{run.source_id ?? ""}</span>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close source">
            <X size={15} />
          </button>
        </div>
        <div className="drawer-body">
          <dl className="m-0 grid grid-cols-3" style={{ border: "1px solid var(--line-1)", borderRadius: "var(--r-2)" }}>
            <div className="flex flex-col gap-1 px-3 py-2.5" style={{ borderRight: "1px solid var(--line-1)" }}>
              <dt className="eyebrow">Page</dt>
              <dd className="stat-v-sm m-0">
                {info?.page != null ? (
                  <>
                    {info.page}
                    {info.pageEnd != null && info.pageEnd !== info.page ? `–${info.pageEnd}` : ""}
                    {doc?.pages ? <span className="fg-3" style={{ fontWeight: 400 }}> / {doc.pages}</span> : null}
                  </>
                ) : "—"}
              </dd>
            </div>
            <div className="flex flex-col gap-1 px-3 py-2.5" style={{ borderRight: "1px solid var(--line-1)" }}>
              <dt className="eyebrow">Chunk</dt>
              <dd className="m-0 flex items-center gap-1.5">
                <span className="mono" style={{ fontSize: 12.5 }}>{chunkId}</span>
                <button className="btn btn-ghost btn-sm btn-icon has-tip tip-below" data-tip={copied ? "Copied" : "Copy chunk ID"} onClick={copyId} aria-label="Copy chunk ID" style={{ width: 24, height: 24 }}>
                  <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
                  </svg>
                </button>
              </dd>
            </div>
            <div className="flex flex-col gap-1 px-3 py-2.5">
              <dt className="eyebrow">Length</dt>
              <dd className="mono m-0" style={{ fontSize: 12.5 }}>{info?.text != null ? `${info.text.length} chars` : "…"}</dd>
            </div>
          </dl>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Source text</span>
              <span className="t-id">
                {info?.page != null
                  ? `p. ${info.page}${info.pageEnd != null && info.pageEnd !== info.page ? `–${info.pageEnd}` : ""} · `
                  : ""}
                {chunkId}
              </span>
            </div>
            {info === null ? (
              <div className="inset flex items-center gap-2 p-4"><Spinner label="Loading source text…" /></div>
            ) : info.text == null ? (
              <blockquote className="inset m-0 px-4 py-4 t-meta">
                The chunk text could not be loaded from the server. The citation itself is still recorded in this post.
              </blockquote>
            ) : (
              <blockquote className="inset m-0 px-4 py-4" style={{ fontSize: 14, lineHeight: 1.7, color: "var(--fg-1)", textWrap: "pretty" }}>
                {info.text}
              </blockquote>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <span className="eyebrow">Cited by this post</span>
            <div className="inset flex flex-col gap-2 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`av av-sm ${avCls}`} aria-hidden>{initials(post.name, post.handle)}</span>
                <span style={{ fontWeight: 600 }}>{post.name ?? post.agent_id}</span>
                <span className={`stance stance-${overall}`}><span className={`sg sg-${overall}`} />{overall === "pro" ? "PRO" : overall === "con" ? "CON" : "NEUTRAL"}</span>
                <span className="t-id ml-auto">T{String(post.tick).padStart(2, "0")}</span>
              </div>
              <p className="fg-2" style={{ fontSize: 13, lineHeight: 1.6 }}>{post.text}</p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Also cited in this run</span>
              <span className="t-meta mono">{others.length}</span>
            </div>
            {others.length === 0 ? (
              <span className="t-meta">No other post in this run cites this chunk.</span>
            ) : (
              <ul className="m-0 list-none p-0">
                {others.slice(0, 8).map((o) => (
                  <li key={o.id}>
                    <div className="list-row" style={{ padding: "8px 0", gap: 10 }}>
                      <span className={`sg sg-${postOverallStance(o)}`} />
                      <span style={{ fontSize: 13, flex: 1 }}>{o.name ?? o.agent_id}</span>
                      <span className="t-id">T{String(o.tick).padStart(2, "0")}</span>
                    </div>
                  </li>
                ))}
                {others.length > 8 && <li className="t-meta pt-1.5">+ {others.length - 8} more</li>}
              </ul>
            )}
          </div>

          <div className="banner banner-mute" style={{ alignItems: "flex-start", fontSize: 12.5 }}>
            <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden style={{ color: "var(--fg-3)", marginTop: 1 }}>
              <circle cx="8" cy="8" r="6" /><path d="M8 7v4" /><path d="M8 5v.01" />
            </svg>
            <span>
              This is the chunk the agent referenced when writing the post. OASIS_SIM records the
              reference; it does not check that the post represents the source accurately.
            </span>
          </div>
        </div>
        <div className="drawer-foot">
          <a className="btn" href={hrefFor({ name: "documents", sourceId: run.source_id ?? undefined })}>
            Open in Documents
            <svg className="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 3.5 10.5 8 6 12.5" /></svg>
          </a>
          <span className="t-id">run {run.id}</span>
        </div>
      </aside>
    </>
  );
}
