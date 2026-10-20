import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, FileText, LayoutGrid, LibraryBig, Upload, Wand2, X } from "lucide-react";
import type { EstimateResponse, RunDetail, SourceStats, WorldBrief } from "./types";
import * as api from "./api";
import { Spinner } from "./common";

const STEPS = [
  { n: 1, label: "Source" },
  { n: 2, label: "Brief" },
  { n: 3, label: "Agents" },
  { n: 4, label: "Run" },
];

const PRESETS = [
  { name: "Quick", agents: 8, ticks: 8, writes_per_tick: 4 },
  { name: "Standard", agents: 24, ticks: 20, writes_per_tick: 6 },
  { name: "Large", agents: 40, ticks: 24, writes_per_tick: 10 },
];

interface LibDoc { id?: string; source_id?: string; filename: string; status: string; pages?: number | null; }

export default function Wizard({ onDone, onCancel, onError }: {
  onDone: (runId: string) => void;
  onCancel: () => void;
  onError: (e: unknown) => void;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [source, setSource] = useState<SourceStats | null>(null);
  const [scenario, setScenario] = useState("");
  const [brief, setBrief] = useState<WorldBrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [est, setEst] = useState<EstimateResponse | null>(null);

  const [agents, setAgents] = useState(PRESETS[0].agents);
  const [ticks, setTicks] = useState(PRESETS[0].ticks);
  const [writesPerTick, setWritesPerTick] = useState(PRESETS[0].writes_per_tick);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [preset, setPreset] = useState("Quick");

  // -- real autosave: wizard state survives refresh/cancel-return --------------
  const DKEY = "oasis-wizard-draft";
  type Draft = Partial<{
    step: number; sourceId: string; name: string; scenario: string;
    agents: number; ticks: number; writesPerTick: number; seed: number; preset: string;
  }>;

  useEffect(() => {
    // restore draft once on mount
    try {
      const raw = localStorage.getItem(DKEY);
      if (raw && !source) {
        const d: Draft = JSON.parse(raw);
        if (d.step) setStep(Math.min(4, Math.max(1, d.step)));
        if (d.name) setName(d.name);
        if (d.scenario) setScenario(d.scenario);
        if (d.agents) setAgents(d.agents);
        if (d.ticks) setTicks(d.ticks);
        if (d.writesPerTick !== undefined) setWritesPerTick(d.writesPerTick);
        if (d.seed) setSeed(d.seed);
        if (d.preset) setPreset(d.preset);
        if (d.sourceId) {
          api.getSource(d.sourceId).then(setSource).catch(() => setSource(null));
        }
      }
    } catch { /* corrupted draft — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const d: Draft = {
      step, sourceId: source?.source_id, name, scenario,
      agents, ticks, writesPerTick, seed, preset,
    };
    try {
      if (source || name || scenario) localStorage.setItem(DKEY, JSON.stringify(d));
      else localStorage.removeItem(DKEY);
    } catch { /* storage unavailable — autosave is best-effort */ }
  }, [source, name, scenario, agents, ticks, writesPerTick, seed, preset, step]);

  useEffect(() => {
    if (step !== 3) return;
    api
      .estimate({ agents, ticks, writes_per_tick: writesPerTick })
      .then(setEst)
      .catch(() => setEst(null));
  }, [step, agents, ticks, writesPerTick]);

  async function handleUpload(file: File | null, text: string | null) {
    setBusy(true);
    onError(null);
    try {
      const stats = file ? await api.uploadSource(file!) : await api.uploadSourceText(text!);
      setSource(stats);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function chooseFromLibrary(lib: LibDoc) {
    onError(null);
    const sid = (lib.id ?? lib.source_id) as string;
    try {
      const stats = await api.getSource(sid);
      setSource(stats);
    } catch (e) {
      onError(e);
    }
  }

  async function handleBrief() {
    if (!source || !scenario.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const r = await api.generateBrief(source.source_id, scenario);
      setBrief(r.brief);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(pname: string) {
    const p = PRESETS.find((x) => x.name === pname)!;
    setPreset(pname);
    setAgents(p.agents);
    setTicks(p.ticks);
    setWritesPerTick(p.writes_per_tick);
  }

  async function launch() {
    if (!source) return;
    setBusy(true);
    onError(null);
    try {
      const run: RunDetail = await api.createRun(
        source.source_id,
        name.trim() || `Simulation ${new Date().toLocaleString()}`,
        { agents, ticks, writes_per_tick: writesPerTick, seed },
        { question: scenario, events: [] },
      );
      try { localStorage.removeItem(DKEY); } catch { /* ignore */ }
      // Launch intent: the run page performs the actual start (seeding can take minutes).
      try { sessionStorage.setItem("oasis-autostart", run.id); } catch { /* ignore */ }
      onDone(run.id);
      void run;
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  }

  const stepStatus = useMemo(() => {
    const s: Record<number, string> = {
      1: source ? `${source.pages} pp · ${source.chunks} chunks` : "Required — upload or choose a document",
      2: brief ? `${brief.issues.length} issues · ${brief.stakeholder_groups.length} groups` : "Required — name and research brief",
      3: `${agents} agents · ${ticks} ticks · ${writesPerTick}/tick`,
      4: `${ticks} ticks · ≤ ${est?.estimate?.max_llm_calls ?? "—"} LLM calls`,
    };
    return s;
  }, [source, brief, agents, ticks, writesPerTick, est]);

  return (
    <div className="pt-6 md:pt-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <div className="eyebrow">New simulation</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 t-meta">
            <span className="badge" style={{ borderStyle: "dashed" }}>DRAFT · AUTOSAVED</span>
            <span>{STEPS[step - 1].label} — step {step} of 4</span>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          <X size={14} /> Cancel
        </button>
      </div>

      {/* step rail */}
      <div className="steps mb-6 flex-wrap">
        {STEPS.map((s) => {
          const active = s.n === step;
          const done = s.n < step;
          return (
            <span key={s.n} className="flex items-center" style={{ flex: s.n < 4 ? "1 1 auto" : "0 0 auto" }}>
              <button
                className={`step ${done ? "is-done" : ""} ${active ? "is-current" : ""}`}
                onClick={() => s.n < step && setStep(s.n)}
                disabled={s.n > step}
              >
                <span className="step-n">{done ? "✓" : s.n}</span>
                <span className="flex flex-col items-start gap-0.5">
                  <span>{s.label}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-4)", fontWeight: 400 }}>
                    {done ? "done" : stepStatus[s.n]}
                  </span>
                </span>
              </button>
              {s.n < 4 && <span className={`step-line ${done ? "is-done" : ""}`} />}
            </span>
          );
        })}
      </div>

      {step === 1 && <StepSource source={source} busy={busy} onUpload={handleUpload} onChoose={chooseFromLibrary} onNext={() => setStep(2)} />}
      {step === 2 && (
        <StepBrief
          name={name} setName={setName}
          scenario={scenario} setScenario={setScenario}
          brief={brief}
          busy={busy}
          onGenerate={handleBrief}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <StepAgents
          agents={agents} setAgents={setAgents}
          ticks={ticks} setTicks={setTicks}
          writesPerTick={writesPerTick} setWritesPerTick={setWritesPerTick}
          seed={seed} setSeed={setSeed}
          est={est}
          preset={preset} applyPreset={applyPreset}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}
      {step === 4 && (
        <StepRun
          source={source}
          name={name} setName={setName}
          scenario={scenario}
          brief={brief}
          agents={agents}
          ticks={ticks}
          writesPerTick={writesPerTick}
          seed={seed}
          est={est}
          busy={busy}
          onBack={() => setStep(3)}
          onLaunch={launch}
        />
      )}
    </div>
  );
}

function Nav({ onBack, nextLabel, onNext, busy }: {
  onBack?: () => void;
  nextLabel: string;
  onNext?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="mt-6 flex items-center justify-between">
      <button className="btn btn-ghost" onClick={onBack} disabled={busy || !onBack}>
        <ArrowLeft size={15} /> Back
      </button>
      {onNext && (
        <button className="btn btn-primary" onClick={onNext} disabled={busy}>
          {nextLabel} <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}

function StepSource({ source, busy, onUpload, onChoose, onNext }: {
  source: SourceStats | null;
  busy: boolean;
  onUpload: (f: File | null, t: string | null) => void;
  onChoose: (d: LibDoc) => void;
  onNext: () => void;
}) {
  const [pasted, setPasted] = useState("");
  const [lib, setLib] = useState<LibDoc[] | null>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    api.listSources().then((r) => setLib(((r.sources || []) as unknown) as LibDoc[]))
      .catch(() => setLib([]));
  }, []);

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onUpload(f, null);
  }

  return (
    <div className="panel panel-body">
      <h2 className="t-h2">Source document</h2>
      <p className="t-body fg-2 mt-1 mb-4" style={{ maxWidth: 560 }}>
        The document your agents read. Every post they write cites the page and chunk it drew from.
      </p>

      <label
        className={`dropzone ${drag ? "is-drag" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <span className="empty-ic">
          <Upload size={20} />
        </span>
        <span style={{ fontWeight: 500 }}>Drop a PDF here, or browse</span>
        <span className="t-meta">PDF / TXT / MD / DOCX with a text layer · scanned pages without text can't be cited</span>
        <input
          type="file"
          className="absolute h-1 w-1 opacity-0"
          accept=".pdf,.txt,.md,.docx"
          onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0], null)}
        />
      </label>

      {lib !== null && lib.length > 0 && (
        <div className="mt-4">
          <div className="eyebrow mb-2 flex items-center gap-1.5"><LibraryBig size={12} /> Choose from library</div>
          <div className="flex flex-wrap gap-2">
            {lib.map((d) => {
              const id = d.id ?? d.source_id ?? "";
              return (
                <button key={id} onClick={() => onChoose(d)} className="chip" title={id}>
                  <LayoutGrid size={11} />
                  {d.filename}
                  {d.pages != null && <span className="chip-n">{d.pages} pp</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <details className="mt-4">
        <summary className="t-meta cursor-pointer select-none">…or paste text instead</summary>
        <textarea
          className="input mt-2"
          placeholder="Paste document text (min. a couple of paragraphs)…"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        <button className="btn btn-ghost mt-2" onClick={() => onUpload(null, pasted)} disabled={!pasted.trim() || busy}>
          Use this text
        </button>
      </details>

      {busy && <div className="mt-4"><Spinner label="Extracting, cleaning, chunking…" /></div>}

      {source && (
        <div className="panel-2 mt-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <FileText size={14} style={{ color: "var(--fg-3)" }} />
            <span style={{ fontWeight: 500 }}>{source.filename}</span>
            <span className={`status ${source.status === "ready" ? "status-ready" : "status-ingesting"}`}>
              {source.status === "ready" ? (
                <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5 6.5 12 13 4.5" /></svg>
              ) : <span className="dot dot-pulse" />}
              {source.status}
            </span>
          </div>
          <dl className="kv mt-3" style={{ gridTemplateColumns: "96px minmax(0,1fr)", gap: "8px 12px", fontSize: 12.5 }}>
            <dt>Pages</dt><dd className="mono">{source.pages}</dd>
            <dt>Source chunks</dt><dd className="mono">{source.chunks}</dd>
            <dt>Words</dt><dd className="mono">{source.words.toLocaleString()}</dd>
            <dt>Brief</dt><dd>{source.has_brief ? "generated — continue to review" : "not yet generated (next step)"}</dd>
          </dl>
          {source.deduplicated && <p className="t-meta mt-2">This document was already uploaded — the existing extraction was reused.</p>}
          <p className="t-meta mt-2">
            Inspect the extracted chunks any time in <a className="kbd-link" href="#/documents">Documents</a>.
          </p>
        </div>
      )}
      <Nav nextLabel="Write the brief" onNext={source ? onNext : undefined} busy={busy} />
    </div>
  );
}

function StepBrief({ name, setName, scenario, setScenario, brief, busy, onGenerate, onBack, onNext }: {
  name: string;
  setName: (s: string) => void;
  scenario: string;
  setScenario: (s: string) => void;
  brief: WorldBrief | null;
  busy: boolean;
  onGenerate: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const canGen = scenario.trim().length > 0;
  return (
    <div className="panel panel-body">
      <h2 className="t-h2">Brief</h2>
      <p className="t-body fg-2 mt-1 mb-4" style={{ maxWidth: 620 }}>
        Name the simulation and pose the question. The LLM reads the document and builds the brief:
        issues, stakeholder groups and claims — with page citations.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="field">
          <span className="label">Simulation name</span>
          <input
            className="input"
            placeholder="e.g. Congestion Charge — Public Response"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
      </div>
      <label className="field mt-4">
        <span className="label">Research brief / scenario</span>
        <textarea
          className="input"
          placeholder={'e.g. "How will our town react if the council approves the wind project next quarter?"'}
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
        />
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button className="btn btn-primary" onClick={onGenerate} disabled={!canGen || busy}>
          <Wand2 size={15} /> {brief ? "Regenerate brief" : "Generate world brief"}
        </button>
        {busy && <Spinner label="The LLM is reading your document…" />}
      </div>

      {brief && (
        <div className="mt-6">
          <div className="banner banner-info mb-4" style={{ alignItems: "flex-start" }}>
            <span>
              {brief.summary}
              {brief.fallback && <span className="t-meta block mt-1">(fallback brief — the provider failed, so issues were derived deterministically from the document's structure)</span>}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {brief.issues.map((iss) => (
              <div key={iss.id} className="panel-2 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <p style={{ fontWeight: 600 }}>{iss.name}</p>
                  <span className="t-id">{iss.id}</span>
                </div>
                <p className="t-meta mt-1">{iss.question}</p>
                <p className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span className="badge st-pro">{iss.pro_label}</span>
                  <span className="t-meta">vs</span>
                  <span className="badge st-con">{iss.con_label}</span>
                </p>
                {iss.evidence_chunk_ids.length > 0 && (
                  <p className="mt-2 flex flex-wrap gap-1.5">
                    {iss.evidence_chunk_ids.slice(0, 3).map((c) => (
                      <span key={c} className="cite" style={{ cursor: "default", height: 20 }}>
                        <span className="cite-p">evidence</span><span className="cite-sep">·</span><span>{c.length > 10 ? c.slice(0, 10) : c}</span>
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4">
            <div className="eyebrow mb-2">Stakeholder groups — {brief.stakeholder_groups.length}</div>
            <div className="grid gap-2">
              {brief.stakeholder_groups.map((g) => (
                <div key={g.name} className="panel-2 flex flex-wrap items-center gap-2 p-3">
                  <span style={{ fontWeight: 600 }}>{g.name}</span>
                  <span className="t-meta">{g.description}</span>
                  <span className="badge ml-auto">{g.size_hint}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <Nav onBack={onBack} nextLabel="Set up agents" onNext={brief ? onNext : undefined} busy={busy} />
    </div>
  );
}

function StepAgents(p: {
  agents: number; setAgents: (n: number) => void;
  ticks: number; setTicks: (n: number) => void;
  writesPerTick: number; setWritesPerTick: (n: number) => void;
  seed: number; setSeed: (n: number) => void;
  est: EstimateResponse | null;
  preset: string;
  applyPreset: (name: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="panel panel-body">
      <h2 className="t-h2">Agents</h2>
      <p className="t-body fg-2 mt-1 mb-4" style={{ maxWidth: 560 }}>
        Population, run length and how many agents post per tick. The seed makes runs reproducible.
      </p>

      <div className="mb-5 flex flex-wrap gap-2">
        {PRESETS.map((ps) => (
          <button
            key={ps.name}
            onClick={() => p.applyPreset(ps.name)}
            className={p.preset === ps.name ? "btn btn-accent" : "btn btn-ghost"}
          >
            <span style={{ fontWeight: 600 }}>{ps.name}</span>
            <span className="mono" style={{ fontSize: 10, opacity: 0.8 }}>
              {ps.agents} agents · {ps.ticks} ticks
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="field">
          <span className="label">Agents <span className="opt mono">{p.agents}</span></span>
          <input type="range" min={5} max={100} value={p.agents}
                 onChange={(e) => p.setAgents(+e.target.value)} className="w-full" />
        </label>
        <label className="field">
          <span className="label">Ticks <span className="opt mono">{p.ticks}</span></span>
          <input type="range" min={1} max={100} value={p.ticks}
                 onChange={(e) => p.setTicks(+e.target.value)} className="w-full" />
        </label>
        <label className="field">
          <span className="label">Writes per tick <span className="opt mono">{p.writesPerTick}</span></span>
          <input type="range" min={0} max={20} value={p.writesPerTick}
                 onChange={(e) => p.setWritesPerTick(+e.target.value)} className="w-full" />
          <span className="hint">How many agents post each tick. 0 = reactions only (deterministic).</span>
        </label>
        <div className="field">
          <span className="label">Random seed</span>
          <div className="flex gap-2">
            <input className="input mono" type="number" value={p.seed}
                   onChange={(e) => p.setSeed(+e.target.value)} />
            <button className="btn btn-ghost flex-none" onClick={() => p.setSeed(Math.floor(Math.random() * 2 ** 31))}>
              Reroll
            </button>
          </div>
          <span className="hint">Same seed + same provider responses → same run structure.</span>
        </div>
      </div>

      {p.est && (
        <div className="panel-2 mt-5 p-4">
          <dl className="kv" style={{ gridTemplateColumns: "150px minmax(0,1fr)", gap: "8px 12px", fontSize: 13 }}>
            <dt>LLM call budget</dt>
            <dd className="mono">≤ {p.est.estimate.max_llm_calls} <span className="fg-3">(core {p.est.estimate.core_calls})</span></dd>
            <dt>Per provider</dt>
            <dd className="mono">{Object.entries(p.est.estimate.per_provider ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}</dd>
          </dl>
          {p.est.warnings?.length > 0 && (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 t-meta" style={{ color: "var(--warn-fg)" }}>
              {p.est.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
            </ul>
          )}
        </div>
      )}
      <Nav onBack={p.onBack} nextLabel="Review & launch" onNext={p.onNext} />
    </div>
  );
}

function StepRun(p: {
  source: SourceStats | null;
  name: string;
  setName: (s: string) => void;
  scenario: string;
  brief: WorldBrief | null;
  agents: number;
  ticks: number;
  writesPerTick: number;
  seed: number;
  est: EstimateResponse | null;
  busy: boolean;
  onBack: () => void;
  onLaunch: () => void;
}) {
  const missingBrief = !p.brief;
  const summary = useMemo(() => [
    ["Name", p.name || "—"],
    ["Source", p.source?.filename ?? "—"],
    ["Brief", p.scenario.slice(0, 60) + (p.scenario.length > 60 ? "…" : "")],
    ["Issues", String(p.brief?.issues.length ?? 0)],
    ["Agents / writes", `${p.agents} · ${p.writesPerTick}/tick`],
    ["Ticks", String(p.ticks)],
    ["Seed", String(p.seed)],
    ["LLM call budget", String(p.est?.estimate.max_llm_calls ?? "—")],
  ], [p]);

  return (
    <div className="panel panel-body">
      <h2 className="t-h2">Review & launch</h2>
      <p className="t-body fg-2 mt-1 mb-4" style={{ maxWidth: 560 }}>
        {p.ticks} ticks · ≤ {p.est?.estimate?.max_llm_calls ?? "—"} LLM calls. You can pause or stop
        at any moment; every tick is committed atomically, so a crash never loses a finished tick.
      </p>
      <dl className="kv m-0" style={{ gridTemplateColumns: "168px minmax(0,1fr)", gap: "10px 16px" }}>
        {summary.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd className="truncate">{v}</dd>
          </div>
        ))}
      </dl>
      {missingBrief && (
        <div className="banner banner-warn mt-4">
          <span>
            No world brief on this source yet — the run can still start, but agents will need a
            fallback brief. Go back to step 2 to generate one.
          </span>
        </div>
      )}
      <Nav onBack={p.onBack} nextLabel="Launch simulation" onNext={p.onLaunch} busy={p.busy} />
      {p.busy && <div className="mt-3"><Spinner label="Creating the run…" /></div>}
    </div>
  );
}
