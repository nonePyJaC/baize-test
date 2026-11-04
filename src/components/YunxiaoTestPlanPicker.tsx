/** Legacy compatibility component. No current product callers; remove after historical consumers migrate to ExternalPlanPicker. */
import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import AppIcon from "./AppIcon";
import { normalizeTestPlanItem, testPlanLink, type YunxiaoTestPlanItem } from "../lib/yunxiaoTestPlan";
import type { RequirementYunxiao, YunxiaoMember, YunxiaoProject, YunxiaoSettings, YunxiaoSprint, YunxiaoTestPlanDraft, YunxiaoTestPlanLink } from "../lib/types";

function todayText(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function YunxiaoTestPlanPicker({ value, onChange, requirementYunxiao }: { value: YunxiaoTestPlanLink | null; onChange: (link: YunxiaoTestPlanLink | null) => void; requirementYunxiao?: RequirementYunxiao | null }) {
  const [settings, setSettings] = useState<YunxiaoSettings | null>(null);
  const [projects, setProjects] = useState<YunxiaoProject[]>([]);
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<YunxiaoTestPlanItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.loadClientPreferences().then((prefs) => { if (!cancelled) setSettings(prefs.yunxiao); });
    return () => { cancelled = true; };
  }, []);

  const ready = Boolean(settings?.access_token.trim() && settings?.organization_id);

  useEffect(() => {
    if (!settings || !ready) return;
    let cancelled = false;
    void api.listYunxiaoProjects(settings.access_token, settings.base_url, settings.organization_id)
      .then((list) => { if (!cancelled) setProjects(list); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [settings, ready]);

  const projectName = (id: string) => projects.find((project) => project.id === id)?.name || "";

  const search = async () => {
    if (!settings || !ready) return;
    setSearching(true);
    setError(null);
    try {
      const items = await api.listYunxiaoTestPlans(settings.access_token, settings.base_url, settings.organization_id, keyword.trim());
      setResults(items.map((item) => normalizeTestPlanItem(item)).filter((item): item is YunxiaoTestPlanItem => item !== null));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSearching(false);
    }
  };

  const select = (item: YunxiaoTestPlanItem) => {
    onChange(testPlanLink({ id: item.id, name: item.name, projectId: item.projectId, projectName: projectName(item.projectId), sprintId: item.sprintId }));
  };

  return (
    <div className="yunxiao-plan-picker">
      {value ? (
        <div className="yunxiao-plan-current">
          <AppIcon name="check" size={14} />
          <span><strong>{value.name}</strong> <small className="mono">{value.id}</small>{value.project_name ? <small> · {value.project_name}</small> : null}</span>
          <button className="button button-ghost button-small" type="button" onClick={() => onChange(null)}>取消关联</button>
        </div>
      ) : (
        <div className="yunxiao-plan-current muted"><span>未关联云效测试计划</span></div>
      )}
      {!ready && <div className="field-help">请先在「设置 → 云效集成」连接云效，之后才能搜索或新建测试计划。</div>}
      {ready && !value && requirementYunxiao?.project_id && <div className="field-help">需求已绑定云效项目「{requirementYunxiao.project_name || requirementYunxiao.project_id}」，新建计划默认关联该项目。</div>}
      <div className="yunxiao-plan-search">
        <input className="field-input" value={keyword} disabled={!ready || searching} placeholder="输入计划名称搜索（留空显示全部）" onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />
        <button className="button button-ghost button-small" type="button" disabled={!ready || searching} onClick={() => void search()}>{searching ? "搜索中…" : "搜索"}</button>
        <button className="button button-ghost button-small" type="button" disabled={!ready} onClick={() => setCreating(true)}><AppIcon name="add" size={13} /> 新建计划</button>
      </div>
      {error && <div className="unlock-warning"><AppIcon name="alert" size={14} /><span>{error}</span></div>}
      {results && (results.length ? (
        <div className="yunxiao-plan-results">
          {results.slice(0, 50).map((item) => (
            <button key={item.id} type="button" className={`yunxiao-plan-result ${value?.id === item.id ? "active" : ""}`} onClick={() => select(item)}>
              <strong>{item.name || "未命名测试计划"}</strong>
              <small className="mono">{item.id}</small>
              <small>{[item.startDate && item.endDate ? `${item.startDate} ~ ${item.endDate}` : "", projectName(item.projectId)].filter(Boolean).join(" · ")}</small>
            </button>
          ))}
        </div>
      ) : <div className="inline-empty">没有找到匹配的测试计划</div>)}
      {creating && settings && <CreateTestPlanDialog settings={settings} defaultName={keyword.trim()} defaultProjectId={requirementYunxiao?.project_id || ""} defaultSprintId={requirementYunxiao?.sprint_id || ""} onCreated={(link) => { onChange(link); setCreating(false); }} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function CreateTestPlanDialog({ settings, defaultName, defaultProjectId, defaultSprintId, onCreated, onClose }: { settings: YunxiaoSettings; defaultName: string; defaultProjectId?: string; defaultSprintId?: string; onCreated: (link: YunxiaoTestPlanLink) => void; onClose: () => void }) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState(todayText());
  const [endDate, setEndDate] = useState("");
  const [managerId, setManagerId] = useState(settings.user_id);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState(defaultProjectId || "");
  const [sprintId, setSprintId] = useState(defaultSprintId || "");
  const [scope, setScope] = useState<"public" | "private">("public");
  const [members, setMembers] = useState<YunxiaoMember[]>([]);
  const [projects, setProjects] = useState<YunxiaoProject[]>([]);
  const [sprints, setSprints] = useState<YunxiaoSprint[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { access_token: token, base_url: baseUrl, organization_id: orgId } = settings;
    void api.listYunxiaoOrgMembers(token, baseUrl, orgId).then((list) => { if (!cancelled) setMembers(list); }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    void api.listYunxiaoProjects(token, baseUrl, orgId).then((list) => { if (!cancelled) setProjects(list); }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [settings]);

  const sprintResetSkip = useRef(true);
  useEffect(() => {
    // 首次运行保留需求绑定带入的默认迭代，之后才随项目切换清空
    if (sprintResetSkip.current) sprintResetSkip.current = false;
    else setSprintId("");
    setSprints([]);
    if (!projectId) return;
    let cancelled = false;
    void api.listYunxiaoSprints(settings.access_token, settings.base_url, settings.organization_id, projectId)
      .then((list) => { if (!cancelled) setSprints(list); })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [projectId, settings]);

  const trimmedName = name.trim();
  const dateOrderOk = !startDate || !endDate || startDate <= endDate;
  const canSubmit = !saving && trimmedName.length > 0 && trimmedName.length <= 100 && Boolean(managerId) && dateOrderOk;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const draft: YunxiaoTestPlanDraft = {
        name: trimmedName,
        description: description.trim(),
        startDate,
        endDate,
        managerIdentifiers: managerId ? [managerId] : [],
        memberIdentifiers: memberIds.filter((id) => id !== managerId),
        projectIdentifier: projectId,
        sprintIdentifier: sprintId,
        scope,
      };
      const created = await api.createYunxiaoTestPlan(settings.access_token, settings.base_url, settings.organization_id, draft);
      const id = String(created.id || created.testPlanIdentifier || "").trim();
      if (!id) throw new Error("云效未返回测试计划ID，请到云效确认计划是否已创建");
      onCreated(testPlanLink({
        id,
        name: trimmedName,
        projectId,
        projectName: projects.find((project) => project.id === projectId)?.name,
        sprintId,
        sprintName: sprints.find((sprint) => sprint.id === sprintId)?.name,
      }));
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal yunxiao-plan-modal">
        <div className="modal-header">
          <div><span className="eyebrow">云效测试管理</span><h2>新建测试计划</h2></div>
          <button className="icon-button" type="button" disabled={saving} onClick={onClose}><AppIcon name="close" size={16} /></button>
        </div>
        <div className="yunxiao-plan-form">
          <label className="field-label">计划名称<span className="field-help">{trimmedName.length}/100</span><input className="field-input" value={name} maxLength={100} disabled={saving} placeholder="输入计划名称" onChange={(event) => setName(event.target.value)} /></label>
          <div className="yunxiao-plan-grid">
            <label className="field-label">开始日期<input className="field-input" type="date" value={startDate} disabled={saving} onChange={(event) => setStartDate(event.target.value)} /></label>
            <label className="field-label">结束日期<input className="field-input" type="date" value={endDate} disabled={saving} onChange={(event) => setEndDate(event.target.value)} /></label>
          </div>
          {!dateOrderOk && <div className="field-help">结束日期不能早于开始日期</div>}
          <label className="field-label">管理员<select className="field-input" value={managerId} disabled={saving} onChange={(event) => setManagerId(event.target.value)}><option value="">请选择管理员</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}</select></label>
          <div className="field-label">参与人<span className="field-help">可多选，可不选</span>
            <div className="yunxiao-plan-members">
              {members.map((member) => (
                <label key={member.userId} className="yunxiao-plan-member">
                  <input type="checkbox" checked={memberIds.includes(member.userId)} disabled={saving || member.userId === managerId} onChange={(event) => setMemberIds((current) => event.target.checked ? [...current, member.userId] : current.filter((id) => id !== member.userId))} />
                  <span>{member.name}</span>
                </label>
              ))}
            </div>
          </div>
          <label className="field-label">关联项目<select className="field-input" value={projectId} disabled={saving} onChange={(event) => setProjectId(event.target.value)}><option value="">不关联项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="field-label">关联迭代<select className="field-input" value={sprintId} disabled={saving || !projectId} onChange={(event) => setSprintId(event.target.value)}><option value="">不关联迭代</option>{sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}</select></label>
          <label className="field-label">公开性<select className="field-input" value={scope} disabled={saving} onChange={(event) => setScope(event.target.value as "public" | "private")}><option value="public">公开</option><option value="private">私有</option></select></label>
          <label className="field-label">描述<textarea className="field-input field-textarea" value={description} disabled={saving} placeholder="可选" onChange={(event) => setDescription(event.target.value)} /></label>
        </div>
        {error && <div className="unlock-warning"><AppIcon name="alert" size={14} /><span>{error}</span></div>}
        <div className="modal-actions">
          <button className="button button-ghost" type="button" disabled={saving} onClick={onClose}>取消</button>
          <button className="button button-primary" type="button" disabled={!canSubmit} onClick={() => void submit()}>{saving ? "新建中…" : "新建"}</button>
        </div>
      </div>
    </div>
  );
}
