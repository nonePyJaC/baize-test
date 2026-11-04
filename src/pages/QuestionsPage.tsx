import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, joinPath } from "../lib/api";
import { useWorkspace } from "../App";
import RichTextEditor from "../components/RichTextEditor";
import MarkdownViewer from "../components/MarkdownViewer";
import type { Question, QuestionsData } from "../lib/types";

const PRIORITY_LABELS: Record<string, string> = { P0: "P0", P1: "P1", P2: "P2" };
const STATUS_LABELS: Record<string, string> = {
  pending: "待回答", partial: "部分回答", answered: "已回答", no_need: "无需回答", void: "已作废",
};

export default function QuestionsPage() {
  const { platformId, reqId } = useParams();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<QuestionsData | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  const platform = workspace.platforms.find((p) => p.id === platformId);
  const questionsPath = joinPath(workspace.workspace.root_path, platform?.path || "", reqId || "", "02-需求理解与答疑", "questions.json");

  useEffect(() => {
    if (!platform) return;
    setLoading(true);
    api.readJsonFile(questionsPath).then((data: QuestionsData) => {
      setQuestions(data);
      setLoading(false);
    }).catch(() => {
      // 文件不存在，初始化空结构
      setQuestions({
        version: "1.0",
        requirement_id: reqId || "",
        questions: [],
      });
      setLoading(false);
    });
  }, [platform, reqId, questionsPath]);

  useEffect(() => {
    if (!platform) return;
    api.readRequirement(workspace.workspace.root_path, platform.path, reqId || "")
      .then((requirement) => setReadOnly(requirement.client_access.mode === "locked_for_ai"))
      .catch(() => setReadOnly(false));
  }, [platform, reqId, workspace.workspace.root_path]);

  if (!platform || loading) {
    return <div className="empty-state"><div className="icon">⏳</div>加载中…</div>;
  }

  const save = (data: QuestionsData) => {
    if (readOnly) {
      alert("需求目录已锁定，疑问内容为只读");
      return;
    }
    api.saveJsonFile(questionsPath, data).then(() => {
      setQuestions(data);
    }).catch((e) => alert("保存失败: " + e));
  };

  const handleAnswer = (qId: string, html: string) => {
    if (!questions) return;
    const updated = {
      ...questions,
      questions: questions.questions.map((q) =>
        q.id === qId
          ? {
              ...q,
              answer: html,
              answer_format: "richtext_json" as const,
              status: "answered" as const,
              answered_at: new Date().toISOString(),
              version: q.version + 1,
            }
          : q
      ),
    };
    save(updated);
    setEditingId(null);
  };

  const handleStatusChange = (qId: string, status: Question["status"]) => {
    if (!questions) return;
    save({
      ...questions,
      questions: questions.questions.map((q) =>
        q.id === qId ? { ...q, status } : q
      ),
    });
  };

  const stats = {
    total: questions?.questions.length || 0,
    pending: questions?.questions.filter((q) => q.status === "pending").length || 0,
    answered: questions?.questions.filter((q) => q.status === "answered").length || 0,
    partial: questions?.questions.filter((q) => q.status === "partial").length || 0,
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/requirement/${platformId}/${reqId}`)}>
          ← 返回
        </button>
        <h2 style={{ margin: 0 }}>疑问管理 - {reqId}</h2>
      </div>

      {/* 统计 */}
      <div className="card">
        <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
          <span>共 <strong>{stats.total}</strong> 个疑问</span>
          <span className="badge badge-danger">待回答 {stats.pending}</span>
          <span className="badge badge-warning">部分回答 {stats.partial}</span>
          <span className="badge badge-success">已回答 {stats.answered}</span>
        </div>
      </div>

      {/* 疑问列表 */}
      {questions?.questions.length === 0 ? (
        <div className="empty-state">
          <div className="icon">❓</div>
          <p>暂无疑问</p>
          <p style={{ fontSize: 12, marginTop: 8, color: "var(--text-muted)" }}>
            疑问由AI在需求理解阶段提取，保存在 {questionsPath}
          </p>
        </div>
      ) : (
        questions?.questions.map((q) => (
          <QuestionItem
            key={q.id}
            question={q}
            isEditing={editingId === q.id}
            onEdit={() => setEditingId(q.id)}
            onCancelEdit={() => setEditingId(null)}
            readOnly={readOnly}
            onSaveAnswer={(html) => handleAnswer(q.id, html)}
            onStatusChange={(s) => handleStatusChange(q.id, s)}
          />
        ))
      )}
    </div>
  );
}

function QuestionItem({
  question: q,
  isEditing,
  readOnly,
  onEdit,
  onCancelEdit,
  onSaveAnswer,
  onStatusChange,
}: {
  question: Question;
  isEditing: boolean;
  readOnly: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveAnswer: (html: string) => void;
  onStatusChange: (s: Question["status"]) => void;
}) {
  return (
    <div className="question-item">
      <div className="q-header">
        <span className={`q-priority q-priority-${q.priority.toLowerCase()}`}>
          {PRIORITY_LABELS[q.priority]}
        </span>
        <span className={`q-status q-status-${q.status}`}>{STATUS_LABELS[q.status]}</span>
        {q.category && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{q.category}</span>}
        <div style={{ flex: 1 }} />
        <select
          className="form-select"
          style={{ width: "auto", fontSize: 12 }}
          value={q.status}
          disabled={readOnly}
          onChange={(e) => onStatusChange(e.target.value as Question["status"])}
        >
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      <div className="q-text">{q.question}</div>

      {q.impact.length > 0 && (
        <div style={{ marginBottom: 8, fontSize: 12, color: "var(--text-muted)" }}>
          影响: {q.impact.join(", ")}
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          回答:
        </div>
        {isEditing ? (
          <RichTextEditor
            initialContent={q.answer || ""}
            disabled={readOnly}
            placeholder="请输入回答…支持富文本和截图粘贴"
            onSave={onSaveAnswer}
            onChange={() => {}}
          />
        ) : q.answer ? (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              {q.answer_format === "markdown" ? (
                <MarkdownViewer content={q.answer} />
              ) : (
                <div dangerouslySetInnerHTML={{ __html: q.answer }} />
              )}
            </div>
            {!readOnly && <button className="btn btn-sm btn-secondary" onClick={onEdit}>编辑</button>}
          </div>
        ) : (
          readOnly ? null : <button className="btn btn-sm btn-primary" onClick={onEdit}>添加回答</button>
        )}
      </div>

      {q.attachments.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <span style={{ color: "var(--text-muted)" }}>附件:</span>
          {q.attachments.map((a, i) => (
            <span key={i} className="badge badge-info" style={{ marginLeft: 4 }}>
              {a.type}: {a.path}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
