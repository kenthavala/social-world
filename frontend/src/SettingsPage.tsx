import { useEffect, useRef, useState } from "react";
import { KeyRound, RefreshCw, Send, ShieldCheck } from "lucide-react";
import type { Provider, SettingsResponse, TestReport } from "./types";
import * as api from "./api";
import { Spinner } from "./common";

export default function SettingsPage({ onSaved, onError }: {
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [models, setModels] = useState<string[] | null>(null);
  const [freeIds, setFreeIds] = useState<string[]>([]);
  const [freeOnly, setFreeOnly] = useState(false);
  const [testReport, setTestReport] = useState<TestReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = useRef(false);

  useEffect(() => {
    setBusy(true);
    Promise.all([api.listProviders(), api.getSettings()])
      .then(([p, s]) => {
        setProviders(p.providers);
        setSettings(s);
        setForm(Object.fromEntries(Object.entries(s.settings).map(([k, v]) => [k, String(v ?? "")])));
      })
      .catch((e) => onError(e))
      .finally(() => setBusy(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchModels() {
    if (!form.llm_provider) return;
    setBusy(true);
    try {
      const r = await api.listProviderModels(form.llm_provider);
      setModels(r.models);
      setFreeIds(r.free_only ?? []);
      if (!r.free_only || r.free_only.length === 0) setFreeOnly(false);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    onError(null);
    try {
      const numeric = new Set(["llm_temperature", "llm_max_tokens", "llm_timeout_seconds", "llm_rpm", "llm_concurrency"]);
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (v === "") continue;
        payload[k] = numeric.has(k) ? Number(v) : k === "llm_cache" || k === "llm_replay" ? v === "true" : v;
      }
      await api.saveSettings(payload, Object.keys(keys).length ? keys : undefined);
      const s = await api.getSettings();
      setSettings(s);
      setForm(Object.fromEntries(Object.entries(s.settings).map(([k, v]) => [k, String(v ?? "")])));
      setKeys({});
      dirty.current = false;
      onSaved();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      setTestReport(await api.testProvider(form.llm_provider, form.llm_model));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  const field = (k: string) => form[k] ?? "";
  const setField = (k: string, v: string) => {
    dirty.current = true;
    setForm((f) => ({ ...f, [k]: v }));
    setModels(null);
  };

  const currentProvider = providers?.find((p) => p.name === field("llm_provider"));
  const keySet = currentProvider?.key_env ? settings?.keys?.[currentProvider.key_env] : undefined;

  if (busy && settings === null) return <div className="pt-8"><Spinner label="Loading settings…" /></div>;

  return (
    <div className="pt-6 md:pt-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="t-h1">Settings</h1>
          <p className="t-body fg-2 mt-1">
            Stored in <code className="mono">settings.json</code>; API keys only ever go to{" "}
            <code className="mono">.env</code> and come back over the API as booleans.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {busy && settings !== null && <Spinner />}
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            <Send size={14} /> {saved ? "Saved ✓" : dirty.current ? "Save changes" : "Save"}
          </button>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {/* ---- provider + model ---- */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="t-h3">LLM provider</h2>
            {currentProvider && (
              <span className={`status ${currentProvider.name === "mock" ? "status-paused" : keySet ? "status-completed" : "status-draft"}`}>
                {currentProvider.name === "mock" ? <span className="dot" /> : keySet ? (
                  <svg className="ic-xs" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5 6.5 12 13 4.5" /></svg>
                ) : <span className="dot" />}
                {currentProvider.name === "mock" ? "Offline mock" : keySet ? "Key set" : "No key"}
              </span>
            )}
          </div>
          <div className="panel-body flex flex-col gap-4">
            <label className="field">
              <span className="label">Provider</span>
              <select className="input" value={field("llm_provider")}
                      onChange={(e) => setField("llm_provider", e.target.value)}>
                {providers?.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}{p.key_env ? (p.has_key ? "  (key set)" : "  (no key)") : ""}
                  </option>
                ))}
              </select>
              {currentProvider?.notes && <span className="hint">{currentProvider.notes}</span>}
              {currentProvider && currentProvider.key_env && !currentProvider.has_key && (
                <span className="hint" style={{ color: "var(--warn-fg)" }}>
                  No API key set. Add it in the Keys section below, or set {currentProvider.key_env} in .env.
                </span>
              )}
            </label>

            {field("llm_provider") === "custom" && (
              <>
                <label className="field">
                  <span className="label">Base URL <span className="opt">(OpenAI-compatible)</span></span>
                  <input className="input mono" placeholder="http://127.0.0.1:11434/v1"
                         value={field("llm_base_url")}
                         onChange={(e) => setField("llm_base_url", e.target.value)} />
                </label>
                <label className="field">
                  <span className="label">Wire format</span>
                  <select className="input" value={field("llm_wire_format")}
                          onChange={(e) => setField("llm_wire_format", e.target.value)}>
                    <option value="openai_chat">openai_chat</option>
                    <option value="anthropic_messages">anthropic_messages</option>
                  </select>
                </label>
              </>
            )}

            <div className="field">
              <span className="label">Model</span>
              <div className="flex gap-2">
                <input className="input mono" value={field("llm_model")}
                       onChange={(e) => setField("llm_model", e.target.value)} />
                <button className="btn btn-ghost flex-none" onClick={fetchModels} disabled={busy}>
                  <RefreshCw size={13} /> List
                </button>
              </div>
              {models && (
                <>
                  <label className="t-meta mt-1 flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={freeOnly}
                           onChange={(e) => setFreeOnly(e.target.checked)} />
                    Free models only ({(freeIds ?? []).length} of {models.length} listed)
                  </label>
                  <select className="input mt-1.5" value={field("llm_model")}
                          onChange={(e) => setField("llm_model", e.target.value)}>
                    <option value="" disabled>(pick from the list)</option>
                    {(freeIds ?? []).length === 0 && freeOnly && (
                      <option value="" disabled>(no free models listed — clear the filter)</option>
                    )}
                    {(freeOnly ? (freeIds ?? []) : models).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </>
              )}
            </div>

            <label className="field">
              <span className="label">Fast model <span className="opt">(writes/reflect) — optional</span></span>
              <input className="input mono" value={field("llm_model_fast")}
                     onChange={(e) => setField("llm_model_fast", e.target.value)} />
            </label>

            <div className="flex items-center gap-2" style={{ borderTop: "1px solid var(--line-1)", paddingTop: 14 }}>
              <button className="btn" onClick={test} disabled={busy}>
                <RefreshCw size={13} /> Test connection
              </button>
              <span className="t-meta">sends one tiny JSON prompt through the gateway</span>
            </div>
            {testReport && (
              <div className="panel-2 p-3.5">
                <p className="t-h3">Test connection — {testReport.provider}</p>
                <p className="mono mt-1.5 t-meta" style={{ color: "var(--fg-2)" }}>
                  auth {testReport.auth_ok ? "✓" : "✗"} · model {testReport.model_ok ? "✓" : "✗"} ·
                  json {testReport.json_ok ? "✓" : "✗"}
                  {testReport.latency_ms !== null && ` · ${testReport.latency_ms} ms`}
                  {testReport.model && ` · ${testReport.model}`}
                </p>
                {testReport.error && <p className="t-meta mt-1" style={{ color: "var(--err-fg)" }}>{testReport.error}</p>}
                {testReport.hint && <p className="t-meta mt-1">{testReport.hint}</p>}
              </div>
            )}
          </div>
        </section>

        {/* ---- runtime ---- */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="t-h3">Runtime</h2>
            <span className="t-meta">rate limits, retries, caching</span>
          </div>
          <div className="panel-body">
            <div className="grid grid-cols-2 gap-4">
              <label className="field">
                <span className="label">Temperature</span>
                <input className="input" type="number" step="0.05" min="0" max="2"
                       value={field("llm_temperature")}
                       onChange={(e) => setField("llm_temperature", e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Max tokens</span>
                <input className="input" type="number" value={field("llm_max_tokens")}
                       onChange={(e) => setField("llm_max_tokens", e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Requests / min</span>
                <input className="input" type="number" value={field("llm_rpm")}
                       onChange={(e) => setField("llm_rpm", e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Concurrency</span>
                <input className="input" type="number" value={field("llm_concurrency")}
                       onChange={(e) => setField("llm_concurrency", e.target.value)} />
              </label>
            </div>
            <label className="field mt-4">
              <span className="label">Fallback models <span className="opt">(comma-separated)</span></span>
              <input className="input mono" value={field("llm_fallback_models")}
                     onChange={(e) => setField("llm_fallback_models", e.target.value)} />
              <span className="hint">Tried in order when the primary model keeps failing (429 / 5xx / timeouts).</span>
            </label>
            <label className="field mt-4">
              <span className="label">Fallback provider</span>
              <select className="input" value={field("llm_fallback_provider")}
                      onChange={(e) => setField("llm_fallback_provider", e.target.value)}>
                <option value="">(none)</option>
                {providers?.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </label>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <label className="field">
                <span className="label">Response cache</span>
                <select className="input" value={field("llm_cache") === "false" ? "false" : "true"}
                        onChange={(e) => setField("llm_cache", e.target.value)}>
                  <option value="true">on — repeat requests reuse recorded responses</option>
                  <option value="false">off — always call the provider</option>
                </select>
              </label>
              <label className="field">
                <span className="label">Replay mode</span>
                <select className="input" value={field("llm_replay") === "true" ? "true" : "false"}
                        onChange={(e) => setField("llm_replay", e.target.value)}>
                  <option value="false">off — live provider calls</option>
                  <option value="true">on — serve only from recorded responses</option>
                </select>
                <span className="hint">Replay asserts on any request with no prior identical recording.</span>
              </label>
            </div>
          </div>
        </section>

        {/* ---- keys ---- */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="t-h3 flex items-center gap-2"><KeyRound size={14} /> API keys</h2>
            <span className="t-meta">write-only · never returned by the API</span>
          </div>
          <div className="panel-body">
            <p className="t-meta mb-3">
              Keys are stored in <code className="mono">.env</code>, used server-side, and never
              echoed back. The badges show only whether a key is set.
            </p>
            <div className="grid gap-2.5">
              {(settings ? Object.keys(settings.keys) : []).map((envVar) => (
                <div key={envVar} className="flex items-center gap-2">
                  <span className={`badge ${settings?.keys?.[envVar] ? "s-ok" : ""}`} style={{ width: 68, justifyContent: "center" }}>
                    {settings?.keys?.[envVar] ? "set" : "not set"}
                  </span>
                  <input
                    className="input mono"
                    type="password"
                    placeholder={`paste ${envVar}`}
                    autoComplete="off"
                    onChange={(e) => { dirty.current = true; setKeys((k) => ({ ...k, [envVar]: e.target.value })); }}
                  />
                </div>
              ))}
            </div>
            {Object.keys(keys).length > 0 && (
              <p className="t-meta mt-2" style={{ color: "var(--warn-fg)" }}>
                {Object.keys(keys).length} key{Object.keys(keys).length === 1 ? "" : "s"} staged — click Save to write them to .env.
              </p>
            )}
          </div>
        </section>

        <RedactionSection onError={onError} />
      </div>
    </div>
  );
}

function RedactionSection({ onError }: { onError: (e: unknown) => void }) {
  const [rules, setRules] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function preview() {
    setBusy(true);
    try {
      const r = await api.redactPreview(message);
      setResult(r.redacted);
      setRules(r.rules);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="t-h3 flex items-center gap-2"><ShieldCheck size={14} /> Redaction</h2>
        <span className="t-meta">verify masking before it ever matters</span>
      </div>
      <div className="panel-body">
        <p className="t-meta mb-3">
          Every error, log line and displayed string passes through the same{" "}
          <code className="mono">redact()</code> function the gateway uses. Paste any text to see
          exactly what gets masked.{" "}
          {rules.length > 0 && (
            <>Rules: {rules.map((r) => <code key={r} className="badge mono mr-1">{r}</code>)}</>
          )}
        </p>
        <textarea className="input" value={message} onChange={(e) => setMessage(e.target.value)}
                  placeholder="e.g. Authorization: Bearer sk-abc123..." />
        <div className="mt-2.5 flex items-center gap-2">
          <button className="btn btn-ghost" onClick={preview} disabled={!message.trim() || busy}>
            Preview redaction
          </button>
          {busy && <Spinner />}
        </div>
        {result !== null && (
          <div className="code mt-2.5" style={{ whiteSpace: "pre-wrap" }}>
            {result}
          </div>
        )}
      </div>
    </section>
  );
}
