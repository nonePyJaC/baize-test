import React, { useRef, useEffect, useState } from "react";
import AppIcon, { type IconName } from "./AppIcon";

interface RichTextEditorProps {
  initialContent?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (html: string) => void;
  onSave?: (html: string) => void;
  onImagePaste?: (file: File) => Promise<string | null>;
}

export default function RichTextEditor({
  initialContent = "",
  placeholder = "请输入内容…",
  disabled = false,
  onChange,
  onSave,
  onImagePaste,
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.innerHTML !== initialContent) editor.innerHTML = initialContent;
  }, [initialContent]);

  const emitChange = () => {
    setDirty(true);
    onChange?.(serializeContent());
  };

  const exec = (cmd: string, value?: string) => {
    if (disabled) return;
    document.execCommand(cmd, false, value);
    editorRef.current?.focus();
    emitChange();
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    if (disabled) return;
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    void insertImage(file);
  };

  const insertImage = async (file: File) => {
    const attachmentPath = await onImagePaste?.(file);
    const reader = new FileReader();
    reader.onload = () => {
      const image = document.createElement("img");
      image.src = String(reader.result);
      image.alt = "粘贴截图";
      image.style.maxWidth = "100%";
      if (attachmentPath) image.dataset.attachmentPath = attachmentPath;
      editorRef.current?.appendChild(image);
      emitChange();
    };
    reader.readAsDataURL(file);
  };

  const serializeContent = () => {
    const holder = document.createElement("template");
    holder.innerHTML = editorRef.current?.innerHTML || "";
    holder.content.querySelectorAll("img[data-attachment-path]").forEach((image) => {
      const path = image.getAttribute("data-attachment-path");
      if (path) {
        image.setAttribute("src", path);
        image.removeAttribute("data-attachment-path");
      }
    });
    return holder.innerHTML;
  };

  const handleSave = () => {
    if (disabled || !onSave) return;
    onSave(serializeContent());
    setDirty(false);
    setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        // 所有打开的Tab保持挂载：隐藏Tab里的编辑器不该响应Ctrl+S（offsetParent为null即不可见）
        if (editorRef.current && editorRef.current.offsetParent === null) return;
        event.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const tools: { label: string; icon: IconName; cmd: string; value?: string }[] = [
    { label: "一级标题", icon: "heading1", cmd: "formatBlock", value: "h1" },
    { label: "二级标题", icon: "heading2", cmd: "formatBlock", value: "h2" },
    { label: "粗体", icon: "bold", cmd: "bold" },
    { label: "斜体", icon: "italic", cmd: "italic" },
    { label: "下划线", icon: "underline", cmd: "underline" },
    { label: "无序列表", icon: "list", cmd: "insertUnorderedList" },
    { label: "有序列表", icon: "listOrdered", cmd: "insertOrderedList" },
    { label: "引用", icon: "quote", cmd: "formatBlock", value: "blockquote" },
    { label: "代码块", icon: "code", cmd: "formatBlock", value: "pre" },
    { label: "插入链接", icon: "link", cmd: "createLink" },
    { label: "分隔线", icon: "minus", cmd: "insertHorizontalRule" },
  ];

  return (
    <div className={`rich-editor ${disabled ? "disabled" : ""}`}>
      <div className="rich-editor-toolbar">
        {tools.map((tool) => <button key={tool.label} type="button" title={tool.label} disabled={disabled} onClick={() => {
          if (tool.cmd === "createLink") {
            const url = window.prompt("请输入链接地址");
            if (url) exec(tool.cmd, url);
          } else exec(tool.cmd, tool.value);
        }}><AppIcon name={tool.icon} size={14} /></button>)}
        <div className="toolbar-divider" />
        <button type="button" title="插入待办" disabled={disabled} onClick={() => exec("insertHTML", '<label class="editor-task"><input type="checkbox" /> <span>待办事项</span></label>')}><AppIcon name="square" size={14} /></button>
        <div className="rich-editor-toolbar-spacer" />
        {savedAt && <span className="editor-save-time">已保存 {savedAt}</span>}
        {onSave && <button type="button" className={`editor-save-button ${dirty ? "dirty" : ""}`} disabled={disabled || !dirty} onClick={handleSave}><AppIcon name="save" size={14} /> 保存</button>}
      </div>
      <div ref={editorRef} className="rich-editor-content" contentEditable={!disabled} data-placeholder={placeholder} suppressContentEditableWarning onInput={emitChange} onPaste={handlePaste} />
    </div>
  );
}
