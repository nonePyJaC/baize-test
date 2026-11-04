import ExcelJS from "exceljs";
import JSZip from "jszip";
import { joinPath } from "./api";
import { caseActions, caseExpectedResults, collectDirectoryNodes, normalizePriority } from "./cases";
import type {
  CaseDirectoryNode,
  CaseExportMappingResult,
  CaseExportPreview,
  CaseExportResult,
  CaseExportValidation,
  CaseTemplate,
  CaseTemplateMapping,
  CaseTemplateRegistry,
  CasesDocument,
  ExcelTemplateMapping,
  StructuredTestCase,
  XMindTemplateMapping,
} from "./types";

const XMindCaseTitlePattern = /^\s*tc-p\d+\b/i;
const XMindSectionPattern = /^\s*(pc|tx|返回数据)\s*[:：]?/i;

export const TEMPLATE_REGISTRY_VERSION = "1.0";

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function defaultXMindMapping(): XMindTemplateMapping {
  return {
    root_topic: "",
    directory_placeholder: "{{目录}}",
    case_placeholder: "{{用例}}",
    pc_topic: "pc",
    tx_topic: "tx",
    expected_topic: "返回数据",
    expected_as_child: true,
  };
}

export function defaultExcelMapping(): ExcelTemplateMapping {
  return {
    worksheet: "",
    header_row: 1,
    data_start_row: 2,
    directory_column: "A",
    title_column: "B",
    priority_column: "C",
    test_type_column: "D",
    preconditions_column: "E",
    steps_column: "F",
    expected_column: "G",
  };
}

export function emptyTemplateRegistry(): CaseTemplateRegistry {
  return { version: TEMPLATE_REGISTRY_VERSION, templates: [] };
}

export function normalizeTemplateRegistry(value: unknown): CaseTemplateRegistry {
  if (!isRecord(value)) return emptyTemplateRegistry();
  const templates = Array.isArray(value.templates)
    ? value.templates.filter(isRecord).map((item, index) => normalizeTemplate(item, `template-${index}`))
    : [];
  return { ...value, version: typeof value.version === "string" ? value.version : TEMPLATE_REGISTRY_VERSION, templates };
}

export function normalizeTemplate(value: Record<string, unknown>, fallbackId: string): CaseTemplate {
  const type: "xmind" | "excel" = value.type === "excel" ? "excel" : "xmind";
  const rawMapping = isRecord(value.mapping) ? value.mapping : {};
  const mapping = type === "excel" ? normalizeExcelMapping(rawMapping) : normalizeXMindMapping(rawMapping);
  return {
    ...value,
    id: stringValue(value.id, fallbackId),
    name: stringValue(value.name, "未命名模板"),
    type,
    version: stringValue(value.version, "1.0"),
    file_path: stringValue(value.file_path, ""),
    platform_id: typeof value.platform_id === "string" && value.platform_id.trim() ? value.platform_id : null,
    fingerprint: stringValue(value.fingerprint, ""),
    output_name_rule: stringValue(value.output_name_rule, `{{requirement_id}}-{{platform_id}}-用例.${type === "excel" ? "xlsx" : "xmind"}`),
    mapping,
    required_fields: Array.isArray(value.required_fields) ? value.required_fields.filter((item): item is string => typeof item === "string") : [],
    is_default: value.is_default === true,
    created_at: stringValue(value.created_at, new Date(0).toISOString()),
    updated_at: stringValue(value.updated_at, new Date(0).toISOString()),
  };
}

export function templateRegistryPath(rootPath: string, templatesDirectory = "templates"): string {
  return joinPath(rootPath, ".blackbox", "templates.json");
}

export function resolveWorkspacePath(rootPath: string, path: string): string {
  return isAbsolutePath(path) ? path : joinPath(rootPath, path);
}

export function workspaceRelativePath(rootPath: string, path: string): string {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedPath = normalizePath(path);
  if (normalizedPath === normalizedRoot) return "";
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1);
  return normalizedPath;
}

export function templateStoragePath(rootPath: string, templatesDirectory: string, type: "xmind" | "excel", name: string, id: string): string {
  const extension = type === "excel" ? "xlsx" : "xmind";
  const safeName = sanitizeFileName(name.replace(/\.(xmind|xlsx)$/i, "")) || "template";
  return joinPath(rootPath, templatesDirectory || "templates", "testcase", type, `${safeName}-${id}.${extension}`);
}

export function renderOutputFileName(rule: string, context: {
  requirement_id: string;
  requirement_name?: string;
  platform: string;
  platform_id: string;
  version?: string;
  date?: string;
}, type: "xmind" | "excel"): string {
  const extension = type === "excel" ? "xlsx" : "xmind";
  const values: Record<string, string> = {
    ...context,
    ext: extension,
    date: context.date || new Date().toISOString().slice(0, 10),
  };
  let result = (rule || `{{requirement_id}}-{{platform_id}}-用例.${extension}`).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key: string) => values[key] || "");
  result = sanitizeFileName(result.trim()) || `testcases.${extension}`;
  if (!/\.[a-z0-9]+$/i.test(result)) result = `${result}.${extension}`;
  return result;
}

export function buildExportPreview(document: CasesDocument, template: CaseTemplate, outputPath: string): CaseExportPreview {
  const directories = collectDirectoryNodes(document.tree);
  const pathMap = directoryPathMap(document.tree);
  const missingCounts = new Map<string, number>();
  const mappings: CaseExportMappingResult[] = document.cases.map((item, index) => {
    const missing = missingFields(item);
    missing.forEach((field) => missingCounts.set(field, (missingCounts.get(field) || 0) + 1));
    const directory = pathMap.get(item.directory_id) || document.tree.title;
    const dataStartRow = Number(mappingValue(template.mapping, "data_start_row") || Number(mappingValue(template.mapping, "header_row") || 1) + 1);
    const target = template.type === "excel"
      ? `${mappingValue(template.mapping, "worksheet") || "第一个工作表"}!${dataStartRow + index}`
      : `${directory} > ${item.title}`;
    return { case_id: item.id, title: item.title, directory, target, missing_fields: missing };
  });
  const mappingMissing = templateMappingMissing(template.mapping, template.type);
  mappingMissing.forEach((field) => missingCounts.set(field, (missingCounts.get(field) || 0) + 1));
  const missingFieldSummary = [...missingCounts.entries()].map(([field, count]) => `${field}（${count}）`);
  return {
    output_path: outputPath,
    output_name: outputPath.split(/[\\/]/).pop() || outputPath,
    template,
    directory_count: directories.length,
    case_count: document.cases.length,
    missing_fields: missingFieldSummary,
    mappings: mappings.slice(0, 10),
    template_changed: false,
  };
}

export async function buildXMindExport(templateBytes: Uint8Array, document: CasesDocument, mappingValueInput: CaseTemplateMapping): Promise<CaseExportResult> {
  const mapping = normalizeXMindMapping(isRecord(mappingValueInput) ? mappingValueInput : {});
  const zip = await JSZip.loadAsync(templateBytes);
  const contentFile = zip.file("content.json");
  if (!contentFile) throw new Error("XMind模板中不存在content.json");
  const content = JSON.parse(await contentFile.async("string")) as unknown;
  if (!Array.isArray(content)) throw new Error("XMind模板content.json顶层必须是数组");
  const sheet = content.find((item): item is Record<string, unknown> => isRecord(item) && isRecord(item.rootTopic) && matchesReference(item.rootTopic, mapping.root_topic));
  const fallbackSheet = content.find((item): item is Record<string, unknown> => isRecord(item) && isRecord(item.rootTopic));
  const selectedSheet = sheet || fallbackSheet;
  if (!selectedSheet || !isRecord(selectedSheet.rootTopic)) throw new Error("XMind模板中没有可用的根主题");
  const root = selectedSheet.rootTopic;
  const directoryLocation = findTopicWithParent(root, mapping.directory_placeholder);
  const caseLocation = findTopicWithParent(root, mapping.case_placeholder);
  const directoryTemplate = directoryLocation?.topic || attachedTopicChildren(root).find((item) => !XMindCaseTitlePattern.test(String(item.title || "")));
  const caseTemplate = caseLocation?.topic || findFirstCaseTopic(root);
  const casesByDirectory = new Map<string, StructuredTestCase[]>();
  document.cases.forEach((item) => casesByDirectory.set(item.directory_id, [...(casesByDirectory.get(item.directory_id) || []), item]));

  const generatedDirectories = document.tree.children.map((node) => buildDirectoryTopic(node, directoryTemplate, caseTemplate, mapping, casesByDirectory));
  const rootCases = (casesByDirectory.get(document.tree.id) || []).map((item) => buildCaseTopic(item, caseTemplate, mapping));
  root.title = document.tree.title || String(root.title || "测试用例");
  const rootChildren = attachedTopicChildren(root);
  const directoryIndex = directoryLocation?.parent === root && directoryLocation.container === "attached"
    ? rootChildren.findIndex((item) => item === directoryLocation.topic)
    : -1;
  const generatedRootChildren = [...generatedDirectories, ...rootCases];
  if (directoryIndex >= 0) {
    rootChildren.splice(directoryIndex, 1, ...generatedRootChildren);
    rootChildren.splice(0, rootChildren.length, ...rootChildren.filter((item) => !matchesReference(item, mapping.case_placeholder)));
  } else {
    rootChildren.splice(0, rootChildren.length, ...generatedRootChildren);
  }
  setAttachedChildren(root, rootChildren);
  zip.file("content.json", JSON.stringify(content, null, 2));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const validation = await validateXMindBytes(bytes, document.cases.length);
  return { output_path: "", bytes, validation };
}

export async function validateXMindBytes(bytes: Uint8Array, expectedCount?: number): Promise<CaseExportValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requiredFiles = ["content.json", "metadata.json", "content.xml", "meta.xml", "styles.xml", "manifest.json"];
  try {
    const zip = await JSZip.loadAsync(bytes);
    requiredFiles.forEach((name) => { if (!zip.file(name)) errors.push(`XMind缺少必需文件：${name}`); });
    const contentFile = zip.file("content.json");
    if (!contentFile) return { passed: false, case_count: 0, errors, warnings };
    const content = JSON.parse(await contentFile.async("string")) as unknown;
    const roots = Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => isRecord(item) && isRecord(item.rootTopic)).map((item) => item.rootTopic as Record<string, unknown>) : [];
    if (!roots.length) errors.push("XMind没有可用根主题");
    const cases: RawTopic[] = [];
    roots.forEach((root) => collectCaseTopics(root, cases));
    cases.forEach((topic) => {
      const sections = topicChildren(topic).map((child) => ({ name: parseSectionName(String(child.title || "")), body: sectionBody(String(child.title || "")), topic: child }));
      const pc = sections.find((item) => item.name === "pc");
      const tx = sections.find((item) => item.name === "tx");
      const expected = sections.find((item) => item.name === "返回数据") || sections.flatMap((item) => topicChildren(item.topic).map((nested) => ({ name: parseSectionName(String(nested.title || "")), body: sectionBody(String(nested.title || "")), topic: nested }))).find((item) => item.name === "返回数据");
      if (!pc || !pc.body) errors.push(`用例缺少pc前置条件：${String(topic.title || "")}`);
      if (!tx || !tx.body) errors.push(`用例缺少tx测试步骤：${String(topic.title || "")}`);
      if (!expected || !expected.body) errors.push(`用例缺少返回数据：${String(topic.title || "")}`);
    });
    if (expectedCount !== undefined && cases.length !== expectedCount) errors.push(`XMind用例数量不一致：期望${expectedCount}，实际${cases.length}`);
    return { passed: errors.length === 0, case_count: cases.length, errors, warnings };
  } catch (reason) {
    errors.push(`XMind校验异常：${String(reason)}`);
    return { passed: false, case_count: 0, errors, warnings };
  }
}

export async function buildExcelExport(templateBytes: Uint8Array, document: CasesDocument, mappingValueInput: CaseTemplateMapping): Promise<CaseExportResult> {
  const mapping = normalizeExcelMapping(isRecord(mappingValueInput) ? mappingValueInput : {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBytes as any);
  const worksheet = mapping.worksheet ? workbook.getWorksheet(mapping.worksheet) : workbook.worksheets[0];
  if (!worksheet) throw new Error(`Excel模板中不存在工作表：${mapping.worksheet || "第一个工作表"}`);
  const rows = document.cases.map((item) => buildExcelRow(item, directoryPathMap(document.tree).get(item.directory_id) || document.tree.title, mapping));
  const dataStartRow = Math.max(mapping.data_start_row, mapping.header_row + 1);
  const prototype = worksheet.getRow(dataStartRow);
  const prototypeStyles = new Map<number, { style: Record<string, unknown>; numFmt?: string }>();
  mappedColumns(mapping).forEach((column) => {
    const cell = prototype.getCell(column);
    prototypeStyles.set(column, { style: cloneValue(cell.style as unknown as Record<string, unknown>), numFmt: cell.numFmt });
  });
  const existingRows = Math.max(0, worksheet.rowCount - dataStartRow + 1);
  if (existingRows > 0) worksheet.spliceRows(dataStartRow, existingRows);
  if (rows.length) {
    const inserted = worksheet.insertRows(dataStartRow, rows, "i");
    inserted.forEach((row) => {
      prototypeStyles.forEach((style, column) => {
        row.getCell(column).style = cloneValue(style.style) as any;
        if (style.numFmt) row.getCell(column).numFmt = style.numFmt;
      });
      if (prototype.height) row.height = prototype.height;
    });
  }
  const output = new Uint8Array(await workbook.xlsx.writeBuffer() as any);
  const validation = await validateExcelBytes(output, document.cases.length, mapping);
  return { output_path: "", bytes: output, validation };
}

export async function validateExcelBytes(bytes: Uint8Array, expectedCount: number, mappingValueInput: CaseTemplateMapping): Promise<CaseExportValidation> {
  const mapping = normalizeExcelMapping(isRecord(mappingValueInput) ? mappingValueInput : {});
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as any);
    const worksheet = mapping.worksheet ? workbook.getWorksheet(mapping.worksheet) : workbook.worksheets[0];
    if (!worksheet) return { passed: false, case_count: 0, errors: [`Excel缺少工作表：${mapping.worksheet || "第一个工作表"}`], warnings };
    let count = 0;
    for (let rowNumber = Math.max(mapping.data_start_row, mapping.header_row + 1); rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const title = String(row.getCell(columnNumber(mapping.title_column)).text || "").trim();
      if (!title) continue;
      count += 1;
      if (!String(row.getCell(columnNumber(mapping.steps_column)).text || "").trim()) errors.push(`Excel用例缺少步骤：第${rowNumber}行`);
      if (!String(row.getCell(columnNumber(mapping.expected_column)).text || "").trim()) errors.push(`Excel用例缺少期望结果：第${rowNumber}行`);
    }
    if (count !== expectedCount) errors.push(`Excel数据行数不一致：期望${expectedCount}，实际${count}`);
    if (!String(worksheet.getRow(mapping.header_row).getCell(columnNumber(mapping.title_column)).text || "").trim()) warnings.push("Excel表头行未检测到标题列内容，请确认映射配置");
    return { passed: errors.length === 0, case_count: count, errors, warnings };
  } catch (reason) {
    errors.push(`Excel校验异常：${String(reason)}`);
    return { passed: false, case_count: 0, errors, warnings };
  }
}

function normalizeXMindMapping(value: Record<string, unknown>): XMindTemplateMapping {
  return {
    ...defaultXMindMapping(),
    ...value,
    root_topic: stringValue(value.root_topic, ""),
    directory_placeholder: stringValue(value.directory_placeholder, "{{目录}}"),
    case_placeholder: stringValue(value.case_placeholder, "{{用例}}"),
    pc_topic: stringValue(value.pc_topic, "pc"),
    tx_topic: stringValue(value.tx_topic, "tx"),
    expected_topic: stringValue(value.expected_topic, "返回数据"),
    expected_as_child: value.expected_as_child !== false,
  };
}

function normalizeExcelMapping(value: Record<string, unknown>): ExcelTemplateMapping {
  const defaults = defaultExcelMapping();
  return {
    ...defaults,
    ...value,
    worksheet: stringValue(value.worksheet, defaults.worksheet),
    header_row: positiveNumber(value.header_row, defaults.header_row),
    data_start_row: positiveNumber(value.data_start_row, defaults.data_start_row),
    directory_column: stringValue(value.directory_column, defaults.directory_column),
    title_column: stringValue(value.title_column, defaults.title_column),
    priority_column: stringValue(value.priority_column, defaults.priority_column),
    test_type_column: stringValue(value.test_type_column, defaults.test_type_column),
    preconditions_column: stringValue(value.preconditions_column, defaults.preconditions_column),
    steps_column: stringValue(value.steps_column, defaults.steps_column),
    expected_column: stringValue(value.expected_column, defaults.expected_column),
  };
}

function buildDirectoryTopic(node: CaseDirectoryNode, directoryTemplate: RawTopic | undefined, caseTemplate: RawTopic | undefined, mapping: XMindTemplateMapping, casesByDirectory: Map<string, StructuredTestCase[]>): RawTopic {
  const topic = directoryTemplate ? cloneValue(directoryTemplate) : { id: node.id, title: node.title };
  topic.id = node.id;
  topic.title = node.title;
  const generated = [
    ...node.children.map((child) => buildDirectoryTopic(child, directoryTemplate, caseTemplate, mapping, casesByDirectory)),
    ...(casesByDirectory.get(node.id) || []).map((item) => buildCaseTopic(item, caseTemplate, mapping)),
  ];
  const preserved = directoryTemplate
    ? attachedTopicChildren(topic).filter((child) => !matchesReference(child, mapping.case_placeholder) && !XMindCaseTitlePattern.test(String(child.title || "")))
    : [];
  setAttachedChildren(topic, [...preserved, ...generated]);
  return topic;
}

type RawTopic = Record<string, any>;

function buildCaseTopic(item: StructuredTestCase, template: RawTopic | undefined, mapping: XMindTemplateMapping): RawTopic {
  const topic = template ? cloneValue(template) : { id: item.id, title: item.title };
  topic.id = item.id;
  topic.blackbox_case_id = item.id;
  topic.title = item.title;
  const existingChildren = attachedTopicChildren(topic);
  const sectionTemplates = new Map<string, RawTopic>();
  existingChildren.forEach((child) => {
    const name = parseSectionName(String(child.title || ""));
    if (name) sectionTemplates.set(name, child);
  });
  const pc = cloneValue(sectionTemplates.get("pc") || { id: `${item.id}-pc`, title: "" });
  pc.title = `pc: ${numbered(item.preconditions)}`;
  const tx = cloneValue(sectionTemplates.get("tx") || { id: `${item.id}-tx`, title: "" });
  tx.title = `tx: ${numbered(caseActions(item))}`;
  const expected = cloneValue(sectionTemplates.get("返回数据") || { id: `${item.id}-expected`, title: "" });
  expected.title = `返回数据: ${numbered(caseExpectedResults(item))}`;
  setAttachedChildren(tx, [expected]);
  const extras = existingChildren.filter((child) => {
    const name = parseSectionName(String(child.title || ""));
    return name !== "pc" && name !== "tx" && name !== "返回数据";
  });
  const sections = [pc, tx];
  setAttachedChildren(topic, sections);
  return topic;
}

function findTopicWithParent(root: RawTopic, reference: string, parent?: RawTopic, container: "attached" | "detached" = "attached"): { topic: RawTopic; parent?: RawTopic; container: "attached" | "detached" } | null {
  if (reference && matchesReference(root, reference)) return { topic: root, parent, container };
  for (const key of ["attached", "detached"] as const) {
    const children = Array.isArray(root.children?.[key]) ? root.children[key] as RawTopic[] : [];
    for (const child of children) {
      const match = findTopicWithParent(child, reference, root, key);
      if (match) return match;
    }
  }
  return null;
}

function matchesReference(topic: RawTopic, reference: string): boolean {
  const value = reference.trim();
  if (!value) return false;
  const id = String(topic.id || "");
  const title = String(topic.title || "").trim();
  return id === value || title === value || title.includes(value);
}

function attachedTopicChildren(topic: RawTopic): RawTopic[] {
  const children = isRecord(topic.children) ? topic.children : {};
  return Array.isArray(children.attached) ? children.attached.filter(isRecord) as RawTopic[] : [];
}

function topicChildren(topic: RawTopic): RawTopic[] {
  const children = isRecord(topic.children) ? topic.children : {};
  return ["attached", "detached"].flatMap((key) => Array.isArray(children[key]) ? children[key].filter(isRecord) as RawTopic[] : []);
}

function setAttachedChildren(topic: RawTopic, children: RawTopic[]): void {
  const original = isRecord(topic.children) ? topic.children : {};
  topic.children = { ...original, attached: children };
  if (!Array.isArray(original.detached) || original.detached.length === 0) delete topic.children.detached;
}

function findFirstCaseTopic(topic: RawTopic): RawTopic | undefined {
  if (XMindCaseTitlePattern.test(String(topic.title || ""))) return topic;
  for (const child of topicChildren(topic)) {
    const match = findFirstCaseTopic(child);
    if (match) return match;
  }
  return undefined;
}

function collectCaseTopics(topic: RawTopic, result: RawTopic[]): void {
  if (XMindCaseTitlePattern.test(String(topic.title || ""))) result.push(topic);
  topicChildren(topic).forEach((child) => collectCaseTopics(child, result));
}

function parseSectionName(title: string): string | null {
  const match = title.match(XMindSectionPattern);
  if (!match) return null;
  return match[1].toLowerCase() === "返回数据" ? "返回数据" : match[1].toLowerCase();
}

function sectionBody(title: string): string {
  return title.replace(/^\s*(pc|tx|返回数据)\s*[:：]?/i, "").trim();
}

function numbered(values: string[]): string {
  return values.map((value, index) => `${index + 1}、${value}`).join("\n");
}

function buildExcelRow(item: StructuredTestCase, directory: string, mapping: ExcelTemplateMapping): any[] {
  const maxColumn = Math.max(...mappedColumns(mapping), 1);
  const values = Array.from({ length: maxColumn }, () => "");
  setColumnValue(values, mapping.directory_column, directory);
  setColumnValue(values, mapping.title_column, item.title);
  setColumnValue(values, mapping.priority_column, `P${normalizePriority(item.priority)}`);
  setColumnValue(values, mapping.test_type_column, item.test_type);
  setColumnValue(values, mapping.preconditions_column, item.preconditions.join("\n"));
  setColumnValue(values, mapping.steps_column, caseActions(item).map((value, index) => `${index + 1}、${value}`).join("\n"));
  setColumnValue(values, mapping.expected_column, caseExpectedResults(item).map((value, index) => `${index + 1}、${value}`).join("\n"));
  return values;
}

function setColumnValue(values: any[], column: string, value: string): void {
  const index = columnNumber(column) - 1;
  while (values.length <= index) values.push("");
  values[index] = value;
}

function mappedColumns(mapping: ExcelTemplateMapping): number[] {
  return [mapping.directory_column, mapping.title_column, mapping.priority_column, mapping.test_type_column, mapping.preconditions_column, mapping.steps_column, mapping.expected_column].map(columnNumber);
}

function columnNumber(value: string): number {
  const raw = String(value || "A").trim().toUpperCase();
  if (/^\d+$/.test(raw)) return Math.max(1, Number(raw));
  return [...raw].reduce((result, char) => result * 26 + char.charCodeAt(0) - 64, 0) || 1;
}

function directoryPathMap(root: CaseDirectoryNode): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (node: CaseDirectoryNode, parents: string[]) => {
    const current = [...parents, node.title].filter(Boolean).join(" > ");
    result.set(node.id, current);
    node.children.forEach((child) => walk(child, [...parents, node.title]));
  };
  walk(root, []);
  return result;
}

function missingFields(item: StructuredTestCase): string[] {
  const missing: string[] = [];
  if (!item.title.trim()) missing.push("标题");
  if (!item.preconditions.length) missing.push("前置条件");
  if (!item.steps.length) missing.push("操作步骤");
  if (!caseExpectedResults(item).length) missing.push("期望结果");
  return missing;
}

function templateMappingMissing(mapping: CaseTemplateMapping, type: "xmind" | "excel"): string[] {
  if (type === "xmind") {
    const value = mapping as XMindTemplateMapping;
    return [
      ["pc映射", value.pc_topic],
      ["tx映射", value.tx_topic],
      ["返回数据映射", value.expected_topic],
    ].filter(([, item]) => !String(item || "").trim()).map(([label]) => label);
  }
  const value = mapping as ExcelTemplateMapping;
  return [
    ["目录列", value.directory_column],
    ["标题列", value.title_column],
    ["优先级列", value.priority_column],
    ["测试类型列", value.test_type_column],
    ["前置条件列", value.preconditions_column],
    ["步骤列", value.steps_column],
    ["期望结果列", value.expected_column],
  ].filter(([, item]) => !String(item || "").trim()).map(([label]) => label);
}

function mappingValue(mapping: CaseTemplateMapping, key: string): string {
  const value = (mapping as Record<string, unknown>)[key];
  return value === undefined || value === null ? "" : String(value);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"|?*]/g, "_").replace(/[\\/]+/g, "_").replace(/\s+/g, " ");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:\/|\/|\\\\)/.test(value.replace(/\\/g, "/"));
}

function positiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object";
}
