import { useDraftSave } from "../lib/draftGuard";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ExternalDefectDialog from "../components/ExternalDefectDialog";
import ApiDebugView from "./ApiDebugView";
import {executionEvidence} from "../lib/apiDebugRuntime";
import {apiCaseVerdict,type ApiExecution} from "../lib/apiDebug";
import { defectReferences, defectSummary, mergeReferences, type ExternalReference } from "../services/integrations";
import AppIcon from "../components/AppIcon";
import { api, joinPath } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import { recordActivity, toWorkspaceRelative } from "../lib/requirementFlow";
import type {
  CaseDirectoryNode,
  CasePriority,
  CasesDocument,
  PlatformInfo,
  RequirementMeta,
  StructuredTestCase,
  TestCaseResult,
  TestEvidence,
  TestResultSeverity,
  TestResultStatus,
  TestResultsDocument,
  TestRunDocument,
  TestRunStats,
  WorkspaceConfig,
} from "../lib/types";
import { useBusinessRefresh } from "../lib/businessEvents";
import { applyCaseRevision, caseContentEqual, commitRevision, createCaseChangeEvent, jsonWrite, projectExecutionRevision, proposeCaseRevision, readRevisionFile, sameDocument, type CasePatch } from "../lib/caseRevision";
import { CASE_TEST_TYPES } from "../lib/types";
import { caseActions, caseExpectedResults, createCaseId, normalizeCasesDocument } from "../lib/cases";
import {
  TEST_EXECUTION_DIRECTORY,
  caseDirectoryOptions,
  createTestCaseResult,
  createTestResults,
  createTestRunId,
  directoryPathMap,
  evidenceTypeLabel,
  getTestRunStats,
  inferEvidenceType,
  normalizeSnapshot,
  normalizeTestResults,
  normalizeTestRun,
  normalizeVersionManifest,
  sanitizeEvidenceFileName,
  testResultSeverityLabel,
  testResultStatusLabel,
  type TestCaseVersionRecord,
  type TestRunRecord,
} from "../lib/testExecution";

interface TestExecutionViewProps {
  workspace: WorkspaceConfig;
  initialPlatformId?: string;
  initialRequirementId?: string;
  initialRunId?: string;
  /** 每次定位请求递增的标识，用于同一Tab内重复选中轮次 */
  focusKey?: number;
  readOnly?: boolean;
  onOpenReport?: (runId: string) => void;
  onRightContext?: import("../lib/workbench").RightContextReporter;
  onDirtyChange?: (dirty: boolean) => void;
}

type ScopeMode = "all" | "selected";
type FilterStatus = "all" | "needs_retest" | TestResultStatus;

interface PendingEvidenceFile {
  id: string;
  file: File;
  name: string;
}

interface EvidencePreviewTarget {
  runPath: string;
  caseId: string;
  item: TestEvidence;
}

const RESULT_STATUSES: TestResultStatus[] = ["not_executed", "passed", "failed", "blocked", "skipped", "not_applicable"];
const RESULT_SEVERITIES: TestResultSeverity[] = ["none", "low", "medium", "high", "critical"];

export default function TestExecutionView({ workspace, initialPlatformId, initialRequirementId, initialRunId, focusKey, readOnly = false, onOpenReport, onRightContext, onDirtyChange }: TestExecutionViewProps) {
  const rootPath = workspace.workspace.root_path;
  const activePlatforms = useMemo(() => workspace.platforms.filter((platform) => platform.status !== "archived"), [workspace.platforms]);
  const initialPlatform = initialPlatformId && activePlatforms.some((platform) => platform.id === initialPlatformId) ? initialPlatformId : activePlatforms[0]?.id || "";
  const [platformId, setPlatformId] = useState(initialPlatform);
  const [requirementId, setRequirementId] = useState(initialRequirementId || "");
  const [requirements, setRequirements] = useState<RequirementMeta[]>([]);
  const [versions, setVersions] = useState<TestCaseVersionRecord[]>([]);
  const [runs, setRuns] = useState<TestRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState(initialRunId || "");
  const appliedRunKey = useRef("");
  const [resultDocument, setResultDocument] = useState<TestResultsDocument | null>(null);
  const [resultDirty, setResultDirty] = useState(false);
  // 未保存的执行结果上报给Tab条：关闭Tab时会有未保存确认
  
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");
  const [directoryFilter, setDirectoryFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [caseEditor, setCaseEditor] = useState<{ mode: "edit" | "add"; caseId?: string } | null>(null);
  const [apiCase,setApiCase] = useState<{id:string;runId:string;title:string;fingerprint:string;notes:string}|null>(null);
  const [apiDirty,setApiDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(resultDirty || Boolean(caseEditor) || apiDirty); }, [resultDirty, caseEditor, apiDirty, onDirtyChange]);
  const [bugDialogCaseId, setBugDialogCaseId] = useState<string | null>(null);
  const [linkBugDialogCaseId, setLinkBugDialogCaseId] = useState<string | null>(null);
  const [failPromptCaseId, setFailPromptCaseId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [scopeCaseIds, setScopeCaseIds] = useState<Set<string>>(new Set());
  const [createDraft, setCreateDraft] = useState<CreateRunDraft>(emptyCreateDraft());
  const evidenceInputRef = useRef<HTMLInputElement>(null);
  /// selectRun 定义在下方，右侧大纲的轮次切换通过 ref 调用以保证走自动保存逻辑
  const selectRunRef = useRef<(id: string) => void>((id) => setSelectedRunId(id));
  const [pendingEvidenceFiles, setPendingEvidenceFiles] = useState<PendingEvidenceFile[]>([]);
  const [evidencePreview, setEvidencePreview] = useState<EvidencePreviewTarget | null>(null);

  const platform = activePlatforms.find((item) => item.id === platformId);
  const requirement = requirements.find((item) => item.requirement.id === requirementId);
  const selectedRecord = runs.find((item) => item.id === selectedRunId) || null;
  const selectedSnapshot = selectedRecord?.snapshot || null;
  const selectedRun = selectedRecord?.run || null;
  const effectiveReadOnly = readOnly || requirement?.client_access.mode === "locked_for_ai";
  const selectedResult = resultDocument?.results.find((item) => item.case_id === selectedCaseId) || null;
  const directoryMap = useMemo(() => selectedSnapshot ? directoryPathMap(selectedSnapshot.tree) : new Map<string, string>(), [selectedSnapshot]);
  const directoryOptions = useMemo(() => selectedSnapshot ? caseDirectoryOptions(selectedSnapshot) : [], [selectedSnapshot]);
  const caseById = useMemo(() => new Map(selectedSnapshot?.cases.map((item) => [item.id, item]) || []), [selectedSnapshot]);
  const resultMap = useMemo(() => new Map(resultDocument?.results.map((item) => [item.case_id, item]) || []), [resultDocument]);
  const stats = useMemo<TestRunStats>(() => getTestRunStats(resultDocument?.results || [], resultDocument?.case_change_history || []), [resultDocument]);

  // BB-16D：上报轮次大纲（含进度）与选中轮次属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "run",
      objectId: selectedRun?.run_id || requirementId,
      title: selectedRun ? selectedRun.name || selectedRun.run_id : "测试执行",
      subtitle: `${platform?.name || platformId} · ${requirementId || "未选择需求"}`,
      path: selectedRecord ? joinPath(rootPath, selectedRecord.path) : undefined,
      platformId: platform?.id || platformId,
      requirementId: requirementId || undefined,
      readOnly: effectiveReadOnly,
      outlineTitle: "执行轮次",
      outline: runs.map((record) => {
        const runStats = getTestRunStats(record.results.results || [], record.results.case_change_history || []);
        return { id: record.id, label: record.run.name || record.run.run_id || record.id, badge: `${runStats.progress}%`, icon: "test", active: record.id === selectedRunId, onSelect: () => selectRunRef.current(record.id) };
      }),
      properties: selectedRun ? [
        { label: "轮次ID", value: selectedRun.run_id, mono: true },
        { label: "轮次名称", value: selectedRun.name || "—" },
        { label: "用例版本", value: selectedRun.case_version_id || "—", mono: true },
        { label: "测试环境", value: selectedRun.environment || "未填写" },
        { label: "执行人", value: selectedRun.executor || "未填写" },
        { label: "计划时间", value: selectedRun.planned_at || "未排期" },
        { label: "创建时间", value: selectedRun.created_at || "—" },
      ] : [{ label: "状态", value: "未选择轮次" }],
      stats: [
        { label: "登记进度", value: `${stats.progress}%（${stats.registered}/${stats.total}）` },
        { label: "实际执行", value: `${stats.executed}/${stats.applicable}` },
        { label: "通过", value: String(stats.passed) },
        { label: "失败", value: String(stats.failed) },
        { label: "阻塞", value: String(stats.blocked) },
        { label: "轮次数", value: String(runs.length) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, selectedRun, selectedRecord, runs, selectedRunId, stats, platform, platformId, requirementId, effectiveReadOnly, rootPath]);
  const filteredCases = useMemo(() => {
    if (!selectedSnapshot || !resultDocument) return [];
    const keyword = search.trim().toLocaleLowerCase();
    const tag = tagFilter.trim().toLocaleLowerCase();
    return selectedSnapshot.cases.filter((item) => {
      const result = resultMap.get(item.id);
      if (!result) return false;
      if (directoryFilter !== "all" && item.directory_id !== directoryFilter) return false;
      if (priorityFilter !== "all" && String(item.priority) !== priorityFilter) return false;
      if (typeFilter !== "all" && item.test_type !== typeFilter) return false;
      if (statusFilter === "needs_retest" ? !result.needs_retest : statusFilter !== "all" && (result.status !== statusFilter || result.needs_retest)) return false;
      if (tag && !item.tags.some((value) => value.toLocaleLowerCase().includes(tag))) return false;
      if (keyword && ![item.title, item.test_type, item.tags.join(" "), result.actual_result, result.notes].join(" ").toLocaleLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [directoryFilter, priorityFilter, resultDocument, resultMap, search, selectedSnapshot, statusFilter, tagFilter, typeFilter]);

  const loadRequirements = useCallback(async () => {
    if (!platform) {
      setRequirements([]);
      setRequirementId("");
      return;
    }
    try {
      const items = await api.scanRequirements(rootPath, platform.path);
      setRequirements(items);
      setRequirementId((current) => items.some((item) => item.requirement.id === current)
        ? current
        : items.some((item) => item.requirement.id === initialRequirementId) ? initialRequirementId || "" : items[0]?.requirement.id || "");
    } catch (reason) {
      setRequirements([]);
      setRequirementId("");
      setError(`读取需求失败：${String(reason)}`);
    }
  }, [initialRequirementId, platform, rootPath]);

  const loadVersions = useCallback(async () => {
    if (!platform || !requirementId) {
      setVersions([]);
      return;
    }
    const versionsPath = joinPath(rootPath, platform.path, requirementId, "04-测试用例", "versions");
    try {
      const entries = await api.listDirectory(versionsPath);
      const loaded = await Promise.all(entries.filter((entry) => entry.is_dir && !entry.name.startsWith(".")).map(async (entry) => {
        try {
          const [manifestValue, casesValue] = await Promise.all([
            api.readJsonFile(joinPath(entry.path, "manifest.json")),
            api.readJsonFile(joinPath(entry.path, "cases.json")),
          ]);
          return {
            id: entry.name,
            path: entry.path,
            manifest: normalizeVersionManifest(manifestValue, entry.name, requirementId, platform.id),
            data: normalizeSnapshot(casesValue, requirementId, platform.name, platform.id),
          };
        } catch {
          return null;
        }
      }));
      setVersions(loaded.filter((item): item is TestCaseVersionRecord => Boolean(item)).sort((left, right) => right.manifest.version - left.manifest.version));
    } catch {
      setVersions([]);
    }
  }, [platform, requirementId, rootPath]);

  const loadRuns = useCallback(async () => {
    if (!platform || !requirementId) {
      setRuns([]);
      setSelectedRunId("");
      return;
    }
    const runsPath = joinPath(rootPath, platform.path, requirementId, TEST_EXECUTION_DIRECTORY);
    setLoadingRuns(true);
    try {
      const entries = await api.listDirectory(runsPath);
      const loaded = await Promise.all(entries.filter((entry) => entry.is_dir).map(async (entry) => {
        try {
          const [runValue, snapshotValue, resultsValue] = await api.readJsonFiles([
            joinPath(entry.path, "run.json"), joinPath(entry.path, "cases-snapshot.json"), joinPath(entry.path, "results.json"),
          ]);
          const run = normalizeTestRun(runValue, entry.name, requirementId, platform.id);
          return {
            id: entry.name,
            path: entry.path,
            run,
            snapshot: normalizeSnapshot(snapshotValue, requirementId, platform.name, platform.id),
            results: normalizeTestResults(resultsValue, run.run_id),
          };
        } catch {
          return null;
        }
      }));
      const next = loaded.filter((item): item is TestRunRecord => Boolean(item)).sort((left, right) => right.run.created_at.localeCompare(left.run.created_at));
      setRuns(next);
      setSelectedRunId((current) => next.some((item) => item.id === current) ? current : next[0]?.id || "");
    } catch {
      setRuns([]);
      setSelectedRunId("");
    } finally {
      setLoadingRuns(false);
    }
  }, [platform, requirementId, rootPath]);

  useEffect(() => { void loadRequirements(); }, [loadRequirements]);
  useEffect(() => {
    setLoading(true);
    setError(null);
    void Promise.all([loadVersions(), loadRuns()]).finally(() => setLoading(false));
  }, [loadRuns, loadVersions]);
  // 外部定位请求（左侧执行树轮次节点）：轮次列表就绪后选中指定 run
  useEffect(() => {
    if (!initialRunId) return;
    const key = `${initialRunId}#${focusKey ?? "mount"}`;
    if (appliedRunKey.current === key) return;
    const target = runs.find((item) => item.id === initialRunId || item.run.run_id === initialRunId);
    if (target) {
      appliedRunKey.current = key;
      selectRunRef.current(target.id);
    }
  }, [focusKey, initialRunId, runs]);
  /// 只在轮次真正切换、或轮次结果被外部重载且本地无未保存修改时，才重置文档/选中/筛选。
  /// 自己保存（persistResults）时 record.results 与 resultDocument 是同一引用，不会误重置筛选。
  const lastRunIdRef = useRef("");
  useEffect(() => {
    if (!selectedRecord) {
      lastRunIdRef.current = "";
      setResultDocument(null);
      setSelectedCaseId("");
      setResultDirty(false);
      return;
    }
    const runChanged = lastRunIdRef.current !== selectedRecord.id;
    if (!runChanged && (resultDirty || selectedRecord.results === resultDocument)) return;
    lastRunIdRef.current = selectedRecord.id;
    // 不克隆：与 record.results 保持同一引用，自己保存触发的重渲染才能被上面的守卫识别跳过；
    // resultDocument 的更新都是不可变更新，不会污染 record.results
    setResultDocument(selectedRecord.results);
    setSelectedCaseId((current) => selectedRecord.snapshot.cases.some((item) => item.id === current) ? current : selectedRecord.snapshot.cases.find((item) => selectedRecord.results.results.some((result) => result.case_id === item.id && !result.deleted))?.id || "");
    setResultDirty(false);
    if (runChanged) {
      setStatusFilter("all"); setDirectoryFilter("all"); setPriorityFilter("all");
      setTypeFilter("all"); setTagFilter(""); setSearch("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRecord, resultDocument, resultDirty]);
  useEffect(() => {
    if (filteredCases.length && !filteredCases.some((item) => item.id === selectedCaseId)) flushThen(() => setSelectedCaseId(filteredCases[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredCases, selectedCaseId]);

  const updateResult = (caseId: string, patch: Partial<TestCaseResult>) => {
    if (effectiveReadOnly || !resultDocument) return;
    const now = new Date().toISOString();
    setResultDocument((current) => current ? { ...current, results: current.results.map((item) => item.case_id === caseId ? { ...item, ...patch, ...(patch.status ? { case_revision: Number(caseById.get(caseId)?.revision || caseById.get(caseId)?.version || 1), needs_retest: false } : {}), updated_at: now } : item) } : current);
    setResultDirty(true);
    setMessage(null);
    setError(null);
  };

  const persistResults = async (nextDocument: TestResultsDocument) => {
    if (!selectedRecord || effectiveReadOnly) return false;
    setSaving(true);
    setError(null);
    try {
      const next = { ...nextDocument, updated_at: new Date().toISOString() };
      const path = joinPath(selectedRecord.path, "results.json");
      const file = await readRevisionFile(path);
      if (JSON.stringify(normalizeTestResults(file.value, selectedRecord.id)) !== JSON.stringify(selectedRecord.results)) throw new Error("执行结果已被其他页面修改，请合并后保存；草稿已保留");
      await commitRevision(joinPath(rootPath, platform!.path, requirementId), createCaseId("results"), [jsonWrite(path, file.bytes, next)]);
      setResultDocument(next);
      setRuns((current) => current.map((item) => item.id === selectedRecord.id ? { ...item, results: next } : item));
      setResultDirty(false);
      setMessage("执行结果已保存");
      if (platform) {
        recordActivity(rootPath, platform.path, requirementId, {
          action: "test_results_saved",
          summary: `保存执行结果（${selectedRun?.name || selectedRecord.id}）`,
          object_id: selectedRecord.id,
          refs: [toWorkspaceRelative(rootPath, joinPath(selectedRecord.path, "results.json"))],
        });
      }
      return true;
    } catch (reason) {
      setError(`保存执行结果失败：${String(reason)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  useDraftSave(async () => { if (caseEditor || !resultDocument) return false; return persistResults(resultDocument); });

  const saveResults = async () => {
    if (!resultDocument) return;
    await persistResults(resultDocument);
  };

  /// 离开当前上下文（换用例/轮次/需求/平台）前自动落盘未保存结果；保存失败则不切换，避免丢修改
  const flushThen = (apply: () => void) => {
    if (resultDirty && resultDocument && !effectiveReadOnly) {
      void persistResults(resultDocument).then((saved) => { if (saved) apply(); });
      return;
    }
    apply();
  };

  const selectCase = (nextId: string) => {
    if (nextId !== selectedCaseId) flushThen(() => setSelectedCaseId(nextId));
  };

  /// 状态按钮：标为失败时弹出选择——提交新缺陷 / 关联已有缺陷 / 仅标记
  const applyStatusAction = (caseId: string, status: TestResultStatus) => {
    updateResult(caseId, { status });
    if (status === "failed" && resultMap.get(caseId)?.status !== "failed") setFailPromptCaseId(caseId);
  };

  /// 外部缺陷提交/关联成功后：把缺陷信息记到结果行、未执行的用例自动标为失败、立即落盘并写活动台账
  const handleBugSubmitted = async (caseId: string, ref: ExternalReference, source: "created" | "linked" = "created"): Promise<boolean> => {
    if (!resultDocument || effectiveReadOnly) return false;
    const now = new Date().toISOString();
    const nextDocument = { ...resultDocument, results: resultDocument.results.map(item => item.case_id === caseId ? { ...item, external_refs: mergeReferences(defectReferences(item), [ref]), ...(item.status === "not_executed" ? { status: "failed" as TestResultStatus } : {}), updated_at: now } : item) };
    setResultDocument(nextDocument);
    setResultDirty(true);
    const saved = await persistResults(nextDocument);
    if (saved && platform && selectedRun) recordActivity(rootPath, platform.path, requirementId, { action: source === "linked" ? "external_defect_linked" : "external_defect_submitted", summary: `${ref.display_key || ref.external_id}: ${ref.title}`, object_id: selectedRun.run_id });
    return Boolean(saved);
  };

  // Accept API evidence only for the original case and run, preserving existing execution facts.
  const applyApiExecution = async (execution:ApiExecution):Promise<boolean> => {
    if(!apiCase||!selectedRecord||!resultDocument||effectiveReadOnly||apiCase.runId!==selectedRecord.id)throw Error("用例或轮次已变化，请重新进入接口调试");
    const item=selectedSnapshot?.cases.find(c=>c.id===apiCase.id);
    const result=resultDocument.results.find(r=>r.case_id===apiCase.id);
    if(!item||!result||result.deleted||JSON.stringify(item)!==apiCase.fingerprint)throw Error("用例已修订或删除，未覆盖原结果；请核对后重新执行接口");
    const relativePath=joinPath('evidence',`api-${execution.id}.json`),path=joinPath(selectedRecord.path,relativePath),bytes=new TextEncoder().encode(executionEvidence(execution));
    const existing=await api.getPathInfo(path).catch(()=>null);if(!existing?.exists)await api.createBinaryFile(path,bytes);
    const verdict=apiCaseVerdict(execution,result.status);
    const summary=`${execution.request_name} · ${execution.environment_name||execution.environment_id||'无环境'} · ${execution.response?`HTTP ${execution.response.status} / ${execution.response.elapsed_ms} ms`:'未收到响应'} · ${execution.checks.length} 项断言 · ${execution.outcome}${execution.error?` · ${execution.error}`:''}`;
    const evidence:TestEvidence={id:execution.id,path:relativePath,name:`接口执行-${execution.request_name}.json`,type:'request_response',size:bytes.length,mime_type:'application/json',added_at:execution.created_at};
    const next={...resultDocument,results:resultDocument.results.map(r=>r.case_id===apiCase.id?{...r,status:verdict.status as TestResultStatus,...(verdict.resetRetest?{needs_retest:false}:{}),actual_result:r.evidence.some(e=>e.id===execution.id)?r.actual_result:[r.actual_result,summary].filter(Boolean).join('\n'),evidence:r.evidence.some(e=>e.id===execution.id)?r.evidence:[...r.evidence,evidence],updated_at:new Date().toISOString()}:r)};
    setResultDocument(next);setResultDirty(true);return persistResults(next);
  };

  // Both execution and review use the same ID-based proposal/commit service.
  const commitExecutionPatch = async (patch: CasePatch) => {
    if (!selectedRecord || !selectedSnapshot || !selectedRun || !resultDocument || !platform) return;
    const requirementDir = joinPath(rootPath, platform.path, requirementId);
    const liveFile = await readRevisionFile(joinPath(requirementDir, "04-测试用例", "cases.json"));
    if (!liveFile.value) throw new Error("当前设计集不存在，未同步；请创建后重试。草稿保留");
    const live = normalizeCasesDocument(liveFile.value, requirementId, platform.name, platform.id);
    const currentCase = live.cases.find((item) => item.id === patch.case_id) || null;
    if (!caseContentEqual(currentCase, patch.before)) throw new Error(`待同步：当前设计集 ${patch.case_id} 与本轮内容冲突，未提交；请核对差异后重试，草稿保留`);
    const proposal = await proposeCaseRevision(live, [{ ...patch, before: currentCase }]);
    const event = createCaseChangeEvent(patch, selectedRun.run_id);
    const projected = projectExecutionRevision(selectedSnapshot, selectedRun, resultDocument, [event]);
    if (!projected.run.baseline_fingerprint) {
      const baseline = versions.find((item) => item.id === selectedRun.case_version_id);
      projected.run.baseline_fingerprint = baseline?.manifest.fingerprint || null;
    }
    const snapshotPath = joinPath(selectedRecord.path, "cases-snapshot.json");
    const resultsPath = joinPath(selectedRecord.path, "results.json");
    const runPath = joinPath(selectedRecord.path, "run.json");
    const [snapshotFile, resultsFile, runFile] = await Promise.all([readRevisionFile(snapshotPath), readRevisionFile(resultsPath), readRevisionFile(runPath)]);
    if (!sameDocument(snapshotFile.value, selectedSnapshot)
      || JSON.stringify(normalizeTestResults(resultsFile.value, selectedRun.run_id)) !== JSON.stringify(selectedRecord.results)
      || JSON.stringify(normalizeTestRun(runFile.value, selectedRecord.id, requirementId, platform.id)) !== JSON.stringify(selectedRun)) throw new Error("轮次数据已变化，未提交；草稿保留，请核对后重试");
    await applyCaseRevision(requirementDir, proposal, live, live.tree, [
      jsonWrite(snapshotPath, snapshotFile.bytes, projected.snapshot),
      jsonWrite(resultsPath, resultsFile.bytes, projected.results),
      jsonWrite(runPath, runFile.bytes, projected.run),
    ], [event]);
    setResultDocument(projected.results);
    setResultDirty(false);
    setRuns((current) => current.map((item) => item.id === selectedRecord.id ? { ...item, ...projected } : item));
    setCaseEditor(null);
    setMessage("用例、本轮工作快照、当前设计集及变更原因已一并保存；正式基线保持原版本");
    return projected;
  };

  const saveCaseEdit = async (draft: CaseEditDraft) => {
    if (!selectedRecord || !selectedSnapshot || !caseEditor || effectiveReadOnly || saving) return;
    const original = caseEditor.mode === "add" ? null : selectedSnapshot.cases.find((item) => item.id === caseEditor.caseId) || null;
    const caseId = original?.id || createCaseId("case");
    const after: StructuredTestCase = {
      ...(original || { id: caseId, created_by: "user", version: 1, status: "draft", tags: [], platforms: [], requirement_refs: [], asset_refs: [], requires_evidence: false, automation_status: "none" }),
      title: draft.title.trim(), priority: draft.priority, test_type: draft.test_type,
      preconditions: draft.preconditions, expected_results: draft.expected_results, directory_id: draft.directory_id,
      steps: draft.actions.filter((action) => action.trim()).map((action, index, actions) => ({ order: index + 1, action: action.trim(), expected: index === actions.length - 1 ? draft.expected_results : [] })),
    };
    if (!after.title) { setError("请填写用例标题"); return; }
    setSaving(true); setError(null);
    try {
      await commitExecutionPatch({ case_id: caseId, before: original, after, reason: draft.reason, source: "execution_editor", origin: "human", actor: null, related_case_ids: [...(draft.related_case_ids || []), ...(caseEditor.caseId && caseEditor.mode === "add" ? [caseEditor.caseId] : [])] });
      setSelectedCaseId(caseId);
      return true;
    } catch (reason) { setError(String(reason)); return false; } finally { setSaving(false); }
  };

  const deleteCase = async (caseId: string, reason: string) => {
    const original = selectedSnapshot?.cases.find((item) => item.id === caseId);
    if (!original || effectiveReadOnly || saving) return;
    setSaving(true); setError(null);
    try {
      const index = selectedSnapshot!.cases.findIndex((item) => item.id === caseId);
      const projected = await commitExecutionPatch({ case_id: caseId, before: original, after: null, reason, source: "execution_editor", origin: "human", actor: null });
      setSelectedCaseId(projected?.snapshot.cases[Math.max(0, index - 1)]?.id || projected?.snapshot.cases[0]?.id || "");
    } catch (error) { setError(String(error)); } finally { setSaving(false); }
  };

  useBusinessRefresh([joinPath(rootPath, platform?.path || "", requirementId)], resultDirty || Boolean(caseEditor) || saving,
    () => { void loadVersions(); void loadRuns(); },
    () => setMessage("磁盘数据已更新，当前草稿保留；保存会校验冲突，请核对后合并"));

  const openCreate = () => {
    if (!versions.length) {
      setError("当前需求没有已提交用例版本，请先在结构化用例中提交版本");
      return;
    }
    const selectedVersion = versions[0];
    setCreateDraft({
      ...emptyCreateDraft(),
      name: `${requirementId} 测试轮次`,
      caseVersionId: selectedVersion.id,
      branch: requirement?.applications[0]?.branch || "",
    });
    setScopeMode("all");
    setScopeCaseIds(new Set(selectedVersion.data.cases.map((item) => item.id)));
    setShowCreateDialog(true);
    setError(null);
  };

  const createRun = async () => {
    if (!platform || !requirement || !requirementId) return;
    const selectedVersion = versions.find((item) => item.id === createDraft.caseVersionId) || versions[0];
    const caseIds = scopeMode === "all" ? selectedVersion.data.cases.map((item) => item.id) : [...scopeCaseIds];
    if (!createDraft.name.trim() || !caseIds.length) {
      setError("请填写测试轮次名称并至少选择一条执行用例");
      return;
    }
    setSaving(true);
    setError(null);
    const now = new Date().toISOString();
    const runId = createTestRunId();
    const runPath = joinPath(rootPath, platform.path, requirementId, TEST_EXECUTION_DIRECTORY, runId);
    const run: TestRunDocument = {
      version: "1.0",
      run_id: runId,
      requirement_id: requirementId,
      platform_id: platform.id,
      name: createDraft.name.trim(),
      case_version_id: selectedVersion.id,
      working_revision: 0, baseline_fingerprint: selectedVersion.manifest.fingerprint,
      case_version: selectedVersion.manifest.version,
      environment: createDraft.environment.trim(),
      application_versions: createDraft.applicationVersions.trim(),
      branch: createDraft.branch.trim(),
      executor: createDraft.executor.trim(),
      planned_at: createDraft.plannedAt || null,
      execution_scope: { case_ids: caseIds, description: createDraft.scopeDescription.trim() },
      created_at: now,
      updated_at: now,
      created_by: "用户",
    };
    const snapshot = { ...clone(selectedVersion.data), version_id: selectedVersion.id, snapshot_of_version: selectedVersion.id, snapshot_at: now };
    const results = createTestResults(runId, caseIds, now);
    try {
      await commitRevision(joinPath(rootPath, platform.path, requirementId), runId, [
        jsonWrite(joinPath(runPath, "run.json"), null, run),
        jsonWrite(joinPath(runPath, "cases-snapshot.json"), null, snapshot),
        jsonWrite(joinPath(runPath, "results.json"), null, results),
      ]);
      setShowCreateDialog(false);
      setMessage(`已创建测试轮次“${run.name}”，快照 ${caseIds.length} 条用例`);
      recordActivity(rootPath, platform.path, requirementId, {
        action: "test_run_created",
        summary: `创建测试轮次“${run.name}”，快照 ${caseIds.length} 条用例（版本 ${selectedVersion.id}）`,
        object_id: runId,
        refs: [toWorkspaceRelative(rootPath, joinPath(runPath, "run.json"))],
      });
      await loadRuns();
      setSelectedRunId(runId);
    } catch (reason) {
      setError(`创建测试轮次失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleEvidenceFiles = (files: File[]) => {
    if (!selectedRecord || !selectedResult || effectiveReadOnly || !resultDocument || !files.length) return;
    setError(null);
    setMessage(null);
    setPendingEvidenceFiles(files.map((file) => ({
      id: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name || "粘贴图片",
    })));
  };

  const saveEvidenceFiles = async (files: PendingEvidenceFile[]) => {
    if (!selectedRecord || !selectedResult || effectiveReadOnly || !resultDocument || !files.length) return;
    setSaving(true);
    setError(null);
    try {
      let nextDocument = clone(resultDocument);
      for (const draft of files) {
        const name = draft.name.trim();
        if (!name) throw new Error("截图名称不能为空");
        const relativePath = joinPath("evidence", `${draft.id}-${sanitizeEvidenceFileName(name)}`);
        const path = joinPath(selectedRecord.path, relativePath);
        const bytes = new Uint8Array(await draft.file.arrayBuffer());
        const info = await api.getPathInfo(path).catch(() => null);
        if (info?.exists) await api.writeBinaryFile(path, bytes);
        else await api.createBinaryFile(path, bytes);
        const evidence: TestEvidence = {
          id: draft.id,
          path: relativePath,
          name,
          type: inferEvidenceType({ name, type: draft.file.type }),
          size: draft.file.size,
          mime_type: draft.file.type || "application/octet-stream",
          added_at: new Date().toISOString(),
        };
        nextDocument = {
          ...nextDocument,
          results: nextDocument.results.map((item) => item.case_id === selectedResult.case_id ? { ...item, evidence: [...item.evidence, evidence], updated_at: new Date().toISOString() } : item),
        };
      }
      const saved = await persistResults(nextDocument);
      if (!saved) return;
      setPendingEvidenceFiles([]);
      setMessage(`已保存 ${files.length} 个证据文件`);
    } catch (reason) {
      setError(`上传证据失败：${String(reason)}`);
      setSaving(false);
    }
  };

  const saveEvidenceName = async (target: EvidencePreviewTarget, name: string) => {
    if (!selectedRecord || !resultDocument || effectiveReadOnly) return false;
    const trimmed = name.trim();
    if (!trimmed) throw new Error("截图名称不能为空");
    if (selectedRecord.path !== target.runPath) throw new Error("测试轮次已切换，请重新打开截图后修改名称");
    const targetResult = resultDocument.results.find((item) => item.case_id === target.caseId);
    if (!targetResult?.evidence.some((item) => item.id === target.item.id)) throw new Error("截图证据已不存在，请重新加载执行结果");
    const nextDocument = {
      ...resultDocument,
      results: resultDocument.results.map((item) => item.case_id === target.caseId
        ? { ...item, evidence: item.evidence.map((evidence) => evidence.id === target.item.id ? { ...evidence, name: trimmed } : evidence), updated_at: new Date().toISOString() }
        : item),
    };
    const saved = await persistResults(nextDocument);
    if (saved) {
      setEvidencePreview({ ...target, item: { ...target.item, name: trimmed } });
      setMessage("截图名称已更新");
    }
    return saved;
  };

  const handleEvidencePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const clipboardFiles = Array.from(event.clipboardData.files || []);
    const files = clipboardFiles.length ? clipboardFiles : Array.from(event.clipboardData.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    handleEvidenceFiles(files);
  };

  const selectRun = (nextId: string) => {
    if (nextId !== selectedRunId) flushThen(() => setSelectedRunId(nextId));
  };
  selectRunRef.current = selectRun;

  const selectRequirement = (nextId: string) => {
    if (nextId !== requirementId) flushThen(() => setRequirementId(nextId));
  };

  const onPlatformChange = (nextId: string) => {
    if (nextId === platformId) return;
    flushThen(() => {
      setPlatformId(nextId);
      setRequirementId("");
      setRuns([]);
      setVersions([]);
      setSelectedRunId("");
    });
  };

  // 离开执行页时的兜底落盘：直接写文件，组件已卸载不走 setState

  return (
    <div className="workspace-view test-execution-view">
      <section className="document-header">
        <div className="document-title-row"><span className="document-icon blue"><AppIcon name="test" size={20} /></span><div><div className="eyebrow">BB-11 / 测试执行与证据</div><h1>测试执行与证据</h1><p>从正式基线创建本轮工作快照，保留修订、结果和证据</p></div></div>
        <div className="header-actions"><button className="button button-primary" type="button" disabled={!requirementId || !versions.length || effectiveReadOnly} onClick={openCreate}><AppIcon name="add" size={15} /> 创建测试轮次</button><button className="button button-ghost" type="button" onClick={() => { void loadVersions(); void loadRuns(); }}><AppIcon name="refresh" size={15} /> 刷新</button></div>
      </section>

      <section className="test-execution-source-panel">
        <div className="test-execution-source-grid">
          <label className="field-label">平台<select className="field-input" value={platformId} onChange={(event) => onPlatformChange(event.target.value)}><option value="">选择平台</option>{activePlatforms.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}</select></label>
          <label className="field-label">需求<select className="field-input" value={requirementId} onChange={(event) => selectRequirement(event.target.value)} disabled={!platform || !requirements.length}><option value="">{platform ? "选择需求" : "先选择平台"}</option>{requirements.map((item) => <option key={item.requirement.id} value={item.requirement.id}>{item.requirement.id} · {item.requirement.name}</option>)}</select></label>
          <label className="field-label">测试轮次<select className="field-input" value={selectedRunId} onChange={(event) => selectRun(event.target.value)} disabled={!runs.length || loadingRuns}><option value="">{loadingRuns ? "读取轮次中…" : runs.length ? "选择测试轮次" : "尚未创建轮次"}</option>{runs.map((record) => <option key={record.id} value={record.id}>{record.run.name} · V{record.run.case_version} · {getTestRunStats(record.results.results).progress}%</option>)}</select></label>
        </div>
        {requirement?.client_access.mode === "locked_for_ai" && <div className="unlock-warning"><AppIcon name="lock" size={14} /><span>当前需求正在由AI处理，测试执行结果和证据为只读状态。</span></div>}
        {requirementId && !versions.length && <div className="unlock-warning"><AppIcon name="info" size={14} /><span>该需求还没有“已提交的用例版本”：请先到「结构化用例」页导入/检查用例并点击“提交版本”，再回到这里创建测试轮次。导入 XMind 只生成 cases.json，不会自动形成版本。</span></div>}
      </section>

      {selectedRun && selectedResult && !selectedResult.deleted && !effectiveReadOnly && <div className="api-execution-shortcut"><button className="button button-primary" disabled={saving} onClick={()=>flushThen(()=>{const item=selectedSnapshot?.cases.find(c=>c.id===selectedCaseId);if(item)setApiCase({id:item.id,runId:selectedRun.run_id,title:item.title,fingerprint:JSON.stringify(item),notes:['前置条件',...item.preconditions,'操作步骤',...item.steps.map(s=>s.action),'期望结果',...caseExpectedResults(item)].join('\n')});})}><AppIcon name="code" size={14}/>接口调试 / 快捷执行当前用例</button><small>首次选择接口并绑定；后续自动带入，可保存响应证据和断言结果。</small></div>}
      {!requirementId ? <div className="inline-empty large"><AppIcon name="inbox" size={20} />请选择平台和需求后查看测试轮次。</div> : <div className="test-execution-layout">

        <main className="test-execution-main">{resultDocument && <details className="panel-section"><summary>修订与删除历史（{resultDocument.case_events?.length || resultDocument.case_change_history?.length || 0}） · 删除 {stats.deleted} · 待复测 {stats.needs_retest}</summary><p>登记进度 {stats.progress}%；实际执行 {stats.executed}/{stats.applicable}；通过率 {stats.pass_rate === null ? "—" : `${stats.pass_rate.toFixed(2)}%`}。暂不执行与阻塞仅登记状态，不计实际执行；不适用单列。</p>{(resultDocument.case_change_history || []).map((entry) => { const fact = resultDocument.result_history?.find((item) => item.event_id === entry.id); return <div key={entry.id}><strong>{entry.action} · {entry.title}</strong><p>{entry.reason || "历史未记录原因"} · {entry.changed_at}</p><details><summary>查看修订与原结果</summary><pre>{JSON.stringify({ before: entry.before, after: entry.after, result: fact?.result || null, history_note: fact ? undefined : "历史执行信息未记录，无法恢复" }, null, 2)}</pre></details></div>; })}</details>}{selectedRun && selectedSnapshot && resultDocument ? <RunDetail run={selectedRun} snapshot={selectedSnapshot} resultDocument={resultDocument} stats={stats} evidenceBasePath={selectedRecord?.path || ""} filteredCases={filteredCases} selectedCaseId={selectedCaseId} selectedResult={selectedResult} directoryMap={directoryMap} directoryOptions={directoryOptions} statusFilter={statusFilter} directoryFilter={directoryFilter} priorityFilter={priorityFilter} typeFilter={typeFilter} tagFilter={tagFilter} search={search} saving={saving} resultDirty={resultDirty} readOnly={effectiveReadOnly} evidenceInputRef={evidenceInputRef} onSelectCase={selectCase} onStatusFilter={setStatusFilter} onDirectoryFilter={setDirectoryFilter} onPriorityFilter={setPriorityFilter} onTypeFilter={setTypeFilter} onTagFilter={setTagFilter} onSearch={setSearch} onUpdateResult={updateResult} onSaveResults={() => void saveResults()} onEditCase={() => setCaseEditor({ mode: "edit", caseId: selectedCaseId })} onAddCase={() => setCaseEditor({ mode: "add" })} onDuplicateCase={() => setCaseEditor({ mode: "add", caseId: selectedCaseId })} onReportBug={() => setBugDialogCaseId(selectedCaseId)} onLinkBug={() => setLinkBugDialogCaseId(selectedCaseId)} onStatusAction={applyStatusAction} onEvidenceFiles={(files) => void handleEvidenceFiles(files)} onEvidencePaste={handleEvidencePaste} onOpenReport={onOpenReport} onOpenEvidence={(item) => { if (item.type === "image" && selectedRecord) setEvidencePreview({ runPath: selectedRecord.path, caseId: selectedResult?.case_id || "", item }); else void systemOpen.openFile(joinPath(selectedRecord?.path || "", item.path)); }} /> : <div className="inline-empty large"><AppIcon name="inbox" size={20} />选择一个测试轮次查看执行结果。</div>}</main>
      </div>}
      {message && <div className="toast toast-success"><AppIcon name="check" size={15} /> {message}<button type="button" onClick={() => setMessage(null)}><AppIcon name="close" size={14} /></button></div>}
      {error && <div className="toast toast-error"><AppIcon name="alert" size={15} /> {error}<button type="button" onClick={() => setError(null)}><AppIcon name="close" size={14} /></button></div>}
      {showCreateDialog && <CreateRunDialog draft={createDraft} versions={versions} selectedVersion={versions.find((item) => item.id === createDraft.caseVersionId) || versions[0]} scopeMode={scopeMode} scopeCaseIds={scopeCaseIds} saving={saving} onDraftChange={setCreateDraft} onVersionChange={(id) => { setCreateDraft((current) => ({ ...current, caseVersionId: id })); const version = versions.find((item) => item.id === id); setScopeCaseIds(new Set(version?.data.cases.map((item) => item.id) || [])); }} onScopeModeChange={setScopeMode} onScopeCaseIdsChange={setScopeCaseIds} onClose={() => setShowCreateDialog(false)} onCreate={() => void createRun()} />}
      {caseEditor && selectedSnapshot && <CaseEditDialog key={`${caseEditor.mode}:${caseEditor.caseId || "new"}`} mode={caseEditor.mode} item={caseEditor.caseId ? selectedSnapshot.cases.find((item) => item.id === caseEditor.caseId) || null : null} deletedCases={(resultDocument?.case_change_history || []).filter((item) => item.action === "deleted").map((item) => ({ id: item.case_id, title: item.title }))} directories={directoryOptions} defaultDirectoryId={directoryFilter !== "all" ? directoryFilter : selectedCaseId ? selectedSnapshot.cases.find((item) => item.id === selectedCaseId)?.directory_id || "" : ""} saving={saving} onClose={() => setCaseEditor(null)} onSave={(draft) => saveCaseEdit(draft)} onDelete={caseEditor.mode === "edit" && caseEditor.caseId ? (reason) => void deleteCase(caseEditor.caseId || "", reason) : undefined} />}
      {bugDialogCaseId && selectedRun && selectedSnapshot && (() => {
        const bugItem = selectedSnapshot.cases.find((item) => item.id === bugDialogCaseId);
        const bugResult = resultDocument?.results.find((item) => item.case_id === bugDialogCaseId);
        if (!bugItem || !bugResult || !platform) return null;
        return <ExternalDefectDialog inheritedDefaults={[platform?.integration_defaults, workspace.defaults?.integration_defaults]}
          requirement={requirement || null}
          title={`[BUG] ${bugItem.title}`}
          description={buildBugDescription(bugItem, bugResult, selectedRun, requirement, directoryMap.get(bugItem.directory_id) || "")}
          storageKey={`${rootPath}:${selectedRun.run_id}:${bugItem.id}`}
          onClose={() => setBugDialogCaseId(null)}
          onLinked={(ref) => handleBugSubmitted(bugDialogCaseId, ref)}
        />;
      })()}
      {linkBugDialogCaseId && (() => {
        const linkResult = resultDocument?.results.find((item) => item.case_id === linkBugDialogCaseId);
        if (!linkResult) return null;
        return <ExternalDefectDialog inheritedDefaults={[platform?.integration_defaults, workspace.defaults?.integration_defaults]} mode="link"
          requirement={requirement || null}
          storageKey={`${rootPath}:${selectedRun?.run_id}:${linkResult.case_id}:link`}
          onClose={() => setLinkBugDialogCaseId(null)}
          onLinked={(bug) => handleBugSubmitted(linkBugDialogCaseId, bug, "linked")}
        />;
      })()}
      {failPromptCaseId && <div className="modal-backdrop">
        <div className="modal bug-fail-modal">
          <div className="modal-header"><div><span className="eyebrow">BB-11 / 标记失败</span><h2>用例已标记为失败</h2></div><button className="icon-button" type="button" onClick={() => setFailPromptCaseId(null)}><AppIcon name="close" size={16} /></button></div>
          <p className="modal-description">是否为这条失败用例记录外部缺陷？也可以稍后通过「提交云效 BUG / 关联缺陷」再处理。</p>
          <div className="modal-actions"><span className="modal-action-spacer" /><button className="button button-ghost" type="button" onClick={() => setFailPromptCaseId(null)}>仅标记失败</button><button className="button button-ghost" type="button" onClick={() => { setLinkBugDialogCaseId(failPromptCaseId); setFailPromptCaseId(null); }}>关联已有缺陷</button><button className="button button-primary" type="button" onClick={() => { setBugDialogCaseId(failPromptCaseId); setFailPromptCaseId(null); }}>提交云效 BUG</button></div>
        </div>
      </div>}
      {apiCase && platform && <div className="modal-backdrop"><div className="modal api-debug-case-modal" role="dialog" aria-modal="true" aria-label="当前用例接口调试"><ApiDebugView context={{workspace:rootPath,platform:platform.id,requirement:requirementId,case_id:apiCase.id,case_title:apiCase.title,run_id:apiCase.runId,case_notes:apiCase.notes}} onDirtyChange={setApiDirty} onClose={()=>{setApiCase(null);setApiDirty(false);}} onApply={applyApiExecution}/></div></div>}
      {pendingEvidenceFiles.length > 0 && <EvidenceUploadDialog files={pendingEvidenceFiles} saving={saving} error={error} onCancel={() => setPendingEvidenceFiles([])} onSave={(files) => void saveEvidenceFiles(files)} />}
      {evidencePreview && <EvidencePreviewDialog target={evidencePreview} readOnly={effectiveReadOnly} saving={saving} onClose={() => setEvidencePreview(null)} onSaveName={(name) => saveEvidenceName(evidencePreview, name)} />}
    </div>
  );
}

function EvidenceGallery({ items, basePath, onSelect }: { items: TestEvidence[]; basePath: string; onSelect: (item: TestEvidence) => void }) {
  const images = items.filter((item) => item.type === "image" && item.path);
  if (!images.length) return null;
  return <section className="test-evidence-gallery" aria-label="当前用例截图证据">
    <div className="test-evidence-gallery-list">{images.map((item) => <button className="test-evidence-gallery-item" type="button" key={item.id} onClick={() => onSelect(item)} title={`查看 ${item.name}`}><EvidenceImageThumbnail path={joinPath(basePath, item.path)} mimeType={item.mime_type} name={item.name} /><span>{item.name}</span></button>)}</div>
  </section>;
}

function EvidenceImageThumbnail({ path, mimeType, name }: { path: string; mimeType: string; name: string }) {
  const { url, error } = useEvidenceImageUrl(path, mimeType);
  if (error) return <span className="test-evidence-thumbnail-fallback"><AppIcon name="image" size={18} /></span>;
  if (!url) return <span className="test-evidence-thumbnail-fallback"><span className="spinner" /></span>;
  return <img className="test-evidence-thumbnail" src={url} alt={name} loading="lazy" />;
}

function useEvidenceImageUrl(path: string, mimeType: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    api.readBinaryFile(path).then((bytes) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: resolveImageMimeType(mimeType, path) }));
      setUrl(objectUrl);
    }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, mimeType]);
  return { url, error };
}

function resolveImageMimeType(mimeType: string, path: string): string {
  if (mimeType.startsWith("image/")) return mimeType;
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" } as Record<string, string>)[extension || ""] || "image/png";
}

function EvidenceUploadDialog({ files, saving, error, onCancel, onSave }: { files: PendingEvidenceFile[]; saving: boolean; error: string | null; onCancel: () => void; onSave: (files: PendingEvidenceFile[]) => void }) {
  const [drafts, setDrafts] = useState(files);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => {
    const urls: Record<string, string> = {};
    files.forEach((draft) => {
      if (inferEvidenceType(draft.file) === "image") urls[draft.id] = URL.createObjectURL(draft.file);
    });
    setPreviewUrls(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  const updateName = (id: string, name: string) => setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, name } : draft));
  const save = () => {
    if (drafts.some((draft) => !draft.name.trim())) {
      setNameError("每个证据都需要填写名称");
      return;
    }
    setNameError(null);
    onSave(drafts);
  };
  return <div className="modal-backdrop">
    <div className="modal test-evidence-upload-modal" role="dialog" aria-modal="true" aria-labelledby="evidence-upload-title">
      <div className="modal-header"><div><span className="eyebrow">测试执行 / 证据</span><h2 id="evidence-upload-title">确认截图名称</h2></div><button className="icon-button" type="button" onClick={onCancel} disabled={saving} title="关闭"><AppIcon name="close" size={16} /></button></div>
      <p className="modal-description">确认后会将证据保存到当前用例。复制截图后，可在用例详情区域按 Ctrl+V 或 ⌘+V 粘贴。</p>
      <div className="test-evidence-upload-list">{drafts.map((draft) => {
        const isImage = inferEvidenceType(draft.file) === "image";
        return <div className="test-evidence-upload-item" key={draft.id}>
          <div className="test-evidence-upload-preview">{isImage && previewUrls[draft.id] ? <img src={previewUrls[draft.id]} alt={draft.name || "待上传截图"} /> : <AppIcon name={isImage ? "image" : "file"} size={24} />}</div>
          <div className="test-evidence-upload-fields"><label className="field-label">{isImage ? "截图名称" : "证据名称"}<input className="field-input" value={draft.name} maxLength={120} disabled={saving} onChange={(event) => updateName(draft.id, event.target.value)} autoFocus={drafts[0].id === draft.id} /></label><small>{draft.file.type || "未知类型"} · {formatBytes(draft.file.size)}</small></div>
        </div>;
      })}</div>
      {(nameError || error) && <div className="modal-error"><AppIcon name="error" size={15} /><span>{nameError || error}</span></div>}
      <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onCancel} disabled={saving}>取消</button><button className="button button-primary" type="button" onClick={save} disabled={saving || !drafts.length}>{saving ? "保存中…" : `保存 ${drafts.length} 个证据`}</button></div>
    </div>
  </div>;
}

function EvidencePreviewDialog({ target, readOnly, saving, onClose, onSaveName }: { target: EvidencePreviewTarget; readOnly: boolean; saving: boolean; onClose: () => void; onSaveName: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState(target.item.name);
  const [error, setError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const path = joinPath(target.runPath, target.item.path);
  const { url, error: previewError } = useEvidenceImageUrl(path, target.item.mime_type);
  const save = async () => {
    if (!name.trim()) { setError("截图名称不能为空"); return; }
    setSavingName(true);
    setError(null);
    try {
      const saved = await onSaveName(name.trim());
      if (saved) onClose();
      else setError("名称未保存，请检查执行结果的保存提示后重试");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSavingName(false);
    }
  };
  return <div className="modal-backdrop">
    <div className="modal test-evidence-preview-modal" role="dialog" aria-modal="true" aria-labelledby="evidence-preview-title">
      <div className="modal-header"><div><span className="eyebrow">测试执行 / 截图证据</span><h2 id="evidence-preview-title">截图预览</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={savingName} title="关闭"><AppIcon name="close" size={16} /></button></div>
      <div className="test-evidence-preview-stage">{url ? <img src={url} alt={target.item.name} /> : previewError ? <div className="inline-empty">无法读取截图：{previewError}</div> : <span className="spinner" />}</div>
      <label className="field-label">截图名称<input className="field-input" value={name} maxLength={120} disabled={readOnly || savingName || saving} onChange={(event) => setName(event.target.value)} /></label>
      {(error || (readOnly && <span className="field-hint">当前执行只读，不能修改截图名称。</span>)) && <div className={error ? "modal-error" : "field-hint"}>{error || "当前执行只读，不能修改截图名称。"}</div>}
      <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onClose} disabled={savingName}>关闭</button>{!readOnly && <button className="button button-primary" type="button" onClick={() => void save()} disabled={savingName || saving || name.trim() === target.item.name}>{savingName ? "保存中…" : "保存名称"}</button>}</div>
    </div>
  </div>;
}

interface CreateRunDraft {
  name: string;
  caseVersionId: string;
  environment: string;
  applicationVersions: string;
  branch: string;
  executor: string;
  plannedAt: string;
  scopeDescription: string;
}

function emptyCreateDraft(): CreateRunDraft {
  return { name: "", caseVersionId: "", environment: "", applicationVersions: "", branch: "", executor: "", plannedAt: "", scopeDescription: "" };
}

function RunDetail(props: {
  run: TestRunDocument;
  snapshot: CasesDocument;
  resultDocument: TestResultsDocument;
  stats: TestRunStats;
  evidenceBasePath: string;
  filteredCases: CasesDocument["cases"];
  selectedCaseId: string;
  selectedResult: TestCaseResult | null;
  directoryMap: Map<string, string>;
  directoryOptions: Array<{ id: string; title: string }>;
  statusFilter: FilterStatus;
  directoryFilter: string;
  priorityFilter: string;
  typeFilter: string;
  tagFilter: string;
  search: string;
  saving: boolean;
  resultDirty: boolean;
  readOnly: boolean;
  evidenceInputRef: React.RefObject<HTMLInputElement>;
  onSelectCase: (id: string) => void;
  onStatusFilter: (value: FilterStatus) => void;
  onDirectoryFilter: (value: string) => void;
  onPriorityFilter: (value: string) => void;
  onTypeFilter: (value: string) => void;
  onTagFilter: (value: string) => void;
  onSearch: (value: string) => void;
  onUpdateResult: (caseId: string, patch: Partial<TestCaseResult>) => void;
  onSaveResults: () => void;
  onEditCase: () => void;
  onAddCase: () => void;
  onDuplicateCase: () => void;
  onReportBug: () => void;
  onLinkBug: () => void;
  onStatusAction: (caseId: string, status: TestResultStatus) => void;
  onEvidenceFiles: (files: File[]) => void;
  onEvidencePaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onOpenReport?: (runId: string) => void;
  onOpenEvidence: (item: TestEvidence) => void;
}) {
  const { run, snapshot, stats, evidenceBasePath, filteredCases, selectedCaseId, selectedResult, directoryMap, directoryOptions, statusFilter, directoryFilter, priorityFilter, typeFilter, tagFilter, search, saving, resultDirty, readOnly, evidenceInputRef, onSelectCase, onStatusFilter, onDirectoryFilter, onPriorityFilter, onTypeFilter, onTagFilter, onSearch, onUpdateResult, onSaveResults, onEditCase, onAddCase, onDuplicateCase, onReportBug, onLinkBug, onStatusAction, onEvidenceFiles, onEvidencePaste, onOpenReport, onOpenEvidence } = props;
  const selectedCase = snapshot.cases.find((item) => item.id === selectedCaseId) || null;
  const testTypes = [...new Set(snapshot.cases.map((item) => item.test_type).filter(Boolean))];
  const [showRunInfo, setShowRunInfo] = useState(false);
  return <div className="test-run-detail"><section className="panel-section test-run-header"><div className="test-run-heading"><div><span className="eyebrow">测试轮次 · {run.run_id}</span><h2>{run.name}</h2><div className="test-run-meta"><span>用例版本 V{run.case_version}</span><span>{run.environment || "未填写环境"}</span><span>{run.executor || "未填写执行人"}</span><span>{run.branch || "未填写分支"}</span></div></div><div className="header-actions"><span className="status-pill test-run-progress-pill">{stats.progress}% 完成 · {run.execution_scope.case_ids.length} 条用例</span><button className="button button-ghost button-small" type="button" title={showRunInfo ? "收起统计与信息" : "展开统计与信息"} onClick={() => setShowRunInfo((value) => !value)}><AppIcon name={showRunInfo ? "down" : "next"} size={13} /> {showRunInfo ? "收起统计" : "展开统计"}</button>{onOpenReport && <button className="button button-ghost button-small" type="button" onClick={() => onOpenReport(run.run_id)}><AppIcon name="file" size={13} /> 生成报告</button>}</div></div>{showRunInfo && <div className="test-run-facts"><span><small>应用版本</small><strong>{run.application_versions || "未填写"}</strong></span><span><small>计划时间</small><strong>{run.planned_at ? formatPlanTime(run.planned_at) : "未安排"}</strong></span><span><small>快照</small><strong>cases-snapshot.json</strong></span><span><small>证据目录</small><strong>evidence/</strong></span></div>}</section>
    {showRunInfo && <div className="test-result-metrics">{metricCard("total", "总数", stats.total, statusFilter, onStatusFilter)}{metricCard("executed", "已执行", stats.executed, statusFilter, onStatusFilter)}{metricCard("passed", "通过", stats.passed, statusFilter, onStatusFilter)}{metricCard("failed", "失败", stats.failed, statusFilter, onStatusFilter)}{metricCard("blocked", "阻塞", stats.blocked, statusFilter, onStatusFilter)}{metricCard("skipped", "暂不执行", stats.skipped, statusFilter, onStatusFilter)}{metricCard("not_executed", "未执行", stats.not_executed, statusFilter, onStatusFilter)}{metricCard("not_applicable", "不适用", stats.not_applicable, statusFilter, onStatusFilter)}{metricCard("needs_retest", "待复测", stats.needs_retest, statusFilter, onStatusFilter)}<div className="test-result-metric progress"><span>登记进度</span><strong>{stats.progress}%</strong><i><b style={{ width: `${stats.progress}%` }} /></i></div></div>}
    <section className="panel-section test-case-execution-panel"><div className="section-heading"><div><AppIcon name="list" size={16} /><h2>执行明细</h2></div><div className="test-execution-actions"><span className="section-muted">{filteredCases.length} / {snapshot.cases.length} 条</span><button className="button button-ghost button-small" type="button" disabled={readOnly || saving} onClick={onAddCase} title="需求变更时向本轮执行和 cases.json 追加用例"><AppIcon name="add" size={13} /> 新增用例</button><button className="button button-ghost button-small" type="button" disabled={readOnly || saving || !selectedCase} onClick={props.onDuplicateCase}>复制当前用例</button><button className="button button-primary button-small" type="button" disabled={readOnly || !resultDirty || saving} onClick={onSaveResults}><AppIcon name="save" size={13} />{saving ? "保存中…" : "保存结果"}</button></div></div><div className="test-execution-filters"><label className="document-search"><AppIcon name="search" size={13} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索标题、结果或备注" /></label><select className="select-control" value={directoryFilter} onChange={(event) => onDirectoryFilter(event.target.value)}><option value="all">全部目录</option>{directoryOptions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><select className="select-control" value={priorityFilter} onChange={(event) => onPriorityFilter(event.target.value)}><option value="all">全部优先级</option><option value="0">P0</option><option value="1">P1</option><option value="2">P2</option></select><select className="select-control" value={typeFilter} onChange={(event) => onTypeFilter(event.target.value)}><option value="all">全部类型</option>{testTypes.map((item) => <option key={item} value={item}>{item}</option>)}</select><input className="field-input test-tag-filter" value={tagFilter} onChange={(event) => onTagFilter(event.target.value)} placeholder="标签" /></div><div className="test-execution-case-layout"><div className="test-case-result-list">{filteredCases.length ? filteredCases.map((item) => { const result = props.resultDocument.results.find((entry) => entry.case_id === item.id); return <button type="button" key={item.id} className={`test-case-result-row ${item.id === selectedCaseId ? "active" : ""}`} onClick={() => onSelectCase(item.id)}><span className={`priority-label p${item.priority}`}>P{item.priority}</span><span className="test-case-result-main"><strong>{item.title}</strong><small>{directoryMap.get(item.directory_id) || "未分类"} · {item.test_type}</small></span><span className={`test-result-status ${result?.status || "not_executed"}`}>{result?.needs_retest ? "内容已变更，待复测" : testResultStatusLabel(result?.status || "not_executed")}</span></button>; }) : <div className="panel-placeholder"><AppIcon name="inbox" size={20} /><span>没有匹配的执行用例</span><small>请调整筛选条件</small></div>}</div><div className="test-case-result-editor">{selectedCase && selectedResult ? <ResultEditor item={selectedCase} result={selectedResult} directoryTitle={directoryMap.get(selectedCase.directory_id) || "未分类"} readOnly={readOnly} saving={saving} evidenceInputRef={evidenceInputRef} onUpdate={onUpdateResult} onEdit={onEditCase} onReportBug={onReportBug} onLinkBug={onLinkBug} onStatusAction={(status) => onStatusAction(selectedCase.id, status)} onEvidenceFiles={onEvidenceFiles} onEvidencePaste={onEvidencePaste} evidenceBasePath={evidenceBasePath} onOpenEvidence={onOpenEvidence} /> : <div className="panel-placeholder"><AppIcon name="inbox" size={20} /><span>选择一条用例开始执行</span></div>}</div></div></section></div>;
}

function ResultEditor(props: { item: CasesDocument["cases"][number]; result: TestCaseResult; directoryTitle: string; evidenceBasePath: string; readOnly: boolean; saving: boolean; evidenceInputRef: React.RefObject<HTMLInputElement>; onUpdate: (id: string, patch: Partial<TestCaseResult>) => void; onEdit: () => void; onReportBug: () => void; onLinkBug: () => void; onStatusAction: (status: TestResultStatus) => void; onEvidenceFiles: (files: File[]) => void; onEvidencePaste: (event: React.ClipboardEvent<HTMLDivElement>) => void; onOpenEvidence: (item: TestEvidence) => void }) {
  const { item, result, directoryTitle, evidenceBasePath, readOnly, saving, evidenceInputRef, onUpdate, onEdit, onReportBug, onLinkBug, onStatusAction, onEvidenceFiles, onEvidencePaste, onOpenEvidence } = props;
  const bugSerial = defectSummary(result);
  const bugSubject = "";
  const actions = caseActions(item);
  const expectedResults = caseExpectedResults(item);
  return <div className="test-result-editor-scroll" onPaste={onEvidencePaste} tabIndex={0}><div className="test-result-editor-heading"><div><span className="eyebrow">当前用例</span><h3>{item.title}</h3><small className="mono">{item.id}</small></div><div className="test-result-editor-side"><span className={`test-result-status large ${result.status}`}>{result.needs_retest ? "内容已变更，待复测" : testResultStatusLabel(result.status)}</span>{!readOnly && <button className="button button-ghost button-small" type="button" onClick={onEdit} title="修改本条用例的标题、前置条件、步骤与期望结果（同步更新执行快照和 cases.json）"><AppIcon name="edit" size={13} /> 编辑用例</button>}{!readOnly && <button className="button test-evidence-upload-shortcut button-small" type="button" onClick={() => evidenceInputRef.current?.click()} title="选择截图；也可复制截图后在用例详情中粘贴"><AppIcon name="image" size={13} /> 上传/粘贴截图</button>}{!readOnly && <button className="button button-ghost button-small" type="button" onClick={onLinkBug} title="输入外部缺陷单号或链接，把已有缺陷关联到当前用例"><AppIcon name="link" size={13} /> 关联缺陷</button>}{!readOnly && <button className="button test-execution-bug-button button-small" type="button" onClick={onReportBug} title="在云效中创建缺陷，挂到当前需求对应的云效需求工作项下"><AppIcon name="alert" size={13} /> 提交云效 BUG</button>}</div></div>
      <div className="test-case-context"><span><small>优先级</small><strong>P{item.priority}</strong></span><span><small>目录</small><strong>{directoryTitle}</strong></span><span><small>类型</small><strong>{item.test_type}</strong></span><span><small>标签</small><strong>{item.tags.join(", ") || "无"}</strong></span></div><div className="test-case-spec"><div className="test-case-spec-block"><div className="test-case-spec-heading"><AppIcon name="info" size={12} /><strong>前置条件</strong></div>{item.preconditions.length ? <ol className="test-case-preconditions">{item.preconditions.map((entry, index) => <li key={index}>{entry}</li>)}</ol> : <span className="field-hint">无前置条件</span>}</div><div className="test-case-spec-block"><div className="test-case-spec-heading"><AppIcon name="list" size={12} /><strong>操作步骤</strong></div>{actions.length ? <ol className="test-case-steps">{actions.map((action, index) => <li key={index}><span className="test-case-step-action">{action}</span></li>)}</ol> : <span className="field-hint">无操作步骤</span>}</div><div className="test-case-spec-block"><div className="test-case-spec-heading"><AppIcon name="check" size={12} /><strong>期望结果</strong></div>{expectedResults.length ? <ol className="test-case-expected-results">{expectedResults.map((entry, index) => <li key={index}>{entry}</li>)}</ol> : <span className="field-hint">无明确期望结果</span>}</div></div>
      <div className="test-result-status-actions"><span className="field-label-inline">执行状态</span><button type="button" className={`test-status-btn passed ${result.status === "passed" ? "active" : ""}`} disabled={readOnly || saving} onClick={() => onStatusAction("passed")}><AppIcon name="check" size={13} /> 通过</button><button type="button" className={`test-status-btn failed ${result.status === "failed" ? "active" : ""}`} disabled={readOnly || saving} onClick={() => onStatusAction("failed")}><AppIcon name="close" size={13} /> 失败</button><button type="button" className={`test-status-btn skipped ${result.status === "skipped" ? "active" : ""}`} disabled={readOnly || saving} onClick={() => onStatusAction("skipped")}>暂不执行</button><select className="select-control test-status-more" value={result.status === "blocked" || result.status === "not_applicable" ? result.status : ""} disabled={readOnly || saving} onChange={(event) => { if (event.target.value) onStatusAction(event.target.value as TestResultStatus); }}><option value="">其他状态…</option><option value="blocked">阻塞</option><option value="not_applicable">不适用</option></select></div><label className="field-label">实际结果<textarea className="field-input field-textarea test-result-textarea" value={result.actual_result} disabled={readOnly} onChange={(event) => onUpdate(item.id, { actual_result: event.target.value })} placeholder="记录实际执行现象、返回值或页面表现" /></label><div className="test-result-editor-grid"><label className="field-label">严重程度<select className="field-input" value={result.severity} disabled={readOnly} onChange={(event) => onUpdate(item.id, { severity: event.target.value as TestResultSeverity })}>{RESULT_SEVERITIES.map((severity) => <option key={severity} value={severity}>{testResultSeverityLabel(severity)}</option>)}</select></label><label className="field-label">外部缺陷链接<input className="field-input" value={result.defect_url} disabled={readOnly} onChange={(event) => onUpdate(item.id, { defect_url: event.target.value })} placeholder="https://…" /></label></div>{bugSerial ? <div className="test-result-bug-tag"><AppIcon name="link" size={12} /><span>外部缺陷 <strong>{bugSerial}</strong>{bugSubject ? ` · ${bugSubject}` : ""}</span>{!readOnly && <button type="button" className="text-button" onClick={onLinkBug}>追加关联</button>}{!readOnly && <button type="button" className="text-button" onClick={onReportBug}>再提交一个</button>}</div> : null}<label className="field-label">备注<textarea className="field-input field-textarea test-result-notes" value={result.notes} disabled={readOnly} onChange={(event) => onUpdate(item.id, { notes: event.target.value })} placeholder="补充执行说明、环境差异或阻塞原因" /></label>
      <div className="test-evidence-section"><div className="structured-editor-section-heading"><strong>证据（{result.evidence.length}）</strong><span className="field-help">图片、日志、接口请求响应及其他附件</span></div><EvidenceGallery items={result.evidence} basePath={evidenceBasePath} onSelect={onOpenEvidence} /><div className={`test-evidence-dropzone ${readOnly ? "disabled" : ""}`} tabIndex={0} onPaste={onEvidencePaste} onClick={() => !readOnly && evidenceInputRef.current?.click()}><AppIcon name="upload" size={17} /><span>点击上传或直接粘贴图片</span><small>文件会保存到本轮次 evidence/ 目录</small></div><input ref={evidenceInputRef} type="file" multiple accept="image/*,.log,.txt,.trace,.out,.json,.xml,.har,.http,.csv,.pdf,.zip" hidden disabled={readOnly} onChange={(event) => { const files = Array.from(event.target.files || []); event.currentTarget.value = ""; if (files.length) onEvidenceFiles(files); }} />{result.evidence.length ? <div className="test-evidence-list">{result.evidence.map((evidence) => <div className="test-evidence-row" key={evidence.id}><span className={`test-evidence-icon ${evidence.type}`}><AppIcon name={evidence.type === "image" ? "image" : evidence.type === "log" ? "terminal" : evidence.type === "request_response" ? "code" : "file"} size={14} /></span><span><strong>{evidence.name}</strong><small>{evidenceTypeLabel(evidence.type)} · {formatBytes(evidence.size)}</small></span><button type="button" className="text-button" onClick={() => onOpenEvidence(evidence)}>打开</button></div>)}</div> : <div className="test-evidence-empty">尚未添加证据</div>}</div>{saving && <div className="test-result-saving"><span className="spinner" />正在保存证据或结果…</div>}</div>;
}

function CreateRunDialog(props: { draft: CreateRunDraft; versions: TestCaseVersionRecord[]; selectedVersion: TestCaseVersionRecord; scopeMode: ScopeMode; scopeCaseIds: Set<string>; saving: boolean; onDraftChange: React.Dispatch<React.SetStateAction<CreateRunDraft>>; onVersionChange: (id: string) => void; onScopeModeChange: (mode: ScopeMode) => void; onScopeCaseIdsChange: React.Dispatch<React.SetStateAction<Set<string>>>; onClose: () => void; onCreate: () => void }) {
  const { draft, versions, selectedVersion, scopeMode, scopeCaseIds, saving, onDraftChange, onVersionChange, onScopeModeChange, onScopeCaseIdsChange, onClose, onCreate } = props;
  const toggleCase = (id: string) => onScopeCaseIdsChange((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <div className="modal-backdrop"><div className="modal test-run-create-modal"><div className="modal-header"><div><span className="eyebrow">BB-11 / 创建轮次</span><h2>创建测试轮次</h2></div><button className="icon-button" type="button" disabled={saving} onClick={onClose}><AppIcon name="close" size={16} /></button></div><p className="modal-description">创建时会把所选正式用例版本复制为 cases-snapshot.json，本轮工作快照允许修订；来源正式基线保持不变，修订后保留旧结果并按需复测。</p><div className="test-run-create-grid"><label className="field-label">轮次名称<input className="field-input" value={draft.name} disabled={saving} onChange={(event) => onDraftChange((current) => ({ ...current, name: event.target.value }))} placeholder="例如 示例平台冒烟测试-2026-09-10" /></label><label className="field-label">用例版本<select className="field-input" value={draft.caseVersionId} disabled={saving} onChange={(event) => onVersionChange(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>V{version.manifest.version} · {version.manifest.note || "无说明"} · {version.manifest.case_count} 条</option>)}</select></label><label className="field-label">测试环境<input className="field-input" value={draft.environment} disabled={saving} onChange={(event) => onDraftChange((current) => ({ ...current, environment: event.target.value }))} placeholder="例如 UAT / Windows 11 / Chrome" /></label><label className="field-label">应用版本<input className="field-input" value={draft.applicationVersions} disabled={saving} onChange={(event) => onDraftChange((current) => ({ ...current, applicationVersions: event.target.value }))} placeholder="例如 v2.6.0" /></label><label className="field-label">分支<input className="field-input" value={draft.branch} disabled={saving} onChange={(event) => onDraftChange((current) => ({ ...current, branch: event.target.value }))} placeholder="release/…" /></label><label className="field-label">执行人<input className="field-input" value={draft.executor} disabled={saving} onChange={(event) => onDraftChange((current) => ({ ...current, executor: event.target.value }))} placeholder="姓名或团队" /></label><label className="field-label">计划时间<input className="field-input" type="datetime-local" value={draft.plannedAt} disabled={saving} onChange={(event) => onDraftChange((current) => ({ ...current, plannedAt: event.target.value }))} /></label></div><label className="field-label">执行范围说明<textarea className="field-input field-textarea" value={draft.scopeDescription} disabled={saving} onChange={(event) => onDraftChange((current) => ({ ...current, scopeDescription: event.target.value }))} placeholder="例如仅执行登录、订单和退款模块" /></label><div className="test-scope-heading"><strong>执行范围</strong><span>当前版本共 {selectedVersion.data.cases.length} 条用例</span><div><label className="batch-check"><input type="radio" checked={scopeMode === "all"} disabled={saving} onChange={() => onScopeModeChange("all")} />全部用例</label><label className="batch-check"><input type="radio" checked={scopeMode === "selected"} disabled={saving} onChange={() => onScopeModeChange("selected")} />选择用例（{scopeCaseIds.size}）</label></div></div>{scopeMode === "selected" && <div className="test-scope-case-list">{selectedVersion.data.cases.map((item) => <label className="test-scope-case-row" key={item.id}><input type="checkbox" checked={scopeCaseIds.has(item.id)} disabled={saving} onChange={() => toggleCase(item.id)} /><span><strong>{item.title}</strong><small>P{item.priority} · {item.test_type}</small></span></label>)}</div>}<div className="modal-actions"><button className="button button-ghost" type="button" disabled={saving} onClick={onClose}>取消</button><button className="button button-primary" type="button" disabled={saving} onClick={onCreate}>{saving ? "创建中…" : "创建轮次并复制快照"}</button></div></div></div>;
}

interface CaseEditDraft {
  related_case_ids?: string[];
  title: string;
  priority: CasePriority;
  test_type: string;
  directory_id: string;
  preconditions: string[];
  actions: string[];
  expected_results: string[];
  reason: string;
}

function splitCaseLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const CASE_TITLE_PREFIX = /^tc-p(\d+)\s*-\s*([^:：]+?)[:：]\s*/i;

function stripCaseTitlePrefix(title: string): string {
  return title.replace(CASE_TITLE_PREFIX, "");
}

function CaseEditDialog(props: { mode: "edit" | "add"; item: StructuredTestCase | null; deletedCases: Array<{ id: string; title: string }>; directories: Array<{ id: string; title: string }>; defaultDirectoryId: string; saving: boolean; onClose: () => void; onSave: (draft: CaseEditDraft) => Promise<boolean | undefined>; onDelete?: (reason: string) => void }) {
  const { mode, item, directories, defaultDirectoryId, saving, onClose, onSave, onDelete } = props;
  const [title, setTitle] = useState(item ? stripCaseTitlePrefix(item.title) : "");
  const [priority, setPriority] = useState<CasePriority>((item?.priority ?? 1) as CasePriority);
  const [testType, setTestType] = useState(item?.test_type || CASE_TEST_TYPES[0]);
  const [directoryId, setDirectoryId] = useState(item?.directory_id || defaultDirectoryId || directories[0]?.id || "");
  const [preconditionsText, setPreconditionsText] = useState((item?.preconditions || []).join("\n"));
  const [actionsText, setActionsText] = useState(item ? caseActions(item).join("\n") : "");
  const [expectedResultsText, setExpectedResultsText] = useState(item ? caseExpectedResults(item).join("\n") : "");
  const [reason, setReason] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [replacementId, setReplacementId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [validationError, setValidationError] = useState("");
  const sceneTitle = stripCaseTitlePrefix(title).trim();
  const handleTitleChange = (value: string) => {
    const match = value.match(CASE_TITLE_PREFIX);
    if (match) {
      const parsedPriority = Number(match[1]);
      const parsedType = match[2].trim();
      if (parsedPriority >= 0 && parsedPriority <= 2) setPriority(parsedPriority as CasePriority);
      if ((CASE_TEST_TYPES as readonly string[]).includes(parsedType)) setTestType(parsedType);
      setTitle(stripCaseTitlePrefix(value));
      return;
    }
    setTitle(value);
  };
  const submit = async () => {
    if (!sceneTitle) { setValidationError("请填写场景标题"); return; }
    if (mode === "edit" && !reason.trim()) {
      setValidationError("请填写修改原因");
      return;
    }
    setValidationError("");
    return Boolean(await onSave({
      related_case_ids: replacementId ? [replacementId] : [],
      title: `tc-p${priority}-${testType}: ${sceneTitle}`,
      priority,
      test_type: testType,
      directory_id: directoryId,
      preconditions: splitCaseLines(preconditionsText),
      actions: splitCaseLines(actionsText),
      expected_results: splitCaseLines(expectedResultsText),
      reason: reason.trim(),
    }));
  };
  useDraftSave(async () => confirmDelete ? false : Boolean(await submit()), 10);
  const draftChanged = Boolean(reason || deleteReason || replacementId) || sceneTitle !== (item ? stripCaseTitlePrefix(item.title) : "") || preconditionsText !== (item?.preconditions || []).join("\n") || actionsText !== (item ? caseActions(item).join("\n") : "") || expectedResultsText !== (item ? caseExpectedResults(item).join("\n") : "") || priority !== (item?.priority ?? 1) || directoryId !== (item?.directory_id || defaultDirectoryId || directories[0]?.id || "");
  const closeDialog = () => { if (!draftChanged || window.confirm("确定放弃本次用例草稿吗？取消将保留输入。")) onClose(); };
  const confirmDeleteCase = () => {
    if (!deleteReason.trim()) {
      setValidationError("请填写删除原因");
      return;
    }
    setValidationError("");
    onDelete?.(deleteReason.trim());
  };
  return <div className="modal-backdrop">
    <div className="modal case-edit-modal">
      <div className="modal-header"><div><span className="eyebrow">BB-11 / {mode === "add" ? "新增用例" : "修改用例"}</span><h2>{mode === "add" ? "新增执行用例" : "修改执行用例"}</h2></div><button className="icon-button" type="button" disabled={saving} onClick={closeDialog}><AppIcon name="close" size={16} /></button></div>
      <p className="modal-description">{mode === "add" ? "新用例会追加到本轮执行快照、执行范围和 cases.json。" : "修改会更新本轮执行快照并同步 04-测试用例/cases.json，正式用例版本不受影响。"}</p>
      <label className="field-label case-edit-title">用例标题<span className="field-help">只填场景标题，「tc-p优先级-测试类型:」前缀自动拼接</span><input className="field-input" value={title} disabled={saving} onChange={(event) => handleTitleChange(event.target.value)} placeholder="例如：结算单新增收款类型" /></label>
      <div className="case-edit-grid">
        <label className="field-label">优先级<select className="field-input" value={priority} disabled={saving} onChange={(event) => setPriority(Number(event.target.value) as CasePriority)}><option value={0}>P0</option><option value={1}>P1</option><option value={2}>P2</option></select></label>
        <label className="field-label">测试类型<select className="field-input" value={testType} disabled={saving} onChange={(event) => setTestType(event.target.value)}>{CASE_TEST_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="field-label">所属目录<select className="field-input" value={directoryId} disabled={saving} onChange={(event) => setDirectoryId(event.target.value)}>{directories.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      </div>
      <label className="field-label">前置条件<textarea className="field-input field-textarea" rows={3} value={preconditionsText} disabled={saving} onChange={(event) => setPreconditionsText(event.target.value)} placeholder="每行一条前置条件" /></label>
      <label className="field-label">操作步骤<span className="field-help">每行一条操作步骤，不与期望结果逐行绑定</span><textarea className="field-input field-textarea" rows={4} value={actionsText} disabled={saving} onChange={(event) => setActionsText(event.target.value)} placeholder="每行一条操作步骤" /></label>
      <label className="field-label">期望结果<span className="field-help">每行一条，描述整个用例的验收结果</span><textarea className="field-input field-textarea" rows={4} value={expectedResultsText} disabled={saving} onChange={(event) => setExpectedResultsText(event.target.value)} placeholder="每行一条期望结果" /></label>
      {<label className="field-label">修改原因/新增依据<span className="field-help">{mode === "edit" ? "修改原因必填" : "新增依据可选"}；原因和修改前后快照会写入本轮 results.json</span><textarea className="field-input field-textarea" rows={2} value={reason} disabled={saving} onChange={(event) => { setReason(event.target.value); setValidationError(""); }} placeholder="说明为什么需要调整这条用例，例如执行中发现业务规则理解有误" /></label>}
      {mode === "add" && props.deletedCases.length > 0 && <label className="field-label">替代关系（可选）<span className="field-help">若新增用于替代删除场景，请明确选择；旧结果仍保留。</span><select className="field-input" value={replacementId} onChange={(event) => setReplacementId(event.target.value)}><option value="">独立新增场景</option>{props.deletedCases.map((old) => <option key={old.id} value={old.id}>{old.title} · {old.id}</option>)}</select></label>}
      {confirmDelete && <label className="field-label case-delete-reason">删除原因<span className="field-help">必填；被删除用例的完整快照和原因会保留在本轮 results.json 变更历史中</span><textarea className="field-input field-textarea" rows={2} value={deleteReason} disabled={saving} onChange={(event) => { setDeleteReason(event.target.value); setValidationError(""); }} placeholder="说明删除原因，例如需求范围调整、场景重复或已被其他用例覆盖" /></label>}
      {validationError && <div className="case-edit-validation">{validationError}</div>}
      <div className="modal-actions">
        {onDelete && !confirmDelete && <button className="button button-danger" type="button" onClick={() => { setConfirmDelete(true); setValidationError(""); }} disabled={saving}><AppIcon name="minus" size={14} /> 删除此用例</button>}
        {onDelete && confirmDelete && <><button className="button button-ghost" type="button" onClick={() => { setConfirmDelete(false); setDeleteReason(""); setValidationError(""); }} disabled={saving}>取消删除</button><button className="button button-danger" type="button" onClick={confirmDeleteCase} disabled={saving || !deleteReason.trim()}>确认删除用例</button></>}
        <span className="modal-action-spacer" />
        {!confirmDelete && <><button className="button button-ghost" type="button" onClick={closeDialog} disabled={saving}>取消</button><button className="button button-primary" type="button" disabled={saving || !sceneTitle || (mode === "edit" && !reason.trim())} onClick={submit}>{saving ? "保存中…" : "保存用例"}</button></>}
      </div>
    </div>
  </div>;
}

function metricCard(status: "total" | "executed" | FilterStatus, label: string, value: number, current: FilterStatus, onChange: (status: FilterStatus) => void) {
  const target = status === "total" || status === "executed" ? "all" : status as FilterStatus;
  return <button type="button" className={`test-result-metric ${status} ${current === target && status !== "executed" ? "active" : ""}`} onClick={() => onChange(current === target ? "all" : target)}><span>{label}</span><strong>{value}</strong></button>;
}

function formatPlanTime(value: string): string {
  return value.replace("T", " ");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildBugDescription(item: StructuredTestCase, result: TestCaseResult, run: TestRunDocument, requirement: RequirementMeta | null | undefined, directoryTitle: string): string {
  const actions = caseActions(item).map((entry, index) => `${index + 1}. ${entry}`).join("\n") || "（无操作步骤）";
  const expectedResults = caseExpectedResults(item).map((entry, index) => `${index + 1}. ${entry}`).join("\n") || "（无明确期望结果）";
  const preconditions = item.preconditions.length ? item.preconditions.map((entry, index) => `${index + 1}. ${entry}`).join("\n") : "（无前置条件）";
  return [
    "【来源】白泽客户端 · 测试执行",
    `【需求】${requirement ? `${requirement.requirement.id} ${requirement.requirement.name}` : run.requirement_id}`,
    `【轮次】${run.name || run.run_id}（${run.run_id}）`,
    `【环境】${run.environment || "未填写"} · 分支 ${run.branch || "未填写"} · 应用版本 ${run.application_versions || "未填写"}`,
    `【用例】${item.title}`,
    `【目录】${directoryTitle} · 优先级 P${item.priority}`,
    "",
    "【前置条件】",
    preconditions,
    "",
    "【操作步骤】",
    actions,
    "",
    "【期望结果】",
    expectedResults,
    "",
    "【实际结果】",
    result.actual_result || "（未填写，请补充实际现象）",
    "",
    `【严重程度】${testResultSeverityLabel(result.severity)}${result.notes.trim() ? `\n【备注】${result.notes.trim()}` : ""}`,
  ].join("\n");
}
