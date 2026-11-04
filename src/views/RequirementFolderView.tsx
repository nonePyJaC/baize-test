import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isTauri, joinPath } from "../lib/api";
import { systemOpen } from "../lib/systemOpen";
import { notify } from "../lib/notify";
import AppIcon, { type IconName } from "../components/AppIcon";
import { formatDateTime } from "../lib/date";
import type { DirEntryInfo, ImportConflictStrategy, ImportResultItem, WorkspaceEvent } from "../lib/types";
import type { WorkbenchTab } from "../lib/workbench";

interface RelFile {
  path: string;
  name: string;
  relative: string;
  size: number;
  modified: string;
}

interface PendingImport {
  name: string;
  /** Tauri 桌面端：真实文件路径，走 Rust 受控复制 */
  sourcePath?: string;
  /** 浏览器模式：File 对象，读取字节后写入 */
  file?: File;
}

interface ConflictModalState {
  targetDir: string;
  items: PendingImport[];
  conflicts: PendingImport[];
  strategies: Record<string, ImportConflictStrategy>;
}

const MATERIALS_ROOT = "01-需求资料";
const DOC_ZONE = "需求文档";
const IMAGE_ZONE = "需求截图";
const QUICK_IMAGE_GROUPS = ["原始业务截图", "需求设计定稿图"];
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const INVALID_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]/;
const MAX_DEPTH = 4;
const VIEW_MODE_KEY = "blackbox-client.materials.view.v1";
const THUMB_LIMIT = 400;

// 图片缩略图缓存：key 为 path|size|modified，值是 blob URL；超出上限时淘汰最早项
const thumbCache = new Map<string, string>();

type ViewMode = "list" | "grid";
type DropZone = "docs" | "images";

interface UploadedFile {
  path: string;
  dir: string;
  name: string;
}

export default function RequirementFolderView({ rootPath, platformPath, requirementId, folder, readOnly = false, latestWorkspaceEvent, onOpenTab, onRightContext }: {
  rootPath: string;
  platformPath: string;
  requirementId: string;
  folder: string;
  readOnly?: boolean;
  latestWorkspaceEvent?: WorkspaceEvent | null;
  onOpenTab: (tab: WorkbenchTab) => void;
  onRightContext?: import("../lib/workbench").RightContextReporter;
}) {
  const requirementPath = joinPath(rootPath, platformPath, requirementId);
  const basePath = joinPath(requirementPath, folder);
  const isMaterials = folder === MATERIALS_ROOT;

  const [currentRel, setCurrentRel] = useState("");
  const currentPath = currentRel ? joinPath(basePath, currentRel) : basePath;
  const atMaterialsHome = isMaterials && currentRel === "";
  const insideImageZone = isMaterials && (currentRel === IMAGE_ZONE || currentRel.startsWith(`${IMAGE_ZONE}/`));

  const [entries, setEntries] = useState<DirEntryInfo[]>([]);
  const [zoneDocs, setZoneDocs] = useState<RelFile[]>([]);
  const [zoneImages, setZoneImages] = useState<RelFile[]>([]);
  const [zoneDocDirs, setZoneDocDirs] = useState<DirEntryInfo[]>([]);
  const [zoneImageDirs, setZoneImageDirs] = useState<DirEntryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode(basePath));
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [namingFiles, setNamingFiles] = useState<UploadedFile[] | null>(null);

  const [createDocTarget, setCreateDocTarget] = useState<{ dir: string } | null>(null);
  const [createDirTarget, setCreateDirTarget] = useState<{ parent: string; initialName?: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<DirEntryInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DirEntryInfo | null>(null);
  const [conflictModal, setConflictModal] = useState<ConflictModalState | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<number | null>(null);
  const pendingUploadDir = useRef("");
  // 拖放导入目标：保持最新值供 webview 拖拽事件闭包使用
  const dropImportRef = useRef<(paths: string[], dir: string) => void>(() => {});
  const pasteImportRef = useRef<(files: File[]) => void>(() => {});
  const targetAt = (x: number, y: number): { zone: DropZone | null; dir: string } => {
    const marked = atMaterialsHome ? document.elementFromPoint(x, y)?.closest("[data-drop-zone]") : null;
    const zone = marked?.getAttribute("data-drop-zone") === "images" ? "images" : marked?.getAttribute("data-drop-zone") === "docs" ? "docs" : null;
    if (zone === "images") return { zone, dir: joinPath(basePath, IMAGE_ZONE) };
    if (zone === "docs") return { zone, dir: joinPath(basePath, DOC_ZONE) };
    return { zone: null, dir: currentPath };
  };
  const targetAtRef = useRef(targetAt);
  targetAtRef.current = targetAt;
  const pasteDir = isMaterials && !insideImageZone ? joinPath(basePath, IMAGE_ZONE) : currentPath;

  const walk = useCallback(async (dir: string, relative: string, depth: number, out: RelFile[]) => {
    const children = await api.listDirectory(dir).catch(() => [] as DirEntryInfo[]);
    for (const entry of children) {
      const childRel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.is_dir) {
        if (depth < MAX_DEPTH) await walk(entry.path, childRel, depth + 1, out);
        continue;
      }
      out.push({ path: entry.path, name: entry.name, relative: childRel, size: entry.size, modified: entry.modified });
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await api.getPathInfo(currentPath);
      if (!info.exists) {
        if (currentRel) {
          // 当前子目录被外部删除/移动：回到上一级，不重置搜索和视图模式
          const parent = currentRel.includes("/") ? currentRel.slice(0, currentRel.lastIndexOf("/")) : "";
          setCurrentRel(parent);
          return;
        }
        setEntries([]);
        setZoneDocs([]);
        setZoneImages([]);
        setZoneDocDirs([]);
        setZoneImageDirs([]);
        return;
      }
      const next = await api.listDirectory(currentPath);
      setEntries(next);
      if (atMaterialsHome) {
        const docDir = joinPath(basePath, DOC_ZONE);
        const imageDir = joinPath(basePath, IMAGE_ZONE);
        const docs: RelFile[] = [];
        const images: RelFile[] = [];
        const [docChildren, imageChildren] = await Promise.all([
          api.listDirectory(docDir).catch(() => [] as DirEntryInfo[]),
          api.listDirectory(imageDir).catch(() => [] as DirEntryInfo[]),
          walk(docDir, DOC_ZONE, 1, docs),
          walk(imageDir, IMAGE_ZONE, 1, images),
        ]);
        setZoneDocDirs(docChildren.filter((entry) => entry.is_dir));
        setZoneImageDirs(imageChildren.filter((entry) => entry.is_dir));
        setZoneDocs(docs);
        setZoneImages(images);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [atMaterialsHome, basePath, currentPath, currentRel, walk]);

  useEffect(() => { void load(); }, [load]);

  // 工作区文件事件：当前目录或子目录变化时自动刷新（防抖合并批量事件）
  useEffect(() => {
    if (!latestWorkspaceEvent) return;
    const paths = [latestWorkspaceEvent.path, latestWorkspaceEvent.old_path].filter(Boolean) as string[];
    if (!paths.some((path) => isPathWithin(path, basePath))) return;
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => { reloadTimer.current = null; void load(); }, 250);
  }, [latestWorkspaceEvent, basePath, load]);

  // Tauri 拖入文件：webview 事件携带真实路径和坐标；导入逻辑经 dropImportRef 取最新闭包
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const toCss = (position: { x: number; y: number }) => {
      const scale = window.devicePixelRatio || 1;
      return { x: position.x / scale, y: position.y / scale };
    };
    const inside = (point: { x: number; y: number }) => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect) return true;
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    };
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (disposed) return;
      return getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setDragActive(false);
          setDropZone(null);
          return;
        }
        const point = toCss(payload.position);
        if (payload.type === "enter" || payload.type === "over") {
          const hovering = inside(point);
          setDragActive(hovering);
          setDropZone(hovering ? targetAtRef.current(point.x, point.y).zone : null);
        } else if (payload.type === "drop") {
          setDragActive(false);
          setDropZone(null);
          if (inside(point)) dropImportRef.current(payload.paths, targetAtRef.current(point.x, point.y).dir);
        }
      });
    }).then((listener) => { if (disposed) listener?.(); else unlisten = listener ?? null; })
      .catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // Ctrl+V：剪贴板图片导入当前资料目录；输入框内保留原生粘贴
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const root = contentRef.current;
      if (!root || readOnly || !root.isConnected || !root.offsetParent) return;
      const target = event.target as Element | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (target && target !== document.body && !root.parentElement?.contains(target)) return;
      const images = [...(event.clipboardData?.items ?? [])]
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (!images.length) return;
      event.preventDefault();
      pasteImportRef.current(images);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [readOnly]);

  const switchView = (mode: ViewMode) => {
    setViewMode(mode);
    writeViewMode(basePath, mode);
  };

  const keyword = search.trim().toLowerCase();
  const matchKeyword = (name: string) => !keyword || name.toLowerCase().includes(keyword);

  const dirs = useMemo(() => entries.filter((entry) => entry.is_dir && matchKeyword(entry.name)), [entries, keyword]);
  const files = useMemo(() => entries.filter((entry) => !entry.is_dir && matchKeyword(entry.name)), [entries, keyword]);
  const visibleZoneDocs = useMemo(() => zoneDocs.filter((file) => matchKeyword(file.name) || matchKeyword(file.relative)), [zoneDocs, keyword]);
  const visibleZoneImages = useMemo(() => zoneImages.filter((file) => matchKeyword(file.name) || matchKeyword(file.relative)), [zoneImages, keyword]);

  const fileCount = atMaterialsHome ? zoneDocs.length + zoneImages.length + files.length : files.length;
  const imageCount = atMaterialsHome ? zoneImages.length : files.filter((file) => IMAGE_RE.test(file.name)).length;
  const breadcrumbSegments = currentRel ? currentRel.split("/") : [];

  // BB-16D：上报资料目录大纲（分区/子目录可点击定位）与目录属性
  useEffect(() => {
    if (!onRightContext) return;
    onRightContext({
      objectType: "folder",
      objectId: requirementId,
      title: folder,
      subtitle: `${requirementId} · ${currentRel || folder}`,
      path: currentPath,
      requirementId,
      readOnly,
      outlineTitle: "目录",
      outline: atMaterialsHome
        ? [
            { id: "zone-docs", label: DOC_ZONE, badge: String(visibleZoneDocs.length), icon: "folder", onSelect: () => setCurrentRel(DOC_ZONE) },
            { id: "zone-images", label: IMAGE_ZONE, badge: String(visibleZoneImages.length), icon: "image", onSelect: () => setCurrentRel(IMAGE_ZONE) },
            ...dirs.map((dir) => ({ id: `dir-${dir.name}`, label: dir.name, depth: 1, icon: "folder", onSelect: () => setCurrentRel(dir.name) })),
          ]
        : [
            { id: "root", label: "回到上一级", icon: "left", onSelect: () => setCurrentRel(currentRel.includes("/") ? currentRel.slice(0, currentRel.lastIndexOf("/")) : "") },
            ...dirs.map((dir) => ({ id: `dir-${dir.name}`, label: dir.name, icon: "folder", onSelect: () => setCurrentRel(currentRel ? `${currentRel}/${dir.name}` : dir.name) })),
          ],
      properties: [
        { label: "当前目录", value: currentRel || folder, mono: true },
        { label: "绝对路径", value: currentPath, mono: true },
        { label: "直接文件", value: String(files.length) },
        { label: "直接子目录", value: String(dirs.length) },
      ],
      stats: [
        { label: "文档", value: String(fileCount - imageCount) },
        { label: "图片", value: String(imageCount) },
      ],
    });
    return () => onRightContext(null);
  }, [onRightContext, folder, requirementId, currentRel, currentPath, atMaterialsHome, visibleZoneDocs.length, visibleZoneImages.length, dirs, files.length, fileCount, imageCount, readOnly]);

  const openFile = (file: RelFile | DirEntryInfo) => {
    const lower = file.name.toLowerCase();
    // 覆盖追溯数据由专用页面管理
    if (folder === "03-测试计划" && lower === "coverage.json") {
      onOpenTab({ id: `coverage:${platformPath}:${requirementId}`, type: "coverage", title: "覆盖追溯", subtitle: `${requirementId} · 覆盖追溯`, icon: "list", preview: false, pinned: true, dirty: false, closable: true, payload: { platformPath, requirementId } });
      return;
    }
    const type: "image" | "markdown" | "docx" | "excel" | "xmind" | null = IMAGE_RE.test(file.name)
      ? "image"
      : /\.(md|txt|yaml|yml|json|py|toml|rs|csv|log|sql|ts|tsx|js|xml|html?)$/.test(lower)
        ? "markdown"
        : lower.endsWith(".docx")
          ? "docx"
          : lower.endsWith(".xlsx")
            ? "excel"
            : lower.endsWith(".xmind")
              ? "xmind"
              : null;
    if (!type) {
      void systemOpen.openFile(file.path);
      return;
    }
    onOpenTab({
      id: `file:${file.path}`,
      type,
      title: file.name,
      subtitle: file.path,
      icon: type === "image" ? "image" : type === "markdown" ? "markdown" : type === "xmind" ? "archiveFile" : type === "excel" ? "spreadsheet" : "file",
      preview: true,
      pinned: false,
      dirty: false,
      closable: true,
      payload: { path: file.path },
    });
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      notify("success", `已复制路径：${fileName(path)}`);
    } catch {
      notify("error", "复制路径失败，请检查剪贴板权限");
    }
  };

  const validateName = (name: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return "名称不能为空";
    if (trimmed === "." || trimmed === "..") return "名称不合法";
    if (INVALID_NAME_RE.test(trimmed)) return "名称不能包含 \\ / : * ? \" < > | 等非法字符";
    return null;
  };

  const pickFiles = async (imagesOnly: boolean, targetDir: string) => {
    if (isTauri) {
      const paths = await api.chooseImportFiles(imagesOnly).catch((reason) => { notify("error", `打开文件选择器失败：${String(reason)}`); return [] as string[]; });
      if (!paths.length) return;
      void beginImport(paths.map((path) => ({ name: fileName(path), sourcePath: path })), targetDir);
      return;
    }
    pendingUploadDir.current = targetDir;
    (imagesOnly ? imageInputRef : fileInputRef).current?.click();
  };

  const onInputFiles = (list: FileList | null, targetDir: string) => {
    if (!list?.length) return;
    const items = [...list].map((file) => ({ name: file.name, file }));
    void beginImport(items, targetDir);
  };

  const beginImport = async (items: PendingImport[], targetDir: string) => {
    if (readOnly) {
      notify("error", "需求目录已锁定，无法上传资料");
      return;
    }
    const invalid = items.filter((item) => validateName(item.name));
    const valid = items.filter((item) => !validateName(item.name));
    invalid.forEach((item) => notify("error", `文件名包含非法字符，已跳过：${item.name}`));
    if (!valid.length) return;
    const existing = await api.listDirectory(targetDir).catch(() => [] as DirEntryInfo[]);
    const existingNames = new Set(existing.map((entry) => entry.name));
    const conflicts = valid.filter((item) => existingNames.has(item.name));
    if (conflicts.length) {
      setConflictModal({
        targetDir,
        items: valid,
        conflicts,
        strategies: Object.fromEntries(conflicts.map((item) => [item.name, "rename" as ImportConflictStrategy])),
      });
      return;
    }
    await runImport(valid, targetDir, {});
  };

  const runImport = async (items: PendingImport[], targetDir: string, strategies: Record<string, ImportConflictStrategy>) => {
    setBusy(true);
    const results: ImportResultItem[] = [];
    const pathItems = items.filter((item) => item.sourcePath);
    if (pathItems.length) {
      try {
        results.push(...await api.importFiles(targetDir, pathItems.map((item) => ({
          source_path: item.sourcePath!,
          name: item.name,
          strategy: strategies[item.name] || "auto",
        }))));
      } catch (reason) {
        pathItems.forEach((item) => results.push({ name: item.name, source_path: item.sourcePath!, target_path: null, status: "failed", message: String(reason) }));
      }
    }
    const fileItems = items.filter((item) => item.file);
    if (fileItems.length) {
      const usedNames = new Set((await api.listDirectory(targetDir).catch(() => [] as DirEntryInfo[])).map((entry) => entry.name));
      for (const item of fileItems) {
        const strategy = strategies[item.name] || "auto";
        let targetName = item.name;
        let status: ImportResultItem["status"] = "imported";
        if (usedNames.has(targetName)) {
          if (strategy === "skip") {
            results.push({ name: item.name, source_path: item.name, target_path: null, status: "skipped", message: "同名文件已存在，按策略跳过" });
            continue;
          }
          if (strategy === "rename") {
            targetName = nextAvailableName(item.name, usedNames);
            status = "renamed";
          } else if (strategy === "overwrite") {
            status = "overwritten";
          } else {
            results.push({ name: item.name, source_path: item.name, target_path: null, status: "failed", message: "同名文件已存在，未指定处理策略" });
            continue;
          }
        }
        try {
          const bytes = new Uint8Array(await item.file!.arrayBuffer());
          const target = joinPath(targetDir, targetName);
          if (status === "overwritten") await api.writeBinaryFile(target, bytes);
          else await api.createBinaryFile(target, bytes);
          usedNames.add(targetName);
          results.push({ name: item.name, source_path: item.name, target_path: target, status, message: "" });
        } catch (reason) {
          results.push({ name: item.name, source_path: item.name, target_path: null, status: "failed", message: String(reason) });
        }
      }
    }
    setBusy(false);
    const imported = results.filter((item) => item.status === "imported").length;
    const renamed = results.filter((item) => item.status === "renamed").length;
    const overwritten = results.filter((item) => item.status === "overwritten").length;
    const skipped = results.filter((item) => item.status === "skipped").length;
    const failedItems = results.filter((item) => item.status === "failed");
    const summary = `导入完成：新增 ${imported}${renamed ? `、保留两者重命名 ${renamed}` : ""}${overwritten ? `、覆盖 ${overwritten}` : ""}${skipped ? `、跳过 ${skipped}` : ""}${failedItems.length ? `、失败 ${failedItems.length}` : ""}`;
    if (failedItems.length) {
      notify("error", `${summary}。${failedItems.slice(0, 3).map((item) => `${item.name}：${item.message}`).join("；")}`, 10000);
    } else {
      notify("success", summary);
    }
    const uploaded = results
      .filter((item) => item.target_path && (item.status === "imported" || item.status === "renamed"))
      .map((item) => ({ path: item.target_path!, dir: targetDir, name: fileName(item.target_path!) }));
    if (uploaded.length) setNamingFiles(uploaded);
    await load();
  };

  const quickCreateImageGroup = async (name: string) => {
    const path = joinPath(basePath, IMAGE_ZONE, name);
    const info = await api.getPathInfo(path).catch(() => null);
    if (info?.exists) {
      notify("info", `分组已存在：${name}`);
      return;
    }
    try {
      await api.createDirectory(path);
      notify("success", `已创建图片分组：${name}`);
      await load();
    } catch (reason) {
      notify("error", `创建分组失败：${String(reason)}`);
    }
  };

  dropImportRef.current = (paths: string[], dir: string) => {
    const items = paths
      .map((path) => ({ name: fileName(path), sourcePath: path }))
      .filter((item) => item.name);
    if (items.length) void beginImport(items, dir);
  };
  pasteImportRef.current = (files: File[]) => {
    const stamp = timestampForName(new Date());
    const items = files.map((file, index) => ({ name: `粘贴截图_${stamp}${files.length > 1 ? `_${index + 1}` : ""}.${extensionForMime(file.type)}`, file }));
    void beginImport(items, pasteDir);
  };

  const headerTitle = isMaterials ? "需求资料" : folder;
  const currentDirLabel = currentRel || folder;

  return <div className="workspace-view materials-view">
    <section className="document-header">
      <div className="document-title-row">
        <span className={`document-icon ${readOnly ? "amber" : "blue"}`}><AppIcon name={readOnly ? "lock" : "folder"} size={20} /></span>
        <div>
          <div className="eyebrow">{platformPath} / {requirementId}</div>
          <h1>{headerTitle} <span>{requirementId}</span></h1>
          <p>{currentPath}</p>
        </div>
      </div>
      <div className="header-actions">
        <div className="document-search"><AppIcon name="search" size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="筛选文件" /></div>
        <div className="materials-view-toggle" role="group" title="视图切换">
          <button className={viewMode === "list" ? "active" : ""} type="button" onClick={() => switchView("list")}><AppIcon name="list" size={13} /> 列表</button>
          <button className={viewMode === "grid" ? "active" : ""} type="button" onClick={() => switchView("grid")}><AppIcon name="image" size={13} /> 缩略图</button>
        </div>
        <button className="button button-ghost" type="button" onClick={() => void load()} title="刷新当前目录"><AppIcon name="refresh" size={15} /> 刷新</button>
        <button className="button button-ghost" type="button" onClick={() => void systemOpen.reveal(currentPath)}><AppIcon name="folderOpen" size={15} /> 在目录中显示</button>
        <button className="button button-ghost" type="button" onClick={() => void systemOpen.openDirectory(currentPath)}><AppIcon name="external" size={15} /> 外部打开目录</button>
      </div>
    </section>

    <div className="materials-breadcrumb">
      <AppIcon name="folder" size={14} />
      <button type="button" className={currentRel ? "" : "current"} onClick={() => setCurrentRel("")}>{folder}</button>
      {breadcrumbSegments.map((segment, index) => (
        <React.Fragment key={index}>
          <AppIcon name="next" size={12} />
          <button type="button" className={index === breadcrumbSegments.length - 1 ? "current" : ""} onClick={() => setCurrentRel(breadcrumbSegments.slice(0, index + 1).join("/"))}>{segment}</button>
        </React.Fragment>
      ))}
      <span className="section-muted">{fileCount} 个文件{imageCount ? ` · ${imageCount} 张图片` : ""}{busy ? " · 正在导入…" : ""}</span>
    </div>

    {readOnly && <div className="unlock-warning"><AppIcon name="lock" size={14} /><span>需求目录已锁定，资料页为只读状态：创建、上传、重命名和删除均已禁用；外部 AI 的修改会通过文件监听自动刷新。</span></div>}

    <div
      ref={contentRef}
      className={`materials-drop-area ${dragActive ? "drag-active" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragActive(true); setDropZone(targetAtRef.current(event.clientX, event.clientY).zone); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDragActive(false); setDropZone(null); } }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        setDropZone(null);
        if (isTauri) return; // Tauri 路径由 webview onDragDropEvent 处理
        onInputFiles(event.dataTransfer?.files || null, targetAtRef.current(event.clientX, event.clientY).dir);
      }}
    >
      {dragActive && <div className="materials-drop-hint"><AppIcon name="upload" size={18} />{readOnly ? "需求已锁定，无法导入" : `拖放到 ${currentDirLabel}`}</div>}
      {loading ? <div className="loading-line"><span className="spinner" />正在读取目录…</div>
        : error ? <div className="inline-empty large"><AppIcon name="alert" size={18} />{error}</div>
          : atMaterialsHome
            ? <MaterialsHome
              basePath={basePath}
              docDir={joinPath(basePath, DOC_ZONE)}
              imageDir={joinPath(basePath, IMAGE_ZONE)}
              dropZone={dropZone}
              entries={entries}
              docs={visibleZoneDocs}
              images={visibleZoneImages}
              docDirs={zoneDocDirs}
              imageDirs={zoneImageDirs}
              readOnly={readOnly}
              viewMode={viewMode}
              onEnter={setCurrentRel}
              onOpenFile={openFile}
              onCreateDoc={(dir) => setCreateDocTarget({ dir })}
              onCreateDir={(parent) => setCreateDirTarget({ parent })}
              onQuickGroup={quickCreateImageGroup}
              onUpload={pickFiles}
              onRename={setRenameTarget}
              onDelete={setDeleteTarget}
              onCopyPath={(path) => void copyPath(path)}
              protectionFor={(path) => protectionReason(path, requirementPath)}
            />
            : <DirBrowser
              dirs={dirs}
              files={files}
              currentRel={currentRel}
              viewMode={viewMode}
              readOnly={readOnly}
              insideImageZone={insideImageZone}
              onEnter={(name) => setCurrentRel(currentRel ? `${currentRel}/${name}` : name)}
              onOpenFile={openFile}
              onCreateDoc={() => setCreateDocTarget({ dir: currentPath })}
              onCreateDir={() => setCreateDirTarget({ parent: currentPath })}
              onQuickGroup={quickCreateImageGroup}
              onUpload={(imagesOnly) => void pickFiles(imagesOnly, currentPath)}
              onRename={setRenameTarget}
              onDelete={setDeleteTarget}
              onCopyPath={(path) => void copyPath(path)}
              protectionFor={(path) => protectionReason(path, requirementPath)}
            />}
    </div>

    <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(event) => { onInputFiles(event.target.files, pendingUploadDir.current || currentPath); event.target.value = ""; }} />
    <input ref={imageInputRef} type="file" multiple accept="image/*" style={{ display: "none" }} onChange={(event) => { onInputFiles(event.target.files, pendingUploadDir.current || currentPath); event.target.value = ""; }} />

    {createDocTarget && <CreateDocModal dir={createDocTarget.dir} busy={busy} onClose={() => setCreateDocTarget(null)} onCreated={async (name, title) => {
      const file = /\.(md|txt)$/i.test(name) ? name : `${name}.md`;
      const path = joinPath(createDocTarget.dir, file);
      const heading = title || name.replace(/\.(md|txt)$/i, "");
      await api.createTextFile(path, /\.txt$/i.test(file) ? `${heading}\n` : `# ${heading}\n`);
      setCreateDocTarget(null);
      notify("success", `已创建文档：${file}`);
      await load();
      onOpenTab({ id: `file:${path}`, type: "markdown", title: file, subtitle: path, icon: "markdown", preview: true, pinned: false, dirty: false, closable: true, payload: { path, focus: "edit" } });
    }} />}

    {createDirTarget && <CreateDirModal parent={createDirTarget.parent} initialName={createDirTarget.initialName || ""} onClose={() => setCreateDirTarget(null)} onCreated={async (name) => {
      const path = joinPath(createDirTarget.parent, name);
      const info = await api.getPathInfo(path);
      if (info.exists) throw new Error(`已存在同名文件或目录：${name}`);
      await api.createDirectory(path);
      setCreateDirTarget(null);
      notify("success", `已创建目录：${name}`);
      await load();
    }} />}

    {renameTarget && <RenameModal entry={renameTarget} onClose={() => setRenameTarget(null)} onRenamed={async (newName) => {
      const normalized = renameTarget.path.replace(/\\/g, "/");
      const parent = normalized.slice(0, normalized.lastIndexOf("/"));
      await api.renamePath(renameTarget.path, joinPath(parent, newName));
      setRenameTarget(null);
      notify("success", `已重命名为：${newName}`);
      await load();
    }} />}

    {deleteTarget && <DeleteModal entry={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={async () => {
      await api.deletePath(deleteTarget.path);
      setDeleteTarget(null);
      notify("success", `已删除：${deleteTarget.name}`);
      await load();
    }} />}

    {namingFiles && <UploadNameModal files={namingFiles} onClose={() => setNamingFiles(null)} onSaved={async () => {
      setNamingFiles(null);
      notify("success", "资料名称已保存");
      await load();
    }} />}

    {conflictModal && <ConflictModal state={conflictModal} onCancel={() => setConflictModal(null)} onConfirm={(strategies) => {
      const state = conflictModal;
      setConflictModal(null);
      void runImport(state.items, state.targetDir, strategies);
    }} />}
  </div>;
}

/* ---------- 01-需求资料 首页：需求文档 + 需求截图 双区域 ---------- */

function MaterialsHome({ basePath, docDir, imageDir, dropZone, entries, docs, images, docDirs, imageDirs, readOnly, viewMode, onEnter, onOpenFile, onCreateDoc, onCreateDir, onQuickGroup, onUpload, onRename, onDelete, onCopyPath, protectionFor }: {
  basePath: string;
  docDir: string;
  imageDir: string;
  dropZone: DropZone | null;
  entries: DirEntryInfo[];
  docs: RelFile[];
  images: RelFile[];
  docDirs: DirEntryInfo[];
  imageDirs: DirEntryInfo[];
  readOnly: boolean;
  viewMode: ViewMode;
  onEnter: (rel: string) => void;
  onOpenFile: (file: RelFile | DirEntryInfo) => void;
  onCreateDoc: (dir: string) => void;
  onCreateDir: (parent: string) => void;
  onQuickGroup: (name: string) => void;
  onUpload: (imagesOnly: boolean, targetDir: string) => void;
  onRename: (entry: DirEntryInfo) => void;
  onDelete: (entry: DirEntryInfo) => void;
  onCopyPath: (path: string) => void;
  protectionFor: (path: string) => string | null;
}) {
  const docZoneExists = entries.some((entry) => entry.is_dir && entry.name === DOC_ZONE);
  const imageZoneExists = entries.some((entry) => entry.is_dir && entry.name === IMAGE_ZONE);
  const otherEntries = entries.filter((entry) => entry.name !== DOC_ZONE && entry.name !== IMAGE_ZONE);

  return <>
    <section className={`panel-section ${dropZone === "docs" ? "drop-zone-active" : ""}`} data-drop-zone="docs">
      <div className="section-heading">
        <div><AppIcon name="markdown" size={16} /><h2>需求文档</h2></div>
        <div className="section-heading-actions">
          <span className="section-muted">{docs.length} 个文档</span>
          {docZoneExists && <button className="text-button" type="button" onClick={() => onEnter(DOC_ZONE)}>进入 <AppIcon name="next" size={13} /></button>}
          <button className="text-button" type="button" disabled={readOnly} onClick={() => onCreateDoc(docDir)}><AppIcon name="add" size={13} /> 新建文档</button>
          <button className="text-button" type="button" disabled={readOnly} onClick={() => onCreateDir(docDir)}><AppIcon name="add" size={13} /> 新建子目录</button>
          <button className="text-button" type="button" disabled={readOnly} onClick={() => onUpload(false, docDir)}><AppIcon name="upload" size={13} /> 上传资料</button>
        </div>
      </div>
      {docZoneExists
        ? <>
          <DirCardGrid dirs={docDirs} readOnly={readOnly} onEnter={(name) => onEnter(`${DOC_ZONE}/${name}`)} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} />
          {docs.length
            ? <FileList files={docs} viewMode={viewMode} readOnly={readOnly} showRelative onOpenFile={onOpenFile} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} />
            : !docDirs.length && <div className="inline-empty"><AppIcon name="inbox" size={15} />需求文档目录为空，可新建 Markdown 或上传 DOCX / PDF / XLSX 资料。</div>}
        </>
        : <div className="inline-empty"><AppIcon name="inbox" size={15} />尚未创建「需求文档」目录。<button className="text-button" type="button" disabled={readOnly} onClick={() => onCreateDir(basePath)}>创建目录</button></div>}
    </section>

    <section className={`panel-section ${dropZone === "images" ? "drop-zone-active" : ""}`} data-drop-zone="images">
      <div className="section-heading">
        <div><AppIcon name="image" size={16} /><h2>需求截图</h2></div>
        <div className="section-heading-actions">
          <span className="section-muted">{images.length} 张图片</span>
          {imageZoneExists && <button className="text-button" type="button" onClick={() => onEnter(IMAGE_ZONE)}>进入 <AppIcon name="next" size={13} /></button>}
          {QUICK_IMAGE_GROUPS.map((name) => <button key={name} className="text-button" type="button" disabled={readOnly} onClick={() => onQuickGroup(name)}><AppIcon name="add" size={13} /> {name}</button>)}
          <button className="text-button" type="button" disabled={readOnly} onClick={() => onCreateDir(imageDir)}><AppIcon name="add" size={13} /> 自定义分组</button>
          <button className="text-button" type="button" disabled={readOnly} onClick={() => onUpload(true, imageDir)}><AppIcon name="upload" size={13} /> 上传图片</button>
        </div>
      </div>
      {imageZoneExists
        ? <>
          <DirCardGrid dirs={imageDirs} readOnly={readOnly} onEnter={(name) => onEnter(`${IMAGE_ZONE}/${name}`)} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} />
          {images.length
            ? <ThumbGrid files={images} readOnly={readOnly} onOpenFile={onOpenFile} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} showRelative />
            : !imageDirs.length && <div className="inline-empty"><AppIcon name="inbox" size={15} />暂无截图，可上传图片或拖入文件。</div>}
        </>
        : <div className="inline-empty"><AppIcon name="inbox" size={15} />尚未创建「需求截图」目录。<button className="text-button" type="button" disabled={readOnly} onClick={() => onQuickGroup("原始业务截图")}>创建分组</button></div>}
    </section>

    {otherEntries.length > 0 && <section className="panel-section">
      <div className="section-heading"><div><AppIcon name="file" size={16} /><h2>其他内容</h2></div><span className="section-muted">{otherEntries.length} 项</span></div>
      <DirCardGrid dirs={otherEntries.filter((entry) => entry.is_dir)} readOnly={readOnly} onEnter={onEnter} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} />
      <FileList files={otherEntries.filter((entry) => !entry.is_dir).map((entry) => ({ ...entry, relative: entry.name }))} viewMode={viewMode} readOnly={readOnly} onOpenFile={onOpenFile} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} />
    </section>}
  </>;
}

/* ---------- 通用目录浏览 ---------- */

function DirBrowser({ dirs, files, currentRel, viewMode, readOnly, insideImageZone, onEnter, onOpenFile, onCreateDoc, onCreateDir, onQuickGroup, onUpload, onRename, onDelete, onCopyPath, protectionFor }: {
  dirs: DirEntryInfo[];
  files: DirEntryInfo[];
  currentRel: string;
  viewMode: ViewMode;
  readOnly: boolean;
  insideImageZone: boolean;
  onEnter: (name: string) => void;
  onOpenFile: (file: RelFile | DirEntryInfo) => void;
  onCreateDoc: () => void;
  onCreateDir: () => void;
  onQuickGroup: (name: string) => void;
  onUpload: (imagesOnly: boolean) => void;
  onRename: (entry: DirEntryInfo) => void;
  onDelete: (entry: DirEntryInfo) => void;
  onCopyPath: (path: string) => void;
  protectionFor: (path: string) => string | null;
}) {
  return <section className="panel-section">
    <div className="section-heading">
      <div><AppIcon name="folder" size={16} /><h2>目录内容</h2></div>
      <div className="section-heading-actions">
        <span className="section-muted">{dirs.length + files.length} 项</span>
        <button className="text-button" type="button" disabled={readOnly} onClick={onCreateDoc}><AppIcon name="add" size={13} /> 新建文档</button>
        <button className="text-button" type="button" disabled={readOnly} onClick={onCreateDir}><AppIcon name="add" size={13} /> 新建子目录</button>
        {insideImageZone && QUICK_IMAGE_GROUPS.map((name) => <button key={name} className="text-button" type="button" disabled={readOnly} onClick={() => onQuickGroup(name)}><AppIcon name="add" size={13} /> {name}</button>)}
        <button className="text-button" type="button" disabled={readOnly} onClick={() => onUpload(false)}><AppIcon name="upload" size={13} /> 上传资料</button>
        <button className="text-button" type="button" disabled={readOnly} onClick={() => onUpload(true)}><AppIcon name="upload" size={13} /> 上传图片</button>
      </div>
    </div>
    <DirCardGrid dirs={dirs} readOnly={readOnly} onEnter={(name) => onEnter(name)} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} />
    {viewMode === "list"
      ? <FileList files={files.map((file) => ({ ...file, relative: currentRel ? `${currentRel}/${file.name}` : file.name }))} viewMode={viewMode} readOnly={readOnly} onOpenFile={onOpenFile} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} />
      : <ThumbGrid files={files.map((file) => ({ ...file, relative: file.name }))} readOnly={readOnly} onOpenFile={onOpenFile} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} />}
    {!dirs.length && !files.length && <div className="inline-empty large"><AppIcon name="inbox" size={18} />该目录下暂无内容，可新建文档、子目录或上传资料。</div>}
  </section>;
}

function DirCardGrid({ dirs, readOnly, onEnter, onRename, onDelete, onCopyPath, protectionFor }: {
  dirs: DirEntryInfo[];
  readOnly: boolean;
  onEnter: (name: string) => void;
  onRename: (entry: DirEntryInfo) => void;
  onDelete: (entry: DirEntryInfo) => void;
  onCopyPath: (path: string) => void;
  protectionFor: (path: string) => string | null;
}) {
  if (!dirs.length) return null;
  return <div className="materials-dir-grid">{dirs.map((dir) => {
    const reason = protectionFor(dir.path);
    return <div key={dir.path} className="materials-dir-card" role="button" tabIndex={0} onClick={() => onEnter(dir.name)} onKeyDown={(event) => { if (event.key === "Enter") onEnter(dir.name); }} title={dir.path}>
      <AppIcon name="folder" size={18} />
      <span>{dir.name}</span>
      <div className="materials-card-actions" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button" type="button" title="在目录中显示" onClick={() => void systemOpen.reveal(dir.path)}><AppIcon name="folderOpen" size={13} /></button>
        <button className="icon-button" type="button" title="复制路径" onClick={() => onCopyPath(dir.path)}><AppIcon name="copy" size={13} /></button>
        <button className="icon-button" type="button" title={reason || "重命名"} disabled={readOnly || Boolean(reason)} onClick={() => onRename(dir)}><AppIcon name="edit" size={13} /></button>
        <button className="icon-button" type="button" title={reason || "删除（目录需为空）"} disabled={readOnly || Boolean(reason)} onClick={() => onDelete(dir)}><AppIcon name="close" size={13} /></button>
      </div>
    </div>;
  })}</div>;
}

function FileList({ files, viewMode, readOnly, showRelative, onOpenFile, onRename, onDelete, onCopyPath, protectionFor }: {
  files: RelFile[];
  viewMode: ViewMode;
  readOnly: boolean;
  showRelative?: boolean;
  onOpenFile: (file: RelFile) => void;
  onRename: (entry: DirEntryInfo) => void;
  onDelete: (entry: DirEntryInfo) => void;
  onCopyPath: (path: string) => void;
  protectionFor: (path: string) => string | null;
}) {
  if (viewMode === "grid") {
    return <ThumbGrid files={files} readOnly={readOnly} onOpenFile={onOpenFile} onRename={onRename} onDelete={onDelete} onCopyPath={onCopyPath} protectionFor={protectionFor} showRelative={showRelative} />;
  }
  return <div className="folder-file-list">{files.map((file) => {
    const reason = protectionFor(file.path);
    return <div className="folder-file-row" key={file.path} role="button" tabIndex={0} onClick={() => onOpenFile(file)} onKeyDown={(event) => { if (event.key === "Enter") onOpenFile(file); }} title={file.path}>
      <AppIcon name={fileIcon(file.name)} size={15} />
      <span className="folder-file-name">{file.name}</span>
      {showRelative && <span className="folder-file-rel mono">{file.relative}</span>}
      <span className="folder-file-meta">{formatSize(file.size)} · {file.modified ? formatDateTime(file.modified) : "—"}</span>
      <span className="materials-row-actions" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button" type="button" title="外部打开" onClick={() => void systemOpen.openFile(file.path)}><AppIcon name="external" size={13} /></button>
        <button className="icon-button" type="button" title="在目录中显示" onClick={() => void systemOpen.reveal(file.path)}><AppIcon name="folderOpen" size={13} /></button>
        <button className="icon-button" type="button" title="复制路径" onClick={() => onCopyPath(file.path)}><AppIcon name="copy" size={13} /></button>
        <button className="icon-button" type="button" title={reason || "重命名"} disabled={readOnly || Boolean(reason)} onClick={() => onRename(asEntry(file))}><AppIcon name="edit" size={13} /></button>
        <button className="icon-button" type="button" title={reason || "删除"} disabled={readOnly || Boolean(reason)} onClick={() => onDelete(asEntry(file))}><AppIcon name="close" size={13} /></button>
      </span>
    </div>;
  })}</div>;
}

function ThumbGrid({ files, readOnly, showRelative, onOpenFile, onRename, onDelete, onCopyPath, protectionFor }: {
  files: RelFile[];
  readOnly: boolean;
  showRelative?: boolean;
  onOpenFile: (file: RelFile) => void;
  onRename: (entry: DirEntryInfo) => void;
  onDelete: (entry: DirEntryInfo) => void;
  onCopyPath: (path: string) => void;
  protectionFor: (path: string) => string | null;
}) {
  return <div className="folder-thumb-grid">{files.map((file) => {
    const reason = protectionFor(file.path);
    return <div className="folder-thumb materials-thumb" key={file.path} role="button" tabIndex={0} onClick={() => onOpenFile(file)} onKeyDown={(event) => { if (event.key === "Enter") onOpenFile(file); }} title={file.path}>
      {IMAGE_RE.test(file.name) ? <Thumb file={file} /> : <div className="materials-thumb-icon"><AppIcon name={fileIcon(file.name)} size={26} /></div>}
      <span>{file.name}</span>
      {showRelative && <small className="mono">{file.relative}</small>}
      <div className="materials-card-actions" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button" type="button" title="外部打开" onClick={() => void systemOpen.openFile(file.path)}><AppIcon name="external" size={12} /></button>
        <button className="icon-button" type="button" title="在目录中显示" onClick={() => void systemOpen.reveal(file.path)}><AppIcon name="folderOpen" size={12} /></button>
        <button className="icon-button" type="button" title={reason || "重命名"} disabled={readOnly || Boolean(reason)} onClick={() => onRename(asEntry(file))}><AppIcon name="edit" size={12} /></button>
        <button className="icon-button" type="button" title={reason || "删除"} disabled={readOnly || Boolean(reason)} onClick={() => onDelete(asEntry(file))}><AppIcon name="close" size={12} /></button>
      </div>
    </div>;
  })}</div>;
}

function Thumb({ file }: { file: RelFile }) {
  const key = `${file.path}|${file.size}|${file.modified}`;
  const [url, setUrl] = useState<string | null>(thumbCache.get(key) || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (url || failed) return;
    let cancelled = false;
    api.readBinaryFile(file.path).then((bytes) => {
      if (cancelled) return;
      const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
      if (thumbCache.size >= THUMB_LIMIT) {
        const oldest = thumbCache.entries().next().value;
        if (oldest) { URL.revokeObjectURL(oldest[1]); thumbCache.delete(oldest[0]); }
      }
      thumbCache.set(key, blobUrl);
      setUrl(blobUrl);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [key, url, failed, file.path]);
  if (failed) return <div className="materials-thumb-icon"><AppIcon name="alert" size={20} /></div>;
  if (!url) return <div className="materials-thumb-icon"><span className="spinner" /></div>;
  return <img src={url} alt={file.name} loading="lazy" />;
}

/* ---------- 弹窗 ---------- */

function ModalShell({ title, eyebrow, children, onClose, busy }: { title: string; eyebrow: string; children: React.ReactNode; onClose: () => void; busy?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <div className="modal">
      <div className="modal-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={busy} title="关闭"><AppIcon name="close" size={16} /></button></div>
      {children}
    </div>
  </div>;
}

function CreateDocModal({ dir, busy, onClose, onCreated }: { dir: string; busy: boolean; onClose: () => void; onCreated: (name: string, title: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("文件名不能为空"); return; }
    if (INVALID_NAME_RE.test(trimmed) || trimmed === "." || trimmed === "..") { setError("文件名不能包含 \\ / : * ? \" < > | 等非法字符"); return; }
    if (/\.[^.]+$/.test(trimmed) && !/\.(md|txt)$/i.test(trimmed)) { setError("资料文档仅支持 .md / .txt 后缀"); return; }
    setSaving(true);
    setError(null);
    try {
      await onCreated(trimmed, title.trim());
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };
  return <ModalShell title="新建 Markdown / 文本文档" eyebrow="需求资料" onClose={onClose} busy={saving || busy}>
    <form onSubmit={(event) => void submit(event)}>
      <p className="modal-description">在 <span className="mono">{dir}</span> 下创建文档；目标已存在时不会覆盖。</p>
      <label className="field-label">文件名<input className="field-input mono" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：接口对接说明（自动补 .md 后缀）" disabled={saving} autoFocus /></label>
      <label className="field-label">初始标题（可选）<input className="field-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="写入文档的一级标题" disabled={saving} /></label>
      {error && <div className="modal-error"><AppIcon name="error" size={15} /><span>{error}</span></div>}
      <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>取消</button><button className="button button-primary" type="submit" disabled={saving || !name.trim()}>{saving ? <span className="spinner" /> : <AppIcon name="add" size={14} />} 创建并打开</button></div>
    </form>
  </ModalShell>;
}

function CreateDirModal({ parent, initialName, onClose, onCreated }: { parent: string; initialName: string; onClose: () => void; onCreated: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("目录名不能为空"); return; }
    if (INVALID_NAME_RE.test(trimmed) || trimmed === "." || trimmed === "..") { setError("目录名不能包含 \\ / : * ? \" < > | 等非法字符"); return; }
    setSaving(true);
    setError(null);
    try {
      await onCreated(trimmed);
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };
  return <ModalShell title="新建子目录" eyebrow="需求资料" onClose={onClose} busy={saving}>
    <form onSubmit={(event) => void submit(event)}>
      <p className="modal-description">在 <span className="mono">{parent}</span> 下创建分类目录。</p>
      <label className="field-label">目录名<input id="materials-dir-name" className="field-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：接口文档、原型截图" disabled={saving} autoFocus /></label>
      {error && <div className="modal-error"><AppIcon name="error" size={15} /><span>{error}</span></div>}
      <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>取消</button><button className="button button-primary" type="submit" disabled={saving || !name.trim()}>{saving ? <span className="spinner" /> : <AppIcon name="add" size={14} />} 创建目录</button></div>
    </form>
  </ModalShell>;
}

function RenameModal({ entry, onClose, onRenamed }: { entry: DirEntryInfo; onClose: () => void; onRenamed: (name: string) => Promise<void> }) {
  const [name, setName] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("名称不能为空"); return; }
    if (INVALID_NAME_RE.test(trimmed) || trimmed === "." || trimmed === "..") { setError("名称不能包含 \\ / : * ? \" < > | 等非法字符"); return; }
    if (trimmed === entry.name) { onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      await onRenamed(trimmed);
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };
  return <ModalShell title={entry.is_dir ? "重命名目录" : "重命名文件"} eyebrow="需求资料" onClose={onClose} busy={saving}>
    <form onSubmit={(event) => void submit(event)}>
      <p className="modal-description mono">{entry.path}</p>
      <label className="field-label">新名称<input className="field-input" value={name} onChange={(event) => setName(event.target.value)} disabled={saving} autoFocus /></label>
      {error && <div className="modal-error"><AppIcon name="error" size={15} /><span>{error}</span></div>}
      <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>取消</button><button className="button button-primary" type="submit" disabled={saving || !name.trim() || name.trim() === entry.name}>{saving ? <span className="spinner" /> : <AppIcon name="save" size={14} />} 重命名</button></div>
    </form>
  </ModalShell>;
}

function DeleteModal({ entry, onClose, onDeleted }: { entry: DirEntryInfo; onClose: () => void; onDeleted: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const confirm = async () => {
    setSaving(true);
    setError(null);
    try {
      await onDeleted();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };
  return <ModalShell title={entry.is_dir ? "删除目录" : "删除文件"} eyebrow="需求资料" onClose={onClose} busy={saving}>
    <p className="modal-description">确认删除 <strong>{entry.name}</strong> 吗？{entry.is_dir ? "目录必须为空才能删除；" : ""}该操作会直接移除磁盘文件，不可撤销。</p>
    <p className="modal-description mono">{entry.path}</p>
    {error && <div className="modal-error"><AppIcon name="error" size={15} /><span>{error}</span></div>}
    <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>取消</button><button className="button button-danger" type="button" disabled={saving} onClick={() => void confirm()}>{saving ? <span className="spinner" /> : <AppIcon name="close" size={14} />} 确认删除</button></div>
  </ModalShell>;
}

function UploadNameModal({ files, onClose, onSaved }: { files: UploadedFile[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(files.map((file) => [file.path, file.name])));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const changed = files.filter((file) => (names[file.path] ?? file.name).trim() !== file.name);
    const invalid = changed.find((file) => {
      const next = (names[file.path] ?? "").trim();
      return !next || INVALID_NAME_RE.test(next) || next === "." || next === "..";
    });
    if (invalid) { setError(`“${invalid.name}”的新名称不能为空或包含 \\ / : * ? " < > | 等非法字符`); return; }
    const duplicate = new Set<string>();
    for (const file of files) {
      const next = (names[file.path] ?? file.name).trim();
      if (duplicate.has(next.toLowerCase())) { setError(`存在重复名称：${next}`); return; }
      duplicate.add(next.toLowerCase());
    }
    setSaving(true);
    setError(null);
    try {
      for (const file of changed) {
        const next = (names[file.path] ?? "").trim();
        const parent = file.dir;
        await api.renamePath(file.path, joinPath(parent, next));
      }
      await onSaved();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };
  return <ModalShell title="命名已上传的资料" eyebrow="上传资料" onClose={onClose} busy={saving}>
    <form onSubmit={(event) => void submit(event)}>
      <p className="modal-description">可直接修改文件名；扩展名保持不变时无需改动。保存前将检查同名冲突。</p>
      <div className="conflict-list">
        {files.map((file) => <div className="conflict-row" key={file.path}>
          <AppIcon name="file" size={14} />
          <input className="field-input mono" value={names[file.path] ?? file.name} onChange={(event) => setNames((current) => ({ ...current, [file.path]: event.target.value }))} disabled={saving} />
        </div>)}
      </div>
      {error && <div className="modal-error"><AppIcon name="error" size={15} /><span>{error}</span></div>}
      <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onClose} disabled={saving}>保持原名</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : <AppIcon name="save" size={14} />} 保存名称</button></div>
    </form>
  </ModalShell>;
}

function ConflictModal({ state, onCancel, onConfirm }: { state: ConflictModalState; onCancel: () => void; onConfirm: (strategies: Record<string, ImportConflictStrategy>) => void }) {
  const [strategies, setStrategies] = useState(state.strategies);
  const applyAll = (strategy: ImportConflictStrategy) => {
    setStrategies(Object.fromEntries(state.conflicts.map((item) => [item.name, strategy])));
  };
  const okCount = state.items.length - state.conflicts.length;
  return <ModalShell title="同名文件处理" eyebrow="上传资料" onClose={onCancel}>
    <p className="modal-description">目标目录中已存在 <strong>{state.conflicts.length}</strong> 个同名文件{okCount ? `，其余 ${okCount} 个将直接导入` : ""}。覆盖会替换磁盘上的现有文件。</p>
    <div className="conflict-apply-all"><span className="section-muted">应用到全部冲突：</span>{(["rename", "overwrite", "skip"] as ImportConflictStrategy[]).map((strategy) => <button key={strategy} className="text-button" type="button" onClick={() => applyAll(strategy)}>{strategyLabel(strategy)}</button>)}</div>
    <div className="conflict-list">
      {state.conflicts.map((item) => <div className="conflict-row" key={item.name}>
        <AppIcon name="alert" size={14} />
        <span className="conflict-name" title={item.name}>{item.name}</span>
        <select className="select-control" value={strategies[item.name] || "rename"} onChange={(event) => setStrategies((current) => ({ ...current, [item.name]: event.target.value as ImportConflictStrategy }))}>
          <option value="rename">保留两者（自动重命名）</option>
          <option value="overwrite">覆盖现有文件</option>
          <option value="skip">跳过</option>
        </select>
      </div>)}
    </div>
    <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onCancel}>取消本批</button><button className="button button-primary" type="button" onClick={() => onConfirm(strategies)}><AppIcon name="upload" size={14} /> 开始导入</button></div>
  </ModalShell>;
}

/* ---------- 工具函数 ---------- */

// 资料页保护规则：返回不可重命名/删除的原因；返回 null 表示可操作
function protectionReason(path: string, requirementPath: string): string | null {
  const rel = relativeWithin(path, requirementPath);
  if (!rel) return "不在当前需求目录范围内";
  if (rel === "requirement.yaml") return "requirement.yaml 由需求服务管理";
  if (rel === `${MATERIALS_ROOT}/${DOC_ZONE}` || rel === `${MATERIALS_ROOT}/${IMAGE_ZONE}`) return "标准资料目录由工作区结构管理";
  if (rel === "02-需求理解与答疑/questions.json") return "答疑数据由疑问工作区管理";
  if (rel === "03-测试计划/coverage.json") return "覆盖追溯数据由覆盖追溯功能管理";
  if (/^04-测试用例\/(versions|reviews)(\/|$)/.test(rel) || rel === "04-测试用例/cases.json") return "用例数据由结构化用例功能管理";
  if (/^(06-测试执行与证据|07-测试报告|08-知识候选)(\/|$)/.test(rel)) return "测试轮次、报告与知识数据由对应业务功能管理";
  return null;
}

function relativeWithin(path: string, parent: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedParent = parent.replace(/\\/g, "/");
  return normalizedPath.startsWith(`${normalizedParent}/`) ? normalizedPath.slice(normalizedParent.length + 1) : "";
}

function isPathWithin(path: string, parent: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedParent = parent.replace(/\\/g, "/");
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || "";
}

function asEntry(file: RelFile): DirEntryInfo {
  return { name: file.name, path: file.path, is_dir: false, size: file.size, modified: file.modified };
}

function timestampForName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function extensionForMime(mime: string): string {
  const map: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
  return map[mime] || "png";
}

function nextAvailableName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!used.has(candidate)) return candidate;
  }
  return name;
}

function strategyLabel(strategy: ImportConflictStrategy): string {
  return { auto: "自动", rename: "全部保留两者", overwrite: "全部覆盖", skip: "全部跳过" }[strategy] || strategy;
}

function formatSize(size: number): string {
  if (!size) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(name: string): IconName {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "md") return "markdown";
  if (ext === "yaml" || ext === "yml" || ext === "json") return "jsonFile";
  if (ext === "py" || ext === "rs" || ext === "ts" || ext === "tsx" || ext === "sql") return "codeFile";
  if (ext === "xmind" || ext === "zip") return "archiveFile";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "spreadsheet";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext || "")) return "image";
  return "file";
}

function readViewMode(basePath: string): ViewMode {
  try {
    return window.localStorage.getItem(`${VIEW_MODE_KEY}.${basePath}`) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function writeViewMode(basePath: string, mode: ViewMode): void {
  try {
    window.localStorage.setItem(`${VIEW_MODE_KEY}.${basePath}`, mode);
  } catch {
    return;
  }
}
