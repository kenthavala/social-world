// Tiny hash router: survives refresh, no dependencies.
// Routes: #/  #/simulations  #/documents  #/settings  #/new  #/run/<id>

export type Route =
  | { name: "home" }
  | { name: "simulations" }
  | { name: "documents"; sourceId?: string }
  | { name: "settings" }
  | { name: "wizard"; sourceId?: string }
  | { name: "run"; runId: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  if (path.startsWith("/run/")) {
    const runId = path.slice(5).split("/")[0];
    if (runId) return { name: "run", runId };
  }
  if (path === "/new") {
    const sourceId = new URLSearchParams(query).get("source") || undefined;
    return { name: "wizard", sourceId };
  }
  if (path === "/simulations") return { name: "simulations" };
  if (path === "/documents") {
    const sourceId = new URLSearchParams(query).get("source") || undefined;
    return { name: "documents", sourceId };
  }
  if (path === "/settings") return { name: "settings" };
  return { name: "home" };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "home": return "#/";
    case "simulations": return "#/simulations";
    case "documents":
      return route.sourceId
        ? `#/documents?source=${encodeURIComponent(route.sourceId)}`
        : "#/documents";
    case "settings": return "#/settings";
    case "wizard":
      return route.sourceId
        ? `#/new?source=${encodeURIComponent(route.sourceId)}`
        : "#/new";
    case "run": return `#/run/${route.runId}`;
  }
}

export function navigate(route: Route): void {
  const href = hrefFor(route);
  if (window.location.hash === href) return;
  window.location.hash = href;
}
