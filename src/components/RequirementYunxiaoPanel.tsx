import React, { useCallback, useEffect, useMemo, useState } from "react";
import AppIcon from "./AppIcon";
import { api } from "../lib/api";
import type { ExternalReference } from "../services/integrations";
import type {
  RequirementMeta,
  YunxiaoMember,
  YunxiaoProject,
  YunxiaoSettings,
  YunxiaoSprint,
  YunxiaoWorkItem,
} from "../lib/types";

interface RequirementYunxiaoPanelProps {
  rootPath: string;
  platformPath: string;
  requirement: RequirementMeta;
  readOnly: boolean;
  onSaved: (requirement: RequirementMeta) => void;
}

interface YunxiaoBinding {
  projectId: string;
  projectName: string;
  workitemId: string;
  workitemSerial: string;
  workitemSubject: string;
  sprintId: string;
  sprintName: string;
  testTaskRefs: ExternalReference[];
  connectionId: string;
}

function isYunxiaoRef(ref: ExternalReference): boolean {
  return ref.provider_id === "yunxiao";
}

function bindingOf(requirement: RequirementMeta, organizationId: string): YunxiaoBinding {
  const legacy = requirement.yunxiao;
  const refs = (requirement.external_refs || []).filter(isYunxiaoRef);
  const requirementRef = refs.find((ref) => ref.entity_type === "requirement" || ref.role === "source");
  const projectRef = refs.find((ref) => ref.entity_type === "project" || ref.role === "project");
  const iterationRef = refs.find((ref) => ref.entity_type === "iteration" || ref.role === "iteration");
  const testTaskRefs = refs.filter((ref) => ref.role === "test_task");
  return {
    projectId: projectRef?.external_id || legacy?.project_id || "",
    projectName: projectRef?.title || legacy?.project_name || "",
    workitemId: requirementRef?.external_id || legacy?.workitem_id || "",
    workitemSerial: requirementRef?.display_key || legacy?.workitem_serial || "",
    workitemSubject: requirementRef?.title || legacy?.workitem_subject || "",
    sprintId: iterationRef?.external_id || legacy?.sprint_id || "",
    sprintName: iterationRef?.title || "",
    testTaskRefs,
    connectionId: requirementRef?.connection_id || projectRef?.connection_id || `legacy-yunxiao-${organizationId || "unverified"}`,
  };
}

function assigneeOf(item: YunxiaoWorkItem | null): { id: string; name: string } | null {
  const raw = item?.assignedTo as unknown;
  if (!raw) return null;
  if (typeof raw === "string") return { id: raw, name: raw };
  if (typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    const id = String(value.id ?? value.identifier ?? "").trim();
    const name = String(value.name ?? value.displayName ?? value.userName ?? id).trim();
    return id || name ? { id, name: name || id } : null;
  }
  return null;
}

function memberId(member: YunxiaoMember): string {
  return String(member.userId || member.id || "").trim();
}

function namedValue(value: { name?: string; displayName?: string; id?: string } | string | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.name || value.displayName || value.id || "";
}

function taskRef(binding: YunxiaoBinding, task: YunxiaoWorkItem): ExternalReference {
  return {
    connection_id: binding.connectionId,
    provider_id: "yunxiao",
    entity_type: "task",
    external_id: task.id,
    display_key: task.serialNumber || task.id,
    title: task.subject || task.serialNumber || task.id,
    linked_at: new Date().toISOString(),
    role: "test_task",
    project_ref: binding.projectId,
  };
}

export default function RequirementYunxiaoPanel({ rootPath, platformPath, requirement, readOnly, onSaved }: RequirementYunxiaoPanelProps) {
  const [settings, setSettings] = useState<YunxiaoSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [projects, setProjects] = useState<YunxiaoProject[]>([]);
  const [members, setMembers] = useState<YunxiaoMember[]>([]);
  const [sprints, setSprints] = useState<YunxiaoSprint[]>([]);
  const [subTasks, setSubTasks] = useState<YunxiaoWorkItem[]>([]);
  const [subTasksLoading, setSubTasksLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftProjectId, setDraftProjectId] = useState("");
  const [draftSprintId, setDraftSprintId] = useState("");
  const [draftWorkItem, setDraftWorkItem] = useState<YunxiaoWorkItem | null>(null);
  const [keyword, setKeyword] = useState("");
  const [searchResults, setSearchResults] = useState<YunxiaoWorkItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [taskSubject, setTaskSubject] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = Boolean(settings?.enabled && settings.access_token.trim() && settings.organization_id.trim());
  const binding = useMemo(() => bindingOf(requirement, settings?.organization_id || ""), [requirement, settings?.organization_id]);

  useEffect(() => {
    let live = true;
    void api.loadClientPreferences()
      .then((prefs) => { if (live) setSettings(prefs.yunxiao); })
      .catch((reason) => { if (live) setError(`读取云效设置失败：${String(reason)}`); })
      .finally(() => { if (live) setSettingsLoading(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!ready || !settings) return;
    let live = true;
    void api.listYunxiaoProjects(settings.access_token, settings.base_url, settings.organization_id)
      .then((list) => { if (live) setProjects(list); })
      .catch((reason) => { if (live) setError(`读取云效项目失败：${String(reason)}`); });
    void api.listYunxiaoOrgMembers(settings.access_token, settings.base_url, settings.organization_id)
      .then((list) => {
        if (!live) return;
        setMembers(list);
        setTaskAssignee((current) => current || settings.user_id || memberId(list[0] || { id: "", userId: "", name: "" }) || "");
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [ready, settings]);

  useEffect(() => {
    if (!ready || !settings || !draftProjectId) {
      setSprints([]);
      return;
    }
    let live = true;
    void api.listYunxiaoSprints(settings.access_token, settings.base_url, settings.organization_id, draftProjectId)
      .then((list) => {
        if (!live) return;
        setSprints(list);
        setDraftSprintId((current) => current && list.some((sprint) => sprint.id === current) ? current : "");
      })
      .catch((reason) => { if (live) setError(`读取云效迭代失败：${String(reason)}`); });
    return () => { live = false; };
  }, [ready, settings, draftProjectId]);

  const loadSubTasks = useCallback(async () => {
    if (!ready || !settings || !binding.projectId || !binding.workitemId) {
      setSubTasks([]);
      return;
    }
    setSubTasksLoading(true);
    try {
      setSubTasks(await api.listYunxiaoSubWorkitems(settings.access_token, settings.base_url, settings.organization_id, binding.projectId, binding.workitemId));
    } catch (reason) {
      setError(`读取云效测试子任务失败：${String(reason)}`);
    } finally {
      setSubTasksLoading(false);
    }
  }, [ready, settings, binding.projectId, binding.workitemId]);

  useEffect(() => { void loadSubTasks(); }, [loadSubTasks]);

  const persist = async (next: RequirementMeta, success: string) => {
    await api.saveRequirement(rootPath, platformPath, requirement.requirement.id, next);
    onSaved(next);
    setMessage(success);
    setError(null);
  };

  const startEdit = () => {
    setEditing(true);
    setDraftProjectId(binding.projectId || "");
    setDraftSprintId(binding.sprintId || "");
    setDraftWorkItem(binding.workitemId ? { id: binding.workitemId, serialNumber: binding.workitemSerial, subject: binding.workitemSubject } : null);
    setKeyword(binding.workitemSerial || "");
    setSearchResults(null);
    setError(null);
    setMessage(null);
  };

  const searchRequirements = async () => {
    if (!ready || !settings) return;
    if (!draftProjectId) {
      setError("请先选择云效项目");
      return;
    }
    setSearching(true);
    setError(null);
    setSearchResults(null);
    try {
      const query = keyword.trim();
      const serial = /^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(query) ? query : undefined;
      const rows = await api.searchYunxiaoWorkitems(
        settings.access_token,
        settings.base_url,
        settings.organization_id,
        draftProjectId,
        "Req",
        serial ? undefined : query || undefined,
        draftSprintId || undefined,
        undefined,
        undefined,
        serial,
      );
      setSearchResults(rows);
      if (!rows.length) setMessage("未找到匹配的云效需求，请更换项目、迭代或关键词");
    } catch (reason) {
      setError(`搜索云效需求失败：${String(reason)}`);
    } finally {
      setSearching(false);
    }
  };

  const saveBinding = async () => {
    if (!ready || !settings) return;
    if (!draftProjectId || !draftWorkItem) {
      setError("请选择云效项目和需求");
      return;
    }
    const project = projects.find((item) => item.id === draftProjectId);
    const sprint = sprints.find((item) => item.id === draftSprintId);
    const projectName = project?.name || (draftProjectId === binding.projectId ? binding.projectName : "") || draftProjectId;
    const sprintName = sprint?.name || (draftSprintId === binding.sprintId ? binding.sprintName : "") || draftSprintId;
    const connectionId = binding.connectionId || `legacy-yunxiao-${settings.organization_id || "unverified"}`;
    const now = new Date().toISOString();
    const keepTestTasks = binding.workitemId === draftWorkItem.id ? binding.testTaskRefs : [];
    const keptRefs = (requirement.external_refs || []).filter((ref) => !(isYunxiaoRef(ref) && (
      ["project", "iteration", "source", "test_task"].includes(ref.role || "")
      || ["project", "iteration", "requirement"].includes(ref.entity_type)
    )));
    const projectRef: ExternalReference | null = draftProjectId ? {
      connection_id: connectionId,
      provider_id: "yunxiao",
      entity_type: "project",
      external_id: draftProjectId,
      display_key: draftProjectId,
      title: projectName,
      linked_at: now,
      role: "project",
    } : null;
    const iterationRef: ExternalReference | null = draftSprintId ? {
      connection_id: connectionId,
      provider_id: "yunxiao",
      entity_type: "iteration",
      external_id: draftSprintId,
      display_key: draftSprintId,
      title: sprintName,
      linked_at: now,
      role: "iteration",
      project_ref: draftProjectId,
    } : null;
    const requirementRef: ExternalReference = {
      connection_id: connectionId,
      provider_id: "yunxiao",
      entity_type: "requirement",
      external_id: draftWorkItem.id,
      display_key: draftWorkItem.serialNumber || draftWorkItem.id,
      title: draftWorkItem.subject || draftWorkItem.serialNumber || draftWorkItem.id,
      linked_at: now,
      role: "source",
      project_ref: draftProjectId,
    };
    const next: RequirementMeta = {
      ...requirement,
      yunxiao: {
        project_id: draftProjectId,
        project_name: projectName,
        workitem_id: draftWorkItem.id,
        workitem_serial: draftWorkItem.serialNumber || "",
        workitem_subject: draftWorkItem.subject || "",
        sprint_id: draftSprintId || "",
      },
      external_refs: [
        ...keptRefs,
        ...(projectRef ? [projectRef] : []),
        ...(iterationRef ? [iterationRef] : []),
        requirementRef,
        ...keepTestTasks,
      ],
    };
    setBusy(true);
    setError(null);
    try {
      await persist(next, `已绑定云效需求：${draftWorkItem.serialNumber || draftWorkItem.id}`);
      setEditing(false);
    } catch (reason) {
      setError(`保存云效关联失败：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const syncOwner = async () => {
    if (!ready || !settings || !binding.workitemId) return;
    setBusy(true);
    setError(null);
    try {
      const item = await api.getYunxiaoWorkitem(settings.access_token, settings.base_url, settings.organization_id, binding.workitemId);
      const assignee = assigneeOf(item);
      if (!assignee) throw new Error("云效需求未设置负责人");
      const next: RequirementMeta = {
        ...requirement,
        requirement: { ...requirement.requirement, owner: assignee.name || assignee.id },
      };
      await persist(next, `已同步云效负责人：${assignee.name || assignee.id}`);
    } catch (reason) {
      setError(`同步云效负责人失败：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const openTaskForm = () => {
    setTaskFormOpen(true);
    setTaskSubject(`[测试] ${binding.workitemSubject || requirement.requirement.name}`);
    setTaskAssignee(settings?.user_id || memberId(members[0] || { id: "", userId: "", name: "" }) || "");
    setError(null);
    setMessage(null);
  };

  const createTask = async () => {
    if (!ready || !settings || !binding.projectId || !binding.workitemId) return;
    const subject = taskSubject.trim() || `[测试] ${binding.workitemSubject || requirement.requirement.name}`;
    const assignee = taskAssignee.trim() || settings.user_id;
    if (!assignee) {
      setError("请选择测试子任务负责人；可在「设置 → 云效集成」校验令牌后使用当前用户");
      return;
    }
    setTaskBusy(true);
    setError(null);
    try {
      // 创建前先刷新子任务，已有测试子任务时直接复用/关联，避免重复创建。
      const latest = await api.listYunxiaoSubWorkitems(
        settings.access_token,
        settings.base_url,
        settings.organization_id,
        binding.projectId,
        binding.workitemId,
      );
      setSubTasks(latest);
      const existing = latest.find((task) =>
        /^\s*\[测试\]/.test(task.subject || "")
        || binding.testTaskRefs.some((ref) => ref.external_id === task.id),
      );
      if (existing) {
        const alreadyLinked = (requirement.external_refs || []).some((item) =>
          isYunxiaoRef(item) && item.role === "test_task" && item.external_id === existing.id,
        );
        if (!alreadyLinked) {
          const ref = taskRef(binding, existing);
          const nextRefs = (requirement.external_refs || []).filter((item) =>
            !(isYunxiaoRef(item) && item.role === "test_task" && item.external_id === existing.id),
          );
          await persist(
            { ...requirement, external_refs: [...nextRefs, ref] },
            `当前需求下已有测试子任务 ${existing.serialNumber || existing.id}，已自动关联，未重复创建`,
          );
        } else {
          setMessage(`当前需求下已关联测试子任务 ${existing.serialNumber || existing.id}，未重复创建`);
        }
        setTaskFormOpen(false);
        await loadSubTasks();
        return;
      }
      const created = await api.createYunxiaoTestTask(
        settings.access_token,
        settings.base_url,
        settings.organization_id,
        binding.projectId,
        binding.workitemId,
        binding.sprintId || "",
        subject,
        assignee,
      );
      if (!created.id) throw new Error("云效未返回测试子任务ID");
      const ref = taskRef(binding, created);
      const nextRefs = (requirement.external_refs || []).filter((item) => !(isYunxiaoRef(item) && item.role === "test_task" && item.external_id === created.id));
      const next: RequirementMeta = { ...requirement, external_refs: [...nextRefs, ref] };
      await persist(next, `已创建云效测试子任务：${created.serialNumber || created.id}`);
      setTaskFormOpen(false);
      await loadSubTasks();
    } catch (reason) {
      setError(`创建云效测试子任务失败：${String(reason)}`);
    } finally {
      setTaskBusy(false);
    }
  };

  const linkTask = async (task: YunxiaoWorkItem) => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const ref = taskRef(binding, task);
      const nextRefs = (requirement.external_refs || []).filter((item) => !(isYunxiaoRef(item) && item.role === "test_task" && item.external_id === task.id));
      const next: RequirementMeta = { ...requirement, external_refs: [...nextRefs, ref] };
      await persist(next, `已关联测试子任务：${task.serialNumber || task.id}`);
    } catch (reason) {
      setError(`关联测试子任务失败：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const unlinkTask = async (task: YunxiaoWorkItem) => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const nextRefs = (requirement.external_refs || []).filter((item) => !(isYunxiaoRef(item) && item.role === "test_task" && item.external_id === task.id));
      const next: RequirementMeta = { ...requirement, external_refs: nextRefs };
      await persist(next, `已取消关联测试子任务：${task.serialNumber || task.id}`);
    } catch (reason) {
      setError(`取消关联测试子任务失败：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const memberOptions = members
    .map((member) => ({ id: memberId(member), name: member.name || member.email || memberId(member) }))
    .filter((member) => member.id);
  const currentUserOption = settings?.user_id && !memberOptions.some((member) => member.id === settings.user_id)
    ? [{ id: settings.user_id, name: settings.user_name || "当前用户" }]
    : [];
  const linkedTaskIds = new Set(binding.testTaskRefs.map((ref) => ref.external_id));

  return (
    <section className="panel-section requirement-yunxiao-panel">
      <div className="section-heading">
        <div><AppIcon name="platform" size={16} /><h2>云效关联</h2></div>
        <div className="section-heading-actions">
          <span className="section-muted">{binding.workitemId ? "已绑定" : "未绑定"}</span>
          {!readOnly && ready && <button className="button button-ghost button-small" type="button" onClick={startEdit}><AppIcon name="link" size={13} /> {binding.workitemId ? "重新绑定" : "绑定云效需求"}</button>}
        </div>
      </div>
      <p className="section-description">维护需求关联的云效项目、需求、迭代和测试子任务；负责人可从云效同步，测试子任务会创建在绑定的云效需求下。</p>

      {settingsLoading && <div className="inline-empty large"><span className="spinner" />正在读取云效设置…</div>}
      {!settingsLoading && !ready && <div className="inline-empty large"><AppIcon name="alert" size={18} /><div><strong>尚未配置云效令牌或组织</strong><span>请到「设置 → 云效集成」填写个人访问令牌并校验组织，再回到这里维护关联。</span></div></div>}

      {editing && ready && <div className="yunxiao-binding-form">
        <div className="form-section-heading"><strong>绑定云效需求</strong><button className="text-button" type="button" onClick={() => setEditing(false)} disabled={busy}>取消</button></div>
        <div className="yunxiao-binding-form-grid">
          <label className="field-label">云效项目<select className="field-input" value={draftProjectId} onChange={(event) => { setDraftProjectId(event.target.value); setDraftWorkItem(null); setSearchResults(null); }} disabled={busy}>
            <option value="">请选择云效项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <label className="field-label">迭代（可选）<select className="field-input" value={draftSprintId} onChange={(event) => setDraftSprintId(event.target.value)} disabled={busy || !draftProjectId}>
            <option value="">不绑定迭代</option>
            {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
          </select></label>
          <label className="field-label yunxiao-binding-wide">搜索云效需求<span className="field-help">支持需求编号（如 DEMO-1000）或标题关键词</span>
            <div className="yunxiao-search-row">
              <input className="field-input" value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchRequirements(); } }} placeholder="输入需求编号或标题关键词" disabled={busy || !draftProjectId} />
              <button className="button button-ghost button-small" type="button" onClick={() => void searchRequirements()} disabled={searching || busy || !draftProjectId}>{searching ? <span className="spinner" /> : <AppIcon name="search" size={13} />} 搜索</button>
            </div>
          </label>
        </div>
        {draftWorkItem && <div className="yunxiao-selected"><strong>{draftWorkItem.serialNumber || draftWorkItem.id}</strong> · {draftWorkItem.subject || "未命名需求"}{assigneeOf(draftWorkItem) && <span> · 负责人：{assigneeOf(draftWorkItem)?.name}</span>}</div>}
        {searchResults && searchResults.length > 0 && <div className="yunxiao-search-results">
          {searchResults.slice(0, 30).map((item) => <button key={item.id} type="button" className={`yunxiao-search-result ${draftWorkItem?.id === item.id ? "active" : ""}`} onClick={() => setDraftWorkItem(item)}>
            <strong>{item.serialNumber || item.id} · {item.subject || "未命名需求"}</strong>
            <small>{[item.status?.name, assigneeOf(item)?.name, item.sprint?.name].filter(Boolean).join(" · ") || "云效需求"}</small>
          </button>)}
        </div>}
        <div className="modal-actions"><button className="button button-primary button-small" type="button" onClick={() => void saveBinding()} disabled={busy || !draftProjectId || !draftWorkItem}>{busy ? <span className="spinner" /> : <AppIcon name="save" size={13} />} 保存绑定</button></div>
      </div>}

      {!editing && binding.workitemId && <article className="yunxiao-binding-card">
        <div className="yunxiao-binding-card-header">
          <div className="yunxiao-binding-title">
            <span className="row-icon blue"><AppIcon name="platform" size={16} /></span>
            <div><strong>{binding.workitemSerial || "云效需求"}</strong><small>{binding.workitemSubject || "未读取需求标题"}</small></div>
          </div>
          <span className="status-pill success">已绑定</span>
        </div>
        <div className="yunxiao-binding-grid">
          <div className="yunxiao-meta-item"><span>云效项目</span><strong title={binding.projectName || binding.projectId}>{binding.projectName || binding.projectId || "未绑定"}</strong></div>
          <div className="yunxiao-meta-item"><span>云效需求</span><strong title={binding.workitemSubject}>{binding.workitemSerial || binding.workitemId}</strong></div>
          <div className="yunxiao-meta-item"><span>迭代</span><strong title={binding.sprintName || binding.sprintId}>{binding.sprintName || binding.sprintId || "未绑定"}</strong></div>
          <div className="yunxiao-meta-item"><span>负责人</span><strong>{requirement.requirement.owner || "未指派"}</strong></div>
        </div>
        <div className="yunxiao-binding-actions">
          {!readOnly && ready && <button className="button button-ghost button-small" type="button" onClick={() => void syncOwner()} disabled={busy}><AppIcon name="users" size={13} /> 同步云效负责人</button>}
          {!readOnly && ready && <button className="button button-ghost button-small" type="button" onClick={openTaskForm} disabled={taskBusy}><AppIcon name="add" size={13} /> 创建测试子任务</button>}
          {!readOnly && ready && <button className="button button-ghost button-small" type="button" onClick={() => void loadSubTasks()} disabled={subTasksLoading}><AppIcon name="refresh" size={13} /> 刷新子任务</button>}
          {readOnly && <span className="field-help">需求已锁定，云效关联只读</span>}
        </div>
      </article>}

      {!editing && !binding.workitemId && !settingsLoading && ready && <div className="inline-empty large"><AppIcon name="link" size={19} /><div><strong>尚未绑定云效需求</strong><span>绑定后可同步负责人、创建测试子任务，并在提交缺陷时挂到对应云效需求下。</span></div>{!readOnly && <button className="button button-primary button-small" type="button" onClick={startEdit}>绑定云效需求</button>}</div>}

      {ready && binding.workitemId && <div className="yunxiao-task-section">
        <div className="yunxiao-task-heading"><div><AppIcon name="review" size={14} /><strong>云效测试子任务（{subTasks.length}）</strong></div>{subTasksLoading && <span className="spinner" />}</div>
        {taskFormOpen && !readOnly && <div className="yunxiao-task-form">
          <div className="yunxiao-task-form-grid">
            <label className="field-label">子任务标题<input className="field-input" value={taskSubject} onChange={(event) => setTaskSubject(event.target.value)} disabled={taskBusy} /></label>
            <label className="field-label">负责人<select className="field-input" value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)} disabled={taskBusy}>
              <option value="">请选择负责人</option>
              {[...currentUserOption, ...memberOptions].map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select></label>
          </div>
          <div className="modal-actions"><button className="button button-ghost button-small" type="button" onClick={() => setTaskFormOpen(false)} disabled={taskBusy}>取消</button><button className="button button-primary button-small" type="button" onClick={() => void createTask()} disabled={taskBusy}>{taskBusy ? <span className="spinner" /> : <AppIcon name="add" size={13} />} 创建测试子任务</button></div>
        </div>}
        {!subTasksLoading && subTasks.length === 0 && <div className="inline-empty">暂无测试子任务{!readOnly && ready ? "，可点击「创建测试子任务」新建。" : "。"}</div>}
        {subTasks.length > 0 && <div className="yunxiao-task-list">
          {subTasks.map((task) => {
            const linked = linkedTaskIds.has(task.id);
            return <div className="yunxiao-task-row" key={task.id}>
              <div><strong>{task.serialNumber || task.id} · {task.subject || "未命名子任务"}</strong><small>{[namedValue(task.status), assigneeOf(task)?.name].filter(Boolean).join(" · ") || "云效任务"}</small></div>
              <div className="yunxiao-task-actions">
                {linked ? <><span className="status-pill success">已关联</span>{!readOnly && <button className="text-button" type="button" onClick={() => void unlinkTask(task)} disabled={busy}>取消关联</button>}</> : <button className="button button-ghost button-small" type="button" onClick={() => void linkTask(task)} disabled={readOnly || busy}><AppIcon name="link" size={13} /> 关联</button>}
              </div>
            </div>;
          })}
        </div>}
      </div>}

      {message && <div className="inline-notice success"><AppIcon name="success" size={14} /><span>{message}</span><button type="button" onClick={() => setMessage(null)}><AppIcon name="close" size={13} /></button></div>}
      {error && <div className="inline-notice danger"><AppIcon name="error" size={14} /><span>{error}</span><button type="button" onClick={() => setError(null)}><AppIcon name="close" size={13} /></button></div>}
    </section>
  );
}
