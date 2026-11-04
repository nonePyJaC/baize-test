import React, { useEffect, useRef, useState } from "react";
import { api, joinPath } from "../lib/api";
import AppIcon, { type IconName } from "../components/AppIcon";
import RequirementManagementModal from "../components/RequirementManagementModal";
import { aiTaskTab } from "../components/ContextToolWindows";
import XMindImportModal from "../components/XMindImportModal";
import RequirementYunxiaoPanel from "../components/RequirementYunxiaoPanel";
import { systemOpen } from "../lib/systemOpen";
import { formatActivityTime, formatDate, formatDateTime } from "../lib/date";
import {
  activityActionLabel,
  computeStageAutoChecks,
  normalizeStageChecklist,
  recordActivity,
  stageAdvanceTarget,
  stageRetreatTarget,
} from "../lib/requirementFlow";
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type AiTaskInfo,
  type FileChanges,
  type PlatformInfo,
  type RequirementActivity,
  type RequirementMeta,
  type StageAutoCheck,
  type StageChecklistItem,
  type StageTransitionAction,
  type UnlockPreview,
  type WorkspaceConfig,
} from "../lib/types";
import type { WorkbenchTab } from "../lib/workbench";

interface RequirementOverviewViewProps {
  rootPath: string;
  workspace: WorkspaceConfig;
  platform: PlatformInfo;
  requirementId: string;
  requirementRevision?: number;
  onOpenTab: (tab: WorkbenchTab) => void;
  onRequirementChanged?: () => void;
  onAccessStateChange?: (platformId: string, requirementId: string, access: RequirementMeta["client_access"]) => void;
  onUnlockPreview?: (changes: FileChanges) => void;
  onRightContext?: import("../lib/workbench").RightContextReporter;
}

type RequirementPageView = "overview" | "activity";

interface TransitionDialogState {
  mode: StageTransitionAction;
  target: string | null;
}

export default function RequirementOverviewView({ rootPath, workspace, platform, requirementId, requirementRevision, onOpenTab, onRequirementChanged, onAccessStateChange, onUnlockPreview, onRightContext }: RequirementOverviewViewProps) {
  const [requirement, setRequirement] = useState<RequirementMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<RequirementPageView>("overview");
  const [activity, setActivity] = useState<RequirementActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [stageChecks, setStageChecks] = useState<StageAutoCheck[]>([]);
  const [relatedTasks, setRelatedTasks] = useState<AiTaskInfo[]>([]);
  const [checklistStage, setChecklistStage] = useState("");
  const [newCheckLabel, setNewCheckLabel] = useState("");
  const [checklistSaving, setChecklistSaving] = useState(false);
  const [transition, setTransition] = useState<TransitionDialogState | null>(null);
  const [transitionReason, setTransitionReason] = useState("");
  const [transitionNote, setTransitionNote] = useState("");
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [unlockPreview, setUnlockPreview] = useState<UnlockPreview | null>(null);
  const [unlockAction, setUnlockAction] = useState<"scan" | "accept" | "force" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateRequirement = (next: RequirementMeta) => {
    setRequirement(next);
    onAccessStateChange?.(platform.id, requirementId, next.client_access);
  };

  // 活动台账、自动检查、关联任务：与需求元数据分开加载，单项失败不影响主视图
  const loadAuxiliary = () => {
    api.readRequirementActivity(rootPath, platform.path, requirementId)
      .then((doc) => { setActivity(doc); setActivityError(null); })
      .catch((reason) => setActivityError(String(reason)));
    computeStageAutoChecks(rootPath, platform.path, requirementId)
      .then(setStageChecks)
      .catch(() => setStageChecks([]));
    api.listAiTasks(rootPath)
      .then((tasks) => setRelatedTasks(tasks.filter((task) => task.platform_id === platform.id && task.requirement_id === requirementId)))
      .catch(() => setRelatedTasks([]));
  };

  const load = () => {
    setLoading(true);
    api.readRequirement(rootPath, platform.path, requirementId).then(updateRequirement).catch((reason) => setError(String(reason))).finally(() => setLoading(false));
    loadAuxiliary();
  };

  useEffect(() => { load(); }, [rootPath, platform.path, requirementId, requirementRevision]);

  useEffect(() => {
    if (!moreOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !moreMenuRef.current?.contains(event.target)) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [moreOpen]);

  const locked = requirement?.client_access.mode === "locked_for_ai";
  const checklist = normalizeStageChecklist(requirement?.stage_checklist);
  const activeChecklistStage = checklistStage || requirement?.current_stage || "draft";
  const currentStageChecks = stageChecks.filter((item) => item.stage === requirement?.current_stage);

  // BB-16D/16E：上报需求业务区块大纲与需求属性
  useEffect(() => {
    if (!onRightContext) return;
    const scrollTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    const stageIndex = requirement ? Math.max(0, STAGE_ORDER.indexOf(requirement.current_stage)) : 0;
    const lockedMode = requirement?.client_access.mode === "locked_for_ai";
    onRightContext({
      objectType: "requirement",
      objectId: requirementId,
      title: requirement ? `${requirement.requirement.id} ${requirement.requirement.name}` : requirementId,
      subtitle: platform.name,
      platformId: platform.id,
      requirementId,
      readOnly: lockedMode,
      outlineTitle: "需求视图",
      outline: [
        { id: "stage", label: "流程进度", hint: `当前阶段：${requirement ? STAGE_LABELS[requirement.current_stage] : "读取中"}`, icon: "activity", onSelect: scrollTo("req-stage-section") },
        { id: "checklist", label: "阶段检查项", badge: checklist.length ? String(checklist.filter((item) => !item.done).length || undefined) : undefined, icon: "check", onSelect: scrollTo("req-checklist-section") },
        { id: "resources", label: "需求资料", icon: "file", onSelect: scrollTo("req-resources-section") },
        ...(requirement?.blockers.length ? [{ id: "blockers", label: "阻塞项", badge: String(requirement.blockers.length), icon: "alert", onSelect: scrollTo("req-blockers-section") }] : []),
        { id: "next", label: "推荐下一步", badge: requirement ? String(requirement.next_actions.length) : undefined, icon: "next", onSelect: scrollTo("req-next-section") },
        { id: "activity", label: "最近活动", badge: activity?.events.length ? String(activity.events.length) : undefined, icon: "history", onSelect: () => setView("activity") },
        { id: "schedule", label: "时间节点", icon: "clock", onSelect: scrollTo("req-side-section") },
        { id: "apps", label: "涉及应用", depth: 1, icon: "box", onSelect: scrollTo("req-side-section") },
        { id: "tasks", label: "历史AI任务", depth: 1, icon: "ai", badge: relatedTasks.length ? String(relatedTasks.length) : undefined, onSelect: scrollTo("req-tasks-section") },
      ],
      properties: requirement ? [
        { label: "需求编号", value: requirement.requirement.id, mono: true },
        { label: "需求名称", value: requirement.requirement.name },
        { label: "负责人", value: requirement.requirement.owner || "未指派" },
        { label: "当前阶段", value: `${STAGE_LABELS[requirement.current_stage] || requirement.current_stage}（${stageIndex + 1}/${STAGE_ORDER.length}）` },
        { label: "计划提测", value: formatDate(requirement.schedule.planned_test_date) },
        { label: "计划上线", value: formatDate(requirement.schedule.planned_release_date) },
        { label: "锁定状态", value: lockedMode ? `已交由AI处理${requirement.client_access.task_id ? `（${requirement.client_access.task_id}）` : ""}` : "未锁定" },
        { label: "活动记录", value: `${activity?.events.length ?? 0} 条` },
      ] : [{ label: "状态", value: "正在读取需求" }],
      stats: requirement ? [
        { label: "阻塞项", value: String(requirement.blockers.length) },
        { label: "待评审", value: String(requirement.pending_reviews.length) },
        { label: "涉及应用", value: String(requirement.applications.length) },
      ] : undefined,
    });
    return () => onRightContext(null);
  }, [onRightContext, requirement, requirementId, platform, activity, relatedTasks, checklist.length]);

  if (loading) return <div className="center-state"><span className="spinner" />正在读取需求…</div>;
  if (!requirement) return <div className="center-state"><AppIcon name="alert" size={22} /><strong>无法读取需求</strong><span>{error || "需求元数据不存在"}</span></div>;

  const currentStage = Math.max(0, STAGE_ORDER.indexOf(requirement.current_stage));
  const advanceTarget = stageAdvanceTarget(requirement.current_stage);
  const retreatTarget = stageRetreatTarget(requirement.current_stage);
  const archived = requirement.current_stage === "archived";

  const openTab = (tab: WorkbenchTab) => onOpenTab(tab);
  const openQuestions = () => openTab({ id: `questions:${platform.id}:${requirementId}`, type: "questions", title: "疑问与答复", subtitle: `${requirementId} · 需求理解与答疑`, icon: "help", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId } });
  const openCases = () => openTab({ id: `cases:${platform.id}:${requirementId}`, type: "structured-cases", title: "结构化用例", subtitle: `${platform.name} · ${requirementId}`, icon: "checks", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId } });
  const openExecution = () => openTab({ id: `test-execution:${platform.id}:${requirementId}`, type: "test-execution", title: "测试执行", subtitle: `${platform.name} · ${requirementId}`, icon: "test", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId } });
  const openCoverage = () => openTab({ id: `coverage:${platform.id}:${requirementId}`, type: "coverage", title: "覆盖追溯", subtitle: `${platform.name} · ${requirementId}`, icon: "checks", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId } });
  const openReport = () => openTab({ id: `report-generation:${platform.id}:${requirementId}`, type: "report-generation", title: "测试报告", subtitle: `${platform.name} · ${requirementId}`, icon: "file", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId } });
  const openKnowledge = () => openTab({ id: `knowledge:${platform.id}:${requirementId}`, type: "knowledge", title: "知识库", subtitle: `${platform.name} · ${requirementId} · 候选审核`, icon: "database", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId } });
  const openFolder = (folder: string, label: string) => openTab({ id: `requirement-folder:${platform.id}:${requirementId}:${folder}`, type: "requirement-folder", title: label, subtitle: `${platform.name} · ${requirementId} · ${folder}`, icon: "folder", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId, folder } });
  const openMarkdown = (name: string) => openTab({ id: `requirement-file:${platform.id}:${requirementId}:${name}`, type: "markdown", title: name, subtitle: `${requirementId} · ${name}`, icon: "markdown", preview: true, pinned: false, dirty: false, closable: true, payload: { path: joinPath(rootPath, platform.path, requirementId, "02-需求理解与答疑", name) } });
  const openTask = (task: AiTaskInfo) => openTab(aiTaskTab(task));

  // 业务视图切换：概览/活动为页内视图，其余导航到对应业务Tab
  const viewItems: { id: string; label: string; icon: IconName; badge?: number; run: () => void }[] = [
    { id: "overview", label: "概览", icon: "dashboard", run: () => setView("overview") },
    { id: "materials", label: "资料", icon: "folder", run: () => openFolder("01-需求资料", "需求资料") },
    { id: "questions", label: "答疑", icon: "help", run: openQuestions },
    { id: "plan", label: "测试计划", icon: "file", run: () => openFolder("03-测试计划", "测试计划") },
    { id: "cases", label: "用例", icon: "checks", run: openCases },
    { id: "coverage", label: "追溯", icon: "list", run: openCoverage },
    { id: "execution", label: "执行", icon: "test", run: openExecution },
    { id: "report", label: "报告", icon: "file", run: openReport },
    { id: "activity", label: "活动", icon: "activity", badge: activity?.events.length, run: () => setView("activity") },
  ];

  // 活动引用（工作区相对路径）→ 文本类打开内置Tab，其余走系统打开
  const openActivityRef = (ref: string) => {
    const absolute = joinPath(rootPath, ref);
    if (/\.(md|markdown|txt|json|ya?ml|csv|log|py|ts|tsx|js|rs|toml)$/i.test(ref)) {
      const name = ref.split("/").pop() || ref;
      openTab({ id: `file:${absolute}`, type: "markdown", title: name, subtitle: ref, icon: "markdown", preview: true, pinned: false, dirty: false, closable: true, payload: { path: absolute } });
    } else {
      void systemOpen.openFile(absolute);
    }
  };

  // —— 阶段流转 ——
  const openTransition = (mode: StageTransitionAction) => {
    setTransitionReason("");
    setTransitionNote("");
    if (mode === "advance") setTransition({ mode, target: advanceTarget });
    else if (mode === "retreat") setTransition({ mode, target: retreatTarget });
    else setTransition({ mode, target: null });
  };

  const submitTransition = async () => {
    if (!transition) return;
    setTransitionBusy(true);
    setError(null);
    try {
      const next = await api.transitionRequirementStage(rootPath, platform.path, requirementId, transition.mode, transitionReason, transitionNote);
      updateRequirement(next);
      setTransition(null);
      setChecklistStage("");
      setMessage(`阶段已更新为「${STAGE_LABELS[next.current_stage] || next.current_stage}」`);
      onRequirementChanged?.();
      loadAuxiliary();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setTransitionBusy(false);
    }
  };

  // —— 阶段检查项（人工项写回 requirement.yaml） ——
  const saveChecklist = async (items: StageChecklistItem[], summary: string) => {
    if (locked) return;
    setChecklistSaving(true);
    setError(null);
    try {
      const next = { ...requirement, stage_checklist: items };
      await api.saveRequirement(rootPath, platform.path, requirementId, next);
      updateRequirement(next);
      recordActivity(rootPath, platform.path, requirementId, { action: "checklist_updated", summary });
      loadAuxiliary();
    } catch (reason) {
      setError(`保存检查项失败：${String(reason)}`);
    } finally {
      setChecklistSaving(false);
    }
  };

  const toggleChecklistItem = (item: StageChecklistItem) => {
    const nextDone = !item.done;
    void saveChecklist(
      checklist.map((entry) => entry.id === item.id ? { ...entry, done: nextDone, done_at: nextDone ? new Date().toISOString() : null } : entry),
      `${nextDone ? "完成" : "取消"}检查项「${item.label}」`,
    );
  };

  const addChecklistItem = () => {
    const label = newCheckLabel.trim();
    if (!label) return;
    const item: StageChecklistItem = {
      id: `check-${Date.now().toString(36)}`,
      stage: activeChecklistStage,
      label,
      kind: "manual",
      done: false,
      done_at: null,
    };
    setNewCheckLabel("");
    void saveChecklist([...checklist, item], `新增检查项「${label}」（${STAGE_LABELS[item.stage] || item.stage}）`);
  };

  const removeChecklistItem = (item: StageChecklistItem) => {
    void saveChecklist(checklist.filter((entry) => entry.id !== item.id), `删除检查项「${item.label}」`);
  };

  const manualItemsForStage = checklist.filter((item) => item.stage === activeChecklistStage);
  const autoChecksForStage = stageChecks.filter((item) => item.stage === activeChecklistStage);
  const incompleteForAdvance = [
    ...currentStageChecks.filter((item) => item.status !== "passed").map((item) => item.label),
    ...checklist.filter((item) => item.stage === requirement.current_stage && !item.done).map((item) => item.label),
  ];

  const handleAiTaskCreated = async (task: AiTaskInfo) => {
    setMessage(`已生成任务 ${task.task_id}${task.requirement_locked ? "，需求目录已锁定" : ""}`);
    onRequirementChanged?.();
    try {
      updateRequirement(await api.readRequirement(rootPath, platform.path, requirementId));
    } catch (reason) {
      setError(String(reason));
    }
    loadAuxiliary();
  };

  const scanUnlock = async () => {
    setUnlockAction("scan");
    setError(null);
    try {
      const preview = await api.scanRequirementChanges(rootPath, platform.path, requirementId);
      setUnlockPreview(preview);
      onUnlockPreview?.(preview.changes);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setUnlockAction(null);
    }
  };

  const acceptUnlock = async () => {
    setUnlockAction("accept");
    setError(null);
    try {
      const result = await api.acceptUnlockRequirement(rootPath, platform.path, requirementId);
      updateRequirement(result.requirement);
      onUnlockPreview?.(result.changes);
      setUnlockPreview(null);
      setMessage(`已接受 ${result.changes.total} 项文件变化并解锁`);
      onRequirementChanged?.();
      loadAuxiliary();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setUnlockAction(null);
    }
  };

  const forceUnlock = async () => {
    if (!window.confirm("强制解锁不会逐项校验外部产物，确定继续吗？")) return;
    setUnlockAction("force");
    setError(null);
    try {
      const result = await api.forceUnlockRequirement(rootPath, platform.path, requirementId, "用户确认强制解锁");
      updateRequirement(result.requirement);
      onUnlockPreview?.(result.changes);
      setUnlockPreview(null);
      setMessage("已强制解锁；请在变化中心复核外部产物");
      onRequirementChanged?.();
      loadAuxiliary();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setUnlockAction(null);
    }
  };

  const recentEvents = activity ? [...activity.events].slice(-5).reverse() : [];

  return (
    <div className="workspace-view requirement-view">
      <section className="document-header requirement-header">
        <div className="document-title-row"><span className={`document-icon ${locked ? "amber" : "blue"}`}><AppIcon name={locked ? "lock" : "box"} size={20} /></span><div><div className="eyebrow">{platform.name} / 需求</div><h1>{requirement.requirement.id} <span>{requirement.requirement.name}</span></h1><p>{locked ? `已交由AI处理 · ${requirement.client_access.task_id || "未关联任务"}` : archived ? "需求已归档" : "当前工作区需求概览"}</p></div></div>
        <div className="header-actions">
          {locked ? (
            <button className="button button-primary" disabled={unlockAction !== null} onClick={() => void scanUnlock()}><AppIcon name="lock" size={15} /> {unlockAction === "scan" ? "扫描中…" : "解锁并查看变化"}</button>
          ) : archived ? (
            <button className="button button-primary" onClick={() => openTransition("restore")}><AppIcon name="refresh" size={15} /> 恢复需求</button>
          ) : (
            <>
              <button className="button button-primary" disabled={!advanceTarget} title={advanceTarget ? `推进到「${STAGE_LABELS[advanceTarget]}」` : "已是最后业务阶段"} onClick={() => openTransition("advance")}><AppIcon name="next" size={15} /> 推进阶段</button>
              <button className="button button-ghost" disabled={!retreatTarget} onClick={() => openTransition("retreat")}><AppIcon name="left" size={15} /> 退回阶段</button>
              <button className="button button-ghost" onClick={() => onOpenTab(aiTaskTab(undefined, platform.id, requirementId))}><AppIcon name="ai" size={15} /> AI会话</button>
            </>
          )}
          <div className="menu-wrap header-more-wrap" ref={moreMenuRef}>
            <button className="button button-ghost" aria-haspopup="menu" aria-expanded={moreOpen} onClick={(event) => { event.stopPropagation(); setMoreOpen((value) => !value); }}><AppIcon name="more" size={15} /> 更多</button>
            {moreOpen && (
              <div className="menu-dropdown header-more-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                {!locked && !archived && <button onClick={() => { setMoreOpen(false); setShowEditDialog(true); }}>编辑需求</button>}
                {!locked && !archived && <button onClick={() => { setMoreOpen(false); setShowImportDialog(true); }}>导入XMind</button>}
                <button onClick={() => { setMoreOpen(false); openKnowledge(); }}>知识候选</button>
                {!locked && !archived && <button onClick={() => { setMoreOpen(false); openTransition("archive"); }}>归档需求</button>}
                {archived && !locked && <button onClick={() => { setMoreOpen(false); openTransition("restore"); }}>恢复需求</button>}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="requirement-meta-line"><span><AppIcon name="platform" size={14} /> {platform.name}</span><span><AppIcon name="users" size={14} /> {requirement.requirement.owner || "未指派"}</span><span><AppIcon name="clock" size={14} /> 创建于 {formatDate(requirement.requirement.created_at)}</span><span className={`status-pill ${locked ? "warning" : archived ? "danger" : ""}`}>{locked ? "AI处理中" : STAGE_LABELS[requirement.current_stage] || requirement.current_stage}</span></div>

      <nav className="requirement-view-switch" aria-label="需求业务视图">
        {viewItems.map((item) => (
          <button key={item.id} className={view === item.id ? "active" : ""} onClick={item.run}>
            <AppIcon name={item.icon} size={14} /> {item.label}{item.badge ? <b>{item.badge}</b> : null}
          </button>
        ))}
      </nav>

      {view === "activity" ? (
        <section className="panel-section" id="req-activity-section">
          <div className="section-heading"><div><AppIcon name="history" size={16} /><h2>需求活动记录</h2></div><span className="section-muted">activity.json · {activity?.events.length ?? 0} 条</span></div>
          {activityError && <div className="inline-empty"><AppIcon name="alert" size={15} />活动记录读取失败：{activityError}</div>}
          {!activityError && (!activity || activity.events.length === 0) && <div className="inline-empty large"><AppIcon name="inbox" size={18} />暂无活动记录；创建、阶段流转、AI任务和用例操作都会记录在这里。</div>}
          {!activityError && activity && activity.events.length > 0 && (
            <div className="activity-list">
              {[...activity.events].reverse().map((event) => (
                <div className="activity-row" key={event.id}>
                  <span className="activity-time">{formatActivityTime(event.occurred_at)}</span>
                  <span className="status-pill">{activityActionLabel(event.action)}</span>
                  <span className="activity-summary"><strong>{event.summary || "—"}</strong>{event.object_id && <small className="mono">{event.object_id}</small>}</span>
                  {event.refs.length > 0 && (
                    <span className="activity-refs">
                      {event.refs.slice(0, 3).map((ref) => <button key={ref} className="text-button mono" title={ref} onClick={() => openActivityRef(ref)}>{ref.split("/").pop()}</button>)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <RequirementYunxiaoPanel rootPath={rootPath} platformPath={platform.path} requirement={requirement} readOnly={Boolean(locked)} onSaved={(updated) => { updateRequirement(updated); onRequirementChanged?.(); recordActivity(rootPath, platform.path, requirementId, { action: "requirement_updated", summary: "更新云效关联" }); loadAuxiliary(); }} />

          <section className="stage-panel panel-section" id="req-stage-section">
            <div className="section-heading"><div><AppIcon name="activity" size={16} /><h2>流程进度</h2></div><span className="section-muted">第 {currentStage + 1} / {STAGE_ORDER.length} 阶段</span></div>
            <div className="stage-track">{STAGE_ORDER.map((stage, index) => <div key={stage} className={`stage-track-item ${index < currentStage ? "complete" : index === currentStage ? "current" : ""}`}><span className="stage-track-dot">{index < currentStage ? <AppIcon name="check" size={11} /> : index + 1}</span><span>{STAGE_LABELS[stage]}</span></div>)}</div>
            {currentStageChecks.length > 0 && (
              <div className="stage-check-chips">
                {currentStageChecks.map((check) => (
                  <span key={check.id} className={`stage-check-chip ${check.status}`} title={`${check.source} · ${check.detail}`}>
                    <AppIcon name={check.status === "passed" ? "check" : check.status === "unavailable" ? "alert" : "clock"} size={12} />
                    {check.label}：{check.detail}
                  </span>
                ))}
              </div>
            )}
          </section>

          <div className="requirement-columns">
            <div className="requirement-main-column">
              <section className="panel-section" id="req-checklist-section">
                <div className="section-heading"><div><AppIcon name="check" size={16} /><h2>阶段检查项</h2></div>
                  <select className="field-input checklist-stage-select" value={activeChecklistStage} onChange={(event) => setChecklistStage(event.target.value)}>
                    {STAGE_ORDER.filter((stage) => stage !== "archived").map((stage) => <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>)}
                  </select>
                </div>
                {autoChecksForStage.length === 0 && manualItemsForStage.length === 0 && <div className="inline-empty">「{STAGE_LABELS[activeChecklistStage]}」暂无检查项，可在下方新增人工检查项。</div>}
                {autoChecksForStage.map((check) => (
                  <div className="check-row auto" key={check.id}>
                    <span className={`check-status ${check.status}`}><AppIcon name={check.status === "passed" ? "check" : check.status === "unavailable" ? "alert" : "clock"} size={13} /></span>
                    <span className="check-label"><strong>{check.label}</strong><small>自动 · {check.source} · {check.detail}</small></span>
                  </div>
                ))}
                {manualItemsForStage.map((item) => (
                  <div className="check-row" key={item.id}>
                    <button className={`check-box ${item.done ? "done" : ""}`} disabled={locked || checklistSaving} onClick={() => toggleChecklistItem(item)} title={item.done ? "取消完成" : "标记完成"}><AppIcon name="check" size={11} /></button>
                    <span className={`check-label ${item.done ? "done" : ""}`}><strong>{item.label}</strong><small>人工{item.done && item.done_at ? ` · 完成于 ${formatDateTime(item.done_at)}` : ""}</small></span>
                    {!locked && <button className="icon-button" disabled={checklistSaving} onClick={() => removeChecklistItem(item)} title="删除检查项"><AppIcon name="minus" size={13} /></button>}
                  </div>
                ))}
                {!locked && (
                  <div className="check-add-row">
                    <input className="field-input" value={newCheckLabel} onChange={(event) => setNewCheckLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addChecklistItem(); }} placeholder={`为「${STAGE_LABELS[activeChecklistStage]}」新增人工检查项`} disabled={checklistSaving} />
                    <button className="button button-ghost button-small" disabled={checklistSaving || !newCheckLabel.trim()} onClick={addChecklistItem}><AppIcon name="add" size={13} /> 添加</button>
                  </div>
                )}
              </section>

              <section className="panel-section" id="req-resources-section"><div className="section-heading"><div><AppIcon name="file" size={16} /><h2>需求资料</h2></div><button className="text-button" onClick={() => openFolder("01-需求资料", "需求资料")}>打开资料目录 <AppIcon name="next" size={14} /></button></div><div className="resource-list"><Resource name="需求理解.md" detail="需求理解与业务范围" icon="markdown" onClick={() => openMarkdown("需求理解.md")} /><Resource name="需求答疑.md" detail="疑问、回答与影响范围" icon="markdown" onClick={() => openMarkdown("需求答疑.md")} /></div></section>

              {requirement.blockers.length > 0 && <section className="panel-section" id="req-blockers-section"><div className="section-heading"><div><AppIcon name="alert" size={16} /><h2>阻塞项</h2></div><span className="count-badge danger">{requirement.blockers.length}</span></div>{requirement.blockers.map((item: any, index) => <div className="blocker-row" key={index}><AppIcon name="alert" size={15} /><span>{item.description || "未填写阻塞说明"}</span><small>{item.owner || "未指派"}</small></div>)}</section>}

              <section className="panel-section" id="req-next-section"><div className="section-heading"><div><AppIcon name="next" size={16} /><h2>推荐下一步</h2></div></div>{requirement.next_actions.length ? requirement.next_actions.map((item: any, index) => <div className="action-row" key={index}><span className={`priority-dot ${item.priority === "high" ? "high" : ""}`} /> <span>{item.action}</span><AppIcon name="next" size={14} /></div>) : <div className="inline-empty">暂无已记录的下一步</div>}</section>

              <section className="panel-section" id="req-activity-preview">
                <div className="section-heading"><div><AppIcon name="history" size={16} /><h2>最近活动</h2></div><button className="text-button" onClick={() => setView("activity")}>查看全部 <AppIcon name="next" size={14} /></button></div>
                {recentEvents.length === 0 ? <div className="inline-empty">暂无活动记录</div> : (
                  <div className="activity-list compact">
                    {recentEvents.map((event) => (
                      <div className="activity-row" key={event.id}>
                        <span className="activity-time">{formatActivityTime(event.occurred_at)}</span>
                        <span className="status-pill">{activityActionLabel(event.action)}</span>
                        <span className="activity-summary"><strong>{event.summary || "—"}</strong></span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <aside className="requirement-side-column" id="req-side-section">
              <section className="panel-section"><div className="section-heading"><div><AppIcon name="clock" size={16} /><h2>时间节点</h2></div></div><div className="detail-list"><DetailRow label="计划提测" value={formatDate(requirement.schedule.planned_test_date)} /><DetailRow label="计划上线" value={formatDate(requirement.schedule.planned_release_date)} /><DetailRow label="实际提测" value={formatDate(requirement.schedule.actual_test_date)} /><DetailRow label="实际上线" value={formatDate(requirement.schedule.actual_release_date)} /></div></section>
              <section className="panel-section"><div className="section-heading"><div><AppIcon name="box" size={16} /><h2>涉及应用</h2></div></div>{requirement.applications.length ? requirement.applications.map((app, index) => <div className="application-row" key={index}><span><strong>{app.name}</strong><small>{app.branch || "未设置分支"}</small></span><AppIcon name="branch" size={14} /></div>) : <div className="inline-empty">未配置应用</div>}</section>
              <section className="panel-section" id="req-tasks-section">
                <div className="section-heading"><div><AppIcon name="ai" size={16} /><h2>历史AI任务</h2></div><span className="section-muted">{relatedTasks.length} 个</span></div>
                {relatedTasks.length ? relatedTasks.slice(0, 5).map((task) => (
                  <button className="task-link-row" key={task.task_id} onClick={() => openTask(task)}>
                    <span className={`status-dot ${taskStatusClass(task)}`} />
                    <span className="task-link-body"><strong className="mono">{task.task_id}</strong><small>{task.progress.message || task.task_type}</small></span>
                    <small>{formatActivityTime(task.updated_at)}</small>
                  </button>
                )) : (
                  <div className="task-placeholder">{locked ? <><span className="status-dot status-dot-warning" /><span><strong>{requirement.client_access.task_id}</strong><small>锁定于 {formatDateTime(requirement.client_access.locked_at)}</small></span></> : <><AppIcon name="inbox" size={18} /><span><strong>暂无AI任务</strong><small>从页面上方“AI会话”开始新工作</small></span></>}</div>
                )}
              </section>
            </aside>
          </div>
        </>
      )}

      {message && <div className="toast toast-success"><AppIcon name="check" size={15} /> {message}<button onClick={() => setMessage(null)}><AppIcon name="close" size={14} /></button></div>}
      {error && <div className="toast toast-error"><AppIcon name="alert" size={15} /> {error}<button onClick={() => setError(null)}><AppIcon name="close" size={14} /></button></div>}

      {transition && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !transitionBusy && setTransition(null)}>
          <div className="modal stage-transition-modal">
            <div className="modal-header"><div><span className="eyebrow">阶段流转</span><h2>{transition.mode === "advance" ? "推进阶段" : transition.mode === "retreat" ? "退回阶段" : transition.mode === "archive" ? "归档需求" : "恢复需求"}</h2></div><button className="icon-button" onClick={() => setTransition(null)} disabled={transitionBusy}><AppIcon name="close" size={16} /></button></div>
            <p className="modal-description">
              {transition.mode === "advance" && <>当前阶段「{STAGE_LABELS[requirement.current_stage]}」→ 目标阶段「{transition.target ? STAGE_LABELS[transition.target] : "—"}」。推进结果会写回 requirement.yaml 并记录到活动台账。</>}
              {transition.mode === "retreat" && <>当前阶段「{STAGE_LABELS[requirement.current_stage]}」→ 退回「{transition.target ? STAGE_LABELS[transition.target] : "—"}」。退回必须填写原因。</>}
              {transition.mode === "archive" && <>归档后需求退出日常工作流，历史数据仍可读，可随时恢复。</>}
              {transition.mode === "restore" && <>将需求从「已归档」恢复到归档前阶段。</>}
            </p>
            {transition.mode === "advance" && (
              <div className="stage-transition-checks">
                <div className="subsection-title"><AppIcon name="check" size={14} />当前阶段检查项</div>
                {currentStageChecks.length === 0 && checklist.filter((item) => item.stage === requirement.current_stage).length === 0 && <span className="field-hint">当前阶段没有检查项。</span>}
                {currentStageChecks.map((check) => (
                  <div className="check-row auto" key={check.id}>
                    <span className={`check-status ${check.status}`}><AppIcon name={check.status === "passed" ? "check" : check.status === "unavailable" ? "alert" : "clock"} size={13} /></span>
                    <span className="check-label"><strong>{check.label}</strong><small>{check.detail}</small></span>
                  </div>
                ))}
                {checklist.filter((item) => item.stage === requirement.current_stage).map((item) => (
                  <div className="check-row" key={item.id}>
                    <span className={`check-box static ${item.done ? "done" : ""}`}><AppIcon name="check" size={11} /></span>
                    <span className={`check-label ${item.done ? "done" : ""}`}><strong>{item.label}</strong><small>人工检查项{item.done ? " · 已完成" : " · 未完成"}</small></span>
                  </div>
                ))}
                {incompleteForAdvance.length > 0 && (
                  <div className="unlock-warning"><AppIcon name="alert" size={14} /><span>未完成检查项 {incompleteForAdvance.length} 项：{incompleteForAdvance.slice(0, 4).join("、")}{incompleteForAdvance.length > 4 ? " 等" : ""}。确认后继续推进。</span></div>
                )}
              </div>
            )}
            {transition.mode === "retreat" && (
              <label className="field-label">退回原因（必填）
                <textarea className="field-input field-textarea" value={transitionReason} onChange={(event) => setTransitionReason(event.target.value)} placeholder="例如：测试计划被驳回，需要回到用例评审" disabled={transitionBusy} autoFocus />
              </label>
            )}
            {transition.mode !== "retreat" && (
              <label className="field-label">备注（可选）
                <textarea className="field-input field-textarea" value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} placeholder={transition.mode === "advance" ? "记录本次推进说明" : transition.mode === "archive" ? "记录归档原因" : "记录恢复说明"} disabled={transitionBusy} />
              </label>
            )}
            <div className="modal-actions">
              <button className="button button-ghost" disabled={transitionBusy} onClick={() => setTransition(null)}>取消</button>
              <button className="button button-primary" disabled={transitionBusy || (transition.mode === "retreat" && !transitionReason.trim()) || (transition.mode === "advance" && !transition.target)} onClick={() => void submitTransition()}>
                {transitionBusy ? "处理中…" : transition.mode === "advance" ? "确认推进" : transition.mode === "retreat" ? "确认退回" : transition.mode === "archive" ? "确认归档" : "确认恢复"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditDialog && <RequirementManagementModal workspace={workspace} platform={platform} requirement={requirement} onClose={() => setShowEditDialog(false)} onSaved={(updated) => { updateRequirement(updated); setShowEditDialog(false); onRequirementChanged?.(); loadAuxiliary(); }} />}
      {showImportDialog && <XMindImportModal workspace={workspace} initialPlatformId={platform.id} initialRequirementId={requirementId} onClose={() => setShowImportDialog(false)} onImported={(result) => { setShowImportDialog(false); setMessage(result.versionPath ? `已另存为新版本，共 ${result.caseCount} 条用例` : `已导入 cases.json，共 ${result.caseCount} 条用例${result.pendingIds?.length ? `；${result.pendingIds.length} 个已有ID待同步，请打开“外部 XMind 差异”确认` : ""}`); onRequirementChanged?.(); loadAuxiliary(); openCases(); }} />}
      {unlockPreview && <div className="modal-backdrop"><div className="modal change-modal"><div className="modal-header"><div><span className="eyebrow">AI任务交接</span><h2>确认解锁需求目录</h2></div><button className="icon-button" onClick={() => setUnlockPreview(null)} disabled={unlockAction !== null}><AppIcon name="close" size={16} /></button></div><p className="modal-description">变化已扫描，需求仍保持锁定。扫描于 {formatDateTime(unlockPreview.scanned_at)}，共发现 <strong>{unlockPreview.changes.total}</strong> 项文件变化。</p>{unlockPreview.warnings.map((warning) => <div className="unlock-warning" key={warning}><AppIcon name="alert" size={14} /><span>{warning}</span></div>)}<ChangeGroup label="新增" items={unlockPreview.changes.added} icon="add" className="added" /><ChangeGroup label="修改" items={unlockPreview.changes.modified} icon="code" className="modified" /><ChangeGroup label="删除" items={unlockPreview.changes.deleted} icon="error" className="deleted" /><MoveGroup items={unlockPreview.changes.moved} /><div className="unlock-confirm-note">“接受并解锁”会清除客户端锁并把本次变化记录写入 .blackbox/logs；“保持锁定”不会改变当前状态。</div><div className="modal-actions"><button className="button button-ghost" disabled={unlockAction !== null} onClick={() => setUnlockPreview(null)}>保持锁定</button><button className="button button-ghost danger-button" disabled={unlockAction !== null} onClick={() => void forceUnlock()}>{unlockAction === "force" ? "解锁中…" : "强制解锁"}</button><button className="button button-primary" disabled={unlockAction !== null} onClick={() => void acceptUnlock()}>{unlockAction === "accept" ? "解锁中…" : "接受变化并解锁"}</button></div></div></div>}
    </div>
  );
}

function taskStatusClass(task: AiTaskInfo): string {
  if (task.status === "failed" || task.review_status === "rejected") return "status-dot-danger";
  if (task.awaiting_confirmation || task.status === "waiting_review") return "status-dot-info";
  if (task.status === "completed") return "status-dot-success";
  return "status-dot-warning";
}

function Resource({ name, detail, icon, onClick }: { name: string; detail: string; icon: any; onClick: () => void }) { return <button className="resource-row" onClick={onClick}><span className="row-icon blue"><AppIcon name={icon} size={16} /></span><span><strong>{name}</strong><small>{detail}</small></span><AppIcon name="next" size={15} /></button>; }
function DetailRow({ label, value }: { label: string; value: string }) { return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>; }
function ChangeGroup({ label, items, icon, className }: { label: string; items: string[]; icon: any; className: string }) { if (!items.length) return null; return <div className={`change-group ${className}`}><div><AppIcon name={icon} size={14} /><strong>{label} ({items.length})</strong></div>{items.map((item, index) => <span key={index} className="mono">{item}</span>)}</div>; }
function MoveGroup({ items }: { items: { from: string; to: string }[] }) { if (!items.length) return null; return <div className="change-group moved"><div><AppIcon name="next" size={14} /><strong>移动 ({items.length})</strong></div>{items.map((item, index) => <span key={index} className="mono">{item.from} → {item.to}</span>)}</div>; }
