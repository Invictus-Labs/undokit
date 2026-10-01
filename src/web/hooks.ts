import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export type Loadable<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/**
 * Load a resource; optionally keep polling while `shouldPoll(data)` holds
 * (applies, compensations and reconciliation complete asynchronously).
 */
export function useResource<T>(path: string | null, shouldPoll?: (data: T) => boolean, intervalMs = 1500): [Loadable<T>, () => void] {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const generation = useRef(0);
  const pollRef = useRef(shouldPoll);
  pollRef.current = shouldPoll;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    if (path === null) return;
    const request = ++generation.current;
    if (timer.current) clearTimeout(timer.current);
    api<T>("GET", path).then(
      (data) => {
        if (request !== generation.current) return;
        setState({ status: "ready", data });
        if (pollRef.current?.(data)) timer.current = setTimeout(load, intervalMs);
      },
      (error: Error) => {
        if (request === generation.current) setState({ status: "error", message: error.message });
      },
    );
  }, [path, intervalMs]);
  useEffect(() => {
    setState({ status: "loading" });
    load();
    return () => {
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);
  return [state, load];
}

/** Hash-based location ("#/operations/123"): no router dependency and works behind any static file server. */
export function useHashPath(): string {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [path, setPath] = useState(read);
  useEffect(() => {
    const onChange = () => setPath(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}
