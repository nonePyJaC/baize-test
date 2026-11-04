// 左侧工具窗口展开状态按工作区持久化（会话级，存 localStorage）
import { useCallback, useEffect, useState } from "react";

const EXPANDED_KEY_PREFIX = "blackbox-client.toolwindow.expanded.v1";

interface ExpandedRecord {
  workspacePath: string;
  nodes: string[];
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/$/.test(normalized) || normalized === "/") return normalized;
  return normalized.replace(/\/+$/g, "");
}

function readExpanded(workspacePath: string, viewKey: string): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(`${EXPANDED_KEY_PREFIX}.${viewKey}`);
    if (!raw) return null;
    const record = JSON.parse(raw) as ExpandedRecord;
    if (normalizePath(record.workspacePath || "") !== normalizePath(workspacePath)) return null;
    return new Set(Array.isArray(record.nodes) ? record.nodes.filter((item) => typeof item === "string") : []);
  } catch {
    return null;
  }
}

function writeExpanded(workspacePath: string, viewKey: string, nodes: Set<string>): void {
  try {
    const record: ExpandedRecord = { workspacePath: normalizePath(workspacePath), nodes: [...nodes].slice(0, 500) };
    window.localStorage.setItem(`${EXPANDED_KEY_PREFIX}.${viewKey}`, JSON.stringify(record));
  } catch {
    return;
  }
}

export function usePersistentExpanded(workspacePath: string, viewKey: string, initial: string[] = []) {
  const [expanded, setExpandedState] = useState<Set<string>>(() => readExpanded(workspacePath, viewKey) ?? new Set(initial));

  useEffect(() => {
    setExpandedState(readExpanded(workspacePath, viewKey) ?? new Set(initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, viewKey]);

  const setExpanded = useCallback((value: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setExpandedState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      writeExpanded(workspacePath, viewKey, next);
      return next;
    });
  }, [workspacePath, viewKey]);

  return [expanded, setExpanded] as const;
}
