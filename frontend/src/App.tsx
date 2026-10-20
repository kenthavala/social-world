import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import { ErrorBanner } from "./common";
import HomePage from "./HomePage";
import Wizard from "./Wizard";
import RunPage from "./RunPage";
import SettingsPage from "./SettingsPage";
import SimulationsPage from "./SimulationsPage";
import DocumentsPage from "./DocumentsPage";
import { Shell, useHashRoute } from "./shell";
import { navigate } from "./router";

export default function App() {
  const route = useHashRoute();
  const [serverUp, setServerUp] = useState(true);
  const [provider, setProvider] = useState<string>("");
  const [err, setErr] = useState<unknown>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);

  useEffect(() => {
    api
      .getHealth()
      .then((h) => {
        setServerUp(true);
        setProvider(h.provider);
      })
      .catch(() => setServerUp(false));
  }, [settingsVersion, route.name]);

  const openRun = useCallback((runId: string) => navigate({ name: "run", runId }), []);
  const goHome = useCallback(() => navigate({ name: "home" }), []);

  return (
    <Shell route={route}>
      {provider === "mock" && route.name !== "wizard" && (
        <div
          className="mx-6 mt-4 rounded-md px-3 py-2 text-xs"
          style={{ background: "var(--warn-soft)", border: "1px solid var(--warn-line)", color: "var(--warn-fg)" }}
        >
          Running on the <strong>mock provider</strong> — agents post synthetic template text. Pick a real
          provider and paste an API key in Settings to get LLM-written posts.
        </div>
      )}

      {!serverUp && (
        <div
          className="mx-6 mt-4 rounded-md px-3 py-2 text-xs"
          style={{ background: "var(--err-soft)", border: "1px solid var(--err-line)", color: "var(--err-fg)" }}
        >
          Backend unreachable — is the server running on http://127.0.0.1:8000?
        </div>
      )}

      <div className={`px-6 pb-16 ${route.name === "run" ? "" : "mx-auto max-w-6xl"}`}>
        <ErrorBanner err={err} onDismiss={() => setErr(null)} />
        {route.name === "home" && (
          <HomePage
            onNew={() => navigate({ name: "wizard" })}
            onOpen={openRun}
            onError={setErr}
            settingsVersion={settingsVersion}
          />
        )}
        {route.name === "simulations" && (
          <SimulationsPage onOpen={openRun} onNew={() => navigate({ name: "wizard" })} onError={setErr} />
        )}
        {route.name === "documents" && <DocumentsPage onError={setErr} />}
        {route.name === "settings" && (
          <SettingsPage onSaved={() => setSettingsVersion((v) => v + 1)} onError={setErr} />
        )}
        {route.name === "wizard" && (
          <Wizard onDone={openRun} onCancel={goHome} onError={setErr} />
        )}
        {route.name === "run" && (
          <RunPage runId={route.runId} onBack={goHome} onError={setErr} />
        )}
      </div>
    </Shell>
  );
}
