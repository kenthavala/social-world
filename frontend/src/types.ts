// Shared frontend types mirroring the backend API shapes.

export interface RunListItem {
  id: string;
  name: string;
  status: string;
  source: string | null;
  source_id: string | null;
  ticks_done: number;
  ticks_total: number;
  created_at: string;
  llm_calls_used: number;
}

export interface RunDetail {
  id: string;
  name: string;
  status: string;
  source_id: string | null;
  scenario: { question?: string; events?: { tick: number; text: string; kind?: string }[] };
  config: RunConfig;
  seed: number;
  current_tick: number;
  last_completed_tick: number;
  llm_calls_used: number;
  max_llm_calls: number | null;
  error: { error_type?: string; message?: string } | null;
  agents: number;
  posts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  provider?: { name?: string; model?: string } | null;
}

export interface RunConfig {
  agents: number;
  ticks: number;
  writes_per_tick: number;
  pop_mix: { pro: number; con: number; undecided: number };
  seed: number;
  write_batch: number;
  reflect_every: number;
  backfire: boolean;
  max_llm_calls: number;
}

export interface SourceStats {
  source_id: string;
  filename: string;
  kind: string;
  pages: number;
  chunks: number;
  words: number;
  status: string;
  error: string | null;
  has_brief: boolean;
  truncated?: boolean;
  deduplicated?: boolean;
}

export interface BriefIssue {
  id: string;
  name: string;
  question: string;
  pro_label: string;
  con_label: string;
  evidence_chunk_ids: string[];
}

export interface WorldBrief {
  summary: string;
  issues: BriefIssue[];
  stakeholder_groups: { name: string; description: string; size_hint: string; stance_by_issue: Record<string, number> }[];
  key_claims: string[];
  entities: unknown[];
  fallback?: boolean;
}

export interface Estimate {
  max_llm_calls: number;
  core_calls: number;
  per_provider: Record<string, number>;
  min_llm_calls: number;
  [k: string]: unknown;
}

export interface EstimateResponse {
  estimate: Estimate;
  config: RunConfig;
  warnings: string[];
}

export interface Provider {
  name: string;
  wire_format: string;
  base_url: string;
  key_env: string;
  has_key: boolean;
  default_rpm: number | null;
  notes: string;
  supports_model_list: boolean;
}

export interface Post {
  id: string;
  tick: number;
  agent_id: string;
  handle: string | null;
  name: string | null;
  kind: string;
  parent_id: string | null;
  text: string;
  stance: Record<string, { value: number; confidence?: number }>;
  emotion: string | null;
  cited_chunk_ids: string[];
  likes: number;
  reposts: number;
  replies: number;
  is_fallback: boolean;
}

export interface Agent {
  id: string;
  handle: string;
  name: string;
  bio: string;
  archetype: string;
  group: string;
  stances: Record<string, { value: number; confidence: number }>;
  traits: Record<string, number>;
  state: Record<string, number>;
  belief_summary: string;
  knowledge: unknown[];
}

export interface GraphNode {
  id: string;
  handle: string | null;
  name: string | null;
  archetype: string | null;
  mean_stance: number;
}

export interface GraphEdge {
  src: string;
  dst: string;
  weight: number;
  follows: boolean;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  [k: string]: unknown;
}

export interface MetricsResponse {
  metrics: { tick: number; engagement?: number; polarity?: number; [k: string]: unknown }[];
  stance_by_issue: Record<string, { tick: number; value: number }[]>;
}

export interface AppErrorShape {
  error: {
    component: string;
    stage: string;
    error_type: string;
    message: string;
    hint: string | null;
    http_status?: number | null;
  };
}

export interface SettingsResponse {
  settings: Record<string, unknown> & { keys: Record<string, boolean> };
  keys: Record<string, boolean>;
}

export interface TestReport {
  provider: string;
  model: string;
  auth_ok: boolean;
  model_ok: boolean;
  json_ok: boolean;
  reasoning_seen: boolean;
  latency_ms: number | null;
  error: string | null;
  hint: string | null;
}
