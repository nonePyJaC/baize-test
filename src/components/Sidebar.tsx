import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useWorkspace } from "../App";
import AppIcon from "./AppIcon";

export default function Sidebar() {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();

  return (
    <div className="app-sidebar">
      <div className="nav-section-title">工作区</div>
      <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
        <AppIcon name="dashboard" size={15} /> 首页
      </NavLink>

      <div className="nav-section-title">平台</div>
      {workspace.platforms.map((p) => (
        <NavLink
          key={p.id}
          to={`/requirements/${p.id}`}
          className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
        >
          <AppIcon name="platform" size={15} /> {p.name}
        </NavLink>
      ))}

      <div className="nav-section-title">工具</div>
      <NavLink to="/markdown" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
        <AppIcon name="markdown" size={15} /> Markdown阅读
      </NavLink>

      <div style={{ flex: 1 }} />
      <div style={{ padding: "8px 16px", fontSize: 11, color: "var(--text-muted)" }}>
        v0.1.0 · A-D组
      </div>
    </div>
  );
}
