// Events: controlled interventions. Composer + log, violet reserved for events.
// Scheduled events persist server-side (events table) until the engine marks them
// fired. Audience: everyone → public newsroom broadcast; a stakeholder group →
// private briefing (only those agents will remember it).
import { useEffect, useMemo, useState } from "react";
import { GitBranch, Megaphone, Zap } from "lucide-react";
import type { RunDetail } from "../types";
import * as api from "../api";
import { Spinner } from "../common";

type RunEventMap = Awaited<ReturnType<typeof api.listRunEvents>>["events"];

const EV_BADGE: React.CSSProperties = {
  color: "var(--evt-fg)", background: "var(--evt-soft)", borderColor: "var(--evt-line)",
};

export default function EventsTab({ runId, run, bumpKey, onError, embedded = false, onBranched }: {
  runId: string;
  run: RunDetail;
  bumpKey: number;
  onError: (e: unknown) => void;
  embedded?: boolean;
  onBranched?: (runId: string) => void;
}) {
  const [events, setEvents] = useState<RunEventMap | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [deliverAt, setDeliverAt] = useState("");
  const [audience, setAudience] = useState("all");
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);
  const [branchNote, setBranchNote] = useState<string | null>(null);

  useEffect(() => {
    api.listRunEvents(runId).then((r) => setEvents(r.events)).catch((e) => {
      setEvents([]);
      onError(e);
    });
    api.listAgents(runId).then((a) => {
      const g = [...new Set(a.agents.map((x) => x.group).filter(Boolean))] as string[];
      setGroups(g);
    }).catch(() => { /* no agents yet — audience stays "everyone" */ });
  }, [runId, bumpKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function inject() {
    if (!text.trim() || !events) return;
    setBusy(true);
    onError(null);
    try {
      const tick = deliverAt.trim() === "" ? null : Number(deliverAt);
      await api.injectEvent(runId, text.trim(), {
        tick: tick === null || Number.isNaN(tick) ? null : tick,
        audience: audience === "all" ? "all" : audience,
      });
      setPosted(audience === "all" ? "ok" : `private:${audience}`);
      setText("");
      setDeliverAt("");
      setAudience("all");
      const refreshed = await api.listRunEvents(runId);
      setEvents(refreshed.events);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function branch() {
    if (!text.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const r = await api.branchRun(runId, text.trim(), audience === "all" ? "all" : audience);
      setBranchNote("New run created from round 1 with this intervention. The original is untouched.");
      onBranched?.(r.id);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  const authored = useMemo(() => (events ?? []).filter((e) => {
    if (e.kind === "event" || e.kind === "scene_event" || e.kind === "injected" || e.kind === "scheduled") {
      return true;
    }
    // kind "news" rows for live-injected events are already covered by their persisted
    // scheduled row — only scenario-authored news (no "live" flag) needs its own row.
    if (e.kind === "news") {
      return !((e.payload as { live?: boolean }).live);
    }
    return false;
  }), [events]);

  const scheduled = authored.filter((e) => e.kind === "scheduled" && (e.payload as { status?: string }).status === "scheduled");
  const nextTick = Math.max(1, (run.last_completed_tick || 0) + 1);
  const canControl = ["draft", "ready", "running", "seeding", "paused", "interrupted"].includes(run.status);

  return (
    <div className={`grid items-start gap-4 ${embedded ? "" : "lg:grid-cols-2"}`}>
      <div className="panel">
        <div className="panel-head">
          <h2 className="t-h3 flex items-center gap-2">
            <Zap size={14} style={{ color: "var(--evt-fg)" }} /> Add an intervention
          </h2>
          <span className="t-meta">intervention</span>
        </div>
        <div className="panel-body flex flex-col gap-3">
          <p className="t-body fg-2" style={{ fontSize: 13 }}>
            Interventions enter the simulated world at the round you choose. Everyone gets a public
            newsroom broadcast, or you can deliver a private briefing to one stakeholder group —
            only those agents will remember it. Schedules are stored on the server, so they
            survive a restart.
          </p>
          <textarea
            className="input"
            placeholder="e.g. Overnight polls show public support dropping six points."
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field">
              <span className="label">Deliver at round <span className="opt">(default: next round)</span></span>
              <input
                className="input"
                inputMode="numeric"
                placeholder={`next round (R${String(nextTick).padStart(2, "0")})`}
                value={deliverAt}
                onChange={(e) => setDeliverAt(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
            <label className="field">
              <span className="label">Audience</span>
              <select className="input" value={audience} onChange={(e) => setAudience(e.target.value)}>
                <option value="all">everyone — public broadcast</option>
                {groups.map((g) => (
                  <option key={g} value={g}>only “{g}” — private briefing</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" onClick={inject}
                    disabled={!canControl || !text.trim() || busy || events === null}>
              <Megaphone size={14} /> {audience === "all" ? "Record intervention" : "Brief group"}
            </button>
            <button className="btn" onClick={branch} disabled={!text.trim() || busy}
                    title="Creates a new run from round 1 with the same setup and seed; the original is untouched">
              <GitBranch size={14} /> Re-run with this intervention
            </button>
            {busy && <Spinner label="Recording…" />}
          </div>
          <p className="t-meta">
            A controlled comparison uses <strong>Re-run with this intervention</strong>: the engine
            does not fork state, so the new run starts from round 1 and is labelled as a re-run.
          </p>
          {!canControl && (
            <p className="t-meta">
              {["completed", "failed"].includes(run.status)
                ? `This run is ${run.status} — no further rounds will run, so a recorded intervention cannot be delivered here. Use “Re-run with this intervention” to compare a fresh run from round 1.`
                : `This run is ${run.status} — interventions cannot be delivered in this state.`}
            </p>
          )}
          {canControl && ["draft", "ready"].includes(run.status) && (
            <p className="t-meta">Scheduled interventions are stored now and delivered once the run starts.</p>
          )}
          {branchNote && <div className="banner banner-info" style={{ fontSize: 12.5 }}><span>{branchNote}</span></div>}
          {posted && (
            <div className="banner banner-info" style={{ fontSize: 12.5 }}>
              <span className={`sg sg-evt`} style={{ marginTop: 3 }} />
              <span>
                {posted.startsWith("private")
                  ? `Private briefing recorded — only the “${posted.slice(8)}” agents will encounter it at the chosen tick.`
                  : "Event recorded — agents will encounter it from the tick you chose."}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="panel-head">
          <span className="eyebrow">Intervention log — {authored.length} recorded</span>
          <span className="t-meta">{scheduled.length} pending</span>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {events === null ? (
            <div className="panel-body"><Spinner /></div>
          ) : authored.length === 0 ? (
            <div className="empty" style={{ padding: "36px 24px" }}>
              <span className="empty-ic"><Zap size={20} style={{ color: "var(--evt-fg)" }} /></span>
              <p className="t-h3">No interventions yet</p>
              <p className="t-meta" style={{ maxWidth: 300 }}>
                No interventions have been added to this simulation. An intervention can nudge the
                world mid-run — a poll, a headline, a private briefing.
              </p>
            </div>
          ) : authored.map((e, i) => {
            const p = e.payload as {
              text?: string; audience?: string; audience_size?: number;
              private?: boolean; status?: string; chunk_id?: string; pushed_to?: number;
            };
            const isScheduled = e.kind === "scheduled" && p.status === "scheduled";
            const isPrivate = p.private === true || (p.audience && p.audience !== "all");
            return (
              <div key={i} className="px-4 py-3" style={i < authored.length - 1 ? { borderBottom: "1px solid var(--line-1)" } : undefined}>
                <div className="flex flex-wrap items-center gap-2">
                  {isScheduled ? (
                    <span className="badge" style={EV_BADGE}>SCHEDULED → R{String(e.tick).padStart(2, "0")}</span>
                  ) : (
                    <span className="badge" style={EV_BADGE}>DELIVERED · R{String(e.tick).padStart(2, "0")}</span>
                  )}
                  {isPrivate ? (
                    <span className="badge">private · {p.audience}{p.audience_size ? ` · ${p.audience_size} agents` : ""}</span>
                  ) : (
                    <span className="badge">everyone{p.pushed_to != null ? ` · pushed doc to ${p.pushed_to}` : ""}</span>
                  )}
                  {p.chunk_id && <span className="badge mono">{p.chunk_id}</span>}
                  <span className="t-id ml-auto">{e.created_at?.slice(0, 10)} {e.created_at?.slice(11, 19)}</span>
                </div>
                <p className="t-post mt-1.5" style={{ fontSize: 14 }}>{p.text ?? JSON.stringify(e.payload)}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
