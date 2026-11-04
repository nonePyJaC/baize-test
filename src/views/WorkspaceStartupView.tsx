import React from "react";
import AppIcon from "../components/AppIcon";
import logoBaize from "../assets/logo-baize.png";
import type { RecentWorkspace, WorkspaceOpenResult } from "../lib/types";

interface WorkspaceStartupViewProps {
  recent: RecentWorkspace[];
  selectedPath: string;
  selectedResult: WorkspaceOpenResult | null;
  workspaceName: string;
  loading: boolean;
  error: string | null;
  onPathChange: (path: string) => void;
  onWorkspaceNameChange: (name: string) => void;
  onChooseDirectory: () => void;
  onInspect: () => void;
  onOpenSelected: () => void;
  onInitializeSelected: () => void;
  onSelectRecent: (workspace: RecentWorkspace) => void;
  onRemoveRecent: (path: string) => void;
}

export default function WorkspaceStartupView({
  recent,
  selectedPath,
  selectedResult,
  workspaceName,
  loading,
  error,
  onPathChange,
  onWorkspaceNameChange,
  onChooseDirectory,
  onInspect,
  onOpenSelected,
  onInitializeSelected,
  onSelectRecent,
  onRemoveRecent,
}: WorkspaceStartupViewProps) {
  const isInitialized = selectedResult?.initialized === true;
  const isUninitialized = selectedResult?.initialized === false;
  const selectedLegacyDirectories = selectedResult?.legacy_directories || [];

  return (
    <main className="startup-page">
      <section className="startup-card">
        <div className="startup-brand"><img className="startup-logo" src={logoBaize} alt="白泽 BAIZE" /></div>
        <div className="startup-heading">
          <div className="eyebrow">本地优先 · 文件即协作协议</div>
          <h1>选择一个工作区开始</h1>
          <p>工作区会保存项目资料、平台配置和 AI 协作任务。客户端不会自动使用固定目录。</p>
        </div>

        <div className="startup-directory-picker">
          <label className="field-label" htmlFor="workspace-path">
            工作区目录
            <div className="startup-path-input">
              <AppIcon name="folder" size={16} />
              <input
                id="workspace-path"
                className="field-input"
                value={selectedPath}
                onChange={(event) => onPathChange(event.target.value)}
                placeholder="输入或选择工作区根目录"
                disabled={loading}
              />
              <button className="button button-small" type="button" onClick={onChooseDirectory} disabled={loading}>
                <AppIcon name="folderOpen" size={14} /> 浏览
              </button>
            </div>
          </label>
          <button className="button button-ghost button-small startup-inspect" type="button" onClick={onInspect} disabled={loading || !selectedPath.trim()}>
            <AppIcon name="refresh" size={14} /> 检查目录
          </button>
        </div>

        {selectedResult && (
          <div className={`startup-selection ${isInitialized ? "ready" : "needs-init"}`}>
            <div className="startup-selection-icon"><AppIcon name={isInitialized ? "success" : "info"} size={19} /></div>
            <div>
              <strong>{isInitialized ? `已识别工作区：${selectedResult.config.workspace.name || "未命名工作区"}` : "这是一个尚未初始化的目录"}</strong>
              <span>{isInitialized ? "可以直接打开，工作区配置不会被覆盖。" : "初始化只会补充白泽协议和标准目录，不会移动历史资料。"}</span>
            </div>
          </div>
        )}

        {isUninitialized && (
          <label className="field-label" htmlFor="workspace-name">
            工作区名称
            <input id="workspace-name" className="field-input" value={workspaceName} onChange={(event) => onWorkspaceNameChange(event.target.value)} placeholder="例如：测试工作区" disabled={loading} />
          </label>
        )}

        {selectedLegacyDirectories.length > 0 && (
          <div className="startup-legacy-notice">
            <AppIcon name="info" size={16} />
            <span>检测到历史目录（{selectedLegacyDirectories.join("、")}）。历史目录尚未迁移，但仍可从项目树访问。</span>
          </div>
        )}

        {error && <div className="startup-error-box"><AppIcon name="error" size={16} /><span>{error}</span></div>}

        <div className="startup-actions">
          <button className="button button-primary" type="button" onClick={onOpenSelected} disabled={loading || !isInitialized}>
            {loading && isInitialized ? <span className="spinner" /> : <AppIcon name="folderOpen" size={15} />} 打开已有工作区
          </button>
          <button className="button" type="button" onClick={onInitializeSelected} disabled={loading || !isUninitialized}>
            {loading && isUninitialized ? <span className="spinner" /> : <AppIcon name="add" size={15} />} 初始化并打开
          </button>
        </div>

        <section className="startup-recent-section">
          <div className="startup-section-heading"><div><AppIcon name="clock" size={15} /><h2>最近工作区</h2></div><span>{recent.length ? `${recent.length} 个记录` : "暂无记录"}</span></div>
          {recent.length === 0 ? (
            <div className="startup-empty"><AppIcon name="inbox" size={19} /><span>首次启动请选择一个目录，打开后会自动加入最近工作区。</span></div>
          ) : (
            <div className="startup-recent-list">
              {recent.map((item) => {
                const unavailable = item.available === false;
                const uninitialized = item.available !== false && item.initialized === false;
                return (
                  <div className={`startup-recent-item ${unavailable ? "unavailable" : ""}`} key={item.path}>
                    <button className="startup-recent-main" type="button" onClick={() => onSelectRecent(item)} disabled={loading}>
                      <span className="startup-recent-icon"><AppIcon name={unavailable ? "alert" : "folder"} size={16} /></span>
                      <span className="startup-recent-text"><strong>{item.name || item.path.split(/[\\/]/).filter(Boolean).pop() || item.path}</strong><small title={item.path}>{item.path}</small></span>
                      <span className={`startup-recent-status ${unavailable ? "danger" : uninitialized ? "warning" : "success"}`}>{unavailable ? "目录不可用" : uninitialized ? "未初始化" : "可打开"}</span>
                    </button>
                    {unavailable && <button className="icon-button" type="button" onClick={() => onRemoveRecent(item.path)} title="移除失效记录" disabled={loading}><AppIcon name="close" size={14} /></button>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
