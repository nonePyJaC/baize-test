// 内置AI执行：把模型返回的结构化产物转换为可写入工作区的文件。
// docx 用 docx 库生成，xmind 优先复用工作区已注册的模板，md 直接写文本。

import JSZip from "jszip";
import type { Paragraph as DocxParagraph } from "docx";
import { api, joinPath } from "./api";
import { normalizeTemplateRegistry, templateRegistryPath } from "./templateExport";

export interface AiGeneratedFile {
  path: string;
  /** md | docx | xmind | xlsx | text */
  type: string;
  /** markdown 或大纲文本 */
  content: string;
}

export interface AiExecutionResult {
  summary: string;
  pending_items: string[];
  files: AiGeneratedFile[];
}

const SUPPORTED_TYPES = new Set(["md", "markdown", "docx", "xmind", "xlsx", "json", "text", "txt"]);

function normalizeType(type: string, path: string): string {
  const value = (type || "").toLowerCase();
  if (SUPPORTED_TYPES.has(value)) return value === "markdown" ? "md" : value === "txt" ? "text" : value;
  const ext = path.split(".").pop()?.toLowerCase() || "md";
  return ext === "markdown" ? "md" : ext;
}

function extractJson(raw: string): unknown | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 解析模型返回的产物。模型应返回 JSON：
 * { summary, pending_items: [], outputs: [{ path, type, content }] }
 * 解析失败时退化为单个 markdown 产物。
 */
export function parseAiOutput(raw: string, fallbackPath: string): AiExecutionResult {
  const parsed = extractJson(raw);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const outputs = Array.isArray(record.outputs) ? record.outputs : [];
    const files: AiGeneratedFile[] = outputs
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        path: String(item.path || "").replace(/\\/g, "/"),
        type: normalizeType(String(item.type || ""), String(item.path || "")),
        content: typeof item.content === "string" ? item.content : "",
      }))
      .filter((item) => item.path);
    if (files.length) {
      return {
        summary: typeof record.summary === "string" ? record.summary : "",
        pending_items: Array.isArray(record.pending_items)
          ? record.pending_items.filter((item): item is string => typeof item === "string")
          : [],
        files,
      };
    }
  }
  return {
    summary: raw.slice(0, 200).replace(/\n/g, " "),
    pending_items: ["模型未返回结构化产物，已按纯文本保存"],
    files: [{ path: fallbackPath, type: "md", content: raw }],
  };
}

function markdownToParagraphs(markdown: string, docx: typeof import("docx")): DocxParagraph[] {
  const { Paragraph, HeadingLevel, TextRun } = docx;
  const paragraphs: DocxParagraph[] = [];
  markdown.replace(/\r\n/g, "\n").split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
      paragraphs.push(new Paragraph({ text: heading[2], heading: levels[level - 1] }));
      return;
    }
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      paragraphs.push(new Paragraph({ text: bullet[1], bullet: { level: 0 } }));
      return;
    }
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      paragraphs.push(new Paragraph({ text: numbered[1], bullet: { level: 0 } }));
      return;
    }
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: trimmed })] }));
  });
  return paragraphs;
}

export async function buildDocxBytes(markdown: string, title: string): Promise<Uint8Array> {
  const docx = await import("docx");
  const { Document, Paragraph, HeadingLevel, Packer } = docx;
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
        ...markdownToParagraphs(markdown, docx),
      ],
    }],
  });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

export interface OutlineTopic {
  title: string;
  children: OutlineTopic[];
}

export function parseOutline(outline: string): OutlineTopic[] {
  const roots: OutlineTopic[] = [];
  const stack: Array<{ depth: number; topic: OutlineTopic }> = [];
  outline.replace(/\r\n/g, "\n").split("\n").forEach((line) => {
    const match = line.match(/^(\s*)(?:(?:[-*+]|#{1,6}|\d+[.)])\s+)?(.+)$/);
    if (!match || !match[2].trim()) return;
    const depth = Math.floor(match[1].replace(/\t/g, "  ").length / 2);
    const topic: OutlineTopic = { title: match[2].trim(), children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) stack[stack.length - 1].topic.children.push(topic);
    else roots.push(topic);
    stack.push({ depth, topic });
  });
  return roots.length ? roots : [{ title: "测试用例", children: [] }];
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `ai-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function toTopic(topic: OutlineTopic): Record<string, unknown> {
  const node: Record<string, unknown> = { id: nextId(), title: topic.title };
  if (topic.children.length) {
    node.children = { attached: topic.children.map(toTopic) };
  }
  return node;
}

async function loadTemplateBytes(rootPath: string): Promise<Uint8Array | null> {
  try {
    const registry = normalizeTemplateRegistry(await api.readJsonFile(templateRegistryPath(rootPath)));
    const template = registry.templates.find((item) => item.type === "xmind" && item.file_path);
    if (!template) return null;
    const path = template.file_path.startsWith("/") || /^[a-zA-Z]:/.test(template.file_path)
      ? template.file_path
      : joinPath(rootPath, template.file_path);
    return await api.readBinaryFile(path);
  } catch {
    return null;
  }
}

const MINIMAL_XML = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0"/>';

export async function buildXMindBytes(rootPath: string, title: string, outline: string): Promise<Uint8Array> {
  const topics = parseOutline(outline);
  const templateBytes = await loadTemplateBytes(rootPath);
  if (templateBytes) {
    try {
      const zip = await JSZip.loadAsync(templateBytes);
      const contentFile = zip.file("content.json");
      if (contentFile) {
        const content = JSON.parse(await contentFile.async("string")) as unknown;
        const sheets = Array.isArray(content) ? content : [];
        const sheet = sheets.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).rootTopic) as Record<string, unknown> | undefined;
        if (sheet) {
          const root = sheet.rootTopic as Record<string, unknown>;
          root.title = title;
          root.children = { attached: topics.map(toTopic) };
          zip.file("content.json", JSON.stringify(content, null, 2));
          return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
        }
      }
    } catch {
      // 模板不可用时退回最小生成
    }
  }
  const zip = new JSZip();
  const content = [{
    id: nextId(),
    class: "sheet",
    title,
    rootTopic: { id: nextId(), title, children: { attached: topics.map(toTopic) } },
  }];
  zip.file("content.json", JSON.stringify(content, null, 2));
  zip.file("metadata.json", JSON.stringify({ creator: { name: "白泽 BAIZE", version: "1.0" } }, null, 2));
  zip.file("content.xml", MINIMAL_XML);
  zip.file("meta.xml", MINIMAL_XML);
  zip.file("styles.xml", MINIMAL_XML);
  zip.file("manifest.json", JSON.stringify({ "file-entries": { "content.json": {}, "metadata.json": {} } }, null, 2));
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

interface XMindTopicNode {
  title?: unknown;
  children?: { attached?: unknown };
}

function collectOutline(topic: unknown, depth: number, lines: string[]): void {
  if (!topic || typeof topic !== "object") return;
  const node = topic as XMindTopicNode;
  const title = typeof node.title === "string" ? node.title.replace(/\s+/g, " ").trim() : "";
  if (title) lines.push(`${"  ".repeat(depth)}${title}`);
  const children = node.children?.attached;
  (Array.isArray(children) ? children : []).forEach((child) =>
    collectOutline(child, title ? depth + 1 : depth, lines),
  );
}

/** 分批写入：把本批大纲接在已有大纲末尾（两者都是缩进大纲文本，第一级节点挂在根主题下）。 */
export function joinOutline(prior: string, chunk: string): string {
  const head = prior.replace(/\s+$/, "");
  const tail = chunk.replace(/^\s*\n/, "").replace(/\s+$/, "");
  return head && tail ? `${head}\n${tail}` : head || tail;
}

/** 读取 XMind 第一个画布的根主题标题与缩进大纲（根主题本身不进入大纲，与 buildXMindBytes 的入参对应）。 */
export async function parseXMindOutline(bytes: Uint8Array): Promise<{ title: string; outline: string }> {
  const zip = await JSZip.loadAsync(bytes);
  const contentFile = zip.file("content.json");
  if (!contentFile) throw new Error("XMind 文件缺少 content.json，无法读取大纲");
  const content = JSON.parse(await contentFile.async("string")) as unknown;
  const sheet = Array.isArray(content) ? (content[0] as { rootTopic?: unknown } | undefined) : undefined;
  const root = sheet?.rootTopic as XMindTopicNode | undefined;
  if (!root || typeof root !== "object") throw new Error("XMind 文件中没有找到根主题");
  const lines: string[] = [];
  const children = root.children?.attached;
  (Array.isArray(children) ? children : []).forEach((child) => collectOutline(child, 0, lines));
  return { title: typeof root.title === "string" ? root.title.trim() : "", outline: lines.join("\n") };
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
