import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import { ErrorBanner } from "./common";
import Wizard from "./Wizard";
import RunPage from "./RunPage";
import SettingsPage from "./SettingsPage";
import SimulationsPage from "./SimulationsPage";
import DocumentsPage from "./DocumentsPage";
import ComparePage from "./ComparePage";
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
  const goSims = useCallback(() => navigate({ name: "simulations" }), []);

  const isRun = route.name === "run";

  return (
    <Shell route={route}>
      {provider === "mock" && route.name !== "wizard" && !isRun && (
        <div className="banner banner-warn mx-4 mt-4 md:mx-8" style={{ alignItems: "flex-start" }}>
          <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden style={{ color: "var(--warn)", marginTop: 1 }}>
            <path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5V9M8 11.5v.01" />
          </svg>
          <span>
            Running on the <strong>mock provider</strong> — agents post synthetic template text. Pick a real
            provider and paste an API key in <a className="kbd-link" href="#/settings">Settings</a> to get LLM-written posts.
          </span>
        </div>
      )}

      {!serverUp && (
        <div className="banner banner-err mx-4 mt-4 md:mx-8">
          <span>
            Backend unreachable — is the server running? Start it with <code className="mono">start.bat</code> (or
            uvicorn on http://127.0.0.1:8000).
          </span>
        </div>
      )}

      <div className={isRun ? "pb-16" : "mx-auto w-full max-w-[1200px] px-4 pb-16 md:px-8"}>
        <ErrorBanner err={err} onDismiss={() => setErr(null)} />
        {route.name === "simulations" && (
          <SimulationsPage onOpen={openRun} onNew={() => navigate({ name: "wizard" })}
                            onError={setErr} settingsVersion={settingsVersion} />
        )}
        {route.name === "documents" && (
          <DocumentsPage onError={setErr} initialSource={route.sourceId} />
        )}
        {route.name === "settings" && (
          <SettingsPage onSaved={() => setSettingsVersion((v) => v + 1)} onError={setErr} />
        )}
        {route.name === "wizard" && (
          <Wizard onDone={openRun} onCancel={goSims} onError={setErr}
                  initialSource={route.sourceId} />
        )}
        {route.name === "run" && (
          <RunPage runId={route.runId} onBack={goSims} onError={setErr}
                   sourceId={route.sourceId} postId={route.postId} />
        )}
        {route.name === "compare" && (
          <ComparePage a={route.a} b={route.b} onBack={goSims} onOpen={openRun} onError={setErr} />
        )}
      </div>
    </Shell>
  );
}
