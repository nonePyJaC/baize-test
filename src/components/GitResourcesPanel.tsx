import React, { useCallback, useEffect, useMemo, useState } from "react";
import AppIcon from "./AppIcon";
import { api } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import { assertFastForwardReady, emptyGitStatus, fetchGitResource, normalizeGitResource, pullGitResourceFastForward, readGitStatus } from "../lib/git";
import type { GitResource, GitStatus, GitResourceAppType, RequirementMeta } from "../lib/types";

interface GitResourcesPanelProps {
  rootPath: string;
  platformPath: string;
  requirement: RequirementMeta;
  readOnly: boolean;
  onSaved: (requirement: RequirementMeta) => void;
}

type ResourceDraft = Omit<GitResource, "id"> & { id: string };

const APP_TYPE_OPTIONS: Array<{ value: GitResourceAppType; label: string }> = [
  { value: "frontend", label: "前端" },
  { value: "backend", label: "后端" },
  { value: "other", label: "其他" },
];

export default function GitResourcesPanel({ rootPath, platformPath, requirement, readOnly, onSaved }: GitResourcesPanelProps) {
  const initialResources = useMemo(() => (requirement.git_resources || []).map((item) => normalizeGitResource(item)), [requirement.git_resources]);
  const [resources, setResources] = useState<GitResource[]>(initialResources);
  const [statuses, setStatuses] = useState<Record<string, GitStatus>>({});
  const [draft, setDraft] = useState<ResourceDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveResources = useCallback(async (nextResources: GitResource[], successMessage?: string) => {
    if (readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const nextRequirement = { ...requirement, git_resources: nextResources };
      await api.saveRequirement(rootPath, platformPath, requirement.requirement.id, nextRequirement);
      setResources(nextResources);
      onSaved(nextRequirement);
      if (successMessage) setMessage(successMessage);
    } catch (reason) {
      setError(`保存Git资源失败：${String(reason)}`);
      throw reason;
    } finally {
      setSaving(false);
    }
  }, [onSaved, platformPath, readOnly, requirement, rootPath]);

  const refreshResources = useCallback(async (items: GitResource[] = resources, persistMetadata = true) => {
    if (!items.length) return;
    setError(null);
    const entries = await Promise.all(items.map(async (resource) => [resource, await readGitStatus(resource)] as const));
    const nextStatuses = entries.reduce<Record<string, GitStatus>>((result, [resource, status]) => ({ ...result, [resource.id]: status }), {});
    setStatuses(nextStatuses);
    const nextResources = entries.map(([resource, status]) => resourceWithStatus(resource, status));
    const changed = nextResources.some((resource, index) => resourceChanged(resource, items[index]));
    if (persistMetadata && changed && !readOnly) {
      await saveResources(nextResources, "Git状态已读取并同步到需求元数据");
    } else {
      setResources(nextResources);
    }
  }, [readOnly, resources, saveResources]);

  useEffect(() => {
    setResources(initialResources);
    setStatuses({});
    setDraft(null);
    void refreshResources(initialResources, !readOnly).catch(() => undefined);
  }, [initialResources, readOnly]);

  const submitDraft = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || readOnly) return;
    const normalized = normalizeGitResource(draft);
    if (!normalized.application_name.trim() || !normalized.local_path.trim()) {
      setError("应用名称和本地仓库路径不能为空");
      return;
    }
    if (resources.some((item) => item.id === normalized.id && item.id !== draft.id)) {
      setError("Git资源ID已存在，请重新添加");
      return;
    }
    const nextResources = resources.some((item) => item.id === normalized.id)
      ? resources.map((item) => item.id === normalized.id ? normalized : item)
      : [...resources, normalized];
    try {
      await saveResources(nextResources, resources.some((item) => item.id === normalized.id) ? "Git资源已更新" : "Git资源已关联");
      setDraft(null);
      await refreshResources(nextResources, true);
    } catch {
      return;
    }
  };

  const removeResource = async (resource: GitResource) => {
    if (readOnly || !window.confirm(`确定解除“${resource.application_name}”的Git资源关联吗？不会删除本地仓库或远端资料。`)) return;
    try {
      await saveResources(resources.filter((item) => item.id !== resource.id), "Git资源关联已解除");
      setStatuses((current) => {
        const next = { ...current };
        delete next[resource.id];
        return next;
      });
    } catch {
      return;
    }
  };

  const refreshOne = async (resource: GitResource) => {
    setBusyId(resource.id);
    setError(null);
    try {
      const status = await readGitStatus(resource);
      setStatuses((current) => ({ ...current, [resource.id]: status }));
      const nextResources = resources.map((item) => item.id === resource.id ? resourceWithStatus(item, status) : item);
      setResources(nextResources);
      if (!readOnly && resourceChanged(nextResources.find((item) => item.id === resource.id) || resource, resource)) {
        await saveResources(nextResources);
      }
    } catch (reason) {
      setError(`读取Git状态失败：${String(reason)}`);
    } finally {
      setBusyId(null);
    }
  };

  const fetchOne = async (resource: GitResource) => {
    setBusyId(resource.id);
    setError(null);
    try {
      const result = await fetchGitResource(resource);
      setStatuses((current) => ({ ...current, [resource.id]: result.status }));
      const nextResources = resources.map((item) => item.id === resource.id ? resourceWithStatus(item, result.status) : item);
      setResources(nextResources);
      if (!readOnly && resourceChanged(nextResources.find((item) => item.id === resource.id) || resource, resource)) await saveResources(nextResources);
      setMessage(result.output);
    } catch (reason) {
      setError(`fetch失败：${String(reason)}`);
    } finally {
      setBusyId(null);
    }
  };

  const pullOne = async (resource: GitResource) => {
    const status = statuses[resource.id] || emptyGitStatus(resource);
    try {
      assertFastForwardReady(status);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    if (!window.confirm(`将对“${resource.application_name}”执行 pull --ff-only，仅允许快进更新。确定继续吗？`)) return;
    setBusyId(resource.id);
    setError(null);
    try {
      const result = await pullGitResourceFastForward(resource);
      setStatuses((current) => ({ ...current, [resource.id]: result.status }));
      const nextResources = resources.map((item) => item.id === resource.id ? resourceWithStatus(item, result.status) : item);
      setResources(nextResources);
      if (!readOnly) await saveResources(nextResources);
      setMessage(result.output);
    } catch (reason) {
      setError(`安全更新失败：${String(reason)}`);
    } finally {
      setBusyId(null);
    }
  };

  const startAdd = () => {
    setMessage(null);
    setError(null);
    setDraft({
      id: `git-${Date.now()}`,
      application_name: "",
      local_path: "",
      repository_url: "",
      current_branch: "",
      current_commit: "",
      expected_branch: "",
      app_type: "other",
    });
  };

  return (
    <section className="panel-section git-resources-panel">
      <div className="section-heading">
        <div><AppIcon name="branch" size={16} /><h2>Git资源关联</h2></div>
        <div className="section-heading-actions"><span className="section-muted">{resources.length} 个仓库</span>{!readOnly && <button className="button button-ghost button-small" type="button" onClick={startAdd}><AppIcon name="add" size={13} /> 关联仓库</button>}</div>
      </div>
      <p className="section-description">关联需求涉及的本地代码仓库，状态读取为只读；更新只允许用户确认后的 fetch 和 fast-forward pull。</p>
      {draft && <form className="git-resource-form" onSubmit={(event) => void submitDraft(event)}>
        <div className="form-section-heading"><strong>{resources.some((item) => item.id === draft.id) ? "编辑Git资源" : "新增Git资源"}</strong><button className="text-button" type="button" onClick={() => setDraft(null)} disabled={saving}>取消</button></div>
        <div className="git-resource-form-grid">
          <label className="field-label">应用名称<input className="field-input" value={draft.application_name} onChange={(event) => setDraft({ ...draft, application_name: event.target.value })} placeholder="例如：门店PC端" disabled={saving} autoFocus /></label>
          <label className="field-label">前后端类型<select className="field-input" value={draft.app_type} onChange={(event) => setDraft({ ...draft, app_type: event.target.value as GitResourceAppType })} disabled={saving}>{APP_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="field-label git-resource-path-field">本地仓库路径<div className="field-input-with-action"><input className="field-input mono" value={draft.local_path} onChange={(event) => setDraft({ ...draft, local_path: event.target.value })} placeholder="选择本地Git仓库目录" disabled={saving} /><button className="button button-small" type="button" onClick={() => void chooseRepositoryPath(setDraft, draft)} disabled={saving}><AppIcon name="folderOpen" size={13} /> 浏览</button></div></label>
          <label className="field-label">仓库地址<input className="field-input mono" value={draft.repository_url} onChange={(event) => setDraft({ ...draft, repository_url: event.target.value })} placeholder="可从origin自动读取" disabled={saving} /></label>
          <label className="field-label">期望分支<input className="field-input mono" value={draft.expected_branch} onChange={(event) => setDraft({ ...draft, expected_branch: event.target.value })} placeholder="例如：release/demo-1001" disabled={saving} /></label>
        </div>
        <div className="modal-actions"><button className="button button-primary button-small" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : <AppIcon name="save" size={13} />} 保存关联</button></div>
      </form>}
      {resources.length === 0 && !draft ? <div className="inline-empty large"><AppIcon name="branch" size={19} />当前需求尚未关联本地Git仓库</div> : <div className="git-resource-list">{resources.map((resource) => <GitResourceCard key={resource.id} resource={resource} status={statuses[resource.id] || emptyGitStatus(resource)} readOnly={readOnly} busy={busyId === resource.id || saving} onEdit={() => setDraft({ ...resource })} onRemove={() => void removeResource(resource)} onRefresh={() => void refreshOne(resource)} onFetch={() => void fetchOne(resource)} onPull={() => void pullOne(resource)} />)}</div>}
      {message && <div className="inline-notice success"><AppIcon name="success" size={14} /><span>{message}</span><button type="button" onClick={() => setMessage(null)}><AppIcon name="close" size={13} /></button></div>}
      {error && <div className="inline-notice danger"><AppIcon name="error" size={14} /><span>{error}</span><button type="button" onClick={() => setError(null)}><AppIcon name="close" size={13} /></button></div>}
    </section>
  );
}

function GitResourceCard({ resource, status, readOnly, busy, onEdit, onRemove, onRefresh, onFetch, onPull }: { resource: GitResource; status: GitStatus; readOnly: boolean; busy: boolean; onEdit: () => void; onRemove: () => void; onRefresh: () => void; onFetch: () => void; onPull: () => void }) {
  const statusClass = !status.is_git_repo ? "danger" : status.error ? "warning" : "success";
  const statusLabel = !status.is_git_repo ? "不是Git仓库" : status.error ? "状态异常" : "Git仓库";
  const branchMismatch = resource.expected_branch && status.branch && resource.expected_branch !== status.branch;
  return <article className="git-resource-card">
    <div className="git-resource-card-header"><div className="git-resource-card-title"><span className="row-icon blue"><AppIcon name={resource.app_type === "backend" ? "codeFile" : resource.app_type === "frontend" ? "box" : "branch"} size={16} /></span><div><strong>{resource.application_name}</strong><small>{appTypeLabel(resource.app_type)} · {resource.id}</small></div></div><span className={`status-pill ${statusClass}`}>{statusLabel}</span></div>
    <div className="git-resource-meta-grid"><MetaItem label="本地路径" value={resource.local_path || "未配置"} mono /><MetaItem label="仓库地址" value={status.remote || resource.repository_url || "未读取"} mono /><MetaItem label="当前分支" value={status.branch || resource.current_branch || "未读取"} mono warning={Boolean(branchMismatch)} /><MetaItem label="当前Commit" value={status.commit || resource.current_commit || "未读取"} mono /></div>
    {resource.expected_branch && <div className={`git-expected-branch ${branchMismatch ? "mismatch" : ""}`}><AppIcon name="branch" size={13} />期望分支：<strong>{resource.expected_branch}</strong>{branchMismatch && <span>当前分支不一致</span>}</div>}
    {status.is_git_repo && <div className="git-state-line"><span className={status.uncommitted_files.length ? "danger-text" : "success-text"}>{status.uncommitted_files.length ? `${status.uncommitted_files.length} 个未提交文件` : "工作区干净"}</span><span>ahead {status.ahead}</span><span>behind {status.behind}</span>{status.upstream_branch && <span className="mono">跟踪 {status.upstream_branch}</span>}</div>}
    {status.error && <div className="git-error-line"><AppIcon name="alert" size={13} />{status.error}</div>}
    {status.uncommitted_files.length > 0 && <div className="git-file-statuses">{status.uncommitted_files.slice(0, 8).map((file) => <span key={`${file.code}-${file.path}`}><b>{file.code}</b>{file.path}</span>)}{status.uncommitted_files.length > 8 && <small>还有 {status.uncommitted_files.length - 8} 个文件</small>}</div>}
    {status.incoming_commits.length > 0 && <div className="git-incoming-list"><div className="git-subheading"><AppIcon name="download" size={13} /><strong>fetch后可更新内容</strong><span>{status.incoming_commits.length} 条</span></div>{status.incoming_commits.slice(0, 5).map((commit) => <CommitRow key={commit.hash} commit={commit} />)}</div>}
    <div className="git-recent-list"><div className="git-subheading"><AppIcon name="history" size={13} /><strong>最近提交</strong></div>{status.recent_commits.length ? status.recent_commits.slice(0, 5).map((commit) => <CommitRow key={commit.hash} commit={commit} />) : <span className="field-hint">暂无提交记录</span>}</div>
    <div className="git-resource-actions"><button className="button button-ghost button-small" type="button" onClick={() => void systemOpen.openDirectory(resource.local_path)} disabled={busy || !resource.local_path}><AppIcon name="folderOpen" size={13} /> 打开目录</button><button className="button button-ghost button-small" type="button" onClick={onRefresh} disabled={busy}><AppIcon name="refresh" size={13} /> 刷新状态</button><button className="button button-ghost button-small" type="button" onClick={onFetch} disabled={busy || !status.is_git_repo}><AppIcon name="download" size={13} /> fetch</button><button className="button button-primary button-small" type="button" onClick={onPull} disabled={busy || !status.can_fast_forward}><AppIcon name="download" size={13} /> pull --ff-only</button>{!readOnly && <><button className="button button-ghost button-small" type="button" onClick={onEdit} disabled={busy}><AppIcon name="edit" size={13} /> 编辑</button><button className="button button-danger button-small" type="button" onClick={onRemove} disabled={busy}><AppIcon name="minus" size={13} /> 解除</button></>}</div>
    <small className="git-checked-at">最近读取：{formatTime(status.checked_at)}</small>
  </article>;
}

function MetaItem({ label, value, mono, warning }: { label: string; value: string; mono?: boolean; warning?: boolean }) {
  return <div className="git-meta-item"><span>{label}</span><strong className={`${mono ? "mono" : ""} ${warning ? "warning-text" : ""}`} title={value}>{value}</strong></div>;
}

function CommitRow({ commit }: { commit: { hash: string; short_hash: string; author: string; date: string; subject: string } }) {
  return <div className="git-commit-row"><span className="mono">{commit.short_hash}</span><strong title={commit.subject}>{commit.subject}</strong><small>{commit.author} · {formatTime(commit.date)}</small></div>;
}

function resourceWithStatus(resource: GitResource, status: GitStatus): GitResource {
  return normalizeGitResource({
    ...resource,
    repository_url: status.remote || resource.repository_url,
    current_branch: status.branch || resource.current_branch,
    current_commit: status.commit || resource.current_commit,
  });
}

function resourceChanged(left: GitResource, right: GitResource): boolean {
  return left.repository_url !== right.repository_url || left.current_branch !== right.current_branch || left.current_commit !== right.current_commit;
}

function appTypeLabel(value: GitResourceAppType): string {
  return APP_TYPE_OPTIONS.find((item) => item.value === value)?.label || "其他";
}

function formatTime(value: string): string {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function chooseRepositoryPath(setDraft: React.Dispatch<React.SetStateAction<ResourceDraft | null>>, draft: ResourceDraft): Promise<void> {
  const path = await api.chooseDirectory();
  if (path) setDraft({ ...draft, local_path: path });
}
