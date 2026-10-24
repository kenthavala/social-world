import { useCallback, useEffect, useRef, useState } from "react";
import type { Post, RunDetail } from "./types";
import * as api from "./api";

export type SseEvent = { event: string; data: Record<string, unknown> };

// Live SSE subscription to a run's event stream (10s heartbeats are ignored).
export function useRunStream(runId: string | null, onEvent: (e: SseEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const makeListener = (eventName: string) => (ev: MessageEvent) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        /* ignore */
      }
      handler.current({ event: eventName, data });
    };
    const kinds = [
      "open", "run_status", "stage", "seeding", "tick_started", "tick_completed",
      "post_created", "post", "reaction", "relation", "event", "llm_call",
      "stance_tick", "warning", "waiting", "opinion", "reflection", "error",
    ];
    const listeners = kinds.map((k) => {
      const fn = makeListener(k);
      es.addEventListener(k, fn);
      return [k, fn] as const;
    });
    return () => {
      listeners.forEach(([k, fn]) => es.removeEventListener(k, fn));
      es.close();
      setConnected(false);
    };
  }, [runId]);

  return { connected };
}

// Posts snapshot refresher; live SSE "post" events trigger a re-fetch.
export function usePosts(runId: string | null, trigger: unknown) {
  const [posts, setPosts] = useState<Post[]>([]);
  const reload = useCallback(async () => {
    if (!runId) return;
    try {
      const { posts: p } = await api.listPosts(runId, { limit: 2000, newest: true });
      setPosts(p);
    } catch {
      /* poll errors surface in run status instead */
    }
  }, [runId]);
  useEffect(() => {
    void reload();
  }, [reload, trigger]);
  return { posts, reload };
}

export function useRunDetail(runId: string | null, trigger: unknown) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    if (!runId) { setLoaded(true); return; }
    try {
      setRun(await api.getRun(runId));
      setError(null);
    } catch (e) {
      // A missing or unreachable run must surface, not leave the room on a
      // spinner forever.
      setError(e);
    } finally {
      setLoaded(true);
    }
  }, [runId]);
  useEffect(() => {
    setLoaded(false);
    void reload();
  }, [reload, trigger]);
  return { run, reload, error, loaded };
}
