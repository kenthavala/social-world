// Events tab: authored runtime events. Composer + list (violet reserved for events).
// Scheduled events persist server-side (events table) until the engine marks them fired.
// Audience: "everyone" → public newsroom broadcast; a stakeholder group → private briefing.
import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import * as api from "../api";
import { Spinner } from "../common";

type RunEventMap = Awaited<ReturnType<typeof api.listRunEvents>>["events"];

export default function EventsTab({ runId, bumpKey, onError }: {
  runId: string;
  bumpKey: number;
  onError: (e: unknown) => void;
}) {
  const [events, setEvents] = useState<RunEventMap | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [deliverAt, setDeliverAt] = useState("");
  const [audience, setAudience] = useState("all");
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);

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
      setPosted(audience === "all"
        ? "ok"
        : `private:${groups.find((g) => g === audience) ?? audience}`);
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

  const authored = (events ?? []).filter((e) => {
    if (e.kind === "event" || e.kind === "scene_event" || e.kind === "injected" || e.kind === "scheduled") {
      return true;
    }
    // kind "news" rows for live-injected events are already covered by their persisted
    // scheduled row — only scenario-authored news (no "live" flag) needs its own row.
    if (e.kind === "news") {
      return !((e.payload as { live?: boolean }).live);
    }
    return false;
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="panel p-4">
        <h2 className="t-h2 mb-1">Add an event</h2>
        <p className="mb-3 text-sm" style={{ color: "var(--fg-2)" }}>
          Events enter the simulated world at the tick you choose. Everyone gets a public
          newsroom broadcast, or you can deliver a private briefing to one stakeholder group —
          only those agents will remember it. Schedules are stored on the server, so they
          survive a restart.
        </p>
        <textarea
          className="input h-24"
          placeholder="e.g. Overnight polls show public support dropping six points."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-xs" style={{ color: "var(--fg-3)" }}>
            Deliver at tick
            <input
              className="input mt-1 w-full"
              inputMode="numeric"
              placeholder="next tick"
              value={deliverAt}
              onChange={(e) => setDeliverAt(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          <label className="text-xs" style={{ color: "var(--fg-3)" }}>
            Audience
            <select
              className="input mt-1 w-full"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
            >
              <option value="all">everyone (public broadcast)</option>
              {groups.map((g) => (
                <option key={g} value={g}>only “{g}” (private briefing)</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button className="btn-primary" onClick={inject} disabled={!text.trim() || busy || events === null}>
            <Megaphone size={14} /> {audience === "all" ? "Inject event" : "Brief group"}
          </button>
          {busy && <Spinner label="Sending…" />}
        </div>
        {posted && (
          <p className="mt-2 text-xs" style={{ color: "var(--ok-fg)" }}>
            {posted.startsWith("private")
              ? `✓ Private briefing recorded — only the “${posted.slice(8)}” agents will encounter it at the chosen tick.`
              : "✓ Event recorded — agents will encounter it from the tick you chose."}
          </p>
        )}
      </div>

      <div className="panel overflow-hidden">
        <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--line-1)" }}>
          <span className="eyebrow">Event log — {authored.length} recorded</span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {events === null ? <Spinner /> : authored.length === 0 ? (
            <p className="p-4 text-sm" style={{ color: "var(--fg-3)" }}>
              No events yet. Injected events appear here the moment the backend records them.
            </p>
          ) : authored.map((e, i) => {
            const p = e.payload as {
              text?: string; audience?: string; audience_size?: number;
              private?: boolean; status?: string; chunk_id?: string; pushed_to?: number;
            };
            const isScheduled = e.kind === "scheduled" && p.status === "scheduled";
            const isPrivate = p.private === true || (p.audience && p.audience !== "all");
            return (
              <div key={i} className="px-4 py-3"
                   style={i < authored.length - 1 ? { borderBottom: "1px solid var(--line-1)" } : undefined}>
                <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--fg-3)" }}>
                  {isScheduled ? (
                    <span className="badge" style={{ color: "var(--ev-fg)", background: "var(--ev-soft)", borderColor: "var(--ev-line)" }}>
                      SCHEDULED → T{e.tick}
                    </span>
                  ) : (
                    <span className="badge" style={{ color: "var(--ev-fg)", background: "var(--ev-soft)", borderColor: "var(--ev-line)" }}>
                      EVENT
                    </span>
                  )}
                  {isPrivate && (
                    <span className="chip" style={{ fontSize: 10 }}>
                      private · {p.audience}
                    </span>
                  )}
                  {!isPrivate && p.pushed_to != null && (
                    <span className="chip" style={{ fontSize: 10 }}>pushed doc to {p.pushed_to} agents</span>
                  )}
                  <span>T{String(e.tick).padStart(2, "0")}</span>
                  <span className="mono ml-auto" style={{ color: "var(--fg-4)" }}>
                    {e.created_at?.slice(11, 19)}
                  </span>
                </div>
                <p className="t-post mt-1.5" style={{ color: "var(--fg-1)" }}>
                  {p.text ?? JSON.stringify(e.payload)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
