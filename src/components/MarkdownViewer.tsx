import React, { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: true,
});

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

/**
 * Markdown 友好阅读器
 * - 支持 GFM 表格、代码块、图片、链接
 * - 通过 DOMPurify 清洗 HTML，禁止执行脚本
 * - 不支持在客户端内直接编辑，用户可通过外部编辑器修改
 */
export default function MarkdownViewer({ content, className }: MarkdownViewerProps) {
  const html = useMemo(() => {
    const raw = marked.parse(content || "") as string;
    return DOMPurify.sanitize(raw, {
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    });
  }, [content]);

  return (
    <div
      className={`markdown-body ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
