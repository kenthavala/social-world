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
  parent_run_id?: string | null;
  branch_round?: number | null;
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
  manifest?: Record<string, unknown> | null;
  parent_run_id?: string | null;
  branch_round?: number | null;
  llm_reserved?: number;
  children?: { id: string; name: string; status: string; created_at: string }[];
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
  brief?: WorldBrief | null;
  truncated?: boolean;
  deduplicated?: boolean;
  used_by?: number;
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
  generated_by?: { provider?: string; model?: string; from_cache?: boolean } | null;
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
  requires_key?: boolean;
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
  seq?: number | null;
  model?: string | null;
  provider?: string | null;
  via_fallback?: number;
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
  group?: string | null;
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
  settings: Record<string, unknown> & {
    keys: Record<string, boolean>;
    key_set_at?: Record<string, string>;
  };
  keys: Record<string, boolean>;
}

export interface FindingRow {
  tick?: number;
  round?: number;
  pro?: number;
  neu?: number;
  con?: number;
  total?: number;
  post_ids?: string[];
  agent_ids?: string[];
  chunk_id?: string;
  page_start?: number | null;
  page_end?: number | null;
  heading?: string | null;
  citations?: number;
  agent_id?: string;
  handle?: string;
  name?: string;
  group?: string;
  posts?: number;
  page?: number;
  chunks?: string[];
  issue_id?: string;
  first?: number;
  last?: number;
  delta?: number;
  [k: string]: unknown;
}

export interface Finding {
  id: string;
  title: string;
  denominator: number;
  unit: string;
  summary?: string;
  rows: FindingRow[];
}

export interface FindingsResponse {
  run_id: string;
  posts_total: number;
  posts_with_source: number;
  agents_total: number;
  calls_total: number;
  findings: Finding[];
}

export interface CompareSide {
  run: RunDetail;
  rounds: { tick: number; pro: number; neu: number; con: number; total: number }[];
  citations: {
    chunk_id: string; citations: number; heading: string | null;
    page_start: number | null; page_end: number | null;
  }[];
  posts: number;
  fallback_posts: number;
  llm_calls: number;
}

export interface CompareResponse {
  left: CompareSide;
  right: CompareSide;
  diffs: { posts: number; fallback_posts: number; citation_total: number; rounds: number };
  label: string;
  linked?: boolean;
}

export interface SampleInfo {
  available: boolean;
  imported: boolean;
  run_id: string | null;
  label: string | null;
  description?: string | null;
  source_file?: string | null;
  mock?: boolean | null;
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
