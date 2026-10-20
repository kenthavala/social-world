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

  if (busy && settings === null) return <Spinner label="Loading settings" />;

  return (
    <div className="pt-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="t-h1">Settings</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--fg-2)" }}>
            Stored in <code>settings.json</code>; API keys only ever go to <code>.env</code> and come
            back over the API as booleans.
          </p>
        </div>
        <button className="btn-primary" onClick={save} disabled={busy}>
          <Send size={14} /> {saved ? "Saved ✓" : dirty.current ? "Save changes" : "Save"}
        </button>
      </div>
      {busy && settings !== null && <div className="mb-3"><Spinner /></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-4">
          <h2 className="eyebrow mb-2">LLM provider</h2>
          <fieldset className="mb-3">
            <select className="input" value={field("llm_provider")}
                    onChange={(e) => setField("llm_provider", e.target.value)}>
              {providers?.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}{p.key_env ? (p.has_key ? "  (key set)" : "  (no key)") : ""}
                </option>
              ))}
            </select>
            {currentProvider?.notes && <p className="mt-1 text-xs" style={{ color: "var(--fg-3)" }}>{currentProvider.notes}</p>}
            {currentProvider && !currentProvider.has_key && (
              <p className="mt-1 text-xs" style={{ color: "var(--warn-fg)" }}>
                No API key set. Add it in the Keys section below, or set {currentProvider.key_env} in .env.
              </p>
            )}
          </fieldset>
          {field("llm_provider") === "custom" && (
            <>
              <fieldset className="mb-3">
                <label className="label">Base URL (OpenAI-compatible)</label>
                <input className="input" placeholder="http://127.0.0.1:11434/v1"
                       value={field("llm_base_url")}
                       onChange={(e) => setField("llm_base_url", e.target.value)} />
              </fieldset>
              <fieldset className="mb-3">
                <label className="label">Wire format</label>
                <select className="input" value={field("llm_wire_format")}
                        onChange={(e) => setField("llm_wire_format", e.target.value)}>
                  <option value="openai_chat">openai_chat</option>
                  <option value="anthropic_messages">anthropic_messages</option>
                </select>
              </fieldset>
            </>
          )}
          <fieldset className="mb-3">
            <label className="label">Model</label>
            <div className="flex gap-2">
              <input className="input" value={field("llm_model")}
                     onChange={(e) => setField("llm_model", e.target.value)} />
              <button className="btn-ghost btn-sm flex-none" onClick={fetchModels} disabled={busy}>
                <RefreshCw size={13} /> List
              </button>
            </div>
            {models && (
              <>
                <label className="mt-2 flex items-center gap-2 text-xs"
                       style={{ color: "var(--fg-2)" }}>
                  <input type="checkbox" checked={freeOnly}
                         onChange={(e) => setFreeOnly(e.target.checked)} />
                  Free models only ({(freeIds ?? []).length} of {models.length} listed)
                </label>
                <select className="input mt-2" value={field("llm_model")}
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
          </fieldset>
          <fieldset>
            <label className="label">Fast model (writes/reflect) — optional</label>
            <input className="input" value={field("llm_model_fast")}
                   onChange={(e) => setField("llm_model_fast", e.target.value)} />
          </fieldset>
        </section>

        <section className="panel p-4">
          <h2 className="eyebrow mb-2">Runtime</h2>
          <div className="grid grid-cols-2 gap-3">
            <fieldset>
              <label className="label">Temperature</label>
              <input className="input" type="number" step="0.05" min="0" max="2"
                     value={field("llm_temperature")}
                     onChange={(e) => setField("llm_temperature", e.target.value)} />
            </fieldset>
            <fieldset>
              <label className="label">Max tokens</label>
              <input className="input" type="number" value={field("llm_max_tokens")}
                     onChange={(e) => setField("llm_max_tokens", e.target.value)} />
            </fieldset>
            <fieldset>
              <label className="label">Requests / min</label>
              <input className="input" type="number" value={field("llm_rpm")}
                     onChange={(e) => setField("llm_rpm", e.target.value)} />
            </fieldset>
            <fieldset>
              <label className="label">Concurrency</label>
              <input className="input" type="number" value={field("llm_concurrency")}
                     onChange={(e) => setField("llm_concurrency", e.target.value)} />
            </fieldset>
          </div>
          <fieldset className="mt-3">
            <label className="label">Fallback models (comma-separated)</label>
            <input className="input" value={field("llm_fallback_models")}
                   onChange={(e) => setField("llm_fallback_models", e.target.value)} />
          </fieldset>
          <fieldset className="mt-3">
            <label className="label">Fallback provider</label>
            <select className="input" value={field("llm_fallback_provider")}
                    onChange={(e) => setField("llm_fallback_provider", e.target.value)}>
              <option value="">(none)</option>
              {providers?.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </fieldset>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <fieldset>
              <label className="label">Response cache</label>
              <select className="input" value={field("llm_cache") === "false" ? "false" : "true"}
                      onChange={(e) => setField("llm_cache", e.target.value)}>
                <option value="true">on — repeat requests reuse recorded responses</option>
                <option value="false">off — always call the provider</option>
              </select>
            </fieldset>
            <fieldset>
              <label className="label">Replay mode</label>
              <select className="input" value={field("llm_replay") === "true" ? "true" : "false"}
                      onChange={(e) => setField("llm_replay", e.target.value)}>
                <option value="false">off — live provider calls</option>
                <option value="true">on — serve only from recorded responses</option>
              </select>
              <p className="mt-1 text-[10px]" style={{ color: "var(--fg-3)" }}>
                Replay asserts on any request with no prior identical recording.
              </p>
            </fieldset>
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn-ghost" onClick={test} disabled={busy}>Test connection</button>
          </div>
          {testReport && (
            <div className="mt-3 rounded-lg p-3 text-xs"
                 style={{ background: "var(--bg-2)", border: "1px solid var(--line-1)" }}>
              <p className="t-h3">Test connection — {testReport.provider}</p>
              <p className="mono mt-1" style={{ color: "var(--fg-2)" }}>
                auth {testReport.auth_ok ? "✓" : "✗"} · model {testReport.model_ok ? "✓" : "✗"} ·
                json {testReport.json_ok ? "✓" : "✗"}
                {testReport.latency_ms !== null && ` · ${testReport.latency_ms} ms`}
                {testReport.model && ` · ${testReport.model}`}
              </p>
              {testReport.error && <p className="mt-1" style={{ color: "var(--err-fg)" }}>{testReport.error}</p>}
              {testReport.hint && <p className="mt-1" style={{ color: "var(--fg-3)" }}>{testReport.hint}</p>}
            </div>
          )}
        </section>

        <section className="panel p-4">
          <h2 className="eyebrow mb-2"><KeyRound className="inline" size={13} /> API keys</h2>
          <p className="mb-2 text-xs" style={{ color: "var(--fg-3)" }}>
            Keys are stored in <code>.env</code>, used server-side, and never returned by the API.
          </p>
          <div className="grid gap-2">
            {(settings ? Object.keys(settings.keys) : []).map((envVar) => (
              <div key={envVar} className="flex items-center gap-2">
                <span className={`badge ${settings?.keys?.[envVar] ? "s-ok" : ""}`}>
                  {settings?.keys?.[envVar] ? "set" : "not set"}
                </span>
                <input
                  className="input"
                  type="password"
                  placeholder={`paste ${envVar}`}
                  onChange={(e) => setKeys((k) => ({ ...k, [envVar]: e.target.value }))}
                />
              </div>
            ))}
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
    <section className="panel p-4">
      <h2 className="eyebrow mb-2"><ShieldCheck className="inline" size={13} /> Redaction</h2>
      <p className="mb-2 text-xs" style={{ color: "var(--fg-3)" }}>
        Every error, log line and displayed string passes through the same <code>redact()</code>
        function the gateway uses. Test it against a paste any text — masked tokens never leave
        as keys. Rules: {rules.length ? rules.map((r) => <code key={r} className="chip mr-1">{r}</code>)
          : <span>load via preview</span>}
      </p>
      <textarea className="input h-20" value={message} onChange={(e) => setMessage(e.target.value)}
                placeholder="e.g. Authorization: Bearer sk-abc123..." />
      <div className="mt-2 flex items-center gap-2">
        <button className="btn-ghost" onClick={preview} disabled={!message.trim() || busy}>
          Preview redaction
        </button>
        {busy && <Spinner />}
      </div>
      {result !== null && (
        <div className="mt-2 rounded p-2.5 text-xs mono"
             style={{ background: "var(--bg-2)", border: "1px solid var(--line-1)", whiteSpace: "pre-wrap" }}>
        {result}
        </div>
      )}
    </section>
  );
}
