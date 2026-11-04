import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, isTauri } from "./lib/api";
import iconBaize from "./assets/icon-baize.png";
import type { RecentWorkspace, WorkspaceConfig, WorkspaceOpenResult } from "./lib/types";
import WorkbenchShell from "./components/WorkbenchShell";
import ToastHost from "./components/ToastHost";
import WorkspaceStartupView from "./views/WorkspaceStartupView";

export const WorkspaceContext = createContext<{
  workspace: WorkspaceConfig;
  setWorkspace: (workspace: WorkspaceConfig) => void;
} | null>(null);

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/$/.test(normalized) || normalized === "/") return normalized;
  return normalized.replace(/\/+$/g, "");
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function pathName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || "工作区";
}

function withMetadata(result: WorkspaceOpenResult): WorkspaceOpenResult {
  return {
    ...result,
    config: {
      ...result.config,
      legacy_directories: result.legacy_directories,
    },
  };
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [startupReady, setStartupReady] = useState(false);
  const [startupLoading, setStartupLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedResult, setSelectedResult] = useState<WorkspaceOpenResult | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");

  const activateWorkspace = useCallback(async (rawResult: WorkspaceOpenResult) => {
    const result = withMetadata(rawResult);
    if (!result.initialized) return;
    setWorkspace(result.config);
    setSelectedResult(null);
    setStartupError(null);
    setStartupLoading(false);
    await api.rememberWorkspace(result.config);
  }, []);

  const updateRecentStatus = useCallback((path: string, result: WorkspaceOpenResult | null) => {
    setRecent((current) => current.map((item) => samePath(item.path, path)
      ? { ...item, available: result !== null, initialized: result?.initialized ?? false, name: result?.config.workspace.name || item.name }
      : item));
  }, []);

  const inspectWorkspace = useCallback(async (path: string, openIfReady = false) => {
    const trimmedPath = path.trim();
    if (!trimmedPath) return;
    setStartupLoading(true);
    setStartupError(null);
    setSelectedPath(trimmedPath);
    setSelectedResult(null);
    let activated = false;
    try {
      const result = withMetadata(await api.openWorkspace(trimmedPath));
      setSelectedResult(result);
      setWorkspaceName(result.config.workspace.name || pathName(trimmedPath));
      updateRecentStatus(trimmedPath, result);
      if (openIfReady && result.initialized) {
        await activateWorkspace(result);
        activated = true;
        return;
      }
      if (!result.initialized) setWorkspaceName(pathName(trimmedPath));
    } catch (reason) {
      updateRecentStatus(trimmedPath, null);
      setStartupError(String(reason));
    } finally {
      if (!activated) setStartupLoading(false);
    }
  }, [activateWorkspace, updateRecentStatus]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      try {
        const session = await api.loadWorkspaceSession();
        const lastRecord = session.last_workspace
          ? session.recent_workspaces.find((item) => samePath(item.path, session.last_workspace || "")) || { path: session.last_workspace, name: pathName(session.last_workspace), last_opened_at: "" }
          : null;
        const knownRecords = [
          ...(lastRecord ? [lastRecord] : []),
          ...session.recent_workspaces.filter((item) => !lastRecord || !samePath(item.path, lastRecord.path)),
        ];
        const checked = await Promise.all(knownRecords.map(async (record) => {
          try {
            const result = withMetadata(await api.openWorkspace(record.path));
            return { record: { ...record, available: true, initialized: result.initialized, name: result.config.workspace.name || record.name }, result };
          } catch {
            return { record: { ...record, available: false, initialized: false }, result: null };
          }
        }));
        if (cancelled) return;

        setRecent(checked.map((item) => item.record));
        const autoOpen = checked.find((item) => item.result?.initialized);
        if (autoOpen?.result) {
          await activateWorkspace(autoOpen.result);
          return;
        }

        const selected = checked.find((item) => session.last_workspace && samePath(item.record.path, session.last_workspace)) || checked[0];
        if (selected) {
          setSelectedPath(selected.record.path);
          setWorkspaceName(selected.result?.config.workspace.name || selected.record.name || pathName(selected.record.path));
          setSelectedResult(selected.result);
        }
      } catch (reason) {
        if (!cancelled) setStartupError(`读取最近工作区失败：${String(reason)}`);
      } finally {
        if (!cancelled) {
          setStartupLoading(false);
          setStartupReady(true);
        }
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [activateWorkspace]);

  useEffect(() => {
    if (!startupReady && !workspace) return;
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => window.dispatchEvent(new Event("baize:app-ready")));
    });
    return () => cancelAnimationFrame(frame);
  }, [startupReady, workspace]);

  const chooseDirectory = async () => {
    const path = await api.chooseDirectory();
    if (path) {
      void inspectWorkspace(path);
    } else if (!isTauri) {
      setStartupError("浏览器预览模式不能弹出系统目录选择器，请直接输入目录后点击“检查目录”。");
    }
  };

  const initializeSelected = async () => {
    if (!selectedPath.trim() || selectedResult?.initialized !== false) return;
    if (!window.confirm("确认初始化这个目录吗？客户端只会创建标准协议和空目录，不会移动或删除已有资料。")) return;
    setStartupLoading(true);
    setStartupError(null);
    try {
      const result = withMetadata(await api.initWorkspace(selectedPath.trim(), workspaceName.trim() || pathName(selectedPath)));
      await activateWorkspace(result);
    } catch (reason) {
      setStartupError(`初始化工作区失败：${String(reason)}`);
      setStartupLoading(false);
    }
  };

  const openSelected = () => {
    if (!selectedPath.trim()) return;
    void inspectWorkspace(selectedPath, true);
  };

  const selectRecent = (item: RecentWorkspace) => {
    void inspectWorkspace(item.path);
  };

  const removeRecent = async (path: string) => {
    await api.removeRecentWorkspace(path);
    setRecent((current) => current.filter((item) => !samePath(item.path, path)));
    if (samePath(selectedPath, path)) {
      setSelectedPath("");
      setSelectedResult(null);
      setWorkspaceName("");
      setStartupError(null);
    }
  };

  const handlePathChange = (path: string) => {
    setSelectedPath(path);
    setSelectedResult(null);
    setStartupError(null);
    setWorkspaceName(pathName(path));
  };

  const requestWorkspaceSetup = (path: string) => {
    setWorkspace(null);
    setStartupReady(true);
    setSelectedPath(path);
    setSelectedResult(null);
    setWorkspaceName(pathName(path));
    setStartupError(null);
    void inspectWorkspace(path);
  };

  if (workspace) {
    return <WorkspaceContext.Provider value={{ workspace, setWorkspace }}><WorkbenchShell workspace={workspace} onWorkspaceChange={setWorkspace} onWorkspaceNeedsSetup={requestWorkspaceSetup} /><ToastHost /></WorkspaceContext.Provider>;
  }

  if (!startupReady) {
    return <><div className="startup-screen"><div className="startup-brand"><img className="startup-mark-img" src={iconBaize} alt="白泽" /><strong>白泽 BAIZE</strong></div><span className="spinner" />正在读取最近工作区…</div><ToastHost /></>;
  }

  return (
    <>
      <WorkspaceStartupView
        recent={recent}
        selectedPath={selectedPath}
        selectedResult={selectedResult}
        workspaceName={workspaceName}
        loading={startupLoading}
        error={startupError}
        onPathChange={handlePathChange}
        onWorkspaceNameChange={setWorkspaceName}
        onChooseDirectory={chooseDirectory}
        onInspect={() => void inspectWorkspace(selectedPath)}
        onOpenSelected={openSelected}
        onInitializeSelected={() => void initializeSelected()}
        onSelectRecent={selectRecent}
        onRemoveRecent={(path) => void removeRecent(path)}
      />
      <ToastHost />
    </>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used within WorkspaceContext");
  return context;
}
