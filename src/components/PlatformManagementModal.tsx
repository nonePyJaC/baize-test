import React, { useEffect, useState } from "react";
import { api, joinPath } from "../lib/api";
import AppIcon from "./AppIcon";
import type { PlatformDraft, PlatformInfo, PlatformUpdate, WorkspaceConfig } from "../lib/types";

interface PlatformManagementModalProps {
  workspace: WorkspaceConfig;
  platform?: PlatformInfo;
  onClose: () => void;
  onSaved: (workspace: WorkspaceConfig) => void;
}

interface PlatformFormState {
  id: string;
  name: string;
  path: string;
  knowledge_path: string;
  description: string;
  status: "active" | "archived";
}

const ID_SUGGESTIONS: Record<string, string> = {
  saas: "saas",
  示例平台二: "chery",
  示例平台: "foton",
  示例项目: "johnson",
};

export default function PlatformManagementModal({ workspace, platform, onClose, onSaved }: PlatformManagementModalProps) {
  const editing = Boolean(platform);
  const projectsRoot = workspace.directories.projects || "projects";
  const knowledgeRoot = workspace.directories.knowledge || "knowledge";
  const [form, setForm] = useState<PlatformFormState>(() => initialForm(workspace, platform));
  const [idTouched, setIdTouched] = useState(editing);
  const [pathTouched, setPathTouched] = useState(editing);
  const [knowledgePathTouched, setKnowledgePathTouched] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(initialForm(workspace, platform));
    setIdTouched(Boolean(platform));
    setPathTouched(Boolean(platform));
    setKnowledgePathTouched(Boolean(platform));
    setError(null);
  }, [platform, workspace, editing]);

  const changeName = (name: string) => {
    setForm((current) => {
      const next = { ...current, name };
      if (!idTouched) next.id = suggestPlatformId(name);
      if (!pathTouched) next.path = joinPath(projectsRoot, name.trim());
      if (!knowledgePathTouched) next.knowledge_path = joinPath(knowledgeRoot, name.trim());
      return next;
    });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!form.name.trim() || !form.id.trim()) {
      setError("平台显示名称和稳定 ID 不能为空");
      return;
    }
    setSaving(true);
    try {
      const updatedWorkspace = editing
        ? await api.updatePlatform(workspace.workspace.root_path, platform!.id, {
          name: form.name.trim(),
          description: form.description.trim(),
          status: form.status,
        } satisfies PlatformUpdate)
        : await api.createPlatform(workspace.workspace.root_path, {
          id: form.id.trim(),
          name: form.name.trim(),
          path: form.path.trim(),
          knowledge_path: form.knowledge_path.trim(),
          description: form.description.trim(),
        } satisfies PlatformDraft);
      onSaved(updatedWorkspace);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!platform || !window.confirm(`确认删除“${platform.name}”的平台注册吗？该操作不会删除目录；存在关联数据时只能归档。`)) return;
    setError(null);
    setSaving(true);
    try {
      const updatedWorkspace = await api.deletePlatform(workspace.workspace.root_path, platform.id);
      onSaved(updatedWorkspace);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal platform-modal" onSubmit={(event) => void submit(event)}>
        <div className="modal-header">
          <div><span className="eyebrow">平台注册表</span><h2>{editing ? "编辑平台" : "新增平台"}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={saving} title="关闭"><AppIcon name="close" size={16} /></button>
        </div>
        <p className="modal-description">平台以 workspace.yaml 中的注册记录为准。稳定 ID 创建后不可修改，目录只接受工作区内的相对路径。</p>

        <label className="field-label">显示名称
          <input className="field-input" value={form.name} onChange={(event) => changeName(event.target.value)} placeholder="例如：示例项目" autoFocus disabled={saving} />
        </label>
        <label className="field-label">稳定 ID
          <input className="field-input mono" value={form.id} onChange={(event) => { setIdTouched(true); setForm((current) => ({ ...current, id: event.target.value })); }} placeholder="例如：johnson" readOnly={editing} disabled={saving} />
          <span className="field-hint">{editing ? "稳定 ID 创建后不可修改。" : "可根据名称自动建议，提交前请确认。"}</span>
        </label>
        <div className="platform-form-grid">
          <label className="field-label">项目目录
            <input className="field-input mono" value={form.path} onChange={(event) => { setPathTouched(true); setForm((current) => ({ ...current, path: event.target.value })); }} placeholder={`${projectsRoot}/平台目录`} readOnly={editing} disabled={saving} />
          </label>
          <label className="field-label">知识目录
            <input className="field-input mono" value={form.knowledge_path} onChange={(event) => { setKnowledgePathTouched(true); setForm((current) => ({ ...current, knowledge_path: event.target.value })); }} placeholder={`${knowledgeRoot}/平台目录`} readOnly={editing} disabled={saving} />
          </label>
        </div>
        {editing && <span className="field-hint platform-path-hint">目录修改需要迁移预览，当前版本不直接移动历史资料。</span>}
        <label className="field-label">描述
          <textarea className="field-input field-textarea" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="可选：平台业务范围或使用说明" disabled={saving} />
        </label>
        {editing && <label className="field-label">状态
          <select className="field-input" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as PlatformFormState["status"] }))} disabled={saving}>
            <option value="active">启用（可用于新需求）</option>
            <option value="archived">归档（保留历史数据）</option>
          </select>
        </label>}

        {error && <div className="modal-error"><AppIcon name="error" size={15} /><span>{error}</span></div>}
        <div className="modal-actions">
          {editing && <button className="button button-danger" type="button" onClick={() => void remove()} disabled={saving}><AppIcon name="archive" size={14} /> 删除注册</button>}
          <span className="modal-action-spacer" />
          <button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>取消</button>
          <button className="button button-primary" type="submit" disabled={saving || !form.name.trim() || !form.id.trim()}>{saving ? <span className="spinner" /> : <AppIcon name="save" size={14} />} {editing ? "保存修改" : "创建平台"}</button>
        </div>
      </form>
    </div>
  );
}

function initialForm(workspace: WorkspaceConfig, platform?: PlatformInfo): PlatformFormState {
  const projectsRoot = workspace.directories.projects || "projects";
  const knowledgeRoot = workspace.directories.knowledge || "knowledge";
  const name = platform?.name || "";
  return {
    id: platform?.id || suggestPlatformId(name),
    name,
    path: platform?.path || joinPath(projectsRoot, name),
    knowledge_path: platform?.knowledge_path || joinPath(knowledgeRoot, name),
    description: platform?.description || "",
    status: platform?.status === "archived" ? "archived" : "active",
  };
}

function suggestPlatformId(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const direct = ID_SUGGESTIONS[trimmed];
  if (direct) return direct;
  const ascii = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii || "platform";
}
