import IntegrationDefaultsPicker from "./IntegrationDefaultsPicker";
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import AppIcon from "./AppIcon";
import ExternalRequirementPicker from "./ExternalRequirementPicker";
import { requirementReferences, type ExternalReference, type IntegrationDefaults } from "../services/integrations";
import { recordActivity } from "../lib/requirementFlow";
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type ApplicationInfo,
  type PlatformInfo,
  type RequirementDraft,
  type RequirementMeta,
  type RequirementYunxiao,
  type WorkspaceConfig,
} from "../lib/types";

interface RequirementManagementModalProps {
  workspace: WorkspaceConfig;
  platform?: PlatformInfo;
  requirement?: RequirementMeta;
  onClose: () => void;
  onSaved: (requirement: RequirementMeta, platform: PlatformInfo) => void;
}

interface BlockerDraft {
  description: string;
  owner: string;
}

interface ActionDraft {
  action: string;
  priority: string;
}

interface RequirementFormState {
  id: string;
  name: string;
  owner: string;
  plannedTestDate: string;
  plannedReleaseDate: string;
  initialStage: string;
  applications: ApplicationInfo[];
  blockers: BlockerDraft[];
  nextActions: ActionDraft[];

}

export default function RequirementManagementModal({ workspace, platform, requirement, onClose, onSaved }: RequirementManagementModalProps) {
  const editing = Boolean(requirement);
  const activePlatforms = useMemo(
    () => workspace.platforms.filter((item) => item.status !== "archived"),
    [workspace.platforms],
  );
  const [selectedPlatformId, setSelectedPlatformId] = useState(platform?.id || activePlatforms[0]?.id || "");
  const [form, setForm] = useState<RequirementFormState>(() => initialForm(requirement));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [integrationDefaults, setIntegrationDefaults] = useState<IntegrationDefaults>(requirement?.integration_defaults || {});
  const [externalRefs, setExternalRefs] = useState<ExternalReference[]>(() => requirementReferences(requirement));

  useEffect(() => {
    setSelectedPlatformId(platform?.id || activePlatforms[0]?.id || "");
    setForm(initialForm(requirement));
    setSaving(false);
    setError(null);
    setExternalRefs(requirementReferences(requirement));
    setIntegrationDefaults(requirement?.integration_defaults || {});
  }, [activePlatforms, platform?.id, requirement?.requirement.id]);

  const selectedPlatform = workspace.platforms.find((item) => item.id === selectedPlatformId);
  const currentPlatform = platform || selectedPlatform;
  const updateForm = <K extends keyof RequirementFormState>(key: K, value: RequirementFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!currentPlatform) {
      setError("请先注册一个启用中的平台");
      return;
    }
    if (!form.id.trim() || !form.name.trim()) {
      setError("需求编号和需求名称不能为空");
      return;
    }
    const applications = normalizeApplications(form.applications);
    if (applications === null) {
      setError("涉及应用名称不能为空；如不填写应用，请删除空行");
      return;
    }

    setSaving(true);
    try {
      if (editing && requirement) {
        const updated: RequirementMeta = {
          ...requirement,
          requirement: {
            ...requirement.requirement,
            name: form.name.trim(),
            owner: form.owner.trim(),
          },
          schedule: {
            ...requirement.schedule,
            planned_test_date: form.plannedTestDate || null,
            planned_release_date: form.plannedReleaseDate || null,
          },
          applications,
          blockers: form.blockers
            .filter((item) => item.description.trim())
            .map((item) => ({ description: item.description.trim(), owner: item.owner.trim() })),
          next_actions: form.nextActions
            .filter((item) => item.action.trim())
            .map((item) => ({ action: item.action.trim(), priority: item.priority })),
        };
        updated.external_refs = externalRefs;
        updated.yunxiao = yunxiaoFromRefs(externalRefs, requirement.yunxiao);
        updated.integration_defaults = integrationDefaults;
        await api.saveRequirement(workspace.workspace.root_path, currentPlatform.path, requirement.requirement.id, updated);
        // BB-16E：需求编辑与阻塞项变化记入活动台账
        const rootPath = workspace.workspace.root_path;
        const requirementId = requirement.requirement.id;
        const changed: string[] = [];
        if (updated.requirement.name !== requirement.requirement.name) changed.push("名称");
        if (updated.requirement.owner !== requirement.requirement.owner) changed.push("负责人");
        if (updated.schedule.planned_test_date !== requirement.schedule.planned_test_date || updated.schedule.planned_release_date !== requirement.schedule.planned_release_date) changed.push("时间节点");
        if (JSON.stringify(updated.applications) !== JSON.stringify(requirement.applications)) changed.push("涉及应用");
        if (JSON.stringify(updated.next_actions) !== JSON.stringify(requirement.next_actions)) changed.push("下一步动作");
        if (JSON.stringify(updated.external_refs) !== JSON.stringify(requirement.external_refs)) changed.push("外部关联");
        if (changed.length) {
          recordActivity(rootPath, currentPlatform.path, requirementId, { action: "requirement_updated", summary: `编辑需求：更新${changed.join("、")}` });
        }
        const oldBlockers = (requirement.blockers || []).map((item: { description?: string }) => item.description || "");
        const newBlockers = updated.blockers.map((item: { description?: string }) => item.description || "");
        newBlockers.filter((item) => !oldBlockers.includes(item)).forEach((item) => {
          recordActivity(rootPath, currentPlatform.path, requirementId, { action: "blocker_added", summary: `新增阻塞项：${item}` });
        });
        oldBlockers.filter((item) => !newBlockers.includes(item)).forEach((item) => {
          recordActivity(rootPath, currentPlatform.path, requirementId, { action: "blocker_closed", summary: `关闭阻塞项：${item}` });
        });
        onSaved(updated, currentPlatform);
      } else {
        const draft: RequirementDraft = {
          id: form.id.trim(),
          name: form.name.trim(),
          owner: form.owner.trim(),
          planned_test_date: form.plannedTestDate || null,
          planned_release_date: form.plannedReleaseDate || null,
          applications,
          initial_stage: form.initialStage,
          external_refs: externalRefs,
          yunxiao: yunxiaoFromRefs(externalRefs),
          integration_defaults: integrationDefaults,
        };
        const created = await api.createRequirement(workspace.workspace.root_path, currentPlatform.id, draft);
        onSaved(created, currentPlatform);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal requirement-modal" onSubmit={(event) => void submit(event)}>
        <div className="modal-header">
          <div><span className="eyebrow">标准需求目录</span><h2>{editing ? "编辑需求" : "新建需求"}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={saving} title="关闭"><AppIcon name="close" size={16} /></button>
        </div>
        <p className="modal-description">
          {editing
            ? "需求编号和所属平台创建后不可修改。修改内容会直接保存到需求目录中的 requirement.yaml。"
            : "保存后会在当前平台项目目录下生成标准需求目录和 requirement.yaml，业务数据不保存在浏览器状态中。"}
        </p>

        <ExternalRequirementPicker defaults={[requirement?.integration_defaults, currentPlatform?.integration_defaults, workspace.defaults?.integration_defaults]} value={externalRefs} onChange={setExternalRefs} onImport={!editing ? ref => { if (!form.name.trim()) updateForm("name", ref.title); } : undefined} />
        <IntegrationDefaultsPicker value={integrationDefaults} onChange={setIntegrationDefaults} />
        <div className="requirement-form-grid">
          <label className="field-label">所属平台<select className="field-input" value={selectedPlatformId} disabled={editing || Boolean(platform) || saving} onChange={e => setSelectedPlatformId(e.target.value)}>{activePlatforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field-label">本地需求编号<input className="field-input" value={form.id} disabled={editing || saving} onChange={e => updateForm("id", e.target.value)} required /></label>
          <label className="field-label">需求名称<input className="field-input" value={form.name} disabled={saving} onChange={e => updateForm("name", e.target.value)} required /></label>
          <label className="field-label">负责人<input className="field-input" value={form.owner} disabled={saving} onChange={e => updateForm("owner", e.target.value)} /></label>
          <label className="field-label">计划提测日期<input className="field-input" type="date" value={form.plannedTestDate} disabled={saving} onChange={e => updateForm("plannedTestDate", e.target.value)} /></label>
          <label className="field-label">计划上线日期<input className="field-input" type="date" value={form.plannedReleaseDate} disabled={saving} onChange={e => updateForm("plannedReleaseDate", e.target.value)} /></label>
          {!editing && <label className="field-label">初始阶段<select className="field-input" value={form.initialStage} onChange={e => updateForm("initialStage", e.target.value)}>{STAGE_ORDER.map(stage => <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>)}</select></label>}
        </div>
        <h3>涉及应用</h3>{form.applications.map((app, i) => <div className="field-row" key={i}><input className="field-input" aria-label="应用名称" value={app.name} onChange={e => updateForm("applications", form.applications.map((v, n) => n === i ? { ...v, name: e.target.value } : v))} /><input className="field-input" aria-label="应用分支" value={app.branch} onChange={e => updateForm("applications", form.applications.map((v, n) => n === i ? { ...v, branch: e.target.value } : v))} /><button type="button" className="text-button" onClick={() => updateForm("applications", form.applications.filter((_, n) => n !== i))}>删除</button></div>)}<button type="button" className="text-button" onClick={() => updateForm("applications", [...form.applications, { name: "", branch: "" }])}>添加应用</button>
        {editing && <><h3>阻塞项</h3>{form.blockers.map((b, i) => <div className="field-row" key={i}><input className="field-input" aria-label="阻塞描述" value={b.description} onChange={e => updateForm("blockers", form.blockers.map((v, n) => n === i ? { ...v, description: e.target.value } : v))} /><input className="field-input" aria-label="阻塞负责人" value={b.owner} onChange={e => updateForm("blockers", form.blockers.map((v, n) => n === i ? { ...v, owner: e.target.value } : v))} /><button type="button" onClick={() => updateForm("blockers", form.blockers.filter((_, n) => n !== i))}>删除</button></div>)}<button type="button" className="text-button" onClick={() => updateForm("blockers", [...form.blockers, { description: "", owner: "" }])}>添加阻塞项</button><h3>下一步动作</h3>{form.nextActions.map((a, i) => <div className="field-row" key={i}><input className="field-input" aria-label="下一步动作" value={a.action} onChange={e => updateForm("nextActions", form.nextActions.map((v, n) => n === i ? { ...v, action: e.target.value } : v))} /><select className="field-input" value={a.priority} onChange={e => updateForm("nextActions", form.nextActions.map((v, n) => n === i ? { ...v, priority: e.target.value } : v))}><option value="normal">普通</option><option value="high">高</option><option value="low">低</option></select><button type="button" onClick={() => updateForm("nextActions", form.nextActions.filter((_, n) => n !== i))}>删除</button></div>)}<button type="button" className="text-button" onClick={() => updateForm("nextActions", [...form.nextActions, { action: "", priority: "normal" }])}>添加动作</button></>}
        {error && <div role="alert" className="unlock-warning">{error}</div>}
        <div className="modal-actions"><button className="button button-ghost" type="button" disabled={saving} onClick={onClose}>取消</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? "保存中…" : "保存需求"}</button></div>
      </form>
    </div>
  );
}
function initialForm(r?: RequirementMeta): RequirementFormState {
  return { id: r?.requirement.id || "", name: r?.requirement.name || "", owner: r?.requirement.owner || "", plannedTestDate: r?.schedule.planned_test_date || "", plannedReleaseDate: r?.schedule.planned_release_date || "", initialStage: r?.current_stage || "collecting", applications: r?.applications.map(a => ({ ...a })) || [], blockers: (r?.blockers || []).map(b => ({ description: String(b.description || ""), owner: String(b.owner || "") })), nextActions: (r?.next_actions || []).map(a => ({ action: String(a.action || ""), priority: String(a.priority || "normal") })) };
}
function normalizeApplications(applications: ApplicationInfo[]): ApplicationInfo[] | null {
  return applications.some(a => !a.name.trim()) ? null : applications.map(a => ({ ...a, name: a.name.trim(), branch: a.branch.trim() }));
}

function yunxiaoFromRefs(refs: ExternalReference[], fallback?: RequirementYunxiao | null): RequirementYunxiao | null {
  const yunxiao = refs.filter((ref) => ref.provider_id === "yunxiao");
  const requirementRef = yunxiao.find((ref) => ref.entity_type === "requirement" || ref.role === "source");
  if (!requirementRef) return null;
  const projectRef = yunxiao.find((ref) => ref.entity_type === "project" || ref.role === "project");
  const iterationRef = yunxiao.find((ref) => ref.entity_type === "iteration" || ref.role === "iteration");
  return {
    project_id: projectRef?.external_id || requirementRef.project_ref || fallback?.project_id || "",
    project_name: projectRef?.title || fallback?.project_name || "",
    workitem_id: requirementRef.external_id,
    workitem_serial: requirementRef.display_key || fallback?.workitem_serial || "",
    workitem_subject: requirementRef.title || fallback?.workitem_subject || "",
    sprint_id: iterationRef?.external_id || fallback?.sprint_id || "",
  };
}
