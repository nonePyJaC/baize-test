import React from "react";
import { useWorkspace } from "../App";
import { STAGE_LABELS, STAGE_ORDER } from "../lib/types";
import AppIcon from "../components/AppIcon";
import { formatDate } from "../lib/date";

export default function HomePage() {
  const { workspace } = useWorkspace();

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>工作区概览</h2>

      <div className="card">
        <div className="card-title">基本信息</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "8px 16px", fontSize: 13 }}>
          <span style={{ color: "var(--text-secondary)" }}>工作区名称</span>
          <span>{workspace.workspace.name}</span>
          <span style={{ color: "var(--text-secondary)" }}>根目录</span>
          <span style={{ fontFamily: "monospace" }}>{workspace.workspace.root_path}</span>
          <span style={{ color: "var(--text-secondary)" }}>协议版本</span>
          <span>{workspace.version}</span>
          <span style={{ color: "var(--text-secondary)" }}>创建时间</span>
          <span>{formatDate(workspace.workspace.created_at)}</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">平台列表 ({workspace.platforms.length})</div>
        {workspace.platforms.length === 0 ? (
          <div className="empty-state" style={{ padding: 20 }}>
            <div className="icon"><AppIcon name="folderOpen" size={28} /></div>
            <p>未发现平台目录</p>
            <p style={{ fontSize: 12, marginTop: 8 }}>
              请在 {workspace.workspace.root_path}\projects 下创建客户平台目录
            </p>
          </div>
        ) : (
          <div className="requirement-grid">
            {workspace.platforms.map((p) => (
              <div key={p.id} className="req-card" onClick={() => {
                window.location.hash = `#/requirements/${p.id}`;
              }}>
                <div className="req-id">平台</div>
                <div className="req-name">{p.name}</div>
                <div className="req-meta">
                  <span><AppIcon name="folder" size={14} /> {p.path}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">需求阶段定义</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {STAGE_ORDER.map((stage, idx) => (
            <span key={stage} className="badge badge-info" style={{ fontSize: 11 }}>
              {idx + 1}. {STAGE_LABELS[stage]}
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">目录结构</div>
        <div style={{ fontSize: 13, fontFamily: "monospace", lineHeight: 1.8 }}>
          {workspace.workspace.root_path}\<br />
          ├─ .blackbox/        # 客户端内部（索引、任务、日志）<br />
          ├─ projects/         # 需求（按平台/需求编号）<br />
          ├─ templates/        # 模板（XMind、Excel）<br />
          ├─ knowledge/        # 知识库<br />
          ├─ tools/            # 工具脚本<br />
          └─ archive/          # 归档
        </div>
      </div>
    </div>
  );
}
