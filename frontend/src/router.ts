// Tiny hash router: survives refresh, no dependencies.
// Routes: #/ (home)  #/simulations  #/documents  #/settings  #/new  #/run/<id>  #/compare?a=&b=

export type Route =
  | { name: "home" }
  | { name: "simulations" }
  | { name: "documents"; sourceId?: string }
  | { name: "settings" }
  | { name: "wizard"; sourceId?: string }
  | { name: "run"; runId: string; sourceId?: string; postId?: string }
  | { name: "compare"; a: string; b: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  if (path.startsWith("/run/")) {
    const runId = path.slice(5).split("/")[0];
    if (runId) {
      return {
        name: "run",
        runId,
        sourceId: params.get("source") || undefined,
        postId: params.get("post") || undefined,
      };
    }
  }
  if (path === "/compare") {
    const a = params.get("a") || "";
    const b = params.get("b") || "";
    if (a && b) return { name: "compare", a, b };
    return { name: "simulations" };
  }
  if (path === "/new") {
    return { name: "wizard", sourceId: params.get("source") || undefined };
  }
  if (path === "/documents" || path === "/sources") {
    return { name: "documents", sourceId: params.get("source") || undefined };
  }
  if (path === "/settings") return { name: "settings" };
  // The bare root is the product home; "/simulations" is the list view.
  if (path === "/") return { name: "home" };
  return { name: "simulations" };
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
    case "run": {
      const qs = new URLSearchParams();
      if (route.sourceId) qs.set("source", route.sourceId);
      if (route.postId) qs.set("post", route.postId);
      const q = qs.toString();
      return `#/run/${route.runId}${q ? `?${q}` : ""}`;
    }
    case "compare":
      return `#/compare?a=${encodeURIComponent(route.a)}&b=${encodeURIComponent(route.b)}`;
  }
}

export function navigate(route: Route): void {
  const href = hrefFor(route);
  if (window.location.hash === href) return;
  window.location.hash = href;
}
