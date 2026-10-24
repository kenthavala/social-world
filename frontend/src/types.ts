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
  // The list endpoint (GET /api/sources) returns `id`; the detail endpoint
  // (GET /api/sources/{id}) returns `source_id`. Read either via
  // `d.id ?? d.source_id`.
  id?: string;
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

// Evidence profile for one document (GET /api/sources/{id}/evidence).
export interface SourceEvidenceChunk {
  id: string;
  idx: number;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  n_words: number | null;
  citations: number;
  excerpt: string;
  post_ids: string[];
}

export interface SourceEvidence {
  source: {
    id: string; filename: string; kind: string; status: string;
    pages: number; created_at: string; error: string | null; sha256: string;
  };
  stats: { chunks: number; words: number; pages: number };
  coverage: {
    chunks_total: number; chunks_cited: number; citation_total: number;
    posts_citing: number; runs: number; pct_chunks_cited: number | null;
  };
  brief: { summary: string; generated_by: { provider?: string; model?: string } | null };
  issues: {
    id: string | null; name: string; question: string; category?: string | null;
    evidence_chunk_ids: string[]; evidence_chunks_found: number;
    evidence_chunks_declared: number;
  }[];
  stakeholder_groups: {
    name: string; description: string; size_hint: string;
    influence?: number | null; agents: number; concerns: string[];
  }[];
  usage: {
    run_id: string; name: string; status: string; created_at: string;
    rounds: number; posts_citing: number; agents_citing: number;
  }[];
  findings: {
    run_id: string; run_name: string; finding_id: string; title: string;
    denominator: number; unit: string; rows: number;
  }[];
  chunks: SourceEvidenceChunk[];
  notes: string[];
}

export interface BriefIssue {
  id: string;
  name: string;
  question: string;
  pro_label: string;
  con_label: string;
  evidence_chunk_ids: string[];
  // Extended fields for issue definition
  category?: string;
  detailed_context?: string;
  geographic_scope?: string;
  time_horizon?: string;
  current_situation?: string;
  proposed_change?: string;
  alternative_options?: string;
  key_tradeoffs?: string;
  evidence_sources?: string;
  known_uncertainties?: string;
  metrics?: string;
  decision_question?: string;
}

export interface WorldBrief {
  summary: string;
  issues: BriefIssue[];
  stakeholder_groups: {
    name: string;
    description: string;
    size_hint: string;
    stance_by_issue: Record<string, number>;
    // Extended fields for stakeholder groups
    population_weight?: number;
    demographic_characteristics?: string;
    geographic_distribution?: string;
    economic_characteristics?: string;
    interests?: string[];
    priorities?: string[];
    concerns?: string[];
    incentives?: string;
    constraints?: string;
    typical_information_sources?: string[];
    initial_stance?: number;
    stance_distribution?: string;
    influence?: number;
    sensitivity?: number;
    trust_level?: number;
    institutional_power?: number;
    behavioural_tendencies?: string;
  }[];
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
  influence?: number | null;
  institutional_power?: number | null;
  trust_level?: number | null;
  group_description?: string;
  concerns?: string[];
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

// ---- computed narrative (no model call) -----------------------------------
export interface NarrativeEvidence {
  chunk_id: string;
  citations: number;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  excerpt: string;
}

export interface NarrativeFinding {
  id: string;
  headline: string;
  explanation: string;
  why_it_matters: string;
  strength: "strong" | "moderate" | "indicative";
  strength_reason: string;
  issue_ids: string[];
  groups: string[];
  agents: string[];
  data: { label: string; value: string }[];
  evidence: NarrativeEvidence[];
  post_ids: string[];
}

export interface NarrativeIssue {
  issue_id: string;
  name: string;
  question: string;
  category?: string | null;
  initial_mean: number | null;
  final_mean: number | null;
  delta: number | null;
  spread: number | null;
  pro_agents: number;
  neutral_agents: number;
  con_agents: number;
  observed_agents: number;
  supporters: string[];
  opponents: string[];
  undecided: string[];
  groups: {
    name: string; agents: number; final_mean: number | null;
    delta: number | null; position: string; influence?: number | null;
  }[];
  movement: { group: string; delta: number; direction: string }[];
  triggers: Record<string, number>;
  evidence: NarrativeEvidence[];
  top_agents: {
    agent_id: string; handle: string | null; name: string | null;
    group: string; posts: number; mean_stance: number;
  }[];
  strength: string;
  strength_reason: string;
}

export interface NarrativeStakeholder {
  name: string;
  description: string;
  agents: number;
  influence?: number | null;
  institutional_power?: number | null;
  trust_level?: number | null;
  initial_mean: number | null;
  final_mean: number | null;
  delta: number | null;
  per_issue: {
    issue_id: string; initial: number | null; final: number | null;
    delta: number | null; agents: number;
  }[];
  priority_issues: string[];
  concerns: string[];
  interests: string[];
  representatives: {
    agent_id: string; handle: string | null; name: string | null; posts: number;
  }[];
  network_role: string;
  strength: string;
  strength_reason: string;
}

export interface NarrativeResponse {
  run_id: string;
  generated_at: string;
  provenance: { kind: string; method: string; predictive_accuracy: string };
  scale: {
    agents: number; posts: number; rounds_completed: number;
    rounds_configured: number | null; issues: number; groups: number;
    stance_observations: number; overall_initial: number | null;
    overall_final: number | null; overall_delta: number | null;
    posts_with_source: number; distinct_chunks_cited: number;
  };
  answers: {
    what_happened: string; why: string; who_drove_it: string; what_evidence: string;
    agreement: string; disagreement: string; what_changed: string; watch: string;
  };
  key_findings: NarrativeFinding[];
  issues: NarrativeIssue[];
  stakeholders: NarrativeStakeholder[];
  timeline: { tick: number; kind: string; label: string; detail: string }[];
  uncertainty: string[];
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

export interface MixCounts { pro: number; neu: number; con: number; total: number }

export interface RoundMixDiff {
  tick: number;
  left: MixCounts;
  right: MixCounts;
  delta_pro: number;
  delta_neu: number;
  delta_con: number;
}

export interface IssueStanceDiff {
  issue_id: string;
  name: string;
  pro_label: string | null;
  con_label: string | null;
  left_start: number;
  left_end: number;
  left_movement: number;
  right_start: number;
  right_end: number;
  right_movement: number;
  difference_in_movement: number;
  left_last_tick: number;
  right_last_tick: number;
  agents_left: number;
  agents_right: number;
}

export interface CompareResponse {
  left: CompareSide;
  right: CompareSide;
  diffs: {
    posts: number;
    fallback_posts: number;
    citation_total: number;
    rounds: number;
    rounds_mix?: RoundMixDiff[];
    issues?: IssueStanceDiff[];
    notes?: string[];
  };
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
