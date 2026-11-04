import AiSessionLinks from "./AiSessionLinks";
// BB-16D：底部工具窗口（问题 / 变更 / AI任务 / 运行日志）与右侧上下文工具窗口（大纲 / 属性 / AI任务）。
// 数据全部来自真实工作区：任务来自 .blackbox/tasks，日志来自 .blackbox/logs，
// 右侧上下文由各业务视图通过 RightContextData 上报。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/date";
import { notify } from "../lib/notify";
import AppIcon, { type IconName } from "./AppIcon";
import { isTaskSignalPath, taskBucket, taskStatusBadge } from "./ContextToolWindows";
import { TASK_TYPE_LABELS } from "./AiTaskWorkspace";
import type { BottomView, RightContextData, RightOutlineItem, RightView } from "../lib/workbench";
import type {
  AiTaskInfo,
  FileChanges,
  WorkspaceConfig,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceLogLevel,
  WorkspaceLogList,
  WorkspaceLogRecord,
} from "../lib/types";

// —— 共享：工作区 AI 任务读取 ————————————————————————————

export function useWorkspaceTasks(rootPath: string, latestWorkspaceEvent?: WorkspaceEvent | null, revision?: number) {
  const [tasks, setTasks] = useState<AiTaskInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await api.listAiTasks(rootPath));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => { void refresh(); }, [refresh, revision]);

  // .blackbox/tasks 下 progress/result/manifest 变化时刷新任务列表
  useEffect(() => {
    if (!latestWorkspaceEvent) return;
    if (isTaskSignalPath(latestWorkspaceEvent, rootPath)) void refresh();
  }, [latestWorkspaceEvent, refresh, rootPath]);

  return { tasks, loading, error, refresh };
}

// —— 底部工具窗口 ————————————————————————————————————

interface BottomToolWindowProps {
  view: BottomView;
  changes: FileChanges | null;
  events: WorkspaceEvent[];
  tasks: AiTaskInfo[];
  tasksLoading: boolean;
  watcherError?: string | null;
  rootPath: string;
  onOpenChanges: () => void;
  onOpenEvent: (event: WorkspaceEvent) => void;
  onOpenTask: (task: AiTaskInfo) => void;
}

export function BottomToolWindow({ view, changes, events, tasks, tasksLoading, watcherError, rootPath, onOpenChanges, onOpenEvent, onOpenTask }: BottomToolWindowProps) {
  return (
    <div className="bottom-tool-body">
      {view === "problems" && <ProblemsPanel tasks={tasks} tasksLoading={tasksLoading} watcherError={watcherError} onOpenTask={onOpenTask} />}
      {view === "changes" && (
        <>
          <div className="bottom-tool-title"><span>工作区文件变化</span><button className="text-button" onClick={onOpenChanges}>打开变化中心</button></div>
          {changes ? (
            <div className="tool-message-list">
              <div className="tool-message tool-message-info"><AppIcon name="activity" size={14} /> 任务期间共 {changes.total} 项变化：新增 {changes.added.length}、修改 {changes.modified.length}、删除 {changes.deleted.length}、移动 {changes.moved.length}</div>
              {[...changes.added.map((path) => ({ type: "新增", path })), ...changes.modified.map((path) => ({ type: "修改", path })), ...changes.deleted.map((path) => ({ type: "删除", path })), ...changes.moved.map((item) => ({ type: "移动", path: `${item.from} → ${item.to}` }))].map((item, index) => (
                <div key={`${item.type}-${item.path}-${index}`} className="tool-message tool-message-muted"><span className="badge badge-muted">{item.type}</span><span className="mono">{item.path}</span></div>
              ))}
            </div>
          ) : (
            <div className="tool-message-list">
              <div className="tool-message tool-message-muted"><AppIcon name="inbox" size={14} /> 尚未扫描需求解锁变化；在需求概览执行“解锁并查看变化”后，这里会列出新增、修改和删除的文件。</div>
            </div>
          )}
        </>
      )}
      {view === "tasks" && <><AiSessionLinks rootPath={rootPath} /><details><summary>历史AI任务</summary><TaskBottomList tasks={tasks} loading={tasksLoading} onOpenTask={onOpenTask} /></details></>}
      {view === "logs" && <WorkspaceLogPanel rootPath={rootPath} />}
      {view === "changes" && events.length > 0 && (
        <div className="tool-message-list" style={{ marginTop: 6 }}>
          {events.slice(0, 12).map((event, index) => (
            <button key={`${event.occurred_at}-${index}`} className="tool-message tool-message-muted tool-message-button" onClick={() => onOpenEvent(event)}>
              <span className={`badge ${eventBadgeClass(event.event_type)}`}>{event.event_type}</span>
              <span className="mono">{event.path}</span>
              <span>{formatDateTime(event.occurred_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function eventBadgeClass(type: WorkspaceEventType): string {
  return type === "create" ? "badge-success" : type === "remove" ? "badge-danger" : type === "rename" ? "badge-warning" : "badge-muted";
}

/** 底部“问题”：聚合真实的客户端异常与AI任务校验问题 */
function ProblemsPanel({ tasks, tasksLoading, watcherError, onOpenTask }: { tasks: AiTaskInfo[]; tasksLoading: boolean; watcherError?: string | null; onOpenTask: (task: AiTaskInfo) => void }) {
  const problems = useMemo(() => {
    const list: { level: "error" | "warning"; text: string; task?: AiTaskInfo }[] = [];
    if (watcherError) list.push({ level: "error", text: `文件监听器：${watcherError}` });
    for (const task of tasks) {
      for (const error of task.validation.errors) list.push({ level: "error", text: `${task.task_id}：${error}`, task });
      for (const path of task.validation.out_of_scope_paths) list.push({ level: "error", text: `${task.task_id} 越界写入：${path}`, task });
      for (const warning of task.validation.warnings) list.push({ level: "warning", text: `${task.task_id}：${warning}`, task });
      if (task.review_status === "rejected") list.push({ level: "warning", text: `${task.task_id} 结果已被拒绝（${task.review_note || "未填写原因"}）`, task });
    }
    return list;
  }, [tasks, watcherError]);

  return (
    <>
      <div className="bottom-tool-title"><span>问题</span><span className="section-muted">{problems.length ? `${problems.length} 项` : tasksLoading ? "正在检查…" : "未发现问题"}</span></div>
      <div className="tool-message-list">
        {problems.length === 0 && !tasksLoading && (
          <div className="tool-message tool-message-success"><AppIcon name="check" size={14} /> 当前没有检测到校验错误、越界写入或监听器异常。</div>
        )}
        {problems.map((problem, index) => (
          <button key={index} className={`tool-message tool-message-button ${problem.level === "error" ? "tool-message-error" : "tool-message-warning"}`} onClick={() => problem.task && onOpenTask(problem.task)} title={problem.task ? "点击打开任务详情" : undefined}>
            <AppIcon name={problem.level === "error" ? "error" : "alert"} size={14} />
            <span>{problem.text}</span>
            {problem.task && <AppIcon name="next" size={13} />}
          </button>
        ))}
      </div>
    </>
  );
}

/** 底部“AI任务”：读取真实任务列表，点击打开任务中心并选中任务 */
function TaskBottomList({ tasks, loading, onOpenTask }: { tasks: AiTaskInfo[]; loading: boolean; onOpenTask: (task: AiTaskInfo) => void }) {
  const sorted = useMemo(() => {
    const order = { waiting: 0, running: 1, failed: 2, completed: 3 } as const;
    return [...tasks].sort((left, right) => order[taskBucket(left)] - order[taskBucket(right)] || right.updated_at.localeCompare(left.updated_at)).slice(0, 30);
  }, [tasks]);
  const activeCount = tasks.filter((task) => taskBucket(task) === "running" || taskBucket(task) === "waiting").length;

  return (
    <>
      <div className="bottom-tool-title">
        <span>历史AI任务 · {tasks.length} 个{activeCount ? `，${activeCount} 个进行中/待确认` : ""}</span>
        {loading && <span className="section-muted">刷新中…</span>}
      </div>
      {sorted.length === 0 && !loading ? (
        <div className="tool-message-list">
          <div className="tool-message tool-message-muted"><AppIcon name="inbox" size={14} /> 当前工作区没有历史AI任务；新工作请使用上方AI会话。</div>
        </div>
      ) : (
        <div className="tool-message-list">
          {sorted.map((task) => (
            <button key={task.task_id} className="tool-message tool-message-button task-bottom-row" onClick={() => onOpenTask(task)} title={`打开任务 ${task.task_id}`}>
              <span className={`status-pill ${taskBucket(task) === "failed" ? "danger" : taskBucket(task) === "completed" ? "success" : taskBucket(task) === "waiting" ? "warning" : ""}`}>{taskStatusBadge(task)}</span>
              <span className="task-bottom-main"><strong>{TASK_TYPE_LABELS[task.task_type] || task.task_type}</strong><small className="mono">{task.task_id}</small></span>
              <span className="task-bottom-message">{task.progress.message || "暂无进度消息"}</span>
              <span className="task-bottom-side">{task.requirement_id} · {formatDateTime(task.updated_at)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const LOG_LEVELS: { value: "all" | WorkspaceLogLevel; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "info", label: "信息" },
  { value: "warning", label: "警告" },
  { value: "error", label: "错误" },
];

/** 底部“运行日志”：读取 .blackbox/logs 的客户端审计与业务操作记录 */
function WorkspaceLogPanel({ rootPath }: { rootPath: string }) {
  const [data, setData] = useState<WorkspaceLogList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<"all" | WorkspaceLogLevel>("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.listWorkspaceLogs(rootPath));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => { void load(); }, [load]);

  const entries = useMemo(() => {
    const list = data?.entries || [];
    return levelFilter === "all" ? list : list.filter((entry) => entry.level === levelFilter);
  }, [data, levelFilter]);

  const copyEntry = async (entry: WorkspaceLogRecord) => {
    const text = [entry.occurred_at, entry.level.toUpperCase(), entry.module, entry.action, entry.result, entry.detail].filter(Boolean).join("  ");
    try {
      await copyText(text);
      notify("success", "日志已复制");
    } catch (reason) {
      notify("error", `复制失败：${String(reason)}`);
    }
  };

  const copyAll = async () => {
    const text = entries.map((entry) => [entry.occurred_at, entry.level.toUpperCase(), entry.module, entry.action, entry.result, entry.detail].filter(Boolean).join("  ")).join("\n");
    try {
      await copyText(text || "");
      notify("success", `已复制 ${entries.length} 条日志`);
    } catch (reason) {
      notify("error", `复制失败：${String(reason)}`);
    }
  };

  return (
    <>
      <div className="bottom-tool-title">
        <span>运行日志</span>
        <span className="log-panel-actions">
          {LOG_LEVELS.map((item) => (
            <button key={item.value} className={`log-level-filter ${levelFilter === item.value ? "active" : ""}`} onClick={() => setLevelFilter(item.value)}>{item.label}</button>
          ))}
          <button className="icon-button" onClick={() => void copyAll()} title="复制当前筛选的日志" disabled={entries.length === 0}><AppIcon name="copy" size={13} /></button>
          <button className="icon-button" onClick={() => void load()} title="刷新日志"><AppIcon name={loading ? "clock" : "refresh"} size={13} /></button>
        </span>
      </div>
      {error && <div className="tool-message tool-message-error"><AppIcon name="error" size={14} /> {error}</div>}
      {data?.errors.map((item) => (
        <div key={item.file} className="tool-message tool-message-warning"><AppIcon name="alert" size={14} /> 日志文件 {item.file} 无法解析：{item.message}</div>
      ))}
      {entries.length === 0 && !loading && !error ? (
        <div className="tool-message-list">
          <div className="tool-message tool-message-muted"><AppIcon name="inbox" size={14} /> {levelFilter === "all" ? ".blackbox/logs 下暂无日志；需求解锁和客户端关键操作会记录在这里。" : "当前级别没有日志记录。"}</div>
        </div>
      ) : (
        <div className="tool-message-list log-list">
          {entries.map((entry, index) => (
            <div key={`${entry.file}-${entry.line}-${index}`} className={`log-row log-${entry.level}`}>
              <span className="log-time mono">{formatDateTime(entry.occurred_at)}</span>
              <span className={`log-level ${entry.level}`}>{entry.level === "error" ? "错误" : entry.level === "warning" ? "警告" : "信息"}</span>
              <span className="log-module">{entry.module || "工作区"}</span>
              <span className="log-action">{entry.action || "—"}</span>
              <span className="log-detail" title={entry.detail}>{entry.result ? `${entry.result}${entry.detail ? ` · ${entry.detail}` : ""}` : entry.detail || ""}</span>
              <button className="icon-button log-copy" onClick={() => void copyEntry(entry)} title="复制该条日志"><AppIcon name="copy" size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("当前环境不支持剪贴板");
}

// —— 右侧工具窗口：大纲 / 属性 / 关联AI任务 ——————————————————

interface RightToolWindowProps {
  view: RightView;
  workspace: WorkspaceConfig;
  context: RightContextData;
  tasks: AiTaskInfo[];
  tasksLoading: boolean;
  onOpenTask: (task: AiTaskInfo) => void;
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
  file: "文件",
  markdown: "Markdown文档",
  requirement: "需求",
  cases: "用例",
  run: "测试轮次",
  report: "报告",
  task: "AI会话",
  knowledge: "知识",
  folder: "目录",
  platform: "平台",
  home: "工作区首页",
  settings: "设置",
  generic: "对象",
};

export function RightToolWindow({ view, workspace, context, tasks, tasksLoading, onOpenTask }: RightToolWindowProps) {
  const rootPath = workspace.workspace.root_path;
  const relatedTasks = useMemo(() => {
    const relPath = context.path ? relativeToRoot(rootPath, context.path) : "";
    return tasks.filter((task) => {
      if (context.objectType === "task") return context.objectId ? task.task_id === context.objectId : true;
      if (context.platformId && context.requirementId && task.platform_id === context.platformId && task.requirement_id === context.requirementId) return true;
      if (relPath) {
        const touched = [...task.input_files.map((file) => file.path), task.output_dir, ...task.allowed_paths];
        if (touched.some((path) => path && (relPath === path || relPath.startsWith(`${path.replace(/\/+$/, "")}/`) || path.endsWith("/**") && relPath.startsWith(path.slice(0, -3))))) return true;
      }
      return false;
    });
  }, [context.objectId, context.objectType, context.path, context.platformId, context.requirementId, rootPath, tasks]);

  return (
    <div className="right-tool-body">
      <div className="right-tool-heading"><AppIcon name="info" size={12} /> {context.title || "当前对象"}<span className="section-muted">{OBJECT_TYPE_LABELS[context.objectType] || context.objectType}</span></div>
      {(view === "outline" || view === "file") && <OutlinePane context={context} />}
      {view === "properties" && <PropertiesPane context={context} workspace={workspace} />}
      {view === "task" && <><AiSessionLinks rootPath={rootPath} platformId={context.platformId} requirementId={context.requirementId} /><details><summary>历史AI任务</summary><TaskPane tasks={relatedTasks} loading={tasksLoading} onOpenTask={onOpenTask} /></details></>}
    </div>
  );
}

function relativeToRoot(rootPath: string, path: string): string {
  const root = rootPath.replace(/\\/g, "/").replace(/\/+$/g, "");
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : "";
}

/** 右侧大纲：由当前视图上报真实条目，点击定位页面内容 */
function OutlinePane({ context }: { context: RightContextData }) {
  const outline = context.outline || [];
  return (
    <section className="right-context-section">
      <div className="outline-title">{context.outlineTitle || "大纲"}</div>
      {outline.length === 0 ? (
        <div className="outline-empty-block"><AppIcon name="list" size={16} /><span>当前对象没有可定位的大纲内容</span></div>
      ) : (
        <div className="outline-list">
          {outline.map((item) => <OutlineRow key={item.id} item={item} />)}
        </div>
      )}
    </section>
  );
}

function OutlineRow({ item }: { item: RightOutlineItem }) {
  const depth = Math.min(item.depth || 0, 6);
  return (
    <button
      className={`outline-item context-outline-item ${item.active ? "active" : ""} ${item.onSelect ? "clickable" : ""}`}
      style={{ paddingLeft: 9 + depth * 13 }}
      onClick={() => item.onSelect?.()}
      disabled={!item.onSelect}
      title={item.hint || item.label}
    >
      {item.icon && <AppIcon name={item.icon as IconName} size={13} />}
      <span className="context-outline-label">{item.label}</span>
      {item.badge && <b className="context-outline-badge">{item.badge}</b>}
    </button>
  );
}

/** 右侧属性：当前对象的真实字段 + 摘要统计 */
function PropertiesPane({ context, workspace }: { context: RightContextData; workspace: WorkspaceConfig }) {
  const platform = context.platformId ? workspace.platforms.find((item) => item.id === context.platformId) : undefined;
  const rows = [
    ...(context.properties || []),
    ...(platform ? [{ label: "所属平台", value: platform.name }] : []),
    ...(context.requirementId ? [{ label: "所属需求", value: context.requirementId }] : []),
  ];
  return (
    <section className="right-context-section">
      <div className="outline-title">属性</div>
      <div className="property-list">
        <PropertyRow label="对象类型" value={OBJECT_TYPE_LABELS[context.objectType] || context.objectType} />
        <PropertyRow label="标题" value={context.title} />
        {context.objectId && context.objectId !== context.title && <PropertyRow label="标识" value={context.objectId} mono />}
        {context.path && <PropertyRow label="路径" value={context.path} mono />}
        {rows.map((row, index) => <PropertyRow key={`${row.label}-${index}`} label={row.label} value={row.value} mono={row.mono} />)}
        <PropertyRow label="编辑状态" value={context.readOnly ? "只读/已锁定" : "可编辑"} />
      </div>
      {context.stats && context.stats.length > 0 && (
        <>
          <div className="outline-title" style={{ marginTop: 12 }}>摘要</div>
          <div className="property-list">
            {context.stats.map((row, index) => <PropertyRow key={`${row.label}-${index}`} label={row.label} value={row.value} />)}
          </div>
        </>
      )}
    </section>
  );
}

function PropertyRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="property-row"><span>{label}</span><strong className={mono ? "mono" : ""} title={value}>{value}</strong></div>;
}

/** 右侧 AI任务：与当前需求/文件关联的真实任务 */
function TaskPane({ tasks, loading, onOpenTask }: { tasks: AiTaskInfo[]; loading: boolean; onOpenTask: (task: AiTaskInfo) => void }) {
  const sorted = useMemo(() => [...tasks].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, 15), [tasks]);
  return (
    <section className="right-context-section">
      <div className="outline-title">关联AI任务</div>
      {sorted.length === 0 ? (
        <div className="outline-empty-block"><AppIcon name="ai" size={16} /><span>{loading ? "正在读取任务…" : "当前对象没有关联的AI任务"}</span></div>
      ) : (
        <div className="context-task-list">
          {sorted.map((task) => (
            <button key={task.task_id} className="context-task-row" onClick={() => onOpenTask(task)} title={`打开任务 ${task.task_id}`}>
              <span className="context-task-head">
                <span className={`status-dot ${taskBucket(task) === "failed" ? "status-dot-danger" : taskBucket(task) === "completed" ? "status-dot-success" : "status-dot-warning"}`} />
                <strong>{TASK_TYPE_LABELS[task.task_type] || task.task_type}</strong>
                <span className="context-task-time">{formatDateTime(task.updated_at)}</span>
              </span>
              <span className="context-task-meta"><span className="mono">{task.task_id}</span> · {taskStatusBadge(task)}{task.awaiting_confirmation ? " · 待确认" : ""}</span>
              <span className="context-task-message">{task.progress.message || task.result.summary || "暂无进度消息"}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
