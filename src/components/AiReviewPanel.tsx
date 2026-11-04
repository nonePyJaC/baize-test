import { caseActions, caseExpectedResults } from "../lib/cases";
import type { StructuredTestCase } from "../lib/types";
import React, { useEffect, useRef, useState } from "react";
import { api, joinPath } from "../lib/api";
import {
  applyReview,
  previewReview,
  reviewHasUnresolved,
  validateReviewProposal,
  type ReviewDecision,
  type ReviewProposal,
} from "../lib/reviewProposal";
import { invalidateBusinessData } from "../lib/businessEvents";
import { useDraftSave } from "../lib/draftGuard";

const statuses: [ReviewDecision, string][] = [
  ["pending", "待处理"],
  ["accepted", "采纳"],
  ["partial", "部分采纳"],
  ["retained", "保留原用例"],
  ["rejected", "拒绝"],
  ["needs_qa", "需答疑"],
];
export default function AiReviewPanel({
  rootPath,
  requirementDir,
  platformId,
  requirementId,
  sessionId,
  disabled,
  onClose,
}: {
  rootPath: string;
  requirementDir: string;
  platformId: string;
  requirementId: string;
  sessionId: string;
  disabled: boolean;
  onClose: () => void;
}) {
  const base = joinPath(rootPath, requirementDir);
  const reviews = joinPath(base, "03-测试计划", "reviews");
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [conflictDraft, setConflictDraft] = useState<any>(null);
  const [proposal, setProposal] = useState<ReviewProposal | null>(null);
  const [saved, setSaved] = useState<unknown>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const archiveHeadingRef = useRef<HTMLHeadingElement>(null);
  const draftKey = `baize-review:${reviews}`;
  useEffect(() => {
    if (!path || !proposal) return;
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          path,
          proposal,
          saved,
          partial,
          reason,
        }),
      );
    } catch {}
  }, [path, proposal, saved, partial, reason, draftKey]);
  const loadFiles = async () => {
    const entries = (await api.getPathInfo(reviews)).exists
      ? await api.listDirectory(reviews)
      : [];
    setFiles(
      entries
        .filter((e) => !e.is_dir && /^revision-proposal-.*\.json$/.test(e.name))
        .map((e) => e.name),
    );
  };
  useEffect(() => {
    loadFiles().catch((e) => setMessage(String(e)));
    try {
      const cache = JSON.parse(sessionStorage.getItem(draftKey) || "null");
      if (cache?.path)
        void load(cache.path).catch((e) => setMessage(String(e)));
    } catch {}
  }, [reviews]);
  const decisionPath = path
    ? joinPath(reviews, `${path.slice(0, -5)}.decisions.json`)
    : "";
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  const load = async (file: string) => {
    const raw = validateReviewProposal(
      await api.readJsonFile(joinPath(reviews, file)),
      platformId,
      requirementId,
    );
    const decisionFile = joinPath(
      reviews,
      `${file.slice(0, -5)}.decisions.json`,
    );
    const savedDecision = (await api.getPathInfo(decisionFile)).exists
      ? await api.readJsonFile(decisionFile)
      : null;
    const next = savedDecision
      ? validateReviewProposal(savedDecision, platformId, requirementId)
      : {
          ...raw,
          items: raw.items.map((i) => ({
            ...i,
            status: "pending" as const,
            event_ids: [],
          })),
        };
    if (
      next.proposal_id !== raw.proposal_id ||
      next.items.length !== raw.items.length ||
      next.items.some((i) => !raw.items.some((r) => r.item_id === i.item_id))
    )
      throw new Error("提案与处理记录不匹配");
    let cache: any = null;
    try {
      cache = JSON.parse(sessionStorage.getItem(draftKey) || "null");
    } catch {}
    const usable =
      cache?.path === file &&
      JSON.stringify(cache.saved) === JSON.stringify(savedDecision);
    if (cache?.path === file && !usable) {
      setConflictDraft(cache);
      try {
        sessionStorage.setItem(`${draftKey}:conflict`, JSON.stringify(cache));
      } catch {}
      setMessage(
        "磁盘处理记录已变化，本地草稿已另存；请查看冲突草稿后决定是否恢复",
      );
    } else {
      try {
        setConflictDraft(
          JSON.parse(sessionStorage.getItem(`${draftKey}:conflict`) || "null"),
        );
      } catch {}
    }
    setPath(file);
    setProposal(usable ? cache.proposal : next);
    setSaved(savedDecision);
    setPartial(usable ? cache.partial : {});
    if (usable) setReason(cache.reason || "");
    setPreview(null);
    setSelected(new Set());
  };
  const save = async (value = proposal) => {
    if (!value) return;
    const recorded = {
      ...value,
      decision_saved_at: new Date().toISOString(),
      source_session_id: sessionId,
    };
    await api.saveJsonFileIfUnchanged(decisionPath, saved, recorded);
    setSaved(recorded);
    setProposal(recorded);
  };
  useDraftSave(async () => {
    try {
      await save();
      return true;
    } catch (e) {
      setMessage(String(e));
      return false;
    }
  }, 10);
  const update = (id: string, status: ReviewDecision) => {
    setPreview(null);
    setProposal(
      (p) =>
        p && {
          ...p,
          items: p.items.map((i) =>
            i.item_id === id
              ? { ...i, status, handling_reason: reason || i.handling_reason }
              : i,
          ),
        },
    );
  };
  const prepare = async () => {
    if (!proposal) return;
    const value = {
      ...proposal,
      items: proposal.items.map((i) => {
        if (i.status !== "partial" || !partial[i.item_id]) return i;
        const after = JSON.parse(partial[i.item_id]);
        return {
          ...i,
          after,
          action: (!i.before ? "added" : after ? "modified" : "deleted") as
            "added" | "modified" | "deleted",
        };
      }),
    };
    validateReviewProposal(value, platformId, requirementId);
    await save(value);
    setPreview(await previewReview(base, value));
  };
  return (
    <section className="panel-section ai-review-panel">
      <div className="section-heading">
        <h2>用例修订建议</h2>
        <div className="section-heading-actions">
          <button
            className="button button-ghost button-small"
            onClick={() => archiveHeadingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            归档与上传方式
          </button>
          <button className="button button-ghost" onClick={onClose}>
            收起（草稿保留）
          </button>
        </div>
      </div>
      <p>
        提案保存在
        03-测试计划/reviews/revision-proposal-*.json。仅确认项应用到当前设计集；执行快照与结果保留，由执行页另行确认修订。
      </p>
      <p className="ai-review-help">
        本面板仅用于逐项处理 AI 修订建议；确认归档范围后，直接在对话中让 AI 生成 XMind 归档并上传，无需在这里创建正式版本。
      </p>
      <div className="header-actions">
        <select
          className="field-input"
          value={path}
          disabled={busy || disabled}
          onChange={(e) => void run(() => load(e.target.value))}
        >
          <option value="">选择修订提案</option>
          {files.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <button
          className="button button-ghost"
          disabled={busy}
          onClick={() => void run(loadFiles)}
        >
          刷新提案
        </button>
      </div>
      {conflictDraft && (
        <details>
          <summary>本地冲突草稿</summary>
          <pre>{JSON.stringify(conflictDraft.proposal, null, 2)}</pre>
          <button
            className="button button-ghost"
            disabled={busy || disabled}
            onClick={() => {
              setProposal(conflictDraft.proposal);
              setPartial(conflictDraft.partial || {});
              setPreview(null);
              setConflictDraft(null);
              sessionStorage.removeItem(`${draftKey}:conflict`);
              setMessage("已恢复本地草稿，请重新预览并处理冲突");
            }}
          >
            恢复本地草稿并重新预览
          </button>
        </details>
      )}
      {proposal && (
        <>
          <label className="field-label">
            批量处理理由
            <input
              className="field-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="header-actions">
            {statuses.slice(1).map(([status, label]) => (
              <button
                className="button button-ghost button-small"
                key={status}
                disabled={disabled || busy || !reason.trim()}
                onClick={() => {
                  setPreview(null);
                  setProposal(
                    (p) =>
                      p && {
                        ...p,
                        items: p.items.map((i) =>
                          selected.has(i.item_id) && !i.event_ids?.length
                            ? { ...i, status, handling_reason: reason }
                            : i,
                        ),
                      },
                  );
                }}
              >
                {label}选中项
              </button>
            ))}
          </div>
          {proposal.items.map((item) => (
            <details key={item.item_id} style={{ margin: "12px 0" }}>
              <summary>
                <input
                  type="checkbox"
                  checked={selected.has(item.item_id)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      e.target.checked
                        ? n.add(item.item_id)
                        : n.delete(item.item_id);
                      return n;
                    })
                  }
                />{" "}
                {item.item_id} · {item.target_case_id} ·{" "}
                {
                  { added: "新增", modified: "修改", deleted: "删除" }[
                    item.action
                  ]
                }{" "}
                ·{" "}
                {
                  {
                    user_request: "用户明确要求",
                    developer_suggestion: "开发建议",
                    ai_suggestion: "AI建议",
                  }[item.nature]
                }{" "}
                · {statuses.find((s) => s[0] === item.status)?.[1]}
              </summary>
              <p>{item.reason}</p>
              <p>{item.source_refs.join("；")}</p>
              <pre style={{ whiteSpace: "pre-wrap" }}>
                {JSON.stringify(
                  { before: item.before, after: item.after },
                  null,
                  2,
                )}
              </pre>
              <select
                className="field-input"
                disabled={disabled || busy || !!item.event_ids?.length}
                value={item.status}
                onChange={(e) =>
                  update(item.item_id, e.target.value as ReviewDecision)
                }
              >
                {statuses.map(([s, l]) => (
                  <option value={s} key={s}>
                    {l}
                  </option>
                ))}
              </select>
              <input
                className="field-input"
                placeholder="处理理由"
                disabled={disabled || busy || !!item.event_ids?.length}
                value={item.handling_reason || ""}
                onChange={(e) => {
                  setPreview(null);
                  setProposal(
                    (p) =>
                      p && {
                        ...p,
                        items: p.items.map((i) =>
                          i.item_id === item.item_id
                            ? { ...i, handling_reason: e.target.value }
                            : i,
                        ),
                      },
                  );
                }}
              />
              {item.status === "partial" && !item.event_ids?.length && (
                <PartialReviewEditor value={item.after || item.before!} draft={partial[item.item_id]} onChange={value => {setPreview(null);setPartial(p=>({...p,[item.item_id]:value}));}} />
              )}
              {!!item.event_ids?.length && (
                <p>已应用事件：{item.event_ids.join("、")}</p>
              )}
            </details>
          ))}
          <button
            className="button button-ghost"
            disabled={busy || disabled}
            onClick={() => void run(prepare)}
          >
            保存处理并预览差异
          </button>
          {preview && (
            <>
              <pre style={{ whiteSpace: "pre-wrap" }}>
                {JSON.stringify(
                  preview.preview.map((p: any) => ({
                    case_id: p.case_id,
                    conflict: p.conflict,
                    changed_fields: p.changed_fields,
                    before: p.before,
                    after: p.after,
                  })),
                  null,
                  2,
                )}
              </pre>
              <button
                className="button button-primary"
                disabled={
                  busy ||
                  disabled ||
                  preview.preview.some((p: any) => p.conflict)
                }
                onClick={() =>
                  void run(async () => {
                    const next = await applyReview(base, proposal);
                    await save(next);
                    setPreview(null);
                    setMessage("已应用确认项；其余结论已保存，执行结果未改动");
                  })
                }
              >
                确认应用采纳项
              </button>
            </>
          )}
        </>
      )}
      <hr />
      <h3 className="ai-review-finalization-heading" ref={archiveHeadingRef}>对话确认后归档与上传</h3>
      <p>
        不用在这里填写确认人、定稿说明、轮次 ID 或核对指纹。与 AI 对话确定本次用例范围后，直接说「确认归档为 XMind 并上传到指定云效用例库」；AI 会自动生成本地 XMind 归档和正式版本，再按已配置的云效连接预览并发布。目标用例库或范围不明确时，AI 会在对话中询问。
      </p>
      <p className="field-help">
        权限模式为「询问」时，仍需在会话中批准实际写入或上传；执行结果和原始用例不会被改写。
      </p>
      {message && (
        <div className="ai-session-notice" role="status">
          {message}
        </div>
      )}
    </section>
  );
}

function PartialReviewEditor({value,draft,onChange}:{value:StructuredTestCase;draft?:string;onChange:(value:string)=>void}) {
  let current=value;
  try {const parsed=draft ? JSON.parse(draft) : null;if(parsed && typeof parsed === "object")current=parsed;}catch{}
  if(!current) return <p>缺少可编辑用例，请重新生成提案。</p>;
  const update=(patch:Partial<StructuredTestCase>)=>onChange(JSON.stringify({...current,...patch}));
  const lines=(value:string)=>value.split("\n");
  return <div className="case-form-grid">
    <label className="field-label">采纳后的标题<input className="field-input" value={current.title} onChange={e=>update({title:e.target.value})}/></label>
    <label className="field-label">前置条件（每行一项）<textarea className="field-input" rows={3} value={current.preconditions.join("\n")} onChange={e=>update({preconditions:lines(e.target.value)})}/></label>
    <label className="field-label">操作步骤（每行一项）<textarea className="field-input" rows={4} value={caseActions(current).join("\n")} onChange={e=>{const actions=lines(e.target.value),expected=caseExpectedResults(current);update({steps:actions.map((action,index)=>({order:index+1,action,expected:index===actions.length-1 ? expected : []}))});}}/></label>
    <label className="field-label">整体期望（每行一项）<textarea className="field-input" rows={4} value={caseExpectedResults(current).join("\n")} onChange={e=>{const expected=lines(e.target.value);update({expected_results:expected,steps:current.steps.map((step,index)=>({...step,expected:index===current.steps.length-1 ? expected : []}))});}}/></label>
  </div>;
}
