import React, { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { aiSessionRuntime } from "../lib/aiSessionRuntime";
import type { AiSessionSummary } from "../lib/aiSessionTypes";

export function openSessionLink(id?: string) {
  if (id) aiSessionRuntime.select(id);
  window.dispatchEvent(
    new CustomEvent("baize-open-ai-session", { detail: { id } }),
  );
}
export default function AiSessionLinks({
  rootPath,
  platformId,
  requirementId,
}: {
  rootPath: string;
  platformId?: string;
  requirementId?: string;
}) {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [error, setError] = useState("");
  const runtime = useSyncExternalStore(
    aiSessionRuntime.subscribe,
    aiSessionRuntime.getSnapshot,
  );
  const activity = [...runtime].map(([id, s]) => `${id}:${s.busy}:${s.session?.updated_at}`).join("|");
  useEffect(() => {
    let alive = true;
    api
      .listAiSessions(rootPath)
      .then((list) => {
        if (alive) {
          setSessions(list);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [rootPath, activity]);
  const list = sessions.filter(
    (s) =>
      !s.archived &&
      (!platformId || s.platform_id === platformId) &&
      (!requirementId || s.requirement_id === requirementId),
  );
  return (
    <div className="context-task-list">
      <button
        className="button button-ghost button-small"
        onClick={() => openSessionLink()}
      >
        打开AI会话
      </button>
      {error && <p>{error}</p>}
      {!list.length && <p className="section-muted">暂无关联会话</p>}
      {list.map((s) => (
        <button
          className="context-task-item"
          key={s.id}
          onClick={() => openSessionLink(s.id)}
        >
          <strong>{s.title}</strong>
          <small>
            {s.platform_id} / {s.requirement_id} ·{" "}
            {runtime.get(s.id)?.busy ? "运行中" : "运行已结束 / 交付待核对"}
          </small>
        </button>
      ))}
    </div>
  );
}
