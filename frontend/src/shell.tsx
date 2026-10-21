// App shell: sidebar (desktop) / bottom nav (mobile) + active run + provider status.
// Global navigation only (Home / Simulations / Documents / Settings) — simulation
// navigation lives inside the run room. Theme: dark default, light override,
// follows the OS until the user picks.
import { useEffect, useState } from "react";
import type { Route } from "./router";
import { hrefFor } from "./router";
import * as api from "./api";
import type { Provider, RunListItem } from "./types";
import { Wordmark } from "./Brand";

export type { Route };

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseNow());
  useEffect(() => {
    const on = () => setRoute(parseNow());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function parseNow() {
  return parseHashLocal(window.location.hash);
}

import { parseHash as parseHashLocal } from "./router";

const THEME_KEY = "oasis-theme";

export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* storage unavailable */ }
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

const PlusIcon = () => (
  <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M8 3v10M3 8h10" />
  </svg>
);
const SimIcon = () => (
  <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M8 2 14 5 8 8 2 5z" />
    <path d="M2 8l6 3 6-3" />
    <path d="M2 11l6 3 6-3" />
  </svg>
);
const DocIcon = () => (
  <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 1.5h5.5L13 5v9.5H4z" />
    <path d="M9.5 1.5V5H13" />
    <path d="M6.5 8.5h4" />
    <path d="M6.5 11h4" />
  </svg>
);
const SettingsIcon = () => (
  <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 4h6.5" /><path d="M12 4h1.5" /><path d="M2.5 8h1.5" /><path d="M7 8h6.5" />
    <path d="M2.5 12h7.5" /><path d="M13 12h.5" />
    <circle cx="10.5" cy="4" r="1.5" /><circle cx="5.5" cy="8" r="1.5" /><circle cx="11.5" cy="12" r="1.5" />
  </svg>
);
const SunIcon = () => (
  <svg className="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
  </svg>
);
const MoonIcon = () => (
  <svg className="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />
  </svg>
);

interface ShellState {
  sims: RunListItem[];
  docs: number | null;
  provider: string | null;
  model: string | null;
  keysOk: boolean;
  providers: Provider[];
}

export function Shell({ route, children }: { route: Route; children: React.ReactNode }) {
  const [state, setState] = useState<ShellState>({ sims: [], docs: null, provider: null, model: null, keysOk: false, providers: [] });
  const { theme, toggle } = useTheme();

  useEffect(() => {
    api.listRuns().then((r) => setState((s) => ({ ...s, sims: r.runs }))).catch(() => undefined);
    api.listSources().then((r) => setState((s) => ({ ...s, docs: r.sources.length }))).catch(() => undefined);
    api.getHealth().then((h) => setState((s) => ({ ...s, provider: h.provider || null }))).catch(() => undefined);
    api.listProviders().then((r) => setState((s) => ({ ...s, providers: r.providers }))).catch(() => undefined);
    api.getSettings().then((r) => {
      const model = String(r.settings.llm_model ?? "");
      const keys = (r.settings.keys ?? {}) as Record<string, boolean>;
      setState((s) => ({ ...s, model: model || null, keysOk: Object.values(keys).some(Boolean) }));
    }).catch(() => undefined);
  }, [route.name]);

  const isMobileLayout = useIsMobile();
  const activeRun = state.sims.find((r) => ["running", "seeding", "paused"].includes(r.status)) ?? null;

  // Keep the sidebar's active-run tick/status fresh while a run is live.
  useEffect(() => {
    if (!activeRun) return;
    const t = window.setInterval(() => {
      api.listRuns().then((r) => setState((s) => ({ ...s, sims: r.runs }))).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(t);
  }, [activeRun?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const navItems = [
    { name: "simulations", label: "Simulations", icon: <SimIcon />, href: "#/simulations", count: state.sims.length || null },
    { name: "documents", label: "Sources", icon: <DocIcon />, href: "#/documents", count: state.docs },
    { name: "settings", label: "Settings", icon: <SettingsIcon />, href: "#/settings", count: null },
  ];
  const isRun = route.name === "run";

  const currentProvider = state.providers.find((p) => p.name === state.provider) ?? null;
  const keyOk = state.provider === "mock" ? true : currentProvider ? currentProvider.has_key : null;
  const providerLabel = state.provider === "mock" ? "mock provider"
    : state.provider
      ? `${state.provider} · ${keyOk === false ? "no key" : "configured"}`
      : "checking…";
  const providerDot = state.provider === "mock"
    ? "dot dot-warn"
    : state.provider
      ? keyOk === false ? "dot dot-warn" : "dot dot-ok"
      : "dot dot-idle";

  if (isMobileLayout) {
    return (
      <div className="mo min-h-screen flex flex-col">
        <header
          className="sticky top-0 z-30 flex items-center justify-between px-4"
          style={{ height: 52, background: "var(--bg-0)", borderBottom: "1px solid var(--line-1)" }}
        >
          <Wordmark compact />
          <button className="btn btn-ghost btn-sm btn-icon" onClick={toggle} aria-label="Toggle colour theme">
            {theme === "light" ? <MoonIcon /> : <SunIcon />}
          </button>
        </header>
        <div className="flex-1 min-w-0">{children}</div>
        {!isRun && (
          <>
            <nav
              className="sticky bottom-0 z-30 border-t grid"
              style={{ gridTemplateColumns: "repeat(3, 1fr)", borderColor: "var(--line-1)", background: "var(--bg-0)" }}
              aria-label="Primary"
            >
              {navItems.map((item) => {
                const current = route.name === item.name;
                return (
                  <a
                    key={item.name}
                    href={item.href}
                    className="flex flex-col items-center justify-center gap-1"
                    style={{ height: 60, fontSize: 10.5, fontWeight: 500, color: current ? "var(--fg-1)" : "var(--fg-3)" }}
                    aria-current={current ? "page" : undefined}
                  >
                    <span style={{ width: 20, height: 20, display: "grid", placeItems: "center" }}>{item.icon}</span>
                    {item.label}
                  </a>
                );
              })}
            </nav>
            <a
              href="#/new"
              aria-label="New simulation"
              className="btn btn-primary"
              style={{ position: "fixed", left: "50%", bottom: 78, transform: "translateX(-50%)",
                       width: 52, height: 52, borderRadius: "50%", zIndex: 32,
                       boxShadow: "var(--shadow-pop)" }}
            >
              <PlusIcon />
            </a>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mo min-h-screen flex">
      <aside className="side sticky top-0 h-screen" style={{ flex: "0 0 224px" }}>
        <Wordmark />
        <a className="btn btn-primary btn-block side-new" href="#/new" title="New simulation" style={{ marginBottom: 14 }}>
          <PlusIcon /> <span className="btn-label">New simulation</span>
        </a>
        <nav aria-label="Primary">
          {navItems.map((item) => {
            const current = route.name === item.name;
            return (
              <a key={item.name} href={item.href} className={`nav ${current ? "is-current" : ""}`}
                 title={item.label} aria-current={current ? "page" : undefined}>
                {item.icon}
                <span className="nav-label">{item.label}</span>
                {item.count != null && <span className="nav-count">{item.count}</span>}
              </a>
            );
          })}
        </nav>

        {activeRun && (
          <>
            <div className="eyebrow side-label">Active run</div>
            <a className="nav-sub" href={hrefFor({ name: "run", runId: activeRun.id })} style={{ paddingLeft: 10, alignItems: "flex-start", gap: 12 }}>
              <span className="dot dot-run dot-pulse" style={{ marginTop: 6 }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <span className="ellipsis" style={{ fontWeight: 500 }}>{activeRun.name}</span>
                <span className="t-id">
                  T{String(activeRun.ticks_done).padStart(2, "0")}/{activeRun.ticks_total || "—"} · {activeRun.status}
                </span>
              </span>
            </a>
          </>
        )}

        <div className="side-foot">
          <a className="nav" href="#/settings" style={{ height: "auto", padding: "8px 10px", alignItems: "flex-start", gap: 12 }}>
            <span className={providerDot} style={{ marginTop: 6 }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <span>{providerLabel}</span>
              {state.provider !== "mock" && state.model && (
                <span className="t-id ellipsis" style={{ maxWidth: 170 }}>
                  {state.model}{keyOk === false ? " · no key" : ""}
                </span>
              )}
            </span>
          </a>
          <button className="btn btn-ghost btn-sm" onClick={toggle} style={{ justifyContent: "flex-start", paddingLeft: 10 }} aria-label="Toggle colour theme">
            {theme === "light" ? <MoonIcon /> : <SunIcon />}
            <span className="btn-label">{theme === "light" ? "Dark mode" : "Light mode"}</span>
          </button>
        </div>
      </aside>

      <div className="main flex-1 min-w-0" style={{ height: "auto", overflow: "visible" }}>
        {children}
      </div>
    </div>
  );
}

export function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export { hrefFor };
