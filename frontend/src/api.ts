// Thin fetch layer: every response is JSON; AppError bodies surface as thrown Errors.
import type {
  AppErrorShape,
  EstimateResponse,
  GraphResponse,
  MetricsResponse,
  Post,
  Provider,
  RunDetail,
  RunListItem,
  SettingsResponse,
  SourceStats,
  TestReport,
  WorldBrief,
  Agent,
  CompareResponse,
  FindingsResponse,
  SampleInfo,
} from "./types";

export class ApiError extends Error {
  hint: string | null;
  stage: string;
  constructor(info: AppErrorShape["error"]) {
    super(info.message);
    this.hint = info.hint;
    this.stage = `${info.component}/${info.stage}`;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, init);
  } catch {
    throw new ApiError({
      component: "ui", stage: "fetch", error_type: "network",
      message: "Backend unreachable. Is the server running on http://127.0.0.1:8000?",
      hint: "Run start.bat in the project folder.",
      http_status: null,
    });
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = body && body.error ? body.error : {
      component: "ui", stage: "fetch", error_type: "http",
      message: resp.statusText || `HTTP ${resp.status}`, hint: null, http_status: resp.status,
    };
    throw new ApiError(e);
  }
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

// health / providers / settings ------------------------------------------------

export const getHealth = () => call<{ ok: boolean; provider: string }>("/api/health");

export const listProviders = () => call<{ providers: Provider[] }>("/api/providers");

export const listProviderModels = (name: string) =>
  call<{ provider: string; models: string[]; free_only: string[] }>(
    `/api/providers/${name}/models`);

export const testProvider = (provider?: string, model?: string) =>
  call<TestReport>("/api/providers/test", json("POST", { provider, model }));

export const getSettings = () => call<SettingsResponse>("/api/settings");

export const saveSettings = (settings: Record<string, unknown>, keys?: Record<string, string>) =>
  call<SettingsResponse>("/api/settings", json("PUT", { settings, keys }));

// sources ----------------------------------------------------------------------

export function uploadSource(file: File): Promise<SourceStats> {
  const fd = new FormData();
  fd.append("file", file);
  return call<SourceStats>("/api/sources", { method: "POST", body: fd });
}

export function uploadSourceText(text: string, filename = "pasted.txt"): Promise<SourceStats> {
  const fd = new FormData();
  fd.append("text", text);
  fd.append("filename", filename);
  return call<SourceStats>("/api/sources", { method: "POST", body: fd });
}

export const getSource = (id: string) => call<SourceStats>(`/api/sources/${id}`);

export const getSourceEvidence = (id: string) =>
  call<import("./types").SourceEvidence>(`/api/sources/${id}/evidence`);

export const generateBrief = (
  id: string,
  scenario: string,
  hints?: { max_issues?: number; max_groups?: number },
) =>
  call<{ brief: WorldBrief }>(
    `/api/sources/${id}/brief`,
    json("POST", { scenario, ...(hints ?? {}) }),
  );

export const updateBrief = (id: string, brief: WorldBrief) =>
  call<{ brief: WorldBrief }>(`/api/sources/${id}/brief`, json("PUT", { brief }));

export const listSources = () => call<{ sources: SourceStats[] }>("/api/sources");
export const listChunks = (sourceId: string) =>
  call<{
    chunks: {
      id: string; idx: number; page_start: number | null; page_end: number | null;
      heading: string | null; n_words: number | null; citations: number;
    }[];
    count: number;
  }>(`/api/sources/${sourceId}/chunks`);
export const getChunk = (sourceId: string, chunkId: string) =>
  call<{ id: string; text: string; page_start: number | null; page_end: number | null }>(
    `/api/sources/${sourceId}/chunks/${chunkId}`);

// runs -----------------------------------------------------------------

export const estimate = (config: Record<string, unknown>) =>
  call<EstimateResponse>("/api/estimate", json("POST", { config }));

export const createRun = (
  source_id: string | null,
  name: string,
  config: Record<string, unknown>,
  scenarioJson?: Record<string, unknown>,
) =>
  call<RunDetail>("/api/runs", json("POST", {
    source_id, name, config, scenario_json: scenarioJson ?? {},
  }));

export const listRuns = () => call<{ runs: RunListItem[] }>("/api/runs");

export const getRun = (id: string) => call<RunDetail>(`/api/runs/${id}`);

export const deleteRun = (id: string) => call<{ deleted: string }>(`/api/runs/${id}`, { method: "DELETE" });

export const seedRun = (id: string) => call<{ agents: number; status: string }>(`/api/runs/${id}/seed`, { method: "POST" });

export const startRun = (id: string) => call<RunDetail>(`/api/runs/${id}/start`, { method: "POST" });

export const pauseRun = (id: string) => call<RunDetail>(`/api/runs/${id}/pause`, { method: "POST" });

export const resumeRun = (id: string) => call<RunDetail>(`/api/runs/${id}/resume`, { method: "POST" });

export const stopRun = (id: string) => call<RunDetail>(`/api/runs/${id}/stop`, { method: "POST" });

export const branchRun = (id: string, text: string, audience = "all") =>
  call<RunDetail & { mode: string; parent_run_id: string; label: string }>(
    `/api/runs/${id}/branch`, json("POST", { text, audience, tick: 1 }));

export const injectEvent = (
  id: string,
  text: string,
  opts: { tick?: number | null; audience?: string; chunkId?: string | null } = {},
) =>
  call<{ injected: unknown }>(`/api/runs/${id}/events`, json("POST", {
    text,
    tick: opts.tick ?? null,
    chunk_id: opts.chunkId ?? null,
    audience: opts.audience ?? null,
  }));

export const listPosts = (id: string, opts: {
  agent?: string; kind?: string; q?: string; limit?: number; newest?: boolean;
} = {}) => {
  const p = new URLSearchParams();
  if (opts.agent) p.set("agent", opts.agent);
  if (opts.kind) p.set("kind", opts.kind);
  if (opts.q) p.set("q", opts.q);
  if (opts.newest) p.set("newest", "1");
  p.set("limit", String(opts.limit ?? 500));
  return call<{ posts: Post[]; count: number; total: number }>(`/api/runs/${id}/posts?${p}`);
};

export const listAgents = (id: string) => call<{ agents: Agent[] }>(`/api/runs/${id}/agents`);

export const getAgent = (runId: string, agentId: string) =>
  call<{ agent: Agent & { persona: Record<string, unknown>; goals: string[]; interests: string[]; big5: Record<string, number> };
        memories: { tick: number; kind: string; text: string; importance: number }[];
        posts: Post[]; stance_history: Record<string, { tick: number; value: number }[]>;
        edges: { src: string; dst: string; follows: boolean; weight: number }[] }>(
    `/api/runs/${runId}/agents/${agentId}`);

export const getGraph = (id: string, suffix = "") =>
  call<GraphResponse>(`/api/runs/${id}/graph${suffix}`);

export const getMetrics = (id: string) => call<MetricsResponse>(`/api/runs/${id}/metrics`);

export const getFindings = (id: string) => call<FindingsResponse>(`/api/runs/${id}/findings`);

export const getNarrative = (id: string) =>
  call<import("./types").NarrativeResponse>(`/api/runs/${id}/narrative`);

export const getRealism = (id: string) =>
  call<{
    run_id: string;
    overall: { score: number | null; label: string; assessed_dimensions: number; total_dimensions: number; method: string };
    summary: {
      headline: string;
      strong: { id: string; label: string; score: number | null }[];
      attention: { id: string; label: string; score: number | null }[];
      not_assessed: { id: string; label: string; status: string; requires: string }[];
      actions: {
        dimension: string; label: string; group: string; score: number | null;
        recommendation: string; requires: string;
      }[];
    };
    predictive_accuracy: { status: string; label: string; observations: number; message: string };
    validation: { connected: boolean; datasets: number; observations: number; message: string };
    dimensions: {
      id: string; label: string; group: string; weight: number; status: string;
      score: number | null; explanation: string; evidence: Record<string, unknown>;
      recommendation: string; requires: string;
    }[];
    updated_at: string;
  }>(`/api/runs/${id}/realism`);

export const raiseBudget = (id: string, maxLlmCalls: number) =>
  call<RunDetail>(`/api/runs/${id}/budget`, json("POST", { max_llm_calls: maxLlmCalls }));

export const getRunStats = (id: string) =>
  call<{
    run_id: string; calls: number; by_status: Record<string, number>;
    by_task: Record<string, number>; models: Record<string, number>;
    avg_latency_ms: number | null; repaired: number; rejected: number;
    fallback_posts: number; template_posts: number;
  }>(`/api/runs/${id}/stats`);

export const compareRuns = (a: string, b: string) =>
  call<CompareResponse>(`/api/runs/${a}/compare?other=${encodeURIComponent(b)}`);

export const getSample = () => call<SampleInfo>("/api/examples/sample");

export const loadSample = () => call<SampleInfo>("/api/examples/sample", { method: "POST" });

export type EssaySummary = {
  sections: Record<string, string>;
  meta: { provider: string; model: string; from_cache: boolean; created_at: string;
          report_created_at: string; latency_ms: number | null; attempts: number };
};

export const getReport = (id: string) =>
  call<{ report_md: string | null; available: boolean; analytics?: unknown; created_at?: string;
         essay?: EssaySummary | null }>(`/api/runs/${id}/report`);

export const generateReport = (id: string) =>
  call<{ report_md: string; available: boolean; analytics?: unknown; created_at?: string;
         essay?: EssaySummary | null }>(`/api/runs/${id}/report`, { method: "POST" });

export const generateEssay = (id: string) =>
  call<{ essay: EssaySummary; run_llm_calls_used?: number }>(
    `/api/runs/${id}/report/essay`, { method: "POST" });

export const redactPreview = (text: string) =>
  call<{ redacted: string; rules: string[] }>("/api/settings/redact-preview", json("POST", { text }));

export const getLLMCalls = (id: string) =>
  call<{ calls: { id: number; task: string; provider: string; model: string; status: string;
                   error: string | null; tokens_in: number | null; tokens_out: number | null;
                   latency_ms: number; created_at: string }[] }>(`/api/runs/${id}/llm-calls?limit=500`);

export const getRunErrors = (id: string) =>
  call<{ errors: { tick: number; kind: string; payload: Record<string, unknown>; created_at: string }[] }>(
    `/api/runs/${id}/errors`);

export const listRunEvents = (id: string) =>
  call<{ events: { tick: number; kind: string; payload: Record<string, unknown>; created_at: string }[] }>(
    `/api/runs/${id}/events`);

export interface AgentDetail {
  agent: Agent & {
    persona?: Record<string, unknown>;
    big5?: Record<string, number>;
    traits?: Record<string, number>;
    goals?: unknown[];
    interests?: unknown[];
    state?: Record<string, unknown>;
    belief_summary: string | null;
  };
  memories: { tick: number; kind: string; text: string; importance: number }[];
  posts: (Post & { likes: number; reposts: number; replies: number })[];
  stance_history: Record<string, { tick: number; value: number }[]>;
  edges: { src: string; dst: string; follows: number; weight: number }[];
}

export const getAgentDetail = (runId: string, agentId: string) =>
  call<AgentDetail>(`/api/runs/${runId}/agents/${agentId}`);

export const exportJson = (id: string) => call<{ run: RunDetail; [k: string]: unknown }>(`/api/runs/${id}/export?format=json`);

export function exportUrl(id: string, format: string): string {
  return `/api/runs/${id}/export?format=${format}`;
}
