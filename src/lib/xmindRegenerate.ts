// AI regeneration preserves known IDs; structural identity changes require explicit mapping.
import JSZip from "jszip";
import { joinPath } from "./api";
import { buildXMindBytes, parseOutline, type OutlineTopic } from "./aiOutput";
import {
  HISTORY_ENTRY,
  buildHistoryMarkdown,
  changedCaseFields,
  createId,
  parseContent,
  readHistory,
  snapshotFromCase,
  stripCasePrefix,
  type ChangeRecord,
  type ParsedCase,
  type Topic,
  type XMindContent,
  type XMindSheet,
} from "./xmindCases";

const AI_STATE_ENTRY = "blackbox/ai-state.json";
export const MANUAL_EDIT_APPROVAL_MESSAGE = "APPROVAL_REQUIRED:XMind 在上次 AI 生成后被人工修改或来源不明，覆盖前需要用户授权";

export interface RegenerateXMindInput {
  rootPath: string;
  relativePath: string;
  title: string;
  outline: string;
  /** 已有 XMind 文件内容；新建文件时为 null */
  existingBytes: Uint8Array | null;
  changedAt: string;
  allowManualOverwrite?: boolean;
  /** Explicit new logical path -> existing case ID, provided only after mapping confirmation. */
  caseIdMapping?: Record<string, string>;
}

export interface RegenerateXMindResult {
  bytes: Uint8Array;
  records: ChangeRecord[];
  history: ChangeRecord[];
  sidecarJson: string;
  sidecarMarkdown: string;
}

const TITLE_FALLBACK = "未命名主题";

/** 匹配键：祖先模块标题 + 节点标题（用例取场景标题）。与 parseContent 的模块路径口径一致。 */
function matchKey(ancestors: string[], rawTitle: string): string {
  const title = String(rawTitle || TITLE_FALLBACK).trim();
  const isCase = /^tc-p\d-/i.test(title);
  return JSON.stringify([...ancestors, isCase ? stripCasePrefix(title) : title, isCase ? "case" : "topic"]);
}

function indexExistingIds(root: Topic | undefined): Map<string, string> {
  const ids = new Map<string, string>();
  const counts = new Map<string, number>();
  const visit = (topic: Topic, ancestors: string[]) => {
    const title = String(topic.title || TITLE_FALLBACK).trim();
    const base = matchKey(ancestors, title);
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    if (topic.id) ids.set(`${base}#${ordinal}`, topic.id);
    (topic.children?.attached ?? []).forEach((child) => visit(child, [...ancestors, title]));
  };
  (root?.children?.attached ?? []).forEach((child) => visit(child, []));
  return ids;
}

function buildTopics(nodes: OutlineTopic[], ancestors: string[], existing: Map<string, string>, counts: Map<string, number>): Topic[] {
  return nodes.map((node) => {
    const title = String(node.title || TITLE_FALLBACK).trim();
    const base = matchKey(ancestors, title);
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    const topic: Topic = { id: existing.get(`${base}#${ordinal}`) ?? createId(), title };
    if (node.children.length) topic.children = { attached: buildTopics(node.children, [...ancestors, title], existing, counts) };
    return topic;
  });
}

function buildContent(base: XMindContent, title: string, outline: string): XMindContent {
  if (base.length > 1) throw new Error("XMind 含多个画布，AI 暂不支持重新生成，请先在 XMind 中合并为单画布");
  const sheet: XMindSheet = { id: createId(), class: "sheet", ...base[0] };
  const topics = buildTopics(parseOutline(outline), [], indexExistingIds(sheet.rootTopic), new Map<string, number>());
  const rootTopic: Topic = { id: createId(), ...sheet.rootTopic, title, children: { attached: topics } };
  return [{ ...sheet, title, rootTopic }];
}

function indexCases(cases: ParsedCase[]): Map<string, ParsedCase> {
  const keyed = new Map<string, ParsedCase>();
  for (const item of cases) {
    if (keyed.has(item.id)) throw new Error(`重复用例ID：${item.id}`);
    keyed.set(item.id, item);
  }
  return keyed;
}

function diffCases(previous: ParsedCase[], next: ParsedCase[], filePath: string, changedAt: string): ChangeRecord[] {
  const previousByKey = indexCases(previous);
  const nextByKey = indexCases(next);
  const records: ChangeRecord[] = [];
  nextByKey.forEach((item, key) => {
    const after = snapshotFromCase(item);
    const before = previousByKey.get(key);
    if (!before) {
      records.push({ id: createId(), changedAt, filePath, caseId: item.id, before: null, after, changedFields: ["新增用例"], changeType: "added" });
      return;
    }
    const beforeSnapshot = snapshotFromCase(before);
    const changedFields = changedCaseFields(beforeSnapshot, after);
    if (JSON.stringify(before.path) !== JSON.stringify(item.path)) changedFields.push("目录移动");
    if (changedFields.length) records.push({ id: createId(), changedAt, filePath, caseId: item.id, before: beforeSnapshot, after, changedFields, changeType: "modified" });
  });
  previousByKey.forEach((item, key) => {
    if (nextByKey.has(key)) return;
    records.push({ id: createId(), changedAt, filePath, caseId: item.id, before: snapshotFromCase(item), after: null, changedFields: ["删除用例"], changeType: "deleted" });
  });
  return records;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readContent(zip: JSZip): Promise<{ text: string; content: XMindContent }> {
  const file = zip.file("content.json");
  if (!file) throw new Error("XMind 文件缺少 content.json，无法重新生成");
  const text = await file.async("string");
  const content = JSON.parse(text) as unknown;
  if (!Array.isArray(content)) throw new Error("XMind 文件的 content.json 格式不正确");
  return { text, content: content as XMindContent };
}

async function readAiStateHash(zip: JSZip): Promise<string | null> {
  const file = zip.file(AI_STATE_ENTRY);
  if (!file) return null;
  try {
    const state = JSON.parse(await file.async("string")) as { contentSha256?: unknown };
    return typeof state.contentSha256 === "string" ? state.contentSha256 : null;
  } catch {
    return null;
  }
}

/**
 * 按大纲重新生成 XMind，并计算相对旧文件的修改记录。
 * 修改记录写入包内 blackbox/changes.json，旁路文件内容随结果返回，由调用方通过受控命令写入。
 */
export async function regenerateXMind(input: RegenerateXMindInput): Promise<RegenerateXMindResult> {
  const absolutePath = joinPath(input.rootPath, input.relativePath);
  let zip: JSZip;
  let previous: XMindContent | null = null;
  let history: ChangeRecord[] = [];
  if (input.existingBytes) {
    zip = await JSZip.loadAsync(input.existingBytes);
    const current = await readContent(zip);
    if (!input.allowManualOverwrite && (await readAiStateHash(zip)) !== (await sha256Hex(current.text))) throw new Error(MANUAL_EDIT_APPROVAL_MESSAGE);
    previous = current.content;
    history = await readHistory(zip, absolutePath);
  } else {
    zip = await JSZip.loadAsync(await buildXMindBytes(input.rootPath, input.title, input.outline));
  }
  const content = buildContent(previous ?? (await readContent(zip)).content, input.title, input.outline);
  if (input.caseIdMapping) {
    const used = new Set<string>();
    const visit = (topic: Topic, ancestors: string[]) => {
      if (/^tc-p\d-/i.test(String(topic.title || ""))) {
        const key = [...ancestors.slice(1), String(topic.title || "")].join(" / ");
        const id = input.caseIdMapping?.[key];
        if (id) {
          if (used.has(id)) throw new Error("映射不能把两个场景合并到同一ID");
          used.add(id); topic.id = id; topic.blackbox_case_id = id;
        }
      }
      (topic.children?.attached || []).forEach((child) => visit(child, [...ancestors, String(topic.title || "")]));
    };
    content.forEach((sheet) => { if (sheet.rootTopic) visit(sheet.rootTopic, []); });
  }
  const previousCases = previous ? parseContent(previous, absolutePath).cases : [];
  const nextCases = parseContent(content, absolutePath).cases;
  const records = diffCases(previousCases, nextCases, absolutePath, input.changedAt).map((record) => ({ ...record, origin: "system" as const, source: "ai_regeneration", actor: null, event_id: record.id }));
  if (previousCases.length && records.some((record) => record.changeType === "deleted") && records.some((record) => record.changeType === "added") && !input.caseIdMapping) {
    throw new Error("XMIND_MAPPING_REQUIRED:存在未匹配的用例ID，请通过按ID修订接口或明确映射确认处理；不能按标题/目录将其自动认作删除与新增");
  }
  const nextHistory = [...history, ...records];
  const contentText = JSON.stringify(content, null, 2);
  zip.file("content.json", contentText);
  zip.file(HISTORY_ENTRY, JSON.stringify(nextHistory, null, 2));
  zip.file(AI_STATE_ENTRY, JSON.stringify({ contentSha256: await sha256Hex(contentText), generatedAt: input.changedAt, generator: "ai" }, null, 2));
  return {
    bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
    records,
    history: nextHistory,
    sidecarJson: JSON.stringify(nextHistory, null, 2),
    sidecarMarkdown: buildHistoryMarkdown(absolutePath, nextHistory),
  };
}
