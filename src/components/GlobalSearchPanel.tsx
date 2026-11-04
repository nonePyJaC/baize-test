// BB-16F：全局搜索面板
// Ctrl+K / ⌘K 打开，300ms 防抖调用 search_workspace，支持键盘导航与分组展示。
import React, { useEffect, useMemo, useRef, useState } from "react";
import AppIcon, { type IconName } from "./AppIcon";
import { api } from "../lib/api";
import type { WorkspaceConfig, WorkspaceSearchResult } from "../lib/types";
import type { WorkbenchTab } from "../lib/workbench";

const HISTORY_KEY = "blackbox-client.search-history.v1";
const GROUP_ITEM_LIMIT = 12;

interface GlobalSearchPanelProps {
  workspace: WorkspaceConfig;
  /** 当前Tab上下文，用于提升本平台/需求结果的排序 */
  contextPlatformId?: string;
  contextRequirementId?: string;
  /** 空查询时展示的最近打开对象 */
  recentTabs: WorkbenchTab[];
  onOpenResult: (result: WorkspaceSearchResult) => void;
  onOpenTab: (tab: WorkbenchTab) => void;
  onClose: () => void;
}

interface SearchGroup {
  id: string;
  label: string;
  items: WorkspaceSearchResult[];
}

const GROUP_DEFS: { id: string; label: string; types: string[] }[] = [
  { id: "requirement", label: "需求", types: ["requirement"] },
  { id: "file", label: "文档与文件", types: ["file"] },
  { id: "case", label: "测试用例", types: ["case"] },
  { id: "ai_task", label: "AI任务", types: ["ai_task"] },
  { id: "execution", label: "测试轮次和报告", types: ["run", "report"] },
  { id: "knowledge", label: "知识", types: ["knowledge"] },
];

const RESULT_ICONS: Record<string, IconName> = {
  requirement: "box",
  case: "checks",
  ai_task: "ai",
  run: "test",
  report: "markdown",
  knowledge: "database",
};

function resultIcon(result: WorkspaceSearchResult): IconName {
  if (result.result_type === "file") {
    if (result.is_directory) return "folder";
    const lower = result.path.toLowerCase();
    if (/\.(md|markdown|txt|log)$/.test(lower)) return "markdown";
    if (/\.(json|yaml|yml|jsonl)$/.test(lower)) return "jsonFile";
    if (/\.(xlsx|xls|csv)$/.test(lower)) return "spreadsheet";
    if (lower.endsWith(".xmind")) return "archiveFile";
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)) return "image";
    if (/\.(docx|doc)$/.test(lower)) return "file";
    return "file";
  }
  return RESULT_ICONS[result.result_type] || "file";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function readHistory(rootPath: string): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const record = JSON.parse(raw) as { workspacePath?: string; queries?: unknown };
    if (normalizePath(record.workspacePath || "") !== normalizePath(rootPath)) return [];
    return (Array.isArray(record.queries) ? record.queries : [])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 10);
  } catch {
    return [];
  }
}

function writeHistory(rootPath: string, queries: string[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ workspacePath: normalizePath(rootPath), queries: queries.slice(0, 10) }));
  } catch {
    return;
  }
}

export default function GlobalSearchPanel({ workspace, contextPlatformId, contextRequirementId, recentTabs, onOpenResult, onOpenTab, onClose }: GlobalSearchPanelProps) {
  const rootPath = workspace.workspace.root_path;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [history, setHistory] = useState<string[]>(() => readHistory(rootPath));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 300ms 防抖；查询序号丢弃过期结果，保证慢查询不覆盖新输入
  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      sequence.current += 1;
      setResults([]);
      setSearching(false);
      setError(null);
      setActiveIndex(0);
      return;
    }
    setSearching(true);
    const seq = ++sequence.current;
    const timer = window.setTimeout(() => {
      api.searchWorkspace(rootPath, keyword, { platformId: contextPlatformId, requirementId: contextRequirementId }, 200)
        .then((items) => {
          if (sequence.current !== seq) return;
          setResults(items);
          setSearching(false);
          setError(null);
          setActiveIndex(0);
        })
        .catch((reason) => {
          if (sequence.current !== seq) return;
          setResults([]);
          setSearching(false);
          setError(`搜索失败：${String(reason)}`);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, rootPath, contextPlatformId, contextRequirementId]);

  const groups = useMemo<SearchGroup[]>(() => {
    return GROUP_DEFS
      .map((def) => ({ id: def.id, label: def.label, items: results.filter((item) => def.types.includes(item.result_type)).slice(0, GROUP_ITEM_LIMIT) }))
      .filter((group) => group.items.length > 0);
  }, [results]);

  const flatItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const indexOfItem = useMemo(() => new Map(flatItems.map((item, index) => [item, index] as const)), [flatItems]);

  // 键盘选中项保持可见
  useEffect(() => {
    listRef.current?.querySelector(".search-result-row.active")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const remember = (keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) return;
    const next = [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, 10);
    setHistory(next);
    writeHistory(rootPath, next);
  };

  const activate = (result: WorkspaceSearchResult) => {
    remember(query);
    onOpenResult(result);
    onClose();
  };

  const openRecentTab = (tab: WorkbenchTab) => {
    onOpenTab(tab);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, flatItems.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = flatItems[activeIndex];
      if (target) activate(target);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const emptyQuery = !query.trim();

  return (
    <div className="search-palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="search-palette" role="dialog" aria-label="全局搜索" onKeyDown={(event) => event.key === "Escape" && onClose()}>
        <div className="search-palette-input">
          <AppIcon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索需求、文件、用例、任务、轮次、报告和知识"
            spellCheck={false}
          />
          {searching && <span className="spinner" />}
          <button className="icon-button" type="button" onClick={onClose} title="关闭"><AppIcon name="close" size={15} /></button>
        </div>
        <div className="search-palette-list" ref={listRef}>
          {error && <div className="search-palette-error"><AppIcon name="alert" size={14} />{error}</div>}
          {emptyQuery && (
            <div className="search-palette-empty">
              {history.length > 0 && (
                <section>
                  <div className="search-group-title">最近搜索</div>
                  <div className="search-history-chips">
                    {history.map((item) => (
                      <button key={item} type="button" className="search-history-chip" onClick={() => setQuery(item)}>
                        <AppIcon name="history" size={12} />{item}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <section>
                <div className="search-group-title">最近打开</div>
                {recentTabs.length === 0 && <div className="search-palette-hint">暂无最近打开的对象</div>}
                {recentTabs.map((tab) => (
                  <button key={tab.id} type="button" className="search-result-row" onClick={() => openRecentTab(tab)}>
                    <AppIcon name={(tab.icon as IconName) || "file"} size={15} />
                    <span className="search-result-main">
                      <strong>{tab.title}</strong>
                      {tab.subtitle && <small>{tab.subtitle}</small>}
                    </span>
                    <span className="search-result-kind">Tab</span>
                  </button>
                ))}
              </section>
              <div className="search-palette-hint">输入关键词搜索整个工作区</div>
            </div>
          )}
          {!emptyQuery && !searching && !error && results.length === 0 && (
            <div className="search-palette-hint">没有匹配“{query.trim()}”的结果</div>
          )}
          {groups.map((group) => (
            <section key={group.id}>
              <div className="search-group-title">{group.label}<span>{group.items.length}</span></div>
              {group.items.map((item) => {
                const index = indexOfItem.get(item) ?? -1;
                return (
                  <button
                    key={`${item.result_type}:${item.path}:${item.object_id || ""}`}
                    type="button"
                    className={`search-result-row ${index === activeIndex ? "active" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activate(item)}
                  >
                    <AppIcon name={resultIcon(item)} size={15} />
                    <span className="search-result-main">
                      <strong>{item.title}</strong>
                      <small>{item.subtitle}</small>
                      {item.matched_text && <small className="search-result-match">{item.matched_text}</small>}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        <div className="search-palette-footer">
          <span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
