import { collectDirectoryNodes, normalizeCasesDocument } from "./cases";
import type {
  CaseDirectoryNode,
  CasesDocument,
  CaseVersionManifest,
  TestCaseResult,
  TestCaseChangeHistoryEntry,
  TestEvidence,
  TestResultSeverity,
  TestResultStatus,
  TestResultsDocument,
  TestRunDocument,
  TestRunStats,
} from "./types";

export const TEST_EXECUTION_DIRECTORY = "06-测试执行与证据";

export interface TestCaseVersionRecord {
  id: string;
  path: string;
  manifest: CaseVersionManifest;
  data: CasesDocument;
}

export interface TestRunRecord {
  id: string;
  path: string;
  run: TestRunDocument;
  snapshot: CasesDocument;
  results: TestResultsDocument;
}

export function createTestRunId(): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${suffix}`;
}

export function createTestCaseResult(caseId: string, now = new Date().toISOString()): TestCaseResult {
  return {
    case_id: caseId,
    status: "not_executed",
    actual_result: "",
    notes: "",
    severity: "none",
    defect_url: "",
    evidence: [],
    updated_at: now,
  };
}

export function createTestResults(runId: string, caseIds: string[], now = new Date().toISOString()): TestResultsDocument {
  return {
    version: "1.0",
    run_id: runId,
    results: caseIds.map((caseId) => createTestCaseResult(caseId, now)),
    updated_at: now,
  };
}

export function normalizeTestRun(value: unknown, fallbackId: string, requirementId: string, platformId: string): TestRunDocument {
  const raw = isRecord(value) ? value : {};
  const rawScope = isRecord(raw.execution_scope) ? raw.execution_scope : {};
  const caseIds = Array.isArray(rawScope.case_ids)
    ? rawScope.case_ids.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  return {
    ...raw,
    version: typeof raw.version === "string" ? raw.version : "1.0",
    run_id: typeof raw.run_id === "string" && raw.run_id.trim() ? raw.run_id : fallbackId,
    requirement_id: typeof raw.requirement_id === "string" ? raw.requirement_id : requirementId,
    platform_id: typeof raw.platform_id === "string" ? raw.platform_id : platformId,
    name: typeof raw.name === "string" ? raw.name : fallbackId,
    case_version_id: typeof raw.case_version_id === "string" ? raw.case_version_id : "",
    case_version: typeof raw.case_version === "number" ? raw.case_version : 0,
    environment: typeof raw.environment === "string" ? raw.environment : "",
    application_versions: typeof raw.application_versions === "string" ? raw.application_versions : "",
    branch: typeof raw.branch === "string" ? raw.branch : "",
    executor: typeof raw.executor === "string" ? raw.executor : "",
    planned_at: typeof raw.planned_at === "string" ? raw.planned_at : null,
    execution_scope: {
      ...rawScope,
      case_ids: caseIds,
      description: typeof rawScope.description === "string" ? rawScope.description : "",
    },
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
    created_by: typeof raw.created_by === "string" ? raw.created_by : "未知",
  };
}

export function normalizeTestResults(value: unknown, runId: string): TestResultsDocument {
  const raw = isRecord(value) ? value : {};
  const results = Array.isArray(raw.results)
    ? raw.results.filter(isRecord).map((item) => normalizeTestCaseResult(item))
    : [];
  return {
    ...raw,
    version: typeof raw.version === "string" ? raw.version : "1.0",
    run_id: typeof raw.run_id === "string" ? raw.run_id : runId,
    results,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}

export function normalizeTestCaseResult(value: Record<string, unknown>): TestCaseResult {
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter(isRecord).map((item) => normalizeEvidence(item))
    : [];
  const status = isTestResultStatus(value.status) ? value.status : "not_executed";
  const severity = isTestResultSeverity(value.severity) ? value.severity : "none";
  return {
    ...value,
    case_id: typeof value.case_id === "string" ? value.case_id : "",
    status,
    actual_result: typeof value.actual_result === "string" ? value.actual_result : "",
    notes: typeof value.notes === "string" ? value.notes : "",
    severity,
    defect_url: typeof value.defect_url === "string" ? value.defect_url : "",
    evidence,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : "",
  };
}

export function normalizeEvidence(value: Record<string, unknown>): TestEvidence {
  const type = value.type === "image" || value.type === "log" || value.type === "request_response" ? value.type : "attachment";
  return {
    ...value,
    id: typeof value.id === "string" ? value.id : `evidence-${Date.now()}`,
    path: typeof value.path === "string" ? value.path : "",
    name: typeof value.name === "string" ? value.name : "未命名证据",
    type,
    size: typeof value.size === "number" ? value.size : 0,
    mime_type: typeof value.mime_type === "string" ? value.mime_type : "application/octet-stream",
    added_at: typeof value.added_at === "string" ? value.added_at : "",
  };
}

export function getTestRunStats(results: TestCaseResult[], history: TestCaseChangeHistoryEntry[] = []): TestRunStats {
  const deletedIds = new Set(results.filter((item) => item.deleted).map((item) => item.case_id));
  for (const event of history) {
    if (event.action === "deleted") deletedIds.add(event.case_id);
    else if (event.action === "restored" || event.action === "added") deletedIds.delete(event.case_id);
  }
  const active = results.filter((item) => !item.deleted && !deletedIds.has(item.case_id));
  const count = (status: TestResultStatus) => active.filter((item) => item.status === status && !item.needs_retest).length;
  const total = active.length;
  const passed = count("passed"), failed = count("failed");
  const applicable = total - count("not_applicable");
  const registered = active.filter((item) => item.status !== "not_executed" && !item.needs_retest).length;
  return {
    total, applicable, registered, deleted: deletedIds.size,
    needs_retest: active.filter((item) => item.needs_retest).length,
    executed: passed + failed, passed, failed,
    blocked: count("blocked"), skipped: count("skipped"),
    not_executed: count("not_executed"), not_applicable: count("not_applicable"),
    progress: total ? Math.round(registered / total * 100) : 0,
    pass_rate: passed + failed ? passed / (passed + failed) * 100 : null,
  };
}

export function testResultStatusLabel(status: string): string {
  return ({
    not_executed: "未执行",
    passed: "通过",
    failed: "失败",
    blocked: "阻塞",
    skipped: "暂不执行",
    not_applicable: "不适用",
  } as Record<string, string>)[status] || status;
}

export function testResultSeverityLabel(severity: string): string {
  return ({ none: "无", low: "低", medium: "中", high: "高", critical: "严重" } as Record<string, string>)[severity] || severity;
}

export function evidenceTypeLabel(type: TestEvidence["type"]): string {
  return ({ image: "图片", log: "日志", request_response: "接口请求/响应", attachment: "其他附件" })[type];
}

export function directoryPathMap(root: CaseDirectoryNode): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (node: CaseDirectoryNode, parent: string[]) => {
    const path = [...parent, node.title].filter(Boolean);
    map.set(node.id, path.join(" / "));
    node.children.forEach((child) => visit(child, path));
  };
  visit(root, []);
  return map;
}

export function caseDirectoryOptions(document: CasesDocument): Array<{ id: string; title: string }> {
  return collectDirectoryNodes(document.tree).map((node) => ({ id: node.id, title: node.title }));
}

export function normalizeVersionManifest(value: unknown, fallbackId: string, requirementId: string, platformId: string): CaseVersionManifest {
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

export function sanitizeEvidenceFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "evidence";
}

export function inferEvidenceType(file: { name: string; type?: string }): TestEvidence["type"] {
  const name = file.name.toLowerCase();
  if (file.type?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return "image";
  if (/\.(log|txt|trace|out)$/i.test(name) || file.type === "text/plain") return "log";
  if (/\.(json|xml|har|http|csv)$/i.test(name)) return "request_response";
  return "attachment";
}

function parseVersionNumber(value: string): number {
  const match = value.match(/^v(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function isTestResultStatus(value: unknown): value is TestResultStatus {
  return value === "not_executed" || value === "passed" || value === "failed" || value === "blocked" || value === "skipped" || value === "not_applicable";
}

function isTestResultSeverity(value: unknown): value is TestResultSeverity {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function normalizeSnapshot(value: unknown, requirementId: string, platformName: string, platformId: string): CasesDocument {
  return normalizeCasesDocument(value, requirementId, platformName, platformId);
}
