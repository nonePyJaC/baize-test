export type TabType =
  | "home"
  | "platform"
  | "requirement"
  | "markdown"
  | "docx"
  | "excel"
  | "image"
  | "xmind"
  | "questions"
  | "test-assets"
  | "coverage"
  | "structured-cases"
  | "case-export"
  | "test-execution"
  | "api-debug"
  | "report-generation"
  | "knowledge"
  | "requirement-folder"
  | "changes"
  | "ai-task"
  | "settings";

// 左侧工具窗口类型；none 表示当前主导航不展示左侧工具窗口（如设置）
export type ToolView = "project" | "requirements" | "tests" | "execution" | "knowledge" | "tasks" | "none";
export type BottomView = "problems" | "changes" | "tasks" | "logs";
export type RightView = "outline" | "properties" | "task" | "file";

// 主导航项，是工作台上下文的单一数据源：左侧工具窗口由它派生
export type WorkbenchNav = "home" | "project" | "requirements" | "tests" | "execution" | "api-debug" | "knowledge" | "tasks" | "settings";

// 主导航 → 左侧工具窗口
export const NAV_TOOL_VIEW: Record<WorkbenchNav, ToolView> = {
  home: "project",
  project: "project",
  requirements: "requirements",
  tests: "tests",
  execution: "execution",
  "api-debug": "none",
  knowledge: "knowledge",
  tasks: "tasks",
  settings: "none",
};

// Tab 类型 → 主导航项：打开/激活 Tab 时同步主导航和左侧工具窗口
export const TAB_NAV: Partial<Record<TabType, WorkbenchNav>> = {
  home: "home",
  platform: "requirements",
  requirement: "requirements",
  questions: "requirements",
  "requirement-folder": "requirements",
  markdown: "project",
  docx: "project",
  excel: "project",
  image: "project",
  xmind: "project",
  "test-assets": "tests",
  "coverage": "tests",
  "structured-cases": "tests",
  "case-export": "tests",
  "test-execution": "execution",
  "api-debug": "api-debug",
  "report-generation": "execution",
  knowledge: "knowledge",
  "ai-task": "tasks",
  settings: "settings",
};

export interface WorkbenchTab {
  id: string;
  type: TabType;
  title: string;
  subtitle?: string;
  icon: string;
  preview: boolean;
  pinned: boolean;
  dirty: boolean;
  closable: boolean;
  payload?: {
    path?: string;
    platformId?: string;
    platformPath?: string;
    requirementId?: string;
    runId?: string;
    taskId?: string;
    /** 深链定位：结构化用例中选中的用例ID / 知识库中选中的条目ID */
    caseId?: string;
    knowledgeId?: string;
    folder?: string;
    // 深链定位：如 structured-cases 的 versions（版本与差异）、knowledge 的作用域
    focus?: string;
    scope?: string;
    // 每次定位请求递增的时间戳，用于同一Tab重复定位时仍能触发目标视图响应
    focusKey?: number;
  };
}

export interface ClosedTab extends WorkbenchTab {
  closedAt: number;
}

export const DEFAULT_TAB: WorkbenchTab = {
  id: "home",
  type: "home",
  title: "工作区首页",
  icon: "home",
  preview: false,
  pinned: true,
  dirty: false,
  closable: false,
};

export function makeTab(input: Partial<WorkbenchTab> & Pick<WorkbenchTab, "id" | "type" | "title">): WorkbenchTab {
  return {
    ...DEFAULT_TAB,
    ...input,
    icon: input.icon || "file",
    closable: input.closable ?? true,
  };
}

export function isDocumentTab(tab: WorkbenchTab): boolean {
  return ["markdown", "docx", "excel", "image", "xmind", "questions", "coverage", "requirement", "structured-cases", "case-export", "test-execution", "report-generation", "knowledge"].includes(tab.type);
}

// —— BB-16D：右侧上下文协议 ————————————————————————————
// 各业务视图通过 onRightContext 回调上报当前对象的真实上下文，
// 工作台据此渲染右侧 大纲 / 属性 / AI任务 三个工具窗口。

/** 右侧大纲条目：onSelect 由上报视图提供，用于定位页面内容 */
export interface RightOutlineItem {
  id: string;
  label: string;
  depth?: number;
  hint?: string;
  badge?: string;
  icon?: string;
  active?: boolean;
  onSelect?: () => void;
}

export interface RightPropertyItem {
  label: string;
  value: string;
  mono?: boolean;
}

export interface RightStatItem {
  label: string;
  value: string;
}

/** 当前对象的统一上下文模型 */
export interface RightContextData {
  /** 对象类型：file/markdown/requirement/cases/run/report/task/knowledge/folder/home/settings/generic */
  objectType: string;
  objectId?: string;
  title: string;
  subtitle?: string;
  /** 绝对路径（文件类对象）或业务目录 */
  path?: string;
  platformId?: string;
  requirementId?: string;
  outlineTitle?: string;
  outline?: RightOutlineItem[];
  properties?: RightPropertyItem[];
  stats?: RightStatItem[];
  /** 目录锁定等只读状态说明 */
  readOnly?: boolean;
}

export type RightContextReporter = (data: RightContextData | null) => void;
