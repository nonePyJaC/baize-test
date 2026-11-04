// AI 会话发送前：为需求目录（01-需求资料、05-开发资源）中的 docx 生成缺失的内嵌图产物（正文.md + 图片文件）。
// 产物已存在则跳过；单个文档失败只记录日志，不阻断会话。写入走 Rust 命令，产物目录只接受客户端生成的文件。

import { api, joinPath } from "./api";
import { buildDocxAssets, MANIFEST_FILE_NAME, MARKDOWN_FILE_NAME, textToBase64 } from "./docxAssets";

export async function ensureRequirementDocxAssets(rootPath: string, requirementDir: string): Promise<number> {
  if (!rootPath || !requirementDir) return 0;
  const statuses = await api.prepareDocxAssets(rootPath, requirementDir);
  let generated = 0;
  for (const status of statuses) {
    if (status.ready) continue;
    try {
      const bytes = await api.readBinaryFile(joinPath(rootPath, status.source));
      const build = await buildDocxAssets(bytes, status.source.split("/").pop() ?? status.source);
      for (const file of build.files) {
        await api.writeDocxAssetFile(rootPath, requirementDir, status.dir_name, file.name, file.base64);
      }
      await api.writeDocxAssetFile(rootPath, requirementDir, status.dir_name, MANIFEST_FILE_NAME, textToBase64(build.manifest));
      // 正文最后写入：正文存在即视为产物就绪，图片未写完之前不会被读到
      await api.writeDocxAssetFile(rootPath, requirementDir, status.dir_name, MARKDOWN_FILE_NAME, textToBase64(build.markdown));
      generated += 1;
    } catch (reason) {
      console.warn(`内嵌图预处理失败：${status.source}`, reason);
    }
  }
  return generated;
}
