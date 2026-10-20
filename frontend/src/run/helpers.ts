// Shared run-room helpers: tab definitions, stance helpers, tick ruler.
import type { Post } from "../types";

export const RUN_TABS = [
  { key: "overview", label: "Overview" },
  { key: "feed", label: "Feed" },
  { key: "agents", label: "Agents" },
  { key: "network", label: "Network" },
  { key: "events", label: "Events" },
  { key: "insights", label: "Insights" },
  { key: "log", label: "Log" },
] as const;

export type RunTabKey = (typeof RUN_TABS)[number]["key"];

export function postOverallStance(p: Post): "pro" | "neu" | "con" {
  const vals = Object.values(p.stance || {}).map((s) => s?.value ?? 0);
  if (vals.length === 0) return "neu";
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean > 0.15) return "pro";
  if (mean < -0.15) return "con";
  return "neu";
}

export function stanceColor(v: number): string {
  if (v > 0.15) return "var(--pro-fg)";
  if (v < -0.15) return "var(--con-fg)";
  return "var(--neu-fg)";
}

// Deterministic hue from a string (avatars, chips) — real identity, not decoration.
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name: string | null | undefined, handle: string | null | undefined): string {
  const src = (name || handle || "?").trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}
