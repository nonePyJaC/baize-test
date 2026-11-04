import type { AiApproval, AiSession, AiSessionMessage, AiSessionToolRecord } from "./aiSessionTypes";

export const READ_TOOL_NAMES = ["read_file", "read_document", "read_xmind", "list_directory"];

const SKIPPED_ERROR = "已停止，未执行";
const APPROVAL_ERROR_PREFIX = "等待用户审批";
const IMAGE_PATTERN = /\.(png|jpe?g|gif|webp|bmp)$/i;
const RESUME_NOTES = ["审批结果已同步", "上一次运行被中断"];
const ACTION_LABELS: Record<string, string> = {
  create_file: "新建",
  update_file: "修改",
  delete_path: "删除",
  move_path: "移动",
  create_directory: "新建目录",
  write_xmind: "生成用例",
};

export type TimelineItem =
  | { kind: "message"; message: AiSessionMessage }
  | { kind: "process"; id: string; messages: AiSessionMessage[] };

export type ItemState = "pending" | "ok" | "failed" | "skipped" | "approval" | "rejected";

export interface ReadItem {
  id: string;
  kind: "document" | "image" | "directory" | "xmind";
  target: string;
  state: ItemState;
  note: string;
}

export interface WriteItem {
  id: string;
  action: string;
  target: string;
  state: ItemState;
  note: string;
}

export type ProcessEntry =
  | { kind: "thought"; text: string }
  | { kind: "reads"; id: string; items: ReadItem[] }
  | { kind: "write"; item: WriteItem };

export interface ProcessSummary {
  entries: ProcessEntry[];
  reads: number;
  writes: number;
  failed: number;
  waiting: number;
}

function isProcessMessage(message: AiSessionMessage): boolean {
  return message.role === "tool" || (message.role === "assistant" && (message.tool_calls ?? []).length > 0);
}

export function buildTimeline(messages: AiSessionMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const message of messages) {
    if (!isProcessMessage(message)) {
      items.push({ kind: "message", message });
      continue;
    }
    const last = items[items.length - 1];
    if (last?.kind === "process") last.messages.push(message);
    else items.push({ kind: "process", id: message.id, messages: [message] });
  }
  return items;
}

export function summarizeProcess(messages: AiSessionMessage[], approvals: AiApproval[] = []): ProcessSummary {
  const approvalStatus = new Map<string, AiApproval["status"]>();
  approvals.forEach((approval) => approvalStatus.set(approval.tool_call_id, approval.status));
  const entries: ProcessEntry[] = [];
  const reads = new Map<string, ReadItem>();
  const writes = new Map<string, WriteItem>();
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content.trim();
      if (text) entries.push({ kind: "thought", text });
      for (const call of message.tool_calls ?? []) {
        const args = parseArguments(call.arguments);
        if (READ_TOOL_NAMES.includes(call.name)) {
          const item: ReadItem = { id: call.id, kind: readKind(call.name, args), target: readTarget(call.name, args), state: "pending", note: "" };
          reads.set(call.id, item);
          const last = entries[entries.length - 1];
          if (last?.kind === "reads") last.items.push(item);
          else entries.push({ kind: "reads", id: call.id, items: [item] });
        } else {
          const item: WriteItem = { id: call.id, action: ACTION_LABELS[call.name] ?? "写入", target: writeTarget(args), state: "pending", note: "" };
          writes.set(call.id, item);
          entries.push({ kind: "write", item });
        }
      }
    } else if (message.role === "tool") {
      for (const record of message.tool_calls ?? []) {
        const item = reads.get(record.id) ?? writes.get(record.id);
        if (item) applyRecord(item, record);
      }
    }
  }
  const all: Array<ReadItem | WriteItem> = [...reads.values(), ...writes.values()];
  for (const item of all) {
    const status = approvalStatus.get(item.id);
    if (item.state !== "approval" || !status) continue;
    if (status === "rejected") item.state = "rejected";
    else if (status === "approved") item.note = "已批准，等待执行";
  }
  return {
    entries,
    reads: reads.size,
    writes: writes.size,
    failed: all.filter((item) => item.state === "failed").length,
    waiting: all.filter((item) => item.state === "approval").length,
  };
}

export function readGroupLabel(items: ReadItem[]): string {
  const anchor = items.find((item) => item.kind !== "directory") ?? items[0];
  const allImages = items.every((item) => item.kind === "image");
  const allDirectories = items.every((item) => item.kind === "directory");
  const plain = items.every((item) => item.kind === "document" || item.kind === "xmind");
  const verb = allImages ? "查看图片" : allDirectories ? "浏览" : plain ? "读取" : "查看";
  if (items.length === 1) return `${verb} ${anchor.target}`;
  const noun = allImages ? "张" : allDirectories ? "个目录" : "项";
  return `${verb} ${baseName(anchor.target)} 等 ${items.length} ${noun}`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function processMeta(summary: ProcessSummary, active: boolean): string {
  return [
    summary.reads ? `查看 ${summary.reads} 项资料` : "",
    summary.writes ? `改动 ${summary.writes} 项` : "",
    summary.failed ? `${summary.failed} 项失败` : "",
    summary.waiting ? `${summary.waiting} 项待审批` : "",
    active ? "进行中" : "",
  ].filter(Boolean).join(" · ");
}

export function wasInterrupted(session: Pick<AiSession, "messages" | "approvals">): boolean {
  if (session.approvals.some((approval) => approval.status === "pending" || approval.status === "approved")) return false;
  const last = session.messages[session.messages.length - 1];
  if (!last) return false;
  if (last.role === "system") return RESUME_NOTES.some((note) => last.content.startsWith(note));
  if (last.role === "assistant") return (last.tool_calls ?? []).length > 0;
  return true;
}

function applyRecord(item: ReadItem | WriteItem, record: AiSessionToolRecord): void {
  if (record.ok) {
    item.state = "ok";
    item.note = "";
    return;
  }
  const error = record.error ?? "";
  if (error === SKIPPED_ERROR) {
    item.state = "skipped";
    item.note = "";
  } else if (error.startsWith(APPROVAL_ERROR_PREFIX)) {
    item.state = "approval";
    item.note = "";
  } else {
    item.state = "failed";
    item.note = error || "执行失败";
  }
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw ?? "");
    return path ? { path: path[1] } : {};
  }
}

function readKind(name: string, args: Record<string, unknown>): ReadItem["kind"] {
  if (name === "list_directory") return "directory";
  if (name === "read_xmind") return "xmind";
  return IMAGE_PATTERN.test(String(args.path ?? "")) ? "image" : "document";
}

function readTarget(name: string, args: Record<string, unknown>): string {
  if (name === "list_directory") return typeof args.path === "string" && args.path ? args.path : "工作区根目录";
  return String(args.path ?? "");
}

function writeTarget(args: Record<string, unknown>): string {
  if (typeof args.from === "string") return `${args.from} → ${String(args.to ?? "")}`;
  return String(args.path ?? args.title ?? "");
}
