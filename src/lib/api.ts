import { invalidateBusinessData } from "./businessEvents";
// Tauri 后端调用封装
// 在浏览器开发模式下使用 mock 数据

import { STAGE_ORDER } from "./types";
import type {
  WorkspaceConfig,
  WorkspaceOpenResult,
  WorkspaceSession,
  RecentWorkspace,
  RequirementMeta,
  RequirementActivity,
  RequirementActivityEvent,
  RequirementActivityInput,
  DirEntryInfo,
  PathInfo,
  FileChanges,
  UnlockPreview,
  UnlockResult,
  PlatformInfo,
  PlatformDraft,
  PlatformUpdate,
  RequirementDraft,
  AiTaskDraft,
  AiTaskInfo,
  AiTaskActionResult,
  ClientPreferences,
  YunxiaoIdentity,
  YunxiaoTestPlanDraft,
  TestAssetInfo,
  ImportSourceItem,
  ImportResultItem,
  WorkspaceLogInput,
  WorkspaceLogList,
  WorkspaceLogRecord,
  WorkspaceSearchResult,
  StageTransitionAction,
  YunxiaoAttachment,
  YunxiaoFieldDef,
  YunxiaoMember,
  YunxiaoProject,
  YunxiaoSprint,
  YunxiaoWorkItem,
  YunxiaoWorkitemType,
  ChatMessage,
} from "./types";
import type {
  AiApproval,
  AiModelMessage,
  AiRestoreItem,
  AiRestoreOutcome,
  AiRunSummary,
  AiSession,
  AiSessionMemory,
  AiSessionSummary,
  AiSessionToolRecord,
  AiStreamEvent,
  AiToolResult,
} from "./aiSessionTypes";
import type { AgentClientRequest, AgentDecision, AgentEvent, AgentSnapshot } from "./aiSessionTypes";
import type { DocxAssetStatus, ModelProviderSettings } from "./types";

export const WORKSPACE_EVENT = "workspace://file-change";
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// 运行平台检测：macOS 快捷键展示 ⌘，其余平台展示 Ctrl
export const isMacPlatform =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || "");

// 跨平台路径拼接：统一使用正斜杠，Rust 端 Path::new 可正确解析
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/\\/g, "/").replace(/\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

// 浏览器开发模式 mock 根目录（跨平台）
const MOCK_ROOT = isTauri ? "" : (() => {
  if (typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac")) {
    return "/Users/demo/Baize/Workspace";
  }
  return "D:/BaizeDemo/Workspace";
})();

const STORE_FILE = "settings.json";
const RECENT_WORKSPACES_KEY = "workspace.recent";
const LAST_WORKSPACE_KEY = "workspace.last";
const CLIENT_PREFERENCES_KEY = "client.preferences";
const LOCAL_SESSION_KEY = "blackbox-client.workspace-session.v1";
const LOCAL_PREFERENCES_KEY = "blackbox-client.preferences.v1";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1000000;
export const DEFAULT_COMPACTION_TRIGGER_TOKENS = 500000;

export const DEFAULT_CLIENT_PREFERENCES: ClientPreferences = {
  external_programs: {
    git_command: "git",
    python_command: "python",
    editor_command: "",
  },
  auto_open_change_center: false,
  yunxiao: {
    enabled: false,
    access_token: "",
    base_url: "https://openapi-rdc.aliyuncs.com",
    organization_id: "",
    organization_name: "",
    user_id: "",
    user_name: "",
    last_verified_at: "",
  },
  model_provider: {
    enabled: false,
    base_url: "",
    api_key: "",
    model: "",
    temperature: 0.3,
    max_tokens: 4096,
    context_window_tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    compaction_trigger_tokens: DEFAULT_COMPACTION_TRIGGER_TOKENS,
    last_verified_at: "",
  },
};

export const DEFAULT_YUNXIAO_BASE_URL = "https://openapi-rdc.aliyuncs.com";
export const DEFAULT_MODEL_BASE_URL = "https://api.deepseek.com/v1";
let mockWorkspace: WorkspaceConfig | null = null;
const mockRequirements = new Map<string, RequirementMeta[]>();
const mockTasks = new Map<string, AiTaskInfo[]>();
const mockJsonFiles = new Map<string, unknown>();
const mockLogs = new Map<string, WorkspaceLogRecord[]>();
const mockTextFiles = new Map<string, string>();
const mockBinaryFiles = new Map<string, Uint8Array>();
const mockDirectories = new Set<string>();

function normalizePathForStorage(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/$/.test(normalized) || normalized === "/") return normalized;
  return normalized.replace(/\/+$/g, "");
}

function sameStoredPath(left: string, right: string): boolean {
  return normalizePathForStorage(left) === normalizePathForStorage(right);
}

function mockRequirementKey(rootPath: string, platformPath: string): string {
  return `${normalizePathForStorage(rootPath)}::${platformPath}`;
}

function emptyFileChanges(): FileChanges {
  return { added: [], modified: [], deleted: [], moved: [], total: 0 };
}

function mockRequirementDirForFile(filePath: string): string {
  const target = normalizePathForStorage(filePath);
  for (const [key, requirements] of mockRequirements.entries()) {
    const separator = key.indexOf("::");
    if (separator < 0) continue;
    const rootPath = key.slice(0, separator);
    const platformPath = key.slice(separator + 2);
    for (const requirement of requirements) {
      const requirementPath = normalizePathForStorage(joinPath(rootPath, platformPath, requirement.requirement.id));
      if (target === requirementPath || target.startsWith(`${requirementPath}/`)) return requirementPath;
    }
  }
  return "";
}

function mockRequirementForFile(filePath: string): RequirementMeta | null {
  const target = normalizePathForStorage(filePath);
  for (const [key, requirements] of mockRequirements.entries()) {
    const separator = key.indexOf("::");
    if (separator < 0) continue;
    const rootPath = key.slice(0, separator);
    const platformPath = key.slice(separator + 2);
    for (const requirement of requirements) {
      const requirementPath = normalizePathForStorage(joinPath(rootPath, platformPath, requirement.requirement.id));
      if (target === requirementPath || target.startsWith(`${requirementPath}/`)) return requirement;
    }
  }
  return null;
}

function ensureMockClientWriteAllowed(filePath: string): void {
  const requirement = mockRequirementForFile(filePath);
  if (requirement?.client_access.mode === "locked_for_ai") {
    throw new Error(`需求目录已锁定，客户端禁止写入（任务：${requirement.client_access.task_id || "未关联任务"}）`);
  }
}

// 与 Rust ensure_not_managed_path 对齐：泛型资料命令不得增删 .blackbox 与需求内受管子树
function ensureMockNotManagedPath(filePath: string): void {
  const target = normalizePathForStorage(filePath);
  if (target.includes("/.blackbox/") || target.endsWith("/.blackbox")) {
    throw new Error(".blackbox 协议目录由客户端内部管理");
  }
  const requirementDir = mockRequirementDirForFile(target);
  if (!requirementDir) return;
  const rel = target === requirementDir ? "" : target.slice(requirementDir.length + 1);
  const managedDirs = [
    "04-测试用例/versions", "04-测试用例/reviews",
    "06-测试执行与证据", "07-测试报告", "08-知识候选",
  ];
  const managed = rel === "04-测试用例/cases.json"
    || rel === "02-需求理解与答疑/questions.json"
    || rel === "activity.json"
    || rel === "activity.corrupt.json"
    || managedDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
  if (managed) throw new Error("该路径由对应业务功能管理，不能通过资料操作修改");
}

function cloneRequirement(requirement: RequirementMeta): RequirementMeta {
  return JSON.parse(JSON.stringify(requirement)) as RequirementMeta;
}

// —— BB-16E mock：需求活动台账（与 Rust 行为对齐，存储在 mockJsonFiles 中） ——
function mockActivityPath(rootPath: string, platformPath: string, requirementId: string): string {
  return normalizePathForStorage(joinPath(rootPath, platformPath, requirementId, "activity.json"));
}

function mockReadActivity(rootPath: string, platformPath: string, requirement: RequirementMeta): RequirementActivity {
  const path = mockActivityPath(rootPath, platformPath, requirement.requirement.id);
  const stored = mockJsonFiles.get(path) as RequirementActivity | undefined;
  if (stored && Array.isArray(stored.events)) return cloneJson(stored);
  return {
    version: "1.0",
    requirement_id: requirement.requirement.id,
    platform_id: requirement.requirement.platform,
    updated_at: new Date().toISOString(),
    events: [],
  };
}

function mockAppendActivity(
  rootPath: string,
  platformPath: string,
  requirement: RequirementMeta,
  input: RequirementActivityInput,
): RequirementActivityEvent {
  const doc = mockReadActivity(rootPath, platformPath, requirement);
  const event: RequirementActivityEvent = {
    id: `act-${Date.now()}-${doc.events.length + 1}`,
    occurred_at: new Date().toISOString(),
    action: input.action.trim(),
    actor: input.actor?.trim() || "user",
    summary: (input.summary || "").trim().slice(0, 300),
    from_stage: input.from_stage ?? null,
    to_stage: input.to_stage ?? null,
    object_id: input.object_id ?? null,
    refs: (input.refs || []).map((ref) => ref.trim()).filter(Boolean),
  };
  doc.events.push(event);
  doc.updated_at = event.occurred_at;
  mockJsonFiles.set(mockActivityPath(rootPath, platformPath, requirement.requirement.id), doc);
  return cloneJson(event);
}

function mockFindRequirement(rootPath: string, platformPath: string, requirementId: string): { requirements: RequirementMeta[]; index: number } {
  const requirements = mockRequirements.get(mockRequirementKey(rootPath, platformPath)) || [];
  return { requirements, index: requirements.findIndex((item) => item.requirement.id === requirementId) };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mockTaskKey(rootPath: string): string {
  return normalizePathForStorage(rootPath);
}

function workspacePlatformPath(config: WorkspaceConfig, platformId: string): string {
  return config.platforms.find((platform) => platform.id === platformId)?.path || "";
}

function mockTaskDispatch(task: AiTaskInfo, rootPath: string): string {
  const inputs = task.input_files.length
    ? task.input_files.map((file) => `- \`${file.path}\`（${file.role}，SHA256：\`${file.fingerprint}\`）`).join("\n")
    : "- （未指定额外输入文件）";
  const knowledge = task.knowledge_scope.length
    ? task.knowledge_scope.map((scope) => `- ${scope.scope}${scope.platform ? `（${scope.platform}）` : ""}`).join("\n")
    : "- （未指定知识范围）";
  return [
    "# 白泽 AI任务",
    "",
    `工作区：${rootPath}`,
    `任务目录：${task.task_dir}`,
    `任务类型：${task.task_type}`,
    `平台：${task.platform_id}`,
    `需求：${task.requirement_id}`,
    "",
    "## 目标",
    "",
    task.objective,
    "",
    "## 完成标准",
    "",
    task.acceptance_criteria.map((item) => `- ${item}`).join("\n"),
    "",
    "## 输入文件",
    "",
    inputs,
    "",
    "## 知识范围",
    "",
    knowledge,
    "",
    "## 写入范围",
    "",
    "允许：",
    task.allowed_paths.map((path) => `- \`${path}\``).join("\n"),
    "禁止：",
    task.forbidden_paths.map((path) => `- \`${path}\``).join("\n"),
    `输出目录：\`${task.output_dir}\``,
    "",
    "开始前更新 progress.json 为 running，完成后更新 progress.json 和 result.json。不要把结果只写在聊天窗口中。",
  ].join("\n");
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    draft: "草稿",
    collecting: "资料收集中",
    analyzing: "需求理解中",
    pending_qa: "待答疑",
    planning: "测试计划中",
    testcase_design: "用例设计中",
    testcase_review: "用例评审中",
    ready_for_test: "待提测",
    testing: "测试执行中",
    pending_report: "待报告",
    completed: "已完成",
    archived: "已归档",
  };
  return labels[stage] || labels.draft;
}

function normalizeRecentWorkspaces(value: unknown): RecentWorkspace[] {
  if (!Array.isArray(value)) return [];
  const result: RecentWorkspace[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || !record.path.trim()) continue;
    const path = normalizePathForStorage(record.path);
    if (result.some((current) => sameStoredPath(current.path, path))) continue;
    result.push({
      path,
      name: typeof record.name === "string" ? record.name : "",
      last_opened_at: typeof record.last_opened_at === "string" ? record.last_opened_at : "",
    });
  }
  return result;
}

function readLocalWorkspaceSession(): WorkspaceSession {
  try {
    const raw = window.localStorage.getItem(LOCAL_SESSION_KEY);
    if (!raw) return { recent_workspaces: [], last_workspace: null };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const last = typeof parsed.last_workspace === "string" && parsed.last_workspace.trim()
      ? normalizePathForStorage(parsed.last_workspace)
      : null;
    return {
      recent_workspaces: normalizeRecentWorkspaces(parsed.recent_workspaces),
      last_workspace: last,
    };
  } catch {
    return { recent_workspaces: [], last_workspace: null };
  }
}

function writeLocalWorkspaceSession(session: WorkspaceSession): void {
  try {
    window.localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(session));
  } catch {
    return;
  }
}

async function readWorkspaceSession(): Promise<WorkspaceSession> {
  if (isTauri) {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load(STORE_FILE);
      const recent = await store.get<unknown>(RECENT_WORKSPACES_KEY);
      const last = await store.get<unknown>(LAST_WORKSPACE_KEY);
      return {
        recent_workspaces: normalizeRecentWorkspaces(recent),
        last_workspace: typeof last === "string" && last.trim() ? normalizePathForStorage(last) : null,
      };
    } catch (error) {
      console.warn("读取工作区偏好失败，将使用浏览器存储作为回退。", error);
    }
  }
  return readLocalWorkspaceSession();
}

async function writeWorkspaceSession(session: WorkspaceSession): Promise<void> {
  if (isTauri) {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load(STORE_FILE);
      await store.set(RECENT_WORKSPACES_KEY, session.recent_workspaces);
      await store.set(LAST_WORKSPACE_KEY, session.last_workspace);
      await store.save();
      return;
    } catch (error) {
      console.warn("保存工作区偏好失败，将使用浏览器存储作为回退。", error);
    }
  }
  writeLocalWorkspaceSession(session);
}

function normalizeClientPreferences(value: unknown): ClientPreferences {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const external = record.external_programs && typeof record.external_programs === "object"
    ? record.external_programs as Record<string, unknown>
    : {};
  const yunxiao = record.yunxiao && typeof record.yunxiao === "object"
    ? record.yunxiao as Record<string, unknown>
    : {};
  const modelProvider = record.model_provider && typeof record.model_provider === "object"
    ? record.model_provider as Record<string, unknown>
    : {};
  const text = (input: unknown, fallback = "") => (typeof input === "string" ? input.trim() : fallback);
  const number = (input: unknown, fallback: number) => (typeof input === "number" && Number.isFinite(input) ? input : fallback);
  return {
    connections: Array.isArray(record.connections) ? record.connections as import("../domain/integrations").Connection[] : undefined,
    integration_defaults: record.integration_defaults as import("../domain/integrations").IntegrationDefaults | undefined,
    auto_open_change_center: typeof record.auto_open_change_center === "boolean" ? record.auto_open_change_center : DEFAULT_CLIENT_PREFERENCES.auto_open_change_center,
    external_programs: {
      git_command: typeof external.git_command === "string" && external.git_command.trim() ? external.git_command.trim() : DEFAULT_CLIENT_PREFERENCES.external_programs.git_command,
      python_command: typeof external.python_command === "string" && external.python_command.trim() ? external.python_command.trim() : DEFAULT_CLIENT_PREFERENCES.external_programs.python_command,
      editor_command: typeof external.editor_command === "string" ? external.editor_command.trim() : DEFAULT_CLIENT_PREFERENCES.external_programs.editor_command,
    },
    yunxiao: {
      enabled: typeof yunxiao.enabled === "boolean" ? yunxiao.enabled : DEFAULT_CLIENT_PREFERENCES.yunxiao.enabled,
      access_token: text(yunxiao.access_token),
      base_url: text(yunxiao.base_url) || DEFAULT_YUNXIAO_BASE_URL,
      organization_id: text(yunxiao.organization_id),
      organization_name: text(yunxiao.organization_name),
      user_id: text(yunxiao.user_id),
      user_name: text(yunxiao.user_name),
      last_verified_at: text(yunxiao.last_verified_at),
    },
    model_provider: {
      enabled: typeof modelProvider.enabled === "boolean" ? modelProvider.enabled : DEFAULT_CLIENT_PREFERENCES.model_provider.enabled,
      base_url: text(modelProvider.base_url),
      api_key: text(modelProvider.api_key),
      model: text(modelProvider.model),
      temperature: number(modelProvider.temperature, DEFAULT_CLIENT_PREFERENCES.model_provider.temperature),
      max_tokens: number(modelProvider.max_tokens, DEFAULT_CLIENT_PREFERENCES.model_provider.max_tokens),
      context_window_tokens: number(modelProvider.context_window_tokens, DEFAULT_CONTEXT_WINDOW_TOKENS),
      compaction_trigger_tokens: number(modelProvider.compaction_trigger_tokens, DEFAULT_COMPACTION_TRIGGER_TOKENS),
      last_verified_at: text(modelProvider.last_verified_at),
    },
  };
}

function readLocalClientPreferences(): ClientPreferences {
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFERENCES_KEY);
    return raw ? normalizeClientPreferences(JSON.parse(raw)) : normalizeClientPreferences(null);
  } catch {
    return normalizeClientPreferences(null);
  }
}

function writeLocalClientPreferences(preferences: ClientPreferences): void {
  try {
    window.localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    return;
  }
}

/// 云效查询响应统一为数组：直接是数组则原样返回，{items: []} / {result:{items:[]}} 则取内层
// 云效元数据内存缓存：项目/成员/工作项类型/字段定义等低频数据，按会话缓存避免每次打开弹窗串行拉取
const yunxiaoCache = new Map<string, { at: number; value: unknown }>();
const YUNXIAO_CACHE_TTL = 5 * 60 * 1000;

async function yunxiaoCached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = yunxiaoCache.get(key);
  if (hit && Date.now() - hit.at < YUNXIAO_CACHE_TTL) return hit.value as T;
  const value = await load();
  yunxiaoCache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidateYunxiaoCache() {
  yunxiaoCache.clear();
}

function asYunxiaoList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["items", "result", "data", "list"]) {
      const inner = record[key];
      if (Array.isArray(inner)) return inner as T[];
      if (inner && typeof inner === "object") {
        const nested = (inner as Record<string, unknown>).items;
        if (Array.isArray(nested)) return nested as T[];
      }
    }
  }
  return [];
}

async function loadClientPreferences(): Promise<ClientPreferences> {
  if (isTauri) {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load(STORE_FILE);
      return normalizeClientPreferences(await store.get<unknown>(CLIENT_PREFERENCES_KEY));
    } catch (error) {
      console.warn("读取客户端偏好失败，将使用浏览器存储作为回退。", error);
    }
  }
  return readLocalClientPreferences();
}

async function saveClientPreferences(preferences: ClientPreferences): Promise<void> {
  const normalized = normalizeClientPreferences(preferences);
  if (isTauri) {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load(STORE_FILE);
      await store.set(CLIENT_PREFERENCES_KEY, normalized);
      await store.save();
      return;
    } catch (error) {
      console.warn("保存客户端偏好失败，将使用浏览器存储作为回退。", error);
    }
  }
  writeLocalClientPreferences(normalized);
}

async function rememberWorkspace(workspace: WorkspaceConfig): Promise<void> {
  const session = await readWorkspaceSession();
  const path = normalizePathForStorage(workspace.workspace.root_path);
  const nextRecord: RecentWorkspace = {
    path,
    name: workspace.workspace.name,
    last_opened_at: new Date().toISOString(),
  };
  const recent = [nextRecord, ...session.recent_workspaces.filter((item) => !sameStoredPath(item.path, path))].slice(0, 10);
  await writeWorkspaceSession({ recent_workspaces: recent, last_workspace: path });
}

async function removeRecentWorkspace(path: string): Promise<void> {
  const session = await readWorkspaceSession();
  const recent = session.recent_workspaces.filter((item) => !sameStoredPath(item.path, path));
  await writeWorkspaceSession({
    recent_workspaces: recent,
    last_workspace: session.last_workspace && sameStoredPath(session.last_workspace, path) ? null : session.last_workspace,
  });
}

function attachWorkspaceMetadata(result: WorkspaceOpenResult): WorkspaceOpenResult {
  return {
    ...result,
    config: {
      ...result.config,
      legacy_directories: result.legacy_directories,
    },
  };
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  let result: T;
  if (isTauri) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    result = await tauriInvoke<T>(cmd, args);
  } else {
    console.warn(`[mock] invoke ${cmd}`, args);
    result = await mockInvoke<T>(cmd, args);
  }
  if (["write_text_file", "write_binary_file", "save_json_file", "save_json_file_if_unchanged", "create_json_file", "create_binary_file", "create_text_file"].includes(cmd) && typeof args?.filePath === "string") invalidateBusinessData([args.filePath]);
  if (["save_requirement", "create_requirement", "accept_ai_task_result", "write_ai_task_outputs"].includes(cmd) && typeof args?.rootPath === "string") invalidateBusinessData([args.rootPath]);
  return result;
}

function mockWorkspaceConfig(rootPath: string): WorkspaceConfig {
  const normalizedRoot = rootPath || MOCK_ROOT;
  if (mockWorkspace && sameStoredPath(mockWorkspace.workspace.root_path, normalizedRoot)) return mockWorkspace;
  const name = normalizedRoot.split(/[\\/]/).filter(Boolean).pop() || "工作区";
  mockWorkspace = {
    version: "1.0",
    workspace: {
      name,
      created_at: "2026-08-28",
      root_path: normalizedRoot,
    },
    directories: {
      projects: "projects",
      templates: "templates",
      knowledge: "knowledge",
      tools: "tools",
      archive: "archive",
      blackbox: ".blackbox",
    },
    defaults: {
      platform_id: null,
      case_template_id: null,
      report_template_id: null,
    },
    watcher: {
      enabled: true,
      debounce_ms: 500,
      ignore_patterns: ["node_modules/*", "target/*", "dist/*", ".git/*", "*.tmp"],
    },
    backup: {
      auto_enabled: true,
      interval_hours: 24,
      max_backups: 10,
      include_cache: false,
    },
    platforms: [],
  };
  return mockWorkspace;
}

// —— BB-16F mock：浏览器开发模式全局搜索（镜像 Rust search_workspace 的行为） ——
function mockSearchScore(query: string, value: string, exact: number, prefix: number, contains: number): number | null {
  if (!value.trim()) return null;
  const lower = value.toLowerCase();
  if (lower === query) return exact;
  if (lower.startsWith(query)) return prefix;
  if (lower.includes(query)) return contains;
  return null;
}

function mockSearchBest(query: string, fields: Array<[string, string, number, number, number]>): { score: number; text: string } | null {
  let best: { score: number; text: string } | null = null;
  for (const [label, value, exact, prefix, contains] of fields) {
    const score = mockSearchScore(query, value, exact, prefix, contains);
    if (score !== null && (!best || score > best.score)) {
      best = { score, text: `${label}：${value.trim()}`.slice(0, 120) };
    }
  }
  return best;
}

const MOCK_SEARCH_STRUCTURED_NAMES = new Set([
  "requirement.yaml", "cases.json", "run.json", "report.json",
  "knowledge.json", "knowledge-candidates.json", "manifest.json", "progress.json", "result.json",
]);

function mockSearchWorkspace(args?: Record<string, unknown>): WorkspaceSearchResult[] {
  const rootPath = normalizePathForStorage((args?.rootPath as string) || MOCK_ROOT);
  const query = String(args?.query || "").trim().toLowerCase();
  const limit = typeof args?.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 200;
  if (!query) return [];
  const config = mockWorkspaceConfig(rootPath);
  const results: WorkspaceSearchResult[] = [];
  const contextRequirementId = String(args?.requirementId || "");
  const contextPlatformId = String(args?.platformId || "");
  const boost = (score: number, platformId: string | null, requirementId: string | null) =>
    score + (contextRequirementId && requirementId === contextRequirementId ? 15 : 0) + (contextPlatformId && platformId === contextPlatformId ? 8 : 0);
  const attribution = (filePath: string): { platformId: string | null; requirementId: string | null } => {
    const requirement = mockRequirementForFile(filePath);
    return requirement
      ? { platformId: requirement.requirement.platform, requirementId: requirement.requirement.id }
      : { platformId: null, requirementId: null };
  };

  // 需求：requirement.yaml 中的编号、名称、负责人
  for (const [key, requirements] of mockRequirements.entries()) {
    const separator = key.indexOf("::");
    if (separator < 0 || key.slice(0, separator) !== rootPath) continue;
    const platformPath = key.slice(separator + 2);
    const platform = config.platforms.find((item) => item.path === platformPath);
    for (const meta of requirements) {
      const hit = mockSearchBest(query, [
        ["需求编号", meta.requirement.id, 100, 85, 65],
        ["需求名称", meta.requirement.name, 90, 70, 50],
        ["负责人", meta.requirement.owner, 50, 40, 30],
        ["当前阶段", meta.status, 40, 30, 20],
      ]);
      if (!hit) continue;
      results.push({
        result_type: "requirement",
        title: meta.requirement.id,
        subtitle: [platform?.name || platformPath, meta.requirement.name, meta.status].filter(Boolean).join(" · "),
        path: joinPath(rootPath, platformPath, meta.requirement.id),
        platform_id: platform?.id || null,
        requirement_id: meta.requirement.id,
        object_id: meta.requirement.id,
        matched_text: hit.text,
        scope: null,
        is_directory: false,
        score: boost(hit.score, platform?.id || null, meta.requirement.id),
      });
    }
  }

  // AI任务：task_id、类型、目标、状态
  for (const task of mockTasks.get(mockTaskKey(rootPath)) || []) {
    const hit = mockSearchBest(query, [
      ["任务ID", task.task_id, 100, 82, 60],
      ["任务目标", task.objective, 80, 60, 40],
      ["任务类型", task.task_type, 60, 45, 30],
      ["任务状态", task.status, 40, 30, 20],
    ]);
    if (!hit) continue;
    results.push({
      result_type: "ai_task",
      title: task.task_id,
      subtitle: [task.task_type, task.status, `${task.platform_id}/${task.requirement_id}`].filter((part) => part.trim()).join(" · "),
      path: joinPath(rootPath, task.task_dir),
      platform_id: task.platform_id || null,
      requirement_id: task.requirement_id || null,
      object_id: task.task_id,
      matched_text: hit.text,
      scope: null,
      is_directory: false,
      score: boost(hit.score, task.platform_id || null, task.requirement_id || null),
    });
  }

  // 文件名与相对路径匹配（mock 文件与目录）
  const filePaths = new Set<string>();
  [...mockTextFiles.keys(), ...mockJsonFiles.keys(), ...mockBinaryFiles.keys()].forEach((path) => filePaths.add(path));
  for (const path of filePaths) {
    if (!path.startsWith(`${rootPath}/`)) continue;
    const relative = path.slice(rootPath.length + 1);
    const name = relative.split("/").pop() || relative;
    const hit = mockSearchBest(query, [
      ["文件名", name, 90, 70, 50],
      ["路径", relative, 60, 35, 25],
    ]);
    if (!hit) continue;
    const owner = attribution(path);
    results.push({
      result_type: "file",
      title: name,
      subtitle: relative,
      path,
      platform_id: owner.platformId,
      requirement_id: owner.requirementId,
      object_id: null,
      matched_text: hit.text,
      scope: null,
      is_directory: false,
      score: boost(hit.score, owner.platformId, owner.requirementId),
    });
  }
  for (const dir of mockDirectories) {
    if (!dir.startsWith(`${rootPath}/`)) continue;
    const relative = dir.slice(rootPath.length + 1);
    const name = relative.split("/").pop() || relative;
    const hit = mockSearchBest(query, [
      ["目录名", name, 90, 70, 50],
      ["路径", relative, 60, 35, 25],
    ]);
    if (!hit) continue;
    const owner = attribution(dir);
    results.push({
      result_type: "file",
      title: name,
      subtitle: relative,
      path: dir,
      platform_id: owner.platformId,
      requirement_id: owner.requirementId,
      object_id: null,
      matched_text: hit.text,
      scope: null,
      is_directory: true,
      score: boost(hit.score, owner.platformId, owner.requirementId),
    });
  }

  // 结构化对象：cases.json / run.json / report.json / knowledge 注册表
  for (const [path, value] of mockJsonFiles.entries()) {
    if (!path.startsWith(`${rootPath}/`)) continue;
    const name = path.split("/").pop() || "";
    const owner = attribution(path);
    const record = value && typeof value === "object" ? value as Record<string, any> : null;
    if (!record) continue;
    if (name === "cases.json" && Array.isArray(record.cases)) {
      const dirTitles = new Map<string, string>();
      const walkTree = (node: any) => {
        if (node && typeof node === "object") {
          if (typeof node.id === "string") dirTitles.set(node.id, typeof node.title === "string" ? node.title : "");
          (Array.isArray(node.children) ? node.children : []).forEach(walkTree);
        }
      };
      walkTree(record.tree);
      for (const item of record.cases as any[]) {
        const caseId = String(item?.id || "");
        const title = String(item?.title || "");
        const hit = mockSearchBest(query, [
          ["用例ID", caseId, 100, 85, 60],
          ["用例标题", title, 90, 72, 52],
          ["标签", (item?.tags || []).join(" "), 55, 45, 35],
          ["需求点", (item?.requirement_refs || []).join(" "), 45, 35, 25],
          ["测试类型", String(item?.test_type || ""), 40, 30, 20],
        ]);
        if (!hit) continue;
        results.push({
          result_type: "case",
          title,
          subtitle: [owner.requirementId || "", `P${item?.priority ?? 1}`, String(item?.test_type || ""), dirTitles.get(String(item?.directory_id || "")) || ""].filter(Boolean).join(" · "),
          path,
          platform_id: owner.platformId,
          requirement_id: owner.requirementId,
          object_id: caseId,
          matched_text: hit.text,
          scope: null,
          is_directory: false,
          score: boost(hit.score, owner.platformId, owner.requirementId),
        });
      }
    } else if (name === "run.json") {
      const hit = mockSearchBest(query, [
        ["轮次ID", String(record.run_id || ""), 100, 80, 60],
        ["轮次名称", String(record.name || ""), 90, 70, 50],
        ["测试环境", String(record.environment || ""), 50, 40, 30],
        ["执行人", String(record.executor || ""), 50, 40, 30],
      ]);
      if (hit) {
        results.push({
          result_type: "run",
          title: String(record.name || record.run_id || name),
          subtitle: [owner.requirementId || "", String(record.environment || ""), String(record.executor || "")].filter(Boolean).join(" · "),
          path,
          platform_id: owner.platformId,
          requirement_id: owner.requirementId,
          object_id: String(record.run_id || path.split("/").slice(-2, -1)[0] || ""),
          matched_text: hit.text,
          scope: null,
          is_directory: false,
          score: boost(hit.score, owner.platformId, owner.requirementId),
        });
      }
    } else if (name === "report.json") {
      const outputName = String(record.output_path || "").split(/[\\/]/).pop() || "";
      const hit = mockSearchBest(query, [
        ["报告ID", String(record.report_id || ""), 100, 80, 60],
        ["输出文件", outputName, 90, 70, 50],
        ["关联轮次", String(record.run_id || ""), 60, 45, 30],
      ]);
      if (hit) {
        results.push({
          result_type: "report",
          title: outputName || String(record.report_id || "报告"),
          subtitle: [owner.requirementId || "", String(record.report_id || "")].filter(Boolean).join(" · "),
          path,
          platform_id: owner.platformId,
          requirement_id: owner.requirementId,
          object_id: String(record.report_id || ""),
          matched_text: hit.text,
          scope: null,
          is_directory: false,
          score: boost(hit.score, owner.platformId, owner.requirementId),
        });
      }
    } else if (name === "knowledge.json" || name === "knowledge-candidates.json") {
      const items = (record.items || record.candidates || []) as any[];
      for (const item of items) {
        const itemId = String(item?.id || "");
        const title = String(item?.title || "");
        const hit = mockSearchBest(query, [
          ["知识ID", itemId, 95, 75, 55],
          ["知识标题", title, 90, 70, 50],
          ["标签", (item?.tags || []).join(" "), 55, 45, 35],
          ["正文", String(item?.body || ""), 0, 0, 25],
        ]);
        if (!hit) continue;
        results.push({
          result_type: "knowledge",
          title,
          subtitle: [String(item?.knowledge_type || ""), String(item?.status || ""), String(item?.requirement_id || owner.requirementId || "")].filter(Boolean).join(" · "),
          path,
          platform_id: item?.platform_id || owner.platformId,
          requirement_id: item?.requirement_id || owner.requirementId,
          object_id: itemId,
          matched_text: hit.text,
          scope: typeof item?.scope === "string" ? item.scope : null,
          is_directory: false,
          score: boost(hit.score, item?.platform_id || owner.platformId, item?.requirement_id || owner.requirementId),
        });
      }
    } else if (!MOCK_SEARCH_STRUCTURED_NAMES.has(name)) {
      // 非结构化 JSON 允许按内容命中
      const text = JSON.stringify(record);
      if (text.toLowerCase().includes(query)) {
        results.push({
          result_type: "file",
          title: name,
          subtitle: path.slice(rootPath.length + 1),
          path,
          platform_id: owner.platformId,
          requirement_id: owner.requirementId,
          object_id: null,
          matched_text: "内容匹配",
          scope: null,
          is_directory: false,
          score: boost(20, owner.platformId, owner.requirementId),
        });
      }
    }
  }

  // 文本内容匹配
  for (const [path, content] of mockTextFiles.entries()) {
    if (!path.startsWith(`${rootPath}/`)) continue;
    const name = path.split("/").pop() || "";
    if (MOCK_SEARCH_STRUCTURED_NAMES.has(name)) continue;
    if (!content.toLowerCase().includes(query)) continue;
    const owner = attribution(path);
    const lineIndex = content.split("\n").findIndex((line) => line.toLowerCase().includes(query));
    const line = lineIndex >= 0 ? `L${lineIndex + 1} ${content.split("\n")[lineIndex].trim()}` : "内容匹配";
    results.push({
      result_type: "file",
      title: name,
      subtitle: path.slice(rootPath.length + 1),
      path,
      platform_id: owner.platformId,
      requirement_id: owner.requirementId,
      object_id: null,
      matched_text: line.slice(0, 160),
      scope: null,
      is_directory: false,
      score: boost(20, owner.platformId, owner.requirementId),
    });
  }

  return results.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title)).slice(0, limit);
}

async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "verify_yunxiao_token":
      throw new Error("浏览器开发模式不校验云效令牌，请在桌面客户端中点击“测试连接”");
    case "verify_model_provider":
      throw new Error("浏览器开发模式不校验模型服务，请在桌面客户端中点击“测试连接”");
    case "chat_completion":
      return "（浏览器开发模式）这里会返回模型回复，请在桌面客户端中调用真实模型。" as T;
    case "run_ai_task":
      throw new Error("浏览器开发模式不支持客户端模型执行任务，请在桌面客户端中运行");
    case "write_ai_task_outputs":
      throw new Error("浏览器开发模式不支持写入AI任务产物，请在桌面客户端中运行");
    case "open_workspace": {
      const config = mockWorkspaceConfig((args?.rootPath as string) || (args?.root_path as string) || MOCK_ROOT);
      return { config, initialized: true, legacy_directories: [] } as T;
    }
    case "init_workspace": {
      const config = mockWorkspaceConfig((args?.rootPath as string) || (args?.root_path as string) || MOCK_ROOT);
      config.workspace.name = (args?.name as string) || config.workspace.name;
      return { config, initialized: true, legacy_directories: [] } as T;
    }
    case "save_workspace_config": {
      const config = mockWorkspaceConfig((args?.rootPath as string) || (args?.root_path as string) || MOCK_ROOT);
      const incoming = args?.config as WorkspaceConfig;
      mockWorkspace = {
        ...config,
        ...cloneJson(incoming),
        workspace: { ...config.workspace, ...cloneJson(incoming.workspace) },
      };
      return cloneJson(mockWorkspace) as T;
    }
    case "start_workspace_watcher":
      return false as T;
    case "stop_workspace_watcher":
      return undefined as T;
    case "scan_platforms_cmd": {
      const config = mockWorkspaceConfig((args?.rootPath as string) || (args?.root_path as string) || MOCK_ROOT);
      return config.platforms as T;
    }
    case "create_platform": {
      const config = mockWorkspaceConfig((args?.rootPath as string) || (args?.root_path as string) || MOCK_ROOT);
      const input = args?.input as PlatformDraft;
      if (config.platforms.some((platform) => platform.id === input.id)) throw new Error(`平台 ID 已存在：${input.id}`);
      const timestamp = new Date().toISOString();
      config.platforms = [...config.platforms, { ...input, status: "active", created_at: timestamp, updated_at: timestamp }];
      return config as T;
    }
    case "update_platform": {
      const config = mockWorkspaceConfig((args?.rootPath as string) || (args?.root_path as string) || MOCK_ROOT);
      const platformId = args?.platformId as string;
      const target = config.platforms.find((platform) => platform.id === platformId);
      if (!target) throw new Error(`平台不存在：${platformId}`);
      target.name = args?.name as string;
      target.description = args?.description as string;
      target.status = args?.status as string;
      target.updated_at = new Date().toISOString();
      return config as T;
    }
    case "delete_platform": {
      const config = mockWorkspaceConfig((args?.rootPath as string) || (args?.root_path as string) || MOCK_ROOT);
      const platformId = args?.platformId as string;
      config.platforms = config.platforms.filter((platform) => platform.id !== platformId);
      return config as T;
    }
    case "create_requirement": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformId = args?.platformId as string;
      const input = args?.input as RequirementDraft;
      const config = mockWorkspaceConfig(rootPath);
      const platform = config.platforms.find((item) => item.id === platformId);
      if (!platform) throw new Error(`平台不存在：${platformId}`);
      if (platform.status === "archived") throw new Error("归档平台不能创建新需求");
      const key = mockRequirementKey(rootPath, platform.path);
      const requirements = mockRequirements.get(key) || [];
      if (requirements.some((item) => item.requirement.id === input.id.trim())) {
        throw new Error(`当前平台下需求编号已存在：${input.id.trim()}`);
      }
      const stage = input.initial_stage || "draft";
      const now = new Date().toISOString();
      const requirement: RequirementMeta = {
        version: "1.0",
        requirement: {
          id: input.id.trim(),
          name: input.name.trim(),
          platform: platform.id,
          owner: input.owner.trim(),
          created_at: now,
        },
        status: stageLabel(stage),
        current_stage: stage,
        schedule: {
          planned_test_date: input.planned_test_date || null,
          planned_release_date: input.planned_release_date || null,
          actual_test_date: null,
          actual_release_date: null,
        },
        applications: (input.applications || []).filter((item) => item.name.trim()),
        client_access: {
          mode: "unlocked",
          locked_at: null,
          locked_by: null,
          task_id: null,
          note: "",
          snapshot_path: null,
        },
        stage_checklist: [],
        blockers: [],
        pending_reviews: [],
        next_actions: [],
      };
      mockRequirements.set(key, [...requirements, requirement]);
      // 与 Rust create_requirement 一致：登记标准需求目录树，供资料页/监听浏览
      const requirementDir = normalizePathForStorage(joinPath(rootPath, platform.path, requirement.requirement.id));
      const standardDirs = [
        "01-需求资料/需求文档", "01-需求资料/需求截图",
        "02-需求理解与答疑/attachments", "03-测试计划", "03-测试计划/reviews",
        "04-测试用例/exports", "04-测试用例/reviews", "04-测试用例/versions",
        "05-开发资源/前端", "05-开发资源/后端",
        "06-测试执行与证据", "07-测试报告", "08-知识候选",
      ];
      for (const rel of standardDirs) {
        let current = joinPath(requirementDir, rel);
        while (current && !mockDirectories.has(current)) {
          mockDirectories.add(current);
          const idx = current.lastIndexOf("/");
          if (idx <= 0) break;
          current = current.slice(0, idx);
        }
      }
      mockAppendActivity(rootPath, platform.path, requirement, {
        action: "requirement_created",
        summary: `创建需求 ${requirement.requirement.id}（${requirement.requirement.name}），初始阶段：${stageLabel(stage)}`,
      });
      return cloneRequirement(requirement) as T;
    }
    case "create_ai_task": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const input = args?.input as AiTaskDraft;
      const config = mockWorkspaceConfig(rootPath);
      const platform = config.platforms.find((item) => item.id === input.platform_id);
      if (!platform) throw new Error(`平台不存在：${input.platform_id}`);
      const key = mockRequirementKey(rootPath, platform.path);
      const requirement = (mockRequirements.get(key) || []).find((item) => item.requirement.id === input.requirement_id);
      if (!requirement) throw new Error(`需求不存在：${input.requirement_id}`);
      if (input.lock_requirement && requirement.client_access.mode === "locked_for_ai") {
        throw new Error("需求已锁定，请先完成解锁确认");
      }
      const now = new Date().toISOString();
      const taskId = `task-${Date.now()}`;
      const task: AiTaskInfo = {
        task_id: taskId,
        task_type: input.task_type,
        platform_id: platform.id,
        requirement_id: input.requirement_id,
        status: "pending",
        created_at: now,
        updated_at: now,
        objective: input.objective.trim(),
        acceptance_criteria: input.acceptance_criteria.filter((item) => item.trim()).map((item) => item.trim()),
        task_dir: joinPath(".blackbox", "tasks", taskId),
        input_files: input.input_files.map((item) => ({ path: item.path.trim(), role: item.role.trim() || "任务输入", fingerprint: `mock-${item.path.trim()}` })),
        knowledge_scope: input.knowledge_scope || [],
        allowed_paths: input.allowed_paths,
        forbidden_paths: input.forbidden_paths,
        output_dir: input.output_dir,
        output_schema: input.output_schema || null,
        lock_requirement: input.lock_requirement,
        requirement_locked: input.lock_requirement || requirement.client_access.mode === "locked_for_ai",
        execution_mode: input.execution_mode || "external",
        dispatch_text: "",
        progress: {
          status: "pending",
          updated_at: now,
          message: "任务已创建，等待外部AI执行",
        },
        result: {
          outputs: [],
          summary: "",
          validation: { passed: false, errors: [] },
          pending_items: ["等待外部AI更新 result.json"],
        },
        file_changes: emptyFileChanges(),
        validation: {
          passed: true,
          errors: [],
          warnings: ["浏览器开发模式不读取外部任务目录，文件变化需在Tauri客户端中验证。"],
          out_of_scope_paths: [],
          artifacts: [],
        },
        artifact_count: 0,
        awaiting_confirmation: false,
        review_status: "pending",
        review_note: "",
      };
      task.dispatch_text = mockTaskDispatch(task, rootPath);
      const tasks = mockTasks.get(mockTaskKey(rootPath)) || [];
      mockTasks.set(mockTaskKey(rootPath), [task, ...tasks]);
      // 登记任务目录，保证全局搜索结果的 get_path_info 存在性校验通过
      mockDirectories.add(normalizePathForStorage(joinPath(rootPath, task.task_dir)));
      mockAppendActivity(rootPath, platform.path, requirement, {
        action: "ai_task_created",
        summary: `创建AI任务 ${taskId}（${input.task_type}）`,
        object_id: taskId,
        refs: [`${task.task_dir}/task.md`],
      });
      if (input.lock_requirement) {
        const requirements = mockRequirements.get(key) || [];
        const index = requirements.findIndex((item) => item.requirement.id === input.requirement_id);
        if (index >= 0) {
          const next = [...requirements];
          next[index] = {
            ...cloneRequirement(requirements[index]),
            client_access: {
              mode: "locked_for_ai",
              locked_at: now,
              locked_by: "用户",
              task_id: taskId,
              note: input.objective.trim(),
              snapshot_path: `.blackbox/snapshots/mock-${Date.now()}.json`,
            },
          };
          mockRequirements.set(key, next);
        }
      }
      return JSON.parse(JSON.stringify(task)) as T;
    }
    case "list_ai_tasks": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      return (mockTasks.get(mockTaskKey(rootPath)) || []).map((task) => JSON.parse(JSON.stringify(task))) as T;
    }
    case "accept_ai_task_result":
    case "reject_ai_task_result":
    case "accept_and_unlock_ai_task":
    case "redispatch_ai_task": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const taskId = args?.taskId as string;
      const tasks = mockTasks.get(mockTaskKey(rootPath)) || [];
      const index = tasks.findIndex((item) => item.task_id === taskId);
      if (index < 0) throw new Error(`AI任务不存在：${taskId}`);
      const current = tasks[index];
      const now = new Date().toISOString();
      if (cmd !== "redispatch_ai_task" && !current.validation.passed) {
        throw new Error(`结果校验未通过，不能确认：${current.validation.errors.join("；") || "请先修复校验问题"}`);
      }
      if (cmd === "redispatch_ai_task") {
        const retryId = `task-${Date.now()}-retry`;
        const retry: AiTaskInfo = JSON.parse(JSON.stringify({
          ...current,
          task_id: retryId,
          task_dir: joinPath(".blackbox", "tasks", retryId),
          status: "pending",
          created_at: now,
          updated_at: now,
          progress: { status: "pending", updated_at: now, message: "任务已重新派发，等待外部AI执行" },
          result: { outputs: [], summary: "", validation: { passed: false, errors: [] }, pending_items: ["等待外部AI更新 result.json"] },
          file_changes: emptyFileChanges(),
          validation: { passed: true, errors: [], warnings: ["浏览器开发模式不读取外部任务目录。"], out_of_scope_paths: [], artifacts: [] },
          artifact_count: 0,
          awaiting_confirmation: false,
          review_status: "pending",
          review_note: "",
        })) as AiTaskInfo;
        retry.dispatch_text = mockTaskDispatch(retry, rootPath);
        const nextTasks = [retry, ...tasks];
        mockTasks.set(mockTaskKey(rootPath), nextTasks);
        mockDirectories.add(normalizePathForStorage(joinPath(rootPath, retry.task_dir)));
        const requirementKey = mockRequirementKey(rootPath, workspacePlatformPath(mockWorkspaceConfig(rootPath), current.platform_id));
        const requirements = mockRequirements.get(requirementKey) || [];
        const requirementIndex = requirements.findIndex((item) => item.requirement.id === current.requirement_id);
        let requirement: RequirementMeta | null = requirementIndex >= 0 ? cloneRequirement(requirements[requirementIndex]) : null;
        if (requirement?.client_access.mode === "locked_for_ai" && requirement.client_access.task_id === current.task_id) {
          const nextRequirements = [...requirements];
          nextRequirements[requirementIndex] = {
            ...requirement,
            client_access: { ...requirement.client_access, task_id: retry.task_id, locked_at: now },
          };
          mockRequirements.set(requirementKey, nextRequirements);
          requirement = cloneRequirement(nextRequirements[requirementIndex]);
          retry.requirement_locked = true;
        }
        if (requirement) {
          mockAppendActivity(rootPath, workspacePlatformPath(mockWorkspaceConfig(rootPath), current.platform_id), requirement, {
            action: "ai_task_redispatched",
            summary: `重新派发AI任务 ${retry.task_id}（原任务 ${current.task_id}）`,
            object_id: retry.task_id,
          });
        }
        return { task: JSON.parse(JSON.stringify(retry)), requirement, warnings: [] } as T;
      }
      const accepted = cmd === "accept_ai_task_result" || cmd === "accept_and_unlock_ai_task";
      const nextTask: AiTaskInfo = {
        ...current,
        status: accepted ? "completed" : "failed",
        updated_at: now,
        progress: { ...current.progress, status: accepted ? "completed" : "failed", updated_at: now, message: accepted ? "结果已由用户确认" : "结果已拒绝，需求保持锁定" },
        awaiting_confirmation: false,
        review_status: accepted ? "accepted" : "rejected",
        review_note: accepted ? "" : "结果被拒绝并保持需求锁定",
      };
      const nextTasks = [...tasks];
      nextTasks[index] = nextTask;
      mockTasks.set(mockTaskKey(rootPath), nextTasks);
      const requirementKey = mockRequirementKey(rootPath, workspacePlatformPath(mockWorkspaceConfig(rootPath), current.platform_id));
      const requirements = mockRequirements.get(requirementKey) || [];
      const requirementIndex = requirements.findIndex((item) => item.requirement.id === current.requirement_id);
      let requirement: RequirementMeta | null = requirementIndex >= 0 ? cloneRequirement(requirements[requirementIndex]) : null;
      if (cmd === "accept_and_unlock_ai_task" && requirement?.client_access.mode === "locked_for_ai") {
        const nextRequirements = [...requirements];
        nextRequirements[requirementIndex] = { ...requirement, client_access: { mode: "unlocked", locked_at: null, locked_by: null, task_id: null, note: "", snapshot_path: null } };
        mockRequirements.set(requirementKey, nextRequirements);
        requirement = cloneRequirement(nextRequirements[requirementIndex]);
      }
      if (requirement) {
        mockAppendActivity(rootPath, workspacePlatformPath(mockWorkspaceConfig(rootPath), current.platform_id), requirement, {
          action: accepted ? "ai_task_accepted" : "ai_task_rejected",
          summary: accepted
            ? `接受AI任务结果（${taskId}）${cmd === "accept_and_unlock_ai_task" ? "并解锁" : ""}`
            : `拒绝AI任务结果（${taskId}），需求保持锁定`,
          object_id: taskId,
        });
        if (cmd === "accept_and_unlock_ai_task") {
          mockAppendActivity(rootPath, workspacePlatformPath(mockWorkspaceConfig(rootPath), current.platform_id), requirement, {
            action: "requirement_unlocked",
            summary: `接受AI任务结果并解锁（任务：${taskId}）`,
            object_id: taskId,
          });
        }
      }
      return { task: JSON.parse(JSON.stringify(nextTask)), requirement, warnings: [] } as T;
    }
    case "scan_requirements": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      mockWorkspaceConfig(rootPath);
      const requirements = mockRequirements.get(mockRequirementKey(rootPath, platformPath)) || [];
      return requirements.map(cloneRequirement) as T;
    }
    case "scan_test_assets":
      // 浏览器开发模式不扫描真实工作区目录
      return [] as T;
    case "read_requirement": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      const requirementId = args?.requirementId as string;
      const requirement = (mockRequirements.get(mockRequirementKey(rootPath, platformPath)) || [])
        .find((item) => item.requirement.id === requirementId);
      if (!requirement) throw new Error(`需求不存在：${requirementId}`);
      return cloneRequirement(requirement) as T;
    }
    case "save_requirement": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      const meta = args?.meta as RequirementMeta;
      const key = mockRequirementKey(rootPath, platformPath);
      const requirements = mockRequirements.get(key) || [];
      const index = requirements.findIndex((item) => item.requirement.id === (args?.requirementId as string));
      if (index < 0) throw new Error(`需求不存在：${args?.requirementId as string}`);
      const existing = requirements[index];
      if (existing.client_access.mode === "locked_for_ai") {
        throw new Error(`需求目录已锁定，客户端禁止写入（任务：${existing.client_access.task_id || "未关联任务"}）`);
      }
      if (JSON.stringify(existing.client_access) !== JSON.stringify(meta.client_access)) {
        throw new Error("需求锁状态只能通过锁定或解锁确认命令修改");
      }
      const next = [...requirements];
      next[index] = cloneRequirement(meta);
      mockRequirements.set(key, next);
      return undefined as T;
    }
    case "lock_requirement": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      const requirementId = args?.requirementId as string;
      const key = mockRequirementKey(rootPath, platformPath);
      const requirements = mockRequirements.get(key) || [];
      const index = requirements.findIndex((item) => item.requirement.id === requirementId);
      if (index < 0) throw new Error(`需求不存在：${requirementId}`);
      const existing = requirements[index];
      if (existing.client_access.mode === "locked_for_ai") throw new Error("需求已锁定，请先完成解锁确认");
      const next = [...requirements];
      next[index] = {
        ...cloneRequirement(existing),
        client_access: {
          mode: "locked_for_ai",
          locked_at: new Date().toISOString(),
          locked_by: (args?.user as string) || "用户",
          task_id: ((args?.taskId as string) || "").trim(),
          note: ((args?.note as string) || "").trim(),
          snapshot_path: `.blackbox/snapshots/mock-${Date.now()}.json`,
        },
      };
      if (!next[index].client_access.task_id) throw new Error("AI任务ID不能为空");
      mockRequirements.set(key, next);
      mockAppendActivity(rootPath, platformPath, next[index], {
        action: "requirement_locked",
        actor: (args?.user as string) || "user",
        summary: `锁定需求目录，交由AI任务处理（${next[index].client_access.task_id}）`,
        object_id: next[index].client_access.task_id,
      });
      return cloneRequirement(next[index]) as T;
    }
    case "scan_requirement_changes": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      const requirementId = args?.requirementId as string;
      const requirements = mockRequirements.get(mockRequirementKey(rootPath, platformPath)) || [];
      const requirement = requirements.find((item) => item.requirement.id === requirementId);
      if (!requirement) throw new Error(`需求不存在：${requirementId}`);
      if (requirement.client_access.mode !== "locked_for_ai") throw new Error("需求未锁定");
      return { requirement: cloneRequirement(requirement), changes: emptyFileChanges(), warnings: [], scanned_at: new Date().toISOString() } as T;
    }
    case "accept_unlock_requirement":
    case "force_unlock_requirement": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      const requirementId = args?.requirementId as string;
      const key = mockRequirementKey(rootPath, platformPath);
      const requirements = mockRequirements.get(key) || [];
      const index = requirements.findIndex((item) => item.requirement.id === requirementId);
      if (index < 0) throw new Error(`需求不存在：${requirementId}`);
      const existing = requirements[index];
      if (existing.client_access.mode !== "locked_for_ai") throw new Error("需求未锁定");
      const action = cmd === "accept_unlock_requirement" ? "accepted" : "forced";
      const next = [...requirements];
      next[index] = { ...cloneRequirement(existing), client_access: { mode: "unlocked", locked_at: null, locked_by: null, task_id: null, note: "", snapshot_path: null } };
      mockRequirements.set(key, next);
      mockAppendActivity(rootPath, platformPath, next[index], {
        action: "requirement_unlocked",
        summary: action === "accepted" ? "接受外部产物并解锁" : `强制解锁（原因：${(args?.reason as string) || "未填写"}）`,
        object_id: existing.client_access.task_id,
      });
      return { requirement: cloneRequirement(next[index]), changes: emptyFileChanges(), warnings: action === "forced" ? ["此次解锁由用户强制执行，未逐项校验外部产物。"] : [], action } as T;
    }
    case "transition_requirement_stage": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      const requirementId = args?.requirementId as string;
      const key = mockRequirementKey(rootPath, platformPath);
      const { requirements, index } = mockFindRequirement(rootPath, platformPath, requirementId);
      if (index < 0) throw new Error(`需求不存在：${requirementId}`);
      const meta = cloneRequirement(requirements[index]);
      if (meta.client_access.mode === "locked_for_ai") {
        throw new Error(`需求目录已锁定，客户端不能调整阶段（任务：${meta.client_access.task_id || "未关联任务"}）`);
      }
      const currentIndex = STAGE_ORDER.indexOf(meta.current_stage);
      if (currentIndex < 0) throw new Error(`需求当前阶段不可识别：${meta.current_stage}`);
      const transition = args?.action as StageTransitionAction;
      const reason = String(args?.reason || "").trim();
      const note = String(args?.note || "").trim();
      let toStage = meta.current_stage;
      let summary = "";
      let actionLabel = "";
      if (transition === "advance") {
        const next = STAGE_ORDER[currentIndex + 1] || "archived";
        if (next === "archived") throw new Error("已是最后业务阶段；如需归档请使用归档动作");
        toStage = next;
        summary = `推进阶段：${stageLabel(meta.current_stage)} → ${stageLabel(next)}`;
        actionLabel = "stage_advance";
      } else if (transition === "retreat") {
        if (meta.current_stage === "archived") throw new Error("已归档需求请使用恢复动作");
        if (currentIndex === 0) throw new Error("已是首个阶段，无法继续退回");
        if (!reason) throw new Error("退回阶段必须填写原因");
        toStage = STAGE_ORDER[currentIndex - 1];
        summary = `退回阶段：${stageLabel(meta.current_stage)} → ${stageLabel(toStage)}（原因：${reason}）`;
        actionLabel = "stage_retreat";
      } else if (transition === "archive") {
        if (meta.current_stage === "archived") throw new Error("需求已归档");
        toStage = "archived";
        summary = `归档需求（原阶段：${stageLabel(meta.current_stage)}）`;
        actionLabel = "stage_archive";
      } else if (transition === "restore") {
        if (meta.current_stage !== "archived") throw new Error("需求未归档");
        const doc = mockReadActivity(rootPath, platformPath, meta);
        const lastArchive = [...doc.events].reverse().find((event) => event.action === "stage_archive");
        toStage = lastArchive?.from_stage || "completed";
        summary = `恢复需求：已归档 → ${stageLabel(toStage)}`;
        actionLabel = "stage_restore";
      } else {
        throw new Error(`不支持的阶段动作：${String(transition)}`);
      }
      const fromStage = meta.current_stage;
      meta.current_stage = toStage;
      meta.status = stageLabel(toStage);
      const next = [...requirements];
      next[index] = meta;
      mockRequirements.set(key, next);
      mockAppendActivity(rootPath, platformPath, meta, {
        action: actionLabel,
        summary: note ? `${summary}；备注：${note}` : summary,
        from_stage: fromStage,
        to_stage: toStage,
      });
      return cloneRequirement(meta) as T;
    }
    case "append_requirement_activity": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      const requirementId = args?.requirementId as string;
      const { index } = mockFindRequirement(rootPath, platformPath, requirementId);
      if (index < 0) throw new Error(`需求不存在：${requirementId}`);
      const requirement = (mockRequirements.get(mockRequirementKey(rootPath, platformPath)) || [])[index];
      const event = args?.event as RequirementActivityInput;
      if (!event?.action?.trim()) throw new Error("活动事件类型不能为空");
      return mockAppendActivity(rootPath, platformPath, requirement, event) as T;
    }
    case "read_requirement_activity": {
      const rootPath = (args?.rootPath as string) || MOCK_ROOT;
      const platformPath = args?.platformPath as string;
      const requirementId = args?.requirementId as string;
      const { index } = mockFindRequirement(rootPath, platformPath, requirementId);
      if (index < 0) throw new Error(`需求不存在：${requirementId}`);
      const requirement = (mockRequirements.get(mockRequirementKey(rootPath, platformPath)) || [])[index];
      return mockReadActivity(rootPath, platformPath, requirement) as T;
    }
    case "create_directory": {
      const dirPath = (args?.dirPath as string) || "";
      ensureMockClientWriteAllowed(dirPath);
      // 与 Rust create_dir_all 一致：补登记所有祖先目录，保证 get_path_info/list_directory 一致
      let current = normalizePathForStorage(dirPath);
      while (current && !mockDirectories.has(current)) {
        mockDirectories.add(current);
        const idx = current.lastIndexOf("/");
        if (idx <= 0) break;
        current = current.slice(0, idx);
      }
      return undefined as T;
    }
    case "read_case_revision_files": {
      const paths = args?.filePaths as string[];
      return await Promise.all(paths.map((filePath) => mockInvoke<number[]>("read_binary_file", { filePath }))) as T;
    }
    case "read_binary_file": {
      const filePath = normalizePathForStorage((args?.filePath as string) || "");
      const content = mockBinaryFiles.get(filePath) || (mockJsonFiles.has(filePath)
        ? new TextEncoder().encode(JSON.stringify(mockJsonFiles.get(filePath), null, 2))
        : mockTextFiles.has(filePath) ? new TextEncoder().encode(mockTextFiles.get(filePath)) : undefined);
      if (!content) throw new Error(`文件不存在：${filePath}`);
      return Array.from(content) as T;
    }
    case "write_binary_file": {
      const filePath = (args?.filePath as string) || "";
      ensureMockClientWriteAllowed(filePath);
      mockBinaryFiles.set(normalizePathForStorage(filePath), new Uint8Array((args?.content as number[]) || []));
      return undefined as T;
    }
    case "create_binary_file": {
      const filePath = (args?.filePath as string) || "";
      ensureMockClientWriteAllowed(filePath);
      const key = normalizePathForStorage(filePath);
      if (mockBinaryFiles.has(key)) throw new Error(`目标二进制文件已存在：${filePath}`);
      mockBinaryFiles.set(key, new Uint8Array((args?.content as number[]) || []));
      return undefined as T;
    }
    case "write_text_file": {
      const filePath = (args?.filePath as string) || "";
      ensureMockClientWriteAllowed(filePath);
      mockTextFiles.set(normalizePathForStorage(filePath), String(args?.content || ""));
      return undefined as T;
    }
    case "commit_case_revision": {
      const writes = args?.writes as import("./caseRevision").RevisionWrite[];
      const conflicts: string[] = [];
      for (const write of writes) {
        ensureMockClientWriteAllowed(write.path);
        const key = normalizePathForStorage(write.path);
        const old = mockBinaryFiles.get(key) || (mockJsonFiles.has(key) ? new TextEncoder().encode(JSON.stringify(mockJsonFiles.get(key), null, 2)) : mockTextFiles.has(key) ? new TextEncoder().encode(mockTextFiles.get(key)) : null);
        if (JSON.stringify(old ? Array.from(old) : null) !== JSON.stringify(write.expected)) conflicts.push(write.path);
      }
      if (conflicts.length) return { applied: false, failed: [], conflicts, changed_paths: [] } as T;
      for (const write of writes) {
        const key = normalizePathForStorage(write.path);
        const bytes = new Uint8Array(write.content);
        if (key.endsWith(".json")) { mockJsonFiles.set(key, JSON.parse(new TextDecoder().decode(bytes))); mockBinaryFiles.delete(key); }
        else if (key.endsWith(".md")) mockTextFiles.set(key, new TextDecoder().decode(bytes));
        else mockBinaryFiles.set(key, bytes);
      }
      return { applied: true, failed: [], conflicts: [], changed_paths: writes.map((w) => w.path) } as T;
    }
    case "save_json_file_if_unchanged": {
      const filePath = String(args?.filePath || "");
      ensureMockClientWriteAllowed(filePath);
      const key = normalizePathForStorage(filePath);
      if (JSON.stringify(mockJsonFiles.get(key) ?? null) !== JSON.stringify(args?.expectedJson ?? null)) throw new Error("磁盘已有新版本，请合并后保存；草稿保留");
      mockJsonFiles.set(key, cloneJson(args?.data));
      return undefined as T;
    }
    case "save_json_file": {
      const filePath = (args?.filePath as string) || "";
      ensureMockClientWriteAllowed(filePath);
      mockJsonFiles.set(normalizePathForStorage(filePath), cloneJson(args?.data));
      return undefined as T;
    }
    case "create_json_file": {
      const filePath = (args?.filePath as string) || "";
      ensureMockClientWriteAllowed(filePath);
      const key = normalizePathForStorage(filePath);
      if (mockJsonFiles.has(key)) throw new Error(`目标JSON文件已存在：${filePath}`);
      mockJsonFiles.set(key, cloneJson(args?.data));
      return undefined as T;
    }
    case "read_json_file": {
      const filePath = (args?.filePath as string) || "";
      const key = normalizePathForStorage(filePath);
      if (!mockJsonFiles.has(key)) throw new Error(`文件不存在：${filePath}`);
      return cloneJson(mockJsonFiles.get(key)) as T;
    }
    case "create_text_file": {
      const filePath = (args?.filePath as string) || "";
      ensureMockNotManagedPath(filePath);
      ensureMockClientWriteAllowed(filePath);
      const key = normalizePathForStorage(filePath);
      if (mockTextFiles.has(key) || mockJsonFiles.has(key) || mockBinaryFiles.has(key)) {
        throw new Error(`目标文件已存在，禁止直接覆盖：${filePath}`);
      }
      mockTextFiles.set(key, String(args?.content || ""));
      return undefined as T;
    }
    case "rename_path": {
      const from = normalizePathForStorage((args?.fromPath as string) || "");
      const to = normalizePathForStorage((args?.toPath as string) || "");
      if (from.split("/").pop() === "requirement.yaml") throw new Error("requirement.yaml 由需求服务管理，不能重命名");
      const fromParent = from.slice(0, Math.max(0, from.lastIndexOf("/")));
      const toParent = to.slice(0, Math.max(0, to.lastIndexOf("/")));
      if (fromParent !== toParent) throw new Error("资料页仅支持同目录重命名");
      const exists = (key: string) => mockTextFiles.has(key) || mockJsonFiles.has(key) || mockBinaryFiles.has(key) || mockDirectories.has(key);
      if (!exists(from)) throw new Error(`目标不存在，无法重命名：${from}`);
      if (exists(to)) throw new Error(`目标已存在，禁止覆盖：${to}`);
      ensureMockNotManagedPath(from);
      ensureMockNotManagedPath(to);
      ensureMockClientWriteAllowed(from);
      ensureMockClientWriteAllowed(to);
      const moveKeys = (map: Map<string, unknown>) => {
        for (const key of [...map.keys()]) {
          if (key === from || key.startsWith(`${from}/`)) {
            map.set(`${to}${key.slice(from.length)}`, map.get(key));
            map.delete(key);
          }
        }
      };
      moveKeys(mockTextFiles as Map<string, unknown>);
      moveKeys(mockJsonFiles);
      moveKeys(mockBinaryFiles);
      const movedDirs = [...mockDirectories].map((dir) => dir === from || dir.startsWith(`${from}/`) ? `${to}${dir.slice(from.length)}` : dir);
      mockDirectories.clear();
      movedDirs.forEach((dir) => mockDirectories.add(dir));
      return undefined as T;
    }
    case "delete_path": {
      const target = normalizePathForStorage((args?.path as string) || "");
      if (target.split("/").pop() === "requirement.yaml") throw new Error("requirement.yaml 由需求服务管理，不能删除");
      ensureMockNotManagedPath(target);
      ensureMockClientWriteAllowed(target);
      const isDir = mockDirectories.has(target);
      const isFile = mockTextFiles.has(target) || mockJsonFiles.has(target) || mockBinaryFiles.has(target);
      if (!isDir && !isFile) throw new Error(`目标不存在：${target}`);
      if (isDir) {
        const hasChildren = [...mockDirectories, ...mockTextFiles.keys(), ...mockJsonFiles.keys(), ...mockBinaryFiles.keys()]
          .some((key) => key.startsWith(`${target}/`));
        if (hasChildren) throw new Error("目录不为空，请先清空后再删除");
        mockDirectories.delete(target);
      } else {
        mockTextFiles.delete(target);
        mockJsonFiles.delete(target);
        mockBinaryFiles.delete(target);
      }
      return undefined as T;
    }
    case "import_files": {
      const dir = normalizePathForStorage((args?.targetDir as string) || "");
      ensureMockNotManagedPath(dir);
      ensureMockClientWriteAllowed(dir);
      mockDirectories.add(dir);
      const sources = (args?.sources as ImportSourceItem[]) || [];
      const fileExists = (key: string) => mockTextFiles.has(key) || mockJsonFiles.has(key) || mockBinaryFiles.has(key);
      const results: ImportResultItem[] = sources.map((item) => {
        const name = item.name.trim();
        const base = { name, source_path: item.source_path, target_path: null as string | null, message: "" };
        if (!name || name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
          return { ...base, status: "failed", message: `文件名包含非法字符：${name}` };
        }
        const source = mockBinaryFiles.get(normalizePathForStorage(item.source_path));
        if (!source) return { ...base, status: "failed", message: `源文件不存在或不是文件：${item.source_path}` };
        let status = "imported";
        let target = joinPath(dir, name);
        if (fileExists(normalizePathForStorage(target))) {
          if (item.strategy === "skip") return { ...base, status: "skipped", message: "同名文件已存在，按策略跳过" };
          if (item.strategy === "overwrite") status = "overwritten";
          else if (item.strategy === "rename") {
            const dot = name.lastIndexOf(".");
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : "";
            for (let index = 2; index < 1000; index += 1) {
              const candidate = joinPath(dir, `${stem} (${index})${ext}`);
              if (!fileExists(normalizePathForStorage(candidate))) { target = candidate; break; }
            }
            status = "renamed";
          } else return { ...base, status: "failed", message: `同名文件已存在，未指定处理策略：${name}` };
        }
        mockBinaryFiles.set(normalizePathForStorage(target), new Uint8Array(source));
        return { ...base, status, target_path: target };
      });
      return results as T;
    }
    case "list_directory": {
      const directoryPath = normalizePathForStorage((args?.dirPath as string) || MOCK_ROOT);
      const entries: DirEntryInfo[] = directoryPath === normalizePathForStorage(MOCK_ROOT)
        ? [
          { name: "requirement", path: joinPath(MOCK_ROOT, "requirement"), is_dir: true, size: 0, modified: "" },
          { name: "testCase", path: joinPath(MOCK_ROOT, "testCase"), is_dir: true, size: 0, modified: "" },
          { name: "APP蓝图.md", path: joinPath(MOCK_ROOT, "APP蓝图.md"), is_dir: false, size: 30000, modified: "" },
        ]
        : [];
      const seen = new Set(entries.map((entry) => normalizePathForStorage(entry.path)));
      for (const dirPath of mockDirectories) {
        const prefix = `${directoryPath}/`;
        if (!dirPath.startsWith(prefix)) continue;
        const remainder = dirPath.slice(prefix.length);
        const [name] = remainder.split("/");
        if (!name) continue;
        const entryPath = joinPath(directoryPath, name);
        if (seen.has(normalizePathForStorage(entryPath))) continue;
        entries.push({ name, path: entryPath, is_dir: true, size: 0, modified: "" });
        seen.add(normalizePathForStorage(entryPath));
      }
      for (const [filePath, value] of mockTextFiles.entries()) {
        const prefix = `${directoryPath}/`;
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        const [name, ...rest] = remainder.split("/");
        if (!name) continue;
        const entryPath = joinPath(directoryPath, name);
        if (seen.has(normalizePathForStorage(entryPath))) continue;
        entries.push({ name, path: entryPath, is_dir: rest.length > 0, size: rest.length ? 0 : value.length, modified: "" });
        seen.add(normalizePathForStorage(entryPath));
      }
      for (const [filePath, value] of mockJsonFiles.entries()) {
        const prefix = `${directoryPath}/`;
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        const [name, ...rest] = remainder.split("/");
        if (!name) continue;
        const entryPath = joinPath(directoryPath, name);
        if (seen.has(normalizePathForStorage(entryPath))) continue;
        entries.push({ name, path: entryPath, is_dir: rest.length > 0, size: rest.length ? 0 : JSON.stringify(value).length, modified: "" });
        seen.add(normalizePathForStorage(entryPath));
      }
      for (const [filePath, value] of mockBinaryFiles.entries()) {
        const prefix = `${directoryPath}/`;
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        const [name, ...rest] = remainder.split("/");
        if (!name) continue;
        const entryPath = joinPath(directoryPath, name);
        if (seen.has(normalizePathForStorage(entryPath))) continue;
        entries.push({ name, path: entryPath, is_dir: rest.length > 0, size: rest.length ? 0 : value.byteLength, modified: "" });
        seen.add(normalizePathForStorage(entryPath));
      }
      return entries as T;
    }
    case "get_path_info": {
      const target = normalizePathForStorage((args?.path as string) || "");
      // 目录存在：已登记，或存在以其为前缀的文件/子目录（隐含父目录）
      const isDirectory = mockDirectories.has(target)
        || [...mockTextFiles.keys(), ...mockJsonFiles.keys(), ...mockBinaryFiles.keys()].some((key) => key.startsWith(`${target}/`));
      const textContent = mockTextFiles.get(target);
      const jsonContent = mockJsonFiles.get(target);
      const binaryContent = mockBinaryFiles.get(target);
      const isFile = textContent !== undefined || jsonContent !== undefined || binaryContent !== undefined;
      const size = textContent !== undefined
        ? textContent.length
        : jsonContent !== undefined
          ? JSON.stringify(jsonContent).length
          : binaryContent?.byteLength || 0;
      return {
        exists: isDirectory || isFile,
        is_file: isFile,
        is_directory: isDirectory,
        size,
        modified: "",
      } as T;
    }
    case "append_workspace_log": {
      const rootPath = mockTaskKey((args?.rootPath as string) || MOCK_ROOT);
      const input = args?.entry as WorkspaceLogInput;
      const record: WorkspaceLogRecord = {
        file: `client-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`,
        line: (mockLogs.get(rootPath) || []).length + 1,
        occurred_at: new Date().toISOString(),
        level: input?.level === "warning" || input?.level === "error" ? input.level : "info",
        module: String(input?.module || "客户端"),
        action: String(input?.action || ""),
        result: String(input?.result || ""),
        detail: String(input?.detail || "").slice(0, 600),
      };
      mockLogs.set(rootPath, [record, ...(mockLogs.get(rootPath) || [])]);
      return undefined as T;
    }
    case "list_workspace_logs": {
      const rootPath = mockTaskKey((args?.rootPath as string) || MOCK_ROOT);
      return { entries: mockLogs.get(rootPath) || [], errors: [] } as T;
    }
    case "search_workspace":
      return mockSearchWorkspace(args) as T;
    case "read_text_file": {
      const filePath = normalizePathForStorage((args?.filePath as string) || "");
      const stored = mockTextFiles.get(filePath);
      if (stored !== undefined) return stored as T;
      if (filePath.endsWith("requirement.yaml")) {
        const requirement = mockRequirementForFile(filePath);
        if (requirement) {
          return [
            "version: \"1.0\"",
            `requirement:`,
            `  id: ${JSON.stringify(requirement.requirement.id)}`,
            `  name: ${JSON.stringify(requirement.requirement.name)}`,
            `  platform: ${JSON.stringify(requirement.requirement.platform)}`,
            `  owner: ${JSON.stringify(requirement.requirement.owner)}`,
            `  created_at: ${JSON.stringify(requirement.requirement.created_at)}`,
          ].join("\n") as T;
        }
      }
      if (filePath.endsWith(".changes.json") || filePath.endsWith(".changes.md")) throw new Error(`文件不存在：${filePath}`);
      return "# 测试Markdown\n\n这是一个**示例**文档。\n\n| 列1 | 列2 |\n|---|---|\n| A | B |\n\n```python\nprint('hello')\n```\n\n![截图](image.png)\n" as T;
    }
    default:
      return {} as T;
  }
}

export const api = {
  openWorkspace: async (rootPath: string) =>
    attachWorkspaceMetadata(await invoke<WorkspaceOpenResult>("open_workspace", { rootPath })),

  initWorkspace: async (rootPath: string, name: string) =>
    attachWorkspaceMetadata(await invoke<WorkspaceOpenResult>("init_workspace", { rootPath, name })),

  loadWorkspaceSession: readWorkspaceSession,
  rememberWorkspace,
  removeRecentWorkspace,
  loadClientPreferences,
  saveClientPreferences,

  // 云效令牌校验：令牌只经客户端本地内存传递，不写入工作区
  integrationCall: <T = unknown>(connection: import("../domain/integrations").Connection, operation: string, args: unknown = {}) => invoke<T>("integration_call", { connection, operation, args }),
  previewPublication: (connection: import("../domain/integrations").Connection, input: import("../domain/integrations").PublicationInput) => invoke<import("../domain/integrations").PublicationPreview>("preview_publication", { connection, input }),
  executePublication: (connection: import("../domain/integrations").Connection, input: import("../domain/integrations").PublicationInput, previewToken: string, archiveIds: string[]) => invoke<import("../domain/integrations").PublicationReceipt>("execute_publication", { connection, input, previewToken, archiveIds }),
  listPublicationHistory: (requirementDir: string, connectionId?: string) => invoke<import("../domain/integrations").PublicationReceipt[]>("list_publication_history", { requirementDir, connectionId: connectionId || null }),
  publicationHistory: (connection: import("../domain/integrations").Connection, input: import("../domain/integrations").PublicationInput) => invoke<import("../domain/integrations").PublicationReceipt[]>("publication_history", { connection, input }),
  reconcilePublication: (connection: import("../domain/integrations").Connection, input: import("../domain/integrations").PublicationInput, caseId: string, externalId: string, note: string) => invoke("reconcile_publication", { connection, input, caseId, externalId, note }),
  previewIntegrationMigration: (requirementDir: string) => invoke<{ rows: unknown[]; fingerprint: string }>("preview_integration_migration", { requirementDir }),
  applyIntegrationMigration: (requirementDir: string, connection: import("../domain/integrations").Connection, expected: string) => invoke("apply_integration_migration", { requirementDir, connection, expected }),
  restoreIntegrationMigration: (requirementDir: string) => invoke("restore_integration_migration", { requirementDir }),
  // Compatibility APIs: only historical callers; new screens use integrationCall.
  verifyYunxiaoToken: (token: string, baseUrl: string) =>
    invoke<YunxiaoIdentity>("verify_yunxiao_token", { token, baseUrl }),

  // 云效查询接口的响应可能是数组，也可能是 { items, totalCount } 分页对象，统一解包
  listYunxiaoProjects: (token: string, baseUrl: string, orgId: string, name?: string) =>
    name
      ? invoke<unknown>("list_yunxiao_projects", { token, baseUrl, orgId, name }).then((v) => asYunxiaoList<YunxiaoProject>(v))
      : yunxiaoCached(`projects:${baseUrl}:${orgId}:${token}`, async () => asYunxiaoList<YunxiaoProject>(await invoke<unknown>("list_yunxiao_projects", { token, baseUrl, orgId }))),

  listYunxiaoSprints: (token: string, baseUrl: string, orgId: string, projectId: string) =>
    yunxiaoCached(`sprints:${baseUrl}:${orgId}:${projectId}:${token}`, async () => asYunxiaoList<YunxiaoSprint>(await invoke<unknown>("list_yunxiao_sprints", { token, baseUrl, orgId, projectId }))),

  listYunxiaoTestPlans: (token: string, baseUrl: string, orgId: string, name?: string, projectId?: string) =>
    invoke<unknown>("list_yunxiao_test_plans", { token, baseUrl, orgId, name, projectId }).then((v) => asYunxiaoList<Record<string, unknown>>(v)),

  createYunxiaoTestPlan: (token: string, baseUrl: string, orgId: string, draft: YunxiaoTestPlanDraft) =>
    invoke<Record<string, unknown>>("create_yunxiao_test_plan", { token, baseUrl, orgId, draft }),

  searchYunxiaoWorkitems: async (
    token: string,
    baseUrl: string,
    orgId: string,
    projectId: string,
    category: string,
    keyword?: string,
    sprintId?: string,
    assignedTo?: string,
    participants?: string[],
    serialNumber?: string,
  ) =>
    asYunxiaoList<YunxiaoWorkItem>(await invoke<unknown>("search_yunxiao_workitems", {
      token,
      baseUrl,
      orgId,
      projectId,
      category,
      keyword,
      sprintId,
      assignedTo,
      participants,
      serialNumber,
    })),

  getYunxiaoWorkitem: (token: string, baseUrl: string, orgId: string, workitemId: string) =>
    invoke<YunxiaoWorkItem>("get_yunxiao_workitem", { token, baseUrl, orgId, workitemId }),

  listYunxiaoSubWorkitems: async (
    token: string,
    baseUrl: string,
    orgId: string,
    projectId: string,
    parentId: string,
  ) =>
    asYunxiaoList<YunxiaoWorkItem>(await invoke<unknown>("list_yunxiao_sub_workitems", {
      token,
      baseUrl,
      orgId,
      projectId,
      parentId,
    })),

  createYunxiaoTestTask: (
    token: string,
    baseUrl: string,
    orgId: string,
    projectId: string,
    parentId: string,
    sprintId: string,
    subject: string,
    assignedTo: string,
    priorityValue?: string,
    workitemTypeId?: string,
  ) =>
    invoke<YunxiaoWorkItem>("create_yunxiao_test_task", {
      token,
      baseUrl,
      orgId,
      projectId,
      parentId,
      sprintId,
      subject,
      assignedTo,
      priorityValue,
      workitemTypeId,
    }),

  // 列出组织成员（缺陷负责人/验证者等 user 字段的候选项）；低频数据走会话缓存
  listYunxiaoOrgMembers: (token: string, baseUrl: string, orgId: string) =>
    yunxiaoCached(`members:${baseUrl}:${orgId}:${token}`, async () => asYunxiaoList<YunxiaoMember>(await invoke<unknown>("list_yunxiao_org_members", { token, baseUrl, orgId }))),

  // 列出项目的工作项类型（用于取 Bug/Task 的内部类型 id；云效要求带 category）
  listYunxiaoWorkitemTypes: (token: string, baseUrl: string, orgId: string, projectId: string, category?: string) =>
    yunxiaoCached(`types:${baseUrl}:${orgId}:${projectId}:${category || ""}:${token}`, async () => asYunxiaoList<YunxiaoWorkitemType>(await invoke<unknown>("list_yunxiao_workitem_types", { token, baseUrl, orgId, projectId, category }))),

  // 查询工作项类型的字段定义（用于渲染必填自定义字段，如缺陷的严重程度）
  listYunxiaoWorkitemTypeFields: (token: string, baseUrl: string, orgId: string, projectId: string, workitemTypeId: string) =>
    yunxiaoCached(`fields:${baseUrl}:${orgId}:${projectId}:${workitemTypeId}:${token}`, async () => asYunxiaoList<YunxiaoFieldDef>(await invoke<unknown>("list_yunxiao_workitem_type_fields", { token, baseUrl, orgId, projectId, workitemTypeId }))),

  // 在云效需求工作项下创建缺陷（Bug）；customFieldValues 传字段标识符→选项id
  createYunxiaoBug: (
    token: string,
    baseUrl: string,
    orgId: string,
    projectId: string,
    parentId: string,
    subject: string,
    description: string,
    assignedTo: string,
    sprintId?: string,
    customFieldValues?: Record<string, string>,
    verifier?: string,
  ) =>
    invoke<YunxiaoWorkItem>("create_yunxiao_bug", {
      token,
      baseUrl,
      orgId,
      projectId,
      parentId,
      subject,
      description,
      assignedTo,
      sprintId,
      customFieldValues,
      verifier,
    }),

  // 向已存在的云效工作项上传附件（缺陷贴图），返回 embedUrl/embedHtml
  uploadYunxiaoWorkitemAttachment: (token: string, baseUrl: string, orgId: string, workitemId: string, fileName: string, dataBase64: string) =>
    invoke<YunxiaoAttachment>("upload_yunxiao_workitem_attachment", { token, baseUrl, orgId, workitemId, fileName, dataBase64 }),

  // 更新云效工作项描述（缺陷创建后回填带贴图的富文本）
  updateYunxiaoWorkitemDescription: (token: string, baseUrl: string, orgId: string, workitemId: string, description: string) =>
    invoke<unknown>("update_yunxiao_workitem", { token, baseUrl, orgId, workitemId, description }),

  // 云效测试管理（TestHub）：用例库、目录与用例查询
  listYunxiaoTestRepos: (token: string, baseUrl: string, orgId: string, name?: string) =>
    invoke<Record<string, unknown>[]>("list_yunxiao_test_repos", { token, baseUrl, orgId, name }),

  listYunxiaoTestcaseDirectories: (token: string, baseUrl: string, orgId: string, testRepoId: string) =>
    invoke<Record<string, unknown>[]>("list_yunxiao_testcase_directories", { token, baseUrl, orgId, testRepoId }),

  searchYunxiaoTestcases: (
    token: string,
    baseUrl: string,
    orgId: string,
    testRepoId: string,
    directoryId?: string,
    keyword?: string,
    page?: number,
  ) =>
    invoke<Record<string, unknown>>("search_yunxiao_testcases", { token, baseUrl, orgId, testRepoId, directoryId, keyword, page }),

  getYunxiaoTestcase: (token: string, baseUrl: string, orgId: string, testRepoId: string, testcaseId: string) =>
    invoke<Record<string, unknown>>("get_yunxiao_testcase", { token, baseUrl, orgId, testRepoId, testcaseId }),

  // OpenAI 兼容模型调用：API Key 只经客户端本地内存传递，不写入工作区
  chatCompletion: (
    baseUrl: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    temperature?: number,
    maxTokens?: number,
  ) =>
    invoke<string>("chat_completion", {
      baseUrl,
      apiKey,
      model,
      messages,
      temperature,
      maxTokens,
    }),

  chatCompletionWithTools: (
    baseUrl: string,
    apiKey: string,
    model: string,
    messages: AiModelMessage[],
    tools: unknown[],
    maxTokens?: number,
  ) => invoke<AiModelMessage>("chat_completion_with_tools", { baseUrl, apiKey, model, messages, tools, maxTokens }),

  chatCompletionStream: (
    runId: string,
    baseUrl: string,
    apiKey: string,
    model: string,
    messages: AiModelMessage[],
    tools: unknown[],
    maxTokens?: number,
  ) => invoke<AiModelMessage>("chat_completion_stream", { runId, baseUrl, apiKey, model, messages, tools, maxTokens }),

  cancelAiSessionRun: (runId: string) => invoke<boolean>("cancel_ai_session_run", { runId }),

  agentStartTurn: (
    rootPath: string,
    sessionId: string,
    text: string,
    provider: ModelProviderSettings,
    requirementLabel: string,
    requirementDir: string,
    images: string[] = [],
    yunxiao: { token: string; base_url: string; org_id: string } | null = null,
    connections: import("../domain/integrations").Connection[] = [],
  ) => invoke<string>("agent_start_turn", { rootPath, sessionId, text, images, provider, yunxiao, connections, requirementLabel, requirementDir }),

  saveAiSessionImage: (rootPath: string, sessionId: string, contentBase64: string, extension: string) =>
    invoke<string>("save_ai_session_image", { rootPath, sessionId, contentBase64, extension }),

  readAiSessionAttachment: (rootPath: string, sessionId: string, name: string) =>
    invoke<string | null>("read_ai_session_attachment", { rootPath, sessionId, name }),

  agentResume: (
    rootPath: string,
    sessionId: string,
    reason: "approval" | "interrupted",
    provider: ModelProviderSettings,
    requirementLabel: string,
    requirementDir: string,
    yunxiao: { token: string; base_url: string; org_id: string } | null = null,
    connections: import("../domain/integrations").Connection[] = [],
  ) => invoke<string>("agent_resume", { rootPath, sessionId, reason, provider, yunxiao, connections, requirementLabel, requirementDir }),

  agentDecide: (
    rootPath: string,
    sessionId: string,
    approvalId: string,
    approved: boolean,
    provider: ModelProviderSettings,
    requirementLabel: string,
    requirementDir: string,
    yunxiao: { token: string; base_url: string; org_id: string } | null = null,
    connections: import("../domain/integrations").Connection[] = [],
  ) =>
    invoke<AgentDecision>("agent_decide", {
      rootPath,
      sessionId,
      approvalId,
      approved,
      provider,
      yunxiao,
      connections,
      requirementLabel,
      requirementDir,
    }),

  agentStop: (sessionId: string) => invoke<boolean>("agent_stop", { sessionId }),

  agentSnapshot: (sessionId: string) => invoke<AgentSnapshot>("agent_snapshot", { sessionId }),

  agentActiveSessions: () => invoke<string[]>("agent_active_sessions"),

  agentPendingClientRequests: () => invoke<AgentClientRequest[]>("agent_pending_client_requests"),

  agentRespondClientTool: (requestId: string, ok: boolean, result: unknown, error: string | null) =>
    invoke<boolean>("agent_respond_client_tool", { requestId, ok, result, error }),

  onAgentEvent: async (handler: (event: AgentEvent) => void): Promise<() => void> => {
    if (!isTauri) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AgentEvent>("agent-event", (event) => handler(event.payload));
  },

  onAgentClientRequest: async (handler: (request: AgentClientRequest) => void): Promise<() => void> => {
    if (!isTauri) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AgentClientRequest>("agent-client-request", (event) => handler(event.payload));
  },

  onAiSessionStream: async (handler: (event: AiStreamEvent) => void): Promise<() => void> => {
    if (!isTauri) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AiStreamEvent>("ai-session-stream", (event) => handler(event.payload));
  },

  listAiSessions: (rootPath: string) => invoke<AiSessionSummary[]>("list_ai_sessions", { rootPath }),

  createAiSession: (
    rootPath: string,
    title: string,
    platformId: string | null,
    requirementId: string | null,
    permissionMode: string,
  ) => invoke<AiSession>("create_ai_session", { rootPath, title, platformId, requirementId, permissionMode }),

  readAiSession: (rootPath: string, sessionId: string) => invoke<AiSession>("read_ai_session", { rootPath, sessionId }),

  updateAiSession: (
    rootPath: string,
    sessionId: string,
    changes: { title?: string; permissionMode?: string; platformId?: string; requirementId?: string },
  ) => invoke<AiSession>("update_ai_session", { rootPath, sessionId, ...changes }),

  setAiSessionArchived: (rootPath: string, sessionId: string, archived: boolean) =>
    invoke<AiSession>("set_ai_session_archived", { rootPath, sessionId, archived }),

  deleteAiSession: (rootPath: string, sessionId: string) => invoke<void>("delete_ai_session", { rootPath, sessionId }),

  appendAiSessionMessage: (
    rootPath: string,
    sessionId: string,
    message: { role: string; content: string; tool_calls?: AiSessionToolRecord[] },
  ) =>
    invoke<AiSession>("append_ai_session_message", {
      rootPath,
      sessionId,
      message: { id: "", created_at: "", tool_calls: [], ...message },
    }),

  runAiSessionTool: (rootPath: string, sessionId: string, toolName: string, args: Record<string, unknown>, runId?: string) =>
    invoke<AiToolResult>("run_ai_session_tool", { rootPath, sessionId, toolName, arguments: args, runId }),

  readAiSessionXmind: (rootPath: string, path: string) => invoke<string | null>("read_ai_session_xmind", { rootPath, path }),

  readAiSessionFile: (rootPath: string, path: string) => invoke<string | null>("read_ai_session_file", { rootPath, path }),

  writeAiSessionXmind: (rootPath: string, sessionId: string, path: string, contentBase64: string) =>
    invoke<AiToolResult>("write_ai_session_xmind", { rootPath, sessionId, path, contentBase64 }),

  writeAiSessionXmindWithRecords: (
    rootPath: string,
    sessionId: string,
    path: string,
    contentBase64: string,
    sideFiles: Array<{ kind: "changes_json" | "changes_md"; content: string }>,
    runId?: string,
  ) => invoke<AiToolResult>("write_ai_session_xmind_with_records", { rootPath, sessionId, path, contentBase64, sideFiles, runId }),

  writeAiSessionXmindApproved: (
    rootPath: string,
    sessionId: string,
    approvalId: string,
    path: string,
    contentBase64: string,
    sideFiles: Array<{ kind: "changes_json" | "changes_md"; content: string }>,
  ) => invoke<AiToolResult>("write_ai_session_xmind_approved", { rootPath, sessionId, approvalId, path, contentBase64, sideFiles }),

  requestAiApproval: (
    rootPath: string,
    sessionId: string,
    toolCallId: string,
    tool: string,
    args: Record<string, unknown>,
    paths: string[],
    reason: string,
    runId?: string,
  ) => invoke<AiApproval>("request_ai_approval", { rootPath, sessionId, toolCallId, tool, arguments: args, paths, reason, runId }),

  decideAiApproval: (rootPath: string, sessionId: string, approvalId: string, approved: boolean) =>
    invoke<AiApproval>("decide_ai_approval", { rootPath, sessionId, approvalId, approved }),

  runApprovedAiSessionTool: (rootPath: string, sessionId: string, approvalId: string) =>
    invoke<AiToolResult>("run_approved_ai_session_tool", { rootPath, sessionId, approvalId }),

  updateAiSessionMemory: (rootPath: string, sessionId: string, memory: AiSessionMemory) =>
    invoke<AiSession>("update_ai_session_memory", { rootPath, sessionId, memory }),

  listAiSessionRuns: (rootPath: string, sessionId: string) =>
    invoke<AiRunSummary[]>("list_ai_session_runs", { rootPath, sessionId }),

  planAiSessionRestore: (rootPath: string, sessionId: string, runId: string) =>
    invoke<AiRestoreItem[]>("plan_ai_session_restore", { rootPath, sessionId, runId }),

  applyAiSessionRestore: (rootPath: string, sessionId: string, runId: string) =>
    invoke<AiRestoreOutcome>("apply_ai_session_restore", { rootPath, sessionId, runId }),

  verifyModelProvider: (baseUrl: string, apiKey: string, model: string) =>
    invoke<string>("verify_model_provider", { baseUrl, apiKey, model }),

  runAiTask: (
    rootPath: string,
    taskId: string,
    baseUrl: string,
    apiKey: string,
    model: string,
    temperature?: number,
    maxTokens?: number,
  ) =>
    invoke<AiTaskInfo>("run_ai_task", {
      rootPath,
      taskId,
      baseUrl,
      apiKey,
      model,
      temperature,
      maxTokens,
    }),

  writeAiTaskOutputs: (
    rootPath: string,
    taskId: string,
    outputs: Array<{ path: string; type: string; summary: string; content?: string; contentBase64?: string }>,
    summary: string,
    pendingItems: string[],
  ) =>
    invoke<AiTaskInfo>("write_ai_task_outputs", {
      rootPath,
      taskId,
      outputs,
      summary,
      pendingItems,
    }),

  saveWorkspaceConfig: (rootPath: string, config: WorkspaceConfig) =>
    invoke<WorkspaceConfig>("save_workspace_config", { rootPath, config }),

  startWorkspaceWatcher: (rootPath: string, generation: number) =>
    invoke<boolean>("start_workspace_watcher", { rootPath, generation }),

  stopWorkspaceWatcher: (generation: number) =>
    invoke<void>("stop_workspace_watcher", { generation }),

  scanPlatforms: (rootPath: string) =>
    invoke<PlatformInfo[]>("scan_platforms_cmd", { rootPath }),

  createPlatform: (rootPath: string, input: PlatformDraft) =>
    invoke<WorkspaceConfig>("create_platform", { rootPath, input }),

  updatePlatform: (rootPath: string, platformId: string, input: PlatformUpdate) =>
    invoke<WorkspaceConfig>("update_platform", { rootPath, platformId, ...input }),

  deletePlatform: (rootPath: string, platformId: string) =>
    invoke<WorkspaceConfig>("delete_platform", { rootPath, platformId }),

  createRequirement: (rootPath: string, platformId: string, input: RequirementDraft) =>
    invoke<RequirementMeta>("create_requirement", { rootPath, platformId, input }),

  createAiTask: (rootPath: string, input: AiTaskDraft) =>
    invoke<AiTaskInfo>("create_ai_task", { rootPath, input }),

  listAiTasks: (rootPath: string) =>
    invoke<AiTaskInfo[]>("list_ai_tasks", { rootPath }),

  acceptAiTaskResult: (rootPath: string, taskId: string) =>
    invoke<AiTaskActionResult>("accept_ai_task_result", { rootPath, taskId }),

  rejectAiTaskResult: (rootPath: string, taskId: string, note: string) =>
    invoke<AiTaskActionResult>("reject_ai_task_result", { rootPath, taskId, note }),

  acceptAndUnlockAiTask: (rootPath: string, taskId: string) =>
    invoke<AiTaskActionResult>("accept_and_unlock_ai_task", { rootPath, taskId }),

  redispatchAiTask: (rootPath: string, taskId: string) =>
    invoke<AiTaskActionResult>("redispatch_ai_task", { rootPath, taskId }),

  scanRequirements: (rootPath: string, platformPath: string) =>
    invoke<RequirementMeta[]>("scan_requirements", { rootPath, platformPath }),

  // 需求资料中的 docx 内嵌图预处理：列出 docx 及产物是否就绪；写入只接受派生目录内的文件
  prepareDocxAssets: (rootPath: string, requirementDir: string) =>
    invoke<DocxAssetStatus[]>("prepare_docx_assets", { rootPath, requirementDir }),

  writeDocxAssetFile: (rootPath: string, requirementDir: string, dirName: string, fileName: string, contentBase64: string) =>
    invoke<void>("write_docx_asset_file", { rootPath, requirementDir, dirName, fileName, contentBase64 }),

  scanTestAssets: (rootPath: string) =>
    invoke<TestAssetInfo[]>("scan_test_assets", { rootPath }),

  readRequirement: (rootPath: string, platformPath: string, requirementId: string) =>
    invoke<RequirementMeta>("read_requirement", { rootPath, platformPath, requirementId }),

  saveRequirement: (rootPath: string, platformPath: string, requirementId: string, meta: RequirementMeta) =>
    invoke<void>("save_requirement", { rootPath, platformPath, requirementId, meta }),

  lockRequirement: (rootPath: string, platformPath: string, requirementId: string, taskId: string, note: string, user: string) =>
    invoke<RequirementMeta>("lock_requirement", { rootPath, platformPath, requirementId, taskId, note, user }),

  scanRequirementChanges: (rootPath: string, platformPath: string, requirementId: string) =>
    invoke<UnlockPreview>("scan_requirement_changes", { rootPath, platformPath, requirementId }),

  acceptUnlockRequirement: (rootPath: string, platformPath: string, requirementId: string) =>
    invoke<UnlockResult>("accept_unlock_requirement", { rootPath, platformPath, requirementId }),

  forceUnlockRequirement: (rootPath: string, platformPath: string, requirementId: string, reason: string) =>
    invoke<UnlockResult>("force_unlock_requirement", { rootPath, platformPath, requirementId, reason }),

  unlockRequirement: (rootPath: string, platformPath: string, requirementId: string) =>
    invoke<UnlockPreview>("scan_requirement_changes", { rootPath, platformPath, requirementId }),

  // BB-16E：需求阶段推进/退回/归档/恢复，写回 requirement.yaml 并追加活动记录
  transitionRequirementStage: (rootPath: string, platformPath: string, requirementId: string, action: StageTransitionAction, reason = "", note = "") =>
    invoke<RequirementMeta>("transition_requirement_stage", { rootPath, platformPath, requirementId, action, reason, note }),

  // 追加一条需求活动记录（台账走内部写入通道，锁定中也可记录客户端动作）
  appendRequirementActivity: (rootPath: string, platformPath: string, requirementId: string, event: RequirementActivityInput) =>
    invoke<RequirementActivityEvent>("append_requirement_activity", { rootPath, platformPath, requirementId, event }),

  // 读取需求目录 activity.json；文件不存在时返回空台账
  readRequirementActivity: (rootPath: string, platformPath: string, requirementId: string) =>
    invoke<RequirementActivity>("read_requirement_activity", { rootPath, platformPath, requirementId }),

  createDirectory: (dirPath: string) =>
    invoke<void>("create_directory", { dirPath }),

  writeBinaryFile: (filePath: string, content: Uint8Array) =>
    invoke<void>("write_binary_file", { filePath, content: Array.from(content) }),

  createBinaryFile: (filePath: string, content: Uint8Array) =>
    invoke<void>("create_binary_file", { filePath, content: Array.from(content) }),

  readBinaryFile: async (filePath: string) => {
    const content = await invoke<number[]>("read_binary_file", { filePath });
    return new Uint8Array(content || []);
  },

  getPathInfo: (path: string) =>
    invoke<PathInfo>("get_path_info", { path }),

  // 系统默认程序打开文件
  openExternalFile: async (filePath: string) => {
    if (!isTauri) throw new Error("系统打开仅在桌面客户端可用");
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(filePath);
  },

  // 在系统文件管理器中打开目录本身
  openExternalDirectory: async (dirPath: string) => {
    if (!isTauri) throw new Error("系统打开仅在桌面客户端可用");
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(dirPath);
  },

  // 在资源管理器/Finder 中定位并选中目标文件或目录
  revealInFileManager: async (path: string) => {
    if (!isTauri) throw new Error("系统打开仅在桌面客户端可用");
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  },

  chooseDirectory: async (): Promise<string | null> => {
    if (!isTauri) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  },

  chooseXMindFile: async (): Promise<string | null> => {
    if (!isTauri) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "XMind文件", extensions: ["xmind"] }],
    });
    return typeof selected === "string" ? selected : null;
  },

  chooseXMindFiles: async (): Promise<string[]> => {
    if (!isTauri) return [];
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: false,
      multiple: true,
      filters: [{ name: "XMind文件", extensions: ["xmind"] }],
    });
    return Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
  },

  chooseTemplateFile: async (): Promise<string | null> => {
    if (!isTauri) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "用例模板", extensions: ["xmind", "xlsx"] }],
    });
    return typeof selected === "string" ? selected : null;
  },

  chooseReportTemplateFile: async (): Promise<string | null> => {
    if (!isTauri) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "测试报告模板", extensions: ["md", "markdown", "docx"] }],
    });
    return typeof selected === "string" ? selected : null;
  },

  readTextFile: (filePath: string) =>
    invoke<string>("read_text_file", { filePath }),

  writeTextFile: (filePath: string, content: string) =>
    invoke<void>("write_text_file", { filePath, content }),

  listDirectory: (dirPath: string) =>
    invoke<DirEntryInfo[]>("list_directory", { dirPath }),

  commitCaseRevision: (requirementDir: string, transactionId: string, writes: import("./caseRevision").RevisionWrite[]) =>
    invoke<import("./caseRevision").RevisionOutcome>("commit_case_revision", { requirementDir, transactionId, writes }),

  confirmCaseFinalization: (requirementDir: string, expected: number[], confirmedBy: string, note: string, proposalRefs: string[], sourceRuns: string[], confirmationId: string) =>
    invoke<Record<string, any>>("confirm_case_finalization", { requirementDir, expected, confirmedBy, note, proposalRefs, sourceRuns, confirmationId }),

  saveJsonFileIfUnchanged: (filePath: string, expectedJson: unknown, data: unknown) =>
    invoke<void>("save_json_file_if_unchanged", { filePath, expectedJson, data }),

  saveJsonFile: (filePath: string, data: any) =>
    invoke<void>("save_json_file", { filePath, data }),

  createJsonFile: (filePath: string, data: any) =>
    invoke<void>("create_json_file", { filePath, data }),

  readJsonFiles: async (filePaths: string[]): Promise<any[]> => {
    const files = await invoke<number[][]>("read_case_revision_files", { filePaths });
    return files.map((bytes) => JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))));
  },

  readJsonFile: (filePath: string) =>
    invoke<any>("read_json_file", { filePath }),

  // 仅创建文本文件，目标已存在时报错而不是覆盖（资料页新建文档）
  createTextFile: (filePath: string, content: string) =>
    invoke<void>("create_text_file", { filePath, content }),

  // 同目录重命名文件或文件夹，目标已存在时拒绝覆盖
  renamePath: (fromPath: string, toPath: string) =>
    invoke<void>("rename_path", { fromPath, toPath }),

  // 删除文件或空目录；requirement.yaml 与需求根目录被拒绝
  deletePath: (path: string) =>
    invoke<void>("delete_path", { path }),

  // 受控导入：把外部文件复制到工作区目录，支持同名冲突策略
  importFiles: (targetDir: string, sources: ImportSourceItem[]) =>
    invoke<ImportResultItem[]>("import_files", { targetDir, sources }),

  // 追加一条客户端审计日志到 .blackbox/logs/client-<日期>.jsonl
  appendWorkspaceLog: (rootPath: string, entry: WorkspaceLogInput) =>
    invoke<void>("append_workspace_log", { rootPath, entry }),

  // 读取 .blackbox/logs 下的审计与业务操作日志（归一化）
  listWorkspaceLogs: (rootPath: string) =>
    invoke<WorkspaceLogList>("list_workspace_logs", { rootPath }),

  // BB-16F：工作区全局搜索；context 用于提升当前平台/需求上下文结果的排序
  searchWorkspace: (rootPath: string, query: string, context?: { platformId?: string; requirementId?: string }, limit?: number) =>
    invoke<WorkspaceSearchResult[]>("search_workspace", {
      rootPath,
      query,
      platformId: context?.platformId ?? null,
      requirementId: context?.requirementId ?? null,
      limit: limit ?? null,
    }),

  // 系统多选文件对话框；浏览器模式返回空数组，由调用方回退到 input[type=file]
  chooseImportFiles: async (imagesOnly = false): Promise<string[]> => {
    if (!isTauri) return [];
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: false,
      multiple: true,
      filters: imagesOnly
        ? [{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }]
        : undefined,
    });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  },
};

export { isTauri };
