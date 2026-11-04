// XMind 用例的解析、快照与修改记录。XMind 编辑器与 AI 重新生成共用这一套口径，保证用例ID、模块路径和变更记录一致。
import type JSZip from "jszip";
import { api } from "./api";

export type Topic = {
  id?: string;
  title?: string;
  children?: { attached?: Topic[]; [key: string]: unknown };
  [key: string]: unknown;
};
export type XMindSheet = { rootTopic?: Topic; [key: string]: unknown };
export type XMindContent = XMindSheet[];
export type ParsedCase = {
  id: string;
  sheetIndex: number;
  topicPath: number[];
  title: string;
  priority: string;
  testType: string;
  path: string[];
  preconditions: string[];
  steps: string[];
  expectedResults: string[];
};
export type ModuleNode = { title: string; path: string[]; caseCount: number };
export type CaseDraft = {
  title: string;
  priority: string;
  testType: string;
  preconditions: string[];
  steps: string[];
  expectedResults: string[];
};
export type CaseSnapshot = Omit<CaseDraft, "priority" | "testType"> & { priority: string; testType: string };
export type ChangeType = "added" | "modified" | "deleted";
export type ChangeRecord = {
  origin?: "human" | "ai" | "system" | "legacy";
  source?: string;
  actor?: string | null;
  event_id?: string;
  id: string;
  changedAt: string;
  filePath: string;
  caseId: string;
  /** 新增用例没有修改前快照 */
  before: CaseSnapshot | null;
  /** 删除用例没有修改后快照 */
  after: CaseSnapshot | null;
  changedFields: string[];
  /** 缺省视为 modified（早期编辑器记录没有该字段） */
  changeType?: ChangeType;
  /** 人工评审删除等原因说明（由操作人填写） */
  reason?: string;
  /** 用例所在模块路径，删除后仍能定位来源 */
  modulePath?: string[];
};

export const TEST_TYPES = ["功能测试", "性能测试", "兼容性测试", "易用性测试", "安全性测试", "稳定性测试", "接口测试", "自动化测试", "安装部署测试", "冒烟测试", "回归测试", "其他"];
export const HISTORY_ENTRY = "blackbox/changes.json";

export function parseContent(content: XMindContent, path: string): { cases: ParsedCase[]; modules: ModuleNode[]; rootTitle: string } {
  const parsedCases: ParsedCase[] = [];
  const parsedModules: ModuleNode[] = [];
  let rootTitle = "";
  content.forEach((sheet, sheetIndex) => {
    if (!sheet.rootTopic) return;
    if (!rootTitle) rootTitle = sheet.rootTopic.title || path.split(/[\\/]/).pop() || "XMind";
    walkTopic(sheet.rootTopic, [], parsedCases, parsedModules, sheetIndex, []);
  });
  return { cases: parsedCases, modules: deduplicateModules(parsedModules, parsedCases), rootTitle };
}

function walkTopic(topic: Topic, parentPath: string[], cases: ParsedCase[], modules: ModuleNode[], sheetIndex: number, topicPath: number[]) {
  const title = String(topic.title || "未命名主题").trim();
  if (/^tc-p\d-/i.test(title)) {
    cases.push(parseCase(topic, parentPath, sheetIndex, topicPath));
    return;
  }
  const currentPath = parentPath.length || modules.length ? [...parentPath, title] : [title];
  modules.push({ title, path: currentPath, caseCount: 0 });
  (topic.children?.attached || []).forEach((child, index) => walkTopic(child, currentPath, cases, modules, sheetIndex, [...topicPath, index]));
}

function parseCase(topic: Topic, path: string[], sheetIndex: number, topicPath: number[]): ParsedCase {
  const title = String(topic.title || "未命名用例");
  const priorityMatch = title.match(/^tc-p(\d)/i);
  const priority = priorityMatch ? `p${priorityMatch[1]}` : "p2";
  const testType = TEST_TYPES.find((type) => title.includes(type)) || "功能测试";
  const preconditions: string[] = [];
  const steps: string[] = [];
  const expectedResults: string[] = [];
  for (const child of topic.children?.attached || []) {
    const childTitle = String(child.title || "");
    const preconditionText = sectionText(childTitle, "pc");
    const actionText = sectionText(childTitle, "tx");
    const expectedText = sectionText(childTitle, "返回数据");
    if (preconditionText !== null) preconditions.push(...splitNumbered(preconditionText));
    if (actionText !== null) {
      steps.push(...splitNumbered(actionText));
      for (const nested of child.children?.attached || []) {
        const nestedExpected = sectionText(String(nested.title || ""), "返回数据");
        if (nestedExpected !== null) expectedResults.push(...splitNumbered(nestedExpected));
      }
    }
    if (expectedText !== null && actionText === null) expectedResults.push(...splitNumbered(expectedText));
  }
  const id = (typeof topic.blackbox_case_id === "string" ? topic.blackbox_case_id : topic.id) || `case-${sheetIndex}-${topicPath.join("-") || "root"}`;
  return { id, sheetIndex, topicPath, title, priority, testType, path, preconditions, steps, expectedResults };
}

function sectionText(title: string, label: string): string | null {
  const match = title.match(new RegExp(`^${label}\\s*[:：]\\s*(.*)$`, "is"));
  return match ? match[1] : null;
}

export function splitNumbered(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => line.split(/(?=\d+[、.)．]\s*)/)).map((line) => line.trim().replace(/^\d+[、.)．]\s*/, "").trim()).filter(Boolean);
}

export function stripCasePrefix(title: string): string { return title.replace(/^tc-p\d-[^:：]*[:：]\s*/i, "").trim(); }
export function samePath(left: string[], right: string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function deduplicateModules(modules: ModuleNode[], cases: ParsedCase[]): ModuleNode[] { const seen = new Set<string>(); return modules.filter((module, index) => { const key = module.path.join("/"); if (index === 0 || seen.has(key)) return false; seen.add(key); module.caseCount = cases.filter((item) => module.path.every((part, pathIndex) => item.path[pathIndex] === part)).length; return module.caseCount > 0; }); }
export function draftFromCase(item: ParsedCase): CaseDraft { return { title: stripCasePrefix(item.title), priority: item.priority, testType: item.testType, preconditions: [...item.preconditions], steps: [...item.steps], expectedResults: [...item.expectedResults] }; }
export function snapshotFromCase(item: ParsedCase): CaseSnapshot { return draftFromCase(item); }
export function snapshotFromDraft(draft: CaseDraft): CaseSnapshot { return { title: draft.title.trim(), priority: draft.priority, testType: draft.testType, preconditions: [...draft.preconditions], steps: [...draft.steps], expectedResults: [...draft.expectedResults] }; }
const CASE_FIELDS: Array<[string, (snapshot: CaseSnapshot) => string | string[]]> = [["标题", (snapshot) => snapshot.title], ["优先级", (snapshot) => snapshot.priority], ["测试类型", (snapshot) => snapshot.testType], ["前置条件", (snapshot) => snapshot.preconditions], ["操作步骤", (snapshot) => snapshot.steps], ["期望结果", (snapshot) => snapshot.expectedResults]];
export function changedCaseFields(before: CaseSnapshot, after: CaseSnapshot): string[] { return CASE_FIELDS.filter(([, pick]) => !sameValue(pick(before), pick(after))).map(([label]) => label); }
function sameValue(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
export type DiffLine = { kind: "removed" | "added"; text: string };
type DiffOp = { kind: "same" | "removed" | "added"; before: number; after: number };
function diffOps(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: DiffOp[] = [];
  let removed: DiffOp[] = [];
  let added: DiffOp[] = [];
  const flush = () => { ops.push(...removed, ...added); removed = []; added = []; };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) { flush(); ops.push({ kind: "same", before: i, after: j }); i += 1; j += 1; }
    else if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) { removed.push({ kind: "removed", before: i, after: -1 }); i += 1; }
    else { added.push({ kind: "added", before: -1, after: j }); j += 1; }
  }
  flush();
  return ops;
}
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const op of diffOps(before, after)) {
    if (op.kind === "removed") lines.push({ kind: "removed", text: before[op.before] });
    else if (op.kind === "added") lines.push({ kind: "added", text: after[op.after] });
  }
  return lines;
}
export function diffRecordField(record: ChangeRecord, field: string): DiffLine[] {
  const pick = CASE_FIELDS.find(([label]) => label === field)?.[1];
  const lines = (snapshot: CaseSnapshot | null) => (!pick || !snapshot ? [] : [pick(snapshot)].flat());
  return diffLines(lines(record.before), lines(record.after));
}
function formatNumbered(items: string[], numbered: boolean): string { return numbered ? items.map((item, index) => `${index + 1}、${item.trim()}`).join("\n") : (items[0] ?? "").trim(); }
function createTopic(title: string): Topic { return { id: createId(), title, children: { attached: [] } }; }
export function createId(): string { return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `bb-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
export function topicAtPath(content: XMindContent, sheetIndex: number, topicPath: number[]): Topic | null { let topic = content[sheetIndex]?.rootTopic || null; for (const index of topicPath) topic = topic?.children?.attached?.[index] || null; return topic; }
export function updateTopic(topic: Topic, draft: CaseDraft) {
  topic.title = `tc-${draft.priority}-${draft.testType}: ${draft.title.trim() || "未命名用例"}`;
  const children = topic.children?.attached || [];
  if (!topic.children) topic.children = { attached: children };
  const txTopics = children.filter((child) => isSection(child, "tx"));
  const expectedTopics = [...children.filter((child) => isSection(child, "返回数据")), ...txTopics.flatMap((tx) => (tx.children?.attached || []).filter((child) => isSection(child, "返回数据")))];
  const pc = children.find((child) => isSection(child, "pc"));
  const at = children.findIndex((child) => SECTION_LABELS.some((label) => isSection(child, label)));
  const sections: Topic[] = [];
  if (draft.preconditions.length) sections.push(withSection(pc || createTopic("pc:"), "pc", draft.preconditions));
  if (draft.steps.length || draft.expectedResults.length) {
    const tx = withSection(txTopics[0] || createTopic("tx:"), "tx", draft.steps);
    const attached = (tx.children?.attached || []).filter((child) => !isSection(child, "返回数据"));
    tx.children = { ...tx.children, attached };
    if (draft.expectedResults.length) attached.push(withSection(expectedTopics[0] || createTopic("返回数据:"), "返回数据", draft.expectedResults));
    sections.push(tx);
  }
  const rest = children.filter((child) => !SECTION_LABELS.some((label) => isSection(child, label)));
  rest.splice(at < 0 ? rest.length : at, 0, ...sections);
  topic.children.attached = rest;
}
function withSection(topic: Topic, label: string, items: string[]): Topic {
  topic.title = `${label}: ${formatNumbered(items, label === "pc" || items.length > 1)}`;
  return topic;
}
/** 按主题路径移除用例节点（评审删除用），返回被移除的主题，未找到返回 null。 */
export function removeCaseTopic(content: XMindContent, sheetIndex: number, topicPath: number[]): Topic | null {
  if (!topicPath.length) return null;
  const parent = topicAtPath(content, sheetIndex, topicPath.slice(0, -1));
  const attached = parent?.children?.attached;
  if (!attached) return null;
  const index = topicPath[topicPath.length - 1];
  const removed = index >= 0 && index < attached.length ? attached.splice(index, 1)[0] : undefined;
  return removed || null;
}
const SECTION_LABELS = ["pc", "tx", "返回数据"];
function isSection(topic: Topic, label: string): boolean { return sectionText(String(topic.title || ""), label) !== null; }

/** 读取修改记录：优先包内 blackbox/changes.json，缺失时回退到旁路 .changes.json */
export async function readHistory(zip: JSZip, path: string): Promise<ChangeRecord[]> {
  const embedded = zip.file(HISTORY_ENTRY);
  if (embedded) {
    try {
      const parsed = JSON.parse(await embedded.async("string")) as ChangeRecord[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 旁路记录仍可能可用
    }
  }
  try {
    const sidecar = JSON.parse(await api.readTextFile(`${path}.changes.json`)) as ChangeRecord[];
    return Array.isArray(sidecar) ? sidecar : [];
  } catch {
    return [];
  }
}

export function buildHistoryMarkdown(path: string, records: ChangeRecord[]): string {
  const lines = [`# XMind用例修改记录`, "", `- 文件：${path}`, `- 记录数：${records.length}`, ""];
  for (const record of records.slice().reverse()) {
    const title = (record.after ?? record.before)?.title ?? record.caseId;
    const typeLabel = record.changeType === "deleted" ? "删除" : record.changeType === "added" ? "新增" : "修改";
    lines.push(`## ${formatDateTime(record.changedAt)} · ${title}`, "", `- 用例ID：${record.caseId}`, `- 变更类型：${typeLabel}`, `- 修改字段：${record.changedFields.join("、")}`, ...(record.modulePath?.length ? [`- 所在目录：${record.modulePath.join(" / ")}`] : []), ...(record.reason ? [`- 修改依据/原因：${record.reason}`] : []), "", "### 修改前", snapshotMarkdown(record.before), "", "### 修改后", snapshotMarkdown(record.after), "");
  }
  return lines.join("\n");
}
function snapshotMarkdown(snapshot: CaseSnapshot | null): string {
  if (!snapshot) return "- 无";
  return [`- 标题：${snapshot.title}`, `- 优先级：${snapshot.priority.toUpperCase()}`, `- 测试类型：${snapshot.testType}`, `- 前置条件：${snapshot.preconditions.join("；") || "无"}`, `- 操作步骤：${snapshot.steps.join("；") || "无"}`, `- 期望结果：${snapshot.expectedResults.join("；") || "无"}`].join("\n");
}
export function formatDateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false }); }
