// Findings: a research-briefing reading surface built on the computed narrative.
//
// The prose here is derived from counted rows by app/analytics/narrative.py — no
// model wrote it — so every sentence is traceable to a number in the database. The
// page answers the reader's questions first and shows the supporting numbers second.
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Search, ShieldCheck } from "lucide-react";
import type { NarrativeIssue, NarrativeResponse, NarrativeStakeholder } from "../types";

const STRENGTH_STYLE: Record<string, { label: string; color: string }> = {
  strong: { label: "Strong evidence", color: "var(--pro-fg)" },
  moderate: { label: "Moderate evidence", color: "var(--accent)" },
  indicative: { label: "Indicative only", color: "var(--warn-fg)" },
};

function Strength({ value }: { value: string }) {
  const s = STRENGTH_STYLE[value] ?? { label: value, color: "var(--fg-3)" };
  return (
    <span className="badge" style={{ borderColor: s.color, color: s.color }} title="Strength of evidence, not a probability">
      <ShieldCheck size={11} /> {s.label}
    </span>
  );
}

function StanceBar({ pro, neu, con }: { pro: number; neu: number; con: number }) {
  const total = Math.max(1, pro + neu + con);
  return (
    <div className="flex h-2 w-full overflow-hidden" style={{ borderRadius: 99, background: "var(--bg-0)" }}
         role="img" aria-label={`${pro} support, ${neu} undecided, ${con} oppose`}>
      <span style={{ width: `${(pro / total) * 100}%`, background: "var(--pro)" }} />
      <span style={{ width: `${(neu / total) * 100}%`, background: "var(--neu)" }} />
      <span style={{ width: `${(con / total) * 100}%`, background: "var(--con)" }} />
    </div>
  );
}

function Signed({ v, suffix = "" }: { v: number | null; suffix?: string }) {
  if (v == null) return <span className="fg-4">—</span>;
  const color = v > 0.05 ? "var(--pro-fg)" : v < -0.05 ? "var(--con-fg)" : "var(--fg-2)";
  return <span className="mono" style={{ color }}>{v > 0 ? "+" : ""}{v.toFixed(2)}{suffix}</span>;
}

const ANSWER_META: { key: keyof NarrativeResponse["answers"]; title: string; accent?: boolean }[] = [
  { key: "what_happened", title: "What happened", accent: true },
  { key: "why", title: "Why it happened", accent: true },
  { key: "who_drove_it", title: "Who drove it", accent: true },
  { key: "what_evidence", title: "What evidence mattered" },
  { key: "agreement", title: "Where there is agreement" },
  { key: "disagreement", title: "Where there is disagreement" },
  { key: "what_changed", title: "What changed" },
  { key: "watch", title: "What to pay attention to" },
];

export default function FindingsView({ data }: { data: NarrativeResponse }) {
  const [issueQuery, setIssueQuery] = useState("");
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const issues = useMemo(() => {
    const q = issueQuery.trim().toLowerCase();
    if (!q) return data.issues;
    return data.issues.filter((i) =>
      [i.name, i.question, i.issue_id, ...i.supporters, ...i.opponents]
        .join(" ").toLowerCase().includes(q));
  }, [data.issues, issueQuery]);

  const s = data.scale;

  return (
    <div className="flex flex-col gap-6">
      {/* ---------- provenance band ---------- */}
      <div className="panel">
        <div className="panel-body flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="eyebrow">Findings briefing</div>
            <h2 className="t-h1 mt-1">
              {s.overall_final != null
                ? `Opinion settled at ${s.overall_final > 0 ? "net support" : s.overall_final < 0 ? "net opposition" : "a split"}`
                : "No completed rounds yet"}
            </h2>
            <p className="t-body fg-2 mt-1" style={{ maxWidth: 720 }}>
              {s.agents} agents · {s.rounds_completed}
              {s.rounds_configured ? `/${s.rounds_configured}` : ""} rounds · {s.posts} posts ·{" "}
              {s.issues} issues · {s.groups} stakeholder groups
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className="badge" title={data.provenance.method}>
              <ShieldCheck size={12} /> Computed, not generated
            </span>
            <span className="t-meta" style={{ maxWidth: 280, textAlign: "right" }}>
              Derived from recorded rows. No model wrote this text.
            </span>
          </div>
        </div>
      </div>

      {/* ---------- the eight questions ---------- */}
      <section aria-labelledby="answers-h" className="flex flex-col gap-3">
        <h3 id="answers-h" className="t-h2">Executive findings</h3>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ANSWER_META.map(({ key, title, accent }) => (
            <div key={key} className="panel-2 p-4"
                 style={accent ? { borderLeft: "3px solid var(--accent)" } : undefined}>
              <div className="eyebrow">{title}</div>
              <p className="t-body mt-2" style={{ color: "var(--fg-1)" }}>{data.answers[key]}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- key findings ---------- */}
      {data.key_findings.length > 0 && (
        <section aria-labelledby="kf-h" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="kf-h" className="t-h2">Key findings</h3>
            <span className="t-meta">Ordered by how much of the record they explain</span>
          </div>
          {data.key_findings.map((f, i) => (
            <article key={f.id} className="panel">
              <div className="panel-body flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h4 className="t-h3 flex items-baseline gap-2">
                    <span className="mono" style={{ color: "var(--fg-3)" }}>{String(i + 1).padStart(2, "0")}</span>
                    {f.headline}
                  </h4>
                  <Strength value={f.strength} />
                </div>
                <p className="t-body" style={{ maxWidth: 860 }}>{f.explanation}</p>

                {f.data.length > 0 && (
                  <dl className="m-0 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {f.data.map((d) => (
                      <div key={d.label} className="panel-2 p-2.5">
                        <dt className="t-meta">{d.label}</dt>
                        <dd className="mono mt-0.5" style={{ fontSize: 15, color: "var(--fg-1)" }}>{d.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                <div className="panel-2 p-3">
                  <div className="eyebrow">Why it matters</div>
                  <p className="t-body fg-2 mt-1">{f.why_it_matters}</p>
                </div>

                {(f.issue_ids.length > 0 || f.groups.length > 0) && (
                  <div className="flex flex-wrap gap-1.5">
                    {f.issue_ids.map((id) => (
                      <span key={id} className="chip" style={{ cursor: "default" }}>{id}</span>
                    ))}
                    {f.groups.map((g) => (
                      <span key={g} className="chip" style={{ cursor: "default" }}>{g}</span>
                    ))}
                    {f.agents.slice(0, 4).map((a) => (
                      <span key={a} className="chip" style={{ cursor: "default" }}>@{a}</span>
                    ))}
                  </div>
                )}

                {f.evidence.length > 0 && (
                  <details>
                    <summary className="t-meta cursor-pointer select-none">
                      Evidence cited ({f.evidence.length} passage{f.evidence.length === 1 ? "" : "s"})
                    </summary>
                    <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                      {f.evidence.map((e) => (
                        <li key={e.chunk_id} className="panel-2 p-2.5">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="t-id">{e.chunk_id}</span>
                            {e.page_start != null && (
                              <span className="cite-p">p. {e.page_start}
                                {e.page_end != null && e.page_end !== e.page_start ? `–${e.page_end}` : ""}</span>
                            )}
                            {e.heading && <span className="t-meta truncate">{e.heading}</span>}
                            <span className="t-meta ml-auto">{e.citations} citation(s)</span>
                          </div>
                          <p className="t-meta mt-1">{e.excerpt}…</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <p className="t-meta">{f.strength_reason}</p>
              </div>
            </article>
          ))}
        </section>
      )}

      {/* ---------- issue analysis ---------- */}
      <section aria-labelledby="issues-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="issues-h" className="t-h2">Issue analysis</h3>
            <p className="t-meta">Every configured issue, whether or not it moved.</p>
          </div>
          <label className="field" style={{ minWidth: 220 }}>
            <span className="label sr-only">Search issues</span>
            <span className="flex items-center gap-2">
              <Search size={14} style={{ color: "var(--fg-3)" }} />
              <input className="input" placeholder="Search issues…" value={issueQuery}
                     onChange={(e) => setIssueQuery(e.target.value)} />
            </span>
          </label>
        </div>

        {issues.length === 0 && (
          <p className="t-meta">No issue matches “{issueQuery}”.</p>
        )}
        <div className="flex flex-col gap-2">
          {issues.map((iss) => (
            <IssueCard key={iss.issue_id} issue={iss}
                       open={openIssue === iss.issue_id}
                       onToggle={() => setOpenIssue(openIssue === iss.issue_id ? null : iss.issue_id)} />
          ))}
        </div>
      </section>

      {/* ---------- stakeholder analysis ---------- */}
      <section aria-labelledby="stake-h" className="flex flex-col gap-3">
        <div>
          <h3 id="stake-h" className="t-h2">Stakeholder analysis</h3>
          <p className="t-meta">What each configured group actually did, not just what it was configured to be.</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {data.stakeholders.map((g) => <StakeholderCard key={g.name} group={g} />)}
        </div>
      </section>

      {/* ---------- timeline ---------- */}
      {data.timeline.length > 0 && (
        <section aria-labelledby="tl-h" className="panel">
          <div className="panel-head">
            <h3 id="tl-h" className="t-h3">Moments that changed the conversation</h3>
            <span className="t-meta">Stance changes of 0.25 or more</span>
          </div>
          <div className="panel-body">
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {data.timeline.map((t, i) => (
                <li key={`${t.tick}-${i}`} className="flex items-start gap-3">
                  <span className="mono t-id" style={{ minWidth: 36 }}>R{String(t.tick).padStart(2, "0")}</span>
                  <span className="min-w-0">
                    <span className="t-body">{t.label}</span>
                    <span className="t-meta block">{t.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}

      {/* ---------- uncertainty ---------- */}
      <section aria-labelledby="unc-h" className="panel">
        <div className="panel-head">
          <h3 id="unc-h" className="t-h3 flex items-center gap-2">
            <AlertTriangle size={15} style={{ color: "var(--warn-fg)" }} /> What remains uncertain
          </h3>
          <span className="t-meta">Read this before quoting any number above</span>
        </div>
        <div className="panel-body">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {data.uncertainty.map((u, i) => (
              <li key={i} className="t-body fg-2 flex gap-2">
                <span aria-hidden style={{ color: "var(--fg-4)" }}>–</span>
                <span>{u}</span>
              </li>
            ))}
            <li className="t-body fg-2 flex gap-2">
              <span aria-hidden style={{ color: "var(--fg-4)" }}>–</span>
              <span>
                Predictive accuracy has not yet been externally validated. These findings
                describe what happened inside this simulation, not what would happen in the
                world.
              </span>
            </li>
          </ul>
        </div>
      </section>

      {/* ---------- raw counted detail (collapsed) ---------- */}
      <div>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowDetail(!showDetail)}
                aria-expanded={showDetail}>
          {showDetail ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {showDetail ? "Hide" : "Show"} the raw counts behind these findings
        </button>
      </div>
      {showDetail && <CountedDetail data={data} />}
    </div>
  );
}

/** The counted rows behind the briefing: unrounded, uninterpreted, collapsible. */
function CountedDetail({ data }: { data: NarrativeResponse }) {
  const s = data.scale;
  const scale: [string, string | number][] = [
    ["Agents seeded", s.agents],
    ["Posts recorded", s.posts],
    ["Rounds completed", s.rounds_configured ? `${s.rounds_completed} of ${s.rounds_configured}` : s.rounds_completed],
    ["Stance observations", s.stance_observations],
    ["Issues configured", s.issues],
    ["Stakeholder groups", s.groups],
    ["Posts citing a source", s.posts_with_source],
    ["Distinct passages cited", s.distinct_chunks_cited],
  ];
  const num = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits));
  const signed = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);

  return (
    <section id="counted-detail" className="panel" aria-labelledby="cd-h">
      <div className="panel-head">
        <h3 id="cd-h" className="t-h3">Counted detail</h3>
        <span className="t-meta">The recorded numbers behind the briefing — no interpretation added</span>
      </div>
      <div className="panel-body flex flex-col gap-5">
        <div>
          <div className="eyebrow mb-2">Scale</div>
          <dl className="m-0 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {scale.map(([label, value]) => (
              <div key={label} className="panel-2 p-2">
                <dt className="t-meta">{label}</dt>
                <dd className="mono m-0 mt-0.5" style={{ fontSize: 15, color: "var(--fg-1)" }}>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="t-meta mt-2">
            Method: {data.provenance.method} Predictive accuracy:{" "}
            {data.provenance.predictive_accuracy === "not_validated"
              ? "not validated — no accuracy figure is claimed for this run."
              : data.provenance.predictive_accuracy}
          </p>
        </div>

        <div>
          <div className="eyebrow mb-2">Stance by issue</div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th scope="col">Issue</th>
                  <th scope="col">Observed</th>
                  <th scope="col">Start</th>
                  <th scope="col">End</th>
                  <th scope="col">Change</th>
                  <th scope="col">Spread</th>
                  <th scope="col">Pro / undecided / con</th>
                </tr>
              </thead>
              <tbody>
                {data.issues.map((i) => (
                  <tr key={i.issue_id}>
                    <td><span className="t-id">{i.issue_id}</span> {i.name}</td>
                    <td className="mono">{i.observed_agents}</td>
                    <td className="mono">{signed(i.initial_mean)}</td>
                    <td className="mono">{signed(i.final_mean)}</td>
                    <td className="mono">{signed(i.delta)}</td>
                    <td className="mono">{num(i.spread)}</td>
                    <td className="mono">{i.pro_agents} / {i.neutral_agents} / {i.con_agents}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="eyebrow mb-2">Stance by stakeholder group</div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Agents</th>
                  <th scope="col">Start</th>
                  <th scope="col">End</th>
                  <th scope="col">Change</th>
                  <th scope="col">Role</th>
                </tr>
              </thead>
              <tbody>
                {data.stakeholders.map((g) => (
                  <tr key={g.name}>
                    <td>{g.name}</td>
                    <td className="mono">{g.agents}</td>
                    <td className="mono">{signed(g.initial_mean)}</td>
                    <td className="mono">{signed(g.final_mean)}</td>
                    <td className="mono">{signed(g.delta)}</td>
                    <td className="t-meta">{g.network_role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="t-meta m-0">
          Computed {new Date(data.generated_at).toLocaleString()} from run {data.run_id}.
        </p>
      </div>
    </section>
  );
}

function IssueCard({ issue, open, onToggle }: {
  issue: NarrativeIssue; open: boolean; onToggle: () => void;
}) {
  const moved = issue.delta != null && Math.abs(issue.delta) >= 0.1;
  return (
    <div className="panel">
      <button className="panel-head w-full text-left" onClick={onToggle} aria-expanded={open}
              style={{ minHeight: 56, cursor: "pointer" }}>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="t-h3 truncate">{issue.name}</span>
          <span className="t-meta truncate">{issue.issue_id} · {issue.observed_agents} agents observed</span>
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <span className="t-meta">start <Signed v={issue.initial_mean} /></span>
          <span className="t-meta">end <Signed v={issue.final_mean} /></span>
          {moved && <span className="badge" style={{ color: "var(--accent)" }}>moved <Signed v={issue.delta} /></span>}
          {!moved && <span className="badge">stable</span>}
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
      </button>
      {open && (
        <div className="panel-body flex flex-col gap-4">
          {issue.question && (
            <div>
              <div className="eyebrow">What the issue was about</div>
              <p className="t-body fg-2 mt-1">{issue.question}</p>
            </div>
          )}

          <div>
            <div className="eyebrow mb-1">Final landscape</div>
            <StanceBar pro={issue.pro_agents} neu={issue.neutral_agents} con={issue.con_agents} />
            <div className="mt-1 flex flex-wrap gap-3 t-meta">
              <span><span className="sg sg-pro" /> {issue.pro_agents} support</span>
              <span><span className="sg sg-neu" /> {issue.neutral_agents} undecided</span>
              <span><span className="sg sg-con" /> {issue.con_agents} oppose</span>
              {issue.spread != null && <span>spread {issue.spread.toFixed(2)}</span>}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SideList title="Ended supportive" items={issue.supporters} tone="var(--pro-fg)" />
            <SideList title="Ended opposed" items={issue.opponents} tone="var(--con-fg)" />
            <SideList title="Remained undecided" items={issue.undecided} tone="var(--neu-fg)" />
          </div>

          {issue.movement.length > 0 && (
            <div>
              <div className="eyebrow mb-1">Who moved</div>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {issue.movement.map((m) => (
                  <li key={m.group} className="t-body fg-2">
                    <strong style={{ color: "var(--fg-1)" }}>{m.group}</strong>{" "}
                    moved {m.direction} by {m.delta > 0 ? "+" : ""}{m.delta.toFixed(2)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="eyebrow mb-1">Why it changed</div>
            <p className="t-body fg-2">
              {Object.keys(issue.triggers).length === 0
                ? "No stance changes on this issue were attributed to a specific trigger."
                : Object.entries(issue.triggers)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, n]) => `${n} change(s) attributed to ${k.replace(/_/g, " ")}`)
                    .join("; ") + "."}
            </p>
          </div>

          {issue.evidence.length > 0 && (
            <div>
              <div className="eyebrow mb-1">Key evidence</div>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {issue.evidence.map((e) => (
                  <li key={e.chunk_id} className="panel-2 p-2.5">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="t-id">{e.chunk_id}</span>
                      {e.page_start != null && <span className="cite-p">p. {e.page_start}</span>}
                      <span className="t-meta ml-auto">{e.citations} citation(s)</span>
                    </div>
                    <p className="t-meta mt-1">{e.excerpt}…</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {issue.top_agents.length > 0 && (
            <div>
              <div className="eyebrow mb-1">Agents who spoke most on this issue</div>
              <div className="flex flex-wrap gap-1.5">
                {issue.top_agents.map((a) => (
                  <span key={a.agent_id} className="chip" style={{ cursor: "default" }}
                        title={`${a.group} · ${a.posts} posts · mean ${a.mean_stance}`}>
                    @{a.handle || a.agent_id} · {a.posts}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="panel-2 p-3">
            <div className="eyebrow">How much weight this issue can bear</div>
            <p className="t-body fg-2 mt-1">{issue.strength_reason}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function SideList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div className="panel-2 p-3">
      <div className="eyebrow" style={{ color: tone }}>{title}</div>
      {items.length === 0 ? (
        <p className="t-meta mt-1">None recorded</p>
      ) : (
        <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
          {items.map((i) => <li key={i} className="t-body fg-2">{i}</li>)}
        </ul>
      )}
    </div>
  );
}

function StakeholderCard({ group }: { group: NarrativeStakeholder }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="t-h3 truncate">{group.name}</span>
          <span className="t-meta">
            {group.agents} agent{group.agents === 1 ? "" : "s"} · {group.network_role}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="t-meta">moved <Signed v={group.delta} /></span>
        </span>
      </div>
      <div className="panel-body flex flex-col gap-3">
        {group.description && <p className="t-body fg-2">{group.description}</p>}

        {group.agents === 0 ? (
          <p className="banner banner-warn m-0">
            <span>This group was configured but received no agents, so it contributed nothing to the result.</span>
          </p>
        ) : (
          <>
            <dl className="m-0 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="panel-2 p-2">
                <dt className="t-meta">Start</dt>
                <dd className="mono"><Signed v={group.initial_mean} /></dd>
              </div>
              <div className="panel-2 p-2">
                <dt className="t-meta">End</dt>
                <dd className="mono"><Signed v={group.final_mean} /></dd>
              </div>
              <div className="panel-2 p-2">
                <dt className="t-meta">Influence</dt>
                <dd className="mono">{group.influence ?? "—"}</dd>
              </div>
              <div className="panel-2 p-2">
                <dt className="t-meta">Power</dt>
                <dd className="mono">{group.institutional_power ?? "—"}</dd>
              </div>
            </dl>

            {group.priority_issues.length > 0 && (
              <div>
                <div className="eyebrow mb-1">Issues that mattered most to this group</div>
                <div className="flex flex-wrap gap-1.5">
                  {group.priority_issues.map((id) => (
                    <span key={id} className="chip" style={{ cursor: "default" }}>{id}</span>
                  ))}
                </div>
              </div>
            )}

            {group.concerns.length > 0 && (
              <div>
                <div className="eyebrow mb-1">Key concerns</div>
                <p className="t-body fg-2">{group.concerns.join(" · ")}</p>
              </div>
            )}

            {group.representatives.length > 0 && (
              <div>
                <div className="eyebrow mb-1">Representative agents</div>
                <div className="flex flex-wrap gap-1.5">
                  {group.representatives.map((r) => (
                    <span key={r.agent_id} className="chip" style={{ cursor: "default" }}>
                      @{r.handle || r.agent_id} · {r.posts} posts
                    </span>
                  ))}
                </div>
              </div>
            )}
            <p className="t-meta">{group.strength_reason}</p>
          </>
        )}
      </div>
    </div>
  );
}
