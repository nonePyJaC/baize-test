// 客户端审计日志：把关键操作追加到 .blackbox/logs/client-<日期>.jsonl。
// 只记录固定字段摘要（模块/动作/结果/详情），禁止写入密钥、Token、Cookie 或完整请求报文。
import { api } from "./api";
import type { WorkspaceLogLevel } from "./types";

export interface ClientLogAction {
  module: string;
  action: string;
  result?: string;
  detail?: string;
  level?: WorkspaceLogLevel;
}

export function logClientAction(rootPath: string, entry: ClientLogAction): void {
  if (!rootPath.trim() || !entry.action.trim()) return;
  void api
    .appendWorkspaceLog(rootPath, {
      level: entry.level || "info",
      module: entry.module.trim() || "客户端",
      action: entry.action.trim(),
      result: entry.result?.trim() || "",
      detail: entry.detail?.trim() || "",
    })
    .catch(() => undefined);
}
