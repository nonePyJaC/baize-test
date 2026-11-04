import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, joinPath } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import { usePersistentExpanded } from "../lib/toolWindowState";
import type { DirEntryInfo, PlatformInfo, RequirementMeta, WorkspaceConfig, WorkspaceEvent } from "../lib/types";
import type { IconName } from "./AppIcon";
import AppIcon from "./AppIcon";
import type { WorkbenchTab } from "../lib/workbench";

interface ProjectToolWindowProps {
  workspace: WorkspaceConfig;
  mode: "project" | "requirements";
  onOpenTab: (tab: WorkbenchTab) => void;
  onCreateRequirement: (platform?: PlatformInfo) => void;
  requirementRevision: number;
  latestWorkspaceEvent: WorkspaceEvent | null;
  locatePath: string | null;
  onLocateHandled: () => void;
  onRequirementAccessChange: (platformId: string, requirementId: string, access: RequirementMeta["client_access"]) => void;
}

export default function ProjectToolWindow({ workspace, mode, onOpenTab, onCreateRequirement, requirementRevision, latestWorkspaceEvent, locatePath, onLocateHandled, onRequirementAccessChange }: ProjectToolWindowProps) {
  return mode === "project" ? (
    <ProjectTree workspace={workspace} onOpenTab={onOpenTab} latestWorkspaceEvent={latestWorkspaceEvent} locatePath={locatePath} onLocateHandled={onLocateHandled} />
  ) : (
    <RequirementTree workspace={workspace} onOpenTab={onOpenTab} onCreateRequirement={onCreateRequirement} requirementRevision={requirementRevision} latestWorkspaceEvent={latestWorkspaceEvent} onRequirementAccessChange={onRequirementAccessChange} />
  );
}

function ProjectTree({ workspace, onOpenTab, latestWorkspaceEvent, locatePath, onLocateHandled }: { workspace: WorkspaceConfig; onOpenTab: (tab: WorkbenchTab) => void; latestWorkspaceEvent: WorkspaceEvent | null; locatePath: string | null; onLocateHandled: () => void }) {
  const root = workspace.workspace.root_path;
  const [expanded, setExpanded] = usePersistentExpanded(root, "project", [root]);
  const [entries, setEntries] = useState<Record<string, DirEntryInfo[]>>({});
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const entriesRef = useRef(entries);
  const expandedRef = useRef(expanded);

  useEffect(() => { entriesRef.current = entries; }, [entries]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  const load = useCallback(async (path: string): Promise<DirEntryInfo[]> => {
    setLoading(true);
    try {
      const next = await api.listDirectory(path);
      setEntries((current) => {
        const updated = { ...current, [path]: next };
        entriesRef.current = updated;
        return updated;
      });
      setLastRefresh(new Date());
      return next;
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setEntries({});
    entriesRef.current = {};
    void load(root);
  }, [load, root]);

  useEffect(() => {
    if (!latestWorkspaceEvent) return;
    const eventPaths = [latestWorkspaceEvent.path, latestWorkspaceEvent.old_path].filter(Boolean) as string[];
    const refreshTargets = new Set<string>();
    eventPaths.forEach((path) => {
      if (samePath(path, root)) refreshTargets.add(root);
      else refreshTargets.add(parentPath(path));
      if (latestWorkspaceEvent.is_directory) refreshTargets.add(path);
    });
    if (latestWorkspaceEvent.event_type === "rename" && latestWorkspaceEvent.is_directory && latestWorkspaceEvent.old_path) {
      setExpanded((current) => {
        const next = new Set(current);
        const oldExpanded = [...current].find((path) => samePath(path, latestWorkspaceEvent.old_path || ""));
        if (oldExpanded) {
          next.delete(oldExpanded);
          next.add(latestWorkspaceEvent.path);
        }
        expandedRef.current = next;
        return next;
      });
    }
    setEntries((current) => {
      const updated = { ...current };
      eventPaths.filter((path) => latestWorkspaceEvent.is_directory).forEach((path) => {
        Object.keys(updated).filter((knownPath) => isPathWithin(knownPath, path)).forEach((knownPath) => delete updated[knownPath]);
      });
      entriesRef.current = updated;
      return updated;
    });
    const targets = [...refreshTargets]
      .map((path) => knownPath(path, entriesRef.current) || (samePath(path, root) ? root : path))
      .filter((path, index, all) => all.findIndex((item) => samePath(item, path)) === index)
      .filter((path) => samePath(path, root) || Boolean(knownPath(path, entriesRef.current)) || expandedRef.current.has(path));
    void Promise.all(targets.map((path) => load(path)));
  }, [latestWorkspaceEvent, load, root]);

  useEffect(() => {
    if (!locatePath) return;
    let cancelled = false;
    const locate = async () => {
      let currentEntries = entriesRef.current[root] || await load(root);
      const normalizedRoot = normalizePath(root);
      const normalizedTarget = normalizePath(locatePath);
      if (!isPathWithin(normalizedTarget, normalizedRoot) || samePath(normalizedTarget, normalizedRoot)) {
        if (!cancelled) onLocateHandled();
        return;
      }
      const relative = normalizedTarget.slice(normalizedRoot.length).replace(/^\/+/, "");
      let currentPath = root;
      for (const segment of relative.split("/").filter(Boolean)) {
        if (cancelled) return;
        const nextPath = joinPath(currentPath, segment);
        const child = currentEntries.find((entry) => samePath(entry.path, nextPath));
        if (!child) break;
        setExpanded((current) => {
          const next = new Set(current).add(child.path);
          expandedRef.current = next;
          return next;
        });
        if (!child.is_dir) break;
        currentPath = child.path;
        currentEntries = await load(child.path);
      }
      if (!cancelled) onLocateHandled();
    };
    void locate();
    return () => { cancelled = true; };
  }, [load, locatePath, onLocateHandled, root]);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (!knownPath(path, entriesRef.current)) void load(path);
    }
    expandedRef.current = next;
    setExpanded(next);
  };

  const openFile = (entry: DirEntryInfo) => {
    const lower = entry.name.toLowerCase();
    const type = /\.(md|txt|yaml|yml|json|py|toml|rs|csv|log)$/.test(lower)
      ? "markdown"
      : lower.endsWith(".docx")
        ? "docx"
        : lower.endsWith(".xlsx")
          ? "excel"
          : lower.endsWith(".xmind")
            ? "xmind"
            : null;
    if (!type) {
      void systemOpen.openFile(entry.path);
      return;
    }
    onOpenTab({
      id: `file:${entry.path}`,
      type,
      title: entry.name,
      subtitle: entry.path,
      icon: fileIcon(entry.name),
      preview: true,
      pinned: false,
      dirty: false,
      closable: true,
      payload: { path: entry.path },
    });
  };

  const visibleEntries = useMemo(() => {
    const current = entries[root] || [];
    return filter.trim()
      ? current.filter((entry) => entry.name.toLowerCase().includes(filter.trim().toLowerCase()))
      : current;
  }, [entries, root, filter]);

  return (
    <div className="tool-panel-content">
      <div className="tool-panel-header">
        <div className="tool-panel-title"><AppIcon name="folderOpen" size={15} /> 项目</div>
        <button className="icon-button" onClick={() => void load(root)} title="刷新项目树">
          <AppIcon name="refresh" size={14} />
        </button>
      </div>
      <div className="tool-panel-path" title={root}>{root}<span>{lastRefresh ? `同步于 ${lastRefresh.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "等待同步"}</span></div>
      <div className="tool-search">
        <AppIcon name="search" size={14} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选文件" />
      </div>
      <div className="tree-scroll">
        <TreeNode
          entry={{ name: workspace.workspace.name || root.split(/[\\/]/).filter(Boolean).pop() || "工作区", path: root, is_dir: true, size: 0, modified: "" }}
          depth={0}
          expanded={expanded}
          entries={entries}
          visibleEntries={visibleEntries}
          onToggle={toggle}
          onOpenFile={openFile}
          loading={loading}
          locatePath={locatePath}
        />
      </div>
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  expanded,
  entries,
  visibleEntries,
  onToggle,
  onOpenFile,
  loading,
  locatePath,
}: {
  entry: DirEntryInfo;
  depth: number;
  expanded: Set<string>;
  entries: Record<string, DirEntryInfo[]>;
  visibleEntries?: DirEntryInfo[];
  onToggle: (path: string) => void;
  onOpenFile: (entry: DirEntryInfo) => void;
  loading: boolean;
  locatePath: string | null;
}) {
  const isExpanded = expanded.has(entry.path);
  const children = visibleEntries || entries[entry.path] || [];
  const located = Boolean(locatePath && samePath(entry.path, locatePath));
  return (
    <div className="tree-node">
      <button className={`tree-row ${located ? "located" : ""}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => entry.is_dir ? onToggle(entry.path) : onOpenFile(entry)}>
        <span className="tree-chevron">{entry.is_dir ? <AppIcon name={isExpanded ? "down" : "next"} size={13} /> : null}</span>
        <AppIcon name={entry.is_dir ? (isExpanded ? "folderOpen" : "folder") : fileIcon(entry.name)} size={15} />
        <span className="tree-label" title={entry.path}>{entry.name}</span>
      </button>
      {entry.is_dir && isExpanded && (
        <div>
          {loading && children.length === 0 && <div className="tree-hint" style={{ paddingLeft: 32 + depth * 16 }}>读取中…</div>}
          {!loading && children.length === 0 && <div className="tree-hint" style={{ paddingLeft: 32 + depth * 16 }}>空目录</div>}
          {children.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} expanded={expanded} entries={entries} onToggle={onToggle} onOpenFile={onOpenFile} loading={loading} locatePath={locatePath} />
          ))}
        </div>
      )}
    </div>
  );
}

function RequirementTree({ workspace, onOpenTab, onCreateRequirement, requirementRevision, latestWorkspaceEvent, onRequirementAccessChange }: { workspace: WorkspaceConfig; onOpenTab: (tab: WorkbenchTab) => void; onCreateRequirement: (platform?: PlatformInfo) => void; requirementRevision: number; latestWorkspaceEvent: WorkspaceEvent | null; onRequirementAccessChange: (platformId: string, requirementId: string, access: RequirementMeta["client_access"]) => void }) {
  const [requirements, setRequirements] = useState<Record<string, RequirementMeta[]>>({});
  const [expanded, setExpanded] = usePersistentExpanded(workspace.workspace.root_path, "requirements.platforms");
  const [expandedRequirements, setExpandedRequirements] = usePersistentExpanded(workspace.workspace.root_path, "requirements.reqs");
  const [loading, setLoading] = useState(false);
  const requirementsRef = useRef(requirements);

  useEffect(() => { requirementsRef.current = requirements; }, [requirements]);
  useEffect(() => {
    setRequirements({});
    requirementsRef.current = {};
  }, [workspace.workspace.root_path]);
  useEffect(() => {
    const loadedPlatforms = workspace.platforms.filter((platform) => Object.prototype.hasOwnProperty.call(requirementsRef.current, platform.id));
    if (!loadedPlatforms.length) return;
    void Promise.all(loadedPlatforms.map(async (platform) => ({ id: platform.id, items: await api.scanRequirements(workspace.workspace.root_path, platform.path).catch(() => []) }))).then((updates) => {
      setRequirements((current) => {
        const next = { ...current };
        updates.forEach((update) => {
          next[update.id] = update.items;
          update.items.forEach((item) => onRequirementAccessChange(update.id, item.requirement.id, item.client_access));
        });
        requirementsRef.current = next;
        return next;
      });
    });
  }, [onRequirementAccessChange, requirementRevision, workspace.platforms, workspace.workspace.root_path]);

  useEffect(() => {
    if (!latestWorkspaceEvent) return;
    const eventPaths = [latestWorkspaceEvent.path, latestWorkspaceEvent.old_path].filter(Boolean) as string[];
    const affectedPlatforms = workspace.platforms.filter((platform) => eventPaths.some((path) => isPathWithin(path, joinPath(workspace.workspace.root_path, platform.path))));
    const loadedPlatforms = affectedPlatforms.filter((platform) => Object.prototype.hasOwnProperty.call(requirementsRef.current, platform.id));
    if (!loadedPlatforms.length) return;
    void Promise.all(loadedPlatforms.map(async (platform) => ({ id: platform.id, items: await api.scanRequirements(workspace.workspace.root_path, platform.path).catch(() => []) }))).then((updates) => {
      setRequirements((current) => {
        const next = { ...current };
        updates.forEach((update) => {
          next[update.id] = update.items;
          update.items.forEach((item) => onRequirementAccessChange(update.id, item.requirement.id, item.client_access));
        });
        requirementsRef.current = next;
        return next;
      });
    });
  }, [latestWorkspaceEvent, onRequirementAccessChange, workspace]);

  const loadPlatform = async (platform: PlatformInfo) => {
    if (requirementsRef.current[platform.id]) {
      setExpanded((current) => {
        const next = new Set(current);
        next.has(platform.id) ? next.delete(platform.id) : next.add(platform.id);
        return next;
      });
      return;
    }
    setLoading(true);
    try {
      const items = await api.scanRequirements(workspace.workspace.root_path, platform.path);
      setRequirements((current) => {
        const next = { ...current, [platform.id]: items };
        requirementsRef.current = next;
        return next;
      });
      items.forEach((item) => onRequirementAccessChange(platform.id, item.requirement.id, item.client_access));
      setExpanded((current) => new Set(current).add(platform.id));
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    workspace.platforms.forEach((platform) => {
      if (expanded.has(platform.id) && !requirementsRef.current[platform.id]) void loadPlatform(platform);
    });
  }, [expanded, workspace.platforms]);

  const toggleRequirement = (key: string) => setExpandedRequirements((current) => {
    const next = new Set(current);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const openNode = (platform: PlatformInfo, req: RequirementMeta, node: RequirementTreeNode) => {
    if (node.kind === "folder" && node.folder) {
      onOpenTab(folderTab(platform, req, node.folder, node.label));
      return;
    }
    if (node.kind === "cases") return void onOpenTab(casesTab(platform, req));
    if (node.kind === "execution") return void onOpenTab(executionTab(platform, req));
    if (node.kind === "report") return void onOpenTab(reportTab(platform, req));
    if (node.kind === "knowledge") return void onOpenTab(requirementKnowledgeTab(platform, req));
    if (node.kind === "tasks") return void onOpenTab(aiTaskTab(platform, req));
    onOpenTab(requirementTab(platform, req));
  };

  return (
    <div className="tool-panel-content">
      <div className="tool-panel-header">
        <div className="tool-panel-title"><AppIcon name="checks" size={15} /> 需求</div>
        <div className="tool-panel-actions"><button className="icon-button" onClick={() => onCreateRequirement()} title="新建需求"><AppIcon name="add" size={14} /></button><button className="icon-button" onClick={() => { setRequirements({}); requirementsRef.current = {}; setExpanded(new Set()); setExpandedRequirements(new Set()); }} title="刷新需求树">
          <AppIcon name="refresh" size={14} />
        </button></div>
      </div>
      <div className="tree-scroll">
        {workspace.platforms.length === 0 ? (
          <div className="tool-empty">
            <AppIcon name="inbox" size={24} />
            <strong>未发现标准需求</strong>
            <span>在 projects/平台/需求 下放置 requirement.yaml 后刷新</span>
          </div>
        ) : workspace.platforms.map((platform) => (
          <div key={platform.id}>
            <button className="tree-row" onClick={() => void loadPlatform(platform)}>
              <span className="tree-chevron"><AppIcon name={expanded.has(platform.id) ? "down" : "next"} size={13} /></span>
              <AppIcon name="platform" size={15} />
              <span className="tree-label">{platform.name}</span>
              <span className="tree-status">{(requirements[platform.id] || []).length || ""}</span>
            </button>
            {expanded.has(platform.id) && (
              <div>
                {loading && !(requirements[platform.id] || []).length && <div className="tree-hint" style={{ paddingLeft: 36 }}>读取中…</div>}
                {(requirements[platform.id] || []).map((req) => {
                  const requirementKey = `${platform.id}::${req.requirement.id}`;
                  const requirementExpanded = expandedRequirements.has(requirementKey);
                  return (
                    <React.Fragment key={req.requirement.id}>
                      <div
                        className="tree-row tree-row-requirement"
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenTab(requirementTab(platform, req))}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenTab(requirementTab(platform, req)); } }}
                      >
                        <button
                          className="tree-chevron tree-chevron-button"
                          title={requirementExpanded ? "收起" : "展开"}
                          onClick={(event) => { event.stopPropagation(); toggleRequirement(requirementKey); }}
                        >
                          <AppIcon name={requirementExpanded ? "down" : "next"} size={13} />
                        </button>
                        <AppIcon name={req.client_access.mode === "locked_for_ai" ? "lock" as IconName : "box"} size={14} />
                        <span className="tree-label" title={req.requirement.name}>{req.requirement.id} <small>{req.requirement.name}</small></span>
                        <span className="tree-status">{req.client_access.mode === "locked_for_ai" ? "AI" : ""}</span>
                      </div>
                      {requirementExpanded && (
                        <div className="requirement-tree-children">
                          {REQUIREMENT_TREE_NODES.map((node) => (
                            <button className="tree-row tree-row-requirement-child" key={node.label} onClick={() => openNode(platform, req, node)} title={node.kind === "folder" ? `在项目树定位 ${node.folder}` : node.label}>
                              <span className="tree-chevron" />
                              <AppIcon name={node.icon} size={13} />
                              <span className="tree-label">{node.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
                {requirements[platform.id] && requirements[platform.id].length === 0 && <div className="tree-hint" style={{ paddingLeft: 36 }}>暂无需求</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface RequirementTreeNode {
  label: string;
  kind: "requirement" | "folder" | "cases" | "execution" | "report" | "knowledge" | "tasks";
  icon: IconName;
  folder?: string;
}

const REQUIREMENT_TREE_NODES: RequirementTreeNode[] = [
  { label: "概览", kind: "requirement", icon: "box" },
  { label: "需求资料", kind: "folder", icon: "folder", folder: "01-需求资料" },
  { label: "需求理解与答疑", kind: "folder", icon: "folder", folder: "02-需求理解与答疑" },
  { label: "测试计划", kind: "folder", icon: "folder", folder: "03-测试计划" },
  { label: "开发资源", kind: "folder", icon: "folder", folder: "05-开发资源" },
  { label: "测试用例", kind: "cases", icon: "checks" },
  { label: "测试执行", kind: "execution", icon: "test" },
  { label: "测试报告", kind: "report", icon: "file" },
  { label: "知识候选", kind: "knowledge", icon: "database" },
  { label: "AI任务", kind: "tasks", icon: "ai" },
];

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/$/.test(normalized) || normalized === "/") return normalized;
  return normalized.replace(/\/+$/g, "");
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isPathWithin(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent);
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function knownPath(path: string, entries: Record<string, DirEntryInfo[]>): string | undefined {
  return Object.keys(entries).find((known) => samePath(known, path));
}

function requirementTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return {
    id: `requirement:${platform.id}:${req.requirement.id}`,
    type: "requirement",
    title: req.requirement.id,
    subtitle: `${platform.name} · ${req.requirement.name}`,
    icon: req.client_access.mode === "locked_for_ai" ? "lock" : "box",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, platformPath: platform.path, requirementId: req.requirement.id },
  };
}

function requirementChildTab(platform: PlatformInfo, req: RequirementMeta, kind: "structured-cases" | "test-execution" | "report-generation"): WorkbenchTab {
  const config = {
    "structured-cases": { idPrefix: "cases", title: "结构化用例", icon: "checks" },
    "test-execution": { idPrefix: "test-execution", title: "测试执行", icon: "test" },
    "report-generation": { idPrefix: "report-generation", title: "测试报告", icon: "file" },
  }[kind];
  return {
    id: `${config.idPrefix}:${platform.id}:${req.requirement.id}`,
    type: kind,
    title: config.title,
    subtitle: `${platform.name} · ${req.requirement.id}`,
    icon: config.icon,
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, platformPath: platform.path, requirementId: req.requirement.id },
  };
}

function folderTab(platform: PlatformInfo, req: RequirementMeta, folder: string, label: string): WorkbenchTab {
  return {
    id: `requirement-folder:${platform.id}:${req.requirement.id}:${folder}`,
    type: "requirement-folder",
    title: label,
    subtitle: `${platform.name} · ${req.requirement.id} · ${folder}`,
    icon: "folder",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, platformPath: platform.path, requirementId: req.requirement.id, folder },
  };
}

function casesTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return requirementChildTab(platform, req, "structured-cases");
}

function executionTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return requirementChildTab(platform, req, "test-execution");
}

function reportTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return requirementChildTab(platform, req, "report-generation");
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

function aiTaskTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return {
    id: "ai-tasks",
    type: "ai-task",
    title: "AI任务",
    subtitle: `${platform.name} · ${req.requirement.id}`,
    icon: "ai",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, requirementId: req.requirement.id, focusKey: Date.now() },
  };
}

function fileIcon(name: string): IconName {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "md") return "markdown";
  if (ext === "yaml" || ext === "yml") return "codeFile";
  if (ext === "json") return "jsonFile";
  if (ext === "py" || ext === "rs" || ext === "ts" || ext === "tsx") return "codeFile";
  if (ext === "xmind" || ext === "zip") return "archiveFile";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "spreadsheet";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") return "image";
  return "file";
}
