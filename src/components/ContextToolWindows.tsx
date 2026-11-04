import AiSessionLinks from "./AiSessionLinks";
// BB-16A：业务上下文工具窗口
// 用例 / 执行与报告 / 知识库 / AI任务 的左侧树，与主导航和中间Tab联动
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, joinPath } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import { usePersistentExpanded } from "../lib/toolWindowState";
import { candidateRegistryPath, knowledgeRegistryPath } from "../lib/knowledge";
import { getTestRunStats } from "../lib/testExecution";
import AppIcon, { type IconName } from "./AppIcon";
import type {
  AiTaskInfo,
  PlatformInfo,
  RequirementMeta,
  TestAssetInfo,
  WorkspaceConfig,
  WorkspaceEvent,
} from "../lib/types";
import type { WorkbenchTab } from "../lib/workbench";

interface ContextToolWindowProps {
  workspace: WorkspaceConfig;
  onOpenTab: (tab: WorkbenchTab) => void;
  requirementRevision: number;
  latestWorkspaceEvent: WorkspaceEvent | null;
}

interface RequirementContext {
  platform: PlatformInfo;
  requirement: RequirementMeta;
}

function requirementKey(platformId: string, requirementId: string): string {
  return `${platformId}::${requirementId}`;
}

function requirementDir(rootPath: string, platform: PlatformInfo, requirementId: string): string {
  return joinPath(rootPath, platform.path, requirementId);
}

export function isTaskSignalPath(event: WorkspaceEvent, rootPath: string): boolean {
  const root = rootPath.replace(/\\/g, "/").replace(/\/+$/g, "");
  return [event.path, event.old_path || ""].some((path) => {
    const normalized = path.replace(/\\/g, "/");
    return normalized.startsWith(`${root}/.blackbox/tasks/`);
  });
}

function eventTouches(event: WorkspaceEvent | null, rootPath: string, segments: string[]): boolean {
  if (!event) return false;
  const paths = [event.path, event.old_path].filter(Boolean) as string[];
  return paths.some((path) => {
    const normalized = path.replace(/\\/g, "/");
    return normalized.startsWith(`${rootPath.replace(/\\/g, "/").replace(/\/+$/g, "")}/`) && segments.some((segment) => normalized.includes(`/${segment}/`) || normalized.endsWith(`/${segment}`));
  });
}

// 平台 → 需求列表，按需加载并随需求修订号/文件事件刷新
function usePlatformRequirements(workspace: WorkspaceConfig, requirementRevision: number, latestWorkspaceEvent: WorkspaceEvent | null, expandedPlatformIds: Set<string>) {
  const rootPath = workspace.workspace.root_path;
  const [requirements, setRequirements] = useState<Record<string, RequirementMeta[]>>({});
  const requirementsRef = useRef(requirements);

  useEffect(() => { requirementsRef.current = requirements; }, [requirements]);
  useEffect(() => {
    setRequirements({});
    requirementsRef.current = {};
  }, [rootPath]);

  const loadPlatform = useCallback(async (platform: PlatformInfo) => {
    const items = await api.scanRequirements(rootPath, platform.path).catch(() => [] as RequirementMeta[]);
    setRequirements((current) => {
      const next = { ...current, [platform.id]: items };
      requirementsRef.current = next;
      return next;
    });
    return items;
  }, [rootPath]);

  const reloadLoaded = useCallback(() => {
    const loaded = workspace.platforms.filter((platform) => Object.prototype.hasOwnProperty.call(requirementsRef.current, platform.id));
    if (loaded.length) void Promise.all(loaded.map(loadPlatform));
  }, [loadPlatform, workspace.platforms]);

  useEffect(() => { reloadLoaded(); }, [reloadLoaded, requirementRevision]);

  useEffect(() => {
    if (!latestWorkspaceEvent) return;
    const paths = [latestWorkspaceEvent.path, latestWorkspaceEvent.old_path].filter(Boolean) as string[];
    const affected = workspace.platforms.filter((platform) => Object.prototype.hasOwnProperty.call(requirementsRef.current, platform.id)
      && paths.some((path) => {
        const normalized = path.replace(/\\/g, "/");
        const platformRoot = `${rootPath.replace(/\\/g, "/")}/${platform.path}`;
        return normalized === platformRoot || normalized.startsWith(`${platformRoot}/`);
      }));
    if (affected.length) void Promise.all(affected.map(loadPlatform));
  }, [latestWorkspaceEvent, loadPlatform, rootPath, workspace.platforms]);

  useEffect(() => {
    workspace.platforms.forEach((platform) => {
      if (expandedPlatformIds.has(platform.id) && !Object.prototype.hasOwnProperty.call(requirementsRef.current, platform.id)) void loadPlatform(platform);
    });
  }, [expandedPlatformIds, loadPlatform, workspace.platforms]);

  return { requirements, loadPlatform, reloadLoaded };
}

function ToolRow({ depth = 0, expandable = false, expanded = false, icon, label, hint, badge, badgeTone = "", onClick, onToggle, title }: {
  depth?: number;
  expandable?: boolean;
  expanded?: boolean;
  icon: IconName;
  label: React.ReactNode;
  hint?: string;
  badge?: string;
  badgeTone?: "" | "warning" | "success";
  onClick?: () => void;
  onToggle?: () => void;
  title?: string;
}) {
  return (
    <div className="tree-row" role="button" tabIndex={0} style={{ paddingLeft: 7 + depth * 14 }}
      title={title}
      onClick={onClick}
      onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && onClick) { event.preventDefault(); onClick(); } }}>
      <span className={`tree-chevron ${expandable ? "tree-chevron-button" : ""}`}
        onClick={(event) => { if (!onToggle) return; event.stopPropagation(); onToggle(); }}
        role={expandable ? "button" : undefined}
        title={expandable ? (expanded ? "收起" : "展开") : undefined}>
        {expandable ? <AppIcon name={expanded ? "down" : "next"} size={13} /> : null}
      </span>
      <AppIcon name={icon} size={15} />
      <span className="tree-label">{label}{hint ? <small> {hint}</small> : null}</span>
      {badge ? <span className={`tree-badge ${badgeTone}`}>{badge}</span> : null}
    </div>
  );
}

function PanelShell({ icon, title, onRefresh, children }: { icon: IconName; title: string; onRefresh?: () => void; children: React.ReactNode }) {
  return (
    <div className="tool-panel-content">
      <div className="tool-panel-header">
        <div className="tool-panel-title"><AppIcon name={icon} size={15} /> {title}</div>
        {onRefresh && <button className="icon-button" onClick={onRefresh} title="刷新"><AppIcon name="refresh" size={14} /></button>}
      </div>
      <div className="tree-scroll">{children}</div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="tree-hint" style={{ paddingLeft: 30 }}>{text}</div>;
}

// —— Tab 构造 ————————————————————————————————————————

function casesTab(platform: PlatformInfo, req: RequirementMeta, focus?: "versions"): WorkbenchTab {
  return {
    id: `cases:${platform.id}:${req.requirement.id}`,
    type: "structured-cases",
    title: "结构化用例",
    subtitle: `${platform.name} · ${req.requirement.id}`,
    icon: req.client_access.mode === "locked_for_ai" ? "lock" : "checks",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, platformPath: platform.path, requirementId: req.requirement.id, ...(focus ? { focus, focusKey: Date.now() } : {}) },
  };
}

function caseAssetsTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return {
    id: `requirement-folder:${platform.id}:${req.requirement.id}:04-测试用例`,
    type: "requirement-folder",
    title: "用例资产",
    subtitle: `${platform.name} · ${req.requirement.id} · 04-测试用例`,
    icon: "folder",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, platformPath: platform.path, requirementId: req.requirement.id, folder: "04-测试用例" },
  };
}

function caseExportTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return {
    id: `case-export:${platform.id}:${req.requirement.id}`,
    type: "case-export",
    title: "模板与导出",
    subtitle: `${platform.name} · ${req.requirement.id}`,
    icon: "tools",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, platformPath: platform.path, requirementId: req.requirement.id },
  };
}

function executionTab(platform: PlatformInfo, req: RequirementMeta, runId?: string): WorkbenchTab {
  return {
    id: `test-execution:${platform.id}:${req.requirement.id}`,
    type: "test-execution",
    title: "测试执行",
    subtitle: `${platform.name} · ${req.requirement.id}`,
    icon: "test",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: {
      platformId: platform.id,
      platformPath: platform.path,
      requirementId: req.requirement.id,
      ...(runId ? { runId, focusKey: Date.now() } : {}),
    },
  };
}

function reportTab(platform: PlatformInfo, req: RequirementMeta, runId?: string): WorkbenchTab {
  return {
    id: `report-generation:${platform.id}:${req.requirement.id}`,
    type: "report-generation",
    title: "测试报告",
    subtitle: `${platform.name} · ${req.requirement.id}`,
    icon: "file",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: {
      platformId: platform.id,
      platformPath: platform.path,
      requirementId: req.requirement.id,
      ...(runId ? { runId } : {}),
    },
  };
}

function knowledgeTab(scope: "general" | "platform", platform?: PlatformInfo): WorkbenchTab {
  const suffix = scope === "general" ? "通用知识" : `${platform?.name || ""}平台知识`;
  return {
    id: scope === "general" ? "knowledge" : `knowledge:platform:${platform?.id}`,
    type: "knowledge",
    title: "知识库",
    subtitle: suffix,
    icon: "database",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { scope, ...(platform ? { platformId: platform.id } : {}), focusKey: Date.now() },
  };
}

function requirementKnowledgeTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return {
    id: `knowledge:${platform.id}:${req.requirement.id}`,
    type: "knowledge",
    title: "知识库",
    subtitle: `${platform.name} · ${req.requirement.id} · 候选审核`,
    icon: "database",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, platformPath: platform.path, requirementId: req.requirement.id, focusKey: Date.now() },
  };
}

export function aiTaskTab(task?: AiTaskInfo, platformId?: string, requirementId?: string): WorkbenchTab {
  return {
    id: "ai-tasks",
    type: "ai-task",
    title: "AI会话",
    subtitle: task ? `${task.task_id}` : platformId ? `${platformId} · ${requirementId || "全部需求"}` : "标准任务包与派发词",
    icon: "ai",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: {
      ...(task ? { taskId: task.task_id, platformId: task.platform_id, requirementId: task.requirement_id } : {}),
      ...(platformId ? { platformId } : {}),
      ...(requirementId ? { requirementId } : {}),
      focusKey: Date.now(),
    },
  };
}

function reportFileTab(path: string): WorkbenchTab {
  const name = path.split(/[\\/]/).pop() || path;
  const lower = name.toLowerCase();
  const type = lower.endsWith(".docx") ? "docx" : "markdown";
  return {
    id: `file:${path}`,
    type,
    title: name,
    subtitle: path,
    icon: type === "docx" ? "file" : "markdown",
    preview: true,
    pinned: false,
    dirty: false,
    closable: true,
    payload: { path },
  };
}

// —— 用例工具窗口 ————————————————————————————————————

interface RequirementCaseStats {
  loading: boolean;
  caseCount: number | null;
  versionCount: number;
}

export function TestToolWindow({ workspace, onOpenTab, requirementRevision, latestWorkspaceEvent }: ContextToolWindowProps) {
  const rootPath = workspace.workspace.root_path;
  const [expanded, setExpanded] = usePersistentExpanded(rootPath, "tests.platforms");
  const { requirements, reloadLoaded } = usePlatformRequirements(workspace, requirementRevision, latestWorkspaceEvent, expanded);
  const [expandedReqs, setExpandedReqs] = usePersistentExpanded(rootPath, "tests.reqs");
  const [stats, setStats] = useState<Record<string, RequirementCaseStats>>({});
  const [assets, setAssets] = useState<TestAssetInfo[]>([]);

  const loadAssets = useCallback(() => {
    void api.scanTestAssets(rootPath).then(setAssets).catch(() => setAssets([]));
  }, [rootPath]);

  useEffect(() => { loadAssets(); }, [loadAssets, requirementRevision]);
  useEffect(() => {
    if (eventTouches(latestWorkspaceEvent, rootPath, ["04-测试用例"])) loadAssets();
  }, [latestWorkspaceEvent, loadAssets, rootPath]);

  const assetCount = useCallback((platformId: string, reqId: string) => assets.filter((asset) => asset.platform_id === platformId && asset.requirement_id === reqId).length, [assets]);

  const loadStats = useCallback(async (platform: PlatformInfo, req: RequirementMeta) => {
    const key = requirementKey(platform.id, req.requirement.id);
    setStats((current) => ({ ...current, [key]: { loading: true, caseCount: current[key]?.caseCount ?? null, versionCount: current[key]?.versionCount ?? 0 } }));
    const casesDir = joinPath(requirementDir(rootPath, platform, req.requirement.id), "04-测试用例");
    const [caseCount, versionCount] = await Promise.all([
      api.readJsonFile(joinPath(casesDir, "cases.json"))
        .then((data) => (data && Array.isArray(data.cases) ? (data.cases as unknown[]).length : 0))
        .catch(() => null),
      api.listDirectory(joinPath(casesDir, "versions"))
        .then((entries) => entries.filter((entry) => entry.is_dir).length)
        .catch(() => 0),
    ]);
    setStats((current) => ({ ...current, [key]: { loading: false, caseCount, versionCount } }));
  }, [rootPath]);

  // 已展开需求的统计信息随文件事件刷新
  useEffect(() => {
    if (!latestWorkspaceEvent || !eventTouches(latestWorkspaceEvent, rootPath, ["04-测试用例"])) return;
    expandedReqs.forEach((key) => {
      const [platformId, reqId] = key.split("::");
      const platform = workspace.platforms.find((item) => item.id === platformId);
      const req = (requirements[platformId] || []).find((item) => item.requirement.id === reqId);
      if (platform && req) void loadStats(platform, req);
    });
  }, [latestWorkspaceEvent, expandedReqs, requirements, rootPath, workspace.platforms, loadStats]);

  useEffect(() => {
    expandedReqs.forEach((key) => {
      const [platformId, reqId] = key.split("::");
      const platform = workspace.platforms.find((item) => item.id === platformId);
      const req = (requirements[platformId] || []).find((item) => item.requirement.id === reqId);
      if (platform && req && expanded.has(platformId) && !stats[key]) void loadStats(platform, req);
    });
  }, [expanded, expandedReqs, requirements, stats, workspace.platforms, loadStats]);

  const togglePlatform = (platform: PlatformInfo) => {
    const next = new Set(expanded);
    if (next.has(platform.id)) next.delete(platform.id);
    else next.add(platform.id);
    setExpanded(next);
  };

  const expandRequirement = (platform: PlatformInfo, req: RequirementMeta) => {
    const key = requirementKey(platform.id, req.requirement.id);
    if (!expandedReqs.has(key)) {
      setExpandedReqs((current) => new Set(current).add(key));
      void loadStats(platform, req);
    }
  };

  const toggleRequirement = (platform: PlatformInfo, req: RequirementMeta) => {
    const key = requirementKey(platform.id, req.requirement.id);
    const next = new Set(expandedReqs);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      void loadStats(platform, req);
    }
    setExpandedReqs(next);
  };

  const openCases = (platform: PlatformInfo, req: RequirementMeta) => {
    expandRequirement(platform, req);
    onOpenTab(casesTab(platform, req));
  };

  return (
    <PanelShell icon="checks" title="测试用例" onRefresh={() => { reloadLoaded(); loadAssets(); expandedReqs.forEach((key) => {
      const [platformId, reqId] = key.split("::");
      const platform = workspace.platforms.find((item) => item.id === platformId);
      const req = (requirements[platformId] || []).find((item) => item.requirement.id === reqId);
      if (platform && req) void loadStats(platform, req);
    }); }}>
      {workspace.platforms.length === 0 ? (
        <div className="tool-empty"><AppIcon name="inbox" size={24} /><strong>没有平台</strong><span>在平台管理中注册平台后，这里会显示各需求的用例</span></div>
      ) : workspace.platforms.map((platform) => (
        <div key={platform.id}>
          <ToolRow expandable expanded={expanded.has(platform.id)} icon="platform" label={platform.name}
            badge={expanded.has(platform.id) ? String((requirements[platform.id] || []).length || "") : ""}
            onClick={() => togglePlatform(platform)} onToggle={() => togglePlatform(platform)} />
          {expanded.has(platform.id) && (
            <div>
              {!requirements[platform.id] && <EmptyHint text="读取中…" />}
              {requirements[platform.id]?.length === 0 && <EmptyHint text="暂无需求" />}
              {(requirements[platform.id] || []).map((req) => {
                const key = requirementKey(platform.id, req.requirement.id);
                const locked = req.client_access.mode === "locked_for_ai";
                const reqStats = stats[key];
                return (
                  <React.Fragment key={key}>
                    <ToolRow depth={1} expandable expanded={expandedReqs.has(key)}
                      icon={locked ? "lock" : "box"}
                      label={<>{req.requirement.id} <small>{req.requirement.name}</small></>}
                      badge={locked ? "AI" : ""} badgeTone="warning"
                      title={`${req.requirement.id} · ${req.requirement.name}`}
                      onClick={() => openCases(platform, req)}
                      onToggle={() => toggleRequirement(platform, req)} />
                    {expandedReqs.has(key) && (
                      <div>
                        <ToolRow depth={2} icon="checks" label="结构化用例"
                          badge={reqStats?.loading ? "…" : reqStats ? (reqStats.caseCount === null ? "未生成" : `${reqStats.caseCount} 条`) : ""}
                          badgeTone={reqStats && reqStats.caseCount === null ? "warning" : ""}
                          title="cases.json 结构化用例"
                          onClick={() => onOpenTab(casesTab(platform, req))} />
                        <ToolRow depth={2} icon="archiveFile" label="XMind/Excel资产"
                          badge={String(assetCount(platform.id, req.requirement.id))}
                          title="04-测试用例 目录下的用例文件与导入入口"
                          onClick={() => onOpenTab(caseAssetsTab(platform, req))} />
                        <ToolRow depth={2} icon="history" label="正式版本"
                          badge={reqStats?.loading ? "…" : reqStats ? `${reqStats.versionCount} 个` : ""}
                          title="已提交用例版本与差异比较"
                          onClick={() => onOpenTab(casesTab(platform, req, "versions"))} />
                        <ToolRow depth={2} icon="tools" label="模板与导出"
                          title="按模板导出 XMind/Excel 交付物"
                          onClick={() => onOpenTab(caseExportTab(platform, req))} />
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </PanelShell>
  );
}

// —— 执行与报告工具窗口 ————————————————————————————————

interface RunSummary {
  id: string;
  name: string;
  progress: number;
  total: number;
  environment: string;
}

interface ReportSummary {
  id: string;
  name: string;
  outputPath: string;
  createdAt: string;
}

interface ExecutionStats {
  loading: boolean;
  runs: RunSummary[];
  reports: ReportSummary[];
}

export function ExecutionToolWindow({ workspace, onOpenTab, requirementRevision, latestWorkspaceEvent }: ContextToolWindowProps) {
  const rootPath = workspace.workspace.root_path;
  const [expanded, setExpanded] = usePersistentExpanded(rootPath, "execution.platforms");
  const { requirements, reloadLoaded } = usePlatformRequirements(workspace, requirementRevision, latestWorkspaceEvent, expanded);
  const [expandedReqs, setExpandedReqs] = usePersistentExpanded(rootPath, "execution.reqs");
  const [expandedGroups, setExpandedGroups] = usePersistentExpanded(rootPath, "execution.groups");
  const [stats, setStats] = useState<Record<string, ExecutionStats>>({});
  const statsRef = useRef(stats);
  useEffect(() => { statsRef.current = stats; }, [stats]);

  const loadStats = useCallback(async (platform: PlatformInfo, req: RequirementMeta) => {
    const key = requirementKey(platform.id, req.requirement.id);
    const reqDir = requirementDir(rootPath, platform, req.requirement.id);
    setStats((current) => ({ ...current, [key]: { loading: true, runs: current[key]?.runs || [], reports: current[key]?.reports || [] } }));
    const [runs, reports] = await Promise.all([
      api.listDirectory(joinPath(reqDir, "06-测试执行与证据")).then(async (entries) => {
        const loaded = await Promise.all(entries.filter((entry) => entry.is_dir).map(async (entry) => {
          try {
            const [runValue, resultsValue] = await Promise.all([
              api.readJsonFile(joinPath(entry.path, "run.json")),
              api.readJsonFile(joinPath(entry.path, "results.json")),
            ]);
            const results = Array.isArray(resultsValue?.results) ? resultsValue.results : [];
            return {
              id: (typeof runValue?.run_id === "string" && runValue.run_id) || entry.name,
              name: (typeof runValue?.name === "string" && runValue.name) || entry.name,
              progress: getTestRunStats(results).progress,
              total: results.length,
              environment: typeof runValue?.environment === "string" ? runValue.environment : "",
            } as RunSummary;
          } catch {
            return null;
          }
        }));
        return loaded.filter((item): item is RunSummary => Boolean(item)).sort((a, b) => b.id.localeCompare(a.id));
      }).catch(() => [] as RunSummary[]),
      api.listDirectory(joinPath(reqDir, "07-测试报告")).then(async (entries) => {
        const loaded = await Promise.all(entries.filter((entry) => entry.is_dir).map(async (entry) => {
          try {
            const manifest = await api.readJsonFile(joinPath(entry.path, "report.json"));
            const outputPath = typeof manifest?.output_path === "string" ? manifest.output_path : "";
            return {
              id: (typeof manifest?.report_id === "string" && manifest.report_id) || entry.name,
              name: outputPath ? outputPath.split(/[\\/]/).pop() || outputPath : entry.name,
              outputPath,
              createdAt: typeof manifest?.created_at === "string" ? manifest.created_at : "",
            } as ReportSummary;
          } catch {
            return null;
          }
        }));
        return loaded.filter((item): item is ReportSummary => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }).catch(() => [] as ReportSummary[]),
    ]);
    setStats((current) => ({ ...current, [key]: { loading: false, runs, reports } }));
  }, [rootPath]);

  useEffect(() => {
    if (!latestWorkspaceEvent || !eventTouches(latestWorkspaceEvent, rootPath, ["06-测试执行与证据", "07-测试报告"])) return;
    expandedReqs.forEach((key) => {
      const [platformId, reqId] = key.split("::");
      const platform = workspace.platforms.find((item) => item.id === platformId);
      const req = (requirements[platformId] || []).find((item) => item.requirement.id === reqId);
      if (platform && req) void loadStats(platform, req);
    });
  }, [latestWorkspaceEvent, expandedReqs, requirements, rootPath, workspace.platforms, loadStats]);

  useEffect(() => {
    expandedReqs.forEach((key) => {
      const [platformId, reqId] = key.split("::");
      const platform = workspace.platforms.find((item) => item.id === platformId);
      const req = (requirements[platformId] || []).find((item) => item.requirement.id === reqId);
      if (platform && req && expanded.has(platformId) && !stats[key]) void loadStats(platform, req);
    });
  }, [expanded, expandedReqs, requirements, stats, workspace.platforms, loadStats]);

  const togglePlatform = (platform: PlatformInfo) => {
    const next = new Set(expanded);
    if (next.has(platform.id)) next.delete(platform.id);
    else next.add(platform.id);
    setExpanded(next);
  };

  const toggleRequirement = (platform: PlatformInfo, req: RequirementMeta, open = false) => {
    const key = requirementKey(platform.id, req.requirement.id);
    const next = new Set(expandedReqs);
    if (next.has(key) && !open) next.delete(key);
    else {
      next.add(key);
      void loadStats(platform, req);
    }
    setExpandedReqs(next);
  };

  const toggleGroup = (key: string) => {
    const next = new Set(expandedGroups);
    next.has(key) ? next.delete(key) : next.add(key);
    setExpandedGroups(next);
  };

  const openReport = (platform: PlatformInfo, req: RequirementMeta, report: ReportSummary) => {
    if (report.outputPath) {
      const absolute = joinPath(requirementDir(rootPath, platform, req.requirement.id), report.outputPath);
      const lower = absolute.toLowerCase();
      if (/\.(md|markdown|docx)$/.test(lower)) {
        onOpenTab(reportFileTab(absolute));
        return;
      }
      void systemOpen.openFile(absolute);
      return;
    }
    onOpenTab(reportTab(platform, req));
  };

  return (
    <PanelShell icon="test" title="执行与报告" onRefresh={() => { reloadLoaded(); expandedReqs.forEach((key) => {
      const [platformId, reqId] = key.split("::");
      const platform = workspace.platforms.find((item) => item.id === platformId);
      const req = (requirements[platformId] || []).find((item) => item.requirement.id === reqId);
      if (platform && req) void loadStats(platform, req);
    }); }}>
      {workspace.platforms.length === 0 ? (
        <div className="tool-empty"><AppIcon name="inbox" size={24} /><strong>没有平台</strong><span>注册平台后显示测试轮次与报告</span></div>
      ) : workspace.platforms.map((platform) => (
        <div key={platform.id}>
          <ToolRow expandable expanded={expanded.has(platform.id)} icon="platform" label={platform.name}
            onClick={() => togglePlatform(platform)} onToggle={() => togglePlatform(platform)} />
          {expanded.has(platform.id) && (
            <div>
              {!requirements[platform.id] && <EmptyHint text="读取中…" />}
              {requirements[platform.id]?.length === 0 && <EmptyHint text="暂无需求" />}
              {(requirements[platform.id] || []).map((req) => {
                const key = requirementKey(platform.id, req.requirement.id);
                const locked = req.client_access.mode === "locked_for_ai";
                const reqStats = stats[key];
                const runsKey = `${key}::runs`;
                const reportsKey = `${key}::reports`;
                return (
                  <React.Fragment key={key}>
                    <ToolRow depth={1} expandable expanded={expandedReqs.has(key)}
                      icon={locked ? "lock" : "box"}
                      label={<>{req.requirement.id} <small>{req.requirement.name}</small></>}
                      badge={locked ? "AI" : ""} badgeTone="warning"
                      title={`${req.requirement.id} · ${req.requirement.name}`}
                      onClick={() => { toggleRequirement(platform, req, true); onOpenTab(executionTab(platform, req)); }}
                      onToggle={() => toggleRequirement(platform, req)} />
                    {expandedReqs.has(key) && (
                      <div>
                        <ToolRow depth={2} expandable expanded={expandedGroups.has(runsKey)} icon="test" label="测试执行"
                          badge={reqStats?.loading ? "…" : reqStats ? `${reqStats.runs.length} 轮` : ""}
                          title="测试轮次与执行结果"
                          onClick={() => { toggleGroup(runsKey); onOpenTab(executionTab(platform, req)); }}
                          onToggle={() => toggleGroup(runsKey)} />
                        {expandedGroups.has(runsKey) && (
                          <div>
                            {reqStats?.loading && <EmptyHint text="读取中…" />}
                            {!reqStats?.loading && !reqStats?.runs.length && <EmptyHint text="暂无测试轮次" />}
                            {reqStats?.runs.map((run) => (
                              <ToolRow key={run.id} depth={3} icon="play" label={run.name}
                                hint={run.environment || undefined}
                                badge={`${run.progress}%`}
                                title={`${run.id} · ${run.total} 条用例 · 进度 ${run.progress}%`}
                                onClick={() => onOpenTab(executionTab(platform, req, run.id))} />
                            ))}
                          </div>
                        )}
                        <ToolRow depth={2} expandable expanded={expandedGroups.has(reportsKey)} icon="file" label="测试报告"
                          badge={reqStats?.loading ? "…" : reqStats ? `${reqStats.reports.length} 份` : ""}
                          title="报告生成与历史记录"
                          onClick={() => { toggleGroup(reportsKey); onOpenTab(reportTab(platform, req)); }}
                          onToggle={() => toggleGroup(reportsKey)} />
                        {expandedGroups.has(reportsKey) && (
                          <div>
                            {reqStats?.loading && <EmptyHint text="读取中…" />}
                            {!reqStats?.loading && !reqStats?.reports.length && <EmptyHint text="暂无测试报告" />}
                            {reqStats?.reports.map((report) => (
                              <ToolRow key={report.id} depth={3} icon="markdown" label={report.name}
                                hint={report.createdAt ? report.createdAt.slice(0, 10) : undefined}
                                title={report.outputPath || report.id}
                                onClick={() => openReport(platform, req, report)} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </PanelShell>
  );
}

// —— 知识库工具窗口 ————————————————————————————————————

export function KnowledgeToolWindow({ workspace, onOpenTab, requirementRevision, latestWorkspaceEvent }: ContextToolWindowProps) {
  const rootPath = workspace.workspace.root_path;
  const [expanded, setExpanded] = usePersistentExpanded(rootPath, "knowledge");
  const candidatePlatforms = useMemo(() => new Set(workspace.platforms.filter((platform) => expanded.has(`candidates:${platform.id}`)).map((platform) => platform.id)), [expanded, workspace.platforms]);
  const { requirements, reloadLoaded } = usePlatformRequirements(workspace, requirementRevision, latestWorkspaceEvent, candidatePlatforms);
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  const loadCount = useCallback(async (key: string, path: string, field: "items" | "candidates") => {
    const count = await api.readJsonFile(path)
      .then((data) => (data && Array.isArray(data[field]) ? (data[field] as unknown[]).length : 0))
      .catch(() => null);
    setCounts((current) => ({ ...current, [key]: count }));
  }, []);

  const loadGeneral = useCallback(() => loadCount("general", knowledgeRegistryPath(rootPath, workspace, "general"), "items"), [loadCount, rootPath, workspace]);
  const loadPlatformKnowledge = useCallback((platform: PlatformInfo) => loadCount(`platform:${platform.id}`, knowledgeRegistryPath(rootPath, workspace, "platform", platform.id), "items"), [loadCount, rootPath, workspace]);
  const loadCandidate = useCallback((platform: PlatformInfo, req: RequirementMeta) => loadCount(`candidate:${platform.id}:${req.requirement.id}`, candidateRegistryPath(rootPath, platform.path, req.requirement.id), "candidates"), [loadCount, rootPath]);

  useEffect(() => { void loadGeneral(); }, [loadGeneral, requirementRevision]);

  // 知识文件变化时刷新已加载的计数
  useEffect(() => {
    if (!latestWorkspaceEvent || !eventTouches(latestWorkspaceEvent, rootPath, ["knowledge", "08-知识候选"])) return;
    void loadGeneral();
    Object.keys(counts).forEach((key) => {
      if (key.startsWith("platform:")) {
        const platform = workspace.platforms.find((item) => item.id === key.slice(9));
        if (platform) void loadPlatformKnowledge(platform);
      } else if (key.startsWith("candidate:")) {
        const [, platformId, reqId] = key.split(":");
        const platform = workspace.platforms.find((item) => item.id === platformId);
        const req = (requirements[platformId] || []).find((item) => item.requirement.id === reqId);
        if (platform && req) void loadCandidate(platform, req);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestWorkspaceEvent]);

  useEffect(() => {
    workspace.platforms.forEach((platform) => {
      if (candidatePlatforms.has(platform.id)) (requirements[platform.id] || []).forEach((req) => void loadCandidate(platform, req));
    });
  }, [candidatePlatforms, requirements, workspace.platforms, loadCandidate]);

  const toggle = (key: string, onExpand?: () => void) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      onExpand?.();
    }
    setExpanded(next);
  };

  const badge = (key: string) => counts[key] === null ? "无" : counts[key] === undefined ? "" : `${counts[key]} 条`;

  return (
    <PanelShell icon="database" title="知识库" onRefresh={() => {
      void loadGeneral();
      workspace.platforms.forEach((platform) => void loadPlatformKnowledge(platform));
      reloadLoaded();
      Object.keys(counts).forEach((key) => {
        if (!key.startsWith("candidate:")) return;
        const [, platformId, reqId] = key.split(":");
        const platform = workspace.platforms.find((item) => item.id === platformId);
        const req = (requirements[platformId] || []).find((item) => item.requirement.id === reqId);
        if (platform && req) void loadCandidate(platform, req);
      });
    }}>
      <ToolRow icon="database" label="通用知识" badge={badge("general")}
        title="knowledge/通用/knowledge.json"
        onClick={() => onOpenTab(knowledgeTab("general"))} />
      <ToolRow expandable expanded={expanded.has("platforms")} icon="platform" label="平台知识"
        onClick={() => toggle("platforms", () => workspace.platforms.forEach((platform) => void loadPlatformKnowledge(platform)))}
        onToggle={() => toggle("platforms")} />
      {expanded.has("platforms") && (
        <div>
          {workspace.platforms.map((platform) => (
            <ToolRow key={platform.id} depth={1} icon="platform" label={platform.name}
              badge={badge(`platform:${platform.id}`)}
              title={platform.knowledge_path || `knowledge/${platform.name}`}
              onClick={() => onOpenTab(knowledgeTab("platform", platform))} />
          ))}
          {workspace.platforms.length === 0 && <EmptyHint text="没有已注册平台" />}
        </div>
      )}
      <ToolRow expandable expanded={expanded.has("candidates")} icon="inbox" label="需求知识候选"
        onClick={() => toggle("candidates")} onToggle={() => toggle("candidates")} />
      {expanded.has("candidates") && (
        <div>
          {workspace.platforms.map((platform) => {
            const pKey = `candidates:${platform.id}`;
            return (
              <div key={platform.id}>
                <ToolRow depth={1} expandable expanded={expanded.has(pKey)} icon="platform" label={platform.name}
                  onClick={() => toggle(pKey)}
                  onToggle={() => toggle(pKey)} />
                {expanded.has(pKey) && (
                  <div>
                    {!requirements[platform.id] && <EmptyHint text="读取中…" />}
                    {requirements[platform.id]?.length === 0 && <EmptyHint text="暂无需求" />}
                    {(requirements[platform.id] || []).map((req) => (
                      <ToolRow key={req.requirement.id} depth={2} icon={req.client_access.mode === "locked_for_ai" ? "lock" : "box"}
                        label={<>{req.requirement.id} <small>{req.requirement.name}</small></>}
                        badge={badge(`candidate:${platform.id}:${req.requirement.id}`)}
                        title={`${req.requirement.id} · 知识候选审核`}
                        onClick={() => onOpenTab(requirementKnowledgeTab(platform, req))} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PanelShell>
  );
}

// —— AI任务工具窗口 ————————————————————————————————————

export type TaskBucket = "running" | "waiting" | "completed" | "failed";

export function taskBucket(task: AiTaskInfo): TaskBucket {
  if (task.review_status === "rejected" || task.status === "failed") return "failed";
  if (task.awaiting_confirmation || task.status === "waiting_review") return "waiting";
  if (task.status === "completed" || task.review_status === "accepted") return "completed";
  return "running";
}

const TASK_BUCKETS: { id: TaskBucket; label: string; icon: IconName }[] = [
  { id: "running", label: "运行中", icon: "play" },
  { id: "waiting", label: "待确认", icon: "review" },
  { id: "completed", label: "已完成", icon: "success" },
  { id: "failed", label: "失败", icon: "error" },
];

export function taskStatusBadge(task: AiTaskInfo): string {
  if (task.review_status === "rejected") return "已拒绝";
  if (task.review_status === "accepted") return "已确认";
  return task.status === "pending" ? "待执行" : task.status === "running" ? "执行中" : task.status === "waiting_review" ? "待确认" : task.status === "completed" ? "已完成" : task.status === "failed" ? "失败" : task.status;
}

export function AiTaskToolWindow({workspace}: ContextToolWindowProps) {
 return <PanelShell icon="ai" title="AI会话"><AiSessionLinks rootPath={workspace.workspace.root_path} /></PanelShell>;
}
