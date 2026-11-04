import type { Connection, ExternalReference, IntegrationDefaults } from "../domain/integrations";
// 白泽 BAIZE 前端类型定义

export interface WorkspaceConfig {
  version: string;
  workspace: WorkspaceInfo;
  directories: Record<string, string>;
  platforms: PlatformInfo[];
  defaults?: WorkspaceDefaults;
  index?: WorkspaceIndexConfig;
  watcher?: WorkspaceWatcherConfig;
  backup?: WorkspaceBackupConfig;
  legacy_directories?: string[];
}

export interface WorkspaceDefaults {
  integration_defaults?: IntegrationDefaults;
  platform_id: string | null;
  case_template_id: string | null;
  report_template_id: string | null;
}

export interface WorkspaceIndexConfig {
  engine: string;
  db_path: string;
  fts_enabled: boolean;
  ignore_patterns: string[];
}

export interface WorkspaceWatcherConfig {
  enabled: boolean;
  debounce_ms: number;
  ignore_patterns: string[];
}

export type WorkspaceEventType = "create" | "modify" | "remove" | "rename";

export interface WorkspaceEvent {
  event_type: WorkspaceEventType;
  path: string;
  old_path: string | null;
  is_directory: boolean;
  occurred_at: string;
}

export interface WorkspaceBackupConfig {
  auto_enabled: boolean;
  interval_hours: number;
  max_backups: number;
  include_cache: boolean;
}

export interface WorkspaceOpenResult {
  config: WorkspaceConfig;
  initialized: boolean;
  legacy_directories: string[];
}

export interface RecentWorkspace {
  path: string;
  name: string;
  last_opened_at: string;
  available?: boolean;
  initialized?: boolean;
}

export interface WorkspaceSession {
  recent_workspaces: RecentWorkspace[];
  last_workspace: string | null;
}

export interface ExternalProgramPreferences {
  git_command: string;
  python_command: string;
  editor_command: string;
}

// 云效集成：个人访问令牌只保存在本机客户端偏好，不写入工作区
export interface YunxiaoSettings {
  enabled: boolean;
  access_token: string;
  base_url: string;
  organization_id: string;
  organization_name: string;
  user_id: string;
  user_name: string;
  last_verified_at: string;
}

export interface YunxiaoIdentity {
  organization_id: string;
  organization_name: string;
  user_id: string;
  user_name: string;
  base_url: string;
}

export interface YunxiaoNamedRef {
  id: string;
  name: string;
}

export interface YunxiaoProject {
  id: string;
  name: string;
  description?: string;
  logicalStatus?: string;
}

export interface YunxiaoSprint {
  id: string;
  name: string;
  status?: string;
}

export interface YunxiaoFieldOption {
  identifier?: string;
  id?: string;
  value?: string;
  valueEn?: string;
  displayValue?: string;
  disabled?: boolean;
}

// 云效组织成员：工作项负责人/验证者等 user 字段的候选项
export interface YunxiaoMember {
  id: string;
  userId: string;
  name: string;
  email?: string;
}

// 云效测试计划：提交版本时关联的计划（manifest 与 cases.json metadata 共用）
export interface YunxiaoTestPlanLink {
  id: string;
  name: string;
  project_id: string | null;
  project_name: string | null;
  sprint_id: string | null;
  sprint_name: string | null;
  linked_at: string;
}

// 新建云效测试计划的请求体，字段与 Rust 端 TestPlanDraft（camelCase）一致
export interface YunxiaoTestPlanDraft {
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  managerIdentifiers: string[];
  memberIdentifiers: string[];
  projectIdentifier: string;
  sprintIdentifier: string;
  scope: "public" | "private";
}

// 项目的工作项类型（categoryId 如 Req/Task/Bug）
export interface YunxiaoWorkitemType {
  id: string;
  name?: string;
  categoryId?: string;
  nameEn?: string;
}

// 工作项类型字段定义：required + format=list 的字段创建时必须传选项 id
export interface YunxiaoFieldDef {
  id: string;
  name: string;
  type?: string;
  format?: string;
  required?: boolean;
  showWhenCreate?: boolean;
  defaultValue?: string | null;
  options?: YunxiaoFieldOption[];
}

// 需求资料 docx 的内嵌图产物：source 为 docx 路径，asset_dir 为产物目录，ready 表示正文.md 已生成
export interface DocxAssetStatus {
  source: string;
  dir_name: string;
  asset_dir: string;
  ready: boolean;
}

// 工作项附件上传结果：embedUrl/embedHtml 是永不过期的嵌入地址，可直接放进富文本描述
export interface YunxiaoAttachment {
  id: string;
  name?: string;
  suffix?: string;
  size?: number;
  url?: string;
  embedUrl?: string;
  embedHtml?: string;
  embedMarkdown?: string;
}

export interface YunxiaoWorkItem {
  id: string;
  serialNumber?: string;
  subject: string;
  description?: string;
  formatType?: string;
  status?: YunxiaoNamedRef & { nameEn?: string; displayName?: string };
  assignedTo?: YunxiaoNamedRef;
  creator?: YunxiaoNamedRef;
  modifier?: YunxiaoNamedRef;
  workitemType?: YunxiaoNamedRef & { nameEn?: string };
  sprint?: YunxiaoNamedRef;
  space?: YunxiaoNamedRef;
  parentId?: string;
  categoryId?: string;
  customFieldValues?: Array<{
    fieldId: string;
    fieldName: string;
    fieldFormat: string;
    values: Array<{ identifier: string; displayValue: string }>;
  }>;
}

// 测试资产：需求 04-测试用例 目录下的 XMind/Excel 用例文件
export interface TestAssetInfo {
  platform_id: string;
  platform_name: string;
  requirement_id: string;
  requirement_name: string;
  name: string;
  path: string;
  relative_path: string;
  kind: "xmind" | "excel";
  size: number;
  modified: string;
  cases_json_exists: boolean;
}

// 模型服务：OpenAI 兼容接口，API Key 只保存在本机客户端偏好，不写入工作区
export interface ModelProviderSettings {
  enabled: boolean;
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens: number;
  context_window_tokens: number;
  compaction_trigger_tokens: number;
  last_verified_at: string;
}

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | string;
  content: string | Array<ChatTextPart | ChatImagePart>;
}

export interface ClientPreferences {
  connections?: Connection[];
  integration_defaults?: IntegrationDefaults;
  external_programs: ExternalProgramPreferences;
  auto_open_change_center: boolean;
  yunxiao: YunxiaoSettings;
  model_provider: ModelProviderSettings;
}

export interface WorkspaceInfo {
  name: string;
  created_at: string;
  root_path: string;
}

export interface PlatformInfo {
  integration_defaults?: IntegrationDefaults;
  id: string;
  name: string;
  path: string;
  created_at: string;
  knowledge_path?: string;
  status?: "active" | "archived" | string;
  description?: string;
  updated_at?: string;
}

export interface PlatformDraft {
  id: string;
  name: string;
  path: string;
  knowledge_path: string;
  description: string;
}

export interface PlatformUpdate {
  name: string;
  description: string;
  status: "active" | "archived";
}

// 需求与云效工作项的绑定：测试执行中提交缺陷时挂到该云效需求下
export interface RequirementYunxiao {
  project_id: string;
  project_name: string;
  workitem_id: string;
  workitem_serial: string;
  workitem_subject: string;
  sprint_id: string;
}

export interface RequirementDraft {
  external_refs?: ExternalReference[];
  integration_defaults?: IntegrationDefaults;
  id: string;
  name: string;
  owner: string;
  planned_test_date: string | null;
  planned_release_date: string | null;
  applications: ApplicationInfo[];
  initial_stage: string;
  yunxiao?: RequirementYunxiao | null;
}

export interface RequirementMeta {
  external_refs?: ExternalReference[];
  integration_defaults?: IntegrationDefaults;
  version: string;
  requirement: RequirementInfo;
  status: string;
  current_stage: string;
  schedule: ScheduleInfo;
  applications: ApplicationInfo[];
  git_resources?: GitResource[];
  client_access: ClientAccess;
  stage_checklist: any[];
  blockers: any[];
  pending_reviews: any[];
  next_actions: any[];
  versions?: any[];
  yunxiao?: RequirementYunxiao | null;
}

export interface RequirementInfo {
  id: string;
  name: string;
  platform: string;
  owner: string;
  created_at: string;
}

export interface ScheduleInfo {
  planned_test_date: string | null;
  planned_release_date: string | null;
  actual_test_date: string | null;
  actual_release_date: string | null;
}

export interface ApplicationInfo {
  name: string;
  branch: string;
}

export type GitResourceAppType = "frontend" | "backend" | "other";

export interface GitResource {
  id: string;
  application_name: string;
  local_path: string;
  repository_url: string;
  current_branch: string;
  current_commit: string;
  expected_branch: string;
  app_type: GitResourceAppType;
}

export interface GitFileStatus {
  code: string;
  path: string;
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitStatus {
  resource_id: string;
  local_path: string;
  is_git_repo: boolean;
  branch: string | null;
  commit: string | null;
  remote: string | null;
  upstream_branch: string | null;
  uncommitted_files: GitFileStatus[];
  ahead: number;
  behind: number;
  recent_commits: GitCommit[];
  incoming_commits: GitCommit[];
  can_fast_forward: boolean;
  checked_at: string;
  error: string | null;
}

export interface GitFetchResult {
  status: GitStatus;
  output: string;
}

export interface GitPullResult {
  status: GitStatus;
  output: string;
}

export interface ClientAccess {
  mode: "unlocked" | "locked_for_ai";
  locked_at: string | null;
  locked_by: string | null;
  task_id: string | null;
  note: string;
  snapshot_path: string | null;
}

export interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
}

export interface PathInfo {
  exists: boolean;
  is_file: boolean;
  is_directory: boolean;
  size: number;
  modified: string;
}

// 资料导入：同名冲突策略。auto 表示未做选择，目标已存在时按失败处理
export type ImportConflictStrategy = "auto" | "rename" | "overwrite" | "skip";

export interface ImportSourceItem {
  source_path: string;
  name: string;
  strategy: ImportConflictStrategy;
}

export interface ImportResultItem {
  name: string;
  source_path: string;
  target_path: string | null;
  /** imported | renamed | overwritten | skipped | failed */
  status: "imported" | "renamed" | "overwritten" | "skipped" | "failed" | string;
  message: string;
}

export interface FileMove {
  from: string;
  to: string;
}

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  moved: FileMove[];
  total: number;
}

export interface UnlockPreview {
  requirement: RequirementMeta;
  changes: FileChanges;
  warnings: string[];
  scanned_at: string;
}

export interface UnlockResult {
  requirement: RequirementMeta;
  changes: FileChanges;
  warnings: string[];
  action: "accepted" | "forced";
}

export const STAGE_LABELS: Record<string, string> = {
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

export const STAGE_ORDER = [
  "draft",
  "collecting",
  "analyzing",
  "pending_qa",
  "planning",
  "testcase_design",
  "testcase_review",
  "ready_for_test",
  "testing",
  "pending_report",
  "completed",
  "archived",
];

// —— BB-16E：需求阶段流转、检查项与活动记录 ——

/** 阶段流转动作：推进一格 / 退回一格（必填原因）/ 归档 / 恢复 */
export type StageTransitionAction = "advance" | "retreat" | "archive" | "restore";

/** requirement.yaml 中 stage_checklist 的人工检查项（自动检查项由文件探测实时计算，不落盘） */
export interface StageChecklistItem {
  id: string;
  stage: string;
  label: string;
  kind: "manual" | "auto" | string;
  done: boolean;
  done_at: string | null;
  note?: string;
  source?: string;
}

/** 需求目录 activity.json 中的单条活动事件 */
export interface RequirementActivityEvent {
  id: string;
  occurred_at: string;
  action: string;
  actor: string;
  summary: string;
  from_stage: string | null;
  to_stage: string | null;
  object_id: string | null;
  refs: string[];
}

/** 需求活动台账（<需求目录>/activity.json） */
export interface RequirementActivity {
  version: string;
  requirement_id: string;
  platform_id: string;
  updated_at: string;
  events: RequirementActivityEvent[];
}

/** 追加活动事件的输入：id/occurred_at 由后端生成 */
export interface RequirementActivityInput {
  action: string;
  actor?: string;
  summary: string;
  from_stage?: string | null;
  to_stage?: string | null;
  object_id?: string | null;
  refs?: string[];
}

/** 阶段自动检查项：由工作区文件实时计算的完成提示 */
export interface StageAutoCheck {
  id: string;
  stage: string;
  label: string;
  /** 来源文件或目录（需求相对路径） */
  source: string;
  /** passed=条件满足 attention=建议关注 unavailable=来源不可读 */
  status: "passed" | "attention" | "unavailable";
  detail: string;
}

export interface Question {
  id: string;
  question: string;
  priority: "P0" | "P1" | "P2";
  category: string;
  status: "pending" | "partial" | "answered" | "no_need" | "void";
  owner: string | null;
  source: string | null;
  impact: string[];
  answer: string | null;
  answer_format: "markdown" | "richtext_json";
  attachments: Attachment[];
  created_at: string;
  answered_at: string | null;
  version: number;
}

export interface Attachment {
  path: string;
  type: string;
  description: string;
}

export interface QuestionsData {
  version: string;
  requirement_id: string;
  questions: Question[];
}

/** 覆盖追溯条目（03-测试计划/coverage.json）：AI 登记维护，豁免只能由人确认 */
export interface CoverageItem {
  id: string;
  ref: string;
  kind: "task" | "interface" | "rule" | "shared_surface" | "other";
  title: string;
  source: string;
  coverage: "covered" | "partial" | "none" | "exempt";
  cases: string[];
  note: string;
  exempt_reason: string | null;
  exempt_by: string | null;
  created_at: string;
  updated_at: string;
  updated_by: "ai" | "user" | string;
}

export interface CoverageData {
  version: string;
  requirement_id: string;
  items: CoverageItem[];
}

export const CASE_TEST_TYPES = [
  "功能测试",
  "性能测试",
  "兼容性测试",
  "易用性测试",
  "安全性测试",
  "稳定性测试",
  "接口测试",
  "自动化测试",
  "安装部署测试",
  "冒烟测试",
  "回归测试",
  "其他",
] as const;

export const CASE_AUTOMATION_STATUSES = ["none", "planned", "in_progress", "completed"] as const;
export const CASE_STATUSES = ["draft", "pending_review", "confirmed", "deprecated"] as const;

export type CasePriority = 0 | 1 | 2;
export type CaseTestType = typeof CASE_TEST_TYPES[number];
export type CaseAutomationStatus = typeof CASE_AUTOMATION_STATUSES[number];
export type CaseStatus = typeof CASE_STATUSES[number];

export interface StructuredCaseStep {
  order: number;
  action: string;
  expected: string[];
}

export interface StructuredCaseOwner {
  connection_id: string;
  provider_id: string;
  entity_type: "member";
  external_id: string;
  display_key?: string;
  title: string;
}

export type StructuredCaseOwnerValue = StructuredCaseOwner | string;

export interface StructuredTestCase {
  source?: { file: string; sheet_id?: string; sheet_index?: number; topic_id: string; directory_id?: string; baseline?: Partial<StructuredTestCase> };
  id: string;
  title: string;
  directory_id: string;
  priority: CasePriority;
  test_type: string;
  preconditions: string[];
  steps: StructuredCaseStep[];
  expected_results?: string[];
  owners?: StructuredCaseOwnerValue[];
  tags: string[];
  platforms: string[];
  requirement_refs: string[];
  asset_refs: string[];
  requires_evidence: boolean;
  automation_status: string;
  created_by: string;
  version: number;
  status: string;
  [key: string]: unknown;
}

export interface CaseDirectoryNode {
  id: string;
  title: string;
  node_type: "platform" | "module" | "section" | "workbook" | "case_ref" | string;
  case_id?: string | null;
  children: CaseDirectoryNode[];
  [key: string]: unknown;
}

export interface CasesDocument {
  version: string;
  requirement_id: string;
  platform: string;
  platform_id?: string;
  tree: CaseDirectoryNode;
  cases: StructuredTestCase[];
  metadata?: Record<string, unknown>;
  version_id?: string;
  [key: string]: unknown;
}

export interface CaseVersionManifest {
  version_id: string;
  version: number;
  created_at: string;
  created_by: string;
  source_task: string | null;
  case_count: number;
  fingerprint: string;
  note: string;
  requirement_id: string;
  platform_id: string;
  external_test_plan?: ExternalReference | null;
  /** Legacy read compatibility only. */
  yunxiao_test_plan?: YunxiaoTestPlanLink | null;
  [key: string]: unknown;
}

export interface CaseDiffEntry {
  id: string;
  title: string;
  fields: string[];
  before?: StructuredTestCase;
  after?: StructuredTestCase;
}

export interface CaseDiffResult {
  added: CaseDiffEntry[];
  deleted: CaseDiffEntry[];
  modified: CaseDiffEntry[];
  moved: CaseDiffEntry[];
}

export type CaseTemplateType = "xmind" | "excel";

export interface XMindTemplateMapping {
  root_topic: string;
  directory_placeholder: string;
  case_placeholder: string;
  pc_topic: string;
  tx_topic: string;
  expected_topic: string;
  expected_as_child: boolean;
  [key: string]: unknown;
}

export interface ExcelTemplateMapping {
  worksheet: string;
  header_row: number;
  data_start_row: number;
  directory_column: string;
  title_column: string;
  priority_column: string;
  test_type_column: string;
  preconditions_column: string;
  steps_column: string;
  expected_column: string;
  [key: string]: unknown;
}

export type CaseTemplateMapping = XMindTemplateMapping | ExcelTemplateMapping;

export interface CaseTemplate {
  id: string;
  name: string;
  type: CaseTemplateType;
  version: string;
  file_path: string;
  platform_id: string | null;
  fingerprint: string;
  output_name_rule: string;
  mapping: CaseTemplateMapping;
  required_fields: string[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface CaseTemplateRegistry {
  version: string;
  templates: CaseTemplate[];
  [key: string]: unknown;
}

export type ReportTemplateType = "markdown" | "docx";

export interface ReportTemplate {
  id: string;
  name: string;
  type: ReportTemplateType;
  version: string;
  file_path: string;
  platform_id: string | null;
  fingerprint: string;
  placeholders: string[];
  fixed_sections: string[];
  output_name_rule: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface ReportTemplateRegistry {
  version: string;
  templates: ReportTemplate[];
  [key: string]: unknown;
}

export interface CaseExportMappingResult {
  case_id: string;
  title: string;
  directory: string;
  target: string;
  missing_fields: string[];
}

export interface CaseExportPreview {
  output_path: string;
  output_name: string;
  template: CaseTemplate;
  directory_count: number;
  case_count: number;
  missing_fields: string[];
  mappings: CaseExportMappingResult[];
  source_fingerprint?: string;
  template_fingerprint?: string;
  template_changed: boolean;
}

export interface CaseExportValidation {
  passed: boolean;
  case_count: number;
  errors: string[];
  warnings: string[];
}

export interface CaseExportResult {
  output_path: string;
  bytes: Uint8Array;
  validation: CaseExportValidation;
}

export const TEST_RESULT_STATUSES = ["not_executed", "passed", "failed", "blocked", "skipped", "not_applicable"] as const;
export const TEST_RESULT_SEVERITIES = ["none", "low", "medium", "high", "critical"] as const;

export type TestResultStatus = typeof TEST_RESULT_STATUSES[number];
export type TestResultSeverity = typeof TEST_RESULT_SEVERITIES[number];

export interface TestRunScope {
  case_ids: string[];
  description: string;
  [key: string]: unknown;
}

export interface TestRunDocument {
  version: string;
  run_id: string;
  requirement_id: string;
  platform_id: string;
  name: string;
  case_version_id: string;
  working_revision?: number;
  baseline_fingerprint?: string | null;
  case_version: number;
  environment: string;
  application_versions: string;
  branch: string;
  executor: string;
  planned_at: string | null;
  execution_scope: TestRunScope;
  created_at: string;
  updated_at: string;
  created_by: string;
  [key: string]: unknown;
}

export interface TestEvidence {
  id: string;
  path: string;
  name: string;
  type: "image" | "log" | "request_response" | "attachment";
  size: number;
  mime_type: string;
  added_at: string;
  [key: string]: unknown;
}

export interface TestCaseResult {
  external_refs?: ExternalReference[];
  case_revision?: number;
  needs_retest?: boolean;
  deleted?: boolean;
  case_id: string;
  status: TestResultStatus;
  actual_result: string;
  notes: string;
  severity: TestResultSeverity;
  defect_url: string;
  evidence: TestEvidence[];
  updated_at: string;
  [key: string]: unknown;
}

export interface TestCaseChangeHistoryEntry {
  id: string;
  changed_at: string;
  action: import("./caseRevision").CaseChangeAction;
  event_id?: string;
  case_id: string;
  title: string;
  reason: string;
  changed_fields: string[];
  before: StructuredTestCase | null;
  after: StructuredTestCase | null;
}

export interface TestResultsDocument {
  version: string;
  run_id: string;
  results: TestCaseResult[];
  case_change_history?: TestCaseChangeHistoryEntry[];
  case_events?: import("./caseRevision").CaseChangeEvent[];
  tombstones?: Array<{ event_id: string; case_id: string; case: StructuredTestCase | null; result: TestCaseResult | null; reason: string | null; deleted_at: string }>;
  result_history?: Array<{ event_id: string; case: StructuredTestCase; result: TestCaseResult }>;
  updated_at: string;
  [key: string]: unknown;
}

export interface TestRunStats {
  registered: number;
  applicable: number;
  deleted: number;
  needs_retest: number;
  pass_rate: number | null;
  total: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  not_executed: number;
  not_applicable: number;
  progress: number;
}

export const AI_TASK_TYPES = [
  "requirement_inventory",
  "requirement_analysis",
  "question_extraction",
  "answer_impact_analysis",
  "test_plan_generation",
  "testcase_directory_suggestion",
  "testcase_generation",
  "testcase_validation",
  "coverage_check",
  "dev_impact_comparison",
  "review_revision_suggestion",
  "xmind_export",
  "report_generation",
  "knowledge_distillation",
] as const;

export type AiTaskType = typeof AI_TASK_TYPES[number];

export interface AiTaskFile {
  path: string;
  fingerprint: string;
  role: string;
}

export interface AiKnowledgeScope {
  scope: "general" | "platform" | "requirement";
  platform: string | null;
}

export interface AiTaskDraft {
  task_type: AiTaskType;
  platform_id: string;
  requirement_id: string;
  objective: string;
  acceptance_criteria: string[];
  input_files: Array<{ path: string; role: string }>;
  knowledge_scope: AiKnowledgeScope[];
  allowed_paths: string[];
  forbidden_paths: string[];
  output_dir: string;
  output_schema: Record<string, unknown> | null;
  lock_requirement: boolean;
  prompt_override?: string | null;
  execution_mode?: "external" | "builtin" | string;
}

export type AiTaskStatus = "pending" | "running" | "waiting_review" | "completed" | "failed" | string;
export type AiTaskReviewStatus = "pending" | "accepted" | "rejected" | string;

export interface AiTaskProgress {
  status: AiTaskStatus;
  updated_at: string;
  message: string;
}

export interface AiTaskOutput {
  path: string;
  type: string;
  summary: string;
}

export interface AiTaskResultValidation {
  passed: boolean;
  errors: string[];
}

export interface AiTaskResult {
  outputs: AiTaskOutput[];
  summary: string;
  validation: AiTaskResultValidation;
  pending_items: string[];
}

export interface AiTaskArtifactCheck {
  path: string;
  exists: boolean;
  in_scope: boolean;
  json_valid: boolean | null;
  errors: string[];
}

export interface AiTaskValidation {
  passed: boolean;
  errors: string[];
  warnings: string[];
  out_of_scope_paths: string[];
  artifacts: AiTaskArtifactCheck[];
}

export interface AiTaskInfo {
  task_id: string;
  task_type: AiTaskType;
  platform_id: string;
  requirement_id: string;
  status: AiTaskStatus;
  created_at: string;
  updated_at: string;
  objective: string;
  acceptance_criteria: string[];
  task_dir: string;
  input_files: AiTaskFile[];
  knowledge_scope: AiKnowledgeScope[];
  allowed_paths: string[];
  forbidden_paths: string[];
  output_dir: string;
  output_schema: Record<string, unknown> | null;
  lock_requirement: boolean;
  requirement_locked: boolean;
  execution_mode: string;
  dispatch_text: string;
  progress: AiTaskProgress;
  result: AiTaskResult;
  file_changes: FileChanges;
  validation: AiTaskValidation;
  artifact_count: number;
  awaiting_confirmation: boolean;
  review_status: AiTaskReviewStatus;
  review_note: string;
}

export interface AiTaskActionResult {
  task: AiTaskInfo;
  requirement: RequirementMeta | null;
  warnings: string[];
}

export type KnowledgeScope = "general" | "platform" | "requirement";
export type KnowledgeType = "business_rule" | "page_state" | "api_data" | "test_strategy" | "historical_issue" | string;
export type KnowledgeEvidenceStatus = "requirement_confirmed" | "verified_current" | "prototype_target" | "integration_pending" | "business_pending" | string;
export type KnowledgeStatus = "candidate" | "published" | "rejected" | "deprecated";
export type KnowledgeSourceKind = "question_answer" | "xmind_change" | "case_review" | "test_execution" | "ai_distillation" | string;

export interface KnowledgeSourceRef {
  path: string;
  kind: KnowledgeSourceKind;
  label: string;
  locator: string;
}

export interface KnowledgeItemSnapshot {
  id: string;
  title: string;
  body: string;
  scope: KnowledgeScope;
  platform_id: string | null;
  requirement_id: string | null;
  knowledge_type: KnowledgeType;
  evidence_status: KnowledgeEvidenceStatus;
  source_refs: KnowledgeSourceRef[];
  applicable_version: string;
  effective_at: string | null;
  expires_at: string | null;
  tags: string[];
  status: KnowledgeStatus;
  version: number;
}

export interface KnowledgeHistoryEntry {
  version: number;
  action: string;
  changed_at: string;
  changed_by: string;
  note: string;
  snapshot: KnowledgeItemSnapshot;
}

export interface KnowledgeItem extends KnowledgeItemSnapshot {
  created_at: string;
  updated_at: string;
  created_by: "user" | "ai" | "discovery" | string;
  published_at: string | null;
  published_path: string | null;
  review_note: string;
  history: KnowledgeHistoryEntry[];
}

export interface KnowledgeCandidateRegistry {
  version: string;
  registry_type: "candidate";
  platform_id: string;
  requirement_id: string;
  updated_at: string;
  candidates: KnowledgeItem[];
  [key: string]: unknown;
}

export interface KnowledgeRegistry {
  version: string;
  registry_type: "published";
  scope: "general" | "platform";
  platform_id: string | null;
  updated_at: string;
  items: KnowledgeItem[];
  [key: string]: unknown;
}

export interface KnowledgeRecord extends KnowledgeItem {
  record_kind: "candidate" | "published";
  storage_path: string;
  requirement_locked: boolean;
}

// —— BB-16D：运行日志 ——

export type WorkspaceLogLevel = "info" | "warning" | "error" | string;

/** 客户端审计日志输入：固定字段，detail 只保存摘要文本 */
export interface WorkspaceLogInput {
  level: WorkspaceLogLevel;
  module: string;
  action: string;
  result: string;
  detail: string;
}

/** 归一化后的运行日志记录（兼容客户端 JSONL 与业务操作 JSON） */
export interface WorkspaceLogRecord {
  file: string;
  line: number;
  occurred_at: string;
  level: WorkspaceLogLevel;
  module: string;
  action: string;
  result: string;
  detail: string;
}

export interface WorkspaceLogFileError {
  file: string;
  message: string;
}

export interface WorkspaceLogList {
  entries: WorkspaceLogRecord[];
  errors: WorkspaceLogFileError[];
}

export interface KnowledgeDiscoveryResult {
  candidates: KnowledgeItem[];
  source_count: number;
  skipped_count: number;
}

// —— BB-16F：全局搜索 ——

/** search_workspace 返回的单条结果；result_type 决定前端打开与定位方式 */
export type WorkspaceSearchResultType =
  | "requirement"
  | "file"
  | "case"
  | "ai_task"
  | "run"
  | "report"
  | "knowledge"
  | string;

export interface WorkspaceSearchResult {
  result_type: WorkspaceSearchResultType;
  title: string;
  subtitle: string;
  /** 绝对路径：file 为文件本身，业务对象为载体文件或目录 */
  path: string;
  platform_id: string | null;
  requirement_id: string | null;
  /** caseId / taskId / runId / reportId / knowledgeId */
  object_id: string | null;
  /** 命中字段说明或文本片段 */
  matched_text: string;
  /** 知识条目作用域（general/platform/requirement），其他类型为 null */
  scope: string | null;
  is_directory: boolean;
  score: number;
}
