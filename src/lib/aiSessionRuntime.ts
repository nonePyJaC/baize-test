import { loadConnections } from "../services/integrations";
// AI 会话的前端运行时：订阅后端运行事件、维护每个会话的投影，并转发发起、续跑、审批与停止等操作。
// 循环与运行状态都在后端；界面刷新或切换页面不会中断运行，重新打开会话时用快照接回进度。

import { api } from "./api";
import { runClientTool } from "./aiClientTools";
import { ensureRequirementDocxAssets } from "./docxAssetSync";
import { EMPTY_SESSION_STATE, reduceAgentEvent, stateFromSnapshot, withSession, type SessionRuntimeState } from "./aiSessionState";
import type { AgentClientRequest, AgentEvent, AgentSnapshot, AiApproval, AiSession } from "./aiSessionTypes";
import type { ModelProviderSettings } from "./types";

export type AiView = "tasks" | "sessions";

export interface RunContext {
  rootPath: string;
  provider: ModelProviderSettings;
  connections?: import("../domain/integrations").Connection[];
  requirementLabel: string;
  requirementDir: string;
}

const BUSY_TEXT = "该会话正在处理中，请等待完成，或先点击「停止」";
const states = new Map<string, SessionRuntimeState>();
const listeners = new Set<() => void>();
const handledRequests = new Set<string>();
let snapshot: ReadonlyMap<string, SessionRuntimeState> = new Map();
let selectedId: string | null = null;
let currentView: AiView = "tasks";
let initialized = false;

function publish(): void {
  snapshot = new Map(states);
  listeners.forEach((listener) => listener());
}

function stateOf(sessionId: string): SessionRuntimeState {
  return states.get(sessionId) ?? EMPTY_SESSION_STATE;
}

function patch(sessionId: string, next: SessionRuntimeState): void {
  states.set(sessionId, next);
  publish();
}

function remember(sessionId: string, rootPath: string): void {
  const current = stateOf(sessionId);
  if (current.rootPath !== rootPath) patch(sessionId, { ...current, rootPath });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function handleEvent(event: AgentEvent): void {
  patch(event.session_id, reduceAgentEvent(stateOf(event.session_id), event, Date.now()));
  if (event.kind === "run_finished") void refresh(event.session_id);
}

/** 运行结束后以落盘内容为准刷新会话；若期间又有新事件，放弃这次刷新，之后的运行结束会再次刷新。 */
async function refresh(sessionId: string): Promise<void> {
  const before = stateOf(sessionId);
  if (!before.rootPath) return;
  try {
    const session = await api.readAiSession(before.rootPath, sessionId);
    const current = stateOf(sessionId);
    if (current.version === before.version) patch(sessionId, withSession(current, session));
  } catch {
    // 读取失败时保留投影；下次打开会话时再读取
  }
}

async function syncSnapshot(sessionId: string): Promise<void> {
  const info: AgentSnapshot = await api.agentSnapshot(sessionId);
  patch(sessionId, stateFromSnapshot(stateOf(sessionId), info, Date.now()));
}

async function handleClientRequest(request: AgentClientRequest): Promise<void> {
  if (handledRequests.has(request.request_id)) return;
  handledRequests.add(request.request_id);
  try {
    const result = await runClientTool(request);
    await api.agentRespondClientTool(request.request_id, true, result, null);
  } catch (error) {
    await api.agentRespondClientTool(request.request_id, false, null, errorText(error));
  }
}

/** 应用启动时调用一次：订阅运行事件与客户端工具请求，并接回已在进行的运行。 */
export function initAiSessionRuntime(): void {
  if (initialized || !isTauriRuntime()) return;
  initialized = true;
  void api.onAgentEvent(handleEvent);
  void api.onAgentClientRequest((request) => void handleClientRequest(request));
  void api
    .agentPendingClientRequests()
    .then((requests) => requests.forEach((request) => void handleClientRequest(request)))
    .catch(() => undefined);
  void api
    .agentActiveSessions()
    .then((ids) => ids.forEach((id) => void syncSnapshot(id).catch(() => undefined)))
    .catch(() => undefined);
}

export const aiSessionRuntime = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSnapshot(): ReadonlyMap<string, SessionRuntimeState> {
    return snapshot;
  },

  state(sessionId: string | null): SessionRuntimeState {
    return (sessionId && snapshot.get(sessionId)) || EMPTY_SESSION_STATE;
  },

  selected(): string | null {
    return selectedId;
  },

  select(sessionId: string | null): void {
    selectedId = sessionId;
  },

  view(): AiView {
    return currentView;
  },

  setView(view: AiView): void {
    currentView = view;
  },

  /** 打开会话：读取落盘内容，并同步进行中的运行。 */
  async load(rootPath: string, sessionId: string): Promise<AiSession> {
    const session = await api.readAiSession(rootPath, sessionId);
    patch(sessionId, { ...withSession(stateOf(sessionId), session), rootPath });
    await syncSnapshot(sessionId);
    return session;
  },

  setSession(sessionId: string, session: AiSession): void {
    patch(sessionId, withSession(stateOf(sessionId), session));
  },

  forget(sessionId: string): void {
    states.delete(sessionId);
    if (selectedId === sessionId) selectedId = null;
    publish();
  },

  async send(sessionId: string, text: string, images: string[], context: RunContext): Promise<void> {
    if (stateOf(sessionId).busy) throw new Error(BUSY_TEXT);
    remember(sessionId, context.rootPath);
    await ensureRequirementDocxAssets(context.rootPath, context.requirementDir).catch(() => 0);
    await api.agentStartTurn(
      context.rootPath,
      sessionId,
      text,
      context.provider,
      context.requirementLabel,
      context.requirementDir,
      images,
      null,
      await loadConnections(),
    );
  },

  async resume(sessionId: string, reason: "approval" | "interrupted", context: RunContext): Promise<void> {
    remember(sessionId, context.rootPath);
    await api.agentResume(
      context.rootPath,
      sessionId,
      reason,
      context.provider,
      context.requirementLabel,
      context.requirementDir,
      null,
      await loadConnections(),
    );
  },

  async decide(sessionId: string, approvalId: string, approved: boolean, context: RunContext): Promise<AiApproval> {
    remember(sessionId, context.rootPath);
    const decision = await api.agentDecide(
      context.rootPath,
      sessionId,
      approvalId,
      approved,
      context.provider,
      context.requirementLabel,
      context.requirementDir,
      null,
      await loadConnections(),
    );
    return decision.approval;
  },

  stop(sessionId: string): void {
    const current = stateOf(sessionId);
    if (current.live) patch(sessionId, { ...current, live: { ...current.live, stopping: true } });
    void api.agentStop(sessionId).catch(() => false);
  },
};
