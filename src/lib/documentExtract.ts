// 内置AI执行：把工作区里的需求资料提取为模型可读的文本/图片内容。
// XMind/docx/xlsx/pdf/图片都在前端解析，避免 Rust 侧重复实现。

import JSZip from "jszip";
import mammoth from "mammoth";
import { api, joinPath } from "./api";

export interface ExtractedDocument {
  /** 提取出的纯文本；图片类文档为空字符串 */
  text: string;
  /** 图片的 data URL，用于多模态模型 */
  images: string[];
  /** 提取过程中的提示，例如二进制无法解析 */
  note?: string;
}

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "csv", "xml", "html", "log"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const MAX_TEXT_LENGTH = 20000;

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function toDataUrl(bytes: Uint8Array, ext: string): string {
  const mime = ext === "jpg" ? "jpeg" : ext;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/${mime};base64,${btoa(binary)}`;
}

function clip(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized.length > MAX_TEXT_LENGTH ? `${normalized.slice(0, MAX_TEXT_LENGTH)}\n…（内容已截断）` : normalized;
}

async function extractXMind(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const contentFile = zip.file("content.json");
  if (!contentFile) return "";
  const content = JSON.parse(await contentFile.async("string")) as unknown;
  const lines: string[] = [];
  const walk = (topic: Record<string, unknown>, depth: number) => {
    if (!topic || typeof topic !== "object") return;
    const title = typeof topic.title === "string" ? topic.title.trim() : "";
    if (title) lines.push(`${"  ".repeat(depth)}- ${title}`);
    const children = topic.children as Record<string, unknown> | undefined;
    if (children && typeof children === "object") {
      const attached = Array.isArray(children.attached) ? children.attached : [];
      attached.forEach((child) => walk(child as Record<string, unknown>, depth + 1));
    }
  };
  const sheets = Array.isArray(content) ? content : [];
  sheets.forEach((sheet, index) => {
    const root = (sheet as Record<string, unknown>)?.rootTopic;
    if (root && typeof root === "object") {
      lines.push(`## 画布 ${index + 1}`);
      walk(root as Record<string, unknown>, 0);
    }
  });
  return lines.join("\n");
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value || "";
}

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const lines: string[] = [];
  workbook.eachSheet((sheet) => {
    lines.push(`## 工作表：${sheet.name}`);
    sheet.eachRow((row) => {
      const values = (row.values as unknown[]).slice(1).map((value) => {
        if (value === null || value === undefined) return "";
        if (typeof value === "object") {
          const rich = value as { text?: string; result?: unknown; richText?: Array<{ text?: string }> };
          if (typeof rich.text === "string") return rich.text;
          if (rich.richText) return rich.richText.map((item) => item.text || "").join("");
          if (rich.result !== undefined) return String(rich.result);
          return JSON.stringify(value);
        }
        return String(value);
      });
      if (values.some((value) => value !== "")) lines.push(values.join(" | "));
    });
  });
  return lines.join("\n");
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  // 使用 legacy 构建，兼容较旧的 WebView2 / WKWebView
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const lines: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    lines.push(`## 第 ${pageNumber} 页\n${text}`);
  }
  return lines.join("\n\n");
}

/**
 * 提取单个文档。path 为工作区相对路径，rootPath 为工作区根目录。
 */
export async function extractDocument(rootPath: string, relativePath: string): Promise<ExtractedDocument> {
  const absolute = joinPath(rootPath, relativePath);
  const ext = extensionOf(relativePath);
  try {
    if (IMAGE_EXTENSIONS.has(ext)) {
      const bytes = await api.readBinaryFile(absolute);
      return { text: "", images: [toDataUrl(bytes, ext)] };
    }
    if (TEXT_EXTENSIONS.has(ext)) {
      return { text: clip(await api.readTextFile(absolute)), images: [] };
    }
    const bytes = await api.readBinaryFile(absolute);
    if (ext === "xmind") return { text: clip(await extractXMind(bytes)), images: [] };
    if (ext === "docx" || ext === "doc") return { text: clip(await extractDocx(bytes)), images: [] };
    if (ext === "xlsx" || ext === "xls") return { text: clip(await extractXlsx(bytes)), images: [] };
    if (ext === "pdf") return { text: clip(await extractPdf(bytes)), images: [] };
    return { text: "", images: [], note: `暂不支持提取 ${ext || "未知"} 类型正文` };
  } catch (reason) {
    return { text: "", images: [], note: `提取失败：${String(reason)}` };
  }
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

export async function extractTextContent(bytes: Uint8Array, ext: string): Promise<string | null> {
  if (TEXT_EXTENSIONS.has(ext)) return new TextDecoder("utf-8").decode(bytes);
  if (ext === "xmind") return extractXMind(bytes);
  if (ext === "docx" || ext === "doc") return extractDocx(bytes);
  if (ext === "xlsx" || ext === "xls") return extractXlsx(bytes);
  if (ext === "pdf") return extractPdf(bytes);
  return null;
}
