import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useWorkspace } from "../App";
import {
  STAGE_LABELS, STAGE_ORDER,
  type RequirementMeta, type UnlockPreview,
} from "../lib/types";
import AppIcon from "../components/AppIcon";
import { formatDate, formatDateTime } from "../lib/date";

export default function RequirementDetailPage() {
  const { platformId, reqId } = useParams();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [req, setReq] = useState<RequirementMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLockDialog, setShowLockDialog] = useState(false);
  const [unlockPreview, setUnlockPreview] = useState<UnlockPreview | null>(null);

  const platform = workspace.platforms.find((p) => p.id === platformId);

  useEffect(() => {
    if (!platform) return;
    setLoading(true);
    api.readRequirement(workspace.workspace.root_path, platform.path, reqId!).then((r) => {
      setReq(r);
      setLoading(false);
    }).catch((e) => {
      console.error(e);
      setLoading(false);
    });
  }, [platform, reqId, workspace.workspace.root_path]);

  if (!platform || loading) {
    return <div className="empty-state"><div className="icon"><AppIcon name="clock" size={28} /></div>加载中…</div>;
  }

  if (!req) {
    return <div className="empty-state"><div className="icon">❓</div>需求不存在</div>;
  }

  const isLocked = req.client_access.mode === "locked_for_ai";
  const stageIdx = STAGE_ORDER.indexOf(req.current_stage);

  const refresh = () => {
    api.readRequirement(workspace.workspace.root_path, platform.path, reqId!).then(setReq);
  };

  const handleLock = async (taskId: string, note: string) => {
    try {
      const updated = await api.lockRequirement(
        workspace.workspace.root_path, platform.path, reqId!, taskId, note, "用户"
      );
      setReq(updated);
      setShowLockDialog(false);
    } catch (e: any) {
      alert("锁定失败: " + e);
    }
  };

  const handleUnlock = async () => {
    try {
      const result = await api.scanRequirementChanges(workspace.workspace.root_path, platform.path, reqId!);
      setReq(result.requirement);
      setUnlockPreview(result);
    } catch (e: any) {
      alert("扫描变化失败: " + e);
    }
  };

  const acceptUnlock = async () => {
    try {
      const result = await api.acceptUnlockRequirement(workspace.workspace.root_path, platform.path, reqId!);
      setReq(result.requirement);
      setUnlockPreview(null);
    } catch (e: any) {
      alert("解锁失败: " + e);
    }
  };

  const forceUnlock = async () => {
    if (!window.confirm("强制解锁不会逐项校验外部产物，确定继续吗？")) return;
    try {
      const result = await api.forceUnlockRequirement(workspace.workspace.root_path, platform.path, reqId!, "用户确认强制解锁");
      setReq(result.requirement);
      setUnlockPreview(null);
    } catch (e: any) {
      alert("强制解锁失败: " + e);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{req.requirement.id}</span>
        <h2 style={{ margin: 0 }}>{req.requirement.name}</h2>
        {isLocked && <span className="badge badge-warning"><AppIcon name="lock" size={12} /> 已交AI处理</span>}
      </div>

      {/* 阶段进度 */}
      <div className="card">
        <div className="card-title">阶段进度</div>
        <div className="stage-progress" style={{ margin: "8px 0 12px" }}>
          {STAGE_ORDER.map((s, i) => (
            <div
              key={s}
              className={`stage-dot ${i < stageIdx ? "completed" : i === stageIdx ? "current" : ""}`}
              title={STAGE_LABELS[s]}
            />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
          <span>当前: {STAGE_LABELS[req.current_stage]}</span>
          <span>{stageIdx + 1} / {STAGE_ORDER.length}</span>
        </div>
      </div>

      {/* 基本信息 */}
      <div className="card">
        <div className="card-title">基本信息</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 120px 1fr", gap: "8px 16px", fontSize: 13 }}>
          <span style={{ color: "var(--text-secondary)" }}>需求编号</span>
          <span>{req.requirement.id}</span>
          <span style={{ color: "var(--text-secondary)" }}>负责人</span>
          <span>{req.requirement.owner || "未指派"}</span>
          <span style={{ color: "var(--text-secondary)" }}>所属平台</span>
          <span>{platform.name}</span>
          <span style={{ color: "var(--text-secondary)" }}>创建时间</span>
          <span>{formatDate(req.requirement.created_at)}</span>
          <span style={{ color: "var(--text-secondary)" }}>计划提测</span>
          <span>{formatDate(req.schedule.planned_test_date)}</span>
          <span style={{ color: "var(--text-secondary)" }}>计划上线</span>
          <span>{req.schedule.planned_release_date || "未定"}</span>
        </div>
      </div>

      {/* 涉及应用 */}
      <div className="card">
        <div className="card-title">涉及应用</div>
        {req.applications.length === 0 ? (
          <span style={{ color: "var(--text-muted)", fontSize: 13 }}>未配置</span>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {req.applications.map((app, i) => (
              <span key={i} className="badge badge-info">
                {app.name} ({app.branch})
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 阻塞项 */}
      {req.blockers.length > 0 && (
        <div className="card">
          <div className="card-title">阻塞项 ({req.blockers.length})</div>
          {req.blockers.map((b: any, i: number) => (
            <div key={i} className="badge badge-danger" style={{ display: "block", marginBottom: 4 }}>
              {b.description}
            </div>
          ))}
        </div>
      )}

      {/* 推荐下一步 */}
      {req.next_actions.length > 0 && (
        <div className="card">
          <div className="card-title">推荐下一步</div>
          {req.next_actions.map((a: any, i: number) => (
            <div key={i} style={{ padding: "4px 0", fontSize: 13 }}>
              <span className={`badge ${a.priority === "high" ? "badge-danger" : "badge-info"}`}>
                {a.priority}
              </span>
              <span style={{ marginLeft: 8 }}>{a.action}</span>
            </div>
          ))}
        </div>
      )}

      {/* AI任务交接 */}
      <div className="card">
        <div className="card-title">AI任务交接</div>
        {!isLocked ? (
          <>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
              锁定需求目录后，客户端进入只读模式，外部AI（Codex/Devin/CLI）可直接修改目录内容。
              AI完成后点击"解锁并扫描变化"查看差异。
            </p>
            <button className="btn btn-warning" onClick={() => setShowLockDialog(true)}>
              <AppIcon name="lock" size={14} /> 交由AI处理
            </button>
          </>
        ) : (
          <>
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              <div><span style={{ color: "var(--text-secondary)" }}>锁定时间:</span> {formatDateTime(req.client_access.locked_at)}</div>
              <div><span style={{ color: "var(--text-secondary)" }}>关联任务:</span> {req.client_access.task_id}</div>
              <div><span style={{ color: "var(--text-secondary)" }}>说明:</span> {req.client_access.note}</div>
            </div>
            <button className="btn btn-primary" onClick={handleUnlock}>
              <AppIcon name="lock" size={14} /> AI处理完成，查看变化
            </button>
          </>
        )}
      </div>

      {/* 快捷入口 */}
      <div className="card">
        <div className="card-title">快捷入口</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-secondary" onClick={() => navigate(`/requirement/${platformId}/${reqId}/questions`)}>
            ❓ 疑问管理
          </button>
          <button className="btn btn-secondary" onClick={() => navigate("/markdown")}>
            <AppIcon name="markdown" size={14} /> Markdown阅读
          </button>
        </div>
      </div>

      {/* 锁定对话框 */}
      {showLockDialog && (
        <LockDialog
          onCancel={() => setShowLockDialog(false)}
          onConfirm={handleLock}
        />
      )}

      {/* 解锁结果对话框 */}
      {unlockPreview && (
        <UnlockResultDialog
          result={unlockPreview}
          onKeep={() => setUnlockPreview(null)}
          onAccept={() => void acceptUnlock()}
          onForce={() => void forceUnlock()}
        />
      )}
    </div>
  );
}

function LockDialog({ onCancel, onConfirm }: {
  onCancel: () => void;
  onConfirm: (taskId: string, note: string) => void;
}) {
  const [taskId, setTaskId] = useState("");
  const [note, setNote] = useState("");

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.6)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div className="card" style={{ width: 420, maxWidth: "90vw" }}>
        <div className="card-title">锁定需求目录</div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
          锁定后客户端将禁止编辑此需求，外部AI可自由修改目录内容。
        </p>
        <div className="form-group">
          <label className="form-label">AI任务ID</label>
          <input className="form-input" value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            placeholder="如: task-001" />
        </div>
        <div className="form-group">
          <label className="form-label">说明</label>
          <textarea className="form-textarea" value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如: 生成需求理解文档" />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onCancel}>取消</button>
          <button className="btn btn-warning"
            disabled={!taskId}
            onClick={() => onConfirm(taskId, note)}>确认锁定</button>
        </div>
      </div>
    </div>
  );
}

function UnlockResultDialog({ result, onKeep, onAccept, onForce }: {
  result: UnlockPreview;
  onKeep: () => void;
  onAccept: () => void;
  onForce: () => void;
}) {
  const { changes } = result;
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.6)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div className="card" style={{ width: 600, maxWidth: "90vw", maxHeight: "80vh", overflowY: "auto" }}>
        <div className="card-title">解锁确认 - 文件变化扫描</div>
        <p style={{ fontSize: 13, marginBottom: 12 }}>
          变化已扫描，当前仍保持锁定，共检测到 <strong>{changes.total}</strong> 个文件变化
        </p>
        <div className="change-list">
          {changes.added.length > 0 && (
            <div className="change-section">
              <h4><span className="badge badge-success">+ 新增 ({changes.added.length})</span></h4>
              {changes.added.map((f, i) => (
                <div key={i} className="change-item change-added">{f}</div>
              ))}
            </div>
          )}
          {changes.modified.length > 0 && (
            <div className="change-section">
              <h4><span className="badge badge-warning">~ 修改 ({changes.modified.length})</span></h4>
              {changes.modified.map((f, i) => (
                <div key={i} className="change-item change-modified">{f}</div>
              ))}
            </div>
          )}
          {changes.deleted.length > 0 && (
            <div className="change-section">
              <h4><span className="badge badge-danger">- 删除 ({changes.deleted.length})</span></h4>
              {changes.deleted.map((f, i) => (
                <div key={i} className="change-item change-deleted">{f}</div>
              ))}
            </div>
          )}
          {changes.moved.length > 0 && (
            <div className="change-section">
              <h4><span className="badge badge-info">↔ 移动 ({changes.moved.length})</span></h4>
              {changes.moved.map((item, i) => (
                <div key={i} className="change-item">{item.from} → {item.to}</div>
              ))}
            </div>
          )}
          {changes.total === 0 && (
            <div className="empty-state" style={{ padding: 20 }}>
              <div className="icon">✓</div>
              <p>无文件变化</p>
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={onKeep}>保持锁定</button>
          <button className="btn btn-secondary" onClick={onForce}>强制解锁</button>
          <button className="btn btn-primary" onClick={onAccept}>接受变化并解锁</button>
        </div>
      </div>
    </div>
  );
}
