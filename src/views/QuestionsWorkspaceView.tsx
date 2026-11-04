import { useDraftSave } from "../lib/draftGuard";
import { useBusinessRefresh, invalidateBusinessData } from "../lib/businessEvents";
import React, { useEffect, useMemo, useState, useRef } from "react";
import DOMPurify from "dompurify";
import { api, joinPath } from "../lib/api";
import RichTextEditor from "../components/RichTextEditor";
import AppIcon from "../components/AppIcon";
import { formatActivityTime } from "../lib/date";
import { resolveAnswerImages } from "../lib/answerImages";
import type { PlatformInfo, Question, QuestionsData } from "../lib/types";

const STATUS_LABELS: Record<Question["status"], string> = { pending: "待回答", partial: "部分回答", answered: "已回答", no_need: "无需回答", void: "已作废" };

export default function QuestionsWorkspaceView({ rootPath, platform, requirementId, readOnly = false, onRightContext, onDirtyChange }: { rootPath: string; platform: PlatformInfo; requirementId: string; readOnly?: boolean; onDirtyChange?: (dirty: boolean) => void; onRightContext?: import("../lib/workbench").RightContextReporter }) {
  const questionsPath = joinPath(rootPath, platform.path, requirementId, "02-需求理解与答疑", "questions.json");
  const answerDir = questionsPath.replace(/[\\/]questions\.json$/, "");
  const baseData = useRef<QuestionsData | null>(null);
  const [data, setData] = useState<QuestionsData>({ version: "1.0", requirement_id: requirementId, questions: [] });
  const [dirty, setDirty] = useState(false);
  const [dataRevision, setDataRevision] = useState(0);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useBusinessRefresh([questionsPath], dirty, () => setDataRevision((v) => v + 1), () => setSaveState("磁盘有新版本，当前答复草稿保留，请合并后保存"));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Question["status"]>("all");
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("未修改");

  useEffect(() => {
    setLoading(true);
    api.readJsonFile(questionsPath).then((value) => {
      const next = value as QuestionsData;
      if (next && Array.isArray(next.questions)) { baseData.current = next; setData(next); }
    }).catch(() => undefined).finally(() => setLoading(false));
  }, [questionsPath, dataRevision]);

  const visibleQuestions = useMemo(() => filter === "all" ? data.questions : data.questions.filter((item) => item.status === filter), [data.questions, filter]);
  const selected = data.questions.find((item) => item.id === selectedId) || visibleQuestions[0];

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const updateQuestion = (id: string, update: Partial<Question>) => { setDirty(true); setData((current) => ({ ...current, questions: current.questions.map((item) => item.id === id ? { ...item, ...update } : item) })); };
  const save = async () => {
    if (readOnly) {
      setSaveState("需求目录已锁定，只读");
      return;
    }
    setSaveState("保存中…");
    try {
      await api.saveJsonFileIfUnchanged(questionsPath, baseData.current, data);
      baseData.current = data;
      setDirty(false); invalidateBusinessData([questionsPath]);
      setSaveState(`已保存 ${formatActivityTime(new Date())}`);
      return true;
    } catch (reason) {
      setSaveState(`保存失败：${String(reason)}`);
      return false;
    }
  };
  useDraftSave(async () => Boolean(await save()));

  const saveAttachment = async (file: File): Promise<string | null> => {
    if (readOnly) {
      setSaveState("需求目录已锁定，只读");
      return null;
    }
    const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const filename = `screenshot-${Date.now()}.${extension}`;
    const relativePath = `attachments/${filename}`;
    try {
      await api.writeBinaryFile(joinPath(workspaceAttachmentPath(questionsPath), filename), new Uint8Array(await file.arrayBuffer()));
      return relativePath;
    } catch (reason) {
      setSaveState(`附件保存失败：${String(reason)}`);
      return null;
    }
  };

  const confirmAnswer = (html: string) => {
    if (readOnly || !selected) return;
    const next: QuestionsData = {
      ...data,
      questions: data.questions.map((item) => item.id === selected.id
        ? { ...item, answer: html, answer_format: "richtext_json", status: "answered", answered_at: new Date().toISOString(), version: item.version + 1 }
        : item),
    };
    setData(next);
    setDirty(true);
    setSaveState("保存中…");
    void api.saveJsonFileIfUnchanged(questionsPath, baseData.current, next).then(() => { baseData.current = next; setDirty(false); invalidateBusinessData([questionsPath]); setSaveState(`已保存 ${formatActivityTime(new Date())}`); }).catch((reason) => setSaveState(`保存失败：${String(reason)}`));
  };

  const stats = { all: data.questions.length, pending: data.questions.filter((item) => item.status === "pending").length, answered: data.questions.filter((item) => item.status === "answered").length, partial: data.questions.filter((item) => item.status === "partial").length };

  // BB-16D：上报疑问列表大纲与当前疑问属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "requirement",
      objectId: requirementId,
      title: "疑问与答复",
      subtitle: `${platform.name} · ${requirementId}`,
      path: questionsPath,
      platformId: platform.id,
      requirementId,
      readOnly,
      outlineTitle: "疑问清单",
      outline: visibleQuestions.slice(0, 40).map((question) => ({
        id: question.id,
        label: question.question,
        badge: STATUS_LABELS[question.status],
        icon: "help",
        active: question.id === selected?.id,
        onSelect: () => setSelectedId(question.id),
      })),
      properties: selected ? [
        { label: "疑问ID", value: selected.id, mono: true },
        { label: "状态", value: STATUS_LABELS[selected.status] },
        { label: "优先级", value: selected.priority },
        { label: "分类", value: selected.category || "未分类" },
        { label: "负责人", value: selected.owner || "未指派" },
      ] : [{ label: "状态", value: "未选择疑问" }],
      stats: [
        { label: "全部", value: String(stats.all) },
        { label: "待回答", value: String(stats.pending) },
        { label: "已回答", value: String(stats.answered) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, data.questions, visibleQuestions, selected, requirementId, platform, questionsPath, readOnly, stats.all, stats.pending, stats.answered]);

  return (
    <div className="questions-workspace">
      <div className="document-toolbar"><div className="document-toolbar-title"><span className="document-icon amber"><AppIcon name="help" size={16} /></span><div><strong>疑问与答复</strong><small>{platform.name} · {requirementId}</small></div><span className={`document-readonly ${readOnly ? "locked" : ""}`}>{readOnly ? "锁定只读" : "可编辑"}</span></div><div className="document-toolbar-actions"><span className="save-state">{saveState}</span><button className="button button-primary button-small" disabled={readOnly} onClick={() => void save()}><AppIcon name="check" size={14} /> {readOnly ? "只读" : "保存草稿"}</button></div></div>
      <div className="questions-summary"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部 <b>{stats.all}</b></button><button className={filter === "pending" ? "selected danger" : ""} onClick={() => setFilter("pending")}>待回答 <b>{stats.pending}</b></button><button className={filter === "partial" ? "selected warning" : ""} onClick={() => setFilter("partial")}>部分回答 <b>{stats.partial}</b></button><button className={filter === "answered" ? "selected success" : ""} onClick={() => setFilter("answered")}>已回答 <b>{stats.answered}</b></button></div>
      <div className="questions-body">
        <aside className="question-list-panel"><div className="panel-search"><AppIcon name="search" size={14} /><input value={filter === "all" ? "" : filter} onChange={() => undefined} placeholder="筛选疑问" readOnly /></div>{loading ? <div className="panel-placeholder"><span className="spinner" />加载中…</div> : visibleQuestions.length ? visibleQuestions.map((question) => <button key={question.id} className={`question-list-row ${selected?.id === question.id ? "active" : ""}`} onClick={() => setSelectedId(question.id)}><span className={`priority-label ${question.priority.toLowerCase()}`}>{question.priority}</span><span className="question-list-text"><strong>{question.question}</strong><small>{question.category || "未分类"}</small></span><AppIcon name="next" size={14} /></button>) : <div className="panel-placeholder"><AppIcon name="inbox" size={20} /><span>{data.questions.length ? "当前筛选无结果" : "暂无疑问"}</span><small>AI提取的疑问会保存到需求目录</small></div>}</aside>
        <section className="question-editor-panel">{selected ? <QuestionEditor key={`${selected.id}:${dataRevision}`} question={selected} answerDir={answerDir} readOnly={readOnly} onUpdate={(update) => updateQuestion(selected.id, update)} onSave={confirmAnswer} onImagePaste={saveAttachment} /> : <div className="center-state"><AppIcon name="help" size={24} /><strong>选择一个疑问开始回答</strong><span>回答内容使用富文本编辑，支持截图粘贴。</span></div>}</section>
      </div>
      <div className="document-footer"><span className="mono" title={questionsPath}>{questionsPath}</span><span>{data.questions.length} 个疑问</span></div>
    </div>
  );
}

function QuestionEditor({ question, answerDir, readOnly, onUpdate, onSave, onImagePaste }: { question: Question; answerDir: string; readOnly: boolean; onUpdate: (update: Partial<Question>) => void; onSave: (html: string) => void; onImagePaste: (file: File) => Promise<string | null> }) {
  const [storedAnswer] = useState(question.answer || "");
  const [initialHtml, setInitialHtml] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void resolveAnswerImages(storedAnswer, answerDir).then((html) => { if (active) setInitialHtml(html); });
    return () => { active = false; };
  }, [storedAnswer, answerDir]);
  return <div className="question-editor"><div className="question-editor-header"><div><div className="question-identifiers"><span className={`priority-label ${question.priority.toLowerCase()}`}>{question.priority}</span><span className={`status-pill ${question.status === "answered" ? "success" : question.status === "partial" ? "warning" : "danger"}`}>{STATUS_LABELS[question.status]}</span>{question.category && <span className="muted-label">{question.category}</span>}</div><h2>{question.question}</h2></div><select className="select-control" value={question.status} disabled={readOnly} onChange={(event) => onUpdate({ status: event.target.value as Question["status"] })}>{Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><div className="question-context-grid"><ContextItem label="来源" value={question.source || "待补充"} /><ContextItem label="负责人" value={question.owner || "未指派"} /><ContextItem label="影响范围" value={question.impact.length ? question.impact.join("、") : "待分析"} /><ContextItem label="最后回答" value={formatActivityTime(question.answered_at)} /></div><div className="answer-label"><AppIcon name="file" size={15} /> 回答内容</div>{initialHtml === null ? <div className="panel-placeholder"><span className="spinner" />加载回答…</div> : <RichTextEditor key={question.id} initialContent={initialHtml} disabled={readOnly} placeholder="请输入回答，支持表格、引用、代码块和截图粘贴…" onChange={(html) => onUpdate({ answer: html, answer_format: "richtext_json" })} onSave={onSave} onImagePaste={onImagePaste} />}<div className="answer-hint"><AppIcon name="security" size={14} /> {readOnly ? "需求目录已锁定，回答内容只读" : "回答会保存到需求目录的questions.json，不依赖客户端缓存"}</div>{question.answer && question.answer_format === "richtext_json" && <AnswerPreview html={question.answer} answerDir={answerDir} />}</div>;
}

function AnswerPreview({ html, answerDir }: { html: string; answerDir: string }) {
  const [resolved, setResolved] = useState<string | null>(() => (html.includes("attachments/") ? null : html));
  useEffect(() => {
    let active = true;
    void resolveAnswerImages(html, answerDir).then((next) => { if (active) setResolved(next); });
    return () => { active = false; };
  }, [html, answerDir]);
  return <div className="answer-preview"><span>当前回答预览</span><div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(resolved ?? "") }} /></div>;
}

function ContextItem({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function workspaceAttachmentPath(questionFilePath: string): string { return questionFilePath.replace(/[\\/]questions\.json$/, "") + "/attachments"; }
