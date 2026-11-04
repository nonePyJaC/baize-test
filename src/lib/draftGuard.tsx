import { createContext, useContext, useEffect, useRef } from "react";
export const DraftScope = createContext("");
const savers = new Map<string, Map<symbol, { save: () => Promise<boolean>; priority: number }>>();
export function useDraftSave(save: () => Promise<boolean>, priority = 0) {
  const id = useContext(DraftScope);
  const latest = useRef(save); latest.current = save;
  useEffect(() => {
    if (!id) return;
    const token = Symbol(id);
    const stack = savers.get(id) || new Map();
    stack.set(token, { save: () => latest.current(), priority }); savers.set(id, stack);
    return () => { stack.delete(token); if (!stack.size) savers.delete(id); };
  }, [id, priority]);
}
export async function saveDirtyTabs(ids: string[]): Promise<boolean> {
  for (const id of ids) {
    const entries = [...(savers.get(id)?.values() || [])].sort((a, b) => a.priority - b.priority);
    const entry = entries[entries.length - 1];
    if (!entry || !await entry.save()) return false;
  }
  return true;
}
