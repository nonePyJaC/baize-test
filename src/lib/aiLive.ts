// 运行中的实时状态：由后端 `agent-event` 逐条累积，界面只负责展示（循环在后端运行）。

import type { AgentEvent, AgentLiveState } from "./aiSessionTypes";

export interface LiveRun {
  runId: string;
  startedAt: number;
  round: number;
  phase: "model" | "tool" | "compacting" | "approval" | "stopped" | "completed" | "failed";
  lastEventAt: number;
  streamText: string;
  reasoningChars: number;
  streamingTool: { name: string; chars: number } | null;
  tool: { name: string; detail: string; startedAt: number } | null;
  toolCount: number;
  readCount: number;
  approvalName: string;
  stopping: boolean;
  contextTokens: number;
  triggerTokens: number;
  compactPart: string;
}

const READ_TOOLS = ["read_file", "read_document", "read_xmind", "list_directory"];
export const STALL_WARNING_MS = 25000;
const IMAGE_PATTERN = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function createLive(runId: string, now: number): LiveRun {
  return {
    runId,
    startedAt: now,
    round: 0,
    phase: "model",
    lastEventAt: now,
    streamText: "",
    reasoningChars: 0,
    streamingTool: null,
    tool: null,
    toolCount: 0,
    readCount: 0,
    approvalName: "",
    stopping: false,
    contextTokens: 0,
    triggerTokens: 0,
    compactPart: "",
  };
}

/** 把快照（界面刷新或重新打开会话时）还原为实时状态；计数类信息快照中没有，从 0 开始累计。 */
export function liveFromSnapshot(state: AgentLiveState, runId: string, now: number): LiveRun {
  return {
    ...createLive(runId, now),
    round: state.round,
    phase: (state.phase as LiveRun["phase"]) || "model",
    streamText: state.text,
    reasoningChars: state.reasoning_chars,
    streamingTool: state.streaming_tool ? { name: state.streaming_tool.name, chars: state.streaming_tool.chars } : null,
    tool: state.tool ? { name: state.tool.name, detail: state.tool.detail, startedAt: state.tool.started_ms } : null,
    approvalName: state.approval_name,
    stopping: state.stopping,
    contextTokens: state.context_tokens,
    triggerTokens: state.trigger_tokens,
    compactPart: state.compact_part && state.compact_total ? `第 ${state.compact_part}/${state.compact_total} 段` : "",
  };
}

export function applyLive(live: LiveRun, event: AgentEvent, now: number): LiveRun {
  switch (event.kind) {
    case "round":
      return {
        ...live,
        round: event.round,
        phase: "model",
        lastEventAt: now,
        streamText: "",
        reasoningChars: 0,
        streamingTool: null,
        tool: null,
        contextTokens: event.context_tokens,
        triggerTokens: event.trigger_tokens,
        compactPart: "",
      };
    case "text":
      return { ...live, streamText: live.streamText + event.delta, lastEventAt: now };
    case "reasoning":
      return { ...live, reasoningChars: live.reasoningChars + event.chars, lastEventAt: now };
    case "tool_args":
      return { ...live, streamingTool: { name: event.name, chars: event.chars }, lastEventAt: now };
    case "tool_started":
      return {
        ...live,
        phase: "tool",
        lastEventAt: now,
        streamText: "",
        streamingTool: null,
        tool: { name: event.name, detail: event.detail, startedAt: now },
        toolCount: live.toolCount + 1,
        readCount: live.readCount + (READ_TOOLS.includes(event.name) ? 1 : 0),
      };
    case "tool_finished":
      return { ...live, tool: null, lastEventAt: now };
    case "approval":
      return { ...live, phase: "approval", approvalName: approvalLabel(event.approval.tool), lastEventAt: now };
    case "compacting":
      return {
        ...live,
        phase: "compacting",
        lastEventAt: now,
        compactPart: event.part && event.total ? `第 ${event.part}/${event.total} 段` : "",
      };
    case "run_finished":
      return {
        ...live,
        phase: event.status,
        tool: null,
        streamingTool: null,
        lastEventAt: now,
      };
    default:
      return live;
  }
}

export function activityLabel(name: string, detail: string): string {
  const target = baseName(detail) || "资料";
  if (name === "read_document" || name === "read_file") return IMAGE_PATTERN.test(detail) ? `正在查看图片 ${target}` : `正在读取 ${target}`;
  if (name === "read_xmind") return `正在读取用例 ${target}`;
  if (name === "list_directory") return `正在浏览 ${detail || "工作区根目录"}`;
  if (name === "create_file") return `正在新建 ${target}`;
  if (name === "update_file") return `正在修改 ${target}`;
  if (name === "write_xmind") return `正在生成用例 ${target}`;
  if (name === "delete_path") return `正在删除 ${target}`;
  if (name === "move_path") return `正在移动 ${detail}`;
  if (name === "create_directory") return `正在新建目录 ${target}`;
  return "正在处理…";
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function approvalLabel(name: string): string {
  if (name === "delete_path") return "删除文件";
  if (name === "move_path") return "移动文件";
  if (name === "write_xmind") return "覆盖用例";
  return "写入文件";
}

function preparingLabel(name: string): string {
  return READ_TOOLS.includes(name) ? "正在准备读取资料…" : "正在准备修改内容…";
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function describeLive(live: LiveRun, now: number): { title: string; detail: string; warn: boolean } {
  const elapsed = Math.round((now - live.startedAt) / 1000);
  const context = live.triggerTokens ? `上下文约 ${formatTokens(live.contextTokens)} / ${formatTokens(live.triggerTokens)}` : "";
  const footer = [`已用时 ${elapsed} 秒`, context].filter(Boolean).join(" · ");
  if (live.stopping) return { title: "正在停止…", detail: `当前操作完成后停止 · ${footer}`, warn: false };
  if (live.phase === "stopped") return { title: "已停止", detail: footer, warn: false };
  if (live.phase === "compacting") return { title: "正在整理较早的过程", detail: [live.compactPart, footer].filter(Boolean).join(" · "), warn: false };
  if (live.phase === "approval") return { title: `等待你审批：${live.approvalName}`, detail: `请在下方的审批卡片中批准或拒绝 · ${footer}`, warn: false };
  if (live.phase === "tool" && live.tool) {
    const toolElapsed = Math.round((now - live.tool.startedAt) / 1000);
    return {
      title: activityLabel(live.tool.name, live.tool.detail),
      detail: [toolElapsed >= 5 ? `已 ${toolElapsed} 秒` : "", footer].filter(Boolean).join(" · "),
      warn: toolElapsed > 60,
    };
  }
  const idle = now - live.lastEventAt;
  const stalled = idle > STALL_WARNING_MS;
  const title = live.streamText
    ? "正在回复…"
    : live.streamingTool
      ? preparingLabel(live.streamingTool.name)
      : live.reasoningChars
        ? "正在思考…"
        : "正在等待模型回复…";
  const stall = stalled ? `已 ${Math.round(idle / 1000)} 秒没有新内容，仍在等待` : "";
  return { title, detail: [stall, footer].filter(Boolean).join(" · "), warn: stalled };
}
