// docx 资料预处理（纯转换，不触碰工作区）：正文转 Markdown，内嵌图按正文出现顺序拆成文件，内容相同的只存一份。
// 产物由 docxAssetSync 写入需求的派生目录；AI 读 docx 时拿到 Markdown，需要看图时再读对应的图片文件。

import mammoth from "mammoth";

export const MARKDOWN_FILE_NAME = "正文.md";
export const MANIFEST_FILE_NAME = "manifest.json";

export interface DocxAssetFile {
  name: string;
  contentType: string;
  base64: string;
}

export interface DocxAssetBuild {
  markdown: string;
  manifest: string;
  files: DocxAssetFile[];
  imageOccurrences: number;
}

type ImageLink = (src: string) => string;

interface Occurrence {
  base64: string;
  contentType: string;
}

interface PlacedImage {
  name: string;
  label: string;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/x-png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/webp": "webp",
};

export async function buildDocxAssets(bytes: Uint8Array, sourceName: string): Promise<DocxAssetBuild> {
  const occurrences: Occurrence[] = [];
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        occurrences.push({ base64: await image.readAsBase64String(), contentType: image.contentType });
        return { src: `occ-${occurrences.length - 1}` };
      }),
    },
  );

  // 按正文中 <img> 出现的顺序编号：同一内容只存一份，类型不支持的图片只留占位文字
  const files: DocxAssetFile[] = [];
  const placed = new Map<number, PlacedImage | string>();
  const byContent = new Map<string, PlacedImage>();
  const counts = new Map<string, number>();
  const skipped = new Map<string, number>();
  const pattern = /<img\b[^>]*?\bsrc="occ-(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(result.value))) {
    const occurrence = Number(match[1]);
    if (placed.has(occurrence)) continue;
    const image = occurrences[occurrence];
    const extension = EXTENSION_BY_TYPE[image.contentType];
    if (!extension) {
      skipped.set(image.contentType, (skipped.get(image.contentType) ?? 0) + 1);
      placed.set(occurrence, `（${image.contentType} 格式的图片暂不支持读取，未提取）`);
      continue;
    }
    let entry = byContent.get(image.base64);
    if (!entry) {
      const number = String(files.length + 1).padStart(3, "0");
      entry = { name: `img-${number}.${extension}`, label: `图 ${number}` };
      byContent.set(image.base64, entry);
      files.push({ name: entry.name, contentType: image.contentType, base64: image.base64 });
    }
    placed.set(occurrence, entry);
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }

  const body = htmlToMarkdown(result.value, (src) => {
    const entry = placed.get(Number(src.replace("occ-", "")));
    if (!entry) return "（图片暂不支持读取，未提取）";
    return typeof entry === "string" ? entry : `![${entry.label}](${entry.name})`;
  });
  const markdown = `> 来源：${sourceName}（由白泽客户端预处理生成。内嵌图已拆分到本目录，正文中的图片链接即同目录下的文件。）\n\n${body}\n`;
  const manifest = JSON.stringify(
    {
      source: sourceName,
      images: files.map((file) => ({ file: file.name, content_type: file.contentType, occurrences: counts.get(file.name) ?? 0 })),
      skipped: [...skipped].map(([contentType, occurrences]) => ({ content_type: contentType, occurrences })),
    },
    null,
    2,
  );
  return { markdown, manifest, files, imageOccurrences: occurrences.length };
}

/** UTF-8 文本转 base64（用于写入 Markdown、manifest 等文本产物）。 */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

// —— HTML → Markdown（只覆盖 mammoth 产出的标签：段落、标题、列表、表格、行内强调、链接、图片） ——

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  text: string;
}

const VOID_TAGS = new Set(["br", "img", "hr", "meta", "link", "input", "col", "wbr"]);
const BLOCK_TAGS = new Set([
  "html", "body", "div", "section", "article", "header", "footer", "main", "aside", "nav", "center",
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr",
  "blockquote", "figure", "pre", "hr", "dl", "dt", "dd",
]);
const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToMarkdown(html: string, image: ImageLink): string {
  return blocksOf(parseHtml(html).children, image).join("\n\n");
}

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole: string, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: HtmlNode[] = [root];
  const pattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    if (match[0].startsWith("<!--")) continue;
    const parent = stack[stack.length - 1];
    if (match[4] !== undefined) {
      parent.children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(match[4]) });
      continue;
    }
    const tag = match[2].toLowerCase();
    if (match[1] === "/") {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const node: HtmlNode = { tag, attrs: parseAttributes(match[3]), children: [], text: "" };
    parent.children.push(node);
    if (!/\/\s*$/.test(match[3]) && !VOID_TAGS.has(tag)) stack.push(node);
  }
  return root;
}

function blocksOf(nodes: HtmlNode[], image: ImageLink): string[] {
  const blocks: string[] = [];
  let loose = "";
  const flush = () => {
    pushText(blocks, loose.replace(/[ \t]+/g, " "));
    loose = "";
  };
  for (const node of nodes) {
    if (node.tag !== "script" && node.tag !== "style" && !BLOCK_TAGS.has(node.tag) && node.tag !== "#root") {
      loose += inlineOf([node], image);
      continue;
    }
    flush();
    if (node.tag === "script" || node.tag === "style") continue;
    if (node.tag === "p") pushText(blocks, inlineOf(node.children, image));
    else if (HEADING_LEVEL[node.tag]) pushText(blocks, `${"#".repeat(HEADING_LEVEL[node.tag])} ${inlineOf(node.children, image)}`);
    else if (node.tag === "ul" || node.tag === "ol") pushText(blocks, listOf(node, 0, image));
    else if (node.tag === "table") pushText(blocks, tableOf(node, image));
    else if (node.tag === "hr") pushText(blocks, "---");
    else blocks.push(...blocksOf(node.children, image));
  }
  flush();
  return blocks.filter((block) => block.trim() !== "");
}

function pushText(blocks: string[], text: string): void {
  const trimmed = text.trim();
  if (trimmed) blocks.push(trimmed);
}

function inlineOf(nodes: HtmlNode[], image: ImageLink): string {
  let out = "";
  for (const node of nodes) {
    if (node.tag === "#text") {
      out += node.text.replace(/\s+/g, " ");
      continue;
    }
    if (node.tag === "br") {
      out += "\n";
      continue;
    }
    if (node.tag === "img") {
      out += image(node.attrs.src ?? "");
      continue;
    }
    if (node.tag === "script" || node.tag === "style") continue;
    const inner = inlineOf(node.children, image).trim();
    if (node.tag === "strong" || node.tag === "b") out += inner ? `**${inner}**` : "";
    else if (node.tag === "em" || node.tag === "i") out += inner ? `*${inner}*` : "";
    else if (node.tag === "code") out += inner ? `\`${inner}\`` : "";
    else if (node.tag === "a") out += node.attrs.href && inner ? `[${inner}](${node.attrs.href})` : inner;
    else out += inner;
  }
  return out;
}

function listOf(node: HtmlNode, depth: number, image: ImageLink): string {
  const ordered = node.tag === "ol";
  const lines: string[] = [];
  let number = 0;
  for (const item of node.children) {
    if (item.tag !== "li") continue;
    number += 1;
    const own = item.children.filter((child) => child.tag !== "ul" && child.tag !== "ol");
    const nested = item.children.filter((child) => child.tag === "ul" || child.tag === "ol");
    const text = blocksOf(own, image).join(" ").replace(/\s*\n\s*/g, " ").trim();
    lines.push(`${"  ".repeat(depth)}${ordered ? `${number}.` : "-"} ${text}`.trimEnd());
    for (const sub of nested) {
      const block = listOf(sub, depth + 1, image);
      if (block) lines.push(block);
    }
  }
  return lines.join("\n");
}

function tableOf(node: HtmlNode, image: ImageLink): string {
  const rows: string[][] = [];
  const collect = (container: HtmlNode) => {
    for (const child of container.children) {
      if (child.tag === "tr") {
        rows.push(
          child.children
            .filter((cell) => cell.tag === "td" || cell.tag === "th")
            .map((cell) => blocksOf(cell.children, image).join("<br>").replace(/\|/g, "\\|").replace(/\n+/g, "<br>")),
        );
      } else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
        collect(child);
      }
    }
  };
  collect(node);
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length === 0 || width === 0) return "";
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [line(rows[0]), line(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(line)].join("\n");
}
