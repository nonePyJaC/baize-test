// AI 会话的前端类型，与 Rust 侧 sessions.rs / ai_tools.rs 的 serde 结构保持一致。

export interface AiSessionToolRecord {
  id: string;
  name: string;
  arguments?: string;
  ok?: boolean;
  changed_paths?: string[];
  error?: string | null;
}

export interface AiSessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: string;
  tool_calls: AiSessionToolRecord[];
  /** 随消息附带的图片文件名（会话 attachments 目录下），由后端写入 */
  images?: string[];
}

export interface AiSession {
  id: string;
  title: string;
  platform_id: string | null;
  requirement_id: string | null;
  permission_mode: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
  messages: AiSessionMessage[];
  approvals: AiApproval[];
  memory?: AiSessionMemory | null;
}

export interface AiSessionMemory {
  summary?: { text: string; until_message_id: string; updated_at: string } | null;
  read_index?: AiReadIndexEntry[];
}

export interface AiReadIndexEntry {
  path: string;
  total_chars: number;
  digest: string;
  read_at: string;
}

export interface AiRunSummary {
  run_id: string;
  created_at: string;
  changes: number;
  pending: number;
}

export interface AiRestoreItem {
  seq: number;
  path: string;
  action: string;
  status: "ready" | "done" | "noop" | "skipped" | "conflict";
  reason: string | null;
}

export interface AiRestoreOutcome {
  restored: number;
  skipped: number;
  conflicts: number;
  items: AiRestoreItem[];
  changed_paths: string[];
}

export interface AiStreamEvent {
  runId: string;
  kind: "text" | "reasoning" | "tool";
  delta?: string;
  name?: string;
  index?: number;
  chars: number;
}

export interface AiApproval {
  id: string;
  status: "pending" | "approved" | "rejected" | "consumed";
  tool_call_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  paths: string[];
  reason: string;
  created_at: string;
  decided_at: string | null;
  run_id?: string | null;
  notified?: boolean;
}

/** 后端运行时的实时状态快照（界面刷新或重新打开会话时用于接回进行中的运行）。 */
export interface AgentLiveState {
  seq: number;
  reason: string;
  round: number;
  phase: string;
  text: string;
  reasoning_chars: number;
  streaming_tool: { name: string; chars: number } | null;
  tool: { id: string; name: string; detail: string; started_ms: number } | null;
  compact_part: number | null;
  compact_total: number | null;
  approval_name: string;
  context_tokens: number;
  trigger_tokens: number;
  stopping: boolean;
}

export interface AgentSnapshot {
  busy: boolean;
  run_id: string | null;
  live: AgentLiveState | null;
}

export interface AgentDecision {
  approval: AiApproval;
  run_id: string | null;
}

/** 后端请求界面执行的客户端工具（文档解析、XMind 生成）。 */
export interface AgentClientRequest {
  request_id: string;
  session_id: string;
  run_id: string;
  kind: string;
  payload: Record<string, unknown>;
}

interface AgentEventBase {
  session_id: string;
  run_id: string;
  seq: number;
}

/** 后端推送的运行事件；run_id 为空的事件表示与运行无关的会话变化（如审批决定）。 */
export type AgentEvent = AgentEventBase &
  (
    | { kind: "run_started"; reason: string }
    | { kind: "round"; round: number; context_tokens: number; trigger_tokens: number }
    | { kind: "text"; delta: string }
    | { kind: "reasoning"; chars: number }
    | { kind: "tool_args"; name: string; chars: number }
    | { kind: "tool_started"; id: string; name: string; detail: string }
    | { kind: "tool_finished"; id: string; name: string; ok: boolean }
    | { kind: "approval"; approval: AiApproval }
    | { kind: "compacting"; part: number | null; total: number | null }
    | { kind: "message"; message: AiSessionMessage }
    | { kind: "run_finished"; status: "completed" | "stopped" | "failed"; error: string | null }
  );

export interface AiSessionSummary {
  id: string;
  title: string;
  platform_id: string | null;
  requirement_id: string | null;
  permission_mode: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface AiToolResult {
  tool: string;
  output: unknown;
  changed_paths: string[];
}

export interface AiModelToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string | Record<string, unknown> };
}

export type AiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface AiModelUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface AiModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AiContentPart[] | null;
  tool_calls?: AiModelToolCall[];
  tool_call_id?: string;
  usage?: AiModelUsage;
}
