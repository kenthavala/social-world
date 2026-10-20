// Feed: post cards grouped by tick, stance filters, evidence chips with real pages.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Post, RunDetail } from "../types";
import * as api from "../api";
import { hashHue, initials, postOverallStance } from "./helpers";

type Filter = "all" | "pro" | "neu" | "con";

const CHUNK_PAGE_CACHE = new Map<string, number | null>();
const pending = new Map<string, Promise<number | null>>();

function chunkPage(chunkId: string): number | null {
  return CHUNK_PAGE_CACHE.get(chunkId) ?? null;
}

export default function FeedTab({ posts, run }: { posts: Post[]; run: RunDetail }) {
  return <FeedTabInner posts={posts} run={run} />;
}

function FeedTabInner({ posts, run }: { posts: Post[]; run: RunDetail }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [follow, setFollow] = useState(true);
  const feedRef = useRef<HTMLDivElement>(null);
  const lastLen = useRef(0);
  const [, force] = useState(0);
  const refresh = () => force((x) => x + 1);

  useEffect(() => {
    // resolve chunk pages once per unique chunk id (real data from the DB)
    const ids = new Set<string>();
    posts.forEach((p) => p.cited_chunk_ids.forEach((c) => ids.add(c)));
    const missing = [...ids].filter((id) => !CHUNK_PAGE_CACHE.has(id) && !pending.has(id) && run.source_id);
    missing.forEach((id) => {
      const prom = api.getChunk(run.source_id as string, id)
        .then((c) => (c.page_start ?? null))
        .catch(() => null);
      pending.set(id, prom);
      prom.then((pageNo) => {
        CHUNK_PAGE_CACHE.set(id, pageNo);
        pending.delete(id);
        refresh();
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length, run.source_id]);

  const counts = useMemo(() => {
    const c = { all: posts.length, pro: 0, neu: 0, con: 0 };
    for (const p of posts) c[postOverallStance(p)] += 1;
    return c;
  }, [posts]);

  const shown = useMemo(
    () => (filter === "all" ? posts : posts.filter((p) => postOverallStance(p) === filter)),
    [posts, filter]);

  // group posts by tick for headers
  const groups = useMemo(() => {
    const m = new Map<number, Post[]>();
    for (const p of shown) {
      const arr = m.get(p.tick) ?? [];
      arr.push(p);
      m.set(p.tick, arr);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]); // newest tick first
  }, [shown]);

  useEffect(() => {
    if (follow && posts.length > lastLen.current) {
      lastLen.current = posts.length;
      feedRef.current?.scrollTo({ top: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length]);

  const FILTERS: [Filter, string][] = [["all", "All"], ["pro", "PRO"], ["neu", "NEU"], ["con", "CON"]];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            className="chip cursor-pointer"
            onClick={() => setFilter(key)}
            style={filter === key
              ? { borderColor: "var(--ac-line)", color: "var(--ac-fg)", background: "var(--ac-soft)" }
              : undefined}
          >
            {label} {counts[key]}
          </button>
        ))}
        <button
          className={`chip ml-auto cursor-pointer ${follow ? "s-run" : ""}`}
          onClick={() => setFollow(!follow)}
        >
          {follow ? "● following live" : "○ follow live"}
        </button>
      </div>

      <div ref={feedRef} className="flex flex-col gap-2">
        {posts.length === 0 ? (
          <div className="panel p-10 text-center text-sm" style={{ color: "var(--fg-3)" }}>
            Nothing posted yet. Once the run starts, new posts stream in here.
          </div>
        ) : (
          groups.map(([tick, tposts]) => (
            <section key={tick}>
              <div
                className="eyebrow flex items-center gap-2 px-1 py-1.5"
                style={{ borderBottom: "1px solid var(--line-1)" }}
              >
                <span>TICK {String(tick).padStart(2, "0")}</span>
                <span style={{ color: "var(--fg-4)" }}>·</span>
                <span>{tposts.length} post{tposts.length === 1 ? "" : "s"}</span>
              </div>
              {tposts.map((p) => <PostCard key={p.id} p={p} />)}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function PostCard({ p }: { p: Post }) {
  const overall = postOverallStance(p);
  const hue = hashHue(p.handle || p.agent_id);
  const cls = overall === "pro" ? "st-pro" : overall === "con" ? "st-con" : "st-neu";
  const label = overall === "pro" ? "PRO" : overall === "con" ? "CON" : "NEUTRAL";

  return (
    <article className="panel p-3">
      <div className="flex items-start gap-3">
        <span
          className="mono flex-none place-items-center"
          style={{
            width: 30, height: 30, borderRadius: "var(--r-2)", display: "grid",
            fontSize: 11, fontWeight: 600, color: `hsl(${hue} 65% 72%)`,
            background: `hsl(${hue} 50% 16%)`, border: `1px solid hsl(${hue} 50% 30%)`,
          }}
          aria-hidden
        >
          {initials(p.name, p.handle)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name ?? "agent"}</span>
            <span className={`badge ${cls}`}>{label}</span>
            {p.kind === "reply" && <span className="badge">reply</span>}
            {p.kind === "system" && <span className="badge">system</span>}
            {p.is_fallback && <span className="badge s-warn">fallback</span>}
            <span className="mono ml-auto text-[11px]" style={{ color: "var(--fg-4)" }}>
              T{String(p.tick).padStart(2, "0")}
            </span>
          </div>

          <p className="t-post mt-1.5" style={{ color: "var(--fg-1)" }}>{p.text}</p>

          <div className="mono mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: "var(--fg-3)" }}>
            {p.parent_id && <span title="reply to">↳ {p.parent_id.slice(0, 14)}</span>}
            {p.cited_chunk_ids.map((c) => {
              const page = chunkPage(c);
              return (
                <span key={c} className="chip">
                  SOURCES {page != null ? `p. ${page}` : ""} · {c.slice(0, 6)}
                </span>
              );
            })}
            <span>👍 {p.likes}</span>
            <span>🔁 {p.reposts}</span>
            <span>↩ {p.replies}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
