import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useWorkspace } from "../App";
import { STAGE_LABELS, STAGE_ORDER, type RequirementMeta } from "../lib/types";
import AppIcon from "../components/AppIcon";
import { formatDate } from "../lib/date";

export default function RequirementsPage() {
  const { platformId } = useParams();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [requirements, setRequirements] = useState<RequirementMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const platform = workspace.platforms.find((p) => p.id === platformId);

  useEffect(() => {
    if (!platform) return;
    setLoading(true);
    api.scanRequirements(workspace.workspace.root_path, platform.path).then((reqs) => {
      setRequirements(reqs);
      setLoading(false);
    }).catch((e) => {
      console.error(e);
      setLoading(false);
    });
  }, [platform, workspace.workspace.root_path]);

  if (!platform) {
    return <div className="empty-state"><div className="icon">❓</div>未找到平台</div>;
  }

  if (loading) {
    return <div className="empty-state"><div className="icon">⏳</div>扫描需求中…</div>;
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>{platform.name} - 需求列表</h2>

      {requirements.length === 0 ? (
        <div className="empty-state">
          <div className="icon"><AppIcon name="inbox" size={28} /></div>
          <p>未发现需求</p>
          <p style={{ fontSize: 12, marginTop: 8 }}>
            请在 {workspace.workspace.root_path}\{platform.path} 下创建需求目录，并放置 requirement.yaml
          </p>
        </div>
      ) : (
        <div className="requirement-grid">
          {requirements.map((req) => (
            <RequirementCard
              key={req.requirement.id}
              req={req}
              onClick={() => navigate(`/requirement/${platformId}/${req.requirement.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RequirementCard({ req, onClick }: { req: RequirementMeta; onClick: () => void }) {
  const isLocked = req.client_access.mode === "locked_for_ai";
  const stageIdx = STAGE_ORDER.indexOf(req.current_stage);

  return (
    <div className={`req-card ${isLocked ? "locked" : ""}`} onClick={onClick}>
      <div className="req-id">{req.requirement.id}</div>
      <div className="req-name">{req.requirement.name}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <span className={`req-status ${isLocked ? "locked" : ""}`}>
          {STAGE_LABELS[req.current_stage] || req.current_stage}
        </span>
        {isLocked && <span className="badge badge-warning"><AppIcon name="lock" size={12} /> 已交AI</span>}
      </div>
      <div className="stage-progress" style={{ marginTop: 8 }}>
        {STAGE_ORDER.map((s, i) => (
          <div
            key={s}
            className={`stage-dot ${i < stageIdx ? "completed" : i === stageIdx ? "current" : ""}`}
          />
        ))}
      </div>
      <div className="req-meta">
        <span><AppIcon name="clock" size={13} /> {formatDate(req.schedule.planned_test_date)}</span>
        <span><AppIcon name="users" size={13} /> {req.requirement.owner || "未指派"}</span>
      </div>
    </div>
  );
}
