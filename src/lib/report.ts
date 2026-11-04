import { defectSummary } from "../domain/integrations";
import JSZip from "jszip";
import { joinPath } from "./api";
import { createTestCaseResult, getTestRunStats } from "./testExecution";
import type {
  CasesDocument,
  ReportTemplate,
  ReportTemplateRegistry,
  TestCaseResult,
  TestResultsDocument,
  TestRunDocument,
  TestRunStats,
} from "./types";
import type { StructuredTestCase } from "./types";

export const REPORT_TEMPLATE_REGISTRY_VERSION = "1.0";
export const REPORT_DIRECTORY = "07-测试报告";

export const REPORT_PLACEHOLDERS = [
  "requirement_id",
  "requirement_name",
  "platform",
  "test_environment",
  "application_versions",
  "case_total",
  "passed",
  "failed",
  "blocked",
  "skipped",
  "not_executed",
  "pass_rate",
  "failed_cases",
  "blocked_cases",
  "skipped_cases",
  "risks",
  "remaining_issues",
] as const;

export type ReportPlaceholder = typeof REPORT_PLACEHOLDERS[number];

export interface ReportRequirementSource {
  id: string;
  name: string;
  platform: string;
  owner: string;
}

export interface ReportCaseSummary {
  case_id: string;
  title: string;
  actual_result: string;
  notes: string;
  severity: string;
  defect_url: string;
  evidence_count: number;
}

export interface ReportBuildData {
  requirement: ReportRequirementSource;
  stats: TestRunStats;
  failed_cases: ReportCaseSummary[];
  blocked_cases: ReportCaseSummary[];
  skipped_cases: ReportCaseSummary[];
  evidence_count: number;
  placeholders: Record<ReportPlaceholder, string>;
}

export interface ReportBuildInput {
  requirement_yaml: unknown;
  platform_name: string;
  run: TestRunDocument;
  snapshot: CasesDocument;
  results: TestResultsDocument;
  risks: string;
  remaining_issues: string;
}

export function defaultReportPlaceholders(): string[] {
  return [...REPORT_PLACEHOLDERS];
}

export function defaultReportOutputRule(type: "markdown" | "docx"): string {
  return `{{requirement_id}}-{{platform_id}}-测试报告-v{{version}}.${type === "docx" ? "docx" : "md"}`;
}

export function emptyReportTemplateRegistry(): ReportTemplateRegistry {
  return { version: REPORT_TEMPLATE_REGISTRY_VERSION, templates: [] };
}

export function normalizeReportTemplateRegistry(value: unknown): ReportTemplateRegistry {
  if (!isRecord(value)) return emptyReportTemplateRegistry();
  const templates = Array.isArray(value.templates)
    ? value.templates.filter(isRecord).map((item, index) => normalizeReportTemplate(item, `report-template-${index}`))
    : [];
  return {
    ...value,
    version: typeof value.version === "string" ? value.version : REPORT_TEMPLATE_REGISTRY_VERSION,
    templates,
  };
}

export function normalizeReportTemplate(value: Record<string, unknown>, fallbackId: string): ReportTemplate {
  const type: "markdown" | "docx" = value.type === "docx" ? "docx" : "markdown";
  const placeholders = Array.isArray(value.placeholders)
    ? value.placeholders.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : defaultReportPlaceholders();
  return {
    ...value,
    id: stringValue(value.id, fallbackId),
    name: stringValue(value.name, "未命名报告模板"),
    type,
    version: stringValue(value.version, "1.0"),
    file_path: stringValue(value.file_path, ""),
    platform_id: typeof value.platform_id === "string" && value.platform_id.trim() ? value.platform_id : null,
    fingerprint: stringValue(value.fingerprint, ""),
    placeholders,
    fixed_sections: Array.isArray(value.fixed_sections)
      ? value.fixed_sections.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [],
    output_name_rule: stringValue(value.output_name_rule, defaultReportOutputRule(type)),
    is_default: value.is_default === true,
    created_at: stringValue(value.created_at, new Date(0).toISOString()),
    updated_at: stringValue(value.updated_at, new Date(0).toISOString()),
  };
}

export function reportTemplateRegistryPath(rootPath: string): string {
  return joinPath(rootPath, ".blackbox", "report-templates.json");
}

export function reportTemplateStoragePath(rootPath: string, templatesDirectory: string, type: "markdown" | "docx", name: string, id: string): string {
  const extension = type === "docx" ? "docx" : "md";
  const safeName = sanitizeFileName(name.replace(/\.(md|markdown|docx)$/i, "")) || "report-template";
  return joinPath(rootPath, templatesDirectory || "templates", "report", `${safeName}-${id}.${extension}`);
}

export function renderReportOutputName(rule: string, context: {
  requirement_id: string;
  requirement_name?: string;
  platform: string;
  platform_id: string;
  version?: string;
  report_id?: string;
  date?: string;
}, type: "markdown" | "docx"): string {
  const extension = type === "docx" ? "docx" : "md";
  const values: Record<string, string> = {
    ...context,
    ext: extension,
    date: context.date || new Date().toISOString().slice(0, 10),
  };
  let result = (rule || defaultReportOutputRule(type)).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key: string) => values[key] || "");
  result = sanitizeFileName(result.trim()) || `test-report.${extension}`;
  if (!/\.[a-z0-9]+$/i.test(result)) result = `${result}.${extension}`;
  return result;
}

export function createReportId(): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `report-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${suffix}`;
}

export function buildReportData(input: ReportBuildInput): ReportBuildData {
  const sourceRequirement = normalizeRequirementSource(input.requirement_yaml, input.run.requirement_id, input.run.requirement_id, input.platform_name);
  const requirement = { ...sourceRequirement, platform: input.platform_name || sourceRequirement.platform };
  const snapshotCaseMap = new Map(input.snapshot.cases.map((item) => [item.id, item]));
  const resultMap = new Map(input.results.results.map((item) => [item.case_id, item]));
  const scopeIds = input.run.execution_scope.case_ids.filter((item) => item.trim().length > 0);
  const resultIds = scopeIds.length ? scopeIds : input.snapshot.cases.map((item) => item.id);
  const scopedResults = resultIds.map((caseId) => resultMap.get(caseId) || createTestCaseResult(caseId, input.run.updated_at));
  const stats = getTestRunStats([...scopedResults.filter((item) => !item.deleted), ...input.results.results.filter((item) => item.deleted)], input.results.case_change_history || []);
  const summaryByResult = (result: TestCaseResult): ReportCaseSummary => summarizeCase(result, snapshotCaseMap.get(result.case_id));
  const validResults = scopedResults.filter((item) => !item.deleted && !item.needs_retest);
  const failedCases = validResults.filter((item) => item.status === "failed").map(summaryByResult);
  const blockedCases = validResults.filter((item) => item.status === "blocked").map(summaryByResult);
  const skippedCases = validResults.filter((item) => item.status === "skipped").map(summaryByResult);
  const evidenceCount = scopedResults.reduce((total, item) => total + item.evidence.length, 0);
  const passRate = stats.pass_rate === null ? "—" : `${stats.pass_rate.toFixed(2)}%`;
  const placeholders: Record<ReportPlaceholder, string> = {
    requirement_id: requirement.id,
    requirement_name: requirement.name,
    platform: requirement.platform || input.platform_name,
    test_environment: input.run.environment || "未填写",
    application_versions: input.run.application_versions || "未填写",
    case_total: String(stats.total),
    passed: String(stats.passed),
    failed: String(stats.failed),
    blocked: String(stats.blocked),
    skipped: String(stats.skipped),
    not_executed: String(stats.not_executed),
    pass_rate: passRate,
    failed_cases: formatCaseSummaries(failedCases),
    blocked_cases: formatCaseSummaries(blockedCases),
    skipped_cases: formatCaseSummaries(skippedCases),
    risks: input.risks.trim() || "未填写",
    remaining_issues: input.remaining_issues.trim() || "未填写",
  };
  return { requirement, stats, failed_cases: failedCases, blocked_cases: blockedCases, skipped_cases: skippedCases, evidence_count: evidenceCount, placeholders };
}

export function renderMarkdownReport(templateContent: string, data: ReportBuildData): string {
  const source = templateContent.trim() ? templateContent : defaultReportMarkdown(data);
  return source.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    const normalizedKey = key as ReportPlaceholder;
    return normalizedKey in data.placeholders ? data.placeholders[normalizedKey] : match;
  });
}

export async function renderDocxReport(templateBytes: Uint8Array, data: ReportBuildData): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(templateBytes);
  if (!zip.file("word/document.xml")) throw new Error("DOCX模板中不存在word/document.xml");
  const xmlFiles = Object.keys(zip.files).filter((name) => name.toLowerCase().endsWith(".xml"));
  for (const name of xmlFiles) {
    const file = zip.file(name);
    if (!file) continue;
    let xml = await file.async("string");
    for (const [key, value] of Object.entries(data.placeholders)) {
      xml = xml.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, "g"), docxValue(value));
    }
    zip.file(name, xml);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export function defaultReportMarkdown(data: ReportBuildData): string {
  const { placeholders, stats, evidence_count } = data;
  return [
    `# ${placeholders.requirement_name} 测试报告`,
    "",
    `- 需求编号：${placeholders.requirement_id}`,
    `- 平台：${placeholders.platform}`,
    `- 测试环境：${placeholders.test_environment}`,
    `- 应用版本：${placeholders.application_versions}`,
    "",
    "## 测试概况",
    "",
    `| 指标 | 数值 |`,
    "|---|---:|",
    `| 用例总数 | ${placeholders.case_total} |`,
    `| 通过 | ${placeholders.passed} |`,
    `| 失败 | ${placeholders.failed} |`,
    `| 阻塞 | ${placeholders.blocked} |`,
    `| 暂不执行 | ${placeholders.skipped} |`,
    `| 未执行 | ${placeholders.not_executed} |`,
    `| 不适用 | ${stats.not_applicable} |`,
    `| 登记进度 | ${data.stats.registered}/${data.stats.total}（${data.stats.progress}%） |`,
    `| 实际执行（当前适用范围） | ${data.stats.executed}/${data.stats.applicable} |`,
    `| 待复测 | ${data.stats.needs_retest} |`,
    `| 不适用 | ${data.stats.not_applicable} |`,
    `| 已删除（不计有效总数） | ${data.stats.deleted} |`,
    `| 通过率（有效通过/通过与失败） | ${placeholders.pass_rate} |`,
    `| 证据数量 | ${evidence_count} |`,
    "",
    "## 失败用例",
    "",
    placeholders.failed_cases,
    "",
    "## 阻塞用例",
    "",
    placeholders.blocked_cases,
    "",
    "## 暂不执行用例",
    "",
    placeholders.skipped_cases,
    "",
    "## 风险",
    "",
    placeholders.risks,
    "",
    "## 遗留问题",
    "",
    placeholders.remaining_issues,
    "",
    "## 数据来源",
    "",
    "本报告仅基于指定测试轮次的 `run.json`、`cases-snapshot.json`、`results.json`、证据元数据和本次填写的风险/遗留问题生成。",
    "",
  ].join("\n");
}

export function normalizeRequirementSource(value: unknown, fallbackId: string, fallbackName: string, fallbackPlatform: string): ReportRequirementSource {
  const root = isRecord(value) ? value : {};
  const raw = isRecord(root.requirement) ? root.requirement : root;
  return {
    id: stringValue(raw.id, fallbackId),
    name: stringValue(raw.name, fallbackName),
    platform: stringValue(raw.platform, fallbackPlatform),
    owner: stringValue(raw.owner, ""),
  };
}

function summarizeCase(result: TestCaseResult, testCase?: StructuredTestCase): ReportCaseSummary {
  return {
    case_id: result.case_id,
    title: testCase?.title || result.case_id,
    actual_result: result.actual_result.trim() || "未填写",
    notes: result.notes.trim(),
    severity: result.severity,
    defect_url: defectSummary(result),
    evidence_count: result.evidence.length,
  };
}

function formatCaseSummaries(cases: ReportCaseSummary[]): string {
  if (!cases.length) return "无";
  return cases.map((item) => {
    const details = [
      `实际结果：${item.actual_result}`,
      item.notes ? `备注：${item.notes}` : "",
      item.defect_url ? `缺陷：${item.defect_url}` : "",
      `严重程度：${item.severity}；证据：${item.evidence_count} 个`,
    ].filter(Boolean);
    return `- ${item.title}（${item.case_id}）\n  - ${details.join("\n  - ")}`;
  }).join("\n");
}

function docxValue(value: string): string {
  return escapeXml(value).replace(/\r?\n/g, "</w:t><w:br/><w:t>");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 150);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object";
}

export interface ReportManifest {
  version: string;
  report_id: string;
  requirement_id: string;
  platform_id: string;
  run_id: string;
  template_id: string;
  template_version: string;
  template_fingerprint: string;
  output_type: "markdown" | "docx";
  output_path: string;
  created_at: string;
  stats: TestRunStats;
  risks: string;
  remaining_issues: string;
  sources: {
    requirement: string;
    run: string;
    snapshot: string;
    results: string;
    evidence: string;
  };
  [key: string]: unknown;
}

