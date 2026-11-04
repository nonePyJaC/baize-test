import { useEffect, useRef } from "react";

type Listener = (paths: string[]) => void;
const listeners = new Set<Listener>();
let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
export function invalidateBusinessData(paths: string[]) {
  paths.forEach((path) => pending.add(path.replace(/\\/g, "/")));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const changed = [...pending]; pending = new Set(); timer = undefined;
    listeners.forEach((listener) => listener(changed));
  }, 180);
}

/** Business refresh never unmounts a pane or replaces a dirty draft. */
export function useBusinessRefresh(paths: string[], dirty: boolean, refresh: () => void, stale: () => void) {
  const latest = useRef({ paths, dirty, refresh, stale });
  latest.current = { paths, dirty, refresh, stale };
  useEffect(() => {
    const listener: Listener = (changed) => {
      const state = latest.current;
      if (!changed.some((path) => state.paths.some((target) => {
        const normalized = target.replace(/\\/g, "/").replace(/\/$/, "");
        return path === normalized || path.startsWith(`${normalized}/`) || normalized.startsWith(`${path}/`);
      }))) return;
      if (state.dirty) state.stale(); else state.refresh();
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
}
