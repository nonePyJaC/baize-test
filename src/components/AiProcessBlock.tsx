import React, { useMemo } from "react";
import type { AiApproval, AiSessionMessage } from "../lib/aiSessionTypes";
import {
  processMeta,
  readGroupLabel,
  summarizeProcess,
  type ItemState,
  type ProcessEntry,
  type ReadItem,
  type WriteItem,
} from "../lib/aiTimeline";

const STATE_TEXT: Record<ItemState, string> = {
  pending: "进行中",
  ok: "",
  failed: "失败",
  skipped: "未执行",
  approval: "待审批",
  rejected: "已拒绝",
};

interface AiProcessBlockProps {
  messages: AiSessionMessage[];
  approvals: AiApproval[];
  active: boolean;
}

export default function AiProcessBlock({ messages, approvals, active }: AiProcessBlockProps) {
  const summary = useMemo(() => summarizeProcess(messages, approvals), [messages, approvals]);
  return (
    <details className={`ai-process ${active ? "active" : ""}`}>
      <summary>
        <span className="ai-process-title">思考过程</span>
        <span className="ai-process-meta">{processMeta(summary, active)}</span>
      </summary>
      <div className="ai-process-body">
        {summary.entries.map((entry, index) => (
          <ProcessRow key={entryKey(entry, index)} entry={entry} />
        ))}
      </div>
    </details>
  );
}

function entryKey(entry: ProcessEntry, index: number): string {
  if (entry.kind === "thought") return `thought-${index}`;
  if (entry.kind === "reads") return `reads-${entry.id}`;
  return `write-${entry.item.id}`;
}

function ProcessRow({ entry }: { entry: ProcessEntry }) {
  if (entry.kind === "thought") return <p className="ai-process-thought">{entry.text}</p>;
  if (entry.kind === "reads") return <ReadRun items={entry.items} />;
  return <WriteRow item={entry.item} />;
}

function groupState(items: ReadItem[]): ItemState {
  if (items.some((item) => item.state === "failed")) return "failed";
  if (items.every((item) => item.state === "ok")) return "ok";
  return "pending";
}

function ReadRun({ items }: { items: ReadItem[] }) {
  const label = readGroupLabel(items);
  if (items.length === 1) {
    const [item] = items;
    return (
      <div className={`ai-process-line ai-process-${item.state}`}>
        <span className="ai-process-dot" aria-hidden="true" />
        <span className="ai-process-text">{label}</span>
        {item.note && <span className="ai-process-note">{item.note}</span>}
      </div>
    );
  }
  const failed = items.filter((item) => item.state === "failed").length;
  return (
    <details className={`ai-process-reads ai-process-${groupState(items)}`}>
      <summary>
        <span className="ai-process-dot" aria-hidden="true" />
        <span className="ai-process-text">{failed ? `${label} · ${failed} 项失败` : label}</span>
      </summary>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={`ai-process-${item.state}`}>
            <span className="mono" title={item.target}>{item.target}</span>
            {item.note && <small>{item.note}</small>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function WriteRow({ item }: { item: WriteItem }) {
  const stateText = STATE_TEXT[item.state];
  return (
    <div className={`ai-process-line ai-process-${item.state}`}>
      <span className="ai-process-dot" aria-hidden="true" />
      <span className="ai-process-text">{item.action} <span className="mono">{item.target}</span></span>
      {stateText && <span className="ai-process-state">{stateText}</span>}
      {item.note && <span className="ai-process-note">{item.note}</span>}
    </div>
  );
}
