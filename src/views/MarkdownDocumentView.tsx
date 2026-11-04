import { useDraftSave } from "../lib/draftGuard";
import { useBusinessRefresh, invalidateBusinessData } from "../lib/businessEvents";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import MarkdownViewer from "../components/MarkdownViewer";
import AppIcon from "../components/AppIcon";
import type { PathInfo } from "../lib/types";
import type { RightContextReporter } from "../lib/workbench";
import { continueMarkdownList, indentMarkdownText, renumberAfterChange, type MarkdownEdit } from "../lib/markdownEdit";

type ViewMode = "preview" | "edit" | "split";

export default function MarkdownDocumentView({ path, readOnly = false, initialMode, onDirtyChange, onRightContext }: { path?: string; readOnly?: boolean; initialMode?: ViewMode; onDirtyChange?: (dirty: boolean) => void; onRightContext?: RightContextReporter }) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [showOutline, setShowOutline] = useState(true);
  const [mode, setMode] = useState<ViewMode>(initialMode === "edit" || initialMode === "split" ? initialMode : "preview");
  const [message, setMessage] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<PathInfo | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const applyEditorEdit = (editor: HTMLTextAreaElement, edit: MarkdownEdit | null) => {
    if (!edit) return;
    editor.focus();
    editor.setSelectionRange(edit.from, edit.to);
    const applied = edit.replacement ? document.execCommand("insertText", false, edit.replacement) : document.execCommand("delete");
    if (applied) {
      editor.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    } else {
      setContent(`${editor.value.slice(0, edit.from)}${edit.replacement}${editor.value.slice(edit.to)}`);
      requestAnimationFrame(() => editor.setSelectionRange(edit.selectionStart, edit.selectionEnd));
    }
  };
  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    const editor = event.currentTarget;
    if (event.key === "Tab") {
      event.preventDefault();
      applyEditorEdit(editor, indentMarkdownText(editor.value, editor.selectionStart, editor.selectionEnd, event.shiftKey));
    } else if (event.key === "Enter" && !event.shiftKey) {
      const edit = continueMarkdownList(editor.value, editor.selectionStart, editor.selectionEnd);
      if (!edit) return;
      event.preventDefault();
      applyEditorEdit(editor, edit);
    }
  };
  const handleEditorChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const editor = event.currentTarget;
    const previous = content;
    setContent(editor.value);
    if ((event.nativeEvent as InputEvent).inputType?.startsWith("history")) return;
    requestAnimationFrame(() => applyEditorEdit(editor, renumberAfterChange(previous, editor.value, editor.selectionStart)));
  };
  const actualPath = path || "";
  const dirty = content !== savedContent;

  const load = () => {
    if (!actualPath) {
      setLoading(false);
      return;
    }
    if (dirty && !window.confirm("当前文档有未保存修改，仍然重新载入磁盘内容吗？")) return;
    setLoading(true);
    api.readTextFile(actualPath).then((value) => {
      setContent(value);
      setSavedContent(value);
      setMessage(null);
    }).catch((reason) => setMessage(`文件读取失败：${String(reason)}`)).finally(() => setLoading(false));
  };

  const save = async () => {
    if (readOnly) {
      setMessage("需求目录已锁定，当前文档为只读状态");
      return;
    }
    setSaving(true);
    try {
      if (await api.readTextFile(actualPath) !== savedContent) throw new Error("磁盘内容已变化，请先合并；草稿保留");
      await api.writeTextFile(actualPath, content);
      invalidateBusinessData([actualPath]);
      setSavedContent(content);
      setMessage("已保存到磁盘");
      return true;
    } catch (reason) {
      setMessage(`保存失败：${String(reason)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  useDraftSave(async () => Boolean(await save()));
  useBusinessRefresh([actualPath], dirty || saving, load, () => setMessage("磁盘有新版本，当前草稿保留，请合并后保存"));
  useEffect(() => { load(); }, [actualPath]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!actualPath) return;
    let cancelled = false;
    api.getPathInfo(actualPath).then((info) => { if (!cancelled) setFileInfo(info); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [actualPath, savedContent]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        // 所有打开的Tab保持挂载：隐藏的Tab不该响应Ctrl+S（offsetParent为null即不可见）
        const element = contentRef.current ?? editorRef.current;
        if (element && element.offsetParent === null) return;
        event.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [content, dirty, readOnly]);

  const headings = useMemo(() => content.split("\n").map((line, index) => {
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    return match ? { level: match[1].length, text: match[2].replace(/[`*_]/g, ""), index } : null;
  }).filter(Boolean) as { level: number; text: string; index: number }[], [content]);
  const hits = search.trim() ? (content.toLowerCase().match(new RegExp(escapeRegExp(search.trim().toLowerCase()), "g")) || []).length : 0;

  const jumpToHeading = (index: number) => {
    const target = contentRef.current?.querySelectorAll("h1, h2, h3")[headings.findIndex((heading) => heading.index === index)] as HTMLElement | undefined;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // 编辑模式没有预览标题元素：定位到源码对应行
    const editor = editorRef.current || document.querySelector<HTMLTextAreaElement>(".markdown-source-editor");
    if (editor) {
      const offset = content.split("\n").slice(0, index).join("\n").length;
      editor.focus();
      editor.setSelectionRange(offset, offset);
      const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight) || 20;
      editor.scrollTop = Math.max(0, index * lineHeight - editor.clientHeight / 3);
    }
  };

  // BB-16D：向右侧上下文上报真实标题大纲与文件属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "markdown",
      title: actualPath.split(/[\\/]/).pop() || "Markdown文档",
      subtitle: actualPath,
      path: actualPath,
      readOnly,
      outlineTitle: "文档标题",
      outline: headings.map((heading) => ({
        id: `h-${heading.index}`,
        label: heading.text,
        depth: heading.level - 1,
        icon: "markdown",
        onSelect: () => jumpToHeading(heading.index),
      })),
      properties: [
        { label: "文件名称", value: actualPath.split(/[\\/]/).pop() || "" },
        { label: "文件类型", value: "Markdown/文本" },
        { label: "文件大小", value: fileInfo?.exists ? formatSize(fileInfo.size) : "—" },
        { label: "修改时间", value: fileInfo?.modified ? formatModified(fileInfo.modified) : "—" },
      ],
      stats: [
        { label: "标题数", value: String(headings.length) },
        { label: "总行数", value: String(content ? content.split("\n").length : 0) },
        { label: "编辑状态", value: readOnly ? "只读" : dirty ? "未保存" : "已同步" },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, actualPath, readOnly, dirty, headings, fileInfo, content]);

  if (!actualPath) {
    return <div className="center-state"><AppIcon name="alert" size={24} /><strong>Markdown文件路径不存在</strong><span>请从左侧项目树重新打开文件。</span></div>;
  }

  return (
    <div className="document-workspace">
      <div className="document-toolbar">
        <div className="document-toolbar-title"><AppIcon name="markdown" size={16} /><strong>{actualPath.split(/[\\/]/).pop()}</strong><span className={`document-readonly ${readOnly ? "locked" : dirty ? "dirty" : ""}`}>{readOnly ? "锁定只读" : dirty ? "未保存" : "已同步"}</span></div>
        <div className="document-toolbar-actions">
          <div className="mode-switch"><button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} title="阅读预览"><AppIcon name="eye" size={14} />预览</button><button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} title="源码编辑"><AppIcon name="edit" size={14} />编辑</button><button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")} title="左右分屏"><AppIcon name="split" size={14} />分屏</button></div>
          <div className="document-search"><AppIcon name="search" size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文档" />{search && <span>{hits} 处</span>}</div>
          <button className={`icon-button ${showOutline ? "selected" : ""}`} onClick={() => setShowOutline(!showOutline)} title="切换大纲"><AppIcon name="list" size={15} /></button>
          <button className="icon-button" onClick={load} title="从磁盘重新载入"><AppIcon name="refresh" size={15} /></button>
          <button className="button button-primary button-small" disabled={readOnly || !dirty || saving} onClick={() => void save()}><AppIcon name="save" size={14} />{saving ? "保存中" : readOnly ? "只读" : "保存"}</button>
          <button className="icon-button" onClick={() => void systemOpen.reveal(actualPath)} title="在目录中显示"><AppIcon name="folderOpen" size={15} /></button>
          <button className="button button-ghost button-small" onClick={() => void systemOpen.openFile(actualPath)}><AppIcon name="external" size={14} /> 外部打开</button>
        </div>
      </div>
      <div className="document-path" title={actualPath}>{actualPath}{message && <span className={message.includes("失败") ? "error" : "success"}>{message}</span>}</div>
      <div className="document-body">
        {showOutline && mode !== "edit" && <aside className="document-outline"><div className="outline-title">文档大纲</div>{headings.length ? headings.map((heading) => <button key={heading.index} className={`outline-link level-${heading.level}`} onClick={() => jumpToHeading(heading.index)}>{heading.text}</button>) : <span className="outline-empty">暂无标题</span>}</aside>}
        {loading ? <div className="center-state document-loading"><span className="spinner" />加载文档…</div> : mode === "preview" ? <div className="markdown-scroll" ref={contentRef}><MarkdownViewer content={content} /></div> : mode === "edit" ? <textarea ref={editorRef} className="markdown-source-editor" value={content} readOnly={readOnly} onChange={handleEditorChange} onKeyDown={handleEditorKeyDown} spellCheck={false} /> : <div className="markdown-split"><textarea ref={editorRef} className="markdown-source-editor" value={content} readOnly={readOnly} onChange={handleEditorChange} onKeyDown={handleEditorKeyDown} spellCheck={false} /><div className="markdown-scroll" ref={contentRef}><MarkdownViewer content={content} /></div></div>}
      </div>
    </div>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatModified(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value || "—";
  return new Date(time).toLocaleString();
}
