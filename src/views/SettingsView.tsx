import { connectionsFromPreferences } from "../services/integrations";
import IntegrationSettings from "../components/IntegrationSettings";
import React, { useEffect, useState } from "react";
import AppIcon from "../components/AppIcon";
import { api, DEFAULT_CLIENT_PREFERENCES, DEFAULT_MODEL_BASE_URL, DEFAULT_YUNXIAO_BASE_URL } from "../lib/api";
import { APP_NAME, APP_VERSION } from "../lib/appInfo";
import { normalizeReportTemplateRegistry, reportTemplateRegistryPath } from "../lib/report";
import { normalizeTemplateRegistry, templateRegistryPath } from "../lib/templateExport";
import logoBaize from "../assets/logo-baize.png";
import type { CaseTemplate, ClientPreferences, RecentWorkspace, ReportTemplate, WorkspaceBackupConfig, WorkspaceConfig, WorkspaceWatcherConfig } from "../lib/types";

interface SettingsViewProps {
  workspace: WorkspaceConfig;
  onWorkspaceChange: (workspace: WorkspaceConfig) => void;
  onOpenWorkspace: (path: string) => void;
  onRightContext?: import("../lib/workbench").RightContextReporter;
  onClientPreferencesChange?: (preferences: ClientPreferences) => void;
}


const FALLBACK_WATCHER: WorkspaceWatcherConfig = { enabled: true, debounce_ms: 500, ignore_patterns: [] };
const FALLBACK_BACKUP: WorkspaceBackupConfig = { auto_enabled: true, interval_hours: 24, max_backups: 10, include_cache: false };

export default function SettingsView({ workspace, onWorkspaceChange, onOpenWorkspace, onRightContext, onClientPreferencesChange }: SettingsViewProps) {
  const rootPath = workspace.workspace.root_path;
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const [caseTemplates, setCaseTemplates] = useState<CaseTemplate[]>([]);
  const [reportTemplates, setReportTemplates] = useState<ReportTemplate[]>([]);
  const [defaultPlatformId, setDefaultPlatformId] = useState("");
  const [defaultCaseTemplateId, setDefaultCaseTemplateId] = useState("");
  const [defaultReportTemplateId, setDefaultReportTemplateId] = useState("");
  const [ignorePatterns, setIgnorePatterns] = useState("");
  const [watcherEnabled, setWatcherEnabled] = useState(true);
  const [debounceMs, setDebounceMs] = useState("500");
  const [backup, setBackup] = useState<WorkspaceBackupConfig>(FALLBACK_BACKUP);
  const [preferences, setPreferences] = useState<ClientPreferences>(DEFAULT_CLIENT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [verifyingModel, setVerifyingModel] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // BB-16D：设置页上报页面区块与工作区信息
  useEffect(() => {
    if (!onRightContext) return;
    const scrollTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    onRightContext({
      objectType: "settings",
      title: "设置",
      subtitle: workspace.workspace.name || workspace.workspace.root_path,
      outlineTitle: "设置区块",
      outline: [
        { id: "recent", label: "最近工作区", badge: String(recent.length), icon: "folder", onSelect: scrollTo("settings-recent") },
        { id: "defaults", label: "工作区默认项", icon: "wrench", onSelect: scrollTo("settings-defaults") },
        { id: "watcher", label: "文件监听与自动备份", icon: "activity", onSelect: scrollTo("settings-watcher") },
        { id: "changes", label: "变化中心", icon: "activity", onSelect: scrollTo("settings-changes") },
        { id: "external", label: "外部程序偏好", icon: "terminal", onSelect: scrollTo("settings-external") },
        { id: "model", label: "模型服务", icon: "ai", onSelect: scrollTo("settings-model") },
        { id: "yunxiao", label: "外部系统连接", icon: "platform", onSelect: scrollTo("settings-integrations") },
        { id: "security", label: "安全边界", icon: "security", onSelect: scrollTo("settings-security") },
      ],
      properties: [
        { label: "工作区", value: workspace.workspace.name || "未命名" },
        { label: "协议版本", value: workspace.version },
        { label: "平台数", value: String(workspace.platforms.length) },
        { label: "用例模板", value: String(caseTemplates.length) },
        { label: "报告模板", value: String(reportTemplates.length) },
        { label: "外部系统连接", value: `${connectionsFromPreferences(preferences).filter(c => c.enabled).length} 个启用连接` },
        { label: "模型服务", value: preferences.model_provider.enabled ? (preferences.model_provider.model || "已启用") : "未配置" },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, workspace, caseTemplates.length, reportTemplates.length, preferences.connections, preferences.model_provider.enabled, preferences.model_provider.model, recent.length]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loadRegistry = async (path: string, normalize: (value: unknown) => { templates: any[] }) => {
      try {
        return normalize(await api.readJsonFile(path)).templates;
      } catch {
        return [];
      }
    };
    Promise.all([
      api.loadWorkspaceSession(),
      loadRegistry(templateRegistryPath(rootPath), normalizeTemplateRegistry),
      loadRegistry(reportTemplateRegistryPath(rootPath), normalizeReportTemplateRegistry),
      api.loadClientPreferences(),
    ]).then(([session, templates, reports, clientPreferences]) => {
      if (cancelled) return;
      setRecent(session.recent_workspaces);
      setCaseTemplates(templates as CaseTemplate[]);
      setReportTemplates(reports as ReportTemplate[]);
      setPreferences(clientPreferences);
      onClientPreferencesChange?.(clientPreferences);
      const defaults = workspace.defaults || { platform_id: null, case_template_id: null, report_template_id: null };
      const watcher = workspace.watcher || FALLBACK_WATCHER;
      setDefaultPlatformId(defaults.platform_id || "");
      setDefaultCaseTemplateId(defaults.case_template_id || "");
      setDefaultReportTemplateId(defaults.report_template_id || "");
      setIgnorePatterns(watcher.ignore_patterns.join("\n"));
      setWatcherEnabled(watcher.enabled);
      setDebounceMs(String(watcher.debounce_ms || 500));
      setBackup({ ...FALLBACK_BACKUP, ...(workspace.backup || {}) });
    }).catch((reason) => {
      if (!cancelled) setError(`读取设置失败：${String(reason)}`);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [rootPath, workspace.backup, workspace.defaults, workspace.watcher, onClientPreferencesChange]);

  const saveWorkspaceSettings = async () => {
    setSavingWorkspace(true);
    setError(null);
    try {
      const watcher = workspace.watcher || FALLBACK_WATCHER;
      const nextConfig: WorkspaceConfig = {
        ...workspace,
        defaults: {
          platform_id: defaultPlatformId || null,
          case_template_id: defaultCaseTemplateId || null,
          report_template_id: defaultReportTemplateId || null,
        },
        watcher: {
          ...watcher,
          enabled: watcherEnabled,
          debounce_ms: Math.max(50, Number.parseInt(debounceMs, 10) || 500),
          ignore_patterns: splitLines(ignorePatterns),
        },
        backup: {
          ...backup,
          interval_hours: Math.max(1, Number(backup.interval_hours) || 24),
          max_backups: Math.max(1, Number(backup.max_backups) || 10),
        },
      };
      const saved = await api.saveWorkspaceConfig(rootPath, nextConfig);
      onWorkspaceChange(saved);
      setMessage("工作区设置已保存到 .blackbox/workspace.yaml");
    } catch (reason) {
      setError(`保存工作区设置失败：${String(reason)}`);
    } finally {
      setSavingWorkspace(false);
    }
  };

  const persistClientPreferences = async (next: ClientPreferences) => {
    await api.saveClientPreferences(next);
    onClientPreferencesChange?.(next);
  };

  const saveExternalPreferences = async () => {
    setSavingPreferences(true);
    setError(null);
    try {
      await persistClientPreferences(preferences);
      setMessage("客户端偏好已保存到 tauri-plugin-store");
    } catch (reason) {
      setError(`保存客户端偏好失败：${String(reason)}`);
    } finally {
      setSavingPreferences(false);
    }
  };

  const updateModelProvider = (patch: Partial<ClientPreferences["model_provider"]>) =>
    setPreferences((current) => ({ ...current, model_provider: { ...current.model_provider, ...patch } }));

  const verifyModelProvider = async () => {
    const provider = preferences.model_provider;
    if (!provider.base_url.trim() || !provider.api_key.trim() || !provider.model.trim()) {
      setError("请先填写模型服务 Base URL、API Key 和模型名称");
      return;
    }
    setVerifyingModel(true);
    setError(null);
    setMessage(null);
    try {
      const detail = await api.verifyModelProvider(provider.base_url, provider.api_key, provider.model);
      const next: ClientPreferences = {
        ...preferences,
        model_provider: {
          ...provider,
          enabled: true,
          last_verified_at: new Date().toISOString(),
        },
      };
      setPreferences(next);
      await persistClientPreferences(next);
      setMessage(`模型服务已连接：${detail}`);
    } catch (reason) {
      setError(`模型服务连接失败：${String(reason)}`);
    } finally {
      setVerifyingModel(false);
    }
  };

  const clearModelProvider = async () => {
    if (!window.confirm("确认清除本机保存的模型服务 API Key？")) return;
    const next: ClientPreferences = { ...preferences, model_provider: { ...DEFAULT_CLIENT_PREFERENCES.model_provider } };
    setPreferences(next);
    setError(null);
    try {
      await persistClientPreferences(next);
      setMessage("已清除本机保存的模型服务配置");
    } catch (reason) {
      setError(`清除模型服务配置失败：${String(reason)}`);
    }
  };

  const removeRecent = async (path: string) => {
    await api.removeRecentWorkspace(path);
    setRecent((current) => current.filter((item) => item.path !== path));
  };

  return <div className="workspace-view settings-view">
    <section className="document-header">
      <div className="document-title-row"><span className="document-icon blue"><AppIcon name="settings" size={20} /></span><div><div className="eyebrow">工作区 / 客户端</div><h1>设置中心</h1><p>客户端偏好保存在本机，平台、模板和业务配置保存在当前工作区</p></div></div>
      <div className="header-actions"><button className="button button-ghost" type="button" onClick={() => window.location.reload()} disabled={loading}><AppIcon name="refresh" size={15} /> 刷新</button></div>
    </section>

    <div className="settings-layout">
      <main>
        <section className="panel-section settings-section" id="settings-recent">
          <div className="section-heading"><div><AppIcon name="folder" size={16} /><h2>最近工作区</h2></div><span className="section-muted">{recent.length} 个记录</span></div>
          {recent.length ? <div className="settings-recent-list">{recent.map((item) => <div className="settings-recent-row" key={item.path}><span className="row-icon blue"><AppIcon name="folder" size={15} /></span><span className="settings-recent-main"><strong>{item.name || item.path}</strong><small className="mono">{item.path}</small></span><small>{item.last_opened_at ? new Date(item.last_opened_at).toLocaleString() : "未记录打开时间"}</small><button className="button button-ghost button-small" type="button" onClick={() => onOpenWorkspace(item.path)}>打开</button><button className="icon-button" type="button" onClick={() => void removeRecent(item.path)} title="移除最近记录"><AppIcon name="close" size={14} /></button></div>)}</div> : <div className="inline-empty">暂无最近工作区记录</div>}
        </section>

        <section className="panel-section settings-section" id="settings-defaults">
          <div className="section-heading"><div><AppIcon name="wrench" size={16} /><h2>工作区默认项</h2></div><span className="section-muted">写入 workspace.yaml</span></div>
          <div className="settings-form-grid">
            <label className="field-label">默认平台<select className="field-input" value={defaultPlatformId} onChange={(event) => setDefaultPlatformId(event.target.value)} disabled={loading || savingWorkspace}><option value="">不指定</option>{workspace.platforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}（{platform.id}）{platform.status === "archived" ? " · 已归档" : ""}</option>)}</select></label>
            <label className="field-label">默认用例模板<select className="field-input" value={defaultCaseTemplateId} onChange={(event) => setDefaultCaseTemplateId(event.target.value)} disabled={loading || savingWorkspace}><option value="">按模板自身默认项</option>{caseTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.type.toUpperCase()} · V{template.version}</option>)}</select><span className="field-hint">来自 .blackbox/templates.json</span></label>
            <label className="field-label">默认报告模板<select className="field-input" value={defaultReportTemplateId} onChange={(event) => setDefaultReportTemplateId(event.target.value)} disabled={loading || savingWorkspace}><option value="">按模板自身默认项</option>{reportTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.type.toUpperCase()} · V{template.version}</option>)}</select><span className="field-hint">来自 .blackbox/report-templates.json</span></label>
          </div>
        </section>

        <section className="panel-section settings-section" id="settings-watcher">
          <div className="section-heading"><div><AppIcon name="activity" size={16} /><h2>文件监听与自动备份</h2></div><span className="section-muted">工作区级配置</span></div>
          <div className="settings-form-grid">
            <label className="settings-check"><input type="checkbox" checked={watcherEnabled} onChange={(event) => setWatcherEnabled(event.target.checked)} disabled={savingWorkspace} /><span><strong>启用文件监听</strong><small>变化记录会收集到变化中心，是否自动打开由客户端偏好控制</small></span></label>
            <label className="field-label">监听防抖毫秒<input className="field-input" type="number" min="50" value={debounceMs} onChange={(event) => setDebounceMs(event.target.value)} disabled={savingWorkspace} /></label>
            <label className="field-label settings-wide-field">监听忽略规则<textarea className="field-input field-textarea settings-ignore-textarea" value={ignorePatterns} onChange={(event) => setIgnorePatterns(event.target.value)} disabled={savingWorkspace} placeholder="每行一条，例如：logs/*" /><span className="field-hint">支持路径片段和通配符；默认规则仍由客户端保护 node_modules、target、dist、.git 等目录。</span></label>
            <label className="settings-check"><input type="checkbox" checked={backup.auto_enabled} onChange={(event) => setBackup({ ...backup, auto_enabled: event.target.checked })} disabled={savingWorkspace} /><span><strong>启用自动备份</strong><small>备份策略写入当前工作区配置</small></span></label>
            <label className="field-label">备份间隔（小时）<input className="field-input" type="number" min="1" value={backup.interval_hours} onChange={(event) => setBackup({ ...backup, interval_hours: Number(event.target.value) })} disabled={savingWorkspace} /></label>
            <label className="field-label">备份保留数量<input className="field-input" type="number" min="1" value={backup.max_backups} onChange={(event) => setBackup({ ...backup, max_backups: Number(event.target.value) })} disabled={savingWorkspace} /></label>
            <label className="settings-check"><input type="checkbox" checked={backup.include_cache} onChange={(event) => setBackup({ ...backup, include_cache: event.target.checked })} disabled={savingWorkspace} /><span><strong>备份缓存目录</strong><small>通常建议关闭以减少备份体积</small></span></label>
          </div>
          <div className="settings-actions"><button className="button button-primary" type="button" onClick={() => void saveWorkspaceSettings()} disabled={savingWorkspace}>{savingWorkspace ? <span className="spinner" /> : <AppIcon name="save" size={14} />} 保存工作区设置</button></div>
        </section>

        <section className="panel-section settings-section" id="settings-changes">
          <div className="section-heading"><div><AppIcon name="activity" size={16} /><h2>变化中心</h2></div><span className="section-muted">客户端本地偏好</span></div>
          <div className="settings-form-grid">
            <label className="settings-check settings-wide-field"><input type="checkbox" checked={preferences.auto_open_change_center} onChange={(event) => setPreferences((current) => ({ ...current, auto_open_change_center: event.target.checked }))} disabled={savingPreferences} /><span><strong>文件变化时自动打开变化中心</strong><small>关闭后，文件变化只更新底部计数，不打断当前操作；需要查看时点击状态栏底部的「变化中心」按钮。</small></span></label>
          </div>
          <div className="settings-actions"><button className="button button-primary" type="button" onClick={() => void saveExternalPreferences()} disabled={savingPreferences}>{savingPreferences ? <span className="spinner" /> : <AppIcon name="save" size={14} />} 保存变化中心设置</button></div>
        </section>

        <section className="panel-section settings-section" id="settings-external">
          <div className="section-heading"><div><AppIcon name="terminal" size={16} /><h2>外部程序偏好</h2></div><span className="section-muted">客户端本地偏好</span></div>
          <div className="settings-form-grid">
            <label className="field-label">Git命令<input className="field-input mono" value={preferences.external_programs.git_command} onChange={(event) => setPreferences({ ...preferences, external_programs: { ...preferences.external_programs, git_command: event.target.value } })} placeholder="git" disabled={savingPreferences} /><span className="field-hint">当前安全执行通道使用 capability 白名单中的 git 命令。</span></label>
            <label className="field-label">Python命令<input className="field-input mono" value={preferences.external_programs.python_command} onChange={(event) => setPreferences({ ...preferences, external_programs: { ...preferences.external_programs, python_command: event.target.value } })} placeholder="python" disabled={savingPreferences} /></label>
            <label className="field-label settings-wide-field">外部编辑器命令<input className="field-input mono" value={preferences.external_programs.editor_command} onChange={(event) => setPreferences({ ...preferences, external_programs: { ...preferences.external_programs, editor_command: event.target.value } })} placeholder="可选，例如 code" disabled={savingPreferences} /></label>
          </div>
          <div className="settings-actions"><button className="button button-primary" type="button" onClick={() => void saveExternalPreferences()} disabled={savingPreferences}>{savingPreferences ? <span className="spinner" /> : <AppIcon name="save" size={14} />} 保存客户端偏好</button></div>
        </section>

        <section className="panel-section settings-section" id="settings-model">
          <div className="section-heading"><div><AppIcon name="ai" size={16} /><h2>模型服务（AI 提示词）</h2></div><span className="section-muted">API Key 只保存在本机</span></div>
          <div className="settings-form-grid">
            <label className="field-label settings-wide-field">API Key<input className="field-input mono" type="password" autoComplete="off" spellCheck={false} value={preferences.model_provider.api_key} onChange={(event) => updateModelProvider({ api_key: event.target.value })} placeholder="sk-…" disabled={savingPreferences || verifyingModel} /><span className="field-hint">支持 OpenAI 兼容接口（DeepSeek、通义千问、Kimi、GLM、自建 vLLM 等）。API Key 只保存在本机客户端偏好，不写入工作区，也不会进入 AI 任务派发词。</span></label>
            <label className="field-label">Base URL<input className="field-input mono" value={preferences.model_provider.base_url} onChange={(event) => updateModelProvider({ base_url: event.target.value })} placeholder={DEFAULT_MODEL_BASE_URL} disabled={savingPreferences || verifyingModel} /><span className="field-hint">例如 {DEFAULT_MODEL_BASE_URL}，末尾不需要 /chat/completions。</span></label>
            <label className="field-label">模型名称<input className="field-input mono" value={preferences.model_provider.model} onChange={(event) => updateModelProvider({ model: event.target.value })} placeholder="deepseek-chat" disabled={savingPreferences || verifyingModel} /></label>
            <label className="field-label">温度<input className="field-input" type="number" min="0" max="2" step="0.1" value={preferences.model_provider.temperature} onChange={(event) => updateModelProvider({ temperature: Number(event.target.value) })} disabled={savingPreferences || verifyingModel} /></label>
            <label className="field-label">最大 Tokens<input className="field-input" type="number" min="256" value={preferences.model_provider.max_tokens} onChange={(event) => updateModelProvider({ max_tokens: Number(event.target.value) })} disabled={savingPreferences || verifyingModel} /></label>
            <label className="field-label">上下文窗口（tokens）<input className="field-input" type="number" min="16000" step="1000" value={preferences.model_provider.context_window_tokens} onChange={(event) => updateModelProvider({ context_window_tokens: Number(event.target.value) })} disabled={savingPreferences || verifyingModel} /><span className="field-hint">模型可接收的输入总长度，默认 1,000,000（1M 上下文）。请按模型实际上限填写。</span></label>
            <label className="field-label">输入压缩触发（tokens）<input className="field-input" type="number" min="4000" step="1000" value={preferences.model_provider.compaction_trigger_tokens} onChange={(event) => updateModelProvider({ compaction_trigger_tokens: Number(event.target.value) })} disabled={savingPreferences || verifyingModel} /><span className="field-hint">输入达到该长度时，较早的过程会摘要成要点以释放上下文，默认 500,000；需小于上下文窗口。</span></label>
            <label className="settings-check"><input type="checkbox" checked={preferences.model_provider.enabled} onChange={(event) => updateModelProvider({ enabled: event.target.checked })} disabled={savingPreferences || verifyingModel} /><span><strong>启用模型服务</strong><small>启用后可在 AI 任务中用内置 AI 优化提示词</small></span></label>
          </div>
          <div className={`settings-yunxiao-status ${preferences.model_provider.enabled && preferences.model_provider.model ? "connected" : ""}`}>
            {preferences.model_provider.enabled && preferences.model_provider.model
              ? <><AppIcon name="success" size={15} /><span>已配置：{preferences.model_provider.model}</span><small className="mono">{preferences.model_provider.last_verified_at ? `校验于 ${new Date(preferences.model_provider.last_verified_at).toLocaleString()}` : "未记录校验时间"}</small></>
              : <><AppIcon name="info" size={15} /><span>尚未配置模型服务，填写后点击“测试连接并保存”。</span></>}
          </div>
          <div className="settings-actions">
            <button className="button button-primary" type="button" onClick={() => void verifyModelProvider()} disabled={savingPreferences || verifyingModel}>{verifyingModel ? <span className="spinner" /> : <AppIcon name="link" size={14} />} 测试连接并保存</button>
            <button className="button button-ghost" type="button" onClick={() => void clearModelProvider()} disabled={savingPreferences || verifyingModel}><AppIcon name="minus" size={14} /> 清除配置</button>
          </div>
        </section>

        <IntegrationSettings preferences={preferences} onChange={setPreferences} />
        <button type="button" className="button button-primary" onClick={() => void saveExternalPreferences()}>保存本机连接与偏好</button>

      </main>

      <aside>
        <section className="panel-section settings-section settings-about"><div className="section-heading"><div><AppIcon name="info" size={16} /><h2>关于</h2></div></div><img className="settings-about-logo" src={logoBaize} alt={APP_NAME} /><span>本地优先的需求、用例和测试协作工作台</span><div className="detail-list"><div className="detail-row"><span>客户端版本</span><strong>{APP_VERSION}</strong></div><div className="detail-row"><span>工作区协议</span><strong>{workspace.version}</strong></div><div className="detail-row"><span>当前工作区</span><strong title={rootPath}>{workspace.workspace.name}</strong></div></div><p className="field-hint">业务数据保存在工作区文件中；客户端不会用 localStorage 替代正式业务数据。</p></section>
        <section className="panel-section settings-section" id="settings-security"><div className="section-heading"><div><AppIcon name="security" size={16} /><h2>安全边界</h2></div></div><ul className="settings-list"><li>Git状态默认只读。</li><li>更新前必须工作区干净并满足 fast-forward 条件。</li><li>不会自动切分支、stash、reset 或 force。</li><li>需求锁定时，Git资源关联和配置写入均为只读。</li></ul></section>
      </aside>
    </div>
    {message && <div className="toast toast-success"><AppIcon name="check" size={15} /> {message}<button type="button" onClick={() => setMessage(null)}><AppIcon name="close" size={14} /></button></div>}
    {error && <div className="toast toast-error"><AppIcon name="alert" size={15} /> {error}<button type="button" onClick={() => setError(null)}><AppIcon name="close" size={14} /></button></div>}
  </div>;
}

function splitLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}
