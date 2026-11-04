import React, { useState, useEffect, useRef } from "react";
import { api } from "../lib/api";
import { useWorkspace } from "../App";
import MarkdownViewer from "../components/MarkdownViewer";
import type { DirEntryInfo } from "../lib/types";
import AppIcon, { type IconName } from "../components/AppIcon";

export default function MarkdownViewerPage() {
  const { workspace } = useWorkspace();
  const [currentDir, setCurrentDir] = useState<string>(workspace.workspace.root_path);
  const [entries, setEntries] = useState<DirEntryInfo[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    loadDir(currentDir);
  }, [currentDir]);

  const loadDir = (dir: string) => {
    api.listDirectory(dir).then(setEntries).catch(console.error);
  };

  const openFile = (path: string) => {
    setLoading(true);
    setCurrentFile(path);
    api.readTextFile(path).then((c) => {
      setContent(c);
      setLoading(false);
    }).catch((e) => {
      setContent(`# 读取失败\n\n${e}`);
      setLoading(false);
    });
  };

  const filtered = entries.filter((e) =>
    e.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ display: "flex", height: "calc(100vh - var(--header-height) - 40px)", gap: 12 }}>
      {/* 文件浏览器 */}
      <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <div className="card" style={{ padding: 8, marginBottom: 0 }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            <button className="btn btn-sm btn-secondary" onClick={() => {
              const parent = currentDir.replace(/[\\/][^\\/]+$/, "");
              if (parent && parent !== currentDir) setCurrentDir(parent);
            }}>↑ 上级</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setCurrentDir(workspace.workspace.root_path)}>
              <AppIcon name="folderOpen" size={14} /> 根目录
            </button>
          </div>
          <input
            className="form-input"
            placeholder="搜索文件名…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div style={{ overflowY: "auto", flex: 1, maxHeight: "calc(100vh - 280px)" }}>
            {filtered.map((e) => (
              <div
                key={e.path}
                className="file-tree-item"
                onClick={() => e.is_dir ? setCurrentDir(e.path) : openFile(e.path)}
                style={{
                  background: currentFile === e.path ? "var(--bg-tertiary)" : undefined,
                }}
              >
                <span className="icon"><AppIcon name={e.is_dir ? "folder" : getFileIcon(e.name)} size={14} /></span>
                <span style={{
                  color: e.is_dir ? "var(--text-primary)" : "var(--text-secondary)",
                  fontWeight: e.is_dir ? 500 : 400,
                }}>{e.name}</span>
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
                无匹配文件
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Markdown 渲染区 */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div className="card" style={{ flex: 1, overflow: "auto", marginBottom: 0 }}>
          {!currentFile ? (
            <div className="empty-state">
              <div className="icon"><AppIcon name="file" size={28} /></div>
              <p>选择左侧的 .md 文件查看</p>
              <p style={{ fontSize: 12, marginTop: 8, color: "var(--text-muted)" }}>
                AI生成的需求理解、测试计划、复盘记录等均为Markdown格式
              </p>
            </div>
          ) : loading ? (
            <div className="empty-state"><div className="icon"><AppIcon name="clock" size={28} /></div>加载中…</div>
          ) : (
            <>
              <div style={{
                padding: "8px 12px", marginBottom: 12,
                background: "var(--bg-secondary)", borderRadius: "var(--radius)",
                fontSize: 12, color: "var(--text-muted)",
                fontFamily: "monospace",
              }}>
                {currentFile}
              </div>
              <MarkdownViewer content={content} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function getFileIcon(name: string): IconName {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "md") return "markdown";
  if (ext === "yaml" || ext === "yml" || ext === "py") return "codeFile";
  if (ext === "json") return "jsonFile";
  if (ext === "xmind" || ext === "zip") return "archiveFile";
  if (ext === "docx" || ext === "doc") return "file";
  if (ext === "xlsx" || ext === "xls") return "spreadsheet";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif") return "image";
  return "file";
}
