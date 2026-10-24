import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ArrowLeft, ArrowRight, FileText, LayoutGrid, LibraryBig, Upload, Wand2, X } from "lucide-react";
import type { EstimateResponse, RunDetail, SourceStats, WorldBrief } from "./types";
import * as api from "./api";
import { GeneratedTag, Spinner } from "./common";
import { fetchChunk } from "./run/helpers";
import { sourceStatusMeta, sourceStatusPill } from "./status";

const STEPS = [
  { n: 1, label: "Source" },
  { n: 2, label: "Question" },
  { n: 3, label: "Issues" },
  { n: 4, label: "Stakeholders" },
  { n: 5, label: "Population" },
  { n: 6, label: "Settings" },
  { n: 7, label: "Review" },
  { n: 8, label: "Launch" },
];

const LAST_STEP = STEPS.length;

const PRESETS = [
  { name: "Quick", agents: 8, ticks: 8, writes_per_tick: 4 },
  { name: "Standard", agents: 24, ticks: 20, writes_per_tick: 6 },
  { name: "Large", agents: 40, ticks: 24, writes_per_tick: 10 },
];

interface LibDoc { id?: string; source_id?: string; filename: string; status: string; pages?: number | null; }

function nameFromFile(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function scenarioFromBrief(brief: WorldBrief | null): string {
  return brief
    ? `How will the people affected respond to ${brief.issues.map((i) => i.name).join(" and ")}?`
    : "";
}

export default function Wizard({ onDone, onCancel, onError, initialSource }: {
  onDone: (runId: string) => void;
  onCancel: () => void;
  onError: (e: unknown) => void;
  initialSource?: string;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [source, setSource] = useState<SourceStats | null>(null);
  const [scenario, setScenario] = useState("");
  const [brief, setBrief] = useState<WorldBrief | null>(null);
  const [edit, setEdit] = useState<WorldBrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [est, setEst] = useState<EstimateResponse | null>(null);

  const [agents, setAgents] = useState(PRESETS[0].agents);
  const [ticks, setTicks] = useState(PRESETS[0].ticks);
  const [writesPerTick, setWritesPerTick] = useState(PRESETS[0].writes_per_tick);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [preset, setPreset] = useState("Quick");
  const [mix, setMix] = useState({ pro: 30, con: 30, neu: 40 });

  // -- real autosave: wizard state survives refresh/cancel-return --------------
  const DKEY = "tsw-wizard-draft";
  type Draft = Partial<{
    step: number; sourceId: string; name: string; scenario: string;
    agents: number; ticks: number; writesPerTick: number; seed: number; preset: string;
    mix: { pro: number; con: number; neu: number }; brief: WorldBrief | null;
    edit: WorldBrief | null;
  }>;

  const restoredRef = useRef(false);


  useEffect(() => {
    // A source chosen elsewhere (Documents → New simulation) wins over the draft;
    // otherwise restore the autosaved draft once on mount. The stored brief travels
    // with the source detail, so revisiting a document never costs another LLM call.
    let cancelled = false;
    async function hydrate() {
      let draft: Draft | null = null;
      try {
        const raw = localStorage.getItem(DKEY);
        if (raw) draft = JSON.parse(raw) as Draft;
      } catch { /* corrupted draft — ignore */ }

      if (initialSource) {
        try {
          const stats = await api.getSource(initialSource);
          if (!cancelled) {
            setSource(stats);
            if (stats.brief) { setBrief(stats.brief); setEdit(stats.brief); }
            setName((cur) => cur || nameFromFile(stats.filename));
            setScenario((cur) => cur || scenarioFromBrief(stats.brief ?? null));
          }
        } catch {
          if (!cancelled) setSource(null);
        }
        if (!cancelled) restoredRef.current = true;
        return;
      }

      if (draft) {
        if (draft.step) setStep(Math.min(LAST_STEP, Math.max(1, draft.step)));
        if (draft.name) setName(draft.name);
        if (draft.scenario) setScenario(draft.scenario);
        if (draft.agents) setAgents(draft.agents);
        if (draft.ticks) setTicks(draft.ticks);
        if (draft.writesPerTick !== undefined) setWritesPerTick(draft.writesPerTick);
        if (draft.seed) setSeed(draft.seed);
        if (draft.preset) setPreset(draft.preset);
        if (draft.mix) setMix(draft.mix);
        // Restore the brief from the draft first — unsaved edits must not be
        // silently overwritten by a source re-fetch below.
        if (draft.brief) setBrief(draft.brief);
        // `edit` is the wizard's working copy and the single source of truth
        // for the issue/group builders, so it must be restored here; without
        // this the user's added issues are lost on reload (D004/D007/D011).
        setEdit(draft.edit ?? draft.brief ?? null);
        if (draft.sourceId) {
          try {
            const stats = await api.getSource(draft.sourceId);
            if (!cancelled) {
              setSource(stats);
              // Only fall back to the source's stored brief when the draft
              // carries neither a brief nor an in-progress edit (e.g. first
              // autosave after a fresh generation).
              if (stats.brief && !draft.brief && !draft.edit) {
                setBrief(stats.brief);
                setEdit(stats.brief);
              }
              setName((cur) => cur || nameFromFile(stats.filename));
              setScenario((cur) => cur || scenarioFromBrief(stats.brief ?? null));
            }
          } catch {
            if (!cancelled) setSource(null);
          }
        }
      }
      if (!cancelled) restoredRef.current = true;
    }
    void hydrate();
    return () => { cancelled = true; };
  }, [initialSource]);

  useEffect(() => {
    // Never clobber a draft before the async restore has had a chance to read it.
    if (!restoredRef.current) return;
    const d: Draft = {
      step, sourceId: source?.source_id, name, scenario,
      agents, ticks, writesPerTick, seed, preset, mix, brief, edit,
    };
    try {
      if (source || name || scenario || brief || edit) localStorage.setItem(DKEY, JSON.stringify(d));
      else localStorage.removeItem(DKEY);
    } catch { /* storage unavailable — autosave is best-effort */ }
  }, [source, name, scenario, agents, ticks, writesPerTick, seed, preset, mix, brief, edit, step]);

  // Persist on every step transition and beforeunload so unsaved edits survive
  // navigation and refresh (D004/D007). Idempotent: localStorage is overwritten.
  useEffect(() => {
    const persist = () => {
      try {
        const d: Draft = {
          step, sourceId: source?.source_id, name, scenario,
          agents, ticks, writesPerTick, seed, preset, mix, brief, edit,
        };
        if (source || name || scenario || brief || edit) {
          localStorage.setItem(DKEY, JSON.stringify(d));
        }
      } catch { /* storage unavailable */ }
    };
    window.addEventListener('beforeunload', persist);
    return () => window.removeEventListener('beforeunload', persist);
  }, [step, source, name, scenario, agents, ticks, writesPerTick, seed, preset, mix, brief, edit]);

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
      if (stats.brief) { setBrief(stats.brief); setEdit(stats.brief); }
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
      if (stats.brief) { setBrief(stats.brief); setEdit(stats.brief); }
      setName((cur) => cur || nameFromFile(stats.filename));
      setScenario((cur) => cur || scenarioFromBrief(stats.brief ?? null));
    } catch (e) {
      onError(e);
    }
  }

  async function handleBrief() {
    if (!source || !scenario.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const r = await api.generateBrief(source.source_id, scenario, {
        max_issues: 5,
        max_groups: Math.max(3, Math.min(20, Math.floor(agents / 2))),
      });
      setBrief(r.brief);
      setEdit(r.brief);
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
        { agents, ticks, writes_per_tick: writesPerTick, seed,
          pop_mix: { pro: mix.pro / 100, con: mix.con / 100, undecided: mix.neu / 100 } },
        { question: scenario, events: [] },
      );
      try { localStorage.removeItem(DKEY); } catch { /* ignore */ }
      // Launch intent: the run page performs the actual start (seeding can take minutes).
      try { sessionStorage.setItem("tsw-autostart", run.id); } catch { /* ignore */ }
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
      2: scenario.trim() ? "Research question set" : "Required — describe what you want to learn",
      3: edit || brief
        ? `${(edit ?? brief)!.issues.length} issue(s) defined`
        : "Draft the scenario first",
      4: edit || brief
        ? `${(edit ?? brief)!.stakeholder_groups.length} group(s) defined`
        : "Draft the scenario first",
      5: `${agents} agents · ${ticks} rounds`,
      6: `${writesPerTick}/round · seed ${seed}`,
      7: est ? `≤ ${est.estimate.max_llm_calls} LLM calls` : "Review configuration",
      8: "Start the simulation",
    };
    return s;
  }, [source, brief, edit, scenario, agents, ticks, writesPerTick, seed, est]);

  return (
    <div className="pt-6 md:pt-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <div className="eyebrow">New simulation</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 t-meta">
            <span className="badge" style={{ borderStyle: "dashed" }}>DRAFT · AUTOSAVED</span>
            <span>{STEPS[step - 1].label} — step {step} of {LAST_STEP}</span>
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
            <span key={s.n} className="flex items-center" style={{ flex: s.n < LAST_STEP ? "1 1 auto" : "0 0 auto" }}>
              <button
                className={`step ${done ? "is-done" : ""} ${active ? "is-current" : ""}`}
                onClick={() => s.n < step && setStep(s.n)}
                disabled={s.n > step}
              >
                <span className="step-n">{done ? "✓" : s.n}</span>
                <span className="flex flex-col items-start gap-0.5">
                  <span>{s.label}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", fontWeight: 400 }}>
                    {done ? "done" : stepStatus[s.n]}
                  </span>
                </span>
              </button>
              {s.n < LAST_STEP && <span className={`step-line ${done ? "is-done" : ""}`} />}
            </span>
          );
        })}
      </div>

      {step === 1 && <StepSource source={source} busy={busy} onUpload={handleUpload} onChoose={chooseFromLibrary} onNext={() => setStep(2)} />}
      {step === 2 && (
        <StepBrief
          mode="question"
          sourceId={source?.source_id ?? null}
          name={name} setName={setName}
          scenario={scenario} setScenario={setScenario}
          brief={brief} setBrief={setBrief}
          edit={edit} setEdit={setEdit}
          agents={agents} maxGroups={Math.max(3, Math.min(20, Math.floor(agents / 2)))}
          busy={busy}
          onError={onError}
          onGenerate={handleBrief}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <StepBrief
          mode="issues"
          sourceId={source?.source_id ?? null}
          name={name} setName={setName}
          scenario={scenario} setScenario={setScenario}
          brief={brief} setBrief={setBrief}
          edit={edit} setEdit={setEdit}
          agents={agents} maxGroups={Math.max(3, Math.min(20, Math.floor(agents / 2)))}
          busy={busy}
          onError={onError}
          onGenerate={handleBrief}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}
      {step === 4 && (
        <StepBrief
          mode="groups"
          sourceId={source?.source_id ?? null}
          name={name} setName={setName}
          scenario={scenario} setScenario={setScenario}
          brief={brief} setBrief={setBrief}
          edit={edit} setEdit={setEdit}
          agents={agents} maxGroups={Math.max(3, Math.min(20, Math.floor(agents / 2)))}
          busy={busy}
          onError={onError}
          onGenerate={handleBrief}
          onBack={() => setStep(3)}
          onNext={() => setStep(5)}
        />
      )}
      {step === 5 && (
        <StepPopulation
          agents={agents} setAgents={setAgents}
          ticks={ticks} setTicks={setTicks}
          mix={mix} setMix={setMix}
          brief={brief}
          preset={preset} applyPreset={applyPreset}
          onBack={() => setStep(4)}
          onNext={() => setStep(6)}
        />
      )}
      {step === 6 && (
        <StepSettings
          writesPerTick={writesPerTick} setWritesPerTick={setWritesPerTick}
          seed={seed} setSeed={setSeed}
          est={est}
          onBack={() => setStep(5)}
          onNext={() => setStep(7)}
        />
      )}
      {step === 7 && (
        <StepRun
          mode="review"
          source={source}
          name={name} setName={setName}
          scenario={scenario}
          brief={brief}
          agents={agents}
          ticks={ticks}
          writesPerTick={writesPerTick}
          seed={seed}
          mix={mix}
          est={est}
          busy={busy}
          onBack={() => setStep(6)}
          onLaunch={launch}
          onNext={() => setStep(8)}
        />
      )}
      {step === 8 && (
        <StepRun
          mode="launch"
          source={source}
          name={name} setName={setName}
          scenario={scenario}
          brief={brief}
          agents={agents}
          ticks={ticks}
          writesPerTick={writesPerTick}
          seed={seed}
          mix={mix}
          est={est}
          busy={busy}
          onBack={() => setStep(7)}
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
  const meta = source ? sourceStatusMeta(source.status) : null;

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
          aria-label="Upload a source document"
          tabIndex={-1}
          onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0], null)}
        />
      </label>
      <p className="t-meta mt-2">
        No document at hand? <a className="kbd-link" href="#/simulations">Open the sample world</a>.
      </p>

      {lib !== null && lib.length > 0 && (
        <div className="mt-4">
          <div className="eyebrow mb-2 flex items-center gap-1.5"><LibraryBig size={12} /> Choose from library</div>
          <div className="flex flex-wrap gap-2">
            {lib.slice(0, 12).map((d) => {
              const id = d.id ?? d.source_id ?? "";
              const docMeta = sourceStatusMeta(d.status);
              return (
                <button key={id} onClick={() => onChoose(d)} className="chip"
                        title={`${id} — ${docMeta.label}. ${docMeta.detail}`}
                        style={{ opacity: docMeta.usable ? 1 : 0.62 }}>
                  <LayoutGrid size={11} />
                  {d.filename}
                  <span className="chip-n">
                    {d.pages != null ? `${d.pages} pp · ` : ""}{docMeta.label}
                  </span>
                </button>
              );
            })}
          </div>
          {lib.length > 12 && (
            <p className="t-meta mt-2">
              {lib.length - 12} more in <a className="kbd-link" href="#/documents">Sources</a>.
            </p>
          )}
        </div>
      )}

      <details className="mt-4">
        <summary className="t-meta cursor-pointer select-none">…or paste text instead</summary>
        <textarea
          className="input mt-2"
          placeholder="Paste document text (min. a couple of paragraphs)…"
          aria-label="Paste document text"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        <button className="btn btn-ghost mt-2" onClick={() => onUpload(null, pasted)}
                disabled={!pasted.trim() || busy}
                aria-label="Use the pasted text as the source document">
          Use this text
        </button>
      </details>

      {busy && <div className="mt-4"><Spinner label="Extracting, cleaning, chunking…" /></div>}

      {source && (
        <div className="panel-2 mt-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <FileText size={14} style={{ color: "var(--fg-3)" }} />
            <span style={{ fontWeight: 500 }}>{source.filename}</span>
            <span className={`status ${meta ? sourceStatusPill(meta.tone) : "status-queued"}`}
                  title={meta ? `${meta.detail} Raw backend status: ${source.status}` : undefined}>
              {meta?.tone === "ok" ? (
                <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5 6.5 12 13 4.5" /></svg>
              ) : meta?.tone === "err" ? (
                <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
              ) : <span className={`dot${meta?.live ? " dot-pulse" : ""}`} />}
              {meta?.label ?? source.status}
            </span>
          </div>
          <dl className="kv mt-3" style={{ gridTemplateColumns: "96px minmax(0,1fr)", gap: "8px 12px", fontSize: 12.5 }}>
            <dt>Pages</dt><dd className="mono">{source.pages}</dd>
            <dt>Source chunks</dt><dd className="mono">{source.chunks}</dd>
            <dt>Words</dt><dd className="mono">{source.words.toLocaleString()}</dd>
            <dt>Scenario</dt><dd>{source.has_brief ? "stored scenario brief loaded — review on the next step" : "not drafted yet (next step)"}</dd>
          </dl>
          {source.deduplicated && <p className="t-meta mt-2">This document was already uploaded — the existing extraction was reused.</p>}
          {source.error && (
            <div className="banner banner-err mt-3" role="alert">
              <span>{source.error}</span>
            </div>
          )}
          {meta && !meta.usable && (
            <p className="t-meta mt-2">
              {meta.live
                ? "Extraction is still running — wait for it to finish before continuing."
                : "This document cannot be used until it is re-uploaded."}
            </p>
          )}
          <p className="t-meta mt-2">
            Inspect the extracted chunks any time in{" "}
            <a className="kbd-link" href={source ? `#/documents?source=${encodeURIComponent(source.source_id)}` : "#/documents"}>Sources</a>.
          </p>
        </div>
      )}
      <Nav nextLabel={source?.has_brief ? "Review the scenario" : "Draft the scenario"}
           onNext={source && meta?.usable ? onNext : undefined} busy={busy} />
    </div>
  );
}

function StepBrief({ mode, sourceId, name, setName, scenario, setScenario, brief, setBrief,
  edit, setEdit, agents, maxGroups, busy, onError, onGenerate, onBack, onNext }: {
  mode: "question" | "issues" | "groups";
  sourceId: string | null;
  name: string;
  setName: (s: string) => void;
  scenario: string;
  setScenario: (s: string) => void;
  brief: WorldBrief | null;
  setBrief: (b: WorldBrief) => void;
  edit: WorldBrief | null;
  setEdit: Dispatch<SetStateAction<WorldBrief | null>>;
  agents: number;
  maxGroups: number;
  busy: boolean;
  onError: (e: unknown) => void;
  onGenerate: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const canGen = scenario.trim().length > 0;
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const draftQuestion = brief
    ? `How will the people affected respond to ${brief.issues.map((i) => i.name).join(" and ")}?`
    : "";

  // One-click issue starters. They only seed name/category/labels — the user can
  // then edit anything. Choosing one must never overwrite an issue already typed.
  const ISSUE_PRESETS = [
    { name: "Policy", category: "policy.infrastructure" },
    { name: "Economy", category: "policy.taxation" },
    { name: "Environment", category: "policy.environment" },
    { name: "Public opinion", category: "society.public_opinion" },
    { name: "Infrastructure", category: "policy.infrastructure" },
    { name: "Technology", category: "policy.digital" },
    { name: "Employment", category: "policy.employment" },
    { name: "Healthcare", category: "policy.healthcare" },
    { name: "Education", category: "policy.education" },
    { name: "Regulation", category: "business.regulation" },
    { name: "Consumer behaviour", category: "business.consumer_behaviour" },
    { name: "Community impact", category: "society.community_conflict" },
    { name: "Equity", category: "society.inequality" },
    { name: "Safety", category: "policy.public_safety" },
    { name: "Cost", category: "business.pricing" },
    { name: "Implementation", category: "policy.urban_planning" },
    { name: "Trust", category: "society.public_opinion" },
    { name: "Political response", category: "policy.welfare" },
  ];

  const GROUP_PRESETS = [
    "Residents", "Consumers", "Businesses", "Government", "Local government",
    "Regulators", "Industry", "Workers", "Students", "Researchers", "NGOs",
    "Media", "Investors", "Activists", "Experts", "Community organizations",
    "Taxpayers", "Tourists", "Transport users", "Healthcare providers", "Educators",
  ];

  // Issue Categories
  const ISSUE_CATEGORIES: { value: string; label: string }[] = [
    { value: "policy.transport", label: "Policy → Transport" },
    { value: "policy.education", label: "Policy → Education" },
    { value: "policy.healthcare", label: "Policy → Healthcare" },
    { value: "policy.housing", label: "Policy → Housing" },
    { value: "policy.taxation", label: "Policy → Taxation" },
    { value: "policy.employment", label: "Policy → Employment" },
    { value: "policy.welfare", label: "Policy → Welfare" },
    { value: "policy.environment", label: "Policy → Environment" },
    { value: "policy.energy", label: "Policy → Energy" },
    { value: "policy.agriculture", label: "Policy → Agriculture" },
    { value: "policy.digital", label: "Policy → Digital Policy" },
    { value: "policy.public_safety", label: "Policy → Public Safety" },
    { value: "policy.infrastructure", label: "Policy → Infrastructure" },
    { value: "policy.urban_planning", label: "Policy → Urban Planning" },
    { value: "business.pricing", label: "Business → Pricing" },
    { value: "business.product_launch", label: "Business → Product Launch" },
    { value: "business.market_entry", label: "Business → Market Entry" },
    { value: "business.regulation", label: "Business → Regulation" },
    { value: "business.competition", label: "Business → Competition" },
    { value: "business.supply_chain", label: "Business → Supply Chain" },
    { value: "business.consumer_behaviour", label: "Business → Consumer Behaviour" },
    { value: "business.brand_perception", label: "Business → Brand Perception" },
    { value: "society.public_opinion", label: "Society → Public Opinion" },
    { value: "society.community_conflict", label: "Society → Community Conflict" },
    { value: "society.cultural_change", label: "Society → Cultural Change" },
    { value: "society.social_policy", label: "Society → Social Policy" },
    { value: "society.inequality", label: "Society → Inequality" },
    { value: "society.demographic_change", label: "Society → Demographic Change" },
    { value: "crisis.natural_disaster", label: "Crisis → Natural Disaster" },
    { value: "crisis.public_health", label: "Crisis → Public Health" },
    { value: "crisis.supply_disruption", label: "Crisis → Supply Disruption" },
    { value: "crisis.economic_shock", label: "Crisis → Economic Shock" },
    { value: "crisis.infrastructure_failure", label: "Crisis → Infrastructure Failure" },
    { value: "crisis.reputation_crisis", label: "Crisis → Reputation Crisis" },
    { value: "custom", label: "Custom" },
  ];

  function patchIssue(i: number, patch: Partial<WorldBrief["issues"][number]>) {
    if (!edit) return;
    setEdit({ ...edit, issues: edit.issues.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  }

  function patchGroup(i: number, patch: Partial<WorldBrief["stakeholder_groups"][number]>) {
    if (!edit) return;
    setEdit({ ...edit, stakeholder_groups: edit.stakeholder_groups.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  }

  function addIssue() {
    if (!edit) return;
    const newId = `iss_${edit.issues.length + 1}`;
    setEdit({
      ...edit,
      issues: [...edit.issues, {
        id: newId,
        name: "New Issue",
        question: "",
        pro_label: "Supports",
        con_label: "Opposes",
        evidence_chunk_ids: [],
        category: "custom",
        detailed_context: "",
        geographic_scope: "",
        time_horizon: "",
        current_situation: "",
        proposed_change: "",
        alternative_options: "",
        key_tradeoffs: "",
        evidence_sources: "",
        known_uncertainties: "",
        metrics: "",
        decision_question: "",
      }]
    });
  }

  function removeIssue(i: number) {
    if (!edit) return;
    setEdit({ ...edit, issues: edit.issues.filter((_, j) => j !== i).map((iss, idx) => ({ ...iss, id: `iss_${idx + 1}` })) });
  }

  function duplicateIssue(i: number) {
    if (!edit) return;
    const iss = edit.issues[i];
    setEdit({
      ...edit,
      issues: [...edit.issues.slice(0, i + 1), { ...iss, id: `iss_${edit.issues.length + 1}`, name: iss.name + " (copy)" }, ...edit.issues.slice(i + 1)]
        .map((is, idx) => ({ ...is, id: `iss_${idx + 1}` }))
    });
  }

  function moveIssue(i: number, direction: "up" | "down") {
    if (!edit) return;
    const issues = [...edit.issues];
    const target = i + (direction === "up" ? -1 : 1);
    if (target < 0 || target >= issues.length) return;
    [issues[i], issues[target]] = [issues[target], issues[i]];
    setEdit({ ...edit, issues: issues.map((iss, idx) => ({ ...iss, id: `iss_${idx + 1}` })) });
  }

  function addGroup() {
    if (!edit) return;
    const issues = edit.issues;
    const newGroup = {
      name: `Group ${edit.stakeholder_groups.length + 1}`,
      description: "",
      size_hint: "medium" as const,
      population_weight: undefined,
      demographic_characteristics: "",
      geographic_distribution: "",
      economic_characteristics: "",
      interests: [],
      priorities: [],
      concerns: [],
      incentives: "",
      constraints: "",
      typical_information_sources: [],
      initial_stance: 0,
      stance_distribution: "",
      influence: 1,
      sensitivity: 1,
      trust_level: 0.5,
      institutional_power: 1,
      behavioural_tendencies: "",
      stance_by_issue: Object.fromEntries(issues.map((iss) => [iss.id, 0])),
    };
    setEdit({ ...edit, stakeholder_groups: [...edit.stakeholder_groups, newGroup] });
  }

  function removeGroup(i: number) {
    if (!edit) return;
    setEdit({ ...edit, stakeholder_groups: edit.stakeholder_groups.filter((_, j) => j !== i) });
  }

  function duplicateGroup(i: number) {
    if (!edit) return;
    const g = edit.stakeholder_groups[i];
    setEdit({ ...edit, stakeholder_groups: [...edit.stakeholder_groups, { ...g, name: g.name + " (copy)" }] });
  }

  async function save(): Promise<boolean> {
    if (!sourceId || !edit) return false;
    setSaving(true);
    setSaveState("saving");
    onError(null);
    try {
      const r = await api.updateBrief(sourceId, edit);
      setBrief(r.brief);
      setEdit(r.brief);
      setSaveState("saved");
      return true;
    } catch (e) {
      onError(e);
      setSaveState("error");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function addPresetIssue(preset: { name: string; category: string }) {
    if (!edit) return;
    setEdit({
      ...edit,
      issues: [...edit.issues, {
        id: `iss_${edit.issues.length + 1}`,
        name: preset.name,
        question: "",
        pro_label: "Supports",
        con_label: "Opposes",
        evidence_chunk_ids: [],
        category: preset.category,
        detailed_context: "",
        geographic_scope: "",
        time_horizon: "",
        current_situation: "",
        proposed_change: "",
        alternative_options: "",
        key_tradeoffs: "",
        evidence_sources: "",
        known_uncertainties: "",
        metrics: "",
        decision_question: "",
      }],
    });
    setSaveState("idle");
  }

  function addPresetGroup(name: string) {
    if (!edit) return;
    const issues = edit.issues;
    setEdit({
      ...edit,
      stakeholder_groups: [...edit.stakeholder_groups, {
        name,
        description: "",
        size_hint: "medium" as const,
        population_weight: undefined,
        demographic_characteristics: "",
        geographic_distribution: "",
        economic_characteristics: "",
        interests: [],
        priorities: [],
        concerns: [],
        incentives: "",
        constraints: "",
        typical_information_sources: [],
        initial_stance: 0,
        stance_distribution: "",
        influence: 1,
        sensitivity: 1,
        trust_level: 0.5,
        institutional_power: 1,
        behavioural_tendencies: "",
        stance_by_issue: Object.fromEntries(issues.map((iss) => [iss.id, 0])),
      }],
    });
    setSaveState("idle");
  }

  // Calculate population representation for display
  const populationData = useMemo(() => {
    if (!edit) return { groups: [], totalWeight: 0, totalAgents: 0 };
    const groups = edit.stakeholder_groups;
    const weights = groups.map(g => g.population_weight ?? (g.size_hint === "large" ? 1.8 : g.size_hint === "small" ? 0.6 : 1.0));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    return {
      groups: groups.map((g, i) => ({
        ...g,
        interests: g.interests ?? [],
        priorities: g.priorities ?? [],
        concerns: g.concerns ?? [],
        popWeight: g.population_weight ?? (g.size_hint === "large" ? 1.8 : g.size_hint === "small" ? 0.6 : 1.0),
        popShare: totalWeight > 0 ? (g.population_weight ?? (g.size_hint === "large" ? 1.8 : g.size_hint === "small" ? 0.6 : 1.0)) / totalWeight : 1 / groups.length,
        agentShare: 0, // will be filled after agents are seeded
        deviation: 0,
      })),
      totalWeight,
      totalAgents: 0,
    };
  }, [edit]);

  const handleNext = async () => {
    const success = await save();
    if (success) onNext();
  };

  return (
    <div className="panel panel-body">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="t-h2">
            {mode === "question" ? "Research question"
              : mode === "issues" ? "Issues"
                : "Stakeholder groups"}
          </h2>
          <p className="t-body fg-2 mt-1 mb-4" style={{ maxWidth: 640 }}>
            {mode === "question" ? (
              <>Name the simulation and state what you want to learn. The model reads the
                document and drafts the issues and stakeholder groups from it — you review
                and edit them on the next two steps.</>
            ) : mode === "issues" ? (
              <>Every issue the population cares about. Add as many as you need — nothing is
                truncated. Agents hold a separate stance on each issue.</>
            ) : (
              <>Who is affected, and how they differ. Each group gets its own stance on every
                issue plus its own influence, exposure and concerns.</>
            )}
          </p>
        </div>
        <GeneratedTag title="The scenario brief is drafted by the configured model from this source" />
      </div>

      {/* Save state is shown explicitly — never claim a save that did not happen. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={`status ${saveState === "saved" ? "status-ok" : saveState === "error" ? "status-err" : saveState === "saving" ? "status-queued" : "status-idle"}`}>
          <span className={`dot${saveState === "saving" ? " dot-pulse" : ""}`} />
          {saveState === "saved" ? "Saved to source"
            : saveState === "saving" ? "Saving…"
              : saveState === "error" ? "Save failed"
                : "Draft autosaved in this browser"}
        </span>
        <span className="t-meta">
          {brief ? `${(edit ?? brief).issues.length} issues · ${(edit ?? brief).stakeholder_groups.length} groups` : "No brief yet"}
        </span>
      </div>

      {mode === "question" && (
        <>
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
            <span className="label">Research question</span>
            <textarea
              className="input"
              placeholder={'e.g. "How will our town react if the council approves the wind project next quarter?"'}
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            />
            <span className="hint">
              One clear question. This steers which parts of the document the model reads.
            </span>
          </label>
          {!scenario.trim() && brief && (
            <button className="btn btn-ghost btn-sm mt-2" onClick={() => setScenario(draftQuestion)}>
              Use a draft question from the brief
            </button>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" onClick={onGenerate} disabled={!canGen || busy}>
              <Wand2 size={15} /> {brief ? "Regenerate brief" : "Draft the brief"}
            </button>
            {busy && <Spinner label="The model is reading your document…" />}
          </div>
        </>
      )}

      {mode === "issues" && brief && (
        <div className="mt-2 flex flex-col gap-3">
          {!edit && (
            <div className="banner banner-warn">
              <span>
                The brief is generated. Reload or re-draft if the issue list is empty, then edit below.
              </span>
            </div>
          )}
          {edit && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">Quick add</span>
                {ISSUE_PRESETS.map((p) => (
                  <button key={p.name} className="chip" onClick={() => addPresetIssue(p)} disabled={busy}
                          title={`Add "${p.name}" as an issue`}>
                    + {p.name}
                  </button>
                ))}
              </div>
              <IssueBuilder
                edit={edit}
                brief={brief}
                sourceId={sourceId}
                busy={busy}
                onError={onError}
                onPatch={patchIssue}
                onAdd={addIssue}
                onRemove={removeIssue}
                onDuplicate={duplicateIssue}
                onMove={moveIssue}
                categories={ISSUE_CATEGORIES}
              />
            </>
          )}
        </div>
      )}

      {mode === "groups" && brief && (
        <div className="mt-2 flex flex-col gap-3">
          {!edit && (
            <div className="banner banner-warn">
              <span>
                The brief is generated. Reload or re-draft if the group list is empty, then edit below.
              </span>
            </div>
          )}
          {edit && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">Quick add</span>
                {GROUP_PRESETS.map((g) => (
                  <button key={g} className="chip" onClick={() => addPresetGroup(g)} disabled={busy}
                          title={`Add "${g}" as a stakeholder group`}>
                    + {g}
                  </button>
                ))}
              </div>
              {edit.stakeholder_groups.length > maxGroups && (
                <div className="banner banner-warn" role="status">
                  <span>
                    {edit.stakeholder_groups.length} groups configured but only {agents} agents are
                    planned. Groups beyond the agent count cannot each receive an agent — raise the
                    population on the next step, or the seeding step will report which groups were
                    left out.
                  </span>
                </div>
              )}
              <StakeholderGroupBuilder
                edit={edit}
                brief={brief}
                populationData={populationData}
                busy={busy}
                onError={onError}
                onPatch={patchGroup}
                onAdd={addGroup}
                onRemove={removeGroup}
                onDuplicate={duplicateGroup}
              />
            </>
          )}
        </div>
      )}

      {!brief && (
        <div className="banner banner-info mt-4" role="status">
          <span>
            {mode === "question"
              ? "Draft the brief to generate an initial issue and stakeholder list."
              : "No brief yet — go back to Research question and draft it first."}
          </span>
        </div>
      )}

      <Nav
        onBack={onBack}
        nextLabel={mode === "question" ? "Review issues" : mode === "issues" ? "Review stakeholders" : "Set up the population"}
        onNext={brief ? handleNext : undefined}
        busy={busy || saving}
      />
    </div>
  );
}

function IssueBuilder({ edit, brief, sourceId, busy, onError, onPatch, onAdd, onRemove, onDuplicate, onMove, categories }: {
  edit: WorldBrief | null;
  brief: WorldBrief | null;
  sourceId: string | null;
  busy: boolean;
  onError: (e: unknown) => void;
  onPatch: (i: number, patch: Partial<WorldBrief["issues"][number]>) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onDuplicate: (i: number) => void;
  onMove: (i: number, direction: "up" | "down") => void;
  categories: { value: string; label: string }[];
}) {
  if (!edit) return null;
  const issues = edit.issues;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">Issues — {issues.length}</span>
        <button className="btn btn-primary btn-sm" onClick={onAdd} disabled={busy}>
          <span>+ Add Issue</span>
        </button>
      </div>
      {issues.length === 0 && (
        <div className="panel-2 p-4 text-center">
          <p className="t-meta">No issues defined yet. Add an issue to get started.</p>
        </div>
      )}
      {issues.map((iss, i) => (
        <div key={iss.id} className="panel-2 p-3.5 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="t-id">{iss.id}</span>
              <span className="badge">{iss.category}</span>
            </div>
            <div className="flex items-center gap-1">
              {i > 0 && <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onMove(i, "up")} title="Move up"><span>↑</span></button>}
              {i < issues.length - 1 && <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onMove(i, "down")} title="Move down"><span>↓</span></button>}
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onDuplicate(i)} title="Duplicate"><span>⧉</span></button>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onRemove(i)} title="Remove"><span>×</span></button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field"><span className="label">Name</span>
              <input className="input" value={iss.name} onChange={(e) => onPatch(i, { name: e.target.value })} />
            </label>
            <label className="field"><span className="label">Category</span>
              <select className="input" value={iss.category} onChange={(e) => onPatch(i, { category: e.target.value })}>
                {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span className="label">Question</span>
            <textarea className="input" style={{ minHeight: 64 }} value={iss.question} onChange={(e) => onPatch(i, { question: e.target.value })} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field"><span className="label">Pro label</span>
              <input className="input" value={iss.pro_label} onChange={(e) => onPatch(i, { pro_label: e.target.value })} />
            </label>
            <label className="field"><span className="label">Con label</span>
              <input className="input" value={iss.con_label} onChange={(e) => onPatch(i, { con_label: e.target.value })} />
            </label>
          </div>
          <label className="field"><span className="label">Detailed context</span>
            <textarea className="input" style={{ minHeight: 64 }} value={iss.detailed_context} onChange={(e) => onPatch(i, { detailed_context: e.target.value })} />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="field"><span className="label">Geographic scope</span>
              <input className="input" value={iss.geographic_scope} onChange={(e) => onPatch(i, { geographic_scope: e.target.value })} />
            </label>
            <label className="field"><span className="label">Time horizon</span>
              <input className="input" value={iss.time_horizon} onChange={(e) => onPatch(i, { time_horizon: e.target.value })} />
            </label>
            <label className="field"><span className="label">Current situation</span>
              <input className="input" value={iss.current_situation} onChange={(e) => onPatch(i, { current_situation: e.target.value })} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field"><span className="label">Proposed change</span>
              <input className="input" value={iss.proposed_change} onChange={(e) => onPatch(i, { proposed_change: e.target.value })} />
            </label>
            <label className="field"><span className="label">Alternative options</span>
              <input className="input" value={iss.alternative_options} onChange={(e) => onPatch(i, { alternative_options: e.target.value })} />
            </label>
          </div>
          <label className="field"><span className="label">Key trade-offs</span>
            <textarea className="input" style={{ minHeight: 64 }} value={iss.key_tradeoffs} onChange={(e) => onPatch(i, { key_tradeoffs: e.target.value })} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field"><span className="label">Evidence sources</span>
              <input className="input" value={iss.evidence_sources} onChange={(e) => onPatch(i, { evidence_sources: e.target.value })} />
            </label>
            <label className="field"><span className="label">Known uncertainties</span>
              <input className="input" value={iss.known_uncertainties} onChange={(e) => onPatch(i, { known_uncertainties: e.target.value })} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field"><span className="label">Metrics</span>
              <input className="input" value={iss.metrics} onChange={(e) => onPatch(i, { metrics: e.target.value })} />
            </label>
            <label className="field"><span className="label">Decision question</span>
              <input className="input" value={iss.decision_question} onChange={(e) => onPatch(i, { decision_question: e.target.value })} />
            </label>
          </div>
          {iss.evidence_chunk_ids.length > 0 && sourceId && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="eyebrow">Evidence chunks</span>
              <EvidenceChips sourceId={sourceId} ids={iss.evidence_chunk_ids} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function StakeholderGroupBuilder({ edit, brief, populationData, busy, onError, onPatch, onAdd, onRemove, onDuplicate }: {
  edit: WorldBrief | null;
  brief: WorldBrief | null;
  populationData: { groups: { name: string; popWeight: number; popShare: number; agentShare: number; deviation: number; population_weight?: number; size_hint: string; description: string; interests?: string[]; priorities?: string[]; concerns?: string[]; incentives?: string; constraints?: string; typical_information_sources?: string[]; initial_stance?: number; stance_distribution?: string; influence?: number; sensitivity?: number; trust_level?: number; institutional_power?: number; behavioural_tendencies?: string; stance_by_issue: Record<string, number> }[]; totalWeight: number; totalAgents: number };
  busy: boolean;
  onError: (e: unknown) => void;
  onPatch: (i: number, patch: Partial<WorldBrief["stakeholder_groups"][number]>) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onDuplicate: (i: number) => void;
}) {
  if (!edit) return null;
  const groups = edit.stakeholder_groups;
  const issues = edit?.issues ?? brief?.issues ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">Stakeholder Groups — {groups.length}</span>
        <button className="btn btn-primary btn-sm" onClick={onAdd} disabled={busy}>
          <span>+ Add Group</span>
        </button>
      </div>
      {groups.length === 0 && (
        <div className="panel-2 p-4 text-center">
          <p className="t-meta">No stakeholder groups defined yet. Add a group to get started.</p>
        </div>
      )}
      {groups.map((g, i) => {
        const popInfo = populationData.groups[i];
        const popSharePct = popInfo ? Math.round(popInfo.popShare * 100) : 0;
        return (
          <div key={i} className="panel-2 p-3.5 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="t-id">Group {i + 1}</span>
                <span className="badge">{g.size_hint}</span>
                {popInfo && <span className="badge" style={{ background: "var(--accent)", color: "var(--accent-fg)" }}>{popSharePct}% population</span>}
              </div>
              <div className="flex items-center gap-1">
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onDuplicate(i)} title="Duplicate"><span>⧉</span></button>
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onRemove(i)} title="Remove"><span>×</span></button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field"><span className="label">Name</span>
                <input className="input" value={g.name} onChange={(e) => onPatch(i, { name: e.target.value })} />
              </label>
              <label className="field"><span className="label">Population weight</span>
                <input className="input" type="number" step="0.1" min="0" value={g.population_weight ?? ""} onChange={(e) => onPatch(i, { population_weight: e.target.value ? Number(e.target.value) : undefined })} />
                <span className="hint">Relative weight (e.g. 1.0 = baseline, 1.8 = large). If empty, size_hint is used.</span>
              </label>
            </div>
            <label className="field"><span className="label">Description</span>
              <input className="input" value={g.description} onChange={(e) => onPatch(i, { description: e.target.value })} />
            </label>
            <label className="field"><span className="label">Demographic characteristics</span>
              <input className="input" value={g.demographic_characteristics} onChange={(e) => onPatch(i, { demographic_characteristics: e.target.value })} />
            </label>
            <label className="field"><span className="label">Geographic distribution</span>
              <input className="input" value={g.geographic_distribution} onChange={(e) => onPatch(i, { geographic_distribution: e.target.value })} />
            </label>
            <label className="field"><span className="label">Economic characteristics</span>
              <input className="input" value={g.economic_characteristics} onChange={(e) => onPatch(i, { economic_characteristics: e.target.value })} />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="field"><span className="label">Influence</span>
                <input className="input" type="number" step="1" min="0" max="10" value={g.influence} onChange={(e) => onPatch(i, { influence: Number(e.target.value) })} />
              </label>
              <label className="field"><span className="label">Sensitivity</span>
                <input className="input" type="number" step="1" min="0" max="10" value={g.sensitivity} onChange={(e) => onPatch(i, { sensitivity: Number(e.target.value) })} />
              </label>
              <label className="field"><span className="label">Trust level</span>
                <input className="input" type="number" step="0.1" min="0" max="1" value={g.trust_level} onChange={(e) => onPatch(i, { trust_level: Number(e.target.value) })} />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field"><span className="label">Institutional power</span>
                <input className="input" type="number" step="1" min="0" max="10" value={g.institutional_power} onChange={(e) => onPatch(i, { institutional_power: Number(e.target.value) })} />
              </label>
              <label className="field"><span className="label">Initial stance</span>
                <input className="input" type="number" step="0.1" min="-1" max="1" value={g.initial_stance} onChange={(e) => onPatch(i, { initial_stance: Number(e.target.value) })} />
              </label>
            </div>
            <label className="field"><span className="label">Interests (comma-separated)</span>
              <input className="input" value={g.interests?.join(", ") ?? ""} onChange={(e) => onPatch(i, { interests: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
            </label>
            <label className="field"><span className="label">Priorities (comma-separated)</span>
              <input className="input" value={g.priorities?.join(", ") ?? ""} onChange={(e) => onPatch(i, { priorities: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
            </label>
            <label className="field"><span className="label">Concerns (comma-separated)</span>
              <input className="input" value={g.concerns?.join(", ") ?? ""} onChange={(e) => onPatch(i, { concerns: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field"><span className="label">Incentives</span>
                <input className="input" value={g.incentives} onChange={(e) => onPatch(i, { incentives: e.target.value })} />
              </label>
              <label className="field"><span className="label">Constraints</span>
                <input className="input" value={g.constraints} onChange={(e) => onPatch(i, { constraints: e.target.value })} />
              </label>
            </div>
            <label className="field"><span className="label">Typical information sources (comma-separated)</span>
              <input className="input" value={g.typical_information_sources?.join(", ") ?? ""} onChange={(e) => onPatch(i, { typical_information_sources: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
            </label>
            <label className="field"><span className="label">Stance distribution</span>
              <input className="input" value={g.stance_distribution} onChange={(e) => onPatch(i, { stance_distribution: e.target.value })} />
            </label>
            <label className="field"><span className="label">Behavioural tendencies</span>
              <textarea className="input" style={{ minHeight: 64 }} value={g.behavioural_tendencies} onChange={(e) => onPatch(i, { behavioural_tendencies: e.target.value })} />
            </label>
            {issues.length > 0 && (
              <div className="panel-2 p-3">
                <span className="eyebrow">Initial stances per issue</span>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {issues.map((iss) => (
                    <label key={iss.id} className="field">
                      <span className="label">{iss.name} ({iss.id})</span>
                      <input className="input" type="number" step="0.1" min="-1" max="1" value={g.stance_by_issue?.[iss.id] ?? 0}
                        onChange={(e) => onPatch(i, { stance_by_issue: { ...g.stance_by_issue, [iss.id]: Number(e.target.value) } })} />
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EvidenceChips({ sourceId, ids }: { sourceId: string; ids: string[] }) {
  const [pages, setPages] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let alive = true;
    ids.slice(0, 4).forEach((id) => {
      fetchChunk(sourceId, id).then((info) => {
        if (alive) setPages((m) => ({ ...m, [id]: info.page }));
      }).catch(() => undefined);
    });
    return () => { alive = false; };
  }, [sourceId, ids.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {ids.slice(0, 3).map((c) => (
        <span key={c} className="cite" style={{ cursor: "default", height: 20 }}>
          {pages[c] != null && <><span className="cite-p">p. {pages[c]}</span><span className="cite-sep">·</span></>}
          <span>{c.length > 10 ? c.slice(0, 10) : c}</span>
        </span>
      ))}
    </>
  );
}

function StepPopulation(p: {
  agents: number; setAgents: (n: number) => void;
  ticks: number; setTicks: (n: number) => void;
  mix: { pro: number; con: number; neu: number };
  setMix: (m: { pro: number; con: number; neu: number }) => void;
  brief: WorldBrief | null;
  preset: string;
  applyPreset: (name: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const groupCount = p.brief?.stakeholder_groups.length ?? 0;
  const shortfall = groupCount > 0 && p.agents < groupCount;
  return (
    <div className="panel panel-body">
      <h2 className="t-h2">Population</h2>
      <p className="t-body fg-2 mt-1 mb-4" style={{ maxWidth: 620 }}>
        How many simulated people take part, and how long the world runs. Every configured
        stakeholder group receives at least one agent when the population is large enough.
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
              {ps.agents} agents · {ps.ticks} rounds
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="field">
          <span className="label">Agents <span className="opt mono">{p.agents}</span></span>
          <input type="range" min={5} max={500} value={p.agents}
                 onChange={(e) => p.setAgents(+e.target.value)} className="w-full" />
          <span className="hint">
            {groupCount
              ? `${groupCount} configured group(s); one agent each needs at least ${groupCount}.`
              : "Each agent is one simulated person."}
          </span>
        </label>
        <label className="field">
          <span className="label">Rounds <span className="opt mono">{p.ticks}</span></span>
          <input type="range" min={1} max={500} value={p.ticks}
                 onChange={(e) => p.setTicks(+e.target.value)} className="w-full" />
          <span className="hint">One round is one cycle of reading, reacting and posting.</span>
        </label>
      </div>

      {shortfall && (
        <div className="banner banner-warn mt-4" role="status">
          <span>
            {groupCount} stakeholder groups but only {p.agents} agents: {groupCount - p.agents}
            {" "}group(s) will receive no agent. The seeding step reports exactly which ones.
            Raise the agent count to include every group.
          </span>
        </div>
      )}

      <div className="panel-2 mt-5 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="eyebrow">Stance mix</span>
          <span className="t-meta">normalized at launch · {p.mix.pro + p.mix.neu + p.mix.con}% shown</span>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {([["pro", "Supports"], ["neu", "Undecided"], ["con", "Opposes"]] as const).map(([k, label]) => (
            <label key={k} className="field">
              <span className="label">{label} <span className="opt mono">{p.mix[k]}%</span></span>
              <input type="range" min={0} max={100} value={p.mix[k]}
                     onChange={(e) => p.setMix({ ...p.mix, [k]: Number(e.target.value) })}
                     className="w-full" />
            </label>
          ))}
        </div>
        <p className="hint mt-2">
          The brief's stakeholder groups and these weights seed each agent's initial stance. The
          sample is deterministic for a given seed; the exact assignment is visible after seeding.
        </p>
      </div>

      {p.brief && (
        <div className="panel-2 mt-5 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="eyebrow">Stakeholder groups from the scenario</span>
            <span className="t-meta">{p.brief.stakeholder_groups.length} groups</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {p.brief.stakeholder_groups.map((g) => (
              <span key={g.name} className="chip" style={{ cursor: "default" }}>
                {g.name}
                <span className="chip-n">{g.size_hint}</span>
              </span>
            ))}
          </div>
          <p className="hint mt-2">
            Agents are sampled across these groups by size hint; per-agent assignment appears in
            the Agents tab after seeding.
          </p>
        </div>
      )}

      <Nav onBack={p.onBack} nextLabel="Simulation settings" onNext={p.onNext} />
    </div>
  );
}

function StepSettings(p: {
  writesPerTick: number; setWritesPerTick: (n: number) => void;
  seed: number; setSeed: (n: number) => void;
  est: EstimateResponse | null;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="panel panel-body">
      <h2 className="t-h2">Simulation settings</h2>
      <p className="t-body fg-2 mt-1 mb-4" style={{ maxWidth: 620 }}>
        How the world moves. Writes control how many agents post each round; the seed fixes the
        population structure and deterministic choices. Model-written text can still vary.
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="field">
          <span className="label">Writes per round <span className="opt mono">{p.writesPerTick}</span></span>
          <input type="range" min={0} max={20} value={p.writesPerTick}
                 onChange={(e) => p.setWritesPerTick(+e.target.value)} className="w-full" />
          <span className="hint">
            How many agents post each round. 0 = reactions and stance updates only, no new posts.
          </span>
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
          <span className="hint">Same seed → same population structure; provider text can vary.</span>
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

      <Nav onBack={p.onBack} nextLabel="Review" onNext={p.onNext} />
    </div>
  );
}

function StepRun(p: {
  mode: "review" | "launch";
  source: SourceStats | null;
  name: string;
  setName: (s: string) => void;
  scenario: string;
  brief: WorldBrief | null;
  agents: number;
  ticks: number;
  writesPerTick: number;
  seed: number;
  mix: { pro: number; con: number; neu: number };
  est: EstimateResponse | null;
  busy: boolean;
  onBack: () => void;
  onLaunch: () => void;
  onNext?: () => void;
}) {
  const missingBrief = !p.brief;
  const [provider, setProvider] = useState<{ name: string; model: string; rpm: number | null } | null>(null);
  useEffect(() => {
    Promise.all([api.getHealth(), api.getSettings()])
      .then(([h, s]) => {
        const raw = s.settings.llm_rpm;
        const rpm = raw == null || raw === "" ? null : Number(raw);
        setProvider({ name: h.provider, model: String(s.settings.llm_model ?? ""), rpm: Number.isFinite(rpm as number) ? rpm as number : null });
      })
      .catch(() => setProvider(null));
  }, []);
  const providerLabel = provider
    ? provider.name === "mock"
      ? "mock (deterministic)"
      : `${provider.name}${provider.model ? ` · ${provider.model}` : ""}`
    : "…";
  const summary = useMemo(() => [
    ["Name", p.name || "—"],
    ["Source", p.source?.filename ?? "—"],
    ["Scenario", p.scenario.slice(0, 60) + (p.scenario.length > 60 ? "…" : "")],
    ["Issues", String(p.brief?.issues.length ?? 0)],
    ["Stakeholder groups", String(p.brief?.stakeholder_groups.length ?? 0)],
    ["Agents / writes", `${p.agents} · ${p.writesPerTick}/round`],
    ["Rounds", String(p.ticks)],
    ["Stance mix", `Supports ${p.mix.pro}% · Undecided ${p.mix.neu}% · Opposes ${p.mix.con}%`],
    ["Seed", String(p.seed)],
    ["LLM call budget", String(p.est?.estimate.max_llm_calls ?? "—")],
    ["Provider", providerLabel],
  ], [p, providerLabel]);

  // Pre-flight: what will actually run, and what is wrong or risky about it.
  const preflight = useMemo(() => {
    const issues = p.brief?.issues.length ?? 0;
    const groups = p.brief?.stakeholder_groups.length ?? 0;
    const warnings: string[] = [];
    const errors: string[] = [];
    if (!p.source) errors.push("No source document selected.");
    if (!p.brief) errors.push("No scenario brief — issues and stakeholder groups are not defined.");
    if (p.brief && issues === 0) errors.push("The brief contains no issues.");
    if (p.brief && groups === 0) errors.push("The brief contains no stakeholder groups.");
    if (p.brief && groups > p.agents) {
      warnings.push(
        `${groups} stakeholder groups but only ${p.agents} agents: ${groups - p.agents} group(s) `
        + "will receive no agent. The run log will name them.");
    }
    if (p.ticks < 2) warnings.push("Only one round is configured; stance change cannot be observed.");
    if (p.writesPerTick === 0) {
      warnings.push("Writes per round is 0, so no agent will post — reactions only.");
    }
    if (!p.scenario.trim()) warnings.push("No research question set.");
    return { issues, groups, warnings, errors };
  }, [p.brief, p.source, p.agents, p.ticks, p.writesPerTick, p.scenario]);

  return (
    <div className="panel panel-body">
      <h2 className="t-h2">{p.mode === "review" ? "Review" : "Launch"}</h2>
      <p className="t-body fg-2 mt-1 mb-4" style={{ maxWidth: 560 }}>
        {p.mode === "review"
          ? "Check the configuration before starting. Nothing runs until you press Start run."
          : (
            <>
              {p.ticks} rounds · ≤ {p.est?.estimate?.max_llm_calls ?? "—"} LLM calls. You can pause or
              stop at any moment; every round is committed atomically, so a crash never loses a
              finished round.
            </>
          )}
      </p>

      {/* Pre-flight validation: the user must see exactly what will run. */}
      <div className="panel-2 mb-4 p-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="eyebrow">Pre-launch check</span>
          <span className="flex gap-2">
            <span className={`badge ${preflight.errors.length ? "status-err" : "status-ok"}`}>
              {preflight.errors.length} error{preflight.errors.length === 1 ? "" : "s"}
            </span>
            <span className={`badge ${preflight.warnings.length ? "status-partial" : "status-ok"}`}>
              {preflight.warnings.length} warning{preflight.warnings.length === 1 ? "" : "s"}
            </span>
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ["Issues", preflight.issues],
            ["Groups", preflight.groups],
            ["Agents", p.agents],
            ["Rounds", p.ticks],
          ] as const).map(([k, v]) => (
            <div key={k}>
              <dt className="t-meta">{k}</dt>
              <dd className="mono m-0" style={{ fontSize: 16, color: "var(--fg-1)" }}>{v}</dd>
            </div>
          ))}
        </dl>
        {preflight.errors.length > 0 && (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" role="alert">
            {preflight.errors.map((e) => (
              <li key={e} className="t-meta" style={{ color: "var(--err-fg)" }}>✕ {e}</li>
            ))}
          </ul>
        )}
        {preflight.warnings.length > 0 && (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {preflight.warnings.map((w) => (
              <li key={w} className="t-meta" style={{ color: "var(--warn-fg)" }}>⚠ {w}</li>
            ))}
          </ul>
        )}
        {preflight.errors.length === 0 && preflight.warnings.length === 0 && (
          <p className="t-meta mt-2">
            No blocking errors and no warnings. The configuration is complete.
          </p>
        )}
      </div>

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
      {p.mode === "review" && p.brief && (
        <div className="panel-2 mt-4 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="eyebrow">What the population will argue about</span>
            <span className="t-meta">
              {p.brief.issues.length} issues · {p.brief.stakeholder_groups.length} groups
            </span>
          </div>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {p.brief.issues.map((i) => (
              <li key={i.id} className="flex items-baseline gap-2">
                <span className="t-id">{i.id}</span>
                <span className="t-body">{i.name}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {p.brief.stakeholder_groups.map((g) => (
              <span key={g.name} className="chip" style={{ cursor: "default" }}>{g.name}</span>
            ))}
          </div>
        </div>
      )}
      <p className="t-meta mt-3">
        {provider?.rpm
          ? `At ${provider.rpm} calls/minute, about ${Math.max(1, Math.ceil((p.est?.estimate?.core_calls ?? 0) / provider.rpm))} minutes of provider time.`
          : "Provider time cannot be estimated until a rate is configured."}{" "}
        Cost is unknown for this provider; the call budget is the hard limit.
      </p>
      {p.mode === "review" ? (
        <Nav onBack={p.onBack} nextLabel="Continue to launch" onNext={p.onNext} busy={p.busy} />
      ) : (
        <Nav onBack={p.onBack} nextLabel="Start run" onNext={p.onLaunch} busy={p.busy} />
      )}
      {p.busy && <div className="mt-3"><Spinner label="Creating the run…" /></div>}
    </div>
  );
}
