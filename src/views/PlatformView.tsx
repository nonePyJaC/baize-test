import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import AppIcon from "../components/AppIcon";
import PlatformManagementModal from "../components/PlatformManagementModal";
import { formatDate } from "../lib/date";
import { STAGE_LABELS, STAGE_ORDER, type PlatformInfo, type RequirementMeta, type WorkspaceConfig } from "../lib/types";
import type { WorkbenchTab } from "../lib/workbench";

export default function PlatformView({ platform, workspace, onOpenTab, onWorkspaceChange, onCreateRequirement, requirementRevision, onRightContext }: { platform: PlatformInfo; workspace: WorkspaceConfig; onOpenTab: (tab: WorkbenchTab) => void; onWorkspaceChange: (workspace: WorkspaceConfig) => void; onCreateRequirement: (platform: PlatformInfo) => void; requirementRevision: number; onRightContext?: import("../lib/workbench").RightContextReporter }) {
  const rootPath = workspace.workspace.root_path;
  const [requirements, setRequirements] = useState<RequirementMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPlatformModal, setShowPlatformModal] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.scanRequirements(rootPath, platform.path)
      .then(setRequirements)
      .catch(() => setRequirements([]))
      .finally(() => setLoading(false));
  }, [platform.path, requirementRevision, rootPath]);

  // BB-16D：上报平台需求大纲与平台属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "platform",
      objectId: platform.id,
      title: platform.name,
      subtitle: platform.path,
      platformId: platform.id,
      outlineTitle: "需求列表",
      outline: requirements.map((req) => ({
        id: req.requirement.id,
        label: `${req.requirement.id} ${req.requirement.name}`,
        badge: STAGE_LABELS[req.current_stage] || req.current_stage,
        icon: req.client_access.mode === "locked_for_ai" ? "lock" : "box",
        onSelect: () => onOpenTab(requirementTab(platform, req)),
      })),
      properties: [
        { label: "平台ID", value: platform.id, mono: true },
        { label: "名称", value: platform.name },
        { label: "项目目录", value: platform.path, mono: true },
        { label: "知识目录", value: platform.knowledge_path || "—", mono: true },
        { label: "状态", value: platform.status === "archived" ? "已归档" : "启用" },
        { label: "创建时间", value: formatDate(platform.created_at) },
      ],
      stats: [
        { label: "需求数", value: String(requirements.length) },
        { label: "进行中", value: String(requirements.filter((item) => !["completed", "archived"].includes(item.current_stage)).length) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, platform, requirements]);

  return (
    <div className="workspace-view">
      <section className="document-header">
        <div className="document-title-row"><span className="document-icon blue"><AppIcon name="platform" size={20} /></span><div><div className="eyebrow">平台 {platform.status === "archived" && <span className="status-pill">已归档</span>}</div><h1>{platform.name}</h1><p>{platform.path}</p></div></div>
        <div className="header-actions"><button className="button button-ghost" onClick={() => setShowPlatformModal(true)}><AppIcon name="settings" size={15} /> 平台设置</button><button className="button button-primary button-small" disabled={platform.status === "archived"} title={platform.status === "archived" ? "归档平台不能创建新需求" : "在当前平台创建标准需求"} onClick={() => onCreateRequirement(platform)}><AppIcon name="add" size={15} /> 新建需求</button></div>
      </section>
      <section className="metric-grid compact-metrics">
        <Metric label="全部需求" value={loading ? "…" : requirements.length} icon="box" />
        <Metric label="进行中" value={requirements.filter((item) => !["completed", "archived"].includes(item.current_stage)).length} icon="timer" />
        <Metric label="待答疑" value={requirements.filter((item) => item.current_stage === "pending_qa").length} icon="help" />
        <Metric label="已交AI" value={requirements.filter((item) => item.client_access.mode === "locked_for_ai").length} icon="ai" />
      </section>
      <section className="panel-section">
        <div className="section-heading"><div><AppIcon name="box" size={16} /><h2>需求列表</h2></div><span className="section-muted">{platform.path}/需求编号/</span></div>
        {loading ? <div className="loading-line"><span className="spinner" />正在扫描需求目录…</div> : requirements.length === 0 ? (
          <div className="inline-empty large"><AppIcon name="inbox" size={20} /><div><strong>这个平台还没有标准需求</strong><span>在 {platform.path} 下创建需求目录并添加 requirement.yaml，客户端会自动识别。</span></div></div>
        ) : <div className="requirement-table"><div className="table-header"><span>需求</span><span>阶段</span><span>计划提测</span><span>负责人</span><span>状态</span></div>{requirements.map((req) => <RequirementRow key={req.requirement.id} req={req} platform={platform} onOpen={() => onOpenTab(requirementTab(platform, req))} />)}</div>}
      </section>
      {showPlatformModal && <PlatformManagementModal workspace={workspace} platform={platform} onClose={() => setShowPlatformModal(false)} onSaved={onWorkspaceChange} />}
    </div>
  );
}

function RequirementRow({ req, platform, onOpen }: { req: RequirementMeta; platform: PlatformInfo; onOpen: () => void }) {
  const stageIndex = Math.max(0, STAGE_ORDER.indexOf(req.current_stage));
  const locked = req.client_access.mode === "locked_for_ai";
  return <button className="requirement-row" onClick={onOpen}><span className="requirement-name"><span className="row-icon"><AppIcon name={locked ? "lock" as any : "box"} size={15} /></span><span><strong>{req.requirement.id}</strong><small>{req.requirement.name}</small></span></span><span className="stage-cell"><span className="stage-mini"><i style={{ width: `${Math.round(((stageIndex + 1) / STAGE_ORDER.length) * 100)}%` }} /></span>{STAGE_LABELS[req.current_stage] || req.current_stage}</span><span>{formatDate(req.schedule.planned_test_date)}</span><span>{req.requirement.owner || "未指派"}</span><span>{locked ? <span className="status-pill warning"><AppIcon name="lock" size={12} /> AI处理中</span> : <span className="status-pill">{STAGE_LABELS[req.current_stage] || req.current_stage}</span>}</span></button>;
}

function Metric({ label, value, icon }: { label: string; value: string | number; icon: any }) {
  return <div className="metric-card metric-neutral"><div className="metric-icon"><AppIcon name={icon} size={16} /></div><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function requirementTab(platform: PlatformInfo, req: RequirementMeta): WorkbenchTab {
  return { id: `requirement:${platform.id}:${req.requirement.id}`, type: "requirement", title: req.requirement.id, subtitle: `${platform.name} · ${req.requirement.name}`, icon: req.client_access.mode === "locked_for_ai" ? "lock" : "box", preview: false, pinned: true, dirty: false, closable: true, payload: { platformId: platform.id, platformPath: platform.path, requirementId: req.requirement.id } };
}
