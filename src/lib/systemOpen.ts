// 系统外部打开服务：统一封装文件打开、目录打开和文件管理器定位，
// 负责存在性校验和统一错误/成功反馈，避免各页面静默丢弃 opener 插件错误。

import { api, isTauri } from "./api";
import { notify } from "./notify";

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

async function checkPathExists(path: string): Promise<boolean> {
  try {
    const info = await api.getPathInfo(path);
    if (!info.exists) {
      notify("error", `文件或目录不存在：${path}`);
      return false;
    }
    return true;
  } catch (reason) {
    notify("error", `读取路径信息失败：${String(reason)}`);
    return false;
  }
}

async function run(name: string, path: string, action: () => Promise<void>, successText: string): Promise<void> {
  if (!isTauri) {
    notify("info", "系统打开仅在桌面客户端可用");
    return;
  }
  if (!path.trim()) {
    notify("error", `${name}失败：路径为空`);
    return;
  }
  if (!(await checkPathExists(path))) return;
  try {
    await action();
    notify("success", `${successText}：${fileName(path)}`);
  } catch (reason) {
    notify("error", `${name}失败：${String(reason)}`);
  }
}

export const systemOpen = {
  // 使用系统默认程序打开文件
  openFile: (path: string) =>
    run("打开文件", path, () => api.openExternalFile(path), "已交给系统打开"),

  // 在系统文件管理器中打开目录本身
  openDirectory: (path: string) =>
    run("打开目录", path, () => api.openExternalDirectory(path), "已交给系统打开"),

  // 在 Windows 资源管理器或 macOS Finder 中定位并选中目标
  reveal: (path: string) =>
    run("在目录中显示", path, () => api.revealInFileManager(path), "已在文件管理器中定位"),
};
