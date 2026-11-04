import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppIcon from "../components/AppIcon";
import { api } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import { recordActivity } from "../lib/requirementFlow";
import { formatActivityTime, formatDateTime } from "../lib/date";
import {
  KNOWLEDGE_EVIDENCE_OPTIONS,
  KNOWLEDGE_SCOPE_OPTIONS,
  KNOWLEDGE_STATUS_OPTIONS,
  KNOWLEDGE_TYPE_OPTIONS,
  candidateRegistryPath,
  discoverKnowledgeCandidates,
  emptyKnowledgeCandidateRegistry,
  emptyKnowledgeRegistry,
  knowledgeEvidenceLabel,
  knowledgeRegistryPath,
  knowledgeScopeLabel,
  knowledgeStatusLabel,
  knowledgeTypeLabel,
  normalizeKnowledgeCandidateRegistry,
  normalizeKnowledgeItem,
  normalizeKnowledgeRegistry,
  resolveWorkspacePath,
  sourceKindLabel,
  sourceRefKey,
  withKnowledgeHistory,
  workspaceRelativePath,
} from "../lib/knowledge";
import type {
  KnowledgeItem,
  KnowledgeRecord,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
  KnowledgeEvidenceStatus,
  PlatformInfo,
  RequirementMeta,
  WorkspaceConfig,
} from "../lib/types";

interface KnowledgeViewProps {
  workspace: WorkspaceConfig;
  initialPlatformId?: string;
  initialRequirementId?: string;
  initialScope?: string;
  /** 全局搜索深链：选中指定知识条目ID */
  initialKnowledgeId?: string;
  /** 每次定位请求递增的标识，用于同一Tab内重复应用筛选 */
  focusKey?: number;
  onRightContext?: import("../lib/workbench").RightContextReporter;
}

type FilterValue = "all" | string;

type KnowledgeEditDraft = {
  title: string;
  body: string;
  scope: KnowledgeScope;
  platformId: string;
  knowledgeType: KnowledgeType;
  evidenceStatus: KnowledgeEvidenceStatus;
  applicableVersion: string;
  effectiveAt: string;
  expiresAt: string;
  tags: string;
};

interface RequirementOption {
  platform: PlatformInfo;
  requirement: RequirementMeta;
}

export default function KnowledgeView({ workspace, initialPlatformId, initialRequirementId, initialScope, initialKnowledgeId, focusKey, onRightContext }: KnowledgeViewProps) {
  const rootPath = workspace.workspace.root_path;
  const initialPlatform = initialPlatformId && workspace.platforms.some((item) => item.id === initialPlatformId) ? initialPlatformId : "all";
  const [records, setRecords] = useState<KnowledgeRecord[]>([]);
  const [requirements, setRequirements] = useState<RequirementOption[]>([]);
  const [platformFilter, setPlatformFilter] = useState<FilterValue>(initialPlatform);
  const [requirementFilter, setRequirementFilter] = useState<FilterValue>(initialRequirementId || "all");
  const [scopeFilter, setScopeFilter] = useState<FilterValue>(initialScope || "all");
  const [statusFilter, setStatusFilter] = useState<FilterValue>("all");
  const [typeFilter, setTypeFilter] = useState<FilterValue>("all");
  const [evidenceFilter, setEvidenceFilter] = useState<FilterValue>("all");
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [editDraft, setEditDraft] = useState<KnowledgeEditDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loadedRequirements: RequirementOption[] = [];
      for (const platform of workspace.platforms) {
        const items = await api.scanRequirements(rootPath, platform.path).catch(() => []);
        items.forEach((requirement) => loadedRequirements.push({ platform, requirement }));
      }
      const loadedRecords = await loadRecords(workspace, loadedRequirements);
      setRequirements(loadedRequirements);
      setRecords(loadedRecords);
      setSelectedId((current) => loadedRecords.some((item) => item.id === current) ? current : loadedRecords[0]?.id || "");
      setEditDraft(null);
    } catch (reason) {
      setError(`读取知识库失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  }, [rootPath, workspace]);

  useEffect(() => { void load(); }, [load]);

  const requirementOptions = useMemo(() => {
    const visible = platformFilter === "all" ? requirements : requirements.filter((item) => item.platform.id === platformFilter);
    return visible.sort((left, right) => left.requirement.requirement.id.localeCompare(right.requirement.requirement.id));
  }, [platformFilter, requirements]);

  useEffect(() => {
    if (requirementFilter !== "all" && !requirementOptions.some((item) => item.requirement.requirement.id === requirementFilter)) {
      setRequirementFilter("all");
    }
  }, [requirementFilter, requirementOptions]);

  // 外部定位请求（左侧知识树节点）：应用携带的 作用域/平台/需求 筛选
  useEffect(() => {
    if (focusKey === undefined) return;
    setPlatformFilter(initialPlatformId || "all");
    setRequirementFilter(initialRequirementId || "all");
    setScopeFilter(initialScope || "all");
  }, [focusKey, initialPlatformId, initialRequirementId, initialScope]);

  const appliedKnowledgeKey = useRef("");
  // 外部定位请求（全局搜索）：记录就绪后清空筛选并选中指定知识条目
  useEffect(() => {
    if (!initialKnowledgeId || !records.length) return;
    const key = `${initialKnowledgeId}#${focusKey ?? "mount"}`;
    if (appliedKnowledgeKey.current === key) return;
    const target = records.find((item) => item.id === initialKnowledgeId);
    if (!target) return;
    appliedKnowledgeKey.current = key;
    setPlatformFilter("all");
    setRequirementFilter("all");
    setScopeFilter("all");
    setStatusFilter("all");
    setTypeFilter("all");
    setEvidenceFilter("all");
    setQuery("");
    setTagFilter("");
    setEditDraft(null);
    setSelectedId(target.id);
  }, [records, initialKnowledgeId, focusKey]);

  const visibleRecords = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    const tag = tagFilter.trim().toLocaleLowerCase();
    return records.filter((record) => {
      if (scopeFilter !== "all" && record.scope !== scopeFilter) return false;
      if (platformFilter !== "all" && record.platform_id !== platformFilter) return false;
      if (requirementFilter !== "all" && record.requirement_id !== requirementFilter) return false;
      if (statusFilter !== "all" && record.status !== statusFilter) return false;
      if (typeFilter !== "all" && record.knowledge_type !== typeFilter) return false;
      if (evidenceFilter !== "all" && record.evidence_status !== evidenceFilter) return false;
      if (tag && !record.tags.some((item) => item.toLocaleLowerCase().includes(tag))) return false;
      if (keyword) {
        const searchable = [record.title, record.body, record.tags.join(" "), ...record.source_refs.map((source) => `${source.label} ${source.path} ${source.locator}`)].join(" ").toLocaleLowerCase();
        if (!searchable.includes(keyword)) return false;
      }
      return true;
    });
  }, [evidenceFilter, platformFilter, query, records, requirementFilter, scopeFilter, statusFilter, tagFilter, typeFilter]);

  const selected = records.find((item) => item.id === selectedId) || visibleRecords[0] || null;
  const selectedPlatform = selected?.platform_id ? workspace.platforms.find((item) => item.id === selected.platform_id) : undefined;
  const canMutateCandidate = Boolean(selected && selected.record_kind === "candidate" && !selected.requirement_locked);
  const canEditSelected = Boolean(selected && (selected.record_kind === "published" || canMutateCandidate));
  const stats = useMemo(() => ({
    candidate: records.filter((item) => item.status === "candidate").length,
    published: records.filter((item) => item.status === "published").length,
    rejected: records.filter((item) => item.status === "rejected").length,
    deprecated: records.filter((item) => item.status === "deprecated").length,
  }), [records]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  // BB-16D：上报知识条目大纲与当前条目属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "knowledge",
      objectId: selected?.id || undefined,
      title: selected ? selected.title : "知识库",
      subtitle: `${platformFilter === "all" ? "全部平台" : platformFilter} · ${scopeFilter === "all" ? "全部作用域" : knowledgeScopeLabel(scopeFilter)}`,
      platformId: platformFilter === "all" ? undefined : platformFilter,
      requirementId: requirementFilter === "all" ? undefined : requirementFilter,
      outlineTitle: "知识条目",
      outline: visibleRecords.slice(0, 40).map((record) => ({
        id: record.id,
        label: record.title,
        badge: record.status === "candidate" ? "候选" : undefined,
        icon: "database",
        active: record.id === selected?.id,
        onSelect: () => setSelectedId(record.id),
      })),
      properties: selected ? [
        { label: "条目ID", value: selected.id, mono: true },
        { label: "作用域", value: knowledgeScopeLabel(selected.scope) },
        { label: "所属平台", value: selectedPlatform?.name || "通用" },
        { label: "知识类型", value: knowledgeTypeLabel(selected.knowledge_type) },
        { label: "证据状态", value: knowledgeEvidenceLabel(selected.evidence_status) },
        { label: "状态", value: knowledgeStatusLabel(selected.status) },
        { label: "版本", value: `v${selected.version}` },
        { label: "来源数", value: String(selected.source_refs.length) },
      ] : [{ label: "状态", value: "未选择条目" }],
      stats: [
        { label: "候选", value: String(stats.candidate) },
        { label: "已发布", value: String(stats.published) },
        { label: "当前筛选", value: String(visibleRecords.length) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, selected, visibleRecords, stats, platformFilter, requirementFilter, scopeFilter, selectedPlatform]);

  const discover = async () => {
    setDiscovering(true);
    setMessage(null);
    setError(null);
    try {
      const result = await discoverKnowledgeCandidates(workspace, platformFilter, requirementFilter);
      const added = await persistDiscoveredCandidates(workspace, result.candidates, records);
      await load();
      setMessage(added ? `已从来源发现 ${added} 条新候选，跳过 ${result.candidates.length - added} 条重复来源` : "未发现新的知识候选；已有来源未重复创建");
    } catch (reason) {
      setError(`发现知识候选失败：${String(reason)}`);
    } finally {
      setDiscovering(false);
    }
  };

  const startEdit = () => {
    if (!selected || !canEditSelected) return;
    setEditDraft({
      title: selected.title,
      body: selected.body,
      scope: selected.scope,
      platformId: selected.platform_id || selectedPlatform?.id || workspace.platforms[0]?.id || "",
      knowledgeType: selected.knowledge_type,
      evidenceStatus: selected.evidence_status,
      applicableVersion: selected.applicable_version,
      effectiveAt: selected.effective_at || "",
      expiresAt: selected.expires_at || "",
      tags: selected.tags.join(", "),
    });
    setMessage(null);
    setError(null);
  };

  const saveEdit = async () => {
    if (!selected || !editDraft || !canEditSelected) return;
    const title = editDraft.title.trim();
    const body = editDraft.body.trim();
    if (!title || !body) {
      setError("知识标题和正文不能为空");
      return;
    }
    const platformId = editDraft.scope === "general" ? null : editDraft.platformId || selected.platform_id;
    if (editDraft.scope === "platform" && !workspace.platforms.some((item) => item.id === platformId)) {
      setError("平台作用域必须选择已注册平台");
      return;
    }
    const next = withKnowledgeHistory(selected, {
      title,
      body,
      scope: editDraft.scope,
      platform_id: platformId,
      knowledge_type: editDraft.knowledgeType,
      evidence_status: editDraft.evidenceStatus,
      applicable_version: editDraft.applicableVersion.trim(),
      effective_at: editDraft.effectiveAt || null,
      expires_at: editDraft.expiresAt || null,
      tags: splitTags(editDraft.tags),
      review_note: "",
    }, "edit", "用户编辑候选知识");
    if (selected.record_kind === "candidate") await persistCandidate(next, selected.storage_path);
    else await persistPublished(next, selected.storage_path);
    setEditDraft(null);
    await load();
    setSelectedId(next.id);
    setMessage(selected.record_kind === "candidate" ? "候选知识已保存，仍需审核后发布" : "正式知识已保存，并保留了修改历史");
  };

  const reject = async () => {
    if (!selected || !canMutateCandidate) return;
    const note = window.prompt("请输入拒绝原因（可选）", selected.review_note || "") ?? "";
    const next = withKnowledgeHistory(selected, { status: "rejected", review_note: note.trim() }, "reject", note.trim() || "用户拒绝候选知识");
    await persistCandidate(next, selected.storage_path);
    await load();
    setSelectedId(next.id);
    setMessage("候选知识已拒绝，未写入正式知识库");
  };

  const restoreCandidate = async () => {
    if (!selected || selected.record_kind !== "candidate" || selected.requirement_locked || selected.status !== "rejected") return;
    const next = withKnowledgeHistory(selected, { status: "candidate", review_note: "" }, "restore", "重新进入候选审核");
    await persistCandidate(next, selected.storage_path);
    await load();
    setSelectedId(next.id);
    setMessage("候选知识已恢复为待审核状态");
  };

  const publish = async () => {
    if (!selected || selected.record_kind !== "candidate" || !canMutateCandidate) return;
    if (selected.scope === "requirement") {
      setError("具体需求作用域不能直接进入正式知识库，请先编辑为通用或客户平台作用域");
      return;
    }
    const targetPath = knowledgeRegistryPath(rootPath, workspace, selected.scope, selected.platform_id || undefined);
    const registry = await readPublishedRegistry(workspace, selected.scope, selected.platform_id);
    const now = new Date().toISOString();
    const existing = registry.items.find((item) => item.id === selected.id);
    const publishedCandidate = withKnowledgeHistory(selected, {
      status: "published",
      published_at: now,
      published_path: workspaceRelativePath(rootPath, targetPath),
      review_note: "",
    }, "publish", `发布到${workspaceRelativePath(rootPath, targetPath)}`);
    const published = existing
      ? {
        ...publishedCandidate,
        version: Math.max(existing.version + 1, publishedCandidate.version),
        history: [...existing.history, ...publishedCandidate.history],
      }
      : publishedCandidate;
    const nextRegistry = {
      ...registry,
      updated_at: now,
      items: [...registry.items.filter((item) => item.id !== selected.id), published],
    };
    setSaving(true);
    setError(null);
    try {
      await api.saveJsonFile(targetPath, nextRegistry);
      await persistCandidate(publishedCandidate, selected.storage_path);
      // BB-16E：候補の採用元需求の活动台账に発行を記録
      if (selected.requirement_id) {
        const sourcePlatform = workspace.platforms.find((item) => item.id === selected.platform_id)
          || requirements.find((item) => item.requirement.requirement.id === selected.requirement_id)?.platform;
        if (sourcePlatform) {
          recordActivity(rootPath, sourcePlatform.path, selected.requirement_id, {
            action: "knowledge_published",
            summary: `知识候选「${selected.title}」を ${workspaceRelativePath(rootPath, targetPath)} へ発行`,
            object_id: selected.id,
            refs: [workspaceRelativePath(rootPath, targetPath)],
          });
        }
      }
      await load();
      setSelectedId(published.id);
      setMessage(`知识已发布到 ${workspaceRelativePath(rootPath, targetPath)}`);
    } catch (reason) {
      setError(`发布知识失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  const deprecate = async () => {
    if (!selected || selected.status === "deprecated") return;
    const note = window.prompt("请输入废弃原因（可选）", selected.review_note || "") ?? "";
    const next = withKnowledgeHistory(selected, { status: "deprecated", review_note: note.trim() }, "deprecate", note.trim() || "用户废弃知识");
    setSaving(true);
    try {
      if (selected.record_kind === "candidate") {
        if (!canMutateCandidate) return;
        await persistCandidate(next, selected.storage_path);
      } else {
        await persistPublished(next, selected.storage_path);
      }
      await load();
      setSelectedId(next.id);
      setMessage("知识已标记为废弃，历史版本仍保留");
    } catch (reason) {
      setError(`废弃知识失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  const openSource = async (path: string) => {
    await systemOpen.openFile(resolveWorkspacePath(rootPath, path));
  };

  return (
    <div className="workspace-view knowledge-view">
      <section className="document-header knowledge-header">
        <div className="document-title-row"><span className="document-icon blue"><AppIcon name="database" size={20} /></span><div><div className="eyebrow">工作区 / 知识沉淀</div><h1>知识库</h1><p>候选知识必须经过人工审核，发布后才进入通用或客户平台知识目录</p></div></div>
        <div className="header-actions"><button className="button button-ghost" type="button" onClick={() => void load()} disabled={loading}><AppIcon name="refresh" size={15} /> 刷新</button><button className="button button-primary" type="button" onClick={() => void discover()} disabled={discovering || loading}><AppIcon name="search" size={15} /> {discovering ? "发现中…" : "发现候选"}</button></div>
      </section>

      <section className="metric-grid compact-metrics knowledge-metrics"><Metric icon="inbox" label="待审核候选" value={stats.candidate} tone="amber" /><Metric icon="success" label="已发布" value={stats.published} tone="blue" /><Metric icon="error" label="已拒绝" value={stats.rejected} tone="red" /><Metric icon="archive" label="已废弃" value={stats.deprecated} tone="neutral" /></section>

      <section className="panel-section knowledge-filter-panel">
        <div className="section-heading"><div><AppIcon name="search" size={16} /><h2>检索与筛选</h2></div><span className="section-muted">当前显示 {visibleRecords.length} / {records.length} 条</span></div>
        <div className="knowledge-filter-grid">
          <label className="field-label">关键词<input className="field-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题、正文、来源或标签" /></label>
          <label className="field-label">作用域<select className="field-input" value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)}><option value="all">全部作用域</option>{KNOWLEDGE_SCOPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="field-label">平台<select className="field-input" value={platformFilter} onChange={(event) => { setPlatformFilter(event.target.value); setRequirementFilter("all"); }}><option value="all">全部平台</option>{workspace.platforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}（{platform.id}）</option>)}</select></label>
          <label className="field-label">需求<select className="field-input" value={requirementFilter} onChange={(event) => setRequirementFilter(event.target.value)}><option value="all">全部需求</option>{requirementOptions.map((item) => <option key={`${item.platform.id}-${item.requirement.requirement.id}`} value={item.requirement.requirement.id}>{item.requirement.requirement.id} · {item.requirement.requirement.name}</option>)}</select></label>
          <label className="field-label">知识类型<select className="field-input" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">全部类型</option>{KNOWLEDGE_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="field-label">证据状态<select className="field-input" value={evidenceFilter} onChange={(event) => setEvidenceFilter(event.target.value)}><option value="all">全部状态</option>{KNOWLEDGE_EVIDENCE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="field-label">审核状态<select className="field-input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option>{KNOWLEDGE_STATUS_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="field-label knowledge-tag-filter">标签<input className="field-input" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} placeholder="例如：工单、接口" /></label>
        </div>
      </section>

      <div className="knowledge-layout">
        <aside className="panel-section knowledge-list-panel">
          <div className="section-heading"><div><AppIcon name="list" size={16} /><h2>知识条目</h2></div><span className="section-muted">{visibleRecords.length}</span></div>
          {loading ? <div className="panel-placeholder"><span className="spinner" />读取知识文件…</div> : visibleRecords.length ? <div className="knowledge-list">{visibleRecords.map((record) => <button type="button" key={`${record.record_kind}-${record.id}`} className={`knowledge-list-row ${selected?.id === record.id ? "active" : ""}`} onClick={() => { setSelectedId(record.id); setEditDraft(null); }}><span className={`knowledge-list-icon ${record.record_kind}`}><AppIcon name={record.record_kind === "candidate" ? "inbox" : "database"} size={15} /></span><span className="knowledge-list-main"><strong>{record.title}</strong><small>{knowledgeTypeLabel(record.knowledge_type)} · {knowledgeScopeLabel(record.scope, workspace.platforms)}</small><small>{record.requirement_id || "工作区知识"} · V{record.version}</small></span><span className={`status-pill ${statusClass(record.status)}`}>{knowledgeStatusLabel(record.status)}</span></button>)}</div> : <div className="inline-empty large"><AppIcon name="inbox" size={18} />没有匹配的知识条目</div>}
        </aside>

        <main className="panel-section knowledge-detail-panel">
          {selected ? <KnowledgeDetail item={selected} platforms={workspace.platforms} editDraft={editDraft} saving={saving} canEdit={canEditSelected} onStartEdit={startEdit} onDraftChange={setEditDraft} onSaveEdit={() => void saveEdit()} onCancelEdit={() => setEditDraft(null)} onPublish={() => void publish()} onReject={() => void reject()} onRestore={() => void restoreCandidate()} onDeprecate={() => void deprecate()} onOpenSource={(path) => void openSource(path)} /> : <div className="inline-empty large"><AppIcon name="database" size={18} />选择知识条目查看内容、来源和审核历史</div>}
        </main>
      </div>
      {message && <div className="toast toast-success"><AppIcon name="check" size={15} /> {message}<button type="button" onClick={() => setMessage(null)}><AppIcon name="close" size={14} /></button></div>}
      {error && <div className="toast toast-error"><AppIcon name="alert" size={15} /> {error}<button type="button" onClick={() => setError(null)}><AppIcon name="close" size={14} /></button></div>}
    </div>
  );
}

function KnowledgeDetail({ item, platforms, editDraft, saving, canEdit, onStartEdit, onDraftChange, onSaveEdit, onCancelEdit, onPublish, onReject, onRestore, onDeprecate, onOpenSource }: {
  item: KnowledgeRecord;
  platforms: PlatformInfo[];
  editDraft: KnowledgeEditDraft | null;
  saving: boolean;
  canEdit: boolean;
  onStartEdit: () => void;
  onDraftChange: React.Dispatch<React.SetStateAction<KnowledgeEditDraft | null>>;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onPublish: () => void;
  onReject: () => void;
  onRestore: () => void;
  onDeprecate: () => void;
  onOpenSource: (path: string) => void;
}) {
  const editing = Boolean(editDraft);
  return <div className="knowledge-detail-content">
    <div className="knowledge-detail-heading"><div><div className="knowledge-identifiers"><span className={`status-pill ${statusClass(item.status)}`}>{knowledgeStatusLabel(item.status)}</span><span className="status-pill">{item.record_kind === "candidate" ? "候选文件" : "正式知识"}</span><span className="status-pill">V{item.version}</span></div><h2>{item.title}</h2><p>{knowledgeTypeLabel(item.knowledge_type)} · {knowledgeScopeLabel(item.scope, platforms)} · 更新于 {formatDateTime(item.updated_at)}</p></div><div className="knowledge-action-buttons">{canEdit && !editing && <button className="button button-ghost button-small" type="button" onClick={onStartEdit}><AppIcon name="edit" size={14} /> 编辑</button>}{editing && <><button className="button button-primary button-small" type="button" disabled={saving} onClick={onSaveEdit}><AppIcon name="save" size={14} /> {item.record_kind === "candidate" ? "保存候选" : "保存知识"}</button><button className="button button-ghost button-small" type="button" disabled={saving} onClick={onCancelEdit}>取消</button></>}{item.record_kind === "candidate" && item.status === "candidate" && !editing && <><button className="button button-primary button-small" type="button" disabled={saving || !canEdit} onClick={onPublish}><AppIcon name="check" size={14} /> 发布</button><button className="button button-danger button-small" type="button" disabled={saving || !canEdit} onClick={onReject}><AppIcon name="error" size={14} /> 拒绝</button></>}{item.record_kind === "candidate" && item.status === "rejected" && !editing && <button className="button button-ghost button-small" type="button" disabled={saving || !canEdit} onClick={onRestore}><AppIcon name="refresh" size={14} /> 恢复候选</button>}{item.status !== "deprecated" && !editing && <button className="button button-danger button-small" type="button" disabled={saving || (item.record_kind === "candidate" && !canEdit)} onClick={onDeprecate}><AppIcon name="archive" size={14} /> 废弃</button>}</div></div>
    {item.record_kind === "candidate" && item.requirement_locked && <div className="unlock-warning"><AppIcon name="lock" size={14} /><span>来源需求目录当前锁定，候选只读；完成 AI 交接解锁后才能审核。</span></div>}
    {editing && editDraft ? <KnowledgeEditor draft={editDraft} platforms={platforms} allowScopeChange={item.record_kind === "candidate"} onChange={onDraftChange} /> : <KnowledgeReadOnly item={item} platforms={platforms} onOpenSource={onOpenSource} />}
  </div>;
}

function KnowledgeReadOnly({ item, platforms, onOpenSource }: { item: KnowledgeRecord; platforms: PlatformInfo[]; onOpenSource: (path: string) => void }) {
  return <>
    <div className="knowledge-context-grid"><ContextItem label="作用域" value={knowledgeScopeLabel(item.scope, platforms)} /><ContextItem label="证据状态" value={knowledgeEvidenceLabel(item.evidence_status)} /><ContextItem label="适用版本" value={item.applicable_version || "未限定"} /><ContextItem label="标签" value={item.tags.join("、") || "无"} /><ContextItem label="生效时间" value={item.effective_at || "未设置"} /><ContextItem label="失效时间" value={item.expires_at || "未设置"} /></div>
    <section className="knowledge-body-section"><div className="knowledge-section-title"><AppIcon name="file" size={15} /><strong>知识正文</strong></div><pre className="knowledge-body">{item.body || "暂无正文"}</pre></section>
    <section className="knowledge-source-section"><div className="knowledge-section-title"><AppIcon name="link" size={15} /><strong>来源引用</strong><span>{item.source_refs.length}</span></div>{item.source_refs.length ? <div className="knowledge-source-list">{item.source_refs.map((source, index) => <div className="knowledge-source-row" key={`${source.path}-${source.locator}-${index}`}><span className="knowledge-source-icon"><AppIcon name="file" size={14} /></span><span className="knowledge-source-main"><strong>{source.label || sourceKindLabel(source.kind)}</strong><small>{source.path}{source.locator ? ` · ${source.locator}` : ""}</small></span><button className="text-button" type="button" onClick={() => onOpenSource(source.path)}>打开来源 <AppIcon name="external" size={13} /></button></div>)}</div> : <div className="inline-empty">该候选没有记录来源引用，建议拒绝并补充可追溯来源。</div>}</section>
    {item.review_note && <div className="knowledge-review-note"><AppIcon name="info" size={14} /><span>审核备注：{item.review_note}</span></div>}
    <section className="knowledge-history-section"><div className="knowledge-section-title"><AppIcon name="history" size={15} /><strong>版本历史</strong><span>{item.history.length}</span></div>{item.history.length ? <div className="knowledge-history-list">{item.history.slice().reverse().map((entry, index) => <div className="knowledge-history-row" key={`${entry.changed_at}-${entry.version}-${index}`}><div><strong>V{entry.version} · {entry.action}</strong><small>{formatDateTime(entry.changed_at)} · {entry.changed_by}</small></div><span>{entry.note || "未填写说明"}</span></div>)}</div> : <div className="inline-empty">暂无历史版本；首次发布会建立版本记录。</div>}</section>
    <div className="knowledge-detail-footer"><span className="mono">{item.id}</span><span>创建于 {formatActivityTime(item.created_at)} · {item.created_by}</span></div>
  </>;
}

function KnowledgeEditor({ draft, platforms, allowScopeChange, onChange }: { draft: KnowledgeEditDraft; platforms: PlatformInfo[]; allowScopeChange: boolean; onChange: React.Dispatch<React.SetStateAction<KnowledgeEditDraft | null>> }) {
  const update = (patch: Partial<KnowledgeEditDraft>) => onChange((current) => current ? { ...current, ...patch } : current);
  return <div className="knowledge-editor">
    <label className="field-label">标题<input className="field-input" value={draft.title} onChange={(event) => update({ title: event.target.value })} /></label>
    <div className="knowledge-editor-grid"><label className="field-label">作用域<select className="field-input" value={draft.scope} disabled={!allowScopeChange} onChange={(event) => update({ scope: event.target.value as KnowledgeScope })}>{KNOWLEDGE_SCOPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field-label">平台<select className="field-input" value={draft.platformId} disabled={!allowScopeChange || draft.scope === "general"} onChange={(event) => update({ platformId: event.target.value })}><option value="">选择平台</option>{platforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}（{platform.id}）</option>)}</select></label><label className="field-label">知识类型<select className="field-input" value={draft.knowledgeType} onChange={(event) => update({ knowledgeType: event.target.value })}>{KNOWLEDGE_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field-label">证据状态<select className="field-input" value={draft.evidenceStatus} onChange={(event) => update({ evidenceStatus: event.target.value })}>{KNOWLEDGE_EVIDENCE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
    <div className="knowledge-editor-grid"><label className="field-label">适用版本<input className="field-input" value={draft.applicableVersion} onChange={(event) => update({ applicableVersion: event.target.value })} placeholder="例如：v3.2.1，留空表示不限定" /></label><label className="field-label">标签<input className="field-input" value={draft.tags} onChange={(event) => update({ tags: event.target.value })} placeholder="用逗号分隔" /></label><label className="field-label">生效时间<input className="field-input" type="date" value={draft.effectiveAt} onChange={(event) => update({ effectiveAt: event.target.value })} /></label><label className="field-label">失效时间<input className="field-input" type="date" value={draft.expiresAt} onChange={(event) => update({ expiresAt: event.target.value })} /></label></div>
    <label className="field-label">正文<textarea className="field-input field-textarea knowledge-body-editor" value={draft.body} onChange={(event) => update({ body: event.target.value })} placeholder="记录可复用的业务规则、现状、接口数据或测试策略" /></label>
  </div>;
}

function Metric({ icon, label, value, tone }: { icon: any; label: string; value: number; tone: string }) {
  return <div className={`metric-card metric-${tone}`}><div className="metric-icon"><AppIcon name={icon} size={17} /></div><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function ContextItem({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function statusClass(status: string): string {
  if (status === "published") return "success";
  if (status === "candidate") return "warning";
  if (status === "rejected") return "danger";
  return "";
}

async function loadRecords(workspace: WorkspaceConfig, requirements: RequirementOption[]): Promise<KnowledgeRecord[]> {
  const rootPath = workspace.workspace.root_path;
  const records: KnowledgeRecord[] = [];
  const generalPath = knowledgeRegistryPath(rootPath, workspace, "general");
  const general = await readPublishedRegistry(workspace, "general", null);
  records.push(...general.items.map((item) => ({ ...item, record_kind: "published" as const, storage_path: generalPath, requirement_locked: false })));
  for (const platform of workspace.platforms) {
    const path = knowledgeRegistryPath(rootPath, workspace, "platform", platform.id);
    const registry = await readPublishedRegistry(workspace, "platform", platform.id);
    records.push(...registry.items.map((item) => ({ ...item, record_kind: "published" as const, storage_path: path, requirement_locked: false })));
  }
  for (const option of requirements) {
    const path = candidateRegistryPath(rootPath, option.platform.path, option.requirement.requirement.id);
    const registry = await readCandidateRegistry(path, option.platform.id, option.requirement.requirement.id);
    records.push(...registry.candidates.filter((item) => item.status !== "published" || !item.published_path).map((item) => ({
      ...item,
      record_kind: "candidate" as const,
      storage_path: path,
      requirement_locked: option.requirement.client_access.mode === "locked_for_ai",
    })));
  }
  return records.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

async function readCandidateRegistry(path: string, platformId: string, requirementId: string) {
  try {
    return normalizeKnowledgeCandidateRegistry(await api.readJsonFile(path), platformId, requirementId);
  } catch {
    return emptyKnowledgeCandidateRegistry(platformId, requirementId);
  }
}

async function readPublishedRegistry(workspace: WorkspaceConfig, scope: "general" | "platform", platformId: string | null) {
  try {
    return normalizeKnowledgeRegistry(await api.readJsonFile(knowledgeRegistryPath(workspace.workspace.root_path, workspace, scope, platformId || undefined)), scope, platformId);
  } catch {
    return emptyKnowledgeRegistry(scope, platformId);
  }
}

async function persistDiscoveredCandidates(workspace: WorkspaceConfig, candidates: KnowledgeItem[], existingRecords: KnowledgeRecord[]): Promise<number> {
  const grouped = new Map<string, { path: string; platformId: string; requirementId: string; candidates: KnowledgeItem[] }>();
  const existingKeys = new Set(existingRecords.map((item) => sourceRefKey(item.source_refs)));
  for (const candidate of candidates) {
    if (existingKeys.has(sourceRefKey(candidate.source_refs))) continue;
    const platform = workspace.platforms.find((item) => item.id === candidate.platform_id);
    if (!platform || !candidate.requirement_id) continue;
    const path = candidateRegistryPath(workspace.workspace.root_path, platform.path, candidate.requirement_id);
    const key = path.replace(/\\/g, "/");
    const group = grouped.get(key) || { path, platformId: platform.id, requirementId: candidate.requirement_id, candidates: [] };
    group.candidates.push(candidate);
    grouped.set(key, group);
    existingKeys.add(sourceRefKey(candidate.source_refs));
  }
  let added = 0;
  for (const group of grouped.values()) {
    const registry = await readCandidateRegistry(group.path, group.platformId, group.requirementId);
    const keys = new Set(registry.candidates.map((item) => sourceRefKey(item.source_refs)));
    const next = group.candidates.filter((item) => !keys.has(sourceRefKey(item.source_refs)));
    if (!next.length) continue;
    await api.saveJsonFile(group.path, { ...registry, updated_at: new Date().toISOString(), candidates: [...registry.candidates, ...next] });
    added += next.length;
  }
  return added;
}

async function persistCandidate(item: KnowledgeItem, path: string): Promise<void> {
  const registry = await readCandidateRegistry(path, item.platform_id || "", item.requirement_id || "");
  const candidates = registry.candidates.some((current) => current.id === item.id)
    ? registry.candidates.map((current) => current.id === item.id ? item : current)
    : [...registry.candidates, item];
  await api.saveJsonFile(path, { ...registry, updated_at: new Date().toISOString(), candidates });
}

async function persistPublished(item: KnowledgeItem, path: string): Promise<void> {
  const registry = await readPublishedRegistryForPath(path, item.scope, item.platform_id);
  await api.saveJsonFile(path, { ...registry, updated_at: new Date().toISOString(), items: registry.items.some((current) => current.id === item.id) ? registry.items.map((current) => current.id === item.id ? item : current) : [...registry.items, item] });
}

async function readPublishedRegistryForPath(path: string, scope: KnowledgeScope, platformId: string | null) {
  try {
    return normalizeKnowledgeRegistry(await api.readJsonFile(path), scope === "general" ? "general" : "platform", platformId);
  } catch {
    return emptyKnowledgeRegistry(scope === "general" ? "general" : "platform", platformId);
  }
}

function splitTags(value: string): string[] {
  return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean).filter((item, index, values) => values.indexOf(item) === index);
}
