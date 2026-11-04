import React, { useEffect, useMemo, useState } from "react";
import mammoth from "mammoth";
import DOMPurify from "dompurify";
import { api } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import AppIcon from "../components/AppIcon";
import type { PathInfo } from "../lib/types";
import type { RightContextReporter } from "../lib/workbench";
import { formatModified, formatSize } from "./MarkdownDocumentView";

export default function DocxDocumentView({ path, onRightContext }: { path: string; onRightContext?: RightContextReporter }) {
  const [html, setHtml] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showOutline, setShowOutline] = useState(true);
  const [fileInfo, setFileInfo] = useState<PathInfo | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const bytes = await api.readBinaryFile(path);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const result = await mammoth.convertToHtml(
        { arrayBuffer },
        {
          convertImage: mammoth.images.imgElement(async (image) => ({
            src: `data:${image.contentType};base64,${await image.read("base64")}`,
          })),
        },
      );
      setHtml(DOMPurify.sanitize(result.value, { FORBID_TAGS: ["script", "iframe", "object", "embed"] }));
      setMessages(result.messages.map((message) => message.message));
    } catch (reason) {
      setError(`DOCX解析失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [path]);

  useEffect(() => {
    let cancelled = false;
    api.getPathInfo(path).then((info) => { if (!cancelled) setFileInfo(info); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [path, loading]);

  const headings = useMemo(() => {
    const document = new DOMParser().parseFromString(html, "text/html");
    return Array.from(document.querySelectorAll("h1, h2, h3")).map((element, index) => ({ index, text: element.textContent || `标题${index + 1}`, level: Number(element.tagName.slice(1)) }));
  }, [html]);

  const jump = (index: number) => document.querySelectorAll(".docx-content h1, .docx-content h2, .docx-content h3")[index]?.scrollIntoView({ behavior: "smooth", block: "start" });

  // BB-16D：上报真实标题大纲与文件属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "file",
      title: path.split(/[\\/]/).pop() || "DOCX文档",
      subtitle: path,
      path,
      readOnly: true,
      outlineTitle: "文档标题",
      outline: headings.map((heading) => ({ id: `h-${heading.index}`, label: heading.text, depth: heading.level - 1, icon: "file", onSelect: () => jump(heading.index) })),
      properties: [
        { label: "文件名称", value: path.split(/[\\/]/).pop() || "" },
        { label: "文件类型", value: "DOCX文档" },
        { label: "文件大小", value: fileInfo?.exists ? formatSize(fileInfo.size) : "—" },
        { label: "修改时间", value: fileInfo?.modified ? formatModified(fileInfo.modified) : "—" },
        { label: "格式提示", value: messages.length ? `${messages.length} 条` : "无" },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, path, headings, fileInfo, messages]);

  return (
    <div className="document-workspace">
      <div className="document-toolbar"><div className="document-toolbar-title"><AppIcon name="file" size={16} /><strong>{path.split(/[\\/]/).pop()}</strong><span className="document-readonly">DOCX阅读</span></div><div className="document-toolbar-actions"><button className={`icon-button ${showOutline ? "selected" : ""}`} onClick={() => setShowOutline(!showOutline)} title="切换大纲"><AppIcon name="list" size={15} /></button><button className="icon-button" onClick={() => void load()} title="重新解析"><AppIcon name="refresh" size={15} /></button><button className="icon-button" onClick={() => void systemOpen.reveal(path)} title="在目录中显示"><AppIcon name="folderOpen" size={15} /></button><button className="button button-ghost button-small" onClick={() => void systemOpen.openFile(path)}><AppIcon name="external" size={14} /> Word/WPS打开</button></div></div>
      <div className="document-path" title={path}>{path}{messages.length > 0 && <span>{messages.length} 条格式提示</span>}</div>
      <div className="document-body">{showOutline && <aside className="document-outline"><div className="outline-title">文档大纲</div>{headings.length ? headings.map((heading) => <button key={heading.index} className={`outline-link level-${heading.level}`} onClick={() => jump(heading.index)}>{heading.text}</button>) : <span className="outline-empty">未识别到标题样式</span>}</aside>}<div className="office-scroll">{loading ? <div className="center-state"><span className="spinner" />正在解析DOCX…</div> : error ? <DocumentError message={error} onRetry={load} /> : <article className="office-document docx-content" dangerouslySetInnerHTML={{ __html: html }} />}</div></div>
    </div>
  );
}

function DocumentError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="center-state"><AppIcon name="alert" size={24} /><strong>{message}</strong><span>复杂分页、文本框或特殊Office对象可能需要使用Word/WPS查看。</span><button className="button button-primary" onClick={onRetry}>重新解析</button></div>; }
