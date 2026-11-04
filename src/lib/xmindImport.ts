import JSZip from "jszip";
import { caseActions, caseExpectedResults, createCaseId, updateCasesMetadata } from "./cases";
import type { CaseDirectoryNode, CasePriority, CasesDocument, StructuredTestCase } from "./types";

export const XMindTestTypes = [
  "功能测试",
  "性能测试",
  "兼容性测试",
  "易用性测试",
  "安全性测试",
  "稳定性测试",
  "接口测试",
  "自动化测试",
  "安装部署测试",
  "冒烟测试",
  "回归测试",
  "其他",
] as const;

const XMindTestTypePattern = XMindTestTypes.join("|");
const XMindCaseTitlePattern = new RegExp(
  `^\\s*tc-p([012])\\s*[-—－]\\s*(${XMindTestTypePattern})\\s*[:：]\\s*(.+?)\\s*$`,
  "i",
);

/** Normalize common legacy title punctuation for the strict XMind template without changing cases.json. */
export function normalizeXMindCaseTitle(title: string): string {
  const match = title.match(XMindCaseTitlePattern);
  if (!match) return title.trim();
  const testType = XMindTestTypes.find((item) => item.toLocaleLowerCase() === match[2].toLocaleLowerCase()) || match[2];
  return `tc-p${match[1]}-${testType}: ${match[3].trim()}`;
}

export interface XMindDirectoryNode {
  id: string;
  title: string;
  node_type: "platform" | "module" | "workbook";
  children: XMindDirectoryNode[];
}

export interface XMindCaseStep {
  order: number;
  action: string;
  expected: string[];
}

export interface XMindImportedCase {
  source?: StructuredTestCase["source"];
  id: string;
  title: string;
  directory_id: string;
  priority: number;
  test_type: string;
  preconditions: string[];
  steps: XMindCaseStep[];
  expected_results: string[];
  tags: string[];
  platforms: string[];
  requirement_refs: string[];
  asset_refs: string[];
  requires_evidence: boolean;
  automation_status: string;
  created_by: "import";
  version: number;
  status: string;
}

export interface XMindImportMetadata {
  total_count: number;
  directory_count: number;
  sheet_count: number;
  source_file: string;
  source_fingerprint: string;
  imported_at: string;
  created_by: "import";
  missing: {
    preconditions: number;
    steps: number;
    expected: number;
  };
  duplicate_titles: string[][];
  [key: string]: unknown;
}

export interface XMindImportData {
  version: "1.0";
  requirement_id: string;
  platform: string;
  platform_id?: string;
  tree: XMindDirectoryNode;
  cases: XMindImportedCase[];
  metadata: XMindImportMetadata;
}

export interface XMindImportPreview {
  data: XMindImportData;
  rootTitle: string;
  directoryCount: number;
  totalCount: number;
  priorityCounts: Record<"P0" | "P1" | "P2", number>;
  typeCounts: Array<{ label: string; count: number }>;
  missing: XMindImportMetadata["missing"];
  duplicateTitles: string[][];
}

type RawTopic = {
  id?: unknown;
  title?: unknown;
  children?: {
    attached?: unknown;
    detached?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type RawSheet = {
  rootTopic?: RawTopic;
  [key: string]: unknown;
};

const CASE_TITLE_PATTERN = /^\s*tc-p\d+\b/i;
const SECTION_PATTERN = /^\s*(pc|tx|返回数据)\s*[:：]?\s*(.*)$/is;

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function parseXMind(bytes: Uint8Array, sourceFile: string, sourceFingerprint?: string): Promise<XMindImportData> {
  const zip = await JSZip.loadAsync(bytes);
  const contentFile = zip.file("content.json");
  if (!contentFile) throw new Error("XMind文件中不存在content.json");
  const content = JSON.parse(await contentFile.async("string")) as unknown;
  if (!Array.isArray(content)) throw new Error("content.json顶层必须是数组");

  const sheets = (content as RawSheet[]).flatMap((sheet, index) => sheet?.rootTopic ? [{ index, root: sheet.rootTopic }] : []);
  if (!sheets.length) throw new Error("XMind中没有可用的根主题");

  const cases: XMindImportedCase[] = [];
  const trees = sheets.map(({ index, root }) => {
    const start = cases.length;
    const tree = parseDirectoryTopic(root, cases, index);
    cases.slice(start).forEach((item) => { item.source = { file: sourceFile, sheet_id: String((content as RawSheet[])[index].id || ""), sheet_index: index, topic_id: item.id, directory_id: item.directory_id, baseline: { ...item, priority: item.priority as CasePriority } }; });
    return tree;
  });
  const tree: XMindDirectoryNode = trees.length === 1
    ? trees[0]
    : { id: "xmind-workbook-root", title: sourceFile.split(/[\\/]/).pop()?.replace(/\.xmind$/i, "") || "XMind测试用例", node_type: "workbook", children: trees };
  const duplicateTitles = findDuplicateTitles(cases);
  const missing = {
    preconditions: cases.filter((item) => item.preconditions.length === 0).length,
    steps: cases.filter((item) => item.steps.length === 0).length,
    expected: cases.filter((item) => item.expected_results.length === 0).length,
  };
  const importedAt = new Date().toISOString();
  const data: XMindImportData = {
    version: "1.0",
    requirement_id: "",
    platform: "",
    tree,
    cases,
    metadata: {
      total_count: cases.length,
      directory_count: countDirectories(tree),
      sheet_count: trees.length,
      source_file: sourceFile,
      source_fingerprint: sourceFingerprint || await sha256Bytes(bytes),
      imported_at: importedAt,
      created_by: "import",
      missing,
      duplicate_titles: duplicateTitles,
    },
  };
  return data;
}

export function buildXMindImportPreview(data: XMindImportData): XMindImportPreview {
  const typeMap = new Map<string, number>();
  data.cases.forEach((item) => typeMap.set(item.test_type, (typeMap.get(item.test_type) || 0) + 1));
  return {
    data,
    rootTitle: data.tree.title,
    directoryCount: data.metadata.directory_count,
    totalCount: data.metadata.total_count,
    priorityCounts: {
      P0: data.cases.filter((item) => item.priority === 0).length,
      P1: data.cases.filter((item) => item.priority === 1).length,
      P2: data.cases.filter((item) => item.priority !== 0 && item.priority !== 1).length,
    },
    typeCounts: [...typeMap.entries()].map(([label, count]) => ({ label, count })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    missing: data.metadata.missing,
    duplicateTitles: data.metadata.duplicate_titles,
  };
}

/** Assign stable case/directory IDs to the generated first canvas, preserving ZIP resources. */
export async function withStructuredCaseIds(bytes: Uint8Array, document: CasesDocument): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const sheets = JSON.parse(await zip.file("content.json")!.async("string"));
  const numbered = (values: string[]) => values.map((value, index) => `${index + 1}. ${value}`).join("\n");
  const caseTopic = (item: StructuredTestCase) => ({ id: item.id, blackbox_case_id: item.id, title: normalizeXMindCaseTitle(item.title), children: { attached: [
    { id: `${item.id}-pc`, title: `pc: ${numbered(item.preconditions)}` },
    { id: `${item.id}-tx`, title: `tx: ${numbered(caseActions(item))}`, children: { attached: [{ id: `${item.id}-expected`, title: `返回数据: ${numbered(caseExpectedResults(item))}` }] } },
  ] } });
  const nodeTopic = (node: CaseDirectoryNode): unknown => ({ id: node.id, title: node.title, children: { attached: [
    ...node.children.filter((child) => child.node_type !== "case_ref").map(nodeTopic),
    ...document.cases.filter((item) => item.directory_id === node.id).map(caseTopic),
  ] } });
  sheets[0].rootTopic = nodeTopic(document.tree);
  zip.file("content.json", JSON.stringify(sheets, null, 2));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function parseDirectoryTopic(topic: RawTopic, cases: XMindImportedCase[], sheetIndex: number, topicPath: number[] = [], isRoot = true): XMindDirectoryNode {
  const id = topicId(topic, `topic-${sheetIndex}-${topicPath.length ? topicPath.join("-") : "root"}`);
  const node: XMindDirectoryNode = {
    id,
    title: String(topic.title ?? ""),
    node_type: isRoot ? "platform" : "module",
    children: [],
  };
  topicChildren(topic).forEach((child, index) => {
    const childTitle = String(child.title ?? "");
    const childPath = [...topicPath, index];
    if (isCaseTitle(childTitle)) {
      cases.push(parseCase(child, id, `case-${sheetIndex}-${childPath.join("-")}`));
      return;
    }
    node.children.push(parseDirectoryTopic(child, cases, sheetIndex, childPath, false));
  });
  return node;
}

function parseCase(topic: RawTopic, directoryId: string, fallbackId: string): XMindImportedCase {
  const title = String(topic.title ?? "").trim();
  const priorityMatch = title.match(/^\s*tc-p(\d+)/i);
  const priorityValue = priorityMatch ? Number(priorityMatch[1]) : 2;
  const priority = priorityValue === 0 || priorityValue === 1 || priorityValue === 2 ? priorityValue : 2;
  const prefix = title.split(/[:：]/, 1)[0];
  const testType = XMindTestTypes.find((item) => prefix.includes(item)) || "功能测试";
  const preconditions: string[] = [];
  const actions: string[] = [];
  const expected: string[] = [];

  topicChildren(topic).forEach((child) => {
    const section = parseSection(String(child.title ?? ""));
    if (!section) return;
    if (section.name === "pc") {
      preconditions.push(...splitNumbered(section.text));
    } else if (section.name === "tx") {
      actions.push(...splitNumbered(section.text));
      topicChildren(child).forEach((nested) => {
        const nestedSection = parseSection(String(nested.title ?? ""));
        if (nestedSection?.name === "返回数据") expected.push(...splitNumbered(nestedSection.text));
      });
    } else if (section.name === "返回数据") {
      expected.push(...splitNumbered(section.text));
    }
  });

  return {
    id: typeof topic.blackbox_case_id === "string" ? topic.blackbox_case_id : topicId(topic, fallbackId),
    title,
    directory_id: directoryId,
    priority,
    test_type: testType,
    preconditions,
    steps: actions.map((action, index) => ({ order: index + 1, action, expected: index === actions.length - 1 ? expected : [] })),
    expected_results: expected,
    tags: [],
    platforms: [],
    requirement_refs: [],
    asset_refs: [],
    requires_evidence: false,
    automation_status: "none",
    created_by: "import",
    version: 1,
    status: "draft",
  };
}

function topicChildren(topic: RawTopic): RawTopic[] {
  const children = topic.children;
  if (!children) return [];
  return ["attached", "detached"].flatMap((key) => Array.isArray(children[key]) ? children[key].filter(isRecord) as RawTopic[] : []);
}

function topicId(topic: RawTopic, fallback: string): string {
  return typeof topic.id === "string" && topic.id.trim() ? topic.id.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isCaseTitle(title: string): boolean {
  return CASE_TITLE_PATTERN.test(title);
}

function parseSection(title: string): { name: string; text: string } | null {
  const match = title.match(SECTION_PATTERN);
  return match ? { name: match[1].toLowerCase(), text: match[2] } : null;
}

// 内联编号拆分：只在条目边界（行首或空白/句读之后）识别「数字+编号符」，
// 编号限 1-2 位数字，且 . ：: ． 后紧跟数字（小数、时间、比例如 0.2、10:30、4999.99）不视为编号。
const NUMBERED_ITEM_BOUNDARY = /(?<=^|[\s:：;；。，,])(?=\d{1,2}\s*(?:、|\)|[.:：．](?!\d)))/;
const NUMBERED_ITEM_PREFIX = /^\d{1,2}\s*(?:、|\)|[.:：．](?!\d))\s*/;

function splitNumbered(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => line.split(NUMBERED_ITEM_BOUNDARY)).map((line) => line.trim().replace(NUMBERED_ITEM_PREFIX, "").replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
}

function countDirectories(node: XMindDirectoryNode): number {
  return 1 + node.children.reduce((total, child) => total + countDirectories(child), 0);
}

function normalizedTitle(title: string): string {
  return title.replace(/^\s*tc-p\d+\s*[-—－]?[^:：]*[:：]?\s*/i, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function findDuplicateTitles(cases: XMindImportedCase[]): string[][] {
  const groups = new Map<string, string[]>();
  cases.forEach((item) => {
    const key = normalizedTitle(item.title);
    if (!key) return;
    groups.set(key, [...(groups.get(key) || []), item.title]);
  });
  return [...groups.values()].filter((items) => items.length > 1);
}

/**
 * 将 cases.json 反向导出为 XMind 缩进大纲（配合 buildXMindBytes 生成 .xmind，供归档或上传云效用例库）。
 * 目录树按层级展开，用例保留 `tc-pN-类型: 标题` 全名；前置条件/步骤/期望以 pc:/tx:/返回数据: 小节行内编号输出，
 * 与 parseXMind 的解析口径一致，可无损回读（多值拼接为「1、… 2、…」内联格式，splitNumbered 可还原）。
 */
export function casesDocumentToOutline(document: CasesDocument): { title: string; outline: string } {
  const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
  const numbered = (items: string[]) => items.map(clean).filter(Boolean).map((text, index) => `${index + 1}、${text}`).join(" ");
  const known = new Set<string>();
  const collect = (node: CaseDirectoryNode) => { known.add(node.id); node.children.forEach(collect); };
  collect(document.tree);
  const byDirectory = new Map<string, StructuredTestCase[]>();
  document.cases.forEach((item) => {
    const key = known.has(item.directory_id) ? item.directory_id : document.tree.id;
    byDirectory.set(key, [...(byDirectory.get(key) ?? []), item]);
  });
  const lines: string[] = [];
  const emitCase = (item: StructuredTestCase, depth: number) => {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${clean(normalizeXMindCaseTitle(item.title)) || "未命名用例"}`);
    const section = `${indent}  `;
    const preconditions = numbered(item.preconditions);
    if (preconditions) lines.push(`${section}pc: ${preconditions}`);
    const actions = numbered(caseActions(item));
    if (actions) {
      lines.push(`${section}tx: ${actions}`);
      const expected = numbered(caseExpectedResults(item));
      if (expected) lines.push(`${section}  返回数据: ${expected}`);
    }
  };
  const emit = (node: CaseDirectoryNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${clean(node.title) || "未命名目录"}`);
    node.children.forEach((child) => emit(child, depth + 1));
    (byDirectory.get(node.id) ?? []).forEach((item) => emitCase(item, depth + 1));
  };
  document.tree.children.forEach((child) => emit(child, 0));
  (byDirectory.get(document.tree.id) ?? []).forEach((item) => emitCase(item, 0));
  return { title: clean(document.tree.title) || "测试用例", outline: lines.join("\n") };
}

interface MergeableNode {
  id: string;
  title: string;
  children: MergeableNode[];
}

function cloneTree<T extends MergeableNode>(node: T): T {
  return { ...node, children: node.children.map((child) => cloneTree(child)) };
}

/// 把 incoming 的树按标题合并进 keeper：同级标题相同的节点保留 keeper 的并递归合并子级，
/// incoming 中被吞掉的节点 id 记入 remap，供用例 directory_id 重定向。
function mergeDirectoryChildren(keeper: MergeableNode, incoming: MergeableNode, remap: Map<string, string>) {
  remap.set(incoming.id, keeper.id);
  incoming.children.forEach((child) => {
    const hit = keeper.children.find((item) => item.title === child.title);
    if (hit) {
      mergeDirectoryChildren(hit, child, remap);
    } else {
      keeper.children.push(cloneTree(child));
    }
  });
}

function missingStats(cases: Array<{ preconditions: string[]; steps: XMindCaseStep[]; expected_results?: string[] }>) {
  return {
    preconditions: cases.filter((item) => item.preconditions.length === 0).length,
    steps: cases.filter((item) => item.steps.length === 0).length,
    expected: cases.filter((item) => caseExpectedResults(item).length === 0).length,
  };
}

/// 多份 XMind 解析结果合并为一份导入数据：同标题目录合并（保留先出现节点的 id），
/// 根节点标题不同则整棵并入根节点之下；用例全量拼接，重复标题只在 metadata 中标注。
export function mergeXMindImportData(documents: XMindImportData[], sourceLabel: string, fingerprint: string): XMindImportData {
  if (!documents.length) throw new Error("没有可合并的XMind数据");
  if (documents.length === 1) {
    const single = documents[0];
    return { ...single, metadata: { ...single.metadata, source_file: sourceLabel, source_fingerprint: fingerprint } };
  }
  const tree = cloneTree(documents[0].tree);
  const cases = documents[0].cases.map((item) => ({ ...item }));
  const takenCaseIds = new Set(cases.map((item) => item.id));
  for (const document of documents.slice(1)) {
    const remap = new Map<string, string>();
    if (document.tree.title === tree.title) {
      mergeDirectoryChildren(tree, document.tree, remap);
    } else {
      tree.children.push(cloneTree(document.tree));
    }
    document.cases.forEach((item) => {
      const id = takenCaseIds.has(item.id) ? createCaseId() : item.id;
      takenCaseIds.add(id);
      const directoryId = remap.get(item.directory_id) || item.directory_id;
      cases.push({ ...item, id, directory_id: directoryId,
        source: item.source ? { ...item.source, baseline: { ...item.source.baseline, id, directory_id: directoryId } } : undefined });
    });
  }
  return {
    version: "1.0",
    requirement_id: "",
    platform: "",
    tree,
    cases,
    metadata: {
      total_count: cases.length,
      directory_count: countDirectories(tree),
      sheet_count: documents.reduce((total, item) => total + (item.metadata.sheet_count || 1), 0),
      source_file: sourceLabel,
      source_fingerprint: fingerprint,
      imported_at: new Date().toISOString(),
      created_by: "import",
      missing: missingStats(cases),
      duplicate_titles: findDuplicateTitles(cases),
    },
  };
}

export interface CasesMergeResult {
  document: CasesDocument;
  addedCount: number;
  skippedTitles: string[];
}

/// 把 XMind 导入数据合并进已有 cases.json：目录树按标题并入现有树，标题规范化后
/// 与现有用例重复的导入项跳过（保留现有版本），新增用例的 directory_id 重定向到合并后的节点。
export function mergeCasesDocument(existing: CasesDocument, imported: XMindImportData): CasesMergeResult {
  const tree = cloneTree(existing.tree) as CaseDirectoryNode;
  const remap = new Map<string, string>();
  const incomingRoot = imported.tree as unknown as CaseDirectoryNode;
  if (incomingRoot.title === tree.title) {
    mergeDirectoryChildren(tree, incomingRoot, remap);
  } else {
    tree.children.push(cloneTree(incomingRoot));
  }
  const takenIds = new Set(existing.cases.map((item) => item.id));

  const added: StructuredTestCase[] = [];
  const skippedTitles: string[] = [];
  imported.cases.forEach((item) => {
    if (existing.cases.some((old) => old.id === item.id && (!old.source || old.source.file === item.source?.file))) {
      skippedTitles.push(item.title);
      return;
    }

    const id = takenIds.has(item.id) ? createCaseId() : item.id;
    takenIds.add(id);
    const directoryId = remap.get(item.directory_id) || item.directory_id;
    added.push({ ...item, id, priority: item.priority as CasePriority, directory_id: directoryId,
      source: item.source ? { ...item.source, baseline: { ...item.source.baseline, directory_id: directoryId } } : undefined });
  });
  const mergedCases = [...existing.cases, ...added];
  const document = updateCasesMetadata({ ...existing, tree, cases: mergedCases });
  document.metadata = {
    ...document.metadata,
    source_file: imported.metadata.source_file,
    source_fingerprint: imported.metadata.source_fingerprint,
    imported_at: new Date().toISOString(),
    missing: missingStats(mergedCases),
    duplicate_titles: findDuplicateTitles(mergedCases as XMindImportedCase[]),
  };
  return { document, addedCount: added.length, skippedTitles };
}
