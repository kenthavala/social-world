import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, FileText, LayoutGrid, LibraryBig, Wand2, X } from "lucide-react";
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
      1: source ? `${source.pages} pp · ${source.chunks} chunks` : "Required — upload or choose a PDF",
      2: brief ? `${brief.issues.length} issues · ${brief.stakeholder_groups.length} groups` : "Required — name and research brief",
      3: `${agents} agents · ${ticks} ticks · ${writesPerTick}/tick`,
      4: `${ticks} ticks · ≤ ${est?.estimate?.max_llm_calls ?? "—"} LLM calls`,
    };
    return s;
  }, [source, brief, agents, ticks, writesPerTick, est]);

  return (
    <div className="pt-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="eyebrow">New simulation</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs" style={{ color: "var(--fg-3)" }}>
            <span className="chip">DRAFT · AUTOSAVED</span>
            <span>{STEPS[step - 1].label}</span>
          </div>
        </div>
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          <X size={14} /> Cancel
        </button>
      </div>

      {/* step rail */}
      <div className="panel mb-5 flex items-stretch px-1 py-1">
        {STEPS.map((s) => {
          const active = s.n === step;
          const done = s.n < step;
          return (
            <button
              key={s.n}
              onClick={() => s.n < step && setStep(s.n)}
              className={`flex items-center gap-2 px-3 py-2 text-left ${s.n < step ? "cursor-pointer" : "cursor-default"}`}
              style={active
                ? { background: "var(--bg-2)", borderRadius: "var(--r-2)", border: "1px solid var(--ac-line)" }
                : { borderRadius: "var(--r-2)", border: "1px solid transparent", color: done ? "var(--fg-2)" : "var(--fg-3)" }}
            >
              <span className={`mono ${done ? "" : ""}`} style={{
                fontSize: 11,
                color: active ? "var(--ac-fg)" : done ? "var(--ok-fg)" : "var(--fg-4)",
              }}>
                {done ? "✓" : s.n}
              </span>
              <span className="flex flex-col">
                <span style={{ fontSize: 13, fontWeight: active ? 600 : 500, color: active ? "var(--fg-1)" : undefined }}>
                  {s.label}
                </span>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-4)" }}>
                  {done ? "done" : stepStatus[s.n]}
                </span>
              </span>
            </button>
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
      <button className="btn-ghost" onClick={onBack} disabled={busy || !onBack}>
        <ArrowLeft size={15} /> Back
      </button>
      {onNext && (
        <button className="btn-primary" onClick={onNext} disabled={busy}>
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
    <div className="card">
      <h2 className="t-h2 mb-1">Source document</h2>
      <p className="mb-4 text-sm" style={{ color: "var(--fg-2)" }}>
        The PDF your agents read. Every post they write cites the page and chunk it drew from.
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className="mb-4 flex flex-col items-center justify-center gap-2 border border-dashed px-6 py-10 text-center"
        style={{
          borderColor: drag ? "var(--ac-line)" : "var(--line-3)",
          background: drag ? "var(--ac-soft)" : "var(--bg-2)",
          borderRadius: "var(--r-3)",
          transition: "border-color 120ms, background 120ms",
        }}
      >
        <label className="cursor-pointer">
          <span className="btn-ghost">
            <FileText size={15} /> Drop a PDF here, or browse
          </span>
          <input
            type="file"
            className="absolute h-1 w-1 opacity-0"
            accept=".pdf,.txt,.md,.docx"
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0], null)}
          />
        </label>
        <span style={{ color: "var(--fg-3)", fontSize: 12 }}>
          PDFs with a text layer. Scanned pages without text can&apos;t be cited.
        </span>
      </div>

      {lib !== null && lib.length > 0 && (
        <div className="mb-4">
          <div className="eyebrow mb-2 flex items-center gap-1.5"><LibraryBig size={12} /> Choose from library</div>
          <div className="flex flex-wrap gap-2">
            {lib.map((d) => {
              const id = d.id ?? d.source_id ?? "";
              return (
                <button
                  key={id}
                  onClick={() => onChoose(d)}
                  className="chip cursor-pointer"
                  title={id}
                >
                  <LayoutGrid size={11} />
                  {d.filename}
                  {d.pages != null && <span style={{ color: "var(--fg-4)" }}>{d.pages}pp</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <details className="mb-4 text-sm" style={{ color: "var(--fg-2)" }}>
        <summary className="cursor-pointer select-none">…or paste text instead</summary>
        <textarea
          className="input mt-2 h-32"
          placeholder="Paste document text (min. a couple of paragraphs)…"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        <button className="btn-ghost mt-2" onClick={() => onUpload(null, pasted)} disabled={!pasted.trim() || busy}>
          Use this text
        </button>
      </details>

      {busy && <Spinner label="Extracting, cleaning, chunking…" />}

      {source && (
        <div className="panel-2 p-3 text-sm">
          <p style={{ color: "var(--ok-fg)" }}>✓ {source.filename}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--fg-3)" }}>
            <span className="mono">{source.status}</span> · {source.pages} pages · {source.chunks} chunks · {source.words} words
            {source.deduplicated ? " · already uploaded (deduplicated)" : ""}
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
    <div className="card">
      <h2 className="t-h2 mb-1">Brief</h2>
      <p className="mb-4 text-sm" style={{ color: "var(--fg-2)" }}>
        Name the simulation and pose the question. The LLM reads the document and builds the brief:
        issues, stakeholder groups and claims — with page citations.
      </p>

      <label className="label" htmlFor="sim-name">Simulation name</label>
      <input
        id="sim-name"
        className="input mb-3"
        placeholder="e.g. Congestion Charge — Public Response"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />

      <label className="label" htmlFor="sim-brief">Research brief / scenario</label>
      <textarea
        id="sim-brief"
        className="input h-24"
        placeholder={'e.g. "How will our town react if the council approves the wind project next quarter?"'}
        value={scenario}
        onChange={(e) => setScenario(e.target.value)}
      />

      <div className="mt-3 flex items-center gap-3">
        <button className="btn-primary" onClick={onGenerate} disabled={!canGen || busy}>
          <Wand2 size={15} /> {brief ? "Regenerate brief" : "Generate world brief"}
        </button>
        {busy && <Spinner label="The LLM is reading your document…" />}
      </div>

      {brief && (
        <div className="mt-5">
          <p className="mb-2 text-sm" style={{ color: "var(--fg-2)" }}>{brief.summary}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {brief.issues.map((iss) => (
              <div key={iss.id} className="panel-2 p-3 text-sm">
                <p style={{ fontWeight: 600 }}>{iss.name}</p>
                <p className="mt-1 text-xs" style={{ color: "var(--fg-3)" }}>{iss.question}</p>
                <p className="mt-2 text-xs">
                  <span className="badge st-pro">{iss.pro_label}</span>
                  {"  vs  "}
                  <span className="badge st-con">{iss.con_label}</span>
                </p>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 text-sm">
            {brief.stakeholder_groups.map((g) => (
              <div key={g.name} className="flex items-center gap-2 panel-2 p-2">
                <span style={{ fontWeight: 600 }}>{g.name}</span>
                <span className="text-xs" style={{ color: "var(--fg-3)" }}>{g.description}</span>
              </div>
            ))}
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
    <div className="card">
      <h2 className="t-h2 mb-1">Agents</h2>
      <p className="mb-4 text-sm" style={{ color: "var(--fg-2)" }}>
        Population, run length and how many agents post per tick.
      </p>

      <div className="mb-4 flex gap-2">
        {PRESETS.map((ps) => (
          <button
            key={ps.name}
            onClick={() => p.applyPreset(ps.name)}
            className={p.preset === ps.name ? "btn-accent" : "btn-ghost"}
          >
            <span style={{ fontWeight: 600 }}>{ps.name}</span>
            <span className="mono" style={{ fontSize: 10, opacity: 0.8 }}>
              {ps.agents}a · {ps.ticks}t
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <span className="label">Agents: {p.agents}</span>
          <input type="range" min={5} max={100} value={p.agents}
                 onChange={(e) => p.setAgents(+e.target.value)} className="w-full" style={{ accentColor: "var(--ac)" }} />
        </div>
        <div>
          <span className="label">Ticks: {p.ticks}</span>
          <input type="range" min={1} max={100} value={p.ticks}
                 onChange={(e) => p.setTicks(+e.target.value)} className="w-full" style={{ accentColor: "var(--ac)" }} />
        </div>
        <div>
          <span className="label">Writes per tick: {p.writesPerTick}</span>
          <input type="range" min={0} max={20} value={p.writesPerTick}
                 onChange={(e) => p.setWritesPerTick(+e.target.value)} className="w-full" style={{ accentColor: "var(--ac)" }} />
        </div>
        <div>
          <label className="label">Random seed</label>
          <div className="flex gap-2">
            <input className="input mono" type="number" value={p.seed}
                   onChange={(e) => p.setSeed(+e.target.value)} />
            <button className="btn-ghost" onClick={() => p.setSeed(Math.floor(Math.random() * 2 ** 31))}>
              Reroll
            </button>
          </div>
        </div>
      </div>

      {p.est && (
        <div className="mt-4 panel-2 p-3 text-sm" style={{ color: "var(--fg-2)" }}>
          Estimated LLM calls: <strong style={{ color: "var(--fg-1)" }}>{p.est.estimate.max_llm_calls}</strong> (core {p.est.estimate.core_calls})
          {p.est.warnings?.length > 0 && (
            <ul className="mt-2 list-disc pl-5" style={{ color: "var(--warn-fg)" }}>
              {p.est.warnings.map((w, i) => <li key={i}>{w}</li>)}
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
    <div className="card">
      <h2 className="t-h2 mb-1">Run</h2>
      <p className="mb-4 text-sm" style={{ color: "var(--fg-2)" }}>
        {p.ticks} ticks · ≤ {p.est?.estimate?.max_llm_calls ?? "—"} LLM calls. You can pause or stop at any moment.
      </p>
      <dl className="mt-4 grid gap-2 text-sm">
        {summary.map(([k, v]) => (
          <div key={k} className="flex gap-3 panel-2 px-3 py-2">
            <dt className="w-36 shrink-0" style={{ color: "var(--fg-3)" }}>{k}</dt>
            <dd className="truncate">{v}</dd>
          </div>
        ))}
      </dl>
      {missingBrief && (
        <p className="mt-3 rounded-md p-3 text-xs"
           style={{ background: "var(--warn-soft)", border: "1px solid var(--warn-line)", color: "var(--warn-fg)" }}>
          No world brief on this source yet — the run can still start, but agents will need a fallback brief.
        </p>
      )}
      <Nav onBack={p.onBack} nextLabel="Launch simulation" onNext={p.onLaunch} busy={p.busy} />
      {p.busy && <div className="mt-3"><Spinner label="Starting…" /></div>}
    </div>
  );
}
