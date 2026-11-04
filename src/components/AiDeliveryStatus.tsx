import React, { useEffect, useState } from "react";
import { api, joinPath } from "../lib/api";
import { parseXMindOutline, parseOutline } from "../lib/aiOutput";
import { validateCaseTemplate } from "../lib/caseTemplate";
import type { AiSession } from "../lib/aiSessionTypes";

export default function AiDeliveryStatus({
  rootPath,
  session,
  busy,
}: {
  rootPath: string;
  session: AiSession;
  busy: boolean;
}) {
  const [items, setItems] = useState<{ path: string; status: string }[]>([]);
  const [error, setError] = useState("");
  const calls = session.messages.flatMap((m) => m.tool_calls || []);
  const paths = [
    ...new Set(calls.filter((c) => c.ok).flatMap((c) => c.changed_paths || [])),
  ];
  const signature = paths.join("|");
  useEffect(() => {
    if (busy) return;
    let alive = true;
    Promise.all(
      paths.map(async (path) => {
        try {
          const full =
            path.startsWith("/") || /^[A-Za-z]:/.test(path)
              ? path
              : joinPath(rootPath, path);
          const info = await api.getPathInfo(full);
          if (!info.exists) return { path, status: "文件不存在，交付未完成" };
          if (path.endsWith(".json")) JSON.parse(await api.readTextFile(full));
          if (path.endsWith(".xmind")) {
            const parsed = await parseXMindOutline(
              await api.readBinaryFile(full),
            );
            const errors = validateCaseTemplate(parseOutline(parsed.outline));
            if (errors.length) throw new Error(errors.join("；"));
          }
          return { path, status: "文件可读取，格式已检查；业务内容待确认" };
        } catch (e) {
          return { path, status: `检查失败：${String(e)}` };
        }
      }),
    )
      .then((rows) => {
        if (alive) {
          setItems(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [rootPath, signature, busy]);
  return (
    <details className="ai-session-notice">
      <summary>
        交付核对 · {busy ? "运行中" : "运行已结束"} · 已记录产物路径{" "}
        {paths.length} · 失败工具 {calls.filter((c) => c.ok === false).length}
      </summary>
      <p>
        文件格式检查与业务验收分别确认；未读证据、遗漏批次、冲突及待办应在复盘与提案中继续处理。
      </p>
      {error && <p>{error}</p>}
      {!items.length && (
        <p>尚无可核对的落盘产物。停止、审批等待或仅对话不代表业务交付完成。</p>
      )}
      {items.map((i) => (
        <p key={i.path}>
          <button
            className="text-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(i.path);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            {i.path}
          </button>{" "}
          · {i.status}
        </p>
      ))}
    </details>
  );
}
