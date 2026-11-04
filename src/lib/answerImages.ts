import { api, joinPath } from "./api";

const ATTACHMENT_SRC = /^attachments\/[^/\\]+\.(png|jpe?g|gif|webp|bmp)$/i;
const attachmentCache = new Map<string, Promise<string>>();

function mimeType(name: string): string {
  const extension = (name.split(".").pop() || "").toLowerCase();
  return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
}

function attachmentDataUrl(filePath: string, name: string): Promise<string> {
  let pending = attachmentCache.get(filePath);
  if (!pending) {
    pending = api.readBinaryFile(filePath).then((bytes) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([bytes], { type: mimeType(name) }));
    }));
    attachmentCache.set(filePath, pending);
    pending.catch(() => attachmentCache.delete(filePath));
  }
  return pending;
}

export async function resolveAnswerImages(html: string, answerDir: string): Promise<string> {
  if (!html.includes("attachments/")) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  await Promise.all(Array.from(template.content.querySelectorAll("img")).map(async (image) => {
    const src = image.getAttribute("src") || "";
    if (!ATTACHMENT_SRC.test(src)) return;
    image.dataset.attachmentPath = src;
    await attachmentDataUrl(joinPath(answerDir, src), src).then((url) => image.setAttribute("src", url), () => undefined);
  }));
  return template.innerHTML;
}
