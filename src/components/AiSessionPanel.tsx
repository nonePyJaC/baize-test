import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { api, joinPath } from "../lib/api";
import { describeLive, type LiveRun } from "../lib/aiLive";
import { composerKeyAction, insertLineBreak } from "../lib/aiComposer";
import { aiSessionRuntime, type RunContext } from "../lib/aiSessionRuntime";
import { EMPTY_SESSION_STATE } from "../lib/aiSessionState";
import { buildTimeline, wasInterrupted } from "../lib/aiTimeline";
import type {
  AiApproval,
  AiRestoreItem,
  AiRunSummary,
  AiSession,
  AiSessionMessage,
  AiSessionSummary,
} from "../lib/aiSessionTypes";
import type { ModelProviderSettings, PlatformInfo, RequirementMeta } from "../lib/types";
import AiProcessBlock from "./AiProcessBlock";
import AppIcon from "./AppIcon";
import AiDeliveryStatus from "./AiDeliveryStatus";
import AiReviewPanel from "./AiReviewPanel";

interface RequirementOption {
  key: string;
  platform: PlatformInfo;
  meta: RequirementMeta;
}

interface AiSessionPanelProps {
  rootPath: string;
  platforms: PlatformInfo[];
  provider: ModelProviderSettings | null;
  onBack: () => void;
  onRightContext?: import("../lib/workbench").RightContextReporter;
  initialPath?: string; initialPlatformId?: string; initialRequirementId?: string; focusKey?: number;
}

const PERMISSION_OPTIONS = [
  { value: "ask", label: "询问：每次写入需审批" },
  { value: "plan", label: "计划：只读" },
  { value: "code", label: "执行：允许写入（经门禁检查）" },
];

const ROLE_LABELS: Record<AiSessionMessage["role"], string> = { user: "你", assistant: "白泽", system: "系统", tool: "工具" };

const APPROVAL_STATUS_LABELS: Record<AiApproval["status"], string> = {
  pending: "待审批",
  approved: "已批准，待执行",
  rejected: "已拒绝",
  consumed: "已执行",
};

const RESTORE_STATUS_LABELS: Record<AiRestoreItem["status"], string> = {
  ready: "待还原",
  done: "已还原",
  noop: "无变化",
  skipped: "已保留",
  conflict: "冲突",
};

/** 待发送的图片：name 是已保存到会话附件目录的文件名，dataUrl 仅用于输入框内的预览。 */
interface PendingImage {
  name: string;
  dataUrl: string;
}

/** 输入框草稿按会话保存在内存里，切换页面或会话后回来不丢失（应用重启后清空）。 */
const composerDrafts = new Map<string, { text: string; images: PendingImage[] }>();
function readComposer(key: string) {
  try { return composerDrafts.get(key) ?? JSON.parse(sessionStorage.getItem(`baize-composer:${key}`) || "null"); } catch { return composerDrafts.get(key); }
}
function saveComposer(key: string, value: {text:string;images:PendingImage[]}) {
  composerDrafts.set(key,value);
  try { sessionStorage.setItem(`baize-composer:${key}`,JSON.stringify(value)); } catch { /* In-memory draft still available. */ }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function imageExtension(file: File): string {
  const subtype = (file.type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return subtype || "png";
}

function imageMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "png";
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
}

/** 历史消息里的图片：附件存在会话目录下，读取后转成 data URL 显示。 */
function SessionMessageImage({ rootPath, sessionId, name }: { rootPath: string; sessionId: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.readAiSessionAttachment(rootPath, sessionId, name)
      .then((data) => { if (alive && data) setUrl(`data:${imageMime(name)};base64,${data}`); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [rootPath, sessionId, name]);
  if (!url) return <span className="ai-msg-image-missing">[图片不可用]</span>;
  return <img className="ai-msg-image" src={url} alt={name} />;
}

function requirementText(option: RequirementOption): string {
  return `${option.meta.requirement.id} · ${option.meta.requirement.name}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function previewArguments(approval: AiApproval): string {
  const args = approval.arguments;
  if (approval.tool === "write_xmind") {
    const outline = String(args.outline ?? "").split("\n").slice(0, 20).join("\n");
    return `标题：${String(args.title ?? "")}\n${outline}`;
  }
  const text = JSON.stringify(args, null, 2);
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}

function RunStatus({ live, now }: { live: LiveRun; now: number }) {
  const { title, detail, warn } = describeLive(live, now);
  return (
    <div className={`ai-run-status ${warn ? "warn" : ""}`}>
      <span className="ai-run-spinner" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function ApprovalCard({ approval, disabled, onApprove, onReject, onExecute }: {
  approval: AiApproval;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  onExecute: () => void;
}) {
  return (
    <div className={`ai-approval-card ai-approval-${approval.status}`}>
      <div className="ai-approval-head">
        <AppIcon name="alert" size={14} />
        <strong>{approval.tool}</strong>
        <span className="status-pill">{APPROVAL_STATUS_LABELS[approval.status]}</span>
      </div>
      <p>{approval.reason}</p>
      <ul className="ai-approval-paths">
        {approval.paths.map((path, index) => <li key={`${index}-${path}`} className="mono">{path}</li>)}
      </ul>
      <pre className="ai-approval-preview">{previewArguments(approval)}</pre>
      {approval.status === "pending" && (
        <div className="ai-approval-actions">
          <button className="button button-primary button-small" disabled={disabled} onClick={onApprove}>批准并执行</button>
          <button className="button button-ghost button-small" disabled={disabled} onClick={onReject}>拒绝</button>
        </div>
      )}
      {approval.status === "approved" && (
        <div className="ai-approval-actions">
          <button className="button button-primary button-small" disabled={disabled} onClick={onExecute}>执行</button>
        </div>
      )}
    </div>
  );
}

export default function AiSessionPanel({ rootPath, platforms, provider, onBack, initialPlatformId, initialRequirementId, initialPath, focusKey, onRightContext }: AiSessionPanelProps) {
  const selectionText = initialPath ? `请阅读选中资料：${initialPath}。\n` : "";
  const [reviewOpen,setReviewOpen] = useState(false);
  const focusApplied = useRef<string>("none");
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [options, setOptions] = useState<RequirementOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(() => aiSessionRuntime.selected());
  const [draft, setDraftState] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newPlatformId, setNewPlatformId] = useState("");
  const [newRequirementKey, setNewRequirementKey] = useState("");
  const [newMode, setNewMode] = useState("ask");
  const [newTitle, setNewTitle] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [runs, setRuns] = useState<AiRunSummary[]>([]);
  const [planRunId, setPlanRunId] = useState<string | null>(null);
  const [plan, setPlan] = useState<AiRestoreItem[] | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [, tick] = useReducer((count: number) => count + 1, 0);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const runtime = useSyncExternalStore(aiSessionRuntime.subscribe, aiSessionRuntime.getSnapshot);
  const state = activeId ? runtime.get(activeId) ?? EMPTY_SESSION_STATE : EMPTY_SESSION_STATE;
  const { session, busy } = state;
  const liveRun = busy ? state.live : null;
  const shownError = error ?? state.error;
  const busyIds = useMemo(() => new Set([...runtime].filter(([, item]) => item.busy).map(([id]) => id)), [runtime]);
  const fail = useCallback((reason: unknown) => setError(String(reason)), []);

  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({objectType:"task",objectId:session?.id,title:session?.title || "AI会话",platformId:session?.platform_id || undefined,requirementId:session?.requirement_id || undefined,subtitle:"对话、评审与测后复盘"});
    return () => onRightContext(null);
  }, [onRightContext,session?.id,session?.title,session?.platform_id,session?.requirement_id]);

  // 草稿（文字 + 待发送图片）按会话保存，切换页面或会话不丢失
  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    if (activeId) saveComposer(`${rootPath}:${activeId}`, { text: value, images: readComposer(`${rootPath}:${activeId}`)?.images ?? [] });
  }, [activeId, rootPath]);
  const setPending = useCallback((images: PendingImage[]) => {
    setPendingImages(images);
    if (activeId) saveComposer(`${rootPath}:${activeId}`, { text: readComposer(`${rootPath}:${activeId}`)?.text ?? "", images });
  }, [activeId, rootPath]);

  const scrollToBottom = useCallback((smooth = false) => {
    const element = messagesRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const handleMessagesScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const at = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
    stickToBottom.current = at;
    setAtBottom(at);
  };

  const jumpToBottom = () => {
    stickToBottom.current = true;
    setAtBottom(true);
    scrollToBottom(true);
  };
  const activePlatforms = useMemo(() => platforms.filter((platform) => platform.status !== "archived"), [platforms]);
  const visibleSessions = useMemo(() => sessions.filter((item) => showArchived || !item.archived), [sessions, showArchived]);
  const archivedCount = sessions.filter((item) => item.archived).length;
  const platformOptions = useMemo(() => options.filter((option) => option.platform.id === newPlatformId), [options, newPlatformId]);
  const newOption = options.find((option) => option.key === newRequirementKey);
  const autoTitle = newOption ? requirementText(newOption) : "聊天会话";

  const refreshSessions = useCallback(async () => {
    setSessions(await api.listAiSessions(rootPath));
  }, [rootPath]);

  useEffect(() => {
    refreshSessions().catch(fail);
  }, [refreshSessions, fail]);

  useEffect(() => {
    setOptionsLoading(true);
    Promise.all(activePlatforms.map(async (platform) => {
      const items = await api.scanRequirements(rootPath, platform.path).catch(() => [] as RequirementMeta[]);
      return items.map((meta) => ({ key: `${platform.id}::${meta.requirement.id}`, platform, meta }));
    }))
      .then((groups) => setOptions(groups.flat()))
      .catch(fail)
      .finally(() => setOptionsLoading(false));
  }, [rootPath, activePlatforms, fail]);

  useEffect(() => {
    aiSessionRuntime.select(activeId);
    if (activeId) aiSessionRuntime.load(rootPath, activeId).catch(fail);
  }, [rootPath, activeId, fail]);

  useEffect(() => {
    const open = () => {setCreating(false);setActiveId(aiSessionRuntime.selected());};
    window.addEventListener("baize-open-ai-session",open);
    return () => window.removeEventListener("baize-open-ai-session",open);
  },[]);

  // 切换会话时恢复该会话的草稿
  useEffect(() => {
    const saved = activeId ? readComposer(`${rootPath}:${activeId}`) : undefined;
    setDraftState(saved?.text ?? "");
    setPendingImages(saved?.images ?? []);
  }, [activeId, rootPath]);

  useEffect(() => {
    if (!initialPlatformId || !initialRequirementId || optionsLoading) return;
    const key = `${rootPath}:${initialPlatformId}:${initialRequirementId}:${focusKey ?? "mount"}`;
    if (focusApplied.current === key) return;
    focusApplied.current = key;
    // Open creation with exact platform context; offer matching existing sessions alongside it.
    setActiveId(null); setCreating(true);
    setNewPlatformId(initialPlatformId); setNewRequirementKey(`${initialPlatformId}::${initialRequirementId}`);
  }, [rootPath,initialPlatformId,initialRequirementId,focusKey,optionsLoading]);

  // 进入会话时定位到最新消息
  useEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    const frame = requestAnimationFrame(() => scrollToBottom());
    return () => cancelAnimationFrame(frame);
  }, [activeId, scrollToBottom]);

  // 新消息或流式输出时，若用户停留在底部则自动跟随；上滚浏览时不打断
  const messageCount = session?.messages.length ?? 0;
  const streamLength = liveRun?.streamText.length ?? 0;
  useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [activeId, messageCount, streamLength, scrollToBottom]);

  useEffect(() => {
    if (!creating && !restoreOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCreating(false);
      setRestoreOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [creating, restoreOpen]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(tick, 400);
    return () => window.clearInterval(timer);
  }, [busy]);

  const approvalsByCall = useMemo(() => {
    const map = new Map<string, AiApproval[]>();
    (session?.approvals ?? []).forEach((approval) => {
      map.set(approval.tool_call_id, [...(map.get(approval.tool_call_id) ?? []), approval]);
    });
    return map;
  }, [session]);

  const linkedLabel = (item: { platform_id: string | null; requirement_id: string | null }) => {
    if (!item.requirement_id) return "未关联需求（仅聊天）";
    const option = options.find((candidate) => candidate.meta.requirement.id === item.requirement_id && (!item.platform_id || candidate.platform.id === item.platform_id));
    return option ? requirementText(option) : item.requirement_id;
  };

  const currentOptionKey = options.find((option) => session !== null && option.meta.requirement.id === session.requirement_id && (!session.platform_id || option.platform.id === session.platform_id))?.key ?? "";

  const runContext = (current: AiSession): RunContext | null => {
    const linked = options.find((item) => item.meta.requirement.id === current.requirement_id && (!current.platform_id || item.platform.id === current.platform_id));
    return {
      rootPath,
      provider: provider!,
      requirementLabel: linked ? requirementText(linked) : current.requirement_id ?? "未关联需求",
      requirementDir: linked ? joinPath(linked.platform.path, linked.meta.requirement.id) : "",
    };
  };
  const reviewContext = session ? runContext(session) : null;
  const reviewAvailable = Boolean(reviewContext?.requirementDir);

  const openCreate = () => {
    setNewPlatformId(initialPlatformId || "");
    setNewRequirementKey(initialRequirementId && initialPlatformId ? `${initialPlatformId}::${initialRequirementId}` : "");
    setNewMode("ask");
    setNewTitle("");
    setError(null);
    setCreating(true);
  };

  const choosePlatform = (platformId: string) => {
    setNewPlatformId(platformId);
    setNewRequirementKey("");
  };

  const createSession = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await api.createAiSession(
        rootPath,
        newTitle.trim() || autoTitle,
        newOption?.platform.id ?? (newPlatformId || null),
        newOption?.meta.requirement.id ?? null,
        newMode,
      );
      setCreating(false);
      await refreshSessions();
      if (selectionText) saveComposer(`${rootPath}:${created.id}`,{text:selectionText,images:[]});
      setActiveId(created.id);
    } catch (reason) {
      fail(reason);
    } finally {
      setSaving(false);
    }
  };

  const withContext = (action: (context: RunContext, current: AiSession) => Promise<void>) => {
    if (!session) return;
    const context = runContext(session);
    if (!context || !provider) {
      fail("请先在「设置 → 模型服务」中启用并配置模型");
      return;
    }
    setError(null);
    action(context, session).then(() => refreshSessions()).catch(fail);
  };

  const send = async () => {
    const text = draft.trim();
    const imageNames = pendingImages.map((item) => item.name);
    if (!session || (!text && imageNames.length === 0) || busy) return;
    const context = runContext(session);
    if (!context || !provider) {
      fail("请先在「设置 → 模型服务」中启用并配置模型");
      return;
    }
    setError(null);
    setDraft("");
    setPending([]);
    try {
      await aiSessionRuntime.send(session.id, text, imageNames, context);
    } catch (reason) {
      setDraft(text);
      setPending(pendingImages);
      fail(reason);
    }
  };

  const pasteImages = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length || !session || busy || session.archived) return;
    event.preventDefault();
    const added: PendingImage[] = [];
    for (const file of files) {
      try {
        const dataUrl = await fileToDataUrl(file);
        const name = await api.saveAiSessionImage(rootPath, session.id, dataUrl.slice(dataUrl.indexOf(",") + 1), imageExtension(file));
        added.push({ name, dataUrl });
      } catch (reason) {
        fail(reason);
      }
    }
    if (added.length) setPending([...pendingImages, ...added]);
  };

  const removePendingImage = (name: string) => setPending(pendingImages.filter((item) => item.name !== name));

  const decide = async (approval: AiApproval, approved: boolean) => {
    if (!session) return;
    const context = runContext(session);
    if (!context || !provider) {
      fail("请先在「设置 → 模型服务」中启用并配置模型");
      return;
    }
    setActionPending(true);
    setError(null);
    try {
      await aiSessionRuntime.decide(session.id, approval.id, approved, context);
      await refreshSessions();
    } catch (reason) {
      fail(reason);
    } finally {
      setActionPending(false);
    }
  };

  /** 已批准但尚未执行的操作：发起审批续跑，由后端执行并继续模型。 */
  const execute = () => {
    withContext((context, current) => aiSessionRuntime.resume(current.id, "approval", context));
  };

  const resumeInterrupted = () => {
    withContext((context, current) => aiSessionRuntime.resume(current.id, "interrupted", context));
  };

  const stopRun = () => {
    if (session) aiSessionRuntime.stop(session.id);
  };

  const linkRequirement = (key: string) => {
    if (!session) return;
    const option = options.find((item) => item.key === key);
    const sessionId = session.id;
    setError(null);
    api.updateAiSession(rootPath, sessionId, {
      platformId: option?.platform.id ?? "",
      requirementId: option?.meta.requirement.id ?? "",
    })
      .then((updated) => aiSessionRuntime.setSession(sessionId, updated))
      .then(() => refreshSessions())
      .catch(fail);
  };

  const changeMode = (mode: string) => {
    if (!session) return;
    const sessionId = session.id;
    setError(null);
    api.updateAiSession(rootPath, sessionId, { permissionMode: mode })
      .then((updated) => aiSessionRuntime.setSession(sessionId, updated))
      .then(() => refreshSessions())
      .catch(fail);
  };

  const setArchived = (archived: boolean) => {
    if (!session) return;
    const sessionId = session.id;
    setError(null);
    api.setAiSessionArchived(rootPath, sessionId, archived)
      .then((updated) => aiSessionRuntime.setSession(sessionId, updated))
      .then(() => refreshSessions())
      .catch(fail);
  };

  const removeSession = async () => {
    if (!session || busy) return;
    if (!window.confirm(`删除会话「${session.title}」？\n对话、审批记录和改动还原记录会一并删除，且无法恢复。需求目录中已写入的文件不会受影响。`)) return;
    const sessionId = session.id;
    setActionPending(true);
    setError(null);
    try {
      await api.deleteAiSession(rootPath, sessionId);
      aiSessionRuntime.forget(sessionId);
      setActiveId(null);
      await refreshSessions();
    } catch (reason) {
      fail(reason);
    } finally {
      setActionPending(false);
    }
  };

  const openRestore = async () => {
    if (!session) return;
    setRestoreOpen(true);
    setPlan(null);
    setPlanRunId(null);
    setError(null);
    try {
      setRuns(await api.listAiSessionRuns(rootPath, session.id));
    } catch (reason) {
      fail(reason);
    }
  };

  const openPlan = async (runId: string) => {
    if (!session) return;
    setPlanRunId(runId);
    setPlan(null);
    try {
      setPlan(await api.planAiSessionRestore(rootPath, session.id, runId));
    } catch (reason) {
      fail(reason);
    }
  };

  const applyRestore = async () => {
    if (!session || !planRunId) return;
    if (busy) {
      fail("会话正在运行，请等待完成后再还原");
      return;
    }
    const sessionId = session.id;
    setRestoreBusy(true);
    setError(null);
    try {
      const outcome = await api.applyAiSessionRestore(rootPath, sessionId, planRunId);
      const updated = await api.appendAiSessionMessage(rootPath, sessionId, {
        role: "system",
        content: `已还原运行：恢复 ${outcome.restored} 项，保留 ${outcome.skipped} 项，冲突 ${outcome.conflicts} 项`,
        tool_calls: [],
      });
      aiSessionRuntime.setSession(sessionId, updated);
      setRuns(await api.listAiSessionRuns(rootPath, sessionId));
      setPlan(await api.planAiSessionRestore(rootPath, sessionId, planRunId));
      await refreshSessions();
    } catch (reason) {
      fail(reason);
    } finally {
      setRestoreBusy(false);
    }
  };

  const now = Date.now();
  const timeline = session ? buildTimeline(session.messages) : [];
  const interrupted = session !== null && !busy && wasInterrupted(session);

  return (
    <div className="workspace-view ai-task-view ai-session-view">
      <section className="document-header">
        <div className="document-title-row">
          <span className="document-icon blue"><AppIcon name="ai" size={20} /></span>
          <div>
            <div className="eyebrow">工作区工具 / AI协作</div>
            <h1>AI会话</h1>
            <p>与模型对话处理需求资料。文件写入受权限模式与门禁约束；删除 XMind 测试用例、覆盖人工修改过的用例需要你在此处逐次批准。</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="button button-ghost" onClick={onBack}>历史任务</button>
        </div>
      </section>

      <div className="ai-session-layout">
        <aside className="ai-session-list">
          <button className="button button-primary button-small" onClick={openCreate}>
            <AppIcon name="add" size={14} /> 新建会话
          </button>
          {archivedCount > 0 && (
            <label className="ai-session-archive-toggle">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> 显示已归档（{archivedCount}）
            </label>
          )}
          {visibleSessions.length === 0 && <div className="panel-placeholder"><span>{sessions.length === 0 ? "还没有会话" : "没有未归档的会话"}</span></div>}
          {visibleSessions.map((item) => (
            <button key={item.id} className={`ai-session-item ${item.id === activeId ? "active" : ""} ${item.archived ? "archived" : ""}`} onClick={() => setActiveId(item.id)}>
              <strong>{item.title}</strong>
              <small>{linkedLabel(item)} · {item.message_count} 条消息</small>
              {busyIds.has(item.id) && <span className="ai-session-running-badge">运行中</span>}
              {item.archived && <span className="ai-session-archived-badge">已归档</span>}
            </button>
          ))}
        </aside>

        <section className="ai-session-main">
          {!session && <div className="center-state"><AppIcon name="ai" size={24} /><strong>选择或新建一个会话</strong></div>}
          {session && (
            <>
              <div className="ai-session-toolbar">
                <strong title={session.title}>{session.title}</strong>
                <div className="ai-session-controls">
                  <label className="ai-session-requirement-picker">
                    <span>关联需求</span>
                    <select className="field-input" value={currentOptionKey} disabled={busy} onChange={(event) => linkRequirement(event.target.value)} aria-label="关联需求">
                      <option value="">未关联需求（仅聊天）</option>
                      {options.map((option) => <option key={option.key} value={option.key}>{option.platform.name} / {requirementText(option)}</option>)}
                    </select>
                  </label>
                  <button
                    className={`button button-small ${reviewOpen ? "button-primary" : "button-ghost"}`}
                    disabled={!reviewAvailable}
                    title={!session.requirement_id ? "请先在此处关联需求" : optionsLoading && !reviewAvailable ? "正在加载关联需求列表" : reviewAvailable ? "可选：逐项处理 AI 用例修订建议；归档与上传可直接在对话中确认" : "请重新选择关联需求"}
                    aria-expanded={reviewAvailable && reviewOpen}
                    onClick={() => setReviewOpen((value) => !value)}
                  >
                    {reviewOpen ? "收起修订面板" : "用例修订（可选）"}
                  </button>
                  <button className="button button-ghost button-small" disabled={busy} onClick={() => void openRestore()}>改动记录</button>
                  <button className="button button-ghost button-small" disabled={busy || actionPending} onClick={() => setArchived(!session.archived)}>{session.archived ? "取消归档" : "归档"}</button>
                  <button className="button button-danger button-small" disabled={busy || actionPending} onClick={() => void removeSession()}>删除</button>
                  <select className="field-input" value={session.permission_mode} disabled={busy} onChange={(event) => changeMode(event.target.value)} aria-label="权限模式">
                    {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
              </div>
              {!session.requirement_id && <div className="ai-session-notice">未关联需求：先用上方「关联需求」选择需求。归档与上传范围确定后可直接在对话中确认；用例修订面板仅用于逐项处理 AI 修订建议。</div>}
              {session.requirement_id && !reviewAvailable && !optionsLoading && <div className="ai-session-notice">当前关联需求暂未定位到工作区；请重新选择关联需求。用例修订面板为可选功能，不影响对话。</div>}
              {session.archived && <div className="ai-session-notice">会话已归档：不能继续对话或审批，取消归档后恢复。</div>}
              {interrupted && (
                <div className="ai-session-notice ai-session-interrupted">
                  <span>上一次运行没有完成（应用关闭或页面刷新时中断），可以从当前进度继续。</span>
                  <button className="button button-primary button-small" disabled={session.archived} onClick={resumeInterrupted}>继续运行</button>
                </div>
              )}
              {reviewAvailable && reviewContext && <div hidden={!reviewOpen}><AiReviewPanel key={`${session.platform_id}:${session.requirement_id}`} rootPath={rootPath} requirementDir={reviewContext.requirementDir} platformId={session.platform_id!} requirementId={session.requirement_id!} sessionId={session.id} disabled={busy || session.archived || session.permission_mode === "plan"} onClose={() => setReviewOpen(false)} /></div>}
              <AiDeliveryStatus rootPath={rootPath} session={session} busy={busy} />
              <div className="ai-session-scroll">
              <div className="ai-session-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
                {timeline.map((item, index) => item.kind === "process" ? (
                  <div key={item.id} className="ai-process-group">
                    <AiProcessBlock messages={item.messages} approvals={session.approvals} active={busy && index === timeline.length - 1} />
                    {item.messages.filter((message) => message.role === "assistant").flatMap((message) => (message.tool_calls ?? []).flatMap((call) => approvalsByCall.get(call.id) ?? [])).map((approval) => (
                      <ApprovalCard
                        key={approval.id}
                        approval={approval}
                        disabled={actionPending || session.archived}
                        onApprove={() => void decide(approval, true)}
                        onReject={() => void decide(approval, false)}
                        onExecute={execute}
                      />
                    ))}
                  </div>
                ) : (
                  <div key={item.message.id} className={`ai-msg ai-msg-${item.message.role}`}>
                    <div className="ai-msg-role">{ROLE_LABELS[item.message.role] ?? item.message.role}</div>
                    {item.message.content && <div className="ai-msg-content">{item.message.content}</div>}
                    {(item.message.images ?? []).length > 0 && (
                      <div className="ai-msg-images">
                        {(item.message.images ?? []).map((name) => (
                          <SessionMessageImage key={name} rootPath={rootPath} sessionId={session.id} name={name} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {liveRun && liveRun.streamText ? (
                  <div className="ai-msg ai-msg-assistant ai-msg-streaming">
                    <div className="ai-msg-role">白泽 · 生成中</div>
                    <div className="ai-msg-content">{liveRun.streamText}</div>
                  </div>
                ) : null}
              </div>
              {!atBottom && (
                <button type="button" className="ai-session-jump-bottom" onClick={jumpToBottom}>↓ 回到底部</button>
              )}
              </div>
              {liveRun && <RunStatus live={liveRun} now={now} />}
              {busy && !liveRun && <div className="ai-session-running">正在处理，请稍候…</div>}
              {pendingImages.length > 0 && (
                <div className="ai-session-attachments">
                  {pendingImages.map((item) => (
                    <span key={item.name} className="ai-session-attachment">
                      <img src={item.dataUrl} alt={item.name} />
                      <button type="button" title="移除图片" onClick={() => removePendingImage(item.name)}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="header-actions">
                {["读取复盘证据包并列出未读资料、版本差异、人工删除原因、替代待办、跨轮次冲突和待复测项。先完整分页读取索引，再追读原文。", "生成给开发agent的可复制外派评审文档，包含稳定ID、指纹、人工修改与禁止恢复项，不创建旧任务包。", "根据实际轮次生成中间复盘、报告草稿和知识提案，记录来源指纹、未执行与待复测，知识不发布。"].map((text,index)=><button className="button button-ghost button-small" key={index} disabled={busy || session.archived} onClick={()=>setDraft(draft ? `${draft}\n${text}` : text)}>{["测后复盘","生成外派词","报告与知识提案"][index]}</button>)}
              </div>
              <div className="ai-session-composer">
                <textarea
                  className="field-input field-textarea"
                  value={draft}
                  disabled={busy || session.archived}
                  placeholder="输入问题或要求，可粘贴图片（Enter 发送，Ctrl + Enter 换行）"
                  onChange={(event) => setDraft(event.target.value)}
                  onPaste={(event) => void pasteImages(event)}
                  onKeyDown={(event) => {
                    const action = composerKeyAction({
                      key: event.key,
                      shiftKey: event.shiftKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      isComposing: event.nativeEvent.isComposing,
                      keyCode: event.keyCode,
                      hasText: draft.trim().length > 0 || pendingImages.length > 0,
                    });
                    if (action === "native") return;
                    event.preventDefault();
                    if (action === "send") {
                      void send();
                    } else if (action === "newline") {
                      const target = event.currentTarget;
                      const next = insertLineBreak(target.value, target.selectionStart, target.selectionEnd);
                      setDraft(next.value);
                      requestAnimationFrame(() => target.setSelectionRange(next.caret, next.caret));
                    }
                  }}
                />
                {busy && <button className="button button-ghost" disabled={liveRun?.stopping} onClick={stopRun}>{liveRun?.stopping ? "停止中…" : "停止"}</button>}
                <button className="button button-primary" disabled={busy || (!draft.trim() && pendingImages.length === 0) || session.archived} onClick={() => void send()}>
                  {busy ? "处理中…" : "发送"}
                </button>
              </div>
            </>
          )}
          {shownError && !creating && !restoreOpen && <div className="ai-session-error">{shownError}</div>}
        </section>
      </div>

      {creating && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false); }}>
          <div className="modal ai-session-create" role="dialog" aria-modal="true" aria-labelledby="ai-session-create-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">AI会话</span>
                <h2 id="ai-session-create-title">新建会话</h2>
              </div>
            </div>
            <label className="field-label ai-session-field">
              <span>平台</span>
              <select className="field-input" value={newPlatformId} onChange={(event) => choosePlatform(event.target.value)}>
                <option value="">不选择（仅聊天）</option>
                {activePlatforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}</option>)}
              </select>
            </label>
            <label className="field-label ai-session-field">
              <span>需求</span>
              <select className="field-input" value={newRequirementKey} disabled={!newPlatformId || optionsLoading} onChange={(event) => setNewRequirementKey(event.target.value)}>
                <option value="">{newPlatformId ? "不关联需求（仅聊天）" : "请先选择平台"}</option>
                {platformOptions.map((option) => <option key={option.key} value={option.key}>{requirementText(option)}</option>)}
              </select>
              {newPlatformId && optionsLoading && <small className="ai-session-hint">正在加载需求…</small>}
              {newPlatformId && !optionsLoading && platformOptions.length === 0 && <small className="ai-session-hint">该平台下暂无需求</small>}
            </label>
            <label className="field-label ai-session-field">
              <span>权限</span>
              <select className="field-input" value={newMode} onChange={(event) => setNewMode(event.target.value)}>
                {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="field-label ai-session-field">
              <span>标题（可选）</span>
              <input className="field-input" value={newTitle} placeholder={autoTitle} onChange={(event) => setNewTitle(event.target.value)} />
            </label>
            {newRequirementKey && sessions.filter(s => !s.archived && s.platform_id === newPlatformId && `${s.platform_id}::${s.requirement_id}` === newRequirementKey).map(s => <button key={s.id} className="button button-ghost" onClick={() => {if(selectionText) saveComposer(`${rootPath}:${s.id}`,{text:`${readComposer(`${rootPath}:${s.id}`)?.text || ""}${selectionText}`,images:readComposer(`${rootPath}:${s.id}`)?.images || []});setActiveId(s.id);setCreating(false);}}>继续已有会话：{s.title}</button>)}
            {!newRequirementKey && <p className="modal-description">未关联需求的会话只能聊天，不能写入文件。</p>}
            {shownError && <div className="ai-session-error">{shownError}</div>}
            <div className="modal-actions">
              <button className="button button-ghost" disabled={saving} onClick={() => setCreating(false)}>取消</button>
              <button className="button button-primary" disabled={saving} onClick={() => void createSession()}>创建会话</button>
            </div>
          </div>
        </div>
      )}

      {restoreOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRestoreOpen(false); }}>
          <div className="modal ai-session-create ai-restore-modal" role="dialog" aria-modal="true" aria-labelledby="ai-restore-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">AI会话</span>
                <h2 id="ai-restore-title">改动记录</h2>
              </div>
            </div>
            <p className="modal-description">每次运行写入的文件都有记录，可以按运行还原。被你手动改过的文件会标记为冲突并保留，不会覆盖你的修改。</p>
            {runs.length === 0 && <p className="modal-description">这个会话还没有可还原的改动。</p>}
            <ul className="ai-run-list">
              {runs.map((item) => (
                <li key={item.run_id}>
                  <button className={`ai-run-item ${item.run_id === planRunId ? "active" : ""}`} onClick={() => void openPlan(item.run_id)}>
                    <strong>{formatTime(item.created_at)}</strong>
                    <small>{item.changes} 项改动 · 待还原 {item.pending}</small>
                  </button>
                </li>
              ))}
            </ul>
            {plan && (
              <div className="ai-restore-plan">
                <ul>
                  {plan.map((item) => (
                    <li key={`${item.seq}-${item.path}`} className={`ai-restore-${item.status}`}>
                      <span className="status-pill">{RESTORE_STATUS_LABELS[item.status]}</span>
                      <span className="mono">{item.path}</span>
                      <small>{item.action}{item.reason ? ` · ${item.reason}` : ""}</small>
                    </li>
                  ))}
                </ul>
                <div className="modal-actions">
                  <button className="button button-primary" disabled={restoreBusy || busy || !plan.some((item) => item.status === "ready")} onClick={() => void applyRestore()}>
                    {restoreBusy ? "还原中…" : "还原可还原项"}
                  </button>
                </div>
              </div>
            )}
            {shownError && <div className="ai-session-error">{shownError}</div>}
            <div className="modal-actions">
              <button className="button button-ghost" onClick={() => setRestoreOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
