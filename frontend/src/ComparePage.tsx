// Compare two runs: the original and a re-run with one intervention. Every
// difference is counted from stored rows; the label says it is a re-run, not a fork.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download } from "lucide-react";
import type { CompareResponse, CompareSide, Post } from "./types";
import * as api from "./api";
import { EmptyState, MockStripe, Spinner, StatusBadge } from "./common";
import { initials, postOverallStance } from "./run/helpers";

export default function ComparePage({ a, b, onBack, onOpen, onError }: {
  a: string;
  b: string;
  onBack: () => void;
  onOpen: (runId: string) => void;
  onError: (e: unknown) => void;
}) {
  const [data, setData] = useState<CompareResponse | null>(null);
  const [postsA, setPostsA] = useState<Post[]>([]);
  const [postsB, setPostsB] = useState<Post[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    Promise.all([
      api.compareRuns(a, b),
      api.listPosts(a, { limit: 2000, newest: true }),
      api.listPosts(b, { limit: 2000, newest: true }),
    ]).then(([cmp, pa, pb]) => {
      if (!alive) return;
      setData(cmp);
      setPostsA(pa.posts);
      setPostsB(pb.posts);
    }).catch((e) => {
      if (!alive) return;
      setFailed(true);
      onError(e);
    });
    return () => { alive = false; };
  }, [a, b, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const rounds = useMemo(() => {
    if (!data) return [];
    const left = new Map(data.left.rounds.map((r) => [r.tick, r]));
    const right = new Map(data.right.rounds.map((r) => [r.tick, r]));
    const maxTick = Math.max(0, ...left.keys(), ...right.keys());
    return Array.from({ length: maxTick }, (_, i) => {
      const tick = i + 1;
      return {
        tick,
        left: left.get(tick) ?? { tick, pro: 0, neu: 0, con: 0, total: 0 },
        right: right.get(tick) ?? { tick, pro: 0, neu: 0, con: 0, total: 0 },
      };
    });
  }, [data]);

  // Per-round stance-mix delta. Backend computes it from the same recorded buckets;
  // the client derivation is only a fallback for older stored responses.
  const mixRows = useMemo(() => {
    if (!data) return [];
    if (data.diffs.rounds_mix) return data.diffs.rounds_mix;
    return rounds
      .filter((r) => r.left.total > 0 || r.right.total > 0)
      .map((r) => ({
        tick: r.tick,
        left: { pro: r.left.pro, neu: r.left.neu, con: r.left.con, total: r.left.total },
        right: { pro: r.right.pro, neu: r.right.neu, con: r.right.con, total: r.right.total },
        delta_pro: r.right.pro - r.left.pro,
        delta_neu: r.right.neu - r.left.neu,
        delta_con: r.right.con - r.left.con,
      }));
  }, [data, rounds]);

  if (failed) {
    return (
      <div className="pt-8">
        <EmptyState title="Could not load the comparison"
                    body="One of the runs may have been deleted, or the backend is unreachable."
                    action={<div className="flex gap-2">
                      <button className="btn btn-primary" onClick={() => setNonce((n) => n + 1)}>Retry</button>
                      <button className="btn btn-ghost" onClick={onBack}>Back to simulations</button>
                    </div>} />
      </div>
    );
  }
  if (!data) return <div className="pt-8"><Spinner label="Comparing runs…" /></div>;

  const max = Math.max(1, ...rounds.flatMap((r) => [r.left.total, r.right.total]));
  const mock = data.left.run.provider?.name === "mock" || data.right.run.provider?.name === "mock";
  const linked = data.linked === true;
  const rightIsChild = data.right.run.parent_run_id === data.left.run.id;
  const leftLabel = linked ? (rightIsChild ? "Original" : "Intervention re-run") : "Run A";
  const rightLabel = linked ? (rightIsChild ? "Intervention re-run" : "Original") : "Run B";
  const selectedA = selected == null ? [] : postsA.filter((p) => p.tick === selected);
  const selectedB = selected == null ? [] : postsB.filter((p) => p.tick === selected);

  return (
    <div className="pt-6 md:pt-8">
      <button className="btn btn-ghost btn-sm" onClick={onBack}>
        <ArrowLeft size={14} /> Simulations
      </button>
      <div className="mb-5 mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="eyebrow">Controlled comparison</span>
          <h1 className="t-display mt-1">Compare runs</h1>
          <p className="t-body fg-2 mt-2" style={{ maxWidth: 760 }}>{data.label}</p>
          <p className="t-meta mt-1">
            {linked
              ? "The engine re-runs from round 1 with the same source, scenario, config and seed; this is not a fork of the original."
              : "These runs are not linked as original and intervention. They may use different sources, configs or models, so the differences below are descriptive, not causal."}{" "}
            Differences are counted from recorded posts.
          </p>
        </div>
        <div className="flex gap-2">
          <a className="btn btn-ghost btn-sm" href={api.exportUrl(data.left.run.id, "pdf")} download>
            <Download size={12} /> Original PDF
          </a>
          <a className="btn btn-ghost btn-sm" href={api.exportUrl(data.right.run.id, "pdf")} download>
            <Download size={12} /> Intervention PDF
          </a>
        </div>
      </div>

      {mock && <div className="mb-4"><MockStripe /></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <RunCard side={data.left} label={leftLabel} onOpen={onOpen} />
        <RunCard side={data.right} label={rightLabel} onOpen={onOpen} />
      </div>

      <section className="panel mt-4" aria-label="Counted differences">
        <div className="panel-head">
          <h2 className="t-h3">Counted differences</h2>
          <span className="t-meta">intervention minus original</span>
        </div>
        <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Diff label="Posts" value={data.diffs.posts} />
          <Diff label="Fallback posts" value={data.diffs.fallback_posts} />
          <Diff label="Citation references" value={data.diffs.citation_total} />
          <Diff label="Rounds present" value={data.diffs.rounds} />
        </dl>
      </section>

      <section className="panel mt-4" aria-labelledby="cmp-issues">
        <div className="panel-head flex-wrap">
          <h2 id="cmp-issues" className="t-h3">Recorded stance by issue</h2>
          <span className="t-meta">mean of recorded agent stances, first vs last round</span>
        </div>
        <div className="p-4">
          {(data.diffs.notes?.length ?? 0) > 0 && (
            <ul className="m-0 mb-2 flex list-none flex-col gap-1 p-0">
              {data.diffs.notes!.map((n) => (
                <li key={n} className="t-meta" style={{ color: "var(--fg-2)" }}>· {n}</li>
              ))}
            </ul>
          )}
          {data.diffs.issues && data.diffs.issues.length > 0 ? (
            <div className="overflow-x-auto" tabIndex={0} role="group"
                 aria-label="Recorded stance by issue — scrollable table">
              <table className="tbl" style={{ minWidth: 720 }}>
                <thead>
                  <tr><th>Issue</th><th className="r">Original start → end</th>
                    <th className="r">Intervention start → end</th>
                    <th className="r">Difference in movement</th><th className="r">Agents</th></tr>
                </thead>
                <tbody>
                  {data.diffs.issues.map((d) => (
                    <tr key={d.issue_id}>
                      <td>
                        <div className="fg-1">{d.name}</div>
                        <div className="t-meta" style={{ fontSize: 10.5 }}>
                          + toward {d.pro_label ?? "the pro side"} · − toward {d.con_label ?? "the con side"}
                        </div>
                      </td>
                      <td className="r mono">{fmt(d.left_start)} → {fmt(d.left_end)}</td>
                      <td className="r mono">{fmt(d.right_start)} → {fmt(d.right_end)}</td>
                      <td className="r mono" style={{
                        fontWeight: Math.abs(d.difference_in_movement) >= 0.05 ? 600 : 400,
                        color: Math.abs(d.difference_in_movement) < 0.005
                          ? "var(--fg-3)" : "var(--fg-1)",
                      }}>
                        {fmt(d.difference_in_movement)}
                      </td>
                      <td className="r mono t-meta">{d.agents_left} · {d.agents_right}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="t-meta mt-2">
                Stances are recorded by the engine after every round for every agent and every issue.
                Averages hide individual movement — the agents table shows each recorded path.
                The simulation does not establish that any intervention caused a stance change.
              </p>
            </div>
          ) : (
            <p className="t-meta">No comparable per-issue stance rows are recorded for both runs.</p>
          )}
        </div>
      </section>

      <section className="panel mt-4" aria-labelledby="cmp-ruler">
        <div className="panel-head flex-wrap">
          <h2 id="cmp-ruler" className="t-h3">Posts per round</h2>
          <span className="t-meta flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5"><span className="sg sg-pro" />Supports</span>
            <span className="inline-flex items-center gap-1.5"><span className="sg sg-neu" />Undecided</span>
            <span className="inline-flex items-center gap-1.5"><span className="sg sg-con" />Opposes</span>
            <span className="ml-2">top: original · bottom: intervention</span>
          </span>
        </div>
        <div className="overflow-x-auto p-4" tabIndex={0} role="group"
             aria-label="Posts per round — scrollable chart">
          {rounds.length === 0 ? (
            <p className="t-meta">No recorded rounds in either run.</p>
          ) : (
            <div className="grid" style={{ gridAutoFlow: "column", gridAutoColumns: "minmax(12px, 1fr)", gap: 4, minWidth: rounds.length * 14 }}>
              {rounds.map((r) => (
                <button key={r.tick} onClick={() => setSelected(selected === r.tick ? null : r.tick)}
                        aria-label={`Round ${String(r.tick).padStart(2, "0")}: original ${r.left.total} posts, intervention ${r.right.total}`}
                        style={{ background: "none", border: 0, padding: 0, cursor: "pointer",
                                 outline: selected === r.tick ? "1px solid var(--accent)" : "none",
                                 borderRadius: 2 }}>
                  <Stack counts={r.left} max={max} />
                  <div style={{ height: 2 }} />
                  <Stack counts={r.right} max={max} />
                  <span className="mono" style={{ display: "block", fontSize: 9, color: selected === r.tick ? "var(--accent-fg)" : "var(--fg-3)", marginTop: 3 }}>
                    {r.tick === 1 || r.tick === rounds.length || r.tick % 4 === 0 ? String(r.tick).padStart(2, "0") : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="t-meta mt-2">Click a round to see the posts behind it.</p>
        </div>
      </section>

      <section className="panel mt-4" aria-labelledby="cmp-mix">
        <div className="panel-head">
          <h2 id="cmp-mix" className="t-h3">Stance mix of the posts, round by round</h2>
          <span className="t-meta">original → intervention · and the difference</span>
        </div>
        <div className="overflow-x-auto" tabIndex={0} role="group"
             aria-label="Stance mix of the posts, round by round — scrollable table">
          {mixRows.length === 0 ? (
            <p className="t-meta p-4">No recorded rounds in either run.</p>
          ) : (
            <table className="tbl" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th rowSpan={2} style={{ verticalAlign: "middle" }}>Round</th>
                  <th colSpan={3} className="r">ORIGINAL — posts tagged supporting / undecided / opposed</th>
                  <th colSpan={3} className="r">INTERVENTION — posts tagged supporting / undecided / opposed</th>
                  <th colSpan={3} className="r" style={{ borderLeft: "1px solid var(--line-1)" }}>
                    INTERVENTION − ORIGINAL
                  </th>
                </tr>
                <tr>
                  <th className="r">Supports</th><th className="r">Undec.</th><th className="r">Opposed</th>
                  <th className="r">Supports</th><th className="r">Undec.</th><th className="r">Opposed</th>
                  <th className="r" style={{ borderLeft: "1px solid var(--line-1)" }}>Supports</th>
                  <th className="r">Undec.</th><th className="r">Opposed</th>
                </tr>
              </thead>
              <tbody>
                {mixRows.map((m) => (
                  <tr key={m.tick}>
                    <td className="mono">{String(m.tick).padStart(2, "0")}</td>
                    <td className="r mono">{m.left.pro}</td>
                    <td className="r mono">{m.left.neu}</td>
                    <td className="r mono">{m.left.con}</td>
                    <td className="r mono">{m.right.pro}</td>
                    <td className="r mono">{m.right.neu}</td>
                    <td className="r mono">{m.right.con}</td>
                    <td className="r mono" style={{ borderLeft: "1px solid var(--line-1)" }}>
                      {signed(m.delta_pro)}
                    </td>
                    <td className="r mono">{signed(m.delta_neu)}</td>
                    <td className="r mono">{signed(m.delta_con)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="t-meta mt-3 p-4">
            Each run's posts in that round are bucketed by the stance snapshot they carry.
            This counts posts, not agents or outcomes: one agent posting six times moves six rows.
          </p>
        </div>
      </section>

      <section className="panel mt-4" aria-labelledby="cmp-cites">
        <div className="panel-head">
          <h2 id="cmp-cites" className="t-h3">Citations by source passage</h2>
          <span className="t-meta">counted references</span>
        </div>
        <div className="overflow-x-auto" tabIndex={0} role="group"
             aria-label="Citations by source passage — scrollable table">
          <table className="tbl" style={{ minWidth: 640 }}>
            <thead>
              <tr><th>Page</th><th>Chunk</th><th>Heading</th><th className="r">Original</th>
                <th className="r">Intervention</th><th className="r">Δ</th></tr>
            </thead>
            <tbody>
              {citationRows(data).map((r) => (
                <tr key={r.chunk_id}>
                  <td className="mono">{r.page ?? "Not recorded"}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{r.chunk_id}</td>
                  <td className="ellipsis" style={{ maxWidth: 260 }}>{r.heading ?? "Not recorded"}</td>
                  <td className="r mono">{r.left}</td>
                  <td className="r mono">{r.right}</td>
                  <td className="r mono" style={{ color: r.right === r.left ? "var(--fg-3)" : r.right > r.left ? "var(--ok-fg)" : "var(--warn-fg)" }}>
                    {r.right - r.left > 0 ? "+" : ""}{r.right - r.left}
                  </td>
                </tr>
              ))}
              {citationRows(data).length === 0 && (
                <tr><td colSpan={6} className="t-meta">No citations recorded in either run.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel mt-4" aria-labelledby="cmp-posts">
        <div className="panel-head">
          <h2 id="cmp-posts" className="t-h3">
            Posts behind the difference — {selected == null ? "choose a round" : `Round ${String(selected).padStart(2, "0")}`}
          </h2>
          {selected != null && <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Clear</button>}
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          {selected == null ? (
            <p className="t-meta lg:col-span-2">Select a round in the ruler above to compare the recorded posts side by side.</p>
          ) : (
            <>
              <PostColumn title={`Original · ${selectedA.length} posts`} posts={selectedA} />
              <PostColumn title={`Intervention · ${selectedB.length} posts`} posts={selectedB} />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function RunCard({ side, label, onOpen }: { side: CompareSide; label: string; onOpen: (id: string) => void }) {
  const run = side.run;
  return (
    <div className="panel panel-body flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge">{label}</span>
        <StatusBadge status={run.status} />
        {run.provider?.name === "mock" && <span className="badge s-warn">mock</span>}
      </div>
      <button className="t-h2 row-link text-left" onClick={() => onOpen(run.id)}>{run.name}</button>
      <p className="t-meta">
        {run.provider?.name ?? "provider not recorded"} · {run.provider?.model ?? "model not recorded"} ·
        {" "}seed <span className="mono">{run.seed}</span>
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 t-meta">
        <span><span className="mono fg-1">{side.posts}</span> posts</span>
        <span><span className="mono fg-1">{side.llm_calls}</span> LLM calls</span>
        <span><span className="mono fg-1">{side.fallback_posts}</span> template posts</span>
        <span><span className="mono fg-1">{run.agents}</span> agents</span>
      </div>
      {run.error && <p className="t-meta" style={{ color: "var(--err-fg)" }}>{String(run.error.message ?? "run error")}</p>}
      <button className="btn btn-ghost btn-sm self-start" onClick={() => onOpen(run.id)}>Open run</button>
    </div>
  );
}

function Diff({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <dt className="eyebrow">{label}</dt>
      <dd className="stat-v m-0">{value > 0 ? "+" : ""}{value}</dd>
    </div>
  );
}

function Stack({ counts, max }: { counts: { pro: number; neu: number; con: number; total: number }; max: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end",
                  height: 74, gap: 1, background: "var(--bg-2)", borderRadius: 2, overflow: "hidden" }}
         title={`${counts.total} posts — Supports ${counts.pro}, Undecided ${counts.neu}, Opposes ${counts.con}`}>
      {(["con", "neu", "pro"] as const).map((k) => counts[k] > 0 ? (
        <i key={k} style={{ display: "block", height: `${(counts[k] / max) * 100}%`, background: `var(--${k})` }} />
      ) : null)}
    </div>
  );
}

function citationRows(data: CompareResponse) {
  const ids = new Set([...data.left.citations, ...data.right.citations].map((c) => c.chunk_id));
  return [...ids].map((id) => {
    const l = data.left.citations.find((c) => c.chunk_id === id);
    const r = data.right.citations.find((c) => c.chunk_id === id);
    const c = l ?? r;
    const page = c?.page_start != null
      ? `${c.page_start}${c.page_end != null && c.page_end !== c.page_start ? `–${c.page_end}` : ""}`
      : null;
    return {
      chunk_id: id,
      page,
      heading: c?.heading ?? null,
      left: l?.citations ?? 0,
      right: r?.citations ?? 0,
    };
  }).sort((x, y) => (y.left + y.right) - (x.left + x.right));
}

function fmt(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n}`;
}

function PostColumn({ title, posts }: { title: string; posts: Post[] }) {
  return (
    <div>
      <p className="eyebrow mb-2">{title}</p>
      {posts.length === 0 ? (
        <p className="t-meta">No posts recorded in this round.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {posts.slice(0, 30).map((p) => {
            const stance = postOverallStance(p);
            return (
              <li key={p.id} className="panel-2 p-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`av av-xs av-${stance}`} aria-hidden>{initials(p.name, p.handle)}</span>
                  <span style={{ fontWeight: 600 }}>{p.name ?? p.agent_id}</span>
                  <span className={`stance stance-${stance}`}>
                    <span className={`sg sg-${stance}`} />
                    {stance === "pro" ? "PRO" : stance === "con" ? "CON" : "NEUTRAL"}
                  </span>
                  <span className="t-id ml-auto">R{String(p.tick).padStart(2, "0")}</span>
                </div>
                <p className="t-post mt-1.5" style={{ fontSize: 13 }}>{p.text}</p>
                {p.cited_chunk_ids.length > 0 && (
                  <p className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.cited_chunk_ids.map((c) => <span key={c} className="cite" style={{ cursor: "default" }}>{c}</span>)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
