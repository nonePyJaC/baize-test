import { DraftScope, saveDirtyTabs } from "../lib/draftGuard";
import { invalidateBusinessData } from "../lib/businessEvents";
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppIcon, { type IconName } from "./AppIcon";
import ProjectToolWindow from "./ProjectToolWindow";
import WorkbenchTabs from "./WorkbenchTabs";
import { BottomToolWindow, RightToolWindow, useWorkspaceTasks } from "./ToolWindows";
import WorkspaceHomeView from "../views/WorkspaceHomeView";
import PlatformView from "../views/PlatformView";
import RequirementOverviewView from "../views/RequirementOverviewView";
import MarkdownDocumentView from "../views/MarkdownDocumentView";
import QuestionsWorkspaceView from "../views/QuestionsWorkspaceView";
import CoverageView from "../views/CoverageView";
import TestAssetsView from "../views/TestAssetsView";
import StructuredCasesView from "../views/StructuredCasesView";
import TemplateExportView from "../views/TemplateExportView";
import TestExecutionView from "../views/TestExecutionView";
import ApiDebugView from "../views/ApiDebugView";
import ReportGenerationView from "../views/ReportGenerationView";
import KnowledgeView from "../views/KnowledgeView";
import RequirementFolderView from "../views/RequirementFolderView";
import SettingsView from "../views/SettingsView";
import RequirementManagementModal from "./RequirementManagementModal";
import AiTaskWorkspace from "./AiTaskWorkspace";
import GlobalSearchPanel from "./GlobalSearchPanel";
import logoBaize from "../assets/logo-baize.png";

const DocxDocumentView = React.lazy(() => import("../views/DocxDocumentView"));
const ExcelDocumentView = React.lazy(() => import("../views/ExcelDocumentView"));
const ImageDocumentView = React.lazy(() => import("../views/ImageDocumentView"));
const XMindDocumentView = React.lazy(() => import("../views/XMindDocumentView"));
import { formatDateTime } from "../lib/date";
import { api, isMacPlatform, isTauri, joinPath, WORKSPACE_EVENT } from "../lib/api";
import { APP_NAME, APP_VERSION } from "../lib/appInfo";
import { logClientAction } from "../lib/auditLog";
import { notify } from "../lib/notify";
import { systemOpen } from "../lib/systemOpen";
import { centerActiveTab } from "../lib/scrollTabs";
import { aiTaskTab, TestToolWindow, ExecutionToolWindow, KnowledgeToolWindow, AiTaskToolWindow } from "./ContextToolWindows";
import type { AiTaskInfo, ClientAccess, ClientPreferences, FileChanges, PlatformInfo, RequirementMeta, WorkspaceConfig, WorkspaceEvent, WorkspaceSearchResult } from "../lib/types";
import { DEFAULT_TAB, makeTab, NAV_TOOL_VIEW, TAB_NAV, type BottomView, type ClosedTab, type RightContextData, type RightView, type ToolView, type WorkbenchNav, type WorkbenchTab } from "../lib/workbench";

const SESSION_KEY = "blackbox-client.workbench.v2";

interface WorkbenchShellProps {
  workspace: WorkspaceConfig;
  onWorkspaceChange: (workspace: WorkspaceConfig) => void;
  onWorkspaceNeedsSetup: (path: string) => void;
}

interface SessionState {
  workspacePath?: string;
  tabs?: WorkbenchTab[];
  activeId?: string;
  activeNav?: WorkbenchNav;
  /** 旧版会话字段，仅用于兼容读取 */
  toolView?: ToolView;
  rightView?: RightView;
  rightOpen?: boolean;
  bottomView?: BottomView;
  bottomOpen?: boolean;
  leftOpen?: boolean;
  leftWidth?: number;
  rightWidth?: number;
  bottomHeight?: number;
}

const navItems: { id: WorkbenchNav; label: string; icon: IconName }[] = [
  { id: "home", label: "首页", icon: "dashboard" },
  { id: "project", label: "项目", icon: "folder" },
  { id: "requirements", label: "需求", icon: "box" },
  { id: "tests", label: "用例", icon: "checks" },
  { id: "execution", label: "执行与报告", icon: "test" },
  { id: "api-debug", label: "接口调试", icon: "code" },
  { id: "knowledge", label: "知识库", icon: "database" },
  { id: "tasks", label: "AI会话", icon: "ai" },
];

const TOOL_VIEW_TABS: { id: Exclude<ToolView, "none">; label: string; icon: IconName; nav: WorkbenchNav }[] = [
  { id: "project", label: "项目", icon: "folder", nav: "project" },
  { id: "requirements", label: "需求", icon: "box", nav: "requirements" },
  { id: "tests", label: "用例", icon: "checks", nav: "tests" },
  { id: "execution", label: "执行", icon: "test", nav: "execution" },
  { id: "knowledge", label: "知识", icon: "database", nav: "knowledge" },
  { id: "tasks", label: "会话", icon: "ai", nav: "tasks" },
];

export default function WorkbenchShell({ workspace, onWorkspaceChange, onWorkspaceNeedsSetup }: WorkbenchShellProps) {
  const initial = readSession(workspace.workspace.root_path);
  const [tabs, setTabs] = useState<WorkbenchTab[]>(initial.tabs?.length ? initial.tabs : [DEFAULT_TAB]);
  const [activeId, setActiveId] = useState(initial.activeId || DEFAULT_TAB.id);
  const [closedTabs, setClosedTabs] = useState<ClosedTab[]>([]);
  const [activeNav, setActiveNav] = useState<WorkbenchNav>(() => {
    if (initial.activeNav) return initial.activeNav;
    // 旧会话没有 activeNav 字段：从激活Tab反推主导航，保证导航/左树/Tab一致
    const restoredTab = (initial.tabs?.length ? initial.tabs : [DEFAULT_TAB]).find((tab) => tab.id === (initial.activeId || DEFAULT_TAB.id));
    return (restoredTab && TAB_NAV[restoredTab.type]) || (initial.toolView === "requirements" ? "requirements" : "project");
  });
  const [leftOpen, setLeftOpen] = useState(initial.leftOpen ?? true);
  const [rightOpen, setRightOpen] = useState(initial.rightOpen ?? true);
  const [rightView, setRightView] = useState<RightView>(initial.rightView || "properties");
  const [bottomOpen, setBottomOpen] = useState(initial.bottomOpen ?? false);
  const [bottomView, setBottomView] = useState<BottomView>(initial.bottomView || "problems");
  const [leftWidth, setLeftWidth] = useState(initial.leftWidth ?? 280);
  const [rightWidth, setRightWidth] = useState(initial.rightWidth ?? 300);
  const [bottomHeight, setBottomHeight] = useState(initial.bottomHeight ?? 185);
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [reportedContext, setReportedContext] = useState<{ tabId: string; data: RightContextData | null } | null>(null);
  const [pathContext, setPathContext] = useState<Record<string, { platformId: string; requirementId: string }>>({});
  const [showAbout, setShowAbout] = useState(false);
  const [changes, setChanges] = useState<FileChanges>(emptyFileChanges());
  const [requirementAccess, setRequirementAccess] = useState<Record<string, ClientAccess>>({});
  const [workspaceEvents, setWorkspaceEvents] = useState<WorkspaceEvent[]>([]);
  const [latestWorkspaceEvent, setLatestWorkspaceEvent] = useState<WorkspaceEvent | null>(null);
  const [watcherStatus, setWatcherStatus] = useState<"starting" | "active" | "disabled" | "error">("starting");
  const [watcherError, setWatcherError] = useState<string | null>(null);
  const [locatePath, setLocatePath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const watcherGeneration = useRef(0);
  const [menu, setMenu] = useState<string | null>(null);
  const [requirementModal, setRequirementModal] = useState<{ platformId?: string } | null>(null);
  const [requirementRevision, setRequirementRevision] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const toolTabsRef = useRef<HTMLDivElement>(null);
  const workspacePathRef = useRef(workspace.workspace.root_path);
  const autoOpenChangeCenterRef = useRef(false);
  const updateClientPreferences = useCallback((preferences: ClientPreferences) => {
    autoOpenChangeCenterRef.current = preferences.auto_open_change_center;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.loadClientPreferences().then((preferences) => { if (!cancelled) updateClientPreferences(preferences); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [updateClientPreferences]);

  const resetWorkspaceState = useCallback(() => {
    setTabs([DEFAULT_TAB]);
    setActiveId(DEFAULT_TAB.id);
    setClosedTabs([]);
    setActiveNav("project");
    setLeftOpen(true);
    setRightOpen(true);
    setRightView("properties");
    setBottomOpen(false);
    setBottomView("problems");
    setLeftWidth(280);
    setRightWidth(300);
    setBottomHeight(185);
    setReportedContext(null);
    setPathContext({});
    setShowAbout(false);
    setChanges(emptyFileChanges());
    setRequirementAccess({});
    setWorkspaceEvents([]);
    setLatestWorkspaceEvent(null);
    setWatcherStatus("starting");
    setWatcherError(null);
    setLocatePath(null);
    setMenu(null);
    setRequirementModal(null);
    setRequirementRevision(0);
  }, []);

  useEffect(() => {
    if (workspacePathRef.current === workspace.workspace.root_path) return;
    workspacePathRef.current = workspace.workspace.root_path;
    resetWorkspaceState();
  }, [resetWorkspaceState, workspace.workspace.root_path]);

  const updateRequirementAccess = useCallback((platformId: string, requirementId: string, access: ClientAccess) => {
    const key = requirementAccessKey(platformId, requirementId);
    setRequirementAccess((current) => ({ ...current, [key]: access }));
    const platform = workspace.platforms.find((item) => item.id === platformId);
    if (platform) {
      const dir = joinPath(workspace.workspace.root_path, platform.path, requirementId);
      setPathContext((current) => current[dir] ? current : { ...current, [dir]: { platformId, requirementId } });
    }
    setTabs((current) => current.map((tab) => tab.id === `requirement:${platformId}:${requirementId}`
      ? { ...tab, icon: access.mode === "locked_for_ai" ? "lock" : "box" }
      : tab));
  }, [workspace.platforms, workspace.workspace.root_path]);

  const handleUnlockPreview = useCallback((nextChanges: FileChanges) => {
    setChanges(nextChanges);
    setBottomView("changes");
    setBottomOpen(true);
  }, []);

  useEffect(() => {
    const rootPath = workspace.workspace.root_path;
    const generation = ++watcherGeneration.current;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const handleEvent = (event: WorkspaceEvent) => {
      const paths = [event.path, event.old_path].filter(Boolean) as string[];
      if (!paths.some((path) => isPathWithin(path, rootPath))) return;
      invalidateBusinessData(paths);
      setLatestWorkspaceEvent(event);
      setWorkspaceEvents((current) => [event, ...current].slice(0, 200));
      if (autoOpenChangeCenterRef.current) {
        setBottomView("changes");
        setBottomOpen(true);
      }
      if (paths.some((path) => path.split(/[\\/]/).pop() === "requirement.yaml")) {
        setRequirementRevision((current) => current + 1);
      }
      if (paths.some((path) => samePath(path, joinPath(rootPath, ".blackbox", "workspace.yaml")))) {
        void api.openWorkspace(rootPath).then((result) => {
          if (!disposed && result.initialized) onWorkspaceChange(result.config);
        }).catch((reason) => {
          if (!disposed) setWatcherError(`刷新工作区配置失败：${String(reason)}`);
        });
      }
    };

    const setup = async () => {
      try {
        if (isTauri) {
          try {
            const { listen } = await import("@tauri-apps/api/event");
            const listener = await listen<WorkspaceEvent>(WORKSPACE_EVENT, ({ payload }) => handleEvent(payload));
            if (disposed) {
              listener();
              return;
            }
            unlisten = listener;
          } catch (reason) {
            // 事件订阅失败不应阻止 Rust 侧监听器启动，单独提示便于定位权限问题
            console.warn("订阅工作区事件失败，文件变化中心将不可用。", reason);
            if (!disposed) setWatcherError(`订阅文件事件失败：${String(reason)}`);
          }
        }
        const enabled = await api.startWorkspaceWatcher(rootPath, generation);
        if (!disposed) {
          setWatcherStatus(enabled ? "active" : "disabled");
          if (enabled) setWatcherError(null);
        }
      } catch (reason) {
        if (!disposed) {
          setWatcherStatus("error");
          setWatcherError(String(reason));
        }
      }
    };

    void setup();
    return () => {
      disposed = true;
      unlisten?.();
      void api.stopWorkspaceWatcher(generation);
    };
  }, [onWorkspaceChange, workspace.workspace.root_path]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (key === "j") {
        event.preventDefault();
        setBottomOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const applyWorkspaceChange = useCallback((nextWorkspace: WorkspaceConfig) => {
    setTabs((current) => current.map((tab) => {
      const platform = tab.payload?.platformId
        ? nextWorkspace.platforms.find((item) => item.id === tab.payload?.platformId)
        : undefined;
      if (!platform) return tab;
      if (tab.type === "platform") return { ...tab, title: platform.name, subtitle: platform.path };
      if (tab.type === "requirement" || tab.type === "questions") return { ...tab, subtitle: `${platform.name} · ${tab.payload?.requirementId || tab.title}` };
      return tab;
    }));
    onWorkspaceChange(nextWorkspace);
  }, [onWorkspaceChange]);

  const toolView = NAV_TOOL_VIEW[activeNav];
  const activeTab = tabs.find((tab) => tab.id === activeId) || tabs[0] || DEFAULT_TAB;
  const activePlatform = activeTab.payload?.platformId ? workspace.platforms.find((item) => item.id === activeTab.payload?.platformId) : undefined;
  const activeAccess = useMemo(() => {
    if (activeTab.payload?.platformId && activeTab.payload.requirementId) {
      return requirementAccess[requirementAccessKey(activeTab.payload.platformId, activeTab.payload.requirementId)];
    }
    if (activeTab.payload?.path) return accessForPath(activeTab.payload.path, workspace, requirementAccess);
    return undefined;
  }, [activeTab, requirementAccess, workspace]);
  const activeDocumentReadOnly = activeAccess?.mode === "locked_for_ai";

  useEffect(() => {
    const platformId = activeTab.payload?.platformId;
    const requirementId = activeTab.payload?.requirementId;
    const platform = platformId ? workspace.platforms.find((item) => item.id === platformId) : undefined;
    if (!platform || !requirementId) return;
    let cancelled = false;
    void api.readRequirement(workspace.workspace.root_path, platform.path, requirementId)
      .then((meta) => { if (!cancelled) updateRequirementAccess(platform.id, requirementId, meta.client_access); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeTab.id, activeTab.payload?.platformId, activeTab.payload?.requirementId, updateRequirementAccess, workspace.platforms, workspace.workspace.root_path]);

  useEffect(() => {
    const session: SessionState = { workspacePath: workspace.workspace.root_path, tabs: tabs.filter((tab) => tab.id !== "home" || tab.pinned), activeId, activeNav, rightView, rightOpen, bottomView, bottomOpen, leftOpen, leftWidth, rightWidth, bottomHeight };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, [tabs, activeId, activeNav, rightView, rightOpen, bottomView, bottomOpen, leftOpen, leftWidth, rightWidth, bottomHeight, workspace.workspace.root_path]);

  // 跟踪窗口尺寸，拖拽后的面板宽度在窗口缩小时自动收敛，保证中间内容可用
  useEffect(() => {
    const onResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 左侧工具窗口Tab条：切换主导航（如AI任务）后把激活Tab滚到可视区中间，窄面板下不再被裁掉看不见
  useEffect(() => {
    centerActiveTab(toolTabsRef.current);
  }, [toolView, leftOpen]);

  const openRequirementModal = useCallback((platform?: PlatformInfo) => {
    setRequirementModal({ platformId: platform?.id });
  }, []);

  const hydratePathAccess = async (path: string) => {
    const platform = workspace.platforms.find((item) => isPathWithin(path, joinPath(workspace.workspace.root_path, item.path)));
    if (!platform) return;
    const requirements = await api.scanRequirements(workspace.workspace.root_path, platform.path).catch(() => []);
    const requirement = requirements.find((item) => isPathWithin(path, joinPath(workspace.workspace.root_path, platform.path, item.requirement.id)));
    if (requirement) updateRequirementAccess(platform.id, requirement.requirement.id, requirement.client_access);
  };

  // 文件路径 → 所属需求目录：由 updateRequirementAccess / hydratePathAccess 填充，
  // 供右侧上下文和关联任务推断文件的业务归属
  const locateRequirementForPath = useCallback((path: string): { platformId: string; requirementId: string } | undefined => {
    const normalized = normalizePath(path);
    let best: { platformId: string; requirementId: string } | undefined;
    let bestLength = -1;
    for (const [dir, context] of Object.entries(pathContext)) {
      const normalizedDir = normalizePath(dir);
      if ((normalized === normalizedDir || normalized.startsWith(`${normalizedDir}/`)) && normalizedDir.length > bestLength) {
        best = context;
        bestLength = normalizedDir.length;
      }
    }
    return best;
  }, [pathContext]);

  // 右侧上下文/脏标记上报：每个Tab一份稳定回调。视图把它们放进 useEffect 依赖里，
  // 内联箭头会让依赖每轮渲染都变化，造成「上报 → setState → 重渲染 → 再上报」的循环
  const tabCallbacks = useRef(new Map<string, { context: (data: RightContextData | null) => void; dirty: (dirty: boolean) => void }>());
  const callbacksForTab = (tabId: string) => {
    let entry = tabCallbacks.current.get(tabId);
    if (!entry) {
      entry = {
        context: (data: RightContextData | null) => setReportedContext({ tabId, data }),
        dirty: (dirty: boolean) => setTabDirty(tabId, dirty),
      };
      tabCallbacks.current.set(tabId, entry);
    }
    return entry;
  };

  const { tasks: workspaceTasks, loading: tasksLoading } = useWorkspaceTasks(workspace.workspace.root_path, latestWorkspaceEvent, requirementRevision);

  // BB-16E：首页“最近工作”数据 = 当前打开的Tab（倒序）+ 最近关闭的Tab，去重取前8
  const recentTabs = useMemo(() => {
    const seen = new Set<string>();
    const list: WorkbenchTab[] = [];
    for (const tab of [...tabs].reverse()) {
      if (tab.type === "home" || seen.has(tab.id)) continue;
      seen.add(tab.id);
      list.push(tab);
      if (list.length >= 8) break;
    }
    for (const tab of [...closedTabs].reverse()) {
      if (list.length >= 8) break;
      if (tab.type === "home" || seen.has(tab.id)) continue;
      seen.add(tab.id);
      list.push(tab);
    }
    return list;
  }, [tabs, closedTabs]);

  const openTaskTab = (task: AiTaskInfo) => openTab(aiTaskTab(task));

  const fallbackContext = useMemo<RightContextData>(() => buildFallbackContext(activeTab, workspace, locateRequirementForPath, activeDocumentReadOnly, changes), [activeTab, workspace, locateRequirementForPath, activeDocumentReadOnly, changes]);

  const rightContext = useMemo<RightContextData>(() => {
    const reported = reportedContext && reportedContext.tabId === activeTab.id ? reportedContext.data : null;
    return reported ? { ...fallbackContext, ...reported, platformId: reported.platformId ?? fallbackContext.platformId, requirementId: reported.requirementId ?? fallbackContext.requirementId, path: reported.path ?? fallbackContext.path, readOnly: reported.readOnly ?? fallbackContext.readOnly } : fallbackContext;
  }, [fallbackContext, reportedContext, activeTab.id]);

  // 面板尺寸按窗口收敛：主内容至少保留 340px 宽度
  const effectiveLeftWidth = Math.min(leftWidth, Math.max(180, windowSize.width - 58 - (rightOpen ? Math.min(rightWidth, 280) : 0) - 340));
  const effectiveRightWidth = Math.min(rightWidth, Math.max(200, windowSize.width - 58 - effectiveLeftWidth - 340));
  const effectiveBottomHeight = Math.min(bottomHeight, Math.max(120, windowSize.height - 300));

  const openTab = (input: WorkbenchTab) => {
    if (input.payload?.path) void hydratePathAccess(input.payload.path);
    const next = makeTab(input);
    setTabs((current) => {
      const existing = current.find((tab) => tab.id === next.id);
      if (existing) {
        invalidateBusinessData([workspace.workspace.root_path]);
        setActiveId(existing.id);
        return current.map((tab) => tab.id === next.id ? { ...tab, ...next, dirty: tab.dirty } : tab);
      }
      if (next.preview) {
        const previewIndex = current.findIndex((tab) => tab.preview && !tab.pinned && !tab.dirty);
        if (previewIndex >= 0) {
          const copy = [...current];
          copy[previewIndex] = next;
          setActiveId(next.id);
          return copy;
        }
      }
      setActiveId(next.id);
      return [...current, next];
    });
    if (["markdown", "docx", "excel", "xmind", "structured-cases", "case-export", "test-execution", "report-generation", "knowledge"].includes(next.type)) setRightView("outline");
    else if (next.type === "requirement" || next.type === "questions") setRightView("properties");
    const mapped = TAB_NAV[next.type];
    if (mapped) setActiveNav(mapped);
  };

  const openWorkspaceEvent = (event: WorkspaceEvent) => {
    if (event.is_directory || event.event_type === "remove") {
      setActiveNav("project");
      setLeftOpen(true);
      setLocatePath(event.path);
      return;
    }
    const fileName = event.path.split(/[\\/]/).pop() || event.path;
    const lower = fileName.toLowerCase();
    const type: "markdown" | "docx" | "excel" | "xmind" | null = /\.(md|txt|yaml|yml|json|py|toml|rs|csv|log)$/.test(lower)
      ? "markdown"
      : lower.endsWith(".docx")
        ? "docx"
        : lower.endsWith(".xlsx")
          ? "excel"
          : lower.endsWith(".xmind")
            ? "xmind"
            : null;
    if (!type) {
      void systemOpen.openFile(event.path);
      return;
    }
    openTab({
      id: `file:${event.path}`,
      type,
      title: fileName,
      subtitle: event.path,
      icon: type === "markdown" ? "markdown" : type === "xmind" ? "archiveFile" : type === "excel" ? "spreadsheet" : "file",
      preview: true,
      pinned: false,
      dirty: false,
      closable: true,
      payload: { path: event.path },
    });
  };

  // BB-16F：打开全局搜索结果中的文件——内置阅读器优先，未知类型交给系统打开
  const openFileSearchTarget = (result: WorkspaceSearchResult) => {
    const fileName = result.path.split(/[\\/]/).pop() || result.path;
    const lower = fileName.toLowerCase();
    const type: "markdown" | "docx" | "excel" | "xmind" | "image" | null = /\.(md|markdown|txt|yaml|yml|json|jsonl|py|toml|rs|csv|log)$/.test(lower)
      ? "markdown"
      : lower.endsWith(".docx")
        ? "docx"
        : /\.(xlsx|xls)$/.test(lower)
          ? "excel"
          : lower.endsWith(".xmind")
            ? "xmind"
            : /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)
              ? "image"
              : null;
    if (!type) {
      void systemOpen.openFile(result.path);
      return;
    }
    openTab({
      id: `file:${result.path}`,
      type,
      title: fileName,
      subtitle: result.path,
      icon: type === "markdown" ? "markdown" : type === "xmind" ? "archiveFile" : type === "excel" ? "spreadsheet" : type === "image" ? "image" : "file",
      preview: true,
      pinned: false,
      dirty: false,
      closable: true,
      payload: { path: result.path },
    });
    // 打开文件同时定位左侧项目树上下文
    setLeftOpen(true);
    setLocatePath(result.path);
  };

  // BB-16F：全局搜索结果 → 深链打开并定位对应工作台对象
  const openSearchResult = async (result: WorkspaceSearchResult) => {
    const missing = () => notify("error", `对象已不存在或已被移动：${result.title || result.path}`);
    try {
      const info = await api.getPathInfo(result.path);
      if (!info.exists) {
        missing();
        return;
      }
    } catch {
      // 存在性校验失败不阻断打开，由各视图兜底提示
    }
    const platform = result.platform_id ? workspace.platforms.find((item) => item.id === result.platform_id) : undefined;
    const requirementId = result.requirement_id || undefined;
    const focusKey = Date.now();

    if (result.result_type === "requirement") {
      if (!platform || !requirementId) { missing(); return; }
      const locked = requirementAccess[requirementAccessKey(platform.id, requirementId)]?.mode === "locked_for_ai";
      openTab({
        id: `requirement:${platform.id}:${requirementId}`,
        type: "requirement",
        title: requirementId,
        subtitle: result.subtitle || `${platform.name} · ${requirementId}`,
        icon: locked ? "lock" : "box",
        preview: false,
        pinned: true,
        dirty: false,
        closable: true,
        payload: { platformId: platform.id, platformPath: platform.path, requirementId },
      });
      return;
    }
    if (result.result_type === "case") {
      if (!platform || !requirementId) { missing(); return; }
      openTab({
        id: `cases:${platform.id}:${requirementId}`,
        type: "structured-cases",
        title: "结构化用例",
        subtitle: `${platform.name} · ${requirementId}`,
        icon: "checks",
        preview: false,
        pinned: true,
        dirty: false,
        closable: true,
        payload: { platformId: platform.id, platformPath: platform.path, requirementId, caseId: result.object_id || undefined, focusKey },
      });
      return;
    }
    if (result.result_type === "ai_task") {
      openTab(makeTab({
        id: "ai-tasks",
        type: "ai-task",
        title: "AI会话",
        subtitle: result.object_id || "任务详情",
        icon: "ai",
        preview: false,
        pinned: true,
        payload: { taskId: result.object_id || undefined, platformId: result.platform_id || undefined, requirementId, focusKey },
      }));
      return;
    }
    if (result.result_type === "run") {
      if (!platform || !requirementId) { missing(); return; }
      openTab({
        id: `test-execution:${platform.id}:${requirementId}`,
        type: "test-execution",
        title: "测试执行",
        subtitle: `${platform.name} · ${requirementId}`,
        icon: "test",
        preview: false,
        pinned: true,
        dirty: false,
        closable: true,
        payload: { platformId: platform.id, platformPath: platform.path, requirementId, runId: result.object_id || undefined, focusKey },
      });
      return;
    }
    if (result.result_type === "report") {
      const lower = result.path.toLowerCase();
      // 输出产物存在时直接打开文件；否则回到报告生成页查看记录
      if (/\.(md|markdown|docx)$/.test(lower)) {
        openFileSearchTarget(result);
        return;
      }
      if (!platform || !requirementId) { missing(); return; }
      openTab({
        id: `report-generation:${platform.id}:${requirementId}`,
        type: "report-generation",
        title: "测试报告",
        subtitle: `${platform.name} · ${requirementId}`,
        icon: "file",
        preview: false,
        pinned: true,
        dirty: false,
        closable: true,
        payload: { platformId: platform.id, platformPath: platform.path, requirementId },
      });
      return;
    }
    if (result.result_type === "knowledge") {
      const scope = result.scope || (requirementId ? "requirement" : platform ? "platform" : "general");
      const id = scope === "general"
        ? "knowledge"
        : scope === "platform"
          ? `knowledge:platform:${platform?.id || result.platform_id || ""}`
          : `knowledge:${platform?.id || result.platform_id || ""}:${requirementId || ""}`;
      openTab(makeTab({
        id,
        type: "knowledge",
        title: "知识库",
        subtitle: scope === "general" ? "通用知识" : scope === "platform" ? `${platform?.name || "平台"}平台知识` : `${platform?.name || ""} · ${requirementId || ""}`,
        icon: "database",
        preview: false,
        pinned: true,
        payload: { scope, platformId: platform?.id, platformPath: platform?.path, requirementId, knowledgeId: result.object_id || undefined, focusKey },
      }));
      return;
    }
    // file：目录定位到项目树，文件打开阅读器或系统打开
    if (result.is_directory) {
      setActiveNav("project");
      setLeftOpen(true);
      setLocatePath(result.path);
      return;
    }
    openFileSearchTarget(result);
  };

  const handleRequirementSaved = (requirement: RequirementMeta, platform: PlatformInfo) => {
    setRequirementModal(null);
    setRequirementRevision((current) => current + 1);
    openTab(requirementTab(platform, requirement));
  };

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (!nativeCloseAllowed.current && tabs.some((tab) => tab.dirty)) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [tabs]);

  const [draftConfirmation, setDraftConfirmation] = useState<{ ids: string[]; action: () => void } | null>(null);
  const [draftSaveError, setDraftSaveError] = useState("");
  const protectDrafts = (ids: string[], action: () => void) => {
    const dirtyIds = tabs.filter((tab) => ids.includes(tab.id) && tab.dirty).map((tab) => tab.id);
    if (!dirtyIds.length) { action(); return; }
    setDraftSaveError(""); setDraftConfirmation({ ids: dirtyIds, action });
  };
  const nativeCloseAllowed = useRef(false);
  const nativeCloseState = useRef({ tabs, protectDrafts });
  nativeCloseState.current = { tabs, protectDrafts };
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false; let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const off = await win.onCloseRequested((event) => {
        if (nativeCloseAllowed.current) return;
        const state = nativeCloseState.current;
        if (!state.tabs.some((tab) => tab.dirty)) return;
        event.preventDefault();
        state.protectDrafts(state.tabs.map((tab) => tab.id), () => { nativeCloseAllowed.current = true; void win.close(); });
      });
      if (disposed) off(); else unlisten = off;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const activateTab = (id: string) => {
    invalidateBusinessData([workspace.workspace.root_path]);
    const target = tabs.find((tab) => tab.id === id);
    const mapped = target ? TAB_NAV[target.type] : undefined;
    if (mapped) setActiveNav(mapped);
    setActiveId(id);
  };
  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    setTabs((current) => {
      const target = current.find((tab) => tab.id === id);
      return !target || target.dirty === dirty ? current : current.map((tab) => tab.id === id ? { ...tab, dirty } : tab);
    });
  }, []);

  const closeTab = (id: string) => {
    const target = tabs.find((tab) => tab.id === id);
    if (!target || !target.closable) return;
    protectDrafts([id], () => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const nextTabs = tabs.filter((tab) => tab.id !== id);
    setTabs(nextTabs.length ? nextTabs : [DEFAULT_TAB]);
    setClosedTabs((current) => [...current.slice(-9), { ...target, closedAt: Date.now() }]);
    if (activeId === id) setActiveId(nextTabs[Math.max(0, index - 1)]?.id || DEFAULT_TAB.id);
    });
  };

  const closeOthers = (id: string) => {
    const target = tabs.find((tab) => tab.id === id);
    if (!target) return;
    const keep = tabs.filter((tab) => tab.id === id || !tab.closable);
    const removed = tabs.filter((tab) => !keep.includes(tab) && tab.closable).map((tab) => ({ ...tab, closedAt: Date.now() }));
    protectDrafts(removed.map((tab) => tab.id), () => {
    setClosedTabs((current) => [...current, ...removed].slice(-10));
    setTabs(keep);
    setActiveId(id);
    });
  };

  // 关闭当前Tab左侧/右侧的Tab：不可关闭的Tab（工作区首页）保留，被关掉的激活Tab回退到当前Tab
  const closeTabsToSide = (id: string, side: "left" | "right") => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const removed = tabs
      .filter((tab, position) => (side === "left" ? position < index : position > index) && tab.closable)
      .map((tab) => ({ ...tab, closedAt: Date.now() }));
    if (!removed.length) return;
    protectDrafts(removed.map((tab) => tab.id), () => {
    const keep = tabs.filter((tab) => !removed.some((item) => item.id === tab.id));
    setClosedTabs((current) => [...current, ...removed].slice(-10));
    setTabs(keep);
    setActiveId(id);
    });
  };

  const closeAllTabs = () => {
    const removed = tabs.filter((tab) => tab.closable).map((tab) => ({ ...tab, closedAt: Date.now() }));
    if (!removed.length) return;
    protectDrafts(removed.map((tab) => tab.id), () => {
    const keep = tabs.filter((tab) => !removed.some((item) => item.id === tab.id));
    setClosedTabs((current) => [...current, ...removed].slice(-10));
    setTabs(keep.length ? keep : [DEFAULT_TAB]);
    if (removed.some((tab) => tab.id === activeId)) setActiveId(keep[0]?.id || DEFAULT_TAB.id);
    });
  };

  const pinTab = (id: string) => setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, pinned: !tab.pinned, preview: false } : tab));
  const restoreTab = () => {
    const target = closedTabs[closedTabs.length - 1];
    if (!target) return;
    const { closedAt: _closedAt, ...tab } = target;
    setClosedTabs((current) => current.slice(0, -1));
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  };

  const handleNav = (id: WorkbenchNav) => {
    setMenu(null);
    setActiveNav(id);
    if (NAV_TOOL_VIEW[id] !== "none") setLeftOpen(true);
    if (id === "home") {
      openTab(DEFAULT_TAB);
      return;
    }
    if (id === "project" || id === "requirements") return;
    if (id === "tasks") {
      openTab(makeTab({ id: "ai-tasks", type: "ai-task", title: "AI会话", subtitle: "对话、评审与测后复盘", icon: "ai", preview: false, pinned: true, payload:{platformId:rightContext.platformId,requirementId:rightContext.requirementId,path:rightContext.path ? rightContext.path.replace(/\\/g,"/").replace(workspace.workspace.root_path.replace(/\\/g,"/") + "/", "") : undefined,focusKey:Date.now()} }));
      return;
    }
    if (id === "settings") {
      openTab(makeTab({ id: "settings", type: "settings", title: "设置", icon: "settings", preview: false, pinned: true }));
      return;
    }
    if (id === "tests") {
      openTab(makeTab({ id: "tests", type: "test-assets", title: "测试用例", subtitle: "XMind与Excel测试资产", icon: "checks", preview: false, pinned: true }));
      return;
    }
    if (id === "execution") {
      openTab(makeTab({ id: "test-execution", type: "test-execution", title: "测试执行", subtitle: "轮次、结果与证据", icon: "test", preview: false, pinned: true }));
      return;
    }
    if (id === "api-debug") {
      openTab(makeTab({ id: "api-debug", type: "api-debug", title: "接口调试", subtitle: "请求、环境、签名、断言与执行证据", icon: "code", preview: false, pinned: true }));
      return;
    }
    if (id === "knowledge") {
      openTab(makeTab({ id: "knowledge", type: "knowledge", title: "知识库", subtitle: "候选审核、发布和检索", icon: "database", preview: false, pinned: true }));
    }
  };

  const openChangesTab = () => openTab({ id: "changes", type: "changes", title: "文件变更", subtitle: "锁定前后文件差异", icon: "activity", preview: false, pinned: true, dirty: false, closable: true });
  const openChangeCenter = () => { setBottomView("changes"); setBottomOpen(true); };
  const openWorkspacePath = async (rootPath: string) => {
    protectDrafts(tabs.map((tab) => tab.id), () => { void applyOpenWorkspacePath(rootPath); });
  };
  const applyOpenWorkspacePath = async (rootPath: string) => {
    try {
      const result = await api.openWorkspace(rootPath);
      if (!result.initialized) {
        onWorkspaceNeedsSetup(rootPath);
        return;
      }
      resetWorkspaceState();
      onWorkspaceChange(result.config);
      void api.rememberWorkspace(result.config);
      logClientAction(rootPath, { module: "工作台", action: "open-workspace", result: "成功", detail: result.config.workspace.name || rootPath });
    } catch (reason) {
      window.alert(`打开工作区失败：${String(reason)}`);
      logClientAction(rootPath, { module: "工作台", action: "open-workspace", result: "失败", detail: String(reason), level: "error" });
    }
  };
  const chooseWorkspace = async () => {
    const rootPath = await api.chooseDirectory();
    if (rootPath) await openWorkspacePath(rootPath);
  };

  const activeDocumentUpdated = Boolean(
    latestWorkspaceEvent
      && activeTab.payload?.path
      && workspaceEventMatchesPath(latestWorkspaceEvent, activeTab.payload.path),
  );

  // 按单个Tab计算平台与只读状态：所有打开的Tab都保持挂载（仅隐藏非活跃），
  // 不能用 activeTab/activeDocumentReadOnly，否则后台Tab会拿到别的Tab的锁定状态
  const platformForTab = (tab: WorkbenchTab) => tab.payload?.platformId
    ? workspace.platforms.find((item) => item.id === tab.payload?.platformId)
    : tab.payload?.platformPath
      ? workspace.platforms.find((item) => item.path === tab.payload?.platformPath)
      : undefined;
  const readOnlyForTab = (tab: WorkbenchTab) => {
    const access = tab.payload?.platformId && tab.payload.requirementId
      ? requirementAccess[requirementAccessKey(tab.payload.platformId, tab.payload.requirementId)]
      : tab.payload?.path ? accessForPath(tab.payload.path, workspace, requirementAccess) : undefined;
    return access?.mode === "locked_for_ai";
  };

  // 渲染指定Tab的内容；组件按 tab.id 保持稳定，切Tab时挂载状态不变，未保存内容不丢失
  const renderTabContent = (tab: WorkbenchTab) => {
    const { context: onRightContext, dirty: onTabDirty } = callbacksForTab(tab.id);
    const tabReadOnly = readOnlyForTab(tab);
    if (tab.type === "home") return <WorkspaceHomeView workspace={workspace} onOpenTab={openTab} onWorkspaceChange={applyWorkspaceChange} requirementRevision={requirementRevision} latestEvent={latestWorkspaceEvent} recentTabs={recentTabs} onNavigate={handleNav} onCreateRequirement={() => openRequirementModal()} onRightContext={onRightContext} />;
    if (tab.type === "platform") {
      const platform = platformForTab(tab);
      return platform ? <PlatformView platform={platform} workspace={workspace} onOpenTab={openTab} onWorkspaceChange={applyWorkspaceChange} onCreateRequirement={openRequirementModal} requirementRevision={requirementRevision} onRightContext={onRightContext} /> : <MissingView message="平台不存在或已被移动" />;
    }
    if (tab.type === "requirement") {
      const platform = platformForTab(tab);
      return platform && tab.payload?.requirementId ? <RequirementOverviewView rootPath={workspace.workspace.root_path} workspace={workspace} platform={platform} requirementId={tab.payload.requirementId} requirementRevision={requirementRevision} onOpenTab={openTab} onRequirementChanged={() => setRequirementRevision((current) => current + 1)} onAccessStateChange={updateRequirementAccess} onUnlockPreview={handleUnlockPreview} onRightContext={onRightContext} /> : <MissingView message="需求不存在或缺少平台信息" />;
    }
    if (tab.type === "markdown") return <MarkdownDocumentView path={tab.payload?.path} readOnly={tabReadOnly} initialMode={tab.payload?.focus === "edit" ? "edit" : undefined} onDirtyChange={onTabDirty} onRightContext={onRightContext} />;
    if (tab.type === "docx") return tab.payload?.path ? <DocxDocumentView path={tab.payload.path} onRightContext={onRightContext} /> : <MissingView message="DOCX文件路径不存在" />;
    if (tab.type === "excel") return tab.payload?.path ? <ExcelDocumentView path={tab.payload.path} onRightContext={onRightContext} /> : <MissingView message="Excel文件路径不存在" />;
    if (tab.type === "image") return tab.payload?.path ? <ImageDocumentView path={tab.payload.path} onRightContext={onRightContext} /> : <MissingView message="图片路径不存在" />;
    if (tab.type === "xmind") return tab.payload?.path ? <XMindDocumentView path={tab.payload.path} readOnly={tabReadOnly} onDirtyChange={onTabDirty} onRightContext={onRightContext} /> : <MissingView message="XMind文件路径不存在" />;
    if (tab.type === "test-assets") return <TestAssetsView workspace={workspace} onOpenTab={openTab} onRightContext={onRightContext} />;
    if (tab.type === "api-debug") return <ApiDebugView onDirtyChange={onTabDirty} />;
    if (tab.type === "case-export") return <TemplateExportView workspace={workspace} initialPlatformId={tab.payload?.platformId} initialRequirementId={tab.payload?.requirementId} readOnly={tabReadOnly} onRightContext={onRightContext} />;
    if (tab.type === "test-execution") return <TestExecutionView workspace={workspace} initialPlatformId={tab.payload?.platformId} initialRequirementId={tab.payload?.requirementId} initialRunId={tab.payload?.runId} focusKey={tab.payload?.focusKey} readOnly={tabReadOnly} onDirtyChange={onTabDirty} onRightContext={onRightContext} onOpenReport={(runId) => openTab({ id: `report-generation:${tab.payload?.platformId || ""}:${tab.payload?.requirementId || ""}`, type: "report-generation", title: "测试报告", subtitle: `${tab.payload?.requirementId || ""} · 报告模板与生成`, icon: "file", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: tab.payload?.platformId, platformPath: tab.payload?.platformPath, requirementId: tab.payload?.requirementId, runId } })} />;
    if (tab.type === "report-generation") return <ReportGenerationView onDirtyChange={onTabDirty} workspace={workspace} initialPlatformId={tab.payload?.platformId} initialRequirementId={tab.payload?.requirementId} initialRunId={tab.payload?.runId} readOnly={tabReadOnly} onRightContext={onRightContext} />;
    if (tab.type === "knowledge") return <KnowledgeView workspace={workspace} initialPlatformId={tab.payload?.platformId} initialRequirementId={tab.payload?.requirementId} initialScope={tab.payload?.scope} initialKnowledgeId={tab.payload?.knowledgeId} focusKey={tab.payload?.focusKey} onRightContext={onRightContext} />;
    if (tab.type === "requirement-folder") {
      const platform = platformForTab(tab);
      return platform && tab.payload?.requirementId && tab.payload?.folder
        ? <RequirementFolderView key={tab.id} rootPath={workspace.workspace.root_path} platformPath={platform.path} requirementId={tab.payload.requirementId} folder={tab.payload.folder} readOnly={tabReadOnly} latestWorkspaceEvent={latestWorkspaceEvent} onOpenTab={openTab} onRightContext={onRightContext} />
        : <MissingView message="目录信息不完整，请从需求树重新打开" />;
    }
    if (tab.type === "structured-cases") {
      const platform = platformForTab(tab);
      return platform && tab.payload?.requirementId
        ? <StructuredCasesView rootPath={workspace.workspace.root_path} workspace={workspace} platform={platform} requirementId={tab.payload.requirementId} readOnly={tabReadOnly} focus={tab.payload?.focus} focusKey={tab.payload?.focusKey} caseId={tab.payload?.caseId} onDirtyChange={onTabDirty} onRightContext={onRightContext} onOpenExport={() => openTab({ id: `case-export:${platform.id}:${tab.payload?.requirementId}`, type: "case-export", title: "模板与导出", subtitle: `${platform.name} · ${tab.payload?.requirementId}`, icon: "tools", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId: tab.payload?.requirementId } })} />
        : <MissingView message="结构化用例缺少平台或需求信息" />;
    }
    if (tab.type === "questions") {
      const platform = platformForTab(tab);
      return platform && tab.payload?.requirementId ? <QuestionsWorkspaceView onDirtyChange={onTabDirty} rootPath={workspace.workspace.root_path} platform={platform} requirementId={tab.payload.requirementId} readOnly={tabReadOnly} onRightContext={onRightContext} /> : <MissingView message="疑问所在需求不存在" />;
    }
    if (tab.type === "coverage") {
      const platform = platformForTab(tab);
      return platform && tab.payload?.requirementId ? <CoverageView rootPath={workspace.workspace.root_path} platform={platform} requirementId={tab.payload.requirementId} readOnly={tabReadOnly} onDirtyChange={onTabDirty} onRightContext={onRightContext} /> : <MissingView message="覆盖追溯所在需求不存在" />;
    }
    if (tab.type === "changes") return <ChangesView changes={changes} />;
    if (tab.type === "ai-task") return <AiTaskWorkspace workspace={workspace} onRightContext={onRightContext} initialTaskId={tab.payload?.taskId} initialPlatformId={tab.payload?.platformId} initialRequirementId={tab.payload?.requirementId} initialPath={tab.payload?.path} focusKey={tab.payload?.focusKey} onTaskCreated={(task) => {
      setRequirementRevision((current) => current + 1);
      const platform = workspace.platforms.find((item) => item.id === task.platform_id);
      if (platform) {
        void api.readRequirement(workspace.workspace.root_path, platform.path, task.requirement_id)
          .then((meta) => updateRequirementAccess(platform.id, task.requirement_id, meta.client_access))
          .catch(() => undefined);
      }
    }} />;
    if (tab.type === "settings") return <SettingsView workspace={workspace} onWorkspaceChange={onWorkspaceChange} onOpenWorkspace={(path) => void openWorkspacePath(path)} onRightContext={onRightContext} onClientPreferencesChange={updateClientPreferences} />;
    return <EmptyWorkView icon="settings" title="设置" detail="工作区、解析器、模板和安全设置将在这里管理。" />;
  };

  useEffect(() => {
    const open = () => openTab(makeTab({id:"ai-tasks",type:"ai-task",title:"AI会话",icon:"ai",preview:false,pinned:true,payload:{focusKey:Date.now()}}));
    window.addEventListener("baize-open-ai-session",open);
    return () => window.removeEventListener("baize-open-ai-session",open);
  }, [workspace.workspace.root_path]);

  const handleMenuCommand = (command: string) => {
    setMenu(null);
    if (command === "open-project") void chooseWorkspace();
    if (command === "refresh") invalidateBusinessData([workspace.workspace.root_path]);
    if (command === "toggle-bottom") setBottomOpen((value) => !value);
    if (command === "toggle-right") setRightOpen((value) => !value);
    if (command === "restore") restoreTab();
    if (command === "close-active") closeTab(activeId);
    if (command === "search") setSearchOpen(true);
    if (command === "requirements") handleNav("requirements");
    if (command === "tests") handleNav("tests");
    if (command === "execution") handleNav("execution");
    if (command === "api-debug") handleNav("api-debug");
    if (command === "knowledge") handleNav("knowledge");
    if (command === "tasks") handleNav("tasks");
    if (command === "reset-layout") { setActiveNav("project"); setLeftOpen(true); setRightOpen(true); setBottomOpen(false); setLeftWidth(280); setRightWidth(300); setBottomHeight(185); }
    if (command === "open-logs") { setBottomView("logs"); setBottomOpen(true); }
    if (command === "about") setShowAbout(true);
  };

  return (
    <div className="ide-shell" onClick={() => menu && setMenu(null)}>
      <TopMenu menu={menu} onMenu={setMenu} onCommand={handleMenuCommand} />
      <div className="command-toolbar">
        <div className="toolbar-group"><button className="toolbar-button" onClick={() => handleMenuCommand("open-project")} title="打开工作区"><AppIcon name="folderOpen" size={15} /><span>打开</span></button><button className="toolbar-button" onClick={() => openRequirementModal()} title="新建需求"><AppIcon name="add" size={15} /><span>需求</span></button><button className="toolbar-button" onClick={() => openTab(DEFAULT_TAB)} title="回到首页"><AppIcon name="dashboard" size={15} /></button><button className="toolbar-button" onClick={() => handleMenuCommand("refresh")} title="刷新"><AppIcon name="refresh" size={15} /></button></div>
        <div className="breadcrumb"><span>{workspace.workspace.name || "工作区"}</span><AppIcon name="next" size={13} /><span>{activePlatform?.name || "全部项目"}</span><AppIcon name="next" size={13} /><strong>{activeTab.title}</strong></div>
        <div className="toolbar-search" onMouseDown={(event) => { event.preventDefault(); setSearchOpen(true); }} title={isMacPlatform ? "全局搜索（⌘K）" : "全局搜索（Ctrl+K）"}><AppIcon name="search" size={15} /><input ref={searchRef} readOnly placeholder={isMacPlatform ? "搜索工作区（⌘K）" : "搜索工作区（Ctrl+K）"} /><span className="shortcut">{isMacPlatform ? "⌘K" : "Ctrl K"}</span></div>
        <div className="toolbar-group"><button className="toolbar-button" onClick={() => handleNav("tasks")} title="AI会话"><AppIcon name="ai" size={15} /></button><button className="toolbar-button" onClick={() => setRightOpen((value) => !value)} title="右侧工具窗口"><AppIcon name="rightPanel" size={15} /></button><button className="toolbar-button" onClick={() => handleNav("settings")} title="设置"><AppIcon name="settings" size={15} /></button></div>
      </div>
      <div className="ide-main">
        <nav className="main-nav" aria-label="主导航">{navItems.map((item) => <button key={item.id} className={`main-nav-item ${item.id === activeNav ? "active" : ""}`} onClick={() => handleNav(item.id)} title={item.label}><AppIcon name={item.icon} size={19} /><span>{item.label}</span></button>)}<div className="nav-spacer" /><button className={`main-nav-item ${activeNav === "settings" ? "active" : ""}`} onClick={() => handleNav("settings")} title="设置"><AppIcon name="settings" size={19} /><span>设置</span></button></nav>
        {leftOpen && toolView !== "none" && <aside className="left-tool-window" style={{ width: effectiveLeftWidth, flexBasis: effectiveLeftWidth }}><div className="tool-window-tabs" ref={toolTabsRef}>{TOOL_VIEW_TABS.map((item) => <button key={item.id} className={toolView === item.id ? "active" : ""} onClick={() => setActiveNav(item.nav)} title={item.label}><AppIcon name={item.icon} size={14} /> {item.label}</button>)}<button className="icon-button" onClick={() => setLeftOpen(false)} title="隐藏左侧工具窗口"><AppIcon name="leftPanel" size={14} /></button></div>{toolView === "project" || toolView === "requirements" ? <ProjectToolWindow workspace={workspace} mode={toolView} onOpenTab={openTab} onCreateRequirement={openRequirementModal} requirementRevision={requirementRevision} latestWorkspaceEvent={latestWorkspaceEvent} locatePath={locatePath} onLocateHandled={() => setLocatePath(null)} onRequirementAccessChange={updateRequirementAccess} /> : toolView === "tests" ? <TestToolWindow workspace={workspace} onOpenTab={openTab} requirementRevision={requirementRevision} latestWorkspaceEvent={latestWorkspaceEvent} /> : toolView === "execution" ? <ExecutionToolWindow workspace={workspace} onOpenTab={openTab} requirementRevision={requirementRevision} latestWorkspaceEvent={latestWorkspaceEvent} /> : toolView === "knowledge" ? <KnowledgeToolWindow workspace={workspace} onOpenTab={openTab} requirementRevision={requirementRevision} latestWorkspaceEvent={latestWorkspaceEvent} /> : <AiTaskToolWindow workspace={workspace} onOpenTab={openTab} requirementRevision={requirementRevision} latestWorkspaceEvent={latestWorkspaceEvent} />}</aside>}
        {leftOpen && toolView !== "none" && <PanelResizer orientation="vertical" onDelta={(delta) => setLeftWidth((width) => clampPanel(width + delta, 180, Math.max(200, windowSize.width - 58 - 200 - 340)))} />}
        <main className="editor-workspace"><WorkbenchTabs tabs={tabs} activeId={activeTab.id} onActivate={activateTab} onClose={closeTab} onPin={pinTab} onCloseOthers={closeOthers} onCloseToLeft={(id) => closeTabsToSide(id, "left")} onCloseToRight={(id) => closeTabsToSide(id, "right")} onCloseAll={closeAllTabs} onRestore={restoreTab} canRestore={closedTabs.length > 0} /><div className="editor-content">{activeDocumentUpdated && <div className={`workspace-event-notice ${activeTab.dirty ? "warning" : ""}`}><AppIcon name="alert" size={15} /><span>磁盘内容已更新{activeTab.dirty ? "，当前未保存修改未被覆盖" : "，请使用文档工具栏重新载入"}。</span></div>}{tabs.map((tab) => <div key={tab.id} className="editor-pane" hidden={tab.id !== activeTab.id}><Suspense fallback={<div className="center-state"><span className="spinner" />正在加载文档阅读器…</div>}><DraftScope.Provider value={tab.id}>{renderTabContent(tab)}</DraftScope.Provider></Suspense></div>)}</div></main>
        {rightOpen && <PanelResizer orientation="vertical" onDelta={(delta) => setRightWidth((width) => clampPanel(width - delta, 200, Math.max(220, windowSize.width - 58 - 180 - 340)))} />}
        {rightOpen && <aside className="right-tool-window" style={{ width: effectiveRightWidth, flexBasis: effectiveRightWidth }}><div className="tool-window-tabs right-tabs"><button className={rightView === "outline" ? "active" : ""} onClick={() => setRightView("outline")}><AppIcon name="list" size={14} /> 大纲</button><button className={rightView === "properties" ? "active" : ""} onClick={() => setRightView("properties")}><AppIcon name="settings" size={14} /> 属性</button><button className={rightView === "task" ? "active" : ""} onClick={() => setRightView("task")}><AppIcon name="ai" size={14} /> 会话</button><button className="icon-button" onClick={() => setRightOpen(false)} title="隐藏右侧工具窗口"><AppIcon name="rightPanel" size={14} /></button></div><RightToolWindow view={rightView} workspace={workspace} context={rightContext} tasks={workspaceTasks} tasksLoading={tasksLoading} onOpenTask={openTaskTab} /></aside>}
      </div>
      {bottomOpen && <PanelResizer orientation="horizontal" onDelta={(delta) => setBottomHeight((height) => clampPanel(height - delta, 110, Math.max(160, windowSize.height - 320)))} />}
      {bottomOpen && <div className="bottom-tool-window" style={{ height: effectiveBottomHeight, flexBasis: effectiveBottomHeight }}><div className="bottom-tool-tabs"><button className={bottomView === "problems" ? "active" : ""} onClick={() => setBottomView("problems")}><AppIcon name="alert" size={14} /> 问题</button><button className={bottomView === "tasks" ? "active" : ""} onClick={() => setBottomView("tasks")}><AppIcon name="ai" size={14} /> AI会话</button><button className={bottomView === "changes" ? "active" : ""} onClick={() => setBottomView("changes")}><AppIcon name="activity" size={14} /> 文件变更{workspaceEvents.length > 0 && <b>{workspaceEvents.length}</b>}</button><button className={bottomView === "logs" ? "active" : ""} onClick={() => setBottomView("logs")}><AppIcon name="terminal" size={14} /> 运行日志</button><button className="icon-button" onClick={() => setBottomOpen(false)} title="隐藏底部工具窗口"><AppIcon name="bottom" size={14} /></button></div><BottomToolWindow view={bottomView} changes={changes} events={workspaceEvents} tasks={workspaceTasks} tasksLoading={tasksLoading} watcherError={watcherError} rootPath={workspace.workspace.root_path} onOpenChanges={openChangesTab} onOpenEvent={openWorkspaceEvent} onOpenTask={openTaskTab} /></div>}
      <footer className="status-bar"><div><span className="status-item"><span className="status-dot status-dot-success" />工作区正常</span><span className="status-item mono" title={workspace.workspace.root_path}>{workspace.workspace.root_path}</span></div><div><span className="status-item">{activePlatform?.name || "未选择平台"}</span><span className="status-item">{activeTab.title}</span>{activeDocumentReadOnly && <span className="status-item status-warning" title={activeAccess?.note || undefined}><AppIcon name="lock" size={12} />目录锁定{activeAccess?.task_id ? ` · ${activeAccess.task_id}` : ""}</span>}<span className={`status-item ${watcherStatus === "error" ? "status-error" : watcherStatus === "active" ? "status-success" : ""}`} title={watcherError || undefined}>{watcherStatus === "active" ? "文件监听正常" : watcherStatus === "starting" ? "正在启动监听" : watcherStatus === "disabled" ? "文件监听未启用" : "文件监听异常"}</span><button className="status-item status-item-action" type="button" onClick={openChangeCenter} title="打开文件变化中心"><AppIcon name="activity" size={12} />变化中心{workspaceEvents.length > 0 && <b>{workspaceEvents.length}</b>}</button><span className="status-item">UTF-8</span><span className="status-item">{formatDateTime(new Date())}</span></div></footer>
      {requirementModal && <RequirementManagementModal workspace={workspace} platform={requirementModal.platformId ? workspace.platforms.find((item) => item.id === requirementModal.platformId) : undefined} onClose={() => setRequirementModal(null)} onSaved={handleRequirementSaved} />}
      {searchOpen && <GlobalSearchPanel workspace={workspace} contextPlatformId={activeTab.payload?.platformId} contextRequirementId={activeTab.payload?.requirementId} recentTabs={recentTabs} onOpenResult={(result) => void openSearchResult(result)} onOpenTab={openTab} onClose={() => setSearchOpen(false)} />}
      {draftConfirmation && <div className="modal-backdrop draft-confirmation-backdrop"><div className="modal" role="alertdialog" aria-label="有未保存的草稿"><h2>有未保存的草稿</h2><p>保存后继续、明确放弃，或取消并保留页面。</p>{draftSaveError && <p role="alert">{draftSaveError}</p>}<div className="modal-actions"><button className="button button-ghost" onClick={() => setDraftConfirmation(null)}>取消</button><button className="button button-ghost" onClick={() => { const action = draftConfirmation.action; setDraftConfirmation(null); action(); }}>放弃草稿并继续</button><button className="button button-primary" onClick={async () => { try { if (!await saveDirtyTabs(draftConfirmation.ids)) { setDraftSaveError("未能完成保存，请查看页面提示；草稿和页面仍保留。用例对话框请先在框内保存。"); return; } const action = draftConfirmation.action; setDraftConfirmation(null); action(); } catch (error) { setDraftSaveError(String(error)); } }}>保存并继续</button></div></div></div>}
      {showAbout && <AboutDialog workspace={workspace} onClose={() => setShowAbout(false)} />}
    </div>
  );
}

function clampPanel(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** 面板拖拽手柄：按住后跟随指针调整相邻面板尺寸 */
function PanelResizer({ orientation, onDelta }: { orientation: "vertical" | "horizontal"; onDelta: (delta: number) => void }) {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = orientation === "vertical" ? event.clientX : event.clientY;
    const onMove = (move: PointerEvent) => onDelta((orientation === "vertical" ? move.clientX : move.clientY) - start);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing-panels");
    };
    document.body.classList.add("resizing-panels");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return <div className={`panel-resizer panel-resizer-${orientation}`} onPointerDown={startDrag} role="separator" aria-orientation={orientation === "vertical" ? "vertical" : "horizontal"} />;
}

// 右侧上下文的默认推导：视图未上报时按Tab负载给出基本对象信息
function buildFallbackContext(tab: WorkbenchTab, workspace: WorkspaceConfig, locate: (path: string) => { platformId: string; requirementId: string } | undefined, readOnly: boolean, changes: FileChanges): RightContextData {
  const typeMap: Record<string, string> = {
    home: "home", platform: "platform", requirement: "requirement", questions: "requirement",
    markdown: "markdown", docx: "file", excel: "file", image: "file", xmind: "file",
    "test-assets": "cases", "structured-cases": "cases", "case-export": "cases",
    "test-execution": "run", "report-generation": "report", knowledge: "knowledge",
    "requirement-folder": "folder", changes: "generic", "ai-task": "task", settings: "settings",
  };
  let platformId = tab.payload?.platformId;
  let requirementId = tab.payload?.requirementId;
  if (tab.payload?.path && (!platformId || !requirementId)) {
    const located = locate(tab.payload.path);
    platformId = platformId || located?.platformId;
    requirementId = requirementId || located?.requirementId;
  }
  const base: RightContextData = {
    objectType: typeMap[tab.type] || "generic",
    objectId: requirementId || tab.payload?.taskId || tab.payload?.runId,
    title: tab.title,
    subtitle: tab.subtitle,
    path: tab.payload?.path,
    platformId,
    requirementId,
    readOnly,
  };
  if (tab.type === "changes") {
    base.outlineTitle = "变更分组";
    base.outline = [
      { id: "added", label: "新增", badge: String(changes.added.length), icon: "add" },
      { id: "modified", label: "修改", badge: String(changes.modified.length), icon: "edit" },
      { id: "deleted", label: "删除", badge: String(changes.deleted.length), icon: "error" },
      { id: "moved", label: "移动", badge: String(changes.moved.length), icon: "next" },
    ];
    base.stats = [{ label: "文件变化总数", value: String(changes.total) }];
  }
  return base;
}

/** 关于对话框：品牌、版本、协议与工作区信息 */
function AboutDialog({ workspace, onClose }: { workspace: WorkspaceConfig; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal about-dialog">
        <div className="modal-header"><div><span className="eyebrow">关于</span></div><button className="icon-button" onClick={onClose} title="关闭"><AppIcon name="close" size={16} /></button></div>
        <div className="about-dialog-body">
          <img className="about-dialog-logo" src={logoBaize} alt={APP_NAME} />
          <p>本地优先的需求、用例和测试协作工作台。业务数据保存在工作区文件中，支持外部 AI 通过标准任务包协作。</p>
          <div className="detail-list">
            <div className="detail-row"><span>客户端版本</span><strong>{APP_VERSION}</strong></div>
            <div className="detail-row"><span>工作区协议</span><strong>{workspace.version}</strong></div>
            <div className="detail-row"><span>当前工作区</span><strong title={workspace.workspace.root_path}>{workspace.workspace.name || workspace.workspace.root_path}</strong></div>
            <div className="detail-row"><span>运行环境</span><strong>{isTauri ? (isMacPlatform ? "macOS 桌面客户端" : "Windows 桌面客户端") : "浏览器开发模式"}</strong></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function requirementTab(platform: PlatformInfo, requirement: RequirementMeta): WorkbenchTab {
  return {
    id: `requirement:${platform.id}:${requirement.requirement.id}`,
    type: "requirement",
    title: requirement.requirement.id,
    subtitle: `${platform.name} · ${requirement.requirement.name}`,
    icon: requirement.client_access.mode === "locked_for_ai" ? "lock" : "box",
    preview: false,
    pinned: true,
    dirty: false,
    closable: true,
    payload: { platformId: platform.id, platformPath: platform.path, requirementId: requirement.requirement.id },
  };
}

interface MenuItem {
  label: string;
  command?: string;
  /** 未实现功能：禁用并说明原因，不伪装为可执行 */
  disabled?: boolean;
  note?: string;
}

function TopMenu({ menu, onMenu, onCommand }: { menu: string | null; onMenu: (menu: string | null) => void; onCommand: (command: string) => void }) {
  const menus: Record<string, MenuItem[]> = {
    文件: [{ label: "打开工作区", command: "open-project" }, { label: "刷新", command: "refresh" }, { label: "关闭Tab", command: "close-active" }],
    编辑: [{ label: "全局搜索", command: "search" }, { label: "恢复关闭的Tab", command: "restore" }],
    视图: [{ label: "切换底部工具窗口", command: "toggle-bottom" }, { label: "切换右侧工具窗口", command: "toggle-right" }, { label: "重置布局", command: "reset-layout" }],
    需求: [{ label: "需求工具窗口", command: "requirements" }, { label: "重建索引", disabled: true, note: "未启用" }],
    测试: [{ label: "测试用例工具窗口", command: "tests" }, { label: "执行与报告工具窗口", command: "execution" }, { label: "接口调试", command: "api-debug" }],
    知识: [{ label: "知识库工具窗口", command: "knowledge" }],
    AI会话: [{ label: "打开AI会话窗口", command: "tasks" }],
    工具: [{ label: "重建索引", disabled: true, note: "未启用" }, { label: "查看日志", command: "open-logs" }],
    帮助: [{ label: `关于${APP_NAME}`, command: "about" }],
  };
  return (
    <header className="ide-menubar">
      <div className="product-mark"><img className="brand-logo" src={logoBaize} alt={APP_NAME} title={APP_NAME} /></div>
      {Object.entries(menus).map(([key, items]) => (
        <div className="menu-wrap" key={key}>
          <button className={`menu-button ${menu === key ? "active" : ""}`} onClick={(event) => { event.stopPropagation(); onMenu(menu === key ? null : key); }}>{key}</button>
          {menu === key && (
            <div className="menu-dropdown">
              {items.map((item, index) => (
                <button key={index} onClick={() => item.command && !item.disabled && onCommand(item.command)} disabled={item.disabled || !item.command} title={item.disabled ? "该功能尚未启用" : undefined}>
                  {item.label}
                  {item.note && <span>{item.note}</span>}
                  {item.command === "toggle-bottom" && <span>{isMacPlatform ? "⌘J" : "Ctrl J"}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="menubar-spacer" />
      <span className="menubar-workspace">本地工作区</span>
    </header>
  );
}

function MissingView({ message }: { message: string }) { return <div className="center-state"><AppIcon name="alert" size={24} /><strong>{message}</strong><span>请刷新工作区或从左侧项目树重新打开。</span></div>; }
function EmptyWorkView({ icon, title, detail }: { icon: IconName; title: string; detail: string }) { return <div className="center-state"><AppIcon name={icon} size={30} /><h1>{title}</h1><span>{detail}</span></div>; }
function ChangesView({ changes }: { changes: FileChanges }) { return <div className="workspace-view"><section className="document-header"><div className="document-title-row"><span className="document-icon blue"><AppIcon name="activity" size={20} /></span><div><div className="eyebrow">工作区工具</div><h1>文件变更</h1><p>需求目录锁定前后的文件差异</p></div></div></section><section className="panel-section"><div className="section-heading"><div><AppIcon name="activity" size={16} /><h2>变更摘要</h2></div><span className="section-muted">{changes.total} 个文件</span></div>{changes.total ? <div className="change-detail-list">{[...changes.added.map((path) => ({ path, type: "新增", className: "added" })), ...changes.modified.map((path) => ({ path, type: "修改", className: "modified" })), ...changes.deleted.map((path) => ({ path, type: "删除", className: "deleted" })), ...changes.moved.map((item) => ({ path: `${item.from} → ${item.to}`, type: "移动", className: "moved" }))].map((item) => <div className="change-detail-row" key={`${item.type}-${item.path}`}><span className={`change-type ${item.className}`}>{item.type}</span><span className="mono">{item.path}</span></div>)}</div> : <div className="inline-empty large"><AppIcon name="check" size={18} />当前没有待确认文件变化</div>}</section></div>; }

function readSession(rootPath: string): SessionState {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "{}") as SessionState;
    if (!session.workspacePath || normalizeSessionPath(session.workspacePath) !== normalizeSessionPath(rootPath)) return {};
    // 旧版会话迁移：执行概览Tab id 由 reports 更名为 test-execution，避免重复Tab
    if (Array.isArray(session.tabs)) {
      const seen = new Set<string>();
      session.tabs = session.tabs
        .map((tab) => (tab.id === "reports" ? { ...tab, id: "test-execution" } : tab))
        .filter((tab) => {
          if (seen.has(tab.id)) return false;
          seen.add(tab.id);
          return true;
        });
      if (session.activeId === "reports") session.activeId = "test-execution";
    }
    return session;
  } catch {
    return {};
  }
}

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

function workspaceEventMatchesPath(event: WorkspaceEvent, path: string): boolean {
  return samePath(event.path, path) || Boolean(event.old_path && samePath(event.old_path, path));
}

function emptyFileChanges(): FileChanges {
  return { added: [], modified: [], deleted: [], moved: [], total: 0 };
}

function requirementAccessKey(platformId: string, requirementId: string): string {
  return `${platformId}::${requirementId}`;
}

function accessForPath(path: string, workspace: WorkspaceConfig, accessMap: Record<string, ClientAccess>): ClientAccess | undefined {
  for (const [key, access] of Object.entries(accessMap)) {
    const separator = key.indexOf("::");
    if (separator < 0) continue;
    const platform = workspace.platforms.find((item) => item.id === key.slice(0, separator));
    if (!platform) continue;
    const requirementPath = joinPath(workspace.workspace.root_path, platform.path, key.slice(separator + 2));
    if (isPathWithin(path, requirementPath)) return access;
  }
  return undefined;
}

function normalizeSessionPath(path: string): string {
  return normalizePath(path);
}
