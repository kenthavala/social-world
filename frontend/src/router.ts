// Tiny hash router: survives refresh, no dependencies.
// Routes: #/  #/simulations  #/documents  #/settings  #/new  #/run/<id>

export type Route =
  | { name: "home" }
  | { name: "simulations" }
  | { name: "documents" }
  | { name: "settings" }
  | { name: "wizard" }
  | { name: "run"; runId: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path.startsWith("/run/")) {
    const runId = path.slice(5).split("/")[0];
    if (runId) return { name: "run", runId };
  }
  if (path === "/new") return { name: "wizard" };
  if (path === "/simulations") return { name: "simulations" };
  if (path === "/documents") return { name: "documents" };
  if (path === "/settings") return { name: "settings" };
  return { name: "home" };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "home": return "#/";
    case "simulations": return "#/simulations";
    case "documents": return "#/documents";
    case "settings": return "#/settings";
    case "wizard": return "#/new";
    case "run": return `#/run/${route.runId}`;
  }
}

export function navigate(route: Route): void {
  const href = hrefFor(route);
  if (window.location.hash === href) return;
  window.location.hash = href;
}
