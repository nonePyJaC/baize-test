import { useDraftSave } from "../lib/draftGuard";
import React, { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { api, joinPath } from "../lib/api";
import { useBusinessRefresh } from "../lib/businessEvents";
import { saveXmindRevision } from "../lib/xmindRevision";
import { systemOpen } from "../lib/systemOpen";
import AppIcon from "../components/AppIcon";
import type { PathInfo } from "../lib/types";
import type { RightContextReporter } from "../lib/workbench";
import { formatModified, formatSize } from "./MarkdownDocumentView";
import {
  HISTORY_ENTRY,
  TEST_TYPES,
  buildHistoryMarkdown,
  changedCaseFields,
  createId,
  diffRecordField,
  draftFromCase,
  formatDateTime,
  parseContent,
  readHistory,
  removeCaseTopic,
  samePath,
  snapshotFromCase,
  snapshotFromDraft,
  splitNumbered,
  stripCasePrefix,
  topicAtPath,
  updateTopic,
} from "../lib/xmindCases";
import type { CaseDraft, CaseSnapshot, ChangeRecord, ModuleNode, ParsedCase, XMindContent } from "../lib/xmindCases";

export default function XMindDocumentView({ path, readOnly = false, onDirtyChange, onRightContext }: { path: string; readOnly?: boolean; onDirtyChange?: (dirty: boolean) => void; onRightContext?: RightContextReporter }) {
  const [cases, setCases] = useState<ParsedCase[]>([]);
  const [modules, setModules] = useState<ModuleNode[]>([]);
  const [content, setContent] = useState<XMindContent | null>(null);
  const [history, setHistory] = useState<ChangeRecord[]>([]);
  const [rootTitle, setRootTitle] = useState("");
  const [selectedPath, setSelectedPath] = useState<string[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CaseDraft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editReason, setEditReason] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fileInfo, setFileInfo] = useState<PathInfo | null>(null);

  useBusinessRefresh([path], dirty || deleting || saving, () => { void load(); }, () => setMessage("磁盘已有新版本，当前草稿保留；保存时会核对该用例的差异"));
  useEffect(() => { onDirtyChange?.(dirty || (deleting && Boolean(deleteReason.trim()))); }, [dirty, deleting, deleteReason, onDirtyChange]);
  const markDirty = (value: boolean) => {
    setDirty(value);
    onDirtyChange?.(value);
  };

  const load = async () => {
    if (dirty && !window.confirm("当前用例有未保存修改，仍然重新载入XMind吗？")) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const bytes = await api.readBinaryFile(path);
      const zip = await JSZip.loadAsync(bytes);
      const contentFile = zip.file("content.json");
      if (!contentFile) throw new Error("文件中不存在content.json，可能是旧版XMind格式");
      const nextContent = JSON.parse(await contentFile.async("string")) as XMindContent;
      const parsed = parseContent(nextContent, path);
      const nextHistory = await readHistory(zip, path);
      setContent(nextContent);
      setCases(parsed.cases);
      setModules(parsed.modules);
      setHistory(nextHistory);
      setRootTitle(parsed.rootTitle);
      setSelectedPath([]);
      setSelectedCaseId(parsed.cases[0]?.id || null);
      setEditingCaseId(null);
      setDraft(null);
      markDirty(false);
    } catch (reason) {
      setError(`XMind解析失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [path]);

  const visibleCases = useMemo(() => cases.filter((item) => {
    const pathMatched = selectedPath.length === 0 || selectedPath.every((part, index) => item.path[index] === part);
    const keyword = search.trim().toLowerCase();
    const searchable = [item.title, ...item.path, ...item.preconditions, ...item.steps, ...item.expectedResults].join(" ").toLowerCase();
    return pathMatched && (!keyword || searchable.includes(keyword));
  }), [cases, selectedPath, search]);
  const selectedCase = visibleCases.find((item) => item.id === selectedCaseId) || visibleCases[0];
  const selectedHistory = selectedCase ? history.filter((record) => record.caseId === selectedCase.id).slice().reverse() : [];

  useEffect(() => {
    let cancelled = false;
    api.getPathInfo(path).then((info) => { if (!cancelled) setFileInfo(info); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [path, loading]);

  // BB-16D：上报用例目录大纲与文件/用例属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "cases",
      title: path.split(/[\\/]/).pop() || "XMind用例",
      subtitle: rootTitle || path,
      path,
      readOnly,
      outlineTitle: "用例目录",
      outline: [
        { id: "all", label: "全部用例", badge: String(cases.length), icon: "archiveFile", active: selectedPath.length === 0, onSelect: () => setSelectedPath([]) },
        ...modules.map((module) => ({ id: `m-${module.path.join("/")}`, label: module.title, depth: module.path.length - 1, badge: String(module.caseCount), icon: "folder", active: samePath(selectedPath, module.path), onSelect: () => setSelectedPath(module.path) })),
      ],
      properties: [
        { label: "文件名称", value: path.split(/[\\/]/).pop() || "" },
        { label: "文件类型", value: "XMind测试用例" },
        { label: "文件大小", value: fileInfo?.exists ? formatSize(fileInfo.size) : "—" },
        { label: "修改时间", value: fileInfo?.modified ? formatModified(fileInfo.modified) : "—" },
        ...(selectedCase ? [
          { label: "选中用例", value: stripCasePrefix(selectedCase.title) },
          { label: "用例ID", value: selectedCase.id, mono: true },
          { label: "优先级", value: selectedCase.priority.toUpperCase() },
          { label: "测试类型", value: selectedCase.testType },
        ] : []),
      ],
      stats: [
        { label: "用例数", value: String(cases.length) },
        { label: "目录数", value: String(modules.length) },
        { label: "修改记录", value: String(history.length) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, path, rootTitle, readOnly, cases, modules, selectedPath, selectedCase, fileInfo, history]);
  const isEditingSelected = Boolean(selectedCase && editingCaseId === selectedCase.id && draft);

  const selectCase = (id: string) => {
    if ((dirty || (deleting && deleteReason.trim())) && !window.confirm("当前用例有未保存修改，切换用例会丢失修改，是否继续？")) return;
    setSelectedCaseId(id);
    setEditingCaseId(null);
    setDraft(null);
    setDeleting(false);
    setDeleteReason("");
    markDirty(false);
  };

  const startEdit = () => {
    if (readOnly || !selectedCase) return;
    setDraft(draftFromCase(selectedCase));
    setEditingCaseId(selectedCase.id);
    setMessage(null);
    markDirty(false);
  };

  const cancelEdit = () => {
    if (dirty && !window.confirm("当前用例有未保存修改，确定放弃吗？")) return;
    setEditingCaseId(null);
    setDraft(null);
    setMessage(null);
    markDirty(false);
  };

  const startDelete = () => {
    if (readOnly || !selectedCase) return;
    setDeleting(true);
    setDeleteReason("");
    setMessage(null);
  };

  const cancelDelete = () => {
    setDeleting(false);
    setDeleteReason("");
  };

  const deleteCase = async () => {
    if (readOnly) {
      setMessage("需求目录已锁定，XMind为只读状态");
      return;
    }
    const reason = deleteReason.trim();
    if (!selectedCase || !content) return;
    if (!reason) {
      setMessage("请填写删除原因");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const bytes = await api.readBinaryFile(path);
      const zip = await JSZip.loadAsync(bytes);
      const latestContentFile = zip.file("content.json");
      if (!latestContentFile) throw new Error("XMind文件中不存在content.json");
      const latestContent = JSON.parse(await latestContentFile.async("string")) as XMindContent;
      const latest = parseContent(latestContent, path).cases.find((item) => item.id === selectedCase.id);
      if (!latest) throw new Error("找不到待删除的XMind用例，文件可能已被外部修改");
      const before = snapshotFromCase(latest);
      if (JSON.stringify(snapshotFromCase(selectedCase)) !== JSON.stringify(before)) throw new Error("该用例已在磁盘修改，草稿保留；请先核对外部差异");
      const removed = removeCaseTopic(latestContent, latest.sheetIndex, latest.topicPath);
      if (!removed) throw new Error("未能从XMind中移除该用例");
      const record: ChangeRecord = {
        id: createId(),
        origin: "human", source: "xmind_editor", actor: null,
        changedAt: new Date().toISOString(),
        filePath: path,
        caseId: selectedCase.id,
        before,
        after: null,
        changedFields: ["删除用例"],
        changeType: "deleted",
        reason,
        modulePath: latest.path,
      };
      const nextHistory = [...(await readHistory(zip, path)), record];
      zip.file("content.json", JSON.stringify(latestContent, null, 2));
      zip.file(HISTORY_ENTRY, JSON.stringify(nextHistory, null, 2));
      const output = await zip.generateAsync({ type: "uint8array" });
      await saveXmindRevision(path, bytes, output, record, nextHistory, buildHistoryMarkdown(path, nextHistory));
      const syncNote = "，关联的当前设计集与变更事件已同步保存";
      const historyWarning = "";
      const parsed = parseContent(latestContent, path);
      setContent(latestContent);
      setCases(parsed.cases);
      setModules(parsed.modules);
      setHistory(nextHistory);
      setSelectedCaseId(null);
      setEditingCaseId(null);
      setDraft(null);
      setDeleting(false);
      setDeleteReason("");
      markDirty(false);
      setMessage(`已删除用例「${before.title}」，删除原因已记录${syncNote}${historyWarning}`);
    } catch (deleteError) {
      setMessage(`删除失败：${String(deleteError)}`);
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = (update: Partial<CaseDraft>) => {
    if (readOnly) return;
    setDraft((current) => current ? { ...current, ...update } : current);
    markDirty(true);
  };

  useDraftSave(async () => deleting ? false : Boolean(await saveCase()));

  const saveCase = async () => {
    if (readOnly) {
      setMessage("需求目录已锁定，XMind为只读状态");
      return;
    }
    if (!selectedCase || !draft || !content) return;
    if (!editReason.trim()) { setMessage("请填写修改原因"); return; }
    const after = snapshotFromDraft(draft);
    setSaving(true);
    setMessage(null);
    try {
      const bytes = await api.readBinaryFile(path);
      const zip = await JSZip.loadAsync(bytes);
      const latestContentFile = zip.file("content.json");
      if (!latestContentFile) throw new Error("XMind文件中不存在content.json");
      const latestContent = JSON.parse(await latestContentFile.async("string")) as XMindContent;
      const latest = parseContent(latestContent, path).cases.find((item) => item.id === selectedCase.id);
      const topic = latest && topicAtPath(latestContent, latest.sheetIndex, latest.topicPath);
      if (!latest || !topic) throw new Error("找不到待修改的XMind用例主题，文件可能已被外部修改");
      const before = snapshotFromCase(latest);
      if (JSON.stringify(snapshotFromCase(selectedCase)) !== JSON.stringify(before)) throw new Error("该用例已在磁盘修改，草稿保留；请先核对外部差异");
      const changedFields = changedCaseFields(before, after);
      if (!changedFields.length) {
        setMessage("没有检测到字段变化");
        cancelEdit();
        return;
      }
      updateTopic(topic, draft);
      const record: ChangeRecord = {
        id: createId(),
        origin: "human", source: "xmind_editor", actor: null,
        changedAt: new Date().toISOString(),
        filePath: path,
        caseId: selectedCase.id,
        before,
        after,
        changedFields,
        reason: editReason.trim(),
        changeType: "modified",
      };
      const latestHistory = await readHistory(zip, path);
      const nextHistory = [...latestHistory, record];
      zip.file("content.json", JSON.stringify(latestContent, null, 2));
      zip.file(HISTORY_ENTRY, JSON.stringify(nextHistory, null, 2));
      const output = await zip.generateAsync({ type: "uint8array" });
      await saveXmindRevision(path, bytes, output, record, nextHistory, buildHistoryMarkdown(path, nextHistory));
      const historyWarning = "";
      setEditReason("");
      const parsed = parseContent(latestContent, path);
      setContent(latestContent);
      setCases(parsed.cases);
      setModules(parsed.modules);
      setHistory(nextHistory);
      setSelectedCaseId(selectedCase.id);
      setEditingCaseId(null);
      setDraft(null);
      markDirty(false);
      setMessage(`已保存到XMind，并记录${changedFields.length}项修改${historyWarning}`);
      return true;
    } catch (reason) {
      setMessage(`保存失败：${String(reason)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="document-workspace xmind-workspace">
      <div className="document-toolbar">
        <div className="document-toolbar-title"><AppIcon name="archiveFile" size={16} /><div><strong>{path.split(/[\\/]/).pop()}</strong><small>{rootTitle || "XMind测试用例"}</small></div><span className={`document-readonly ${readOnly ? "locked" : dirty ? "dirty" : ""}`}>{readOnly ? "锁定只读" : dirty ? "有未保存修改" : isEditingSelected ? "编辑用例" : "用例阅读"}</span></div>
        <div className="document-toolbar-actions">
          <div className="document-search"><AppIcon name="search" size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用例" />{search && <span>{visibleCases.length} 条</span>}</div>
          {selectedCase && !isEditingSelected && !deleting && <button className="button button-ghost button-small" disabled={readOnly} onClick={startEdit}><AppIcon name="edit" size={14} /> {readOnly ? "只读" : "编辑用例"}</button>}
          {selectedCase && !isEditingSelected && !deleting && <button className="button button-ghost button-small button-danger" disabled={readOnly} onClick={startDelete}><AppIcon name="minus" size={14} /> 删除用例</button>}
          {isEditingSelected && <><input className="field-input" aria-label="修改原因" placeholder="修改原因（必填）" value={editReason} onChange={(event) => setEditReason(event.target.value)} /><button className="button button-primary button-small" disabled={readOnly || saving} onClick={() => void saveCase()}><AppIcon name="save" size={14} /> {saving ? "保存中…" : "保存到XMind"}</button><button className="button button-ghost button-small" disabled={saving} onClick={cancelEdit}>取消</button></>}
          <button className="icon-button" onClick={() => void load()} title="重新解析"><AppIcon name="refresh" size={15} /></button>
          <button className="icon-button" onClick={() => void systemOpen.reveal(path)} title="在目录中显示"><AppIcon name="folderOpen" size={15} /></button>
          <button className="button button-ghost button-small" onClick={() => void systemOpen.openFile(path)}><AppIcon name="external" size={14} /> XMind打开</button>
        </div>
      </div>
      <div className="document-path" title={path}>{path}<span>{cases.length} 条测试用例 · {modules.length} 个目录{message ? ` · ${message}` : ""}</span></div>
      {loading ? <div className="center-state"><span className="spinner" />正在解析XMind主题树…</div> : error ? <div className="center-state"><AppIcon name="alert" size={24} /><strong>{error}</strong><span>当前内置阅读器支持包含content.json的XMind Zen格式，其他格式可使用XMind客户端打开。</span></div> : <div className="xmind-body"><aside className="xmind-modules"><div className="outline-title">用例目录</div><button className={`module-row ${selectedPath.length === 0 ? "active" : ""}`} onClick={() => setSelectedPath([])}><AppIcon name="archiveFile" size={14} /><span>全部用例</span><b>{cases.length}</b></button>{modules.map((module) => <button key={module.path.join("/")} className={`module-row level-${Math.min(module.path.length, 4)} ${samePath(selectedPath, module.path) ? "active" : ""}`} onClick={() => setSelectedPath(module.path)}><AppIcon name="folder" size={14} /><span title={module.path.join(" / ")}>{module.title}</span><b>{module.caseCount}</b></button>)}</aside><section className="xmind-case-list"><div className="case-list-heading"><span>测试用例</span><strong>{visibleCases.length}</strong></div>{visibleCases.length ? visibleCases.map((item) => <button key={item.id} className={`case-list-row ${selectedCase?.id === item.id ? "active" : ""}`} onClick={() => selectCase(item.id)}><span className={`priority-label ${item.priority.toLowerCase()}`}>{item.priority.toUpperCase()}</span><span><strong>{stripCasePrefix(item.title)}</strong><small>{item.path.join(" / ") || "未分类"}</small></span><span className="case-type">{item.testType}</span></button>) : <div className="panel-placeholder"><AppIcon name="inbox" size={20} /><span>没有匹配的测试用例</span></div>}</section><section className="xmind-case-detail">{selectedCase ? (deleting ? <DeleteCasePanel item={selectedCase} reason={deleteReason} saving={saving} onReasonChange={setDeleteReason} onCancel={cancelDelete} onConfirm={() => void deleteCase()} /> : <CaseDetail item={selectedCase} history={selectedHistory} editing={Boolean(isEditingSelected)} draft={draft} readOnly={readOnly} onDraftChange={updateDraft} />) : <div className="center-state"><AppIcon name="checks" size={24} /><strong>选择用例查看详情</strong></div>}</section></div>}
    </div>
  );
}

function CaseDetail({ item, history, editing, draft, readOnly, onDraftChange }: { item: ParsedCase; history: ChangeRecord[]; editing: boolean; draft: CaseDraft | null; readOnly: boolean; onDraftChange: (update: Partial<CaseDraft>) => void }) {
  if (editing && draft) return <CaseEditor draft={draft} onChange={onDraftChange} />;
  return <div className="case-detail-content"><div className="case-detail-header"><div><span className={`priority-label ${item.priority}`}>{item.priority.toUpperCase()}</span><span className="status-pill">{item.testType}</span></div><h2>{stripCasePrefix(item.title)}</h2><p>{item.path.join(" / ")}</p></div><CaseListSection title="前置条件" items={item.preconditions} empty="无明确前置条件" /><CaseListSection title="操作步骤" items={item.steps} empty="未解析到操作步骤" numbered /><CaseListSection title="期望结果" items={item.expectedResults} empty="未解析到期望结果" tone="expected" numbered /><ChangeHistory records={history} /></div>;
}

function CaseEditor({ draft, onChange }: { draft: CaseDraft; onChange: (update: Partial<CaseDraft>) => void }) {
  return <div className="case-detail-content case-edit-content"><div className="case-edit-heading"><div><span className="eyebrow">编辑当前测试用例</span><h2>修改后保存将回写原XMind文件</h2></div><span className="document-readonly dirty">草稿</span></div><label className="field-label">用例标题<input className="field-input" value={draft.title} onChange={(event) => onChange({ title: event.target.value })} /></label><div className="case-edit-meta"><label className="field-label">优先级<select className="select-control" value={draft.priority} onChange={(event) => onChange({ priority: event.target.value })}><option value="p0">P0</option><option value="p1">P1</option><option value="p2">P2</option></select></label><label className="field-label">测试类型<select className="select-control" value={draft.testType} onChange={(event) => onChange({ testType: event.target.value })}>{TEST_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label></div><label className="field-label">前置条件<span className="field-help">每行一条，保存后写入 pc: 主题</span><textarea className="field-input field-textarea xmind-edit-textarea" value={draft.preconditions.join("\n")} onChange={(event) => onChange({ preconditions: splitNumbered(event.target.value) })} /></label><label className="field-label">操作步骤<span className="field-help">每行一条，保存后写入 tx: 主题</span><textarea className="field-input field-textarea xmind-edit-textarea" value={draft.steps.join("\n")} onChange={(event) => onChange({ steps: splitNumbered(event.target.value) })} /></label><label className="field-label">期望结果<span className="field-help">每行一条，保存后写入 返回数据: 主题</span><textarea className="field-input field-textarea xmind-edit-textarea" value={draft.expectedResults.join("\n")} onChange={(event) => onChange({ expectedResults: splitNumbered(event.target.value) })} /></label><div className="case-edit-hint"><AppIcon name="info" size={14} />保存会同时更新XMind、内置blackbox/changes.json和旁路修改记录文件。</div></div>;
}

function DeleteCasePanel({ item, reason, saving, onReasonChange, onCancel, onConfirm }: { item: ParsedCase; reason: string; saving: boolean; onReasonChange: (value: string) => void; onCancel: () => void; onConfirm: () => void }) {
  return <div className="case-detail-content"><div className="case-edit-heading"><div><span className="eyebrow">删除当前测试用例</span><h2>{stripCasePrefix(item.title)}</h2><p>{item.path.join(" / ")}</p></div><span className="status-pill danger">删除</span></div><div className="unlock-warning"><AppIcon name="alert" size={14} /><span>删除后将从 XMind 中移除该用例；删除操作与原因会写入修改记录（.changes.json/.changes.md），供评审比对和后续生成 cases.json 参考。</span></div><label className="field-label">删除原因<span className="field-help">必填，例如：需求已取消该场景、与其他用例重复、超出本次测试范围</span><textarea className="field-input field-textarea xmind-edit-textarea" value={reason} onChange={(event) => onReasonChange(event.target.value)} placeholder="填写删除这条用例的原因" /></label><div className="case-edit-actions"><button className="button button-primary" disabled={saving || !reason.trim()} onClick={onConfirm}><AppIcon name="minus" size={14} /> 确认删除</button><button className="button button-ghost button-small" disabled={saving} onClick={onCancel}>取消</button></div></div>;
}

function CaseListSection({ title, items, empty, numbered = false, tone = "" }: { title: string; items: string[]; empty: string; numbered?: boolean; tone?: string }) {
  return <div className={`case-section ${tone ? `case-section-${tone}` : ""}`}><h3>{title}</h3>{items.length ? <ol className={numbered ? "case-numbered-list" : ""}>{items.map((text, index) => <li key={`${index}-${text}`}>{text}</li>)}</ol> : <span className="case-empty">{empty}</span>}</div>;
}

function ChangeHistory({ records }: { records: ChangeRecord[] }) {
  if (!records.length) return null;
  return <div className="case-section case-history"><h3><AppIcon name="history" size={14} /> 修改记录 <span>{records.length}</span></h3>{records.slice(0, 5).map((record) => <div className="case-history-row" key={record.id}><div><strong>{formatDateTime(record.changedAt)}</strong><span>{record.changedFields.join("、")}</span></div>{record.before && record.after ? record.changedFields.map((field) => <p className="case-history-field" key={field}><em>{field}</em>{diffRecordField(record, field).map((line, index) => <span key={index} className={`case-history-line ${line.kind}`}>{line.kind === "removed" ? "−" : "+"} {line.text}</span>)}</p>) : <small>{record.before ? "删除用例" : "新增用例"}：{(record.after ?? record.before)?.title}{record.reason ? ` · 原因：${record.reason}` : ""}</small>}</div>)}</div>;
}





