import { aiSessionRuntime } from "../lib/aiSessionRuntime";
import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import AppIcon, { type IconName } from "../components/AppIcon";
import XMindImportModal from "../components/XMindImportModal";
import { api, joinPath } from "../lib/api";
import { formatDate } from "../lib/date";
import {
  type AiTaskInfo,
  type PlatformInfo,
  type QuestionsData,
  type RequirementMeta,
  type WorkspaceConfig,
  type WorkspaceEvent,
} from "../lib/types";
import type { WorkbenchNav, WorkbenchTab } from "../lib/workbench";

interface WorkspaceHomeViewProps {
  workspace: WorkspaceConfig;
  /** 需求相关变化后递增，驱动首页数据刷新 */
  requirementRevision?: number;
  /** 最新工作区文件事件，驱动首页数据刷新 */
  latestEvent?: WorkspaceEvent | null;
  /** 最近打开/关闭的工作台Tab，作为“最近工作”的真实数据 */
  recentTabs?: WorkbenchTab[];
  onNavigate: (nav: WorkbenchNav) => void;
  onOpenTab: (tab: WorkbenchTab) => void;
  onCreateRequirement: (platform?: PlatformInfo) => void;
  onWorkspaceChange?: (workspace: WorkspaceConfig) => void;
  onRightContext?: import("../lib/workbench").RightContextReporter;
}

/** 首页聚合的单需求摘要：元数据 + 关键业务文件探测结果 */
interface RequirementDigest {
  platform: PlatformInfo;
  requirement: RequirementMeta;
  p0Open: number;
  pendingReviewCases: number;
  caseCount: number;
  versionCount: number;
  runCount: number;
  reportCount: number;
}

const QUESTIONS_REL = joinPath("02-需求理解与答疑", "questions.json");
const CASES_REL = joinPath("04-测试用例", "cases.json");
const VERSIONS_REL = joinPath("04-测试用例", "versions");
const EXECUTION_REL = "06-测试执行与证据";
const REPORT_REL = "07-测试报告";
const PLAN_REL = "03-测试计划";

function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const target = new Date(`${date}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export default function WorkspaceHomeView({ workspace, requirementRevision, latestEvent, recentTabs, onNavigate, onOpenTab, onCreateRequirement, onRightContext }: WorkspaceHomeViewProps) {
  const rootPath = workspace.workspace.root_path;
  const sessionStates = useSyncExternalStore(aiSessionRuntime.subscribe,aiSessionRuntime.getSnapshot);
  const runningSessions = [...sessionStates.values()].filter(s => s.rootPath === rootPath && s.busy).length;
  const [digests, setDigests] = useState<RequirementDigest[]>([]);
  const [tasks, setTasks] = useState<AiTaskInfo[]>([]);
  const [showXmindImport, setShowXmindImport] = useState(false);
  const [xmindTarget, setXmindTarget] = useState<{ platformId?: string; requirementId?: string }>({});

  // 加载需求摘要：扫描全部平台需求，再逐需求探测 questions/cases/versions/runs/reports
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const options: { platform: PlatformInfo; requirement: RequirementMeta }[] = [];
      for (const platform of workspace.platforms) {
        const items = await api.scanRequirements(rootPath, platform.path).catch(() => []);
        items.forEach((requirement) => options.push({ platform, requirement }));
      }
      const next = await Promise.all(options.map(async ({ platform, requirement }) => {
        const reqDir = joinPath(rootPath, platform.path, requirement.requirement.id);
        let p0Open = 0;
        let pendingReviewCases = 0;
        let caseCount = 0;
        let versionCount = 0;
        let runCount = 0;
        let reportCount = 0;
        const questions = await api.readJsonFile(joinPath(reqDir, QUESTIONS_REL)).catch(() => null) as QuestionsData | null;
        if (questions && Array.isArray(questions.questions)) {
          p0Open = questions.questions.filter((item) => item.priority === "P0" && !["answered", "no_need", "void"].includes(item.status)).length;
        }
        const cases = await api.readJsonFile(joinPath(reqDir, CASES_REL)).catch(() => null);
        if (cases && Array.isArray(cases.cases)) {
          caseCount = cases.cases.length;
          pendingReviewCases = cases.cases.filter((item: { status?: string }) => item.status === "pending_review").length;
        }
        const versions = await api.listDirectory(joinPath(reqDir, VERSIONS_REL)).catch(() => []);
        versionCount = versions.filter((entry) => entry.is_dir && !entry.name.startsWith(".")).length;
        const runs = await api.listDirectory(joinPath(reqDir, EXECUTION_REL)).catch(() => []);
        runCount = runs.filter((entry) => entry.is_dir).length;
        const reports = await api.listDirectory(joinPath(reqDir, REPORT_REL)).catch(() => []);
        reportCount = reports.length;
        return { platform, requirement, p0Open, pendingReviewCases, caseCount, versionCount, runCount, reportCount };
      }));
      if (!cancelled) setDigests(next);
    };
    void load();
    api.listAiTasks(rootPath).then((list) => { if (!cancelled) setTasks(list); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [rootPath, workspace.platforms, latestEvent, requirementRevision]);

  // BB-16E：首页上报右侧上下文（概览区块大纲 + 工作区属性）
  useEffect(() => {
    if (!onRightContext) return;
    const scrollTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    onRightContext({
      objectType: "workspace",
      objectId: workspace.workspace.name || "workspace",
      title: workspace.workspace.name || "工作区首页",
      subtitle: rootPath,
      outlineTitle: "首页区块",
      outline: [
        { id: "metrics", label: "工作区统计", icon: "dashboard", onSelect: scrollTo("home-metrics") },
        { id: "recent", label: "最近工作", icon: "history", onSelect: scrollTo("home-recent") },
        { id: "mywork", label: "我的工作", icon: "list", onSelect: scrollTo("home-mywork") },
        { id: "timeline", label: "时间节点", icon: "clock", onSelect: scrollTo("home-timeline") },
        { id: "issues", label: "工作区异常", icon: "alert", onSelect: scrollTo("home-issues") },
        { id: "platforms", label: "平台与项目", icon: "platform", onSelect: scrollTo("home-platforms") },
        { id: "next", label: "建议下一步", icon: "next", onSelect: scrollTo("home-next") },
      ],
      properties: [
        { label: "工作区", value: workspace.workspace.name || "未命名" },
        { label: "根目录", value: rootPath, mono: true },
        { label: "平台数", value: String(workspace.platforms.length) },
        { label: "需求数", value: String(digests.length) },
        { label: "历史AI任务", value: String(tasks.length) },
      ],
      stats: [
        { label: "进行中需求", value: String(digests.filter((item) => !["completed", "archived"].includes(item.requirement.current_stage)).length) },
        { label: "待办事项", value: String(digests.reduce((sum, item) => sum + item.requirement.next_actions.length, 0)) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, workspace, rootPath, digests, tasks.length]);

  const metrics = useMemo(() => {
    const inProgress = digests.filter((item) => !["completed", "archived"].includes(item.requirement.current_stage));
    const p0Total = digests.reduce((sum, item) => sum + item.p0Open, 0);
    const reviewTotal = digests.reduce((sum, item) => sum + item.pendingReviewCases, 0);
    const blocked = digests.filter((item) => item.requirement.blockers.length > 0);
    const busyTasks = tasks.filter((task) => ["pending", "running", "waiting_review"].includes(task.status) || task.awaiting_confirmation);
    const locked = digests.filter((item) => item.requirement.client_access.mode === "locked_for_ai");
    const upcoming = digests.filter((item) => {
      if (["completed", "archived"].includes(item.requirement.current_stage)) return false;
      const days = daysUntil(item.requirement.schedule.planned_test_date);
      return days !== null && days <= 14;
    });
    return { inProgress, p0Total, reviewTotal, blocked, busyTasks, locked, upcoming };
  }, [digests, tasks]);

  const timeline = useMemo(() => {
    const entries: { requirement: RequirementMeta; platform: PlatformInfo; kind: "提测" | "上线"; date: string; days: number }[] = [];
    for (const { platform, requirement } of digests) {
      if (requirement.current_stage === "archived") continue;
      const testDays = daysUntil(requirement.schedule.planned_test_date);
      if (testDays !== null && !requirement.schedule.actual_test_date) entries.push({ platform, requirement, kind: "提测", date: requirement.schedule.planned_test_date!, days: testDays });
      const releaseDays = daysUntil(requirement.schedule.planned_release_date);
      if (releaseDays !== null && !requirement.schedule.actual_release_date) entries.push({ platform, requirement, kind: "上线", date: requirement.schedule.planned_release_date!, days: releaseDays });
    }
    return entries.sort((left, right) => left.date.localeCompare(right.date)).slice(0, 7);
  }, [digests]);

  const issues = useMemo(() => {
    const list: { id: string; icon: IconName; title: string; detail: string; open: () => void }[] = [];
    tasks.filter((task) => task.status === "failed" || task.review_status === "rejected").slice(0, 4).forEach((task) => {
      list.push({ id: `task-${task.task_id}`, icon: "ai", title: `历史任务失败 ${task.task_id}`, detail: task.progress.message || task.task_type, open: () => onOpenTab(aiTaskHomeTab(task)) });
    });
    digests.filter((item) => item.requirement.client_access.mode === "locked_for_ai").slice(0, 4).forEach((item) => {
      list.push({ id: `lock-${item.requirement.requirement.id}`, icon: "lock", title: `需求锁定 ${item.requirement.requirement.id}`, detail: `任务 ${item.requirement.client_access.task_id || "未关联"}`, open: () => onOpenTab(requirementTab(item.platform, item.requirement)) });
    });
    digests.filter((item) => {
      const days = daysUntil(item.requirement.schedule.planned_test_date);
      return days !== null && days < 0 && !["completed", "archived"].includes(item.requirement.current_stage);
    }).slice(0, 4).forEach((item) => {
      list.push({ id: `overdue-${item.requirement.requirement.id}`, icon: "clock", title: `提测逾期 ${item.requirement.requirement.id}`, detail: `计划提测 ${formatDate(item.requirement.schedule.planned_test_date)}`, open: () => onOpenTab(requirementTab(item.platform, item.requirement)) });
    });
    return list.slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digests, tasks]);

  const myWork = useMemo(() => {
    const list: { id: string; requirement: RequirementMeta; platform: PlatformInfo; kind: "blocker" | "action"; text: string; meta: string }[] = [];
    for (const { platform, requirement } of digests) {
      if (["completed", "archived"].includes(requirement.current_stage)) continue;
      requirement.blockers.forEach((item: { description?: string; owner?: string }, index: number) => {
        list.push({ id: `b-${requirement.requirement.id}-${index}`, platform, requirement, kind: "blocker", text: item.description || "未填写阻塞说明", meta: `${requirement.requirement.id} · ${item.owner || "未指派"}` });
      });
      requirement.next_actions.forEach((item: { action?: string; priority?: string }, index: number) => {
        if (item.action) list.push({ id: `a-${requirement.requirement.id}-${index}`, platform, requirement, kind: "action", text: item.action, meta: `${requirement.requirement.id} · ${item.priority === "high" ? "高优先级" : "普通"}` });
      });
    }
    return list.slice(0, 8);
  }, [digests]);

  // —— Tab 工厂 ——
  const requirementTab = (platform: PlatformInfo, requirement: RequirementMeta): WorkbenchTab => ({
    id: `requirement:${platform.id}:${requirement.requirement.id}`, type: "requirement", title: requirement.requirement.id, subtitle: platform.name, icon: "box", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId: requirement.requirement.id },
  });
  const questionsTab = (option: RequirementDigest): WorkbenchTab => ({
    id: `questions:${option.platform.id}:${option.requirement.requirement.id}`, type: "questions", title: "疑问与答复", subtitle: `${option.requirement.requirement.id} · 需求理解与答疑`, icon: "help", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: option.platform.id, platformPath: option.platform.path, requirementId: option.requirement.requirement.id },
  });
  const casesTab = (option: RequirementDigest): WorkbenchTab => ({
    id: `cases:${option.platform.id}:${option.requirement.requirement.id}`, type: "structured-cases", title: "结构化用例", subtitle: `${option.platform.name} · ${option.requirement.requirement.id}`, icon: "checks", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: option.platform.id, platformPath: option.platform.path, requirementId: option.requirement.requirement.id, focus: "versions" },
  });
  const executionTab = (option: RequirementDigest): WorkbenchTab => ({
    id: `test-execution:${option.platform.id}:${option.requirement.requirement.id}`, type: "test-execution", title: "测试执行", subtitle: `${option.platform.name} · ${option.requirement.requirement.id}`, icon: "test", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: option.platform.id, platformPath: option.platform.path, requirementId: option.requirement.requirement.id },
  });
  const reportTab = (option: RequirementDigest): WorkbenchTab => ({
    id: `report-generation:${option.platform.id}:${option.requirement.requirement.id}`, type: "report-generation", title: "测试报告", subtitle: `${option.platform.name} · ${option.requirement.requirement.id}`, icon: "file", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: option.platform.id, platformPath: option.platform.path, requirementId: option.requirement.requirement.id },
  });
  const aiTaskHomeTab = (task: AiTaskInfo): WorkbenchTab => ({
    id: "ai-tasks", type: "ai-task", title: "历史AI任务", subtitle: task.task_id, icon: "ai", preview: false, pinned: true, dirty: false, closable: true, payload: { taskId: task.task_id, platformId: task.platform_id, requirementId: task.requirement_id, focusKey: Date.now() },
  });
  const knowledgeTab = (): WorkbenchTab => ({
    id: "knowledge", type: "knowledge", title: "知识库", subtitle: "通用与平台知识", icon: "database", preview: false, pinned: true, dirty: false, closable: true, payload: {},
  });

  // —— 建议下一步目标选择 ——
  const firstP0 = digests.find((item) => item.p0Open > 0) || digests.find((item) => !["completed", "archived"].includes(item.requirement.current_stage));
  const firstForVersion = digests.find((item) => item.caseCount > 0 && item.versionCount === 0) || digests.find((item) => item.caseCount > 0);
  const firstForRun = digests.find((item) => item.versionCount > 0 && item.runCount === 0) || digests.find((item) => item.versionCount > 0);
  const firstForReport = digests.find((item) => item.runCount > 0);
  const firstInProgress = digests.find((item) => !["completed", "archived"].includes(item.requirement.current_stage));
  const firstReview = digests.find((item) => item.pendingReviewCases > 0) || firstForVersion;

  const openQuestions = () => { if (firstP0) onOpenTab(questionsTab(firstP0)); else onNavigate("requirements"); };
  const openReviewCases = () => { if (firstReview) onOpenTab(casesTab(firstReview)); else onNavigate("tests"); };
  const openBlocked = () => { if (metrics.blocked[0]) onOpenTab(requirementTab(metrics.blocked[0].platform, metrics.blocked[0].requirement)); else onNavigate("requirements"); };
  const openXmind = () => {
    setXmindTarget(firstInProgress ? { platformId: firstInProgress.platform.id, requirementId: firstInProgress.requirement.requirement.id } : {});
    setShowXmindImport(true);
  };

  const nextSteps: { icon: IconName; title: string; detail: string; run?: () => void }[] = [
    { icon: "add", title: "创建标准需求", detail: "requirement.yaml + 标准目录结构", run: () => onCreateRequirement() },
    { icon: "help", title: "打开待回答疑问", detail: firstP0 && firstP0.p0Open > 0 ? `${firstP0.requirement.requirement.id} 有 ${firstP0.p0Open} 条P0` : "进入需求答疑视图", run: openQuestions },
    { icon: "markdown", title: "导入XMind", detail: firstInProgress ? `默认目标 ${firstInProgress.requirement.requirement.id}` : "导入为结构化用例", run: openXmind },
    { icon: "commit", title: "提交用例版本", detail: firstForVersion ? `${firstForVersion.requirement.requirement.id} · ${firstForVersion.caseCount}条用例/${firstForVersion.versionCount}版本` : "在结构化用例中提交版本", run: () => { if (firstForVersion) onOpenTab(casesTab(firstForVersion)); else onNavigate("tests"); } },
    { icon: "test", title: "创建测试轮次", detail: firstForRun ? `${firstForRun.requirement.requirement.id} · ${firstForRun.versionCount}个版本` : "选择已评审版本执行", run: () => { if (firstForRun) onOpenTab(executionTab(firstForRun)); else onNavigate("execution"); } },
    { icon: "file", title: "生成报告", detail: firstForReport ? `${firstForReport.requirement.requirement.id} · ${firstForReport.runCount}个轮次` : "从测试轮次生成报告", run: () => { if (firstForReport) onOpenTab(reportTab(firstForReport)); else onNavigate("execution"); } },
    { icon: "database", title: "审核知识候选", detail: "候选知识待人工审核发布", run: () => onOpenTab(knowledgeTab()) },
  ];

  const recentList = (recentTabs || []).slice(0, 8);

  return (
    <div className="workspace-view home-view">
      <section className="welcome-row">
        <div className="welcome-badge"><AppIcon name="home" size={16} /><div><strong>{workspace.workspace.name || "测试工作区"}</strong><small>{rootPath}</small></div></div>
        <div className="welcome-actions"><button className="button button-ghost" onClick={() => onNavigate("settings")}><AppIcon name="settings" size={15} /> 工作区设置</button><button className="button button-primary" onClick={() => onCreateRequirement()}><AppIcon name="add" size={15} /> 新建需求</button></div>
      </section>

      <section className="metric-grid home-metrics" id="home-metrics">
        <Metric icon="box" label="进行中需求" value={String(metrics.inProgress.length)} tone="blue" onViewAll={() => onNavigate("requirements")} />
        <Metric icon="help" label="P0待回答疑问" value={String(metrics.p0Total)} tone="violet" onViewAll={openQuestions} />
        <Metric icon="review" label="待评审用例" value={String(metrics.reviewTotal)} tone="amber" onViewAll={openReviewCases} />
        <Metric icon="alert" label="阻塞需求" value={String(metrics.blocked.length)} tone="red" onViewAll={openBlocked} />
        <Metric icon="ai" label="运行中AI会话" value={String(runningSessions)} tone="neutral" onViewAll={() => onNavigate("tasks")} />
        <Metric icon="clock" label="即将提测" value={String(metrics.upcoming.length)} tone="blue" onViewAll={() => { const first = metrics.upcoming[0]; if (first) onOpenTab(requirementTab(first.platform, first.requirement)); else onNavigate("requirements"); }} />
      </section>

      <section className="home-columns">
        <section className="panel-section" id="home-recent">
          <div className="section-heading"><div><AppIcon name="history" size={16} /><h2>最近工作</h2></div><button className="text-button" onClick={() => onNavigate("requirements")}>查看全部 <AppIcon name="next" size={14} /></button></div>
          <div className="recent-list">
            {recentList.map((tab) => <RecentItem key={tab.id} icon={(tab.icon as IconName) || "file"} title={tab.title} detail={tab.subtitle || tab.type} onClick={() => onOpenTab(tab)} />)}
            {recentList.length === 0 && <div className="inline-empty">还没有打开的视图；从下方建议下一步或左侧需求树开始。</div>}
          </div>
        </section>
        <section className="panel-section" id="home-mywork">
          <div className="section-heading"><div><AppIcon name="list" size={16} /><h2>我的工作</h2></div><span className="section-muted">{myWork.length} 项</span></div>
          {myWork.length === 0 && digests.length === 0 && <div className="inline-empty">工作区还没有需求。<button className="text-button" onClick={() => onCreateRequirement()}>创建第一个需求</button></div>}
          {myWork.length === 0 && digests.length > 0 && <div className="inline-empty">暂无阻塞项和下一步动作。</div>}
          {myWork.map((item) => (
            <button className="recent-item" key={item.id} onClick={() => onOpenTab(requirementTab(item.platform, item.requirement))}>
              <span className={`recent-icon ${item.kind === "blocker" ? "danger" : ""}`}><AppIcon name={item.kind === "blocker" ? "alert" : "next"} size={14} /></span>
              <span><strong>{item.text}</strong><small>{item.meta}</small></span>
            </button>
          ))}
        </section>
      </section>

      <section className="home-columns">
        <section className="panel-section" id="home-timeline">
          <div className="section-heading"><div><AppIcon name="clock" size={16} /><h2>时间节点</h2></div><span className="section-muted">按计划排序</span></div>
          {timeline.length === 0 && <div className="inline-empty">暂无未完成的计划节点。</div>}
          {timeline.map((item, index) => (
            <button className="recent-item" key={`${item.requirement.requirement.id}-${item.kind}-${index}`} onClick={() => onOpenTab(requirementTab(item.platform, item.requirement))}>
              <span className="recent-icon"><AppIcon name="timer" size={14} /></span>
              <span><strong>{item.requirement.requirement.id} {item.requirement.requirement.name}</strong><small>{item.kind} · {formatDate(item.date)}</small></span>
              <small className={item.days < 0 ? "timeline-overdue" : ""}>{item.days < 0 ? `逾期 ${-item.days} 天` : item.days === 0 ? "今天" : `${item.days} 天后`}</small>
            </button>
          ))}
        </section>
        <section className="panel-section" id="home-issues">
          <div className="section-heading"><div><AppIcon name="alert" size={16} /><h2>工作区异常</h2></div><span className="section-muted">{issues.length} 项</span></div>
          {issues.length === 0 && <div className="inline-empty"><AppIcon name="success" size={14} /> 工作区运行正常。</div>}
          {issues.map((item) => (
            <button className="recent-item" key={item.id} onClick={item.open}>
              <span className="recent-icon"><AppIcon name={item.icon} size={14} /></span>
              <span><strong>{item.title}</strong><small>{item.detail}</small></span>
            </button>
          ))}
        </section>
      </section>

      <section className="panel-section platform-section" id="home-platforms"><div className="section-heading"><div><AppIcon name="platform" size={16} /><h2>平台与项目</h2></div><button className="text-button" onClick={() => onNavigate("settings")}>管理 <AppIcon name="next" size={14} /></button></div><div className="platform-grid">{workspace.platforms.map((platform) => <button className="platform-card" key={platform.id} onClick={() => onNavigate("requirements")}><span className="platform-icon"><AppIcon name="platform" size={18} /></span><span><strong>{platform.name}</strong><small>{platform.path}</small></span><small>{digests.filter((item) => item.platform.id === platform.id).length} 个需求</small></button>)}{workspace.platforms.length === 0 && <div className="inline-empty"><AppIcon name="inbox" size={16} />暂无平台，请在「设置 → 平台管理」中新增。</div>}</div></section>

      <section className="panel-section next-step-section" id="home-next"><div className="section-heading"><div><AppIcon name="next" size={16} /><h2>建议下一步</h2></div><span className="section-muted">按当前工作区状态生成</span></div><div className="next-step-grid">{nextSteps.map((step) => <button className="next-step" key={step.title} onClick={step.run}><span className="next-step-icon"><AppIcon name={step.icon} size={15} /></span><span><strong>{step.title}</strong><small>{step.detail}</small></span></button>)}</div></section>

      {showXmindImport && <XMindImportModal workspace={workspace} initialPlatformId={xmindTarget.platformId} initialRequirementId={xmindTarget.requirementId} onClose={() => setShowXmindImport(false)} onImported={() => { setShowXmindImport(false); onNavigate("tests"); }} />}
    </div>
  );
}

function Metric({ icon, label, value, tone, onViewAll }: { icon: IconName; label: string; value: string; tone: string; onViewAll?: () => void }) {
  return <div className={`metric-card metric-${tone}`}><span className="metric-icon"><AppIcon name={icon} size={17} /></span><div><span>{label}</span><strong>{value}</strong>{onViewAll && <button className="text-button" onClick={onViewAll}>查看全部</button>}</div></div>;
}

function RecentItem({ icon, title, detail, onClick }: { icon: IconName; title: string; detail: string; onClick: () => void }) {
  return <button className="recent-item" onClick={onClick}><span className="recent-icon"><AppIcon name={icon} size={15} /></span><span><strong>{title}</strong><small>{detail}</small></span><AppIcon name="next" size={14} /></button>;
}
