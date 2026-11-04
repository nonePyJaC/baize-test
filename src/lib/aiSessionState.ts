// 会话运行状态的投影（纯函数）：把后端事件与快照归并为界面所需的会话状态。
// 没有 Tauri 与网络依赖，便于在 Node 中直接验证。

import { applyLive, createLive, liveFromSnapshot, type LiveRun } from "./aiLive";
import type { AgentEvent, AgentSnapshot, AiApproval, AiSession, AiSessionMessage } from "./aiSessionTypes";

export interface SessionRuntimeState {
  /** 会话的落盘副本（消息与审批由事件增量更新，运行结束后整体刷新） */
  session: AiSession | null;
  /** 会话所在工作区，用于读取与发起运行 */
  rootPath: string | null;
  busy: boolean;
  runId: string | null;
  live: LiveRun | null;
  error: string | null;
  /** 每收到一条事件或快照递增，用于判断刷新结果是否已过期 */
  version: number;
}

export const EMPTY_SESSION_STATE: SessionRuntimeState = {
  session: null,
  rootPath: null,
  busy: false,
  runId: null,
  live: null,
  error: null,
  version: 0,
};

function upsertMessage(messages: AiSessionMessage[], message: AiSessionMessage): AiSessionMessage[] {
  return messages.some((item) => item.id === message.id) ? messages : [...messages, message];
}

function upsertApproval(approvals: AiApproval[], approval: AiApproval): AiApproval[] {
  return approvals.some((item) => item.id === approval.id)
    ? approvals.map((item) => (item.id === approval.id ? approval : item))
    : [...approvals, approval];
}

export function reduceAgentEvent(state: SessionRuntimeState, event: AgentEvent, now: number): SessionRuntimeState {
  const version = state.version + 1;
  switch (event.kind) {
    case "run_started":
      return { ...state, version, busy: true, runId: event.run_id, live: createLive(event.run_id, now), error: null };
    case "run_finished":
      return {
        ...state,
        version,
        busy: false,
        runId: null,
        live: null,
        error: event.status === "failed" ? event.error ?? "运行失败" : null,
      };
    case "message":
      return state.session
        ? { ...state, version, session: { ...state.session, messages: upsertMessage(state.session.messages, event.message) } }
        : { ...state, version };
    case "approval": {
      const session = state.session
        ? { ...state.session, approvals: upsertApproval(state.session.approvals, event.approval) }
        : state.session;
      const live = state.live && event.run_id === state.runId ? applyLive(state.live, event, now) : state.live;
      return { ...state, version, session, live };
    }
    default:
      return state.live && event.run_id === state.runId
        ? { ...state, version, live: applyLive(state.live, event, now) }
        : { ...state, version };
  }
}

/** 快照只表示运行是否进行中及其实时状态；会话内容仍以落盘副本为准。 */
export function stateFromSnapshot(state: SessionRuntimeState, snapshot: AgentSnapshot, now: number): SessionRuntimeState {
  const version = state.version + 1;
  if (!snapshot.busy || !snapshot.run_id) {
    return { ...state, version, busy: false, runId: null, live: null };
  }
  return {
    ...state,
    version,
    busy: true,
    runId: snapshot.run_id,
    live: snapshot.live ? liveFromSnapshot(snapshot.live, snapshot.run_id, now) : createLive(snapshot.run_id, now),
  };
}

export function withSession(state: SessionRuntimeState, session: AiSession): SessionRuntimeState {
  return { ...state, version: state.version + 1, session };
}
