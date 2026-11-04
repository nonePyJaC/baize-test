import { previewExternalXmind, type ExternalXmindDiff } from "../lib/xmindRevision";
import { useDraftSave } from "../lib/draftGuard";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBusinessRefresh } from "../lib/businessEvents";
import { applyCaseRevision, proposeCaseRevision, readRevisionFile, mergeCaseDraft, type CasePatch } from "../lib/caseRevision";
import { api, joinPath } from "../lib/api";
import AppIcon from "../components/AppIcon";
import ExternalPlanPicker, { readPlan, withPlan } from "../components/ExternalPlanPicker";
import PublicationPanel from "../components/PublicationPanel";
import type { ExternalReference } from "../domain/integrations";
import {
  CASE_AUTOMATION_STATUSES,
  CASE_STATUSES,
  CASE_TEST_TYPES,
  type CaseDiffEntry,
  type CaseDirectoryNode,
  type CaseVersionManifest,
  type CasesDocument,
  type PlatformInfo,
  type StructuredTestCase,
  type WorkspaceConfig,
} from "../lib/types";
import type { RightContextReporter, RightOutlineItem } from "../lib/workbench";
import { recordActivity, toWorkspaceRelative } from "../lib/requirementFlow";
import { buildXMindBytes } from "../lib/aiOutput";

import { casesDocumentToOutline, withStructuredCaseIds } from "../lib/xmindImport";
import {
  automationLabel,
  caseActions,
  caseExpectedResults,
  caseDirectoryIds,
  collectDirectoryNodes,
  compareCaseDocuments,
  findDirectoryNode,
  fingerprintCases,
  listValue,
  newCase,
  newDirectory,
  normalizeCasesDocument,
  parseListValue,
  priorityLabel,
  statusLabel,
  updateCasesMetadata,
} from "../lib/cases";

interface StructuredCasesViewProps {
  rootPath: string;
  workspace: WorkspaceConfig;
  platform: PlatformInfo;
  requirementId: string;
  readOnly?: boolean;
  /** 深链定位目标：versions 打开版本与差异对话框 */
  focus?: string;
  /** 全局搜索深链：选中指定用例ID */
  caseId?: string;
  focusKey?: number;
  onOpenExport?: () => void;
  onRightContext?: RightContextReporter;
  onDirtyChange?: (dirty: boolean) => void;
}

interface LoadedVersion {
  id: string;
  path: string;
  manifest: CaseVersionManifest;
  data: CasesDocument;
}

interface XMindChangeNotice {
  path: string;
  kind: "json" | "markdown";
  count: number | null;
}

type SortMode = "original" | "priority" | "title" | "status";

export default function StructuredCasesView({ rootPath, workspace, platform, requirementId, readOnly = false, focus, caseId, focusKey, onOpenExport, onRightContext, onDirtyChange }: StructuredCasesViewProps) {
  const casesPath = joinPath(rootPath, platform.path, requirementId, "04-测试用例", "cases.json");
  const versionsPath = joinPath(rootPath, platform.path, requirementId, "04-测试用例", "versions");
  const [document, setDocument] = useState<CasesDocument | null>(null);
  const baseDocument = useRef<CasesDocument | null>(null);
  const [draftMerge, setDraftMerge] = useState<{ disk: CasesDocument; merged: ReturnType<typeof mergeCaseDraft> } | null>(null);
  const [mergeChoices, setMergeChoices] = useState<Record<string, boolean>>({});
  const [useDiskTree, setUseDiskTree] = useState(false);
  const [externalDiff, setExternalDiff] = useState<{ incoming: CasesDocument; entries: ExternalXmindDiff[] } | null>(null);
  const [externalChoices, setExternalChoices] = useState<Record<string, boolean>>({});
  const [externalMapping, setExternalMapping] = useState<Record<string, string>>({});
  const [externalReason, setExternalReason] = useState("");
  const [versions, setVersions] = useState<LoadedVersion[]>([]);
  const [selectedDirectoryId, setSelectedDirectoryId] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("original");
  const [bulkPriority, setBulkPriority] = useState("");
  const [bulkType, setBulkType] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkDirectory, setBulkDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // 未保存修改上报给Tab条：关闭Tab/关闭其他时会有未保存确认
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportName, setExportName] = useState("");
  const [exporting, setExporting] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [testPlan, setTestPlan] = useState<ExternalReference | null>(null);
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [versionNote, setVersionNote] = useState("");
  const [sourceTask, setSourceTask] = useState("");
  const [oldVersionId, setOldVersionId] = useState("");
  const [newVersionId, setNewVersionId] = useState("");
  const [xmindChanges, setXmindChanges] = useState<XMindChangeNotice | null>(null);
  const [xmindChangesAcknowledged, setXmindChangesAcknowledged] = useState(false);

  const directories = useMemo(() => document ? collectDirectoryNodes(document.tree) : [], [document]);
  const directoryMap = useMemo(() => new Map(directories.map((directory) => [directory.id, directory])), [directories]);
  const selectedDirectory = document ? findDirectoryNode(document.tree, selectedDirectoryId) : null;
  const selectedCase = document?.cases.find((item) => item.id === selectedCaseId) || null;
  const canEdit = !readOnly && Boolean(document);

  // BB-16D：上报用例目录大纲与当前用例属性
  useEffect(() => {
    if (!onRightContext) return;
    const outline: RightOutlineItem[] = [];
    const walk = (node: CaseDirectoryNode, depth: number) => {
      if (node.node_type === "case_ref") return;
      const caseCount = document ? document.cases.filter((item) => caseDirectoryIds(node).has(item.directory_id)).length : 0;
      outline.push({ id: node.id, label: node.title, depth, badge: caseCount ? String(caseCount) : undefined, icon: "folder", active: node.id === selectedDirectoryId, onSelect: () => setSelectedDirectoryId(node.id) });
      node.children.forEach((child) => walk(child, depth + 1));
    };
    if (document) walk(document.tree, 0);
    onRightContext({
      objectType: "cases",
      objectId: requirementId,
      title: "结构化用例",
      subtitle: `${platform.name} · ${requirementId}`,
      path: casesPath,
      platformId: platform.id,
      requirementId,
      readOnly,
      outlineTitle: "用例目录",
      outline,
      properties: [
        { label: "数据文件", value: "04-测试用例/cases.json", mono: true },
        { label: "当前目录", value: selectedDirectory?.title || "根目录" },
        ...(selectedCase ? [
          { label: "用例ID", value: selectedCase.id, mono: true },
          { label: "用例标题", value: selectedCase.title },
          { label: "优先级", value: priorityLabel(selectedCase.priority) },
          { label: "测试类型", value: selectedCase.test_type },
          { label: "状态", value: statusLabel(selectedCase.status) },
          { label: "版本", value: `v${selectedCase.version}` },
        ] : []),
      ],
      stats: [
        { label: "用例总数", value: String(document?.cases.length ?? 0) },
        { label: "目录数", value: String(directories.length) },
        { label: "正式版本", value: String(versions.length) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, document, directories, selectedDirectoryId, selectedDirectory, selectedCase, versions, readOnly, requirementId, platform, casesPath]);

  const loadXMindChanges = useCallback(async (nextDocument: CasesDocument) => {
    const sourceFile = typeof nextDocument.metadata?.source_file === "string" ? nextDocument.metadata.source_file : "";
    if (!sourceFile) {
      setXmindChanges(null);
      setXmindChangesAcknowledged(false);
      return;
    }
    const sourcePath = isAbsolutePath(sourceFile) ? sourceFile : joinPath(rootPath, sourceFile);
    const jsonPath = `${sourcePath}.changes.json`;
    try {
      const raw = await api.readTextFile(jsonPath);
      const parsed = JSON.parse(raw) as unknown;
      setXmindChanges({ path: jsonPath, kind: "json", count: Array.isArray(parsed) ? parsed.length : null });
      setXmindChangesAcknowledged(false);
      return;
    } catch {
      const markdownPath = `${sourcePath}.changes.md`;
      try {
        const raw = await api.readTextFile(markdownPath);
        if (raw.trim()) {
          setXmindChanges({ path: markdownPath, kind: "markdown", count: countMarkdownChanges(raw) });
          setXmindChangesAcknowledged(false);
          return;
        }
      } catch {
        setXmindChanges(null);
        setXmindChangesAcknowledged(false);
        return;
      }
    }
    setXmindChanges(null);
    setXmindChangesAcknowledged(false);
    setXmindChangesAcknowledged(false);
  }, [rootPath]);

  const loadVersions = useCallback(async () => {
    try {
      const entries = await api.listDirectory(versionsPath);
      const directoriesOnly = entries.filter((entry) => entry.is_dir && !entry.name.startsWith("."));
      const loaded = await Promise.all(directoriesOnly.map(async (entry) => {
        try {
          const [rawManifest, rawData] = await Promise.all([
            api.readJsonFile(joinPath(entry.path, "manifest.json")),
            api.readJsonFile(joinPath(entry.path, "cases.json")),
          ]);
          const manifest = normalizeManifest(rawManifest, entry.name, requirementId, platform.id);
          return { id: entry.name, path: entry.path, manifest, data: normalizeCasesDocument(rawData, requirementId, platform.name, platform.id) };
        } catch {
          return null;
        }
      }));
      const next = loaded.filter((item): item is LoadedVersion => Boolean(item)).sort((left, right) => left.manifest.version - right.manifest.version || left.manifest.created_at.localeCompare(right.manifest.created_at));
      setVersions(next);
      const defaultOldId = next[0]?.id || "";
      const defaultNewId = next[1]?.id || defaultOldId;
      setOldVersionId((current) => next.some((item) => item.id === current) ? current : defaultOldId);
      setNewVersionId((current) => next.some((item) => item.id === current) && current !== defaultOldId ? current : defaultNewId);
    } catch {
      setVersions([]);
      setOldVersionId("");
      setNewVersionId("");
    }
  }, [platform.id, platform.name, requirementId, versionsPath]);

  const load = useCallback(async (confirmDirty = true) => {
    if (confirmDirty && dirty && !window.confirm("当前用例有未保存修改，仍然重新载入cases.json吗？")) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const raw = await api.readJsonFile(casesPath);
      const next = normalizeCasesDocument(raw, requirementId, platform.name, platform.id);
      baseDocument.current = next;
      setDocument(next);
      setSelectedDirectoryId((id) => findDirectoryNode(next.tree, id) ? id : next.tree.id);
      setSelectedCaseId((id) => next.cases.some((item) => item.id === id) ? id : next.cases[0]?.id || null);
      setSelectedCaseIds(new Set());
      setDirty(false);
      await loadXMindChanges(next);
      await loadVersions();
    } catch (reason) {
      setDocument(null);
      setSelectedDirectoryId("");
      setSelectedCaseId(null);
      setSelectedCaseIds(new Set());
      setDirty(false);
      setXmindChanges(null);
      setError(isMissingFileError(reason) ? null : `读取cases.json失败：${String(reason)}`);
      await loadVersions();
    } finally {
      setLoading(false);
    }
  }, [casesPath, dirty, loadVersions, loadXMindChanges, platform.id, platform.name, requirementId]);

  useEffect(() => { void load(false); }, [casesPath]);
  useBusinessRefresh([joinPath(rootPath, platform.path, requirementId, "04-测试用例")], dirty || saving,
    () => { void load(false); }, () => setMessage("磁盘已有新版本，当前草稿保留；保存前请合并差异"));
  const openExternalDiff = async () => {
    if (!document) return;
    if (dirty) { setMessage("请先保存当前草稿，再预览外部脑图差异"); return; }
    try {
      const files = [...new Set(document.cases.flatMap((item) => item.source?.file ? [item.source.file] : []))];
      if (!files.length && typeof document.metadata?.source_file === "string") files.push(document.metadata.source_file);
      const source = files.length === 1 ? files[0] : window.prompt("选择要同步的 XMind 文件绝对路径", files[0] || "");
      if (!source) return;
      const path = isAbsolutePath(source) ? source : joinPath(rootPath, source);
      setExternalDiff(await previewExternalXmind(document, path));
      setExternalChoices({}); setExternalMapping({}); setExternalReason("");
    } catch (reason) { setError(String(reason)); }
  };
  const applyExternalDiff = async () => {
    if (!document || !externalDiff || !externalReason.trim()) return;
    setSaving(true);
    try {
      const selected = externalDiff.entries.filter((item) => externalChoices[item.id]);
      const mappedIds = new Set(selected.map((entry) => externalMapping[entry.id]).filter(Boolean));
      const patches: CasePatch[] = selected.filter((entry) => !(!entry.after && mappedIds.has(entry.id))).map((entry) => {
        const id = externalMapping[entry.id] || entry.id;
        const before = document.cases.find((item) => item.id === id) || null;
        const after = entry.after ? { ...entry.after, id, source: entry.after.source ? { ...entry.after.source, baseline: { ...entry.after, source: undefined, id } } : undefined } : null;
        return { case_id: id, before, after, reason: externalReason, source: "external_xmind_confirmed", origin: "human" };
      });
      const tree = structuredClone(document.tree);
      const merge = (target: CaseDirectoryNode, incoming: CaseDirectoryNode) => {
        for (const child of incoming.children) {
          const old = collectDirectoryNodes(tree).find((node) => node.id === child.id);
          if (old) { old.title = child.title; merge(old, child); } else target.children.push(structuredClone(child));
        }
      };
      merge(tree, externalDiff.incoming.tree);
      const proposal = await proposeCaseRevision(document, patches);
      const saved = await applyCaseRevision(joinPath(rootPath, platform.path, requirementId), proposal, document, tree);
      setDocument(saved.document); baseDocument.current = saved.document;
      setExternalDiff(null); setMessage(`已应用 ${patches.length} 条确认差异；未选择项保留原内容`);
    } catch (reason) { setError(String(reason)); } finally { setSaving(false); }
  };

  const initializeEmpty = async () => {
    if (readOnly) return;
    try {
      const empty = normalizeCasesDocument({ tree: { id: `root-${requirementId}`, title: requirementId, node_type: "platform", children: [] }, cases: [] }, requirementId, platform.name, platform.id);
      await api.createJsonFile(casesPath, empty);
      baseDocument.current = empty; setDocument(empty); setSelectedDirectoryId(empty.tree.id);
    } catch (reason) { setError(String(reason)); }
  };

  // 外部定位请求（左侧用例树“正式版本”节点）：打开版本与差异对话框
  useEffect(() => {
    if (focus === "versions") setShowVersionDialog(true);
  }, [focus, focusKey]);

  const appliedCaseKey = useRef("");
  // 外部定位请求（全局搜索）：用例文档就绪后选中指定用例并展开所在目录
  useEffect(() => {
    if (!caseId || !document) return;
    const key = `${caseId}#${focusKey ?? "mount"}`;
    if (appliedCaseKey.current === key) return;
    appliedCaseKey.current = key;
    const target = document.cases.find((item) => item.id === caseId);
    if (target) {
      setSearch("");
      setSelectedDirectoryId(target.directory_id || document.tree.id);
      setSelectedCaseId(target.id);
    } else {
      setMessage(`未找到用例 ${caseId}，可能已被删除或移动`);
    }
  }, [caseId, document, focusKey]);

  const visibleCases = useMemo(() => {
    if (!document) return [];
    const allowedDirectories = selectedDirectoryId ? caseDirectoryIds(findDirectoryNode(document.tree, selectedDirectoryId) || document.tree) : caseDirectoryIds(document.tree);
    const keyword = search.trim().toLocaleLowerCase();
    const filtered = document.cases.filter((item) => {
      if (!allowedDirectories.has(item.directory_id)) return false;
      if (!keyword) return true;
      return [item.title, item.test_type, item.status, ...item.preconditions, ...caseActions(item), ...caseExpectedResults(item), ...item.tags].join(" ").toLocaleLowerCase().includes(keyword);
    });
    return filtered.slice().sort((left, right) => {
      if (sortMode === "priority") return left.priority - right.priority || left.title.localeCompare(right.title);
      if (sortMode === "title") return left.title.localeCompare(right.title);
      if (sortMode === "status") return left.status.localeCompare(right.status) || left.title.localeCompare(right.title);
      return document.cases.indexOf(left) - document.cases.indexOf(right);
    });
  }, [document, search, selectedDirectoryId, sortMode]);

  const visibleSelectedCount = visibleCases.filter((item) => selectedCaseIds.has(item.id)).length;
  const diff = useMemo(() => {
    const oldVersion = versions.find((item) => item.id === oldVersionId);
    const newVersion = versions.find((item) => item.id === newVersionId);
    return oldVersion && newVersion ? compareCaseDocuments(oldVersion.data, newVersion.data) : null;
  }, [newVersionId, oldVersionId, versions]);

  const markChanged = () => {
    setDirty(true);
    setMessage(null);
    setError(null);
  };

  const updateDocument = (update: (current: CasesDocument) => CasesDocument) => {
    if (!canEdit || !document) return;
    setDocument(update(document));
    markChanged();
  };

  const updateCase = (id: string, patch: Partial<StructuredTestCase>) => {
    updateDocument((current) => ({ ...current, cases: current.cases.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  };

  const selectCase = (id: string) => setSelectedCaseId(id);

  const toggleCaseSelection = (id: string) => {
    setSelectedCaseIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedCaseIds((current) => {
      const next = new Set(current);
      if (visibleCases.every((item) => next.has(item.id))) visibleCases.forEach((item) => next.delete(item.id));
      else visibleCases.forEach((item) => next.add(item.id));
      return next;
    });
  };

  const applyBulkChanges = () => {
    if (!canEdit || !document || selectedCaseIds.size === 0) return;
    const patch: Partial<StructuredTestCase> = {};
    if (bulkPriority !== "") patch.priority = Number(bulkPriority) as 0 | 1 | 2;
    if (bulkType !== "") patch.test_type = bulkType;
    if (bulkStatus !== "") patch.status = bulkStatus;
    if (!Object.keys(patch).length && !bulkDirectory) {
      setError("请选择要批量修改的字段");
      return;
    }
    updateDocument((current) => ({
      ...current,
      cases: current.cases.map((item) => selectedCaseIds.has(item.id) ? { ...item, ...patch, ...(bulkDirectory ? { directory_id: bulkDirectory } : {}) } : item),
    }));
    setMessage(`已修改 ${selectedCaseIds.size} 条用例，保存后正式落盘`);
    setBulkPriority("");
    setBulkType("");
    setBulkStatus("");
    setBulkDirectory("");
  };

  const save = async (successMessage = "cases.json已保存") => {
    if (readOnly) {
      setError("需求目录已锁定，结构化用例为只读状态");
      return false;
    }
    if (!document) return false;
    if (xmindChanges && !xmindChangesAcknowledged) {
      setError("检测到XMind人工修改记录，请先确认已阅读，避免静默丢失修改");
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const base = baseDocument.current;
      if (!base) throw new Error("缺少读取基线，请重新读取");
      const diskFile = await readRevisionFile(casesPath);
      const disk = normalizeCasesDocument(diskFile.value, requirementId, platform.name, platform.id);
      const merge = mergeCaseDraft(base, document, disk);
      if (merge.conflicts.length || merge.treeConflict) {
        setDraftMerge({ disk, merged: merge }); setMergeChoices({}); setUseDiskTree(false);
        setError("磁盘和草稿都已变化，请逐项确认合并。草稿尚未写入磁盘");
        return false;
      }
      if (JSON.stringify(disk) !== JSON.stringify(base)) {
        baseDocument.current = disk; setDocument(merge.document);
        setMessage("已合并磁盘中的独立变更，请检查后再次保存");
        return false;
      }
      const diff = compareCaseDocuments(base, document);
      const ids = new Set([...diff.added, ...diff.deleted, ...diff.modified, ...diff.moved].map((item) => item.id));
      const directoryPath = (doc: CasesDocument, directoryId: string): string => {
        const visit = (node: CaseDirectoryNode, parents: string[]): string | null => node.id === directoryId ? [...parents, node.title].join(" / ") : node.children.map((child) => visit(child, [...parents, node.title])).find((value) => value !== null) ?? null;
        return visit(doc.tree, []) || "";
      };
      const pathChanged = new Set(document.cases.filter((item) => base.cases.some((old) => old.id === item.id && directoryPath(base, old.directory_id) !== directoryPath(document, item.directory_id))).map((item) => item.id));
      pathChanged.forEach((id) => ids.add(id));
      const reason = ids.size ? window.prompt(`保存 ${ids.size} 条用例修订，请填写原因（批量操作共用；新增可填写依据）`) : "目录调整";
      if (reason === null) return false;
      if (ids.size && !reason?.trim()) throw new Error("请填写修订原因");
      const patches: CasePatch[] = [...ids].map((id) => ({ case_id: id, before: base.cases.find((item) => item.id === id) || null, after: document.cases.find((item) => item.id === id) || null, reason: reason || "", source: "review_editor", origin: "human", directory_path_changed: pathChanged.has(id) }));
      const proposal = await proposeCaseRevision(base, patches);
      const saved = await applyCaseRevision(joinPath(rootPath, platform.path, requirementId), proposal, base, document.tree);
      const next = saved.document;
      baseDocument.current = next;
      setDocument(next);
      setDirty(false);
      setMessage(successMessage);
      recordActivity(rootPath, platform.path, requirementId, {
        action: "cases_saved",
        summary: `保存结构化用例，共 ${next.cases.length} 条`,
        refs: [toWorkspaceRelative(rootPath, casesPath)],
      });
      return true;
    } catch (reason) {
      setError(`保存cases.json失败：${String(reason)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  useDraftSave(() => save());

  /// 把当前 cases.json（含未保存的编辑内容）反向生成 .xmind 到 04-测试用例/exports/，供归档或上传云效。
  const exportXMind = async () => {
    if (!document || exporting) return;
    const { title, outline } = casesDocumentToOutline(document);
    const fileName = (exportName.trim() || title).replace(/\.xmind$/i, "").replace(/[\\/:*?"<>|]/g, "_");
    if (!fileName) {
      setError("请填写导出的文件名");
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const exportDir = joinPath(rootPath, platform.path, requirementId, "04-测试用例", "exports");
      const dirInfo = await api.getPathInfo(exportDir).catch(() => null);
      if (!dirInfo?.is_directory) await api.createDirectory(exportDir);
      const filePath = joinPath(exportDir, `${fileName}.xmind`);
      const fileInfo = await api.getPathInfo(filePath).catch(() => null);
      if (fileInfo?.exists && !window.confirm(`exports 下已存在「${fileName}.xmind」，覆盖吗？`)) return;
      const bytes = await withStructuredCaseIds(await buildXMindBytes(rootPath, title, outline), document);
      if (fileInfo?.exists) await api.writeBinaryFile(filePath, bytes);
      else await api.createBinaryFile(filePath, bytes);
      recordActivity(rootPath, platform.path, requirementId, {
        action: "cases_exported_xmind",
        summary: `导出 ${document.cases.length} 条用例到 ${fileName}.xmind${dirty ? "（含未保存修改）" : ""}`,
        refs: [toWorkspaceRelative(rootPath, filePath)],
      });
      setMessage(`已导出 ${document.cases.length} 条用例到 ${toWorkspaceRelative(rootPath, filePath)}${dirty ? "（注意：包含尚未保存的编辑内容）" : ""}`);
      setExportOpen(false);
    } catch (reason) {
      setError(`导出 XMind 失败：${String(reason)}`);
    } finally {
      setExporting(false);
    }
  };

  const addDirectory = () => {
    if (!canEdit || !document) return;
    const title = window.prompt("请输入新目录名称", "新目录")?.trim();
    if (!title) return;
    const parentId = selectedDirectoryId || document.tree.id;
    const directory = newDirectory(title);
    updateDocument((current) => ({ ...current, tree: mapDirectory(current.tree, parentId, (node) => ({ ...node, children: [...node.children, directory] })) }));
    setSelectedDirectoryId(directory.id);
    setMessage(`已新增目录“${title}”，保存后正式落盘`);
  };

  const renameDirectory = () => {
    if (!canEdit || !document || !selectedDirectory || selectedDirectory.id === document.tree.id) return;
    const title = window.prompt("请输入新的目录名称", selectedDirectory.title)?.trim();
    if (!title || title === selectedDirectory.title) return;
    updateDocument((current) => ({ ...current, tree: mapDirectory(current.tree, selectedDirectory.id, (node) => ({ ...node, title })) }));
    setMessage(`目录已重命名为“${title}”，保存后正式落盘`);
  };

  const deleteDirectory = () => {
    if (!canEdit || !document || !selectedDirectory || selectedDirectory.id === document.tree.id) return;
    if (selectedDirectory.children.length > 0 || document.cases.some((item) => item.directory_id === selectedDirectory.id)) {
      setError("只能删除空目录，请先移动其中的子目录和用例");
      return;
    }
    if (!window.confirm(`确定删除空目录“${selectedDirectory.title}”吗？`)) return;
    updateDocument((current) => ({ ...current, tree: removeDirectory(current.tree, selectedDirectory.id) || current.tree }));
    setSelectedDirectoryId(document.tree.id);
    setMessage("空目录已删除，保存后正式落盘");
  };

  const addCase = () => {
    if (!canEdit || !document) return;
    const item = newCase(selectedDirectoryId || document.tree.id);
    updateDocument((current) => ({ ...current, cases: [...current.cases, item] }));
    setSelectedCaseId(item.id);
    setSelectedCaseIds(new Set());
    setMessage("已新增测试用例，请完善字段后保存");
  };

  const commitVersion = async () => {
    if (readOnly || !document) return;
    if (xmindChanges && !xmindChangesAcknowledged) {
      setError("检测到XMind人工修改记录，请先确认已阅读");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const current = updateCasesMetadata({ ...document, metadata: withPlan(document.metadata, testPlan) });
      await api.saveJsonFile(casesPath, current);
      const nextVersion = nextVersionNumber(versions);
      const versionId = `v${nextVersion}`;
      const versionData = { ...current, version_id: versionId };
      const fingerprint = await fingerprintCases(versionData);
      const versionDirectory = joinPath(versionsPath, versionId);
      await api.createJsonFile(joinPath(versionDirectory, "cases.json"), versionData);
      await api.createJsonFile(joinPath(versionDirectory, "manifest.json"), {
        version_id: versionId,
        version: nextVersion,
        created_at: new Date().toISOString(),
        created_by: "用户",
        source_task: sourceTask.trim() || (typeof current.metadata?.source_task === "string" ? current.metadata.source_task : null),
        case_count: current.cases.length,
        fingerprint,
        note: versionNote.trim(),
        external_test_plan: testPlan,
        requirement_id: requirementId,
        platform_id: platform.id,
      });
      setDocument(current);
      setDirty(false);
      setVersionNote("");
      setSourceTask("");
      setShowCommitDialog(false);
      setMessage(`已提交 V${nextVersion}，共 ${current.cases.length} 条用例`);
      recordActivity(rootPath, platform.path, requirementId, {
        action: "case_version_committed",
        summary: `提交用例版本 V${nextVersion}，共 ${current.cases.length} 条用例${versionNote.trim() ? `（${versionNote.trim()}）` : ""}`,
        object_id: versionId,
        refs: [toWorkspaceRelative(rootPath, joinPath(versionDirectory, "cases.json"))],
      });
      await loadVersions();
    } catch (reason) {
      setError(`提交版本失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  const headerStatus = readOnly ? "锁定只读" : dirty ? "有未保存修改" : "已保存";

  return (
    <div className="document-workspace structured-cases-workspace">
      <div className="document-toolbar">
        <div className="document-toolbar-title"><AppIcon name="checks" size={16} /><div><strong>结构化用例 · {requirementId}</strong><small>cases.json · {platform.name}</small></div><span className={`document-readonly ${readOnly ? "locked" : dirty ? "dirty" : ""}`}>{headerStatus}</span></div>
        <div className="document-toolbar-actions">
          <div className="document-search"><AppIcon name="search" size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用例" />{search && <span>{visibleCases.length} 条</span>}</div>
          <button className="button button-ghost button-small" type="button" disabled={!canEdit} onClick={addCase}><AppIcon name="add" size={14} /> 新增用例</button>
          <button className="button button-ghost button-small" type="button" disabled={!canEdit || !dirty || saving} onClick={() => void save()}><AppIcon name="save" size={14} /> {saving ? "保存中…" : "保存"}</button>
          <button className="button button-primary button-small" type="button" disabled={readOnly || !document || saving} onClick={() => { setTestPlan(readPlan(document?.metadata)); setShowCommitDialog(true); }}><AppIcon name="commit" size={14} /> 提交版本</button>
          <button className="button button-ghost button-small" type="button" disabled={versions.length < 1} onClick={() => setShowVersionDialog(true)}><AppIcon name="history" size={14} /> 版本与差异{versions.length ? `（${versions.length}）` : ""}</button>
          <button className="button button-ghost button-small" disabled={!document || readOnly || saving} onClick={() => void openExternalDiff()}>外部 XMind 差异</button>
          <button className="button button-ghost button-small" type="button" disabled={!document || readOnly} onClick={onOpenExport}><AppIcon name="download" size={14} /> 模板导出</button>
          <button className="button button-ghost button-small" type="button" disabled={!document || saving} onClick={() => { setExportName(`${document?.tree.title || requirementId}-结构化用例`); setExportOpen(true); }} title="把当前 cases.json 反向生成 .xmind，供归档或导入云效用例库"><AppIcon name="upload" size={14} /> 导出 XMind</button>
          <button className="icon-button" type="button" disabled={loading || saving} onClick={() => void load()} title="重新载入"><AppIcon name="refresh" size={15} /></button>
        </div>
      </div>
      <div className="document-path" title={casesPath}><span className="mono">{casesPath}</span><span className={error ? "error" : message ? "success" : ""}>{error || message || `${document?.cases.length || 0} 条用例 · ${directories.length} 个目录`}</span></div>
      {draftMerge && <div className="modal-backdrop"><div className="modal" style={{ maxHeight: "85vh", overflow: "auto" }}><h2>磁盘与草稿冲突</h2>{draftMerge.merged.conflicts.map((entry) => <div key={entry.id}><label><input type="checkbox" checked={Boolean(mergeChoices[entry.id])} onChange={(event) => setMergeChoices((old) => ({ ...old, [entry.id]: event.target.checked }))} />采纳磁盘：{(entry.disk || entry.local || entry.before)?.title}（默认保留草稿）</label><details><summary>查看前后差异</summary><pre>{JSON.stringify(entry, null, 2)}</pre></details></div>)}{draftMerge.merged.treeConflict && <label><input type="checkbox" checked={useDiskTree} onChange={(event) => setUseDiskTree(event.target.checked)} />采纳磁盘目录树（默认保留草稿目录）</label>}<div className="modal-actions"><button className="button button-ghost" onClick={() => setDraftMerge(null)}>取消</button><button className="button button-primary" onClick={() => {
        const map = new Map(draftMerge.merged.document.cases.map((item) => [item.id, item]));
        draftMerge.merged.conflicts.forEach((entry) => { const choice = mergeChoices[entry.id] ? entry.disk : entry.local; if (choice) map.set(entry.id, choice); else map.delete(entry.id); });
        baseDocument.current = draftMerge.disk;
        setDocument({ ...draftMerge.merged.document, cases: [...map.values()], tree: useDiskTree ? draftMerge.disk.tree : draftMerge.merged.document.tree });
        setDirty(true); setDraftMerge(null); setError(null); setMessage("已合并到草稿，请检查并保存");
      }}>确认合并到草稿</button></div></div></div>}
      {externalDiff && <div className="modal-backdrop"><div className="modal" style={{ maxHeight: "85vh", overflow: "auto", width: "900px" }}><h2>确认外部 XMind 差异</h2><p>逐项勾选采纳；未勾选表示保留本地。重建ID的用例可明确映射到旧ID，系统不会按标题自动合并。</p>{externalDiff.entries.map((entry) => <div key={entry.id}><label><input type="checkbox" checked={Boolean(externalChoices[entry.id])} onChange={(event) => setExternalChoices((old) => ({ ...old, [entry.id]: event.target.checked }))} />{entry.kind} · {(entry.after || entry.before)?.title} {entry.conflict ? "（需确认）" : ""}</label><p>{entry.note}</p>{!entry.before && entry.after && <select className="field-input" value={externalMapping[entry.id] || ""} onChange={(event) => setExternalMapping((old) => ({ ...old, [entry.id]: event.target.value }))}><option value="">确认创建新ID</option>{externalDiff.entries.filter((old) => old.before && !old.after).map((old) => <option key={old.id} value={old.id}>映射旧ID：{old.before?.title} · {old.id}</option>)}</select>}<details><summary>字段差异</summary><pre>{JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}</pre></details></div>)}<label className="field-label">本次确认依据/原因<textarea className="field-input" value={externalReason} onChange={(event) => setExternalReason(event.target.value)} /></label><div className="modal-actions"><button className="button button-ghost" onClick={() => setExternalDiff(null)} disabled={saving}>取消</button><button className="button button-primary" disabled={saving || !externalReason.trim() || !Object.values(externalChoices).some(Boolean)} onClick={() => void applyExternalDiff()}>应用已选差异</button></div></div></div>}
      {loading ? <div className="center-state structured-cases-loading"><span className="spinner" />正在读取结构化用例…</div> : !document ? <><EmptyCasesView error={error} onReload={() => void load(false)} />{!readOnly && <button className="button button-primary" onClick={() => void initializeEmpty()}>创建空用例集</button>}</> : <div className="structured-cases-body">
        <aside className="structured-cases-directories">
          <div className="structured-panel-heading"><strong>用例目录</strong><span>{directories.length}</span></div>
          <div className="structured-directory-actions"><button className="icon-button" type="button" disabled={!canEdit} onClick={addDirectory} title="新增目录"><AppIcon name="add" size={14} /></button><button className="icon-button" type="button" disabled={!canEdit || !selectedDirectory || selectedDirectory.id === document.tree.id} onClick={renameDirectory} title="重命名目录"><AppIcon name="edit" size={14} /></button><button className="icon-button" type="button" disabled={!canEdit || !selectedDirectory || selectedDirectory.id === document.tree.id} onClick={deleteDirectory} title="删除空目录"><AppIcon name="minus" size={14} /></button></div>
          <div className="structured-directory-scroll"><DirectoryTree node={document.tree} selectedId={selectedDirectoryId || document.tree.id} cases={document.cases} onSelect={(id) => { setSelectedDirectoryId(id); setSelectedCaseIds(new Set()); }} /></div>
        </aside>
        <section className="structured-case-list">
          <div className="structured-list-heading"><div><strong>{selectedDirectory?.title || "全部用例"}</strong><span>{visibleCases.length} / {document.cases.length}</span></div><label className="compact-select-label">排序<select className="select-control" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}><option value="original">原始顺序</option><option value="priority">优先级</option><option value="title">标题</option><option value="status">状态</option></select></label></div>
          <div className="structured-batch-toolbar"><label className="batch-check"><input type="checkbox" checked={visibleCases.length > 0 && visibleSelectedCount === visibleCases.length} onChange={toggleVisibleSelection} />全选</label>{selectedCaseIds.size > 0 && <><span className="batch-count">已选 {selectedCaseIds.size}</span><select className="select-control" value={bulkPriority} onChange={(event) => setBulkPriority(event.target.value)}><option value="">批量优先级</option><option value="0">P0</option><option value="1">P1</option><option value="2">P2</option></select><select className="select-control" value={bulkType} onChange={(event) => setBulkType(event.target.value)}><option value="">批量类型</option>{CASE_TEST_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select><select className="select-control" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value)}><option value="">批量状态</option>{CASE_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select><select className="select-control" value={bulkDirectory} onChange={(event) => setBulkDirectory(event.target.value)}><option value="">批量移动目录</option>{directories.map((directory) => <option key={directory.id} value={directory.id}>{directory.title}</option>)}</select><button className="button button-ghost button-small" type="button" disabled={!canEdit} onClick={applyBulkChanges}>应用</button></>}</div>
          <div className="structured-case-list-scroll">{visibleCases.length ? visibleCases.map((item) => <CaseListRow key={item.id} item={item} selected={item.id === selectedCaseId} checked={selectedCaseIds.has(item.id)} directoryName={directoryMap.get(item.directory_id)?.title || "未分类"} onSelect={selectCase} onToggle={toggleCaseSelection} />) : <div className="panel-placeholder"><AppIcon name="inbox" size={20} /><span>没有匹配的测试用例</span><small>可以切换目录或清除搜索条件</small></div>}</div>
        </section>
        <section className="structured-case-editor">{selectedCase && <CaseEditor item={selectedCase} directories={directories} readOnly={!canEdit} onChange={(patch) => updateCase(selectedCase.id, patch)} />}</section>
      </div>}
      {xmindChanges && !xmindChangesAcknowledged && <div className="modal-backdrop"><div className="modal xmind-change-warning-modal"><div className="modal-header"><div><span className="eyebrow">BB-09 / 数据保护</span><h2>检测到XMind人工修改记录</h2></div></div><div className="unlock-warning"><AppIcon name="alert" size={15} /><span>导入来源存在修改记录。已阅读仅表示知悉，不代表已经同步。请使用“外部 XMind 差异”逐项确认当前脑图与设计集；结构化编辑会保留原记录。</span></div><div className="xmind-change-record-path mono">{xmindChanges.path}</div><p className="modal-description">记录类型：{xmindChanges.kind === "json" ? "JSON修改记录" : "Markdown修改记录"}{xmindChanges.count === null ? "" : ` · ${xmindChanges.count} 条`}</p><div className="modal-actions"><button className="button button-primary" type="button" onClick={() => setXmindChangesAcknowledged(true)}>我已阅读，继续编辑</button></div></div></div>}
      <PublicationPanel key={requirementId} inheritedDefaults={[platform.integration_defaults, workspace.defaults?.integration_defaults]} requirementDir={joinPath(rootPath, platform.path, requirementId)} disabled={readOnly} />
      {showCommitDialog && <CommitVersionDialog note={versionNote} sourceTask={sourceTask} saving={saving} onNoteChange={setVersionNote} onSourceTaskChange={setSourceTask} testPlan={testPlan} onTestPlanChange={setTestPlan} onClose={() => setShowCommitDialog(false)} onCommit={() => void commitVersion()} />}
      {showVersionDialog && <VersionDiffDialog versions={versions} oldVersionId={oldVersionId} newVersionId={newVersionId} diff={diff} onOldChange={setOldVersionId} onNewChange={setNewVersionId} onClose={() => setShowVersionDialog(false)} />}
      {exportOpen && document && (
        <div className="modal-backdrop"><div className="modal xmind-export-modal"><div className="modal-header"><div><span className="eyebrow">BB-09 / 用例归档</span><h2>导出 XMind 用例</h2></div><button className="icon-button" type="button" disabled={exporting} onClick={() => setExportOpen(false)}><AppIcon name="close" size={16} /></button></div>
          <p className="modal-description">按当前 cases.json 的目录树和 {document.cases.length} 条用例重新生成 .xmind，写入 <span className="mono">04-测试用例/exports/</span>，可直接在云效用例库中导入或归档。{dirty && <strong>注意：包含尚未保存的修改。</strong>}</p>
          <label className="field-label">文件名<span className="field-help">无需填写 .xmind 后缀</span><input className="field-input" value={exportName} disabled={exporting} onChange={(event) => setExportName(event.target.value)} placeholder={document.tree.title || "测试用例"} /></label>
          <div className="modal-actions"><button className="button button-ghost" type="button" disabled={exporting} onClick={() => setExportOpen(false)}>取消</button><button className="button button-primary" type="button" disabled={exporting} onClick={() => void exportXMind()}>{exporting ? "导出中…" : "导出"}</button></div></div></div>
      )}
    </div>
  );
}

function DirectoryTree({ node, selectedId, cases, onSelect, depth = 0 }: { node: CaseDirectoryNode; selectedId: string; cases: StructuredTestCase[]; onSelect: (id: string) => void; depth?: number }) {
  if (node.node_type === "case_ref") return null;
  const ids = caseDirectoryIds(node);
  const count = cases.filter((item) => ids.has(item.directory_id)).length;
  return <div className="structured-directory-node"><button type="button" className={`structured-directory-row ${selectedId === node.id ? "active" : ""}`} style={{ paddingLeft: 7 + depth * 14 }} onClick={() => onSelect(node.id)}><AppIcon name={depth === 0 ? "archiveFile" : "folder"} size={13} /><span title={node.title}>{node.title || "未命名目录"}</span><b>{count}</b></button>{node.children.map((child) => <DirectoryTree key={child.id} node={child} selectedId={selectedId} cases={cases} onSelect={onSelect} depth={depth + 1} />)}</div>;
}

function CaseListRow({ item, selected, checked, directoryName, onSelect, onToggle }: { item: StructuredTestCase; selected: boolean; checked: boolean; directoryName: string; onSelect: (id: string) => void; onToggle: (id: string) => void }) {
  return <div className={`structured-case-row ${selected ? "active" : ""}`}><input type="checkbox" checked={checked} onChange={() => onToggle(item.id)} aria-label={`选择${item.title}`} /><button type="button" onClick={() => onSelect(item.id)}><span className={`priority-label p${item.priority}`}>{priorityLabel(item.priority)}</span><span className="structured-case-row-main"><strong>{item.title || "未命名用例"}</strong><small>{directoryName} · {item.status}</small></span><span className="case-type">{item.test_type}</span></button></div>;
}

function CaseEditor({ item, directories, readOnly, onChange }: { item: StructuredTestCase; directories: CaseDirectoryNode[]; readOnly: boolean; onChange: (patch: Partial<StructuredTestCase>) => void }) {
  const parseLines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const updateStep = (index: number, patch: { action?: string; expected?: string[] }) => {
    const steps = item.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch, order: stepIndex + 1 } : { ...step, order: stepIndex + 1 });
    onChange({ steps, expected_results: steps.flatMap((step) => step.expected) });
  };
  const addStep = () => {
    const expected = caseExpectedResults(item);
    const steps = [...item.steps, { order: item.steps.length + 1, action: "", expected: [] }];
    onChange({ steps: steps.map((step, index) => ({ ...step, expected: index === steps.length - 1 ? expected : [] })), expected_results: expected });
  };
  const removeStep = (index: number) => {
    const expected = caseExpectedResults(item);
    const steps = item.steps.filter((_, stepIndex) => stepIndex !== index).map((step, stepIndex) => ({ ...step, order: stepIndex + 1 }));
    onChange({ steps: steps.map((step, stepIndex) => ({ ...step, expected: stepIndex === steps.length - 1 ? expected : [] })), expected_results: expected });
  };
  return <div className="structured-case-editor-scroll"><div className="structured-editor-heading"><div><span className="eyebrow">单条用例编辑器</span><h2>{item.title || "未命名用例"}</h2><small className="mono">{item.id}</small></div><span className={`status-pill ${item.status === "confirmed" ? "success" : item.status === "deprecated" ? "danger" : ""}`}>{statusLabel(item.status)}</span></div><label className="field-label">标题<input className="field-input" value={item.title} disabled={readOnly} onChange={(event) => onChange({ title: event.target.value })} /></label><div className="structured-editor-grid"><label className="field-label">优先级<select className="field-input" value={item.priority} disabled={readOnly} onChange={(event) => onChange({ priority: Number(event.target.value) as 0 | 1 | 2 })}><option value={0}>P0</option><option value={1}>P1</option><option value={2}>P2</option></select></label><label className="field-label">测试类型<select className="field-input" value={item.test_type} disabled={readOnly} onChange={(event) => onChange({ test_type: event.target.value })}>{CASE_TEST_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label className="field-label">用例状态<select className="field-input" value={item.status} disabled={readOnly} onChange={(event) => onChange({ status: event.target.value })}>{CASE_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label><label className="field-label">自动化状态<select className="field-input" value={item.automation_status} disabled={readOnly} onChange={(event) => onChange({ automation_status: event.target.value })}>{CASE_AUTOMATION_STATUSES.map((status) => <option key={status} value={status}>{automationLabel(status)}</option>)}</select></label></div><label className="field-label">所属目录<select className="field-input" value={item.directory_id} disabled={readOnly} onChange={(event) => onChange({ directory_id: event.target.value })}>{directories.map((directory) => <option key={directory.id} value={directory.id}>{directory.title}</option>)}</select></label><label className="field-label">前置条件<span className="field-help">每行一条</span><textarea className="field-input field-textarea structured-textarea" value={item.preconditions.join("\n")} disabled={readOnly} onChange={(event) => onChange({ preconditions: parseListValue(event.target.value) })} /></label><EditorSectionHeading title="操作步骤与用例整体期望" action={<button className="text-button" type="button" disabled={readOnly} onClick={addStep}><AppIcon name="add" size={13} /> 添加步骤</button>} />{item.steps.map((step, index) => <div className="structured-step-editor" key={`${item.id}-step-${index}`}><div className="structured-step-heading"><strong>步骤 {index + 1}</strong><button className="icon-button" type="button" disabled={readOnly} onClick={() => removeStep(index)} title="删除步骤"><AppIcon name="minus" size={13} /></button></div><label className="field-label">操作<textarea className="field-input field-textarea structured-step-textarea" value={step.action} disabled={readOnly} onChange={(event) => updateStep(index, { action: event.target.value })} /></label></div>)}<label className="field-label">用例整体期望结果<textarea className="field-input field-textarea structured-step-textarea expected" value={caseExpectedResults(item).join("\n")} disabled={readOnly} onChange={(event) => { const expected = parseListValue(event.target.value); onChange({ expected_results: expected, steps: item.steps.map((step, index) => ({ ...step, expected: index === item.steps.length - 1 ? expected : [] })) }); }} /></label><div className="structured-editor-grid"><label className="field-label">标签<span className="field-help">逗号或换行分隔</span><input className="field-input" value={listValue(item.tags)} disabled={readOnly} onChange={(event) => onChange({ tags: parseListValue(event.target.value) })} /></label><label className="field-label">适用平台/端<span className="field-help">逗号或换行分隔</span><input className="field-input" value={listValue(item.platforms)} disabled={readOnly} onChange={(event) => onChange({ platforms: parseListValue(event.target.value) })} /></label><label className="field-label">关联需求点<span className="field-help">逗号或换行分隔</span><input className="field-input" value={listValue(item.requirement_refs)} disabled={readOnly} onChange={(event) => onChange({ requirement_refs: parseListValue(event.target.value) })} /></label><div className="field-label structured-checkbox-label"><span>执行要求</span><label><input type="checkbox" checked={item.requires_evidence} disabled={readOnly} onChange={(event) => onChange({ requires_evidence: event.target.checked })} />要求保留证据</label></div></div><div className="structured-editor-note"><AppIcon name="info" size={14} /><span>修改会先更新内存中的结构化数据；点击顶部“保存”后才写入 <span className="mono">cases.json</span>。</span></div></div>;
}

function EditorSectionHeading({ title, action }: { title: string; action?: React.ReactNode }) {
  return <div className="structured-editor-section-heading"><strong>{title}</strong>{action}</div>;
}

function EmptyCasesView({ error, onReload }: { error: string | null; onReload: () => void }) {
  return <div className="center-state"><AppIcon name={error ? "alert" : "inbox"} size={25} /><strong>{error || "当前需求尚未生成cases.json"}</strong><span>{error ? "请检查文件内容或权限后重试。" : "请先从需求概览导入XMind，导入后即可在这里编辑、保存和提交版本。"}</span><button className="button button-ghost button-small" type="button" onClick={onReload}><AppIcon name="refresh" size={14} />重新读取</button></div>;
}

function CommitVersionDialog({ note, sourceTask, saving, onNoteChange, onSourceTaskChange, testPlan, onTestPlanChange, onClose, onCommit }: { note: string; sourceTask: string; saving: boolean; onNoteChange: (value: string) => void; onSourceTaskChange: (value: string) => void; testPlan: ExternalReference | null; onTestPlanChange: (link: ExternalReference | null) => void; onClose: () => void; onCommit: () => void }) {
  return <div className="modal-backdrop"><div className="modal case-version-modal"><div className="modal-header"><div><span className="eyebrow">BB-09 / 版本管理</span><h2>提交正式用例版本</h2></div><button className="icon-button" type="button" disabled={saving} onClick={onClose}><AppIcon name="close" size={16} /></button></div><p className="modal-description">提交会先保存当前cases.json，再生成不可变版本目录。下一个版本号将自动递增。</p><label className="field-label">来源任务<span className="field-help">可填写AI任务ID或评审任务编号</span><input className="field-input" value={sourceTask} disabled={saving} onChange={(event) => onSourceTaskChange(event.target.value)} placeholder="例如 task-20260910-001" /></label><label className="field-label">版本说明<textarea className="field-input field-textarea" value={note} disabled={saving} onChange={(event) => onNoteChange(event.target.value)} placeholder="记录本次版本的范围、评审结论或变更原因" /></label><div className="field-label">外部测试计划<span className="field-help">可选：搜索已有计划或新建计划并关联，关联ID随版本保存</span><ExternalPlanPicker value={testPlan} onChange={onTestPlanChange} /></div><div className="modal-actions"><button className="button button-ghost" type="button" disabled={saving} onClick={onClose}>取消</button><button className="button button-primary" type="button" disabled={saving} onClick={onCommit}>{saving ? "提交中…" : "提交版本"}</button></div></div></div>;
}

function VersionDiffDialog({ versions, oldVersionId, newVersionId, diff, onOldChange, onNewChange, onClose }: { versions: LoadedVersion[]; oldVersionId: string; newVersionId: string; diff: ReturnType<typeof compareCaseDocuments> | null; onOldChange: (value: string) => void; onNewChange: (value: string) => void; onClose: () => void }) {
  return <div className="modal-backdrop"><div className="modal case-version-diff-modal"><div className="modal-header"><div><span className="eyebrow">BB-09 / 版本差异</span><h2>比较结构化用例版本</h2></div><button className="icon-button" type="button" onClick={onClose}><AppIcon name="close" size={16} /></button></div><div className="case-version-selectors"><label className="field-label">基准版本<select className="field-input" value={oldVersionId} onChange={(event) => onOldChange(event.target.value)}>{versions.map((item) => <option key={item.id} value={item.id}>V{item.manifest.version} · {item.manifest.note || "无说明"}</option>)}</select></label><label className="field-label">目标版本<select className="field-input" value={newVersionId} onChange={(event) => onNewChange(event.target.value)}>{versions.map((item) => <option key={item.id} value={item.id}>V{item.manifest.version} · {item.manifest.note || "无说明"}</option>)}</select></label></div>{diff ? <VersionDiffContent diff={diff} /> : <div className="inline-empty large">请选择两个不同版本进行比较</div>}<div className="modal-actions"><button className="button button-primary" type="button" onClick={onClose}>完成</button></div></div></div>;
}

function VersionDiffContent({ diff }: { diff: ReturnType<typeof compareCaseDocuments> }) {
  const total = diff.added.length + diff.deleted.length + diff.modified.length + diff.moved.length;
  return <div className="case-diff-content"><div className="case-diff-summary"><span className="added">新增 <strong>{diff.added.length}</strong></span><span className="deleted">删除 <strong>{diff.deleted.length}</strong></span><span className="modified">修改 <strong>{diff.modified.length}</strong></span><span className="moved">目录移动 <strong>{diff.moved.length}</strong></span></div>{total ? <div className="case-diff-list"><DiffGroup title="新增用例" entries={diff.added} className="added" /><DiffGroup title="删除用例" entries={diff.deleted} className="deleted" /><DiffGroup title="修改字段" entries={diff.modified} className="modified" /><DiffGroup title="目录移动" entries={diff.moved} className="moved" /></div> : <div className="inline-empty large"><AppIcon name="check" size={18} />两个版本没有检测到差异</div>}</div>;
}

function DiffGroup({ title, entries, className }: { title: string; entries: CaseDiffEntry[]; className: string }) {
  if (!entries.length) return null;
  return <section className={`case-diff-group ${className}`}><h3>{title}（{entries.length}）</h3>{entries.map((entry) => <div className="case-diff-row" key={`${title}-${entry.id}`}><strong>{entry.title || entry.id}</strong><span>{entry.fields.join("、")}</span>{entry.before && entry.after && entry.before.directory_id !== entry.after.directory_id && <small className="mono">{entry.before.directory_id} → {entry.after.directory_id}</small>}</div>)}</section>;
}

function mapDirectory(node: CaseDirectoryNode, targetId: string, update: (node: CaseDirectoryNode) => CaseDirectoryNode): CaseDirectoryNode {
  if (node.id === targetId) return update(node);
  return { ...node, children: node.children.map((child) => mapDirectory(child, targetId, update)) };
}

function removeDirectory(node: CaseDirectoryNode, targetId: string): CaseDirectoryNode | null {
  const children = node.children.filter((child) => child.id !== targetId).map((child) => removeDirectory(child, targetId)).filter((child): child is CaseDirectoryNode => Boolean(child));
  if (node.id === targetId) return null;
  return { ...node, children };
}

function normalizeManifest(value: unknown, fallbackId: string, requirementId: string, platformId: string): CaseVersionManifest {
  const raw = isRecord(value) ? value : {};
  return {
    ...raw,
    version_id: typeof raw.version_id === "string" && raw.version_id ? raw.version_id : fallbackId,
    version: typeof raw.version === "number" ? raw.version : parseVersionNumber(typeof raw.version_id === "string" ? raw.version_id : fallbackId),
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    created_by: typeof raw.created_by === "string" ? raw.created_by : "未知",
    source_task: typeof raw.source_task === "string" ? raw.source_task : null,
    case_count: typeof raw.case_count === "number" ? raw.case_count : 0,
    fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : "",
    note: typeof raw.note === "string" ? raw.note : "",
    requirement_id: typeof raw.requirement_id === "string" ? raw.requirement_id : requirementId,
    platform_id: typeof raw.platform_id === "string" ? raw.platform_id : platformId,
  };
}

function nextVersionNumber(versions: LoadedVersion[]): number {
  return versions.reduce((max, item) => Math.max(max, item.manifest.version), 0) + 1;
}

function parseVersionNumber(value: string): number {
  const match = value.match(/^v(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function countMarkdownChanges(value: string): number | null {
  const count = (value.match(/^## /gm) || []).length;
  return count || null;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isMissingFileError(reason: unknown): boolean {
  const value = String(reason).toLocaleLowerCase();
  return value.includes("不存在")
    || value.includes("找不到")
    || value.includes("not found")
    || value.includes("no such file")
    || value.includes("cannot find")
    || value.includes("os error 2");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
