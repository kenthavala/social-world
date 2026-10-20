// App shell: sidebar (desktop) / bottom nav (mobile) + provider status chip.
import { useEffect, useState } from "react";
import { FlaskConical, Folder, Home, Settings } from "lucide-react";
import type { Route } from "./router";
import { hrefFor } from "./router";
import * as api from "./api";

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
  // avoid circular import with router.ts parseHash? parseHash is also exported there.
  return parseHashLocal(window.location.hash);
}

import { parseHash as parseHashLocal } from "./router";

const NAV = [
  { name: "home", label: "Home", icon: Home, href: "#/" },
  { name: "simulations", label: "Simulations", icon: FlaskConical, href: "#/simulations" },
  { name: "documents", label: "Documents", icon: Folder, href: "#/documents" },
  { name: "settings", label: "Settings", icon: Settings, href: "#/settings" },
] as const;

function NavItems({ route, counts, onNavigate }: {
  route: Route;
  counts: { sims: number | null; docs: number | null };
  onNavigate?: () => void;
}) {
  return NAV.map((item) => (
    <a
      key={item.name}
      href={item.href}
      onClick={onNavigate}
      className={`nav-item ${route.name === item.name ? "active" : ""}`}
    >
      <item.icon size={15} strokeWidth={1.8} />
      <span className={item.name === "home" ? "" : ""}>{item.label}</span>
      {item.name === "simulations" && counts.sims !== null && (
        <span className="chip ml-auto">{counts.sims}</span>
      )}
      {item.name === "documents" && counts.docs !== null && (
        <span className="chip ml-auto">{counts.docs}</span>
      )}
    </a>
  ));
}

export function Shell({ route, children }: { route: Route; children: React.ReactNode }) {
  const [provider, setProvider] = useState<string>("");
  const [counts, setCounts] = useState<{ sims: number | null; docs: number | null }>(
    { sims: null, docs: null });

  useEffect(() => {
    api.getHealth().then((h) => setProvider(h.provider || "")).catch(() => setProvider(""));
    api.listRuns().then((r) => setCounts((c) => ({ ...c, sims: r.runs.length })))
      .catch(() => undefined);
    api.listSources().then((r) => setCounts((c) => ({ ...c, docs: r.sources.length })))
      .catch(() => undefined);
  }, [route.name]);

  const isMobileLayout = useIsMobile();
  const isRun = route.name === "run" || route.name === "wizard";

  if (isMobileLayout) {
    return (
      <div className="mo min-h-screen flex flex-col">
        <div className="flex-1">{children}</div>
        <nav
          className="sticky bottom-0 border-t flex"
          style={{ borderColor: "var(--line-2)", background: "var(--bg-1)" }}
        >
          {NAV.map((item) => (
            <a
              key={item.name}
              href={item.href}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-xs
                ${route.name === item.name ? "text-mo-fg-1" : "text-mo-fg-3"}`}
              style={route.name === item.name ? { color: "var(--fg-1)" } : { color: "var(--fg-3)" }}
            >
              <item.icon size={18} strokeWidth={1.8} />
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="mo min-h-screen flex">
      <aside
        className="w-56 flex-none border-r flex flex-col px-3 py-4 sticky top-0 h-screen"
        style={{ borderColor: "var(--line-1)", background: "var(--bg-1)" }}
      >
        <a href="#/" className="flex items-center gap-2.5 px-2 pb-4" style={{ borderBottom: "1px solid var(--line-1)" }}>
          <span
            className="grid grid-cols-2 gap-[2px] p-1.5"
            style={{ background: "var(--ac-soft)", border: "1px solid var(--ac-line)", borderRadius: "var(--r-2)" }}
            aria-hidden
          >
            <span className="w-1.5 h-1.5 rounded-[1px]" style={{ background: "var(--ac)" }} />
            <span className="w-1.5 h-1.5 rounded-[1px]" style={{ background: "var(--ac)", opacity: 0.45 }} />
            <span className="w-1.5 h-1.5 rounded-[1px]" style={{ background: "var(--ac)", opacity: 0.45 }} />
            <span className="w-1.5 h-1.5 rounded-[1px]" style={{ background: "var(--ac)" }} />
          </span>
          <span>
            <span className="block font-semibold" style={{ fontSize: 13 }}>OASIS-Lite</span>
            <span className="eyebrow" style={{ fontSize: 10 }}>Local-first simulation studio</span>
          </span>
        </a>

        <nav className="mt-4 flex flex-col gap-0.5">
          <NavItems route={route} counts={counts} />
        </nav>

        <div className="mt-auto">
          {provider && (
            <div className="panel-2 px-2.5 py-2">
              <div className="eyebrow">Provider</div>
              <div className="mono flex items-center gap-1.5" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                <span className="dot" style={{ background: "var(--ok)" }} />
                {provider}
              </div>
            </div>
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}

function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export { hrefFor };
