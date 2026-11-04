import { applyCaseRevision, proposeCaseRevision } from "../lib/caseRevision";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, isTauri, joinPath } from "../lib/api";
import AppIcon from "./AppIcon";
import { recordActivity, toWorkspaceRelative } from "../lib/requirementFlow";
import type { PlatformInfo, RequirementMeta, WorkspaceConfig } from "../lib/types";
import { normalizeCasesDocument } from "../lib/cases";
import {
  buildXMindImportPreview,
  mergeCasesDocument,
  mergeXMindImportData,
  parseXMind,
  sha256Bytes,
  type XMindCaseStep,
  type XMindImportData,
  type XMindImportPreview,
  type XMindImportedCase,
  type XMindDirectoryNode,
} from "../lib/xmindImport";

interface XMindImportModalProps {
  workspace: WorkspaceConfig;
  initialPlatformId?: string;
  initialRequirementId?: string;
  onClose: () => void;
  onImported: (result: { path: string; caseCount: number; versionPath?: string; pendingIds?: string[] }) => void;
}

interface ImportSource {
  name: string;
  path: string;
  bytes: Uint8Array;
}

export default function XMindImportModal({ workspace, initialPlatformId, initialRequirementId, onClose, onImported }: XMindImportModalProps) {
  const rootPath = workspace.workspace.root_path;
  const inputRef = useRef<HTMLInputElement>(null);
  const selectablePlatforms = useMemo(() => workspace.platforms.filter((platform) => platform.status !== "archived"), [workspace.platforms]);
  const firstPlatformId = initialPlatformId && selectablePlatforms.some((platform) => platform.id === initialPlatformId)
    ? initialPlatformId
    : selectablePlatforms[0]?.id || "";
  const [selectedPlatformId, setSelectedPlatformId] = useState(firstPlatformId);
  const [selectedRequirementId, setSelectedRequirementId] = useState(initialRequirementId || "");
  const [requirements, setRequirements] = useState<RequirementMeta[]>([]);
  const [loadingRequirements, setLoadingRequirements] = useState(false);
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [mergedData, setMergedData] = useState<XMindImportData | null>(null);
  const [preview, setPreview] = useState<XMindImportPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingData, setExistingData] = useState<unknown>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const selectedPlatform = workspace.platforms.find((platform) => platform.id === selectedPlatformId);
  const selectedRequirement = requirements.find((item) => item.requirement.id === selectedRequirementId);
  const targetDirectory = selectedPlatform && selectedRequirement
    ? joinPath(rootPath, selectedPlatform.path, selectedRequirement.requirement.id, "04-测试用例")
    : "";
  const targetPath = targetDirectory ? joinPath(targetDirectory, "cases.json") : "";

  useEffect(() => {
    if (!selectedPlatformId || !selectedPlatform) {
      setRequirements([]);
      setSelectedRequirementId("");
      return;
    }
    let cancelled = false;
    setLoadingRequirements(true);
    api.scanRequirements(rootPath, selectedPlatform.path)
      .then((next) => {
        if (cancelled) return;
        setRequirements(next);
        setSelectedRequirementId((current) => next.some((item) => item.requirement.id === current)
          ? current
          : next.some((item) => item.requirement.id === initialRequirementId) ? initialRequirementId || "" : next[0]?.requirement.id || "");
      })
      .catch((reason) => {
        if (!cancelled) {
          setRequirements([]);
          setSelectedRequirementId("");
          setError(String(reason));
        }
      })
      .finally(() => { if (!cancelled) setLoadingRequirements(false); });
    return () => { cancelled = true; };
  }, [initialRequirementId, rootPath, selectedPlatform, selectedPlatformId]);

  const updateTarget = (platformId: string) => {
    setSelectedPlatformId(platformId);
    setSelectedRequirementId("");
    setExistingData(null);
    setConflictOpen(false);
    setMergeOpen(false);
    setError(null);
  };

  const chooseSource = async () => {
    setError(null);
    try {
      if (isTauri) {
        const paths = await api.chooseXMindFiles();
        if (!paths.length) return;
        const added = await Promise.all(paths.map(async (path) => ({
          name: path.split(/[\\/]/).pop() || path,
          path,
          bytes: await api.readBinaryFile(path),
        })));
        await loadSources(added);
        return;
      }
      inputRef.current?.click();
    } catch (reason) {
      setError(`读取XMind失败：${String(reason)}`);
    }
  };

  const rebuildPreview = async (nextSources: ImportSource[]) => {
    if (!nextSources.length) {
      setMergedData(null);
      setPreview(null);
      return;
    }
    setLoadingPreview(true);
    try {
      const documents = await Promise.all(nextSources.map(async (item) => parseXMind(item.bytes, item.path || item.name, await sha256Bytes(item.bytes))));
      const total = nextSources.reduce((size, item) => size + item.bytes.length, 0);
      const combined = new Uint8Array(total);
      let offset = 0;
      nextSources.forEach((item) => { combined.set(item.bytes, offset); offset += item.bytes.length; });
      const fingerprint = await sha256Bytes(combined);
      const label = nextSources.map((item) => item.path || item.name).join("；");
      const data = mergeXMindImportData(documents, label, fingerprint);
      setMergedData(data);
      setPreview(buildXMindImportPreview(data));
    } catch (reason) {
      setPreview(null);
      setMergedData(null);
      setError(`XMind解析失败：${String(reason)}`);
    } finally {
      setLoadingPreview(false);
    }
  };

  const loadSources = async (added: ImportSource[]) => {
    setError(null);
    setExistingData(null);
    setConflictOpen(false);
    setMergeOpen(false);
    const known = new Set(sources.map((item) => item.path || item.name));
    const nextSources = [...sources, ...added.filter((item) => !known.has(item.path || item.name))];
    setSources(nextSources);
    await rebuildPreview(nextSources);
  };

  const removeSource = async (item: ImportSource) => {
    const nextSources = sources.filter((entry) => entry !== item);
    setSources(nextSources);
    setExistingData(null);
    setConflictOpen(false);
    setMergeOpen(false);
    await rebuildPreview(nextSources);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.currentTarget.value = "";
    if (!files.length) return;
    void Promise.all(files.map(async (file) => ({ name: file.name, path: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })))
      .then((added) => loadSources(added))
      .catch((reason) => setError(`读取XMind失败：${String(reason)}`));
  };

  const importedData = () => {
    if (!mergedData || !selectedPlatform || !selectedRequirement || !sources.length) return null;
    return {
      ...mergedData,
      requirement_id: selectedRequirement.requirement.id,
      platform: selectedPlatform.name,
      platform_id: selectedPlatform.id,
      metadata: {
        ...mergedData.metadata,
        source_file: sources.map((item) => item.path || item.name).join("；"),
        created_by: "import" as const,
      },
    };
  };

  const checkExisting = async (): Promise<unknown | null> => {
    if (!targetPath) return null;
    try {
      return await api.readJsonFile(targetPath);
    } catch {
      return null;
    }
  };

  const savePrimary = async () => {
    const data = importedData();
    if (!data || !targetPath || !selectedPlatform || !selectedRequirement) {
      setError("请选择XMind、目标平台和目标需求");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = normalizeCasesDocument(data, selectedRequirement.requirement.id, selectedPlatform.name, selectedPlatform.id);
      const empty = { ...next, cases: [] };
      const proposal = await proposeCaseRevision(empty, next.cases.map((item) => ({ case_id: item.id, before: null, after: item, reason: "", source: "xmind_import", origin: "human" })));
      await applyCaseRevision(joinPath(rootPath, selectedPlatform.path, selectedRequirement.requirement.id), proposal, empty, next.tree, [], undefined, next.metadata);
      recordActivity(workspace.workspace.root_path, selectedPlatform.path, selectedRequirement.requirement.id, {
        action: "cases_imported",
        summary: `导入XMind为cases.json，共 ${data.cases.length} 条用例（来源：${data.metadata.source_file || "未知"}）`,
        refs: [toWorkspaceRelative(workspace.workspace.root_path, targetPath)],
      });
      onImported({ path: targetPath, caseCount: data.cases.length });
    } catch (reason) {
      setError(`保存cases.json失败：${String(reason)}`);
      if (String(reason).includes("存在")) {
        const existing = await checkExisting();
        if (existing !== null) {
          setExistingData(existing);
          setConflictOpen(true);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const importCases = async () => {
    if (!preview || !selectedPlatform || !selectedRequirement) {
      setError("请选择目标平台和需求");
      return;
    }
    if (selectedRequirement.client_access.mode === "locked_for_ai") {
      setError(`需求目录已锁定，不能导入用例（任务：${selectedRequirement.client_access.task_id || "未关联任务"}）`);
      return;
    }
    const existing = await checkExisting();
    if (existing !== null) {
      setExistingData(existing);
      setConflictOpen(true);
      setMergeOpen(false);
      return;
    }
    await savePrimary();
  };

  const saveVersion = async () => {
    const data = importedData();
    if (!data || !selectedPlatform || !selectedRequirement) return;
    setSaving(true);
    setError(null);
    const versionId = `v${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
    const versionDirectory = joinPath(targetDirectory, "versions", versionId);
    const versionCasesPath = joinPath(versionDirectory, "cases.json");
    const manifestPath = joinPath(versionDirectory, "manifest.json");
    const versionData = { ...data, version_id: versionId };
    try {
      await api.createJsonFile(versionCasesPath, versionData);
      await api.createJsonFile(manifestPath, {
        version_id: versionId,
        created_at: new Date().toISOString(),
        created_by: "import",
        source_file: data.metadata.source_file,
        source_fingerprint: data.metadata.source_fingerprint,
        case_count: data.cases.length,
        requirement_id: selectedRequirement.requirement.id,
        platform_id: selectedPlatform.id,
      });
      recordActivity(workspace.workspace.root_path, selectedPlatform.path, selectedRequirement.requirement.id, {
        action: "cases_imported",
        summary: `导入XMind并另存为用例版本 ${versionId}，共 ${data.cases.length} 条用例`,
        object_id: versionId,
        refs: [toWorkspaceRelative(workspace.workspace.root_path, versionCasesPath)],
      });
      onImported({ path: targetPath, versionPath: versionCasesPath, caseCount: data.cases.length });
    } catch (reason) {
      setError(`保存新版本失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  const mergeIntoExisting = async () => {
    const data = importedData();
    if (!data || !targetPath || !selectedPlatform || !selectedRequirement) return;
    setSaving(true);
    setError(null);
    try {
      const existing = normalizeCasesDocument(existingData, selectedRequirement.requirement.id, selectedPlatform.name, selectedPlatform.id);
      const { document: mergedDocument, addedCount, skippedTitles } = mergeCasesDocument(existing, data);
      const additions = mergedDocument.cases.filter((item) => !existing.cases.some((old) => old.id === item.id));
      const proposal = await proposeCaseRevision(existing, additions.map((item) => ({ case_id: item.id, before: null, after: item, reason: "", source: "xmind_import", origin: "human" })));
      await applyCaseRevision(joinPath(rootPath, selectedPlatform.path, selectedRequirement.requirement.id), proposal, existing, mergedDocument.tree, [], undefined, mergedDocument.metadata);
      recordActivity(workspace.workspace.root_path, selectedPlatform.path, selectedRequirement.requirement.id, {
        action: "cases_imported",
        summary: `合并导入XMind到cases.json：新增 ${addedCount} 条用例${skippedTitles.length ? `，已有ID待同步 ${skippedTitles.length} 条` : ""}（合并后共 ${mergedDocument.cases.length} 条，事务日志保留原文件）`,
        refs: [toWorkspaceRelative(workspace.workspace.root_path, targetPath)],
      });
      onImported({ path: targetPath, caseCount: mergedDocument.cases.length, pendingIds: data.cases.filter((item) => existing.cases.some((old) => old.id === item.id)).map((item) => item.id) });
    } catch (reason) {
      setError(`合并导入失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  const mergeInfo = useMemo(() => buildMergeInfo(existingData, mergedData), [existingData, mergedData]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <div className="modal xmind-import-modal">
        <div className="modal-header">
          <div><span className="eyebrow">BB-08 / 结构化用例</span><h2>导入XMind为 cases.json</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={saving} title="关闭"><AppIcon name="close" size={16} /></button>
        </div>
        <p className="modal-description">导入会解析根节点、目录、用例、前置条件、操作步骤和期望结果。确认后写入目标需求的 <span className="mono">04-测试用例/cases.json</span>，已有文件不会被覆盖。</p>

        <input ref={inputRef} type="file" accept=".xmind,application/zip" multiple onChange={handleFileChange} hidden />
        <div className="xmind-import-source">
          <div><AppIcon name="archiveFile" size={17} /><span>{sources.length ? <><strong>{sources.length === 1 ? sources[0].name : `已选择 ${sources.length} 份XMind`}</strong><small>{sources.length > 1 ? sources.map((item) => item.name).join("、") : sources[0].path}</small></> : <><strong>尚未选择XMind文件</strong><small>支持多选，多份会合并成一份 cases.json；文件内需包含 content.json</small></>}</span></div>
          <button className="button button-ghost button-small" type="button" onClick={() => void chooseSource()} disabled={loadingPreview || saving}><AppIcon name="upload" size={14} /> {sources.length ? "继续添加" : "选择XMind"}</button>
        </div>
        {sources.length > 1 && <div className="xmind-import-source-list">{sources.map((item) => <div className="xmind-import-source-row" key={item.path || item.name}><AppIcon name="file" size={13} /><span className="mono">{item.name}</span><button className="icon-button" type="button" title="移除" disabled={saving} onClick={() => void removeSource(item)}><AppIcon name="close" size={12} /></button></div>)}</div>}

        <div className="xmind-import-target">
          <label className="field-label">目标平台
            <select className="field-input" value={selectedPlatformId} onChange={(event) => updateTarget(event.target.value)} disabled={saving || selectablePlatforms.length === 0}>
              <option value="">选择平台</option>
              {selectablePlatforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.name}（{platform.id}）</option>)}
            </select>
          </label>
          <label className="field-label">目标需求
            <select className="field-input" value={selectedRequirementId} onChange={(event) => { setSelectedRequirementId(event.target.value); setExistingData(null); setConflictOpen(false); setMergeOpen(false); }} disabled={saving || loadingRequirements || requirements.length === 0}>
              <option value="">{loadingRequirements ? "正在读取需求…" : "选择需求"}</option>
              {requirements.map((item) => <option key={item.requirement.id} value={item.requirement.id}>{item.requirement.id} · {item.requirement.name}</option>)}
            </select>
          </label>
        </div>
        {targetPath && <div className="field-hint mono xmind-import-target-path">目标：{targetPath}</div>}
        {selectedRequirement?.client_access.mode === "locked_for_ai" && <div className="unlock-warning"><AppIcon name="lock" size={14} /><span>目标需求已锁定，导入写入会被拒绝。</span></div>}

        {loadingPreview && <div className="center-state compact"><span className="spinner" />正在解析XMind并生成预览…</div>}
        {preview && !loadingPreview && <ImportPreview preview={preview} />}
        {!preview && !loadingPreview && <div className="inline-empty large"><AppIcon name="inbox" size={18} />选择XMind后将在这里显示导入预览</div>}

        {conflictOpen && <div className="xmind-import-conflict">
          <div className="section-heading"><div><AppIcon name="alert" size={16} /><h3>目标已有 cases.json</h3></div><span className="status-pill warning">禁止覆盖</span></div>
          <p>当前需求已经存在正式用例数据。可以<strong>合并导入</strong>（目录树按名称合并，新增 {mergeInfo.newCount} 条、已有ID待同步 {mergeInfo.repeatedCount} 条，事务日志保留原文件；已有ID的内容修改请使用“外部 XMind 差异”逐项确认）或<strong>另存为新版本</strong>。</p>
          <div className="modal-actions"><button className="button button-ghost" type="button" onClick={() => { setConflictOpen(false); setMergeOpen(false); }}>取消</button><button className="button button-ghost" type="button" onClick={() => setMergeOpen((current) => !current)}><AppIcon name="split" size={14} /> {mergeOpen ? "收起合并预览" : "合并预览"}</button><button className="button button-ghost" type="button" disabled={saving} onClick={() => void saveVersion()}>另存为新版本</button><button className="button button-primary" type="button" disabled={saving || !mergeInfo.newCount} onClick={() => void mergeIntoExisting()}>{saving ? "合并中…" : `合并导入（新增 ${mergeInfo.newCount} 条）`}</button></div>
          {mergeOpen && <MergePreview info={mergeInfo} />}
        </div>}

        {error && <div className="modal-error"><AppIcon name="error" size={15} /><span>{error}</span></div>}
        <div className="modal-actions"><span className="modal-action-spacer" /><button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>关闭</button><button className="button button-primary" type="button" onClick={() => void importCases()} disabled={saving || loadingPreview || !preview || !selectedRequirement}>{saving ? "保存中…" : "确认导入"}</button></div>
      </div>
    </div>
  );
}

function ImportPreview({ preview }: { preview: XMindImportPreview }) {
  return <section className="xmind-import-preview">
    <div className="xmind-import-summary">
      <SummaryCard label="根节点" value={preview.rootTitle || "未命名"} />
      <SummaryCard label="目录" value={`${preview.directoryCount}`} />
      <SummaryCard label="用例总数" value={`${preview.totalCount}`} />
      <SummaryCard label="优先级" value={`P0 ${preview.priorityCounts.P0} · P1 ${preview.priorityCounts.P1} · P2 ${preview.priorityCounts.P2}`} />
    </div>
    <div className="xmind-import-preview-grid">
      <div className="xmind-import-tree panel-subsection"><div className="subsection-title"><AppIcon name="folder" size={14} />目录树</div><DirectoryTree node={preview.data.tree} cases={preview.data.cases} /></div>
      <div className="xmind-import-checks panel-subsection"><div className="subsection-title"><AppIcon name="review" size={14} />导入检查</div><CheckRow label="缺失前置" value={preview.missing.preconditions} /><CheckRow label="缺失步骤" value={preview.missing.steps} /><CheckRow label="缺失期望" value={preview.missing.expected} /><CheckRow label="疑似已有ID" value={preview.duplicateTitles.length} danger={preview.duplicateTitles.length > 0} /><div className="subsection-title distribution-title"><AppIcon name="list" size={14} />测试类型分布</div>{preview.typeCounts.length ? preview.typeCounts.map((item) => <div className="xmind-import-distribution" key={item.label}><span>{item.label}</span><strong>{item.count}</strong></div>) : <span className="field-hint">没有识别到测试用例</span>}</div>
    </div>
    {preview.duplicateTitles.length > 0 && <div className="xmind-import-duplicates"><strong>已有ID提示</strong>{preview.duplicateTitles.slice(0, 8).map((group, index) => <span key={`${index}-${group.join("-")}`}>{group.join(" / ")}</span>)}</div>}
  </section>;
}

function DirectoryTree({ node, cases, depth = 0 }: { node: XMindDirectoryNode; cases: XMindImportedCase[]; depth?: number }) {
  const descendantIds = new Set([node.id, ...node.children.flatMap((child) => collectDirectoryIds(child))]);
  const count = cases.filter((item) => descendantIds.has(item.directory_id)).length;
  return <div className="xmind-directory-node"><div className="xmind-directory-row" style={{ paddingLeft: 8 + depth * 14 }}><AppIcon name={node.node_type === "workbook" || depth === 0 ? "archiveFile" : "folder"} size={13} /><span title={node.title}>{node.title || "未命名目录"}</span><b>{count}</b></div>{node.children.map((child) => <DirectoryTree key={`${child.id}-${depth}`} node={child} cases={cases} depth={depth + 1} />)}</div>;
}

function collectDirectoryIds(node: XMindDirectoryNode): string[] {
  return [node.id, ...node.children.flatMap((child) => collectDirectoryIds(child))];
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="xmind-import-summary-card"><small>{label}</small><strong title={value}>{value}</strong></div>;
}

function CheckRow({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return <div className={`xmind-import-check-row ${danger ? "danger" : value ? "warning" : "success"}`}><span>{label}</span><strong>{value}</strong></div>;
}

function buildMergeInfo(existingData: unknown, importedData: XMindImportData | null) {
  const existingCases = readCases(existingData);
  const importedCases = importedData?.cases || [];
  const existingIds = new Set(existingCases.map((item) => item.id));
  const newCases = importedCases.filter((item) => !existingIds.has(item.id));
  const repeatedCases = importedCases.filter((item) => existingIds.has(item.id));
  return { existingCount: existingCases.length, importedCount: importedCases.length, newCount: newCases.length, repeatedCount: repeatedCases.length, newTitles: newCases.slice(0, 10).map((item) => item.title), repeatedTitles: repeatedCases.slice(0, 10).map((item) => item.title) };
}

function MergePreview({ info }: { info: ReturnType<typeof buildMergeInfo> }) {
  return <div className="xmind-merge-preview"><div className="xmind-merge-stats"><span>现有用例 <strong>{info.existingCount}</strong></span><span>导入用例 <strong>{info.importedCount}</strong></span><span>新增ID <strong>{info.newCount}</strong></span><span>已有ID <strong>{info.repeatedCount}</strong></span></div>{info.newTitles.length > 0 && <div><strong>可新增ID</strong>{info.newTitles.map((title) => <small key={title}>{title}</small>)}</div>}{info.repeatedTitles.length > 0 && <div><strong>已有ID</strong>{info.repeatedTitles.map((title) => <small key={title}>{title}</small>)}</div>}<span className="field-hint">「合并导入」会把新增用例和目录并入现有 cases.json：已有ID保留现有内容并列为待同步；请在用例页使用外部差异预览。事务日志保留原文件。</span></div>;
}

function readCases(value: unknown): Array<{ id: string; title: string; steps?: XMindCaseStep[] }> {
  if (!isRecord(value) || !Array.isArray(value.cases)) return [];
  return value.cases.filter(isRecord).map((item) => ({ id: String(item.id || ""), title: typeof item.title === "string" ? item.title : "", steps: Array.isArray(item.steps) ? item.steps as XMindCaseStep[] : [] }));
}

function normalizeTitle(title: string): string {
  return title.replace(/^\s*tc-p\d+\s*[-—－]?[^:：]*[:：]?\s*/i, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object";
}
