// 客户端工具：后端在运行中请求界面执行的文档解析与 XMind 生成（阶段一的桥接实现）。
// 工作区访问、门禁与写入仍在 Rust 侧完成；这里只做格式转换，结果回填给后端运行时。

import { buildXMindBytes, fromBase64, joinOutline, parseOutline, parseXMindOutline, toBase64 } from "./aiOutput";
import { normalizeCasesDocument } from "./cases";
import { validateCaseTemplate } from "./caseTemplate";
import { extractTextContent } from "./documentExtract";
import type { AgentClientRequest } from "./aiSessionTypes";
import { casesDocumentToOutline, normalizeXMindCaseTitle, withStructuredCaseIds } from "./xmindImport";
import type { ChangeRecord, ChangeType } from "./xmindCases";
import { regenerateXMind } from "./xmindRegenerate";

const MAX_IMAGE_SIDE = 1600;
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export async function runClientTool(request: AgentClientRequest): Promise<unknown> {
  const payload = request.payload;
  if (request.kind === "extract_document") return extractDocument(text(payload.ext), text(payload.base64));
  if (request.kind === "parse_xmind") {
    const parsed = await parseXMindOutline(fromBase64(text(payload.base64)));
    return { title: parsed.title, outline: parsed.outline };
  }
  if (request.kind === "export_cases_xmind") return exportCasesXMind(payload);
  if (request.kind === "write_xmind") return writeXMind(payload);
  throw new Error(`未知的客户端工具：${request.kind}`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function exportCasesXMind(payload: Record<string, unknown>) {
  const raw = payload.document as Record<string, unknown> | undefined;
  if (!raw || !Array.isArray(raw.cases)) throw new Error("归档用例数据无效");
  const document = normalizeCasesDocument(
    raw,
    text(raw.requirement_id),
    text(raw.platform),
    text(raw.platform_id),
  );
  if (Array.isArray(payload.case_ids)) {
    const requested = payload.case_ids.filter((value): value is string => typeof value === "string");
    const selected = new Set(requested);
    if (selected.size !== payload.case_ids.length || [...selected].some((id) => !document.cases.some((item) => item.id === id))) {
      throw new Error("归档用例范围包含重复或不存在的用例ID");
    }
    document.cases = document.cases.filter((item) => selected.has(item.id));
  }
  if (!document.cases.length) throw new Error("没有可归档的用例");

  const { title, outline } = casesDocumentToOutline(document);
  const violations = validateCaseTemplate(parseOutline(outline));
  if (violations.length) {
    throw new Error(`XMind 模板校验未通过：${violations.slice(0, 20).join("；")}`);
  }
  const outputTitle = text(payload.title) || title;
  const generated = await buildXMindBytes(text(payload.root_path), outputTitle, outline);
  const bytes = await withStructuredCaseIds(generated, document);
  return {
    content_base64: toBase64(bytes),
    case_count: document.cases.length,
    title: outputTitle,
    case_ids: document.cases.map((item) => item.id),
    normalized_titles: document.cases.filter((item) => item.title !== normalizeXMindCaseTitle(item.title)).length,
  };
}

async function extractDocument(ext: string, base64: string) {
  const mime = IMAGE_MIME[ext];
  if (mime) return { kind: "image", data_url: await smallerImageUrl(`data:${mime};base64,${base64}`) };
  const extracted = await extractTextContent(fromBase64(base64), ext);
  return extracted === null ? { kind: "unsupported" } : { kind: "text", text: extracted };
}

async function writeXMind(payload: Record<string, unknown>) {
  const violations = validateCaseTemplate(parseOutline(text(payload.outline)));
  if (violations.length) throw new Error(`大纲不符合固定用例模板，未写入。请按模板修改后重新提交：\n${violations.slice(0, 30).join("\n")}`);
  const existing = typeof payload.existing_base64 === "string" ? fromBase64(payload.existing_base64) : null;
  // 分批写入：append 时先读出已有大纲，把本批接在末尾；根主题标题沿用已有文件
  const prior = payload.append === true && existing ? await parseXMindOutline(existing) : null;
  const regenerated = await regenerateXMind({
    rootPath: text(payload.root_path),
    relativePath: text(payload.path),
    title: prior?.title || text(payload.title),
    outline: prior ? joinOutline(prior.outline, text(payload.outline)) : text(payload.outline),
    existingBytes: existing,
    changedAt: text(payload.changed_at),
    allowManualOverwrite: payload.allow_manual_overwrite === true,
  });
  return {
    content_base64: toBase64(regenerated.bytes),
    sidecar_json: regenerated.sidecarJson,
    sidecar_markdown: regenerated.sidecarMarkdown,
    changes: summarizeChanges(regenerated.records),
  };
}

function summarizeChanges(records: ChangeRecord[]) {
  const typeOf = (record: ChangeRecord): ChangeType => record.changeType ?? "modified";
  const count = (type: ChangeType) => records.filter((record) => typeOf(record) === type).length;
  return {
    added: count("added"),
    modified: count("modified"),
    deleted: count("deleted"),
    items: records.slice(0, 50).map((record) => ({
      type: typeOf(record),
      caseId: record.caseId,
      title: (record.after ?? record.before)?.title ?? "",
      fields: record.changedFields,
    })),
  };
}

async function smallerImageUrl(dataUrl: string): Promise<string> {
  if (typeof document === "undefined" || typeof Image === "undefined") return dataUrl;
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("图片无法解码"));
      element.src = dataUrl;
    });
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(image.naturalWidth, image.naturalHeight, 1));
    if (scale === 1 && dataUrl.length <= 400000) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return dataUrl;
  }
}
