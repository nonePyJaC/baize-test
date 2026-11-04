import { useDraftSave } from "../lib/draftGuard";
import { useBusinessRefresh } from "../lib/businessEvents";
import React, { useEffect, useMemo, useState, useRef } from "react";
import { api, joinPath } from "../lib/api";
import AppIcon from "../components/AppIcon";
import { formatActivityTime } from "../lib/date";
import { recordActivity, toWorkspaceRelative } from "../lib/requirementFlow";
import type { CoverageData, CoverageItem, PlatformInfo } from "../lib/types";

const COVERAGE_LABELS: Record<CoverageItem["coverage"], string> = {
  covered: "已覆盖",
  partial: "部分覆盖",
  none: "未覆盖",
  exempt: "已豁免",
};
const KIND_LABELS: Record<CoverageItem["kind"], string> = {
  task: "任务",
  interface: "接口",
  rule: "规则",
  shared_surface: "共用面",
  other: "其他",
};

export default function CoverageView({ rootPath, platform, requirementId, readOnly = false, onRightContext, onDirtyChange }: {
  rootPath: string;
  platform: PlatformInfo;
  requirementId: string;
  readOnly?: boolean;
  onRightContext?: import("../lib/workbench").RightContextReporter;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const coveragePath = joinPath(rootPath, platform.path, requirementId, "03-测试计划", "coverage.json");
  const [dataRevision, setDataRevision] = useState(0);
  const baseData = useRef<CoverageData | null>(null);
  const [data, setData] = useState<CoverageData | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | CoverageItem["coverage"]>("all");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState("未修改");
  const [exemptDraft, setExemptDraft] = useState<string | null>(null);

  useBusinessRefresh([coveragePath], dirty || exemptDraft !== null, () => setDataRevision((v) => v + 1), () => setSaveState("磁盘有新版本，当前草稿保留"));
  useEffect(() => {
    api.readJsonFile(coveragePath).then((value) => {
      const next = value as CoverageData;
      if (next && Array.isArray(next.items)) { baseData.current = next; setData(next); }
      setExists(true);
    }).catch(() => setExists(false));
  }, [coveragePath, dataRevision]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const visible = useMemo(() => filter === "all" ? items : items.filter((item) => item.coverage === filter), [items, filter]);
  const selected = items.find((item) => item.id === selectedId) || visible[0];
  const stats = useMemo(() => ({
    all: items.length,
    none: items.filter((item) => item.coverage === "none").length,
    partial: items.filter((item) => item.coverage === "partial").length,
    covered: items.filter((item) => item.coverage === "covered").length,
    exempt: items.filter((item) => item.coverage === "exempt").length,
  }), [items]);

  useEffect(() => { onDirtyChange?.(dirty || exemptDraft !== null); }, [dirty, exemptDraft, onDirtyChange]);

  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "requirement",
      objectId: requirementId,
      title: "覆盖追溯",
      subtitle: `${platform.name} · ${requirementId}`,
      path: coveragePath,
      platformId: platform.id,
      requirementId,
      readOnly,
      outlineTitle: "覆盖项",
      outline: visible.slice(0, 60).map((item) => ({
        id: item.id,
        label: item.title,
        badge: COVERAGE_LABELS[item.coverage],
        icon: item.coverage === "none" ? "alert" : item.coverage === "covered" ? "check" : "file",
        active: item.id === selected?.id,
        onSelect: () => setSelectedId(item.id),
      })),
      properties: selected ? [
        { label: "标识", value: selected.ref, mono: true },
        { label: "状态", value: COVERAGE_LABELS[selected.coverage] },
        { label: "类型", value: KIND_LABELS[selected.kind] },
        { label: "来源", value: selected.source || "未登记" },
        { label: "最近更新", value: `${formatActivityTime(selected.updated_at)} · ${selected.updated_by === "user" ? "人工" : "AI"}` },
      ] : [{ label: "状态", value: "未选择覆盖项" }],
      stats: [
        { label: "全部", value: String(stats.all) },
        { label: "未覆盖", value: String(stats.none) },
        { label: "已豁免", value: String(stats.exempt) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, visible, selected, stats, requirementId, platform, coveragePath, readOnly]);

  const save = async (next: CoverageData) => {
    setSaveState("保存中…");
    try {
      await api.saveJsonFileIfUnchanged(coveragePath, baseData.current, next);
      baseData.current = next;
      setDirty(false);
      setSaveState(`已保存 ${formatActivityTime(new Date())}`);
      return true;
    } catch (reason) {
      setSaveState(`保存失败：${String(reason)}`);
      return false;
    }
  };

  useDraftSave(async () => exemptDraft !== null ? false : data ? Boolean(await save(data)) : false);

  const setExempt = (item: CoverageItem, reason: string) => {
    if (!data || readOnly) return;
    const now = new Date().toISOString();
    const next: CoverageData = {
      ...data,
      items: data.items.map((entry) => entry.id === item.id ? {
        ...entry,
        coverage: "exempt",
        exempt_reason: reason.trim() || "人工确认无需黑盒用例覆盖",
        exempt_by: "user",
        updated_at: now,
        updated_by: "user",
      } : entry),
    };
    setData(next);
    setDirty(true);
    setExemptDraft(null);
    void save(next);
    recordActivity(rootPath, platform.path, requirementId, {
      action: "coverage_exempt",
      summary: `豁免覆盖项 ${item.ref}：${reason.trim() || "无需黑盒用例覆盖"}`,
      refs: [toWorkspaceRelative(rootPath, coveragePath)],
    });
  };

  const clearExempt = (item: CoverageItem) => {
    if (!data || readOnly) return;
    const now = new Date().toISOString();
    const next: CoverageData = {
      ...data,
      items: data.items.map((entry) => entry.id === item.id ? {
        ...entry,
        coverage: "none",
        exempt_reason: null,
        exempt_by: null,
        updated_at: now,
        updated_by: "user",
      } : entry),
    };
    setData(next);
    setDirty(true);
    void save(next);
    recordActivity(rootPath, platform.path, requirementId, {
      action: "coverage_unexempt",
      summary: `取消豁免 ${item.ref}`,
      refs: [toWorkspaceRelative(rootPath, coveragePath)],
    });
  };

  if (exists === false) {
    return (
      <div className="workspace-view coverage-view">
        <div className="document-toolbar"><div className="document-toolbar-title"><span className="document-icon blue"><AppIcon name="checks" size={16} /></span><div><strong>覆盖追溯</strong><small>{platform.name} · {requirementId}</small></div></div></div>
        <div className="center-state"><AppIcon name="checks" size={24} /><strong>还没有覆盖追溯数据</strong><span>在 AI 会话中让它「梳理需求文档/接口文档的覆盖项并核对用例」，AI 会通过 update_coverage 生成 03-测试计划/coverage.json，之后在这里逐条确认豁免。</span></div>
      </div>
    );
  }

  return (
    <div className="workspace-view coverage-view">
      <div className="document-toolbar"><div className="document-toolbar-title"><span className="document-icon blue"><AppIcon name="checks" size={16} /></span><div><strong>覆盖追溯</strong><small>{platform.name} · {requirementId}</small></div><span className={`document-readonly ${readOnly ? "locked" : ""}`}>{readOnly ? "锁定只读" : "可编辑"}</span></div><div className="document-toolbar-actions"><span className="save-state">{saveState}</span></div></div>
      <div className="questions-summary"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部 <b>{stats.all}</b></button><button className={filter === "none" ? "selected danger" : ""} onClick={() => setFilter("none")}>未覆盖 <b>{stats.none}</b></button><button className={filter === "partial" ? "selected warning" : ""} onClick={() => setFilter("partial")}>部分覆盖 <b>{stats.partial}</b></button><button className={filter === "covered" ? "selected success" : ""} onClick={() => setFilter("covered")}>已覆盖 <b>{stats.covered}</b></button><button className={filter === "exempt" ? "selected" : ""} onClick={() => setFilter("exempt")}>已豁免 <b>{stats.exempt}</b></button></div>
      <div className="questions-body">
        <aside className="question-list-panel">
          {exists === null ? <div className="panel-placeholder"><span className="spinner" />加载中…</div> : visible.length ? visible.map((item) => <button key={item.id} className={`question-list-row coverage-row ${selected?.id === item.id ? "active" : ""}`} onClick={() => setSelectedId(item.id)}><span className={`status-pill coverage-${item.coverage}`}>{COVERAGE_LABELS[item.coverage]}</span><span className="question-list-text"><strong>{item.title}</strong><small>{item.ref} · {KIND_LABELS[item.kind]}</small></span><AppIcon name="next" size={14} /></button>) : <div className="panel-placeholder"><AppIcon name="inbox" size={20} /><span>{items.length ? "当前筛选无结果" : "暂无覆盖项"}</span><small>AI 通过 update_coverage 登记的覆盖项会显示在这里</small></div>}
        </aside>
        <section className="question-editor-panel">
          {selected ? (
            <div className="question-editor coverage-detail">
              <div className="question-editor-header"><div><div className="question-identifiers"><span className={`status-pill coverage-${selected.coverage}`}>{COVERAGE_LABELS[selected.coverage]}</span><span className="muted-label mono">{selected.ref}</span><span className="muted-label">{KIND_LABELS[selected.kind]}</span></div><h2>{selected.title}</h2></div></div>
              <div className="question-context-grid">
                <ContextItem label="来源" value={selected.source || "未登记"} />
                <ContextItem label="更新" value={`${formatActivityTime(selected.updated_at)} · ${selected.updated_by === "user" ? "人工" : "AI"}`} />
                <ContextItem label="关联用例" value={selected.cases.length ? `${selected.cases.length} 条` : "无"} />
                <ContextItem label="编号" value={selected.id} />
              </div>
              {selected.cases.length > 0 && <div className="coverage-cases"><div className="answer-label"><AppIcon name="checks" size={15} /> 对应用例</div><ul>{selected.cases.map((title, index) => <li key={index}>{title}</li>)}</ul></div>}
              {selected.note && <div className="coverage-note"><div className="answer-label"><AppIcon name="file" size={15} /> 备注</div><p>{selected.note}</p></div>}
              {selected.coverage === "exempt" ? (
                <div className="coverage-exempt-box">
                  <div><AppIcon name="security" size={15} /><strong>已豁免</strong><span>{selected.exempt_reason || "人工确认无需黑盒用例覆盖"}{selected.exempt_by ? ` · ${selected.exempt_by === "user" ? "人工" : selected.exempt_by}` : ""}</span></div>
                  {!readOnly && <button className="button button-ghost button-small" onClick={() => clearExempt(selected)}>取消豁免</button>}
                </div>
              ) : !readOnly && (
                <div className="coverage-exempt-box muted">
                  {exemptDraft === selected.id ? (
                    <div className="coverage-exempt-form">
                      <input autoFocus placeholder="豁免原因，例如：后端内部接口，页面不可见（可选）" onKeyDown={(event) => { if (event.key === "Enter") setExempt(selected, (event.target as HTMLInputElement).value); if (event.key === "Escape") setExemptDraft(null); }} />
                      <button className="button button-primary button-small" onClick={(event) => { const input = (event.currentTarget.parentElement?.querySelector("input") as HTMLInputElement | null); setExempt(selected, input?.value || ""); }}>确认豁免</button>
                      <button className="button button-ghost button-small" onClick={() => setExemptDraft(null)}>取消</button>
                    </div>
                  ) : (
                    <div><span>该覆盖项不需要黑盒用例？</span><button className="button button-ghost button-small" onClick={() => setExemptDraft(selected.id)}>标记为豁免</button></div>
                  )}
                </div>
              )}
            </div>
          ) : <div className="center-state"><AppIcon name="checks" size={24} /><strong>选择一个覆盖项</strong><span>AI 登记的覆盖项在左侧；豁免只能由人确认，AI 无法设置。</span></div>}
        </section>
      </div>
      <div className="document-footer"><span className="mono" title={coveragePath}>{coveragePath}</span><span>{items.length} 个覆盖项</span></div>
    </div>
  );
}

function ContextItem({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
