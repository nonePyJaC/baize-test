import { defectSummary } from "../domain/integrations";
import { api, joinPath } from "./api";
import type {
  KnowledgeCandidateRegistry,
  KnowledgeDiscoveryResult,
  KnowledgeEvidenceStatus,
  KnowledgeHistoryEntry,
  KnowledgeItem,
  KnowledgeItemSnapshot,
  KnowledgeRegistry,
  KnowledgeScope,
  KnowledgeSourceKind,
  KnowledgeSourceRef,
  KnowledgeStatus,
  KnowledgeType,
  PlatformInfo,
  Question,
  RequirementMeta,
  WorkspaceConfig,
} from "./types";

export const KNOWLEDGE_PROTOCOL_VERSION = "1.0";
export const KNOWLEDGE_CANDIDATE_DIRECTORY = "08-知识候选";
export const KNOWLEDGE_CANDIDATE_FILE = "knowledge-candidates.json";
export const KNOWLEDGE_REGISTRY_FILE = "knowledge.json";

export const KNOWLEDGE_TYPE_OPTIONS: Array<{ value: KnowledgeType; label: string }> = [
  { value: "business_rule", label: "业务规则" },
  { value: "page_state", label: "页面现状" },
  { value: "api_data", label: "接口数据" },
  { value: "test_strategy", label: "测试策略" },
  { value: "historical_issue", label: "历史问题" },
];

export const KNOWLEDGE_EVIDENCE_OPTIONS: Array<{ value: KnowledgeEvidenceStatus; label: string }> = [
  { value: "requirement_confirmed", label: "需求已确认" },
  { value: "verified_current", label: "现状已验证" },
  { value: "prototype_target", label: "原型目标" },
  { value: "integration_pending", label: "联调待验证" },
  { value: "business_pending", label: "待业务确认" },
];

export const KNOWLEDGE_STATUS_OPTIONS: Array<{ value: KnowledgeStatus; label: string }> = [
  { value: "candidate", label: "候选" },
  { value: "published", label: "已发布" },
  { value: "rejected", label: "已拒绝" },
  { value: "deprecated", label: "已废弃" },
];

export const KNOWLEDGE_SCOPE_OPTIONS: Array<{ value: KnowledgeScope; label: string }> = [
  { value: "general", label: "通用" },
  { value: "platform", label: "客户平台" },
  { value: "requirement", label: "具体需求" },
];

export interface KnowledgeSourceCandidateContext {
  platform: PlatformInfo;
  requirement: RequirementMeta;
  requirementPath: string;
}

interface CandidateInput {
  id: string;
  title: string;
  body: string;
  platformId: string;
  requirementId: string;
  sourceRefs: KnowledgeSourceRef[];
  scope?: KnowledgeScope;
  knowledgeType?: KnowledgeType;
  evidenceStatus?: KnowledgeEvidenceStatus;
  applicableVersion?: string;
  createdBy?: "user" | "ai" | "discovery" | string;
}

export function emptyKnowledgeCandidateRegistry(platformId = "", requirementId = ""): KnowledgeCandidateRegistry {
  return {
    version: KNOWLEDGE_PROTOCOL_VERSION,
    registry_type: "candidate",
    platform_id: platformId,
    requirement_id: requirementId,
    updated_at: new Date(0).toISOString(),
    candidates: [],
  };
}

export function emptyKnowledgeRegistry(scope: "general" | "platform", platformId: string | null = null): KnowledgeRegistry {
  return {
    version: KNOWLEDGE_PROTOCOL_VERSION,
    registry_type: "published",
    scope,
    platform_id: platformId,
    updated_at: new Date(0).toISOString(),
    items: [],
  };
}

export function candidateRegistryPath(rootPath: string, platformPath: string, requirementId: string): string {
  return joinPath(rootPath, platformPath, requirementId, KNOWLEDGE_CANDIDATE_DIRECTORY, KNOWLEDGE_CANDIDATE_FILE);
}

export function knowledgeDirectoryPath(rootPath: string, workspace: WorkspaceConfig, scope: "general" | "platform", platformId?: string): string {
  const root = workspace.directories.knowledge || "knowledge";
  if (scope === "general") return joinPath(rootPath, root, "通用");
  const platform = workspace.platforms.find((item) => item.id === platformId);
  return joinPath(rootPath, platform?.knowledge_path || joinPath(root, platformId || "unknown"));
}

export function knowledgeRegistryPath(rootPath: string, workspace: WorkspaceConfig, scope: "general" | "platform", platformId?: string): string {
  return joinPath(knowledgeDirectoryPath(rootPath, workspace, scope, platformId), KNOWLEDGE_REGISTRY_FILE);
}

export function knowledgeItemSnapshot(item: KnowledgeItem): KnowledgeItemSnapshot {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    scope: item.scope,
    platform_id: item.platform_id,
    requirement_id: item.requirement_id,
    knowledge_type: item.knowledge_type,
    evidence_status: item.evidence_status,
    source_refs: item.source_refs.map((source) => ({ ...source })),
    applicable_version: item.applicable_version,
    effective_at: item.effective_at,
    expires_at: item.expires_at,
    tags: [...item.tags],
    status: item.status,
    version: item.version,
  };
}

export function withKnowledgeHistory(
  item: KnowledgeItem,
  patch: Partial<KnowledgeItem>,
  action: string,
  note: string,
  changedBy = "用户",
  now = new Date().toISOString(),
): KnowledgeItem {
  const nextVersion = Math.max(item.version + 1, 1);
  const history: KnowledgeHistoryEntry = {
    version: item.version,
    action,
    changed_at: now,
    changed_by: changedBy,
    note: note.trim(),
    snapshot: knowledgeItemSnapshot(item),
  };
  return {
    ...item,
    ...patch,
    version: nextVersion,
    updated_at: now,
    history: [...item.history, history],
  };
}

export function normalizeKnowledgeItem(value: unknown, fallbackId: string): KnowledgeItem {
  const raw = asRecord(value);
  const scope = isKnowledgeScope(raw?.scope) ? raw.scope : "requirement";
  const status = isKnowledgeStatus(raw?.status) ? raw.status : "candidate";
  const createdAt = stringValue(raw?.created_at, new Date(0).toISOString());
  const sourceRefs = normalizeSourceRefs(raw?.source_refs);
  const history = Array.isArray(raw?.history)
    ? raw.history.filter(isRecord).map((entry) => normalizeHistoryEntry(entry, fallbackId))
    : [];
  return {
    id: stringValue(raw?.id, fallbackId),
    title: stringValue(raw?.title, "未命名知识"),
    body: typeof raw?.body === "string" ? raw.body : "",
    scope,
    platform_id: nullableString(raw?.platform_id),
    requirement_id: nullableString(raw?.requirement_id),
    knowledge_type: stringValue(raw?.knowledge_type, "business_rule"),
    evidence_status: stringValue(raw?.evidence_status, "business_pending"),
    source_refs: sourceRefs,
    applicable_version: stringValue(raw?.applicable_version, ""),
    effective_at: nullableString(raw?.effective_at),
    expires_at: nullableString(raw?.expires_at),
    tags: stringArray(raw?.tags),
    status,
    version: positiveInteger(raw?.version, 1),
    created_at: createdAt,
    updated_at: stringValue(raw?.updated_at, createdAt),
    created_by: stringValue(raw?.created_by, "discovery"),
    published_at: nullableString(raw?.published_at),
    published_path: nullableString(raw?.published_path),
    review_note: typeof raw?.review_note === "string" ? raw.review_note : "",
    history,
  };
}

export function normalizeKnowledgeCandidateRegistry(value: unknown, platformId: string, requirementId: string): KnowledgeCandidateRegistry {
  const raw = asRecord(value);
  const candidates = Array.isArray(raw?.candidates)
    ? raw.candidates.filter(isRecord).map((item, index) => normalizeKnowledgeItem(item, `knowledge-candidate-${index}`))
    : [];
  return {
    ...(raw || {}),
    version: stringValue(raw?.version, KNOWLEDGE_PROTOCOL_VERSION),
    registry_type: "candidate",
    platform_id: stringValue(raw?.platform_id, platformId),
    requirement_id: stringValue(raw?.requirement_id, requirementId),
    updated_at: stringValue(raw?.updated_at, new Date(0).toISOString()),
    candidates,
  };
}

export function normalizeKnowledgeRegistry(value: unknown, scope: "general" | "platform", platformId: string | null): KnowledgeRegistry {
  const raw = asRecord(value);
  const items = Array.isArray(raw?.items)
    ? raw.items.filter(isRecord).map((item, index) => normalizeKnowledgeItem(item, `knowledge-${index}`))
    : [];
  return {
    ...(raw || {}),
    version: stringValue(raw?.version, KNOWLEDGE_PROTOCOL_VERSION),
    registry_type: "published",
    scope,
    platform_id: nullableString(raw?.platform_id) || platformId,
    updated_at: stringValue(raw?.updated_at, new Date(0).toISOString()),
    items,
  };
}

export function createKnowledgeCandidate(input: CandidateInput, now = new Date().toISOString()): KnowledgeItem {
  return normalizeKnowledgeItem({
    id: input.id,
    title: input.title,
    body: input.body,
    scope: input.scope || "requirement",
    platform_id: input.platformId,
    requirement_id: input.requirementId,
    knowledge_type: input.knowledgeType || "business_rule",
    evidence_status: input.evidenceStatus || "business_pending",
    source_refs: input.sourceRefs,
    applicable_version: input.applicableVersion || "",
    effective_at: null,
    expires_at: null,
    tags: [],
    status: "candidate",
    version: 1,
    created_at: now,
    updated_at: now,
    created_by: input.createdBy || "discovery",
    published_at: null,
    published_path: null,
    review_note: "",
    history: [],
  }, input.id);
}

export function sourceRefKey(sourceRefs: KnowledgeSourceRef[]): string {
  return sourceRefs
    .map((source) => `${normalizePath(source.path)}#${source.kind}#${source.locator}`)
    .sort()
    .join("|");
}

export function knowledgeStatusLabel(value: string): string {
  return KNOWLEDGE_STATUS_OPTIONS.find((item) => item.value === value)?.label || value || "未知";
}

export function knowledgeScopeLabel(value: string, platforms: PlatformInfo[] = []): string {
  if (value === "general") return "通用";
  if (value === "platform") return "客户平台";
  if (value === "requirement") return "具体需求";
  return platforms.find((platform) => platform.id === value)?.name || value;
}

export function knowledgeTypeLabel(value: string): string {
  return KNOWLEDGE_TYPE_OPTIONS.find((item) => item.value === value)?.label || value || "未分类";
}

export function knowledgeEvidenceLabel(value: string): string {
  return KNOWLEDGE_EVIDENCE_OPTIONS.find((item) => item.value === value)?.label || value || "待补充";
}

export function sourceKindLabel(value: string): string {
  const labels: Record<string, string> = {
    question_answer: "疑问答复",
    xmind_change: "XMind修改",
    case_review: "用例评审",
    test_execution: "测试执行",
    ai_distillation: "AI蒸馏",
  };
  return labels[value] || value || "来源文件";
}

export function stableKnowledgeId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function workspaceRelativePath(rootPath: string, targetPath: string): string {
  const root = normalizePath(rootPath);
  const target = normalizePath(targetPath);
  if (target === root) return ".";
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  return target;
}

export function resolveWorkspacePath(rootPath: string, path: string): string {
  return isAbsolutePath(path) ? path : joinPath(rootPath, path);
}

export async function discoverKnowledgeCandidates(
  workspace: WorkspaceConfig,
  targetPlatformId = "all",
  targetRequirementId = "all",
): Promise<KnowledgeDiscoveryResult> {
  const rootPath = workspace.workspace.root_path;
  const contexts = await loadRequirementContexts(workspace, targetPlatformId, targetRequirementId);
  const candidates: KnowledgeItem[] = [];
  let sourceCount = 0;

  for (const context of contexts) {
    const discovered = await discoverRequirementSources(workspace, context);
    candidates.push(...discovered);
    sourceCount += discovered.length;
  }

  for (const context of contexts) {
    const entries = await api.listDirectory(joinPath(context.requirementPath,"08-知识候选")).catch(()=>[]);
    for (const entry of entries.filter(e => !e.is_dir && /^knowledge-proposal-.*\.json$/.test(e.name))) {
      const proposal = asRecord(await readOptionalJson(entry.path));
      if (proposal?.registry_type !== "candidate") continue;
      for (const [index,record] of distillationRecords(proposal).entries()) {
        const originalRefs: KnowledgeSourceRef[] = Array.isArray(record.source_refs) ? record.source_refs.flatMap(ref => typeof ref === "string" ? [sourceRef(ref,"ai_distillation","提案证据","")] : isRecord(ref) ? [ref as unknown as KnowledgeSourceRef] : []) : [];
        candidates.push(createKnowledgeCandidate({
          id:stableKnowledgeId("knowledge-session",`${entry.path}#${record.id || index}`),
          title:stringValue(record.title,`会话知识提案 ${index+1}`),
          body:[stringValue(record.body ?? record.content,""),`新旧规则差异：${JSON.stringify(record.rule_diff ?? "待补充")}`,`适用范围：${JSON.stringify(record.applicable_scope ?? "待确认")}`].join("\n"),
          platformId:context.platform.id,requirementId:context.requirement.requirement.id,
          sourceRefs:[sourceRef(workspaceRelativePath(rootPath,entry.path),"ai_distillation","AI会话知识提案",String(record.id || index)),...originalRefs],
          evidenceStatus:stringValue(record.evidence_status,"business_pending"),createdBy:"ai",
        }));
      }
    }
  }
  const aiCandidates = await discoverAiDistillationSources(workspace, contexts);
  candidates.push(...aiCandidates);
  sourceCount += aiCandidates.length;

  return { candidates, source_count: sourceCount, skipped_count: 0 };
}

async function loadRequirementContexts(workspace: WorkspaceConfig, targetPlatformId: string, targetRequirementId: string): Promise<KnowledgeSourceCandidateContext[]> {
  const contexts: KnowledgeSourceCandidateContext[] = [];
  for (const platform of workspace.platforms) {
    if (targetPlatformId !== "all" && platform.id !== targetPlatformId) continue;
    const requirements = await api.scanRequirements(workspace.workspace.root_path, platform.path).catch(() => []);
    for (const requirement of requirements) {
      if (targetRequirementId !== "all" && requirement.requirement.id !== targetRequirementId) continue;
      contexts.push({
        platform,
        requirement,
        requirementPath: joinPath(workspace.workspace.root_path, platform.path, requirement.requirement.id),
      });
    }
  }
  return contexts;
}

async function discoverRequirementSources(workspace: WorkspaceConfig, context: KnowledgeSourceCandidateContext): Promise<KnowledgeItem[]> {
  const candidates: KnowledgeItem[] = [];
  const rootPath = workspace.workspace.root_path;
  const requirementId = context.requirement.requirement.id;
  const platformId = context.platform.id;
  const questionsPath = joinPath(context.requirementPath, "02-需求理解与答疑", "questions.json");
  const questions = await readOptionalJson(questionsPath);
  if (questions) {
    const questionRecord = asRecord(questions);
    const questionItems: unknown[] = questionRecord && Array.isArray(questionRecord.questions) ? questionRecord.questions : [];
    for (const value of questionItems) {
      const question = asRecord(value) as Partial<Question> | null;
      if (!question || question.status !== "answered" || typeof question.answer !== "string" || !question.answer.trim()) continue;
      const answer = question.answer_format === "richtext_json" ? richTextToText(question.answer) : question.answer.trim();
      if (!answer.trim()) continue;
      const source = typeof question.source === "string" ? question.source : "";
      candidates.push(createKnowledgeCandidate({
        id: stableKnowledgeId("knowledge-question", `${platformId}/${requirementId}/${question.id || question.question}`),
        title: `疑问答复：${String(question.question || "未命名疑问")}`,
        body: [`问题：${String(question.question || "")}`, "", `回答：${answer}`, source ? `来源标记：${source}` : ""].filter(Boolean).join("\n"),
        platformId,
        requirementId,
        sourceRefs: [sourceRef(workspaceRelativePath(rootPath, questionsPath), "question_answer", "疑问答复", String(question.id || question.question || ""))],
        knowledgeType: "business_rule",
        evidenceStatus: questionEvidenceStatus(source),
      }));
    }
  }

  const changeFiles = await discoverXMindChangeFiles(context.requirementPath, rootPath);
  for (const file of changeFiles) {
    const records = await readXMindChanges(file.path);
    if (!records.length) continue;
    for (const record of records) {
      if (record.origin === "system" || record.source === "ai_regeneration" || !String(record.reason || "").trim()) continue;
      const before = asRecord(record.before);
      const after = asRecord(record.after);
      const caseId = stringValue(record.caseId ?? record.case_id, "");
      const locator = stringValue(record.id, caseId || "change");
      const title = stringValue(after?.title, stringValue(before?.title, caseId || "未命名用例"));
      const changedFields = stringArray(record.changedFields ?? record.changed_fields);
      const body = [
        `用例：${title}`,
        changedFields.length ? `修改字段：${changedFields.join("、")}` : "",
        "",
        "修改前：",
        JSON.stringify(before || {}, null, 2),
        "",
        "修改后：",
        JSON.stringify(after || {}, null, 2),
      ].filter(Boolean).join("\n");
      candidates.push(createKnowledgeCandidate({
        id: stableKnowledgeId("knowledge-xmind", `${file.path}#${locator}`),
        title: `XMind用例修改：${title}`,
        body,
        platformId,
        requirementId,
        sourceRefs: [sourceRef(workspaceRelativePath(rootPath, file.path), "xmind_change", "XMind修改记录", locator)],
        knowledgeType: "test_strategy",
        evidenceStatus: "business_pending",
      }));
    }
  }

  const reviewRoots = [joinPath(context.requirementPath, "03-测试计划", "reviews"), joinPath(context.requirementPath, "04-测试用例", "reviews")];
  const reviewFiles = (await Promise.all(reviewRoots.map((reviewsPath) => listFilesRecursive(reviewsPath, (path) => /\.(md|markdown|json)$/i.test(path))))).flat();
  for (const file of reviewFiles) {
    const content = await readSourceContent(file.path);
    if (!content.trim()) continue;
    const title = firstMarkdownHeading(content) || file.name.replace(/\.[^.]+$/, "");
    candidates.push(createKnowledgeCandidate({
      id: stableKnowledgeId("knowledge-review", `${file.path}`),
      title: `用例评审：${title}`,
      body: content.trim(),
      platformId,
      requirementId,
      sourceRefs: [sourceRef(workspaceRelativePath(rootPath, file.path), "case_review", "用例评审记录", "")],
      knowledgeType: "test_strategy",
      evidenceStatus: "business_pending",
    }));
  }

  const executionPath = joinPath(context.requirementPath, "06-测试执行与证据");
  const runEntries = await api.listDirectory(executionPath).catch(() => []);
  for (const runEntry of runEntries.filter((entry) => entry.is_dir)) {
    const runPath = runEntry.path;
    const runValue = await readOptionalJson(joinPath(runPath, "run.json"));
    const resultsValue = await readOptionalJson(joinPath(runPath, "results.json"));
    const resultsRecord = asRecord(resultsValue);
    const results: unknown[] = resultsRecord && Array.isArray(resultsRecord.results) ? resultsRecord.results : [];
    const snapshotValue = await readOptionalJson(joinPath(runPath, "cases-snapshot.json"));
    const caseTitles = new Map<string, string>();
    const snapshotRecord = asRecord(snapshotValue);
    const snapshotCases: unknown[] = snapshotRecord && Array.isArray(snapshotRecord.cases) ? snapshotRecord.cases : [];
    for (const item of snapshotCases) {
      const record = asRecord(item);
      if (record && typeof record.id === "string") caseTitles.set(record.id, stringValue(record.title, record.id));
    }
    const meaningfulResults = results.filter((value) => {
      const result = asRecord(value);
      return result && ["failed", "blocked", "passed"].includes(String(result.status)) && (result.status !== "passed" || String(result.actual_result || result.notes || "").trim());
    });
    const selectedResults = meaningfulResults.length ? meaningfulResults : results.filter((value) => asRecord(value)?.status === "passed").slice(0, 1);
    for (const value of selectedResults) {
      const result = asRecord(value);
      if (!result || result.deleted || result.needs_retest) continue;
      const caseId = stringValue(result.case_id, "unknown-case");
      const status = stringValue(result.status, "unknown");
      const title = caseTitles.get(caseId) || caseId;
      const body = [
        `测试轮次：${stringValue(asRecord(runValue)?.name, runEntry.name)}`,
        `用例：${title}（${caseId}）`,
        `执行状态：${status}`,
        String(result.actual_result || "").trim() ? `实际结果：${String(result.actual_result).trim()}` : "",
        String(result.notes || "").trim() ? `备注：${String(result.notes).trim()}` : "",
        defectSummary(result) ? `缺陷引用：${defectSummary(result)}` : "",
      ].filter(Boolean).join("\n");
      candidates.push(createKnowledgeCandidate({
        id: stableKnowledgeId("knowledge-execution", `${joinPath(runPath, "results.json")}#${caseId}`),
        title: `测试执行结论：${title}`,
        body,
        platformId,
        requirementId,
        sourceRefs: [sourceRef(workspaceRelativePath(rootPath, joinPath(runPath, "results.json")), "test_execution", "测试执行结果", caseId)],
        knowledgeType: status === "failed" || status === "blocked" ? "historical_issue" : "test_strategy",
        evidenceStatus: result.case_revision != null ? "verified_current" : "business_pending",
        applicableVersion: stringValue(asRecord(runValue)?.application_versions, ""),
      }));
    }
  }

  const reportPath = joinPath(context.requirementPath, "07-测试报告");
  const reportEntries = await api.listDirectory(reportPath).catch(() => []);
  for (const reportEntry of reportEntries.filter((entry) => entry.is_dir)) {
    const manifestPath = joinPath(reportEntry.path, "report.json");
    const manifest = await readOptionalJson(manifestPath);
    if (!manifest) continue;
    const report = asRecord(manifest);
    const reportLabel = stringValue(report?.report_id, reportEntry.name);
    const risks = String(report?.risks || "").trim();
    const remaining = String(report?.remaining_issues || "").trim();
    for (const item of [
      { label: "风险", value: risks, suffix: "risk" },
      { label: "遗留问题", value: remaining, suffix: "remaining" },
    ]) {
      if (!item.value) continue;
      candidates.push(createKnowledgeCandidate({
        id: stableKnowledgeId("knowledge-report", `${manifestPath}#${item.suffix}`),
        title: `测试报告${item.label}：${reportLabel}`,
        body: item.value,
        platformId,
        requirementId,
        sourceRefs: [sourceRef(workspaceRelativePath(rootPath, manifestPath), "test_execution", "测试报告清单", item.suffix)],
        knowledgeType: item.label === "风险" ? "historical_issue" : "test_strategy",
        evidenceStatus: "verified_current",
        applicableVersion: stringValue(report?.template_version, ""),
      }));
    }
  }

  const postTestSources = [
    joinPath(context.requirementPath, "08-知识候选"),
    joinPath(context.requirementPath, "03-测试计划"),
  ];
  for (const directory of postTestSources) {
    const files = await listFilesRecursive(directory, (path) => /(?:测后总结|测试过后的几处改动|测后知识整理范例)\.(md|markdown)$/i.test(path));
    for (const file of files) {
      const content = await readSourceContent(file.path);
      if (!content.trim()) continue;
      const title = firstMarkdownHeading(content) || file.name.replace(/\.[^.]+$/, "");
      const isSourceSummary = file.name === "测后总结.md";
      const isMethodExample = file.name === "测后知识整理范例.md";
      candidates.push(createKnowledgeCandidate({
        id: stableKnowledgeId("knowledge-posttest", file.path),
        title: `${isMethodExample ? "知识整理方法" : isSourceSummary ? "测后总结" : "测后差异复核"}：${title}`,
        body: content.trim(),
        platformId,
        requirementId,
        sourceRefs: [sourceRef(workspaceRelativePath(rootPath, file.path), isMethodExample ? "case_review" : "test_execution", isMethodExample ? "测后知识整理范例" : isSourceSummary ? "用户测后总结" : "测后差异复核", "")],
        knowledgeType: isMethodExample ? "test_strategy" : isSourceSummary ? "historical_issue" : "test_strategy",
        evidenceStatus: isSourceSummary || isMethodExample ? "verified_current" : "business_pending",
        createdBy: "discovery",
      }));
    }
  }

  return candidates;
}

async function discoverAiDistillationSources(workspace: WorkspaceConfig, contexts: KnowledgeSourceCandidateContext[]): Promise<KnowledgeItem[]> {
  const rootPath = workspace.workspace.root_path;
  const tasksPath = joinPath(rootPath, workspace.directories.blackbox || ".blackbox", "tasks");
  const taskEntries = await api.listDirectory(tasksPath).catch(() => []);
  const contextMap = new Map(contexts.map((item) => [`${item.platform.id}::${item.requirement.requirement.id}`, item]));
  const candidates: KnowledgeItem[] = [];
  for (const taskEntry of taskEntries.filter((entry) => entry.is_dir)) {
    const taskPath = taskEntry.path;
    const manifestValue = await readOptionalJson(joinPath(taskPath, "manifest.json"));
    const manifest = asRecord(manifestValue);
    if (manifest?.task_type !== "knowledge_distillation") continue;
    const platformId = stringValue(manifest.platform_id ?? manifest.platform, "");
    const requirementId = stringValue(manifest.requirement_id, "");
    const context = contextMap.get(`${platformId}::${requirementId}`);
    if (!context) continue;
    const resultPath = joinPath(taskPath, "result.json");
    const resultValue = await readOptionalJson(resultPath);
    const result = asRecord(resultValue);
    if (!result) continue;
    const outputs = Array.isArray(result.outputs) ? result.outputs : [];
    let outputCount = 0;
    for (const outputValue of outputs) {
      const output = asRecord(outputValue);
      if (!output || typeof output.path !== "string") continue;
      const outputPath = resolveWorkspacePath(rootPath, output.path);
      const outputRef = sourceRef(workspaceRelativePath(rootPath, outputPath), "ai_distillation", "AI蒸馏产物", output.path);
      const rawOutput = /\.json$/i.test(outputPath) || String(output.type || "").toLowerCase() === "json"
        ? await readOptionalJson(outputPath)
        : await readOptionalText(outputPath);
      const records = distillationRecords(rawOutput);
      if (!records.length && typeof rawOutput === "string" && rawOutput.trim()) {
        records.push({ title: firstMarkdownHeading(rawOutput) || output.path.split(/[\\/]/).pop() || "AI蒸馏知识", body: rawOutput });
      }
      records.forEach((record, index) => {
        const title = stringValue(record.title, `AI蒸馏知识 ${index + 1}`);
        const body = stringValue(record.body, typeof record.content === "string" ? record.content : "");
        if (!body.trim()) return;
        const sourceRefs = [
          sourceRef(workspaceRelativePath(rootPath, resultPath), "ai_distillation", "AI任务结果", `${taskEntry.name}#${output.path}`),
          outputRef,
        ];
        candidates.push(createKnowledgeCandidate({
          id: stableKnowledgeId("knowledge-ai", `${taskEntry.name}/${output.path}/${record.id || index}`),
          title,
          body,
          platformId,
          requirementId,
          sourceRefs,
          scope: isKnowledgeScope(record.scope) ? record.scope : "requirement",
          knowledgeType: stringValue(record.knowledge_type, "business_rule"),
          evidenceStatus: stringValue(record.evidence_status, "business_pending"),
          applicableVersion: stringValue(record.applicable_version, ""),
          createdBy: "ai",
        }));
        outputCount += 1;
      });
    }
    if (outputCount === 0 && String(result.summary || "").trim()) {
      candidates.push(createKnowledgeCandidate({
        id: stableKnowledgeId("knowledge-ai", `${taskEntry.name}/summary`),
        title: `AI蒸馏结果：${stringValue(manifest.objective, taskEntry.name)}`,
        body: String(result.summary).trim(),
        platformId,
        requirementId,
        sourceRefs: [sourceRef(workspaceRelativePath(rootPath, resultPath), "ai_distillation", "AI任务结果", "summary")],
        createdBy: "ai",
      }));
    }
  }
  return candidates;
}

function distillationRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["candidates", "items", "knowledge"]) {
    if (Array.isArray(record[key])) return record[key].map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  }
  return typeof record.title === "string" || typeof record.body === "string" || typeof record.content === "string" ? [record] : [];
}

async function discoverXMindChangeFiles(requirementPath: string, rootPath: string): Promise<Array<{ path: string; name: string }>> {
  const files = await listFilesRecursive(requirementPath, (path) => /\.changes\.(json|md)$/i.test(path));
  const jsonPaths = new Set(files.filter((file) => /\.changes\.json$/i.test(file.path)).map((file) => normalizePath(file.path)));
  const withoutDuplicateMarkdown = files.filter((file) => {
    if (!/\.changes\.md$/i.test(file.path)) return true;
    const jsonPath = normalizePath(file.path).replace(/\.changes\.md$/i, ".changes.json");
    return !jsonPaths.has(jsonPath);
  });
  const casesPath = joinPath(requirementPath, "04-测试用例", "cases.json");
  const cases = await readOptionalJson(casesPath);
  const sourceFile = asRecord(asRecord(cases)?.metadata)?.source_file;
  if (typeof sourceFile === "string" && sourceFile.trim()) {
    const sourcePath = resolveWorkspacePath(rootPath, sourceFile);
    for (const sidecar of [`${sourcePath}.changes.json`, `${sourcePath}.changes.md`]) {
      if (!withoutDuplicateMarkdown.some((file) => normalizePath(file.path) === normalizePath(sidecar))) {
        const entries = await api.listDirectory(sidecar).catch(() => []);
        if (entries.length >= 0) {
          const sidecarContent = await readOptionalText(sidecar);
          if (sidecarContent !== null) withoutDuplicateMarkdown.push({ path: sidecar, name: sidecar.split(/[\\/]/).pop() || sidecar });
        }
      }
    }
  }
  return withoutDuplicateMarkdown;
}

async function readXMindChanges(path: string): Promise<Array<Record<string, unknown>>> {
  if (!/\.json$/i.test(path)) return [];
  const value = await readOptionalJson(path);
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  const record = asRecord(value);
  if (Array.isArray(record?.changes)) return record.changes.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  return [];
}

async function listFilesRecursive(directoryPath: string, predicate: (path: string) => boolean, depth = 0, output: Array<{ path: string; name: string }> = []): Promise<Array<{ path: string; name: string }>> {
  if (!directoryPath || depth > 12 || output.length >= 500) return output;
  const entries = await api.listDirectory(directoryPath).catch(() => []);
  for (const entry of entries) {
    if (output.length >= 500) break;
    if (entry.is_dir) {
      if (shouldSkipKnowledgeDirectory(entry.name)) continue;
      await listFilesRecursive(entry.path, predicate, depth + 1, output);
    } else if (predicate(entry.path)) {
      output.push({ path: entry.path, name: entry.name });
    }
  }
  return output;
}

async function readSourceContent(path: string): Promise<string> {
  if (/\.json$/i.test(path)) {
    const value = await readOptionalJson(path);
    return value === null ? "" : JSON.stringify(value, null, 2);
  }
  return (await readOptionalText(path)) || "";
}

async function readOptionalJson(path: string): Promise<unknown | null> {
  try {
    return await api.readJsonFile(path);
  } catch {
    return null;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await api.readTextFile(path);
  } catch {
    return null;
  }
}

function sourceRef(path: string, kind: KnowledgeSourceKind, label: string, locator: string): KnowledgeSourceRef {
  return { path, kind, label, locator };
}

function normalizeSourceRefs(value: unknown): KnowledgeSourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    path: stringValue(item.path, ""),
    kind: stringValue(item.kind, "source"),
    label: stringValue(item.label, "来源文件"),
    locator: stringValue(item.locator, ""),
  })).filter((item) => item.path);
}

function normalizeHistoryEntry(value: Record<string, unknown>, fallbackId: string): KnowledgeHistoryEntry {
  const snapshot = normalizeKnowledgeItem(value.snapshot, fallbackId);
  return {
    version: positiveInteger(value.version, snapshot.version),
    action: stringValue(value.action, "修改"),
    changed_at: stringValue(value.changed_at, new Date(0).toISOString()),
    changed_by: stringValue(value.changed_by, "未知"),
    note: typeof value.note === "string" ? value.note : "",
    snapshot: knowledgeItemSnapshot(snapshot),
  };
}

function questionEvidenceStatus(source: string): KnowledgeEvidenceStatus {
  if (source.includes("验证")) return "verified_current";
  if (source.includes("需求") || source.includes("产品") || source.includes("开发")) return "requirement_confirmed";
  return "business_pending";
}

function richTextToText(value: string): string {
  if (typeof DOMParser === "undefined") return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const document = new DOMParser().parseFromString(value, "text/html");
  return (document.body.textContent || "").replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
}

function firstMarkdownHeading(value: string): string {
  return value.match(/^\s*#{1,6}\s+(.+)$/m)?.[1]?.trim() || "";
}

function shouldSkipKnowledgeDirectory(name: string): boolean {
  return ["node_modules", "target", "dist", ".git", "__pycache__", "evidence", KNOWLEDGE_CANDIDATE_DIRECTORY].includes(name);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path.replace(/\\/g, "/")) || path.startsWith("/");
}

function isKnowledgeScope(value: unknown): value is KnowledgeScope {
  return value === "general" || value === "platform" || value === "requirement";
}

function isKnowledgeStatus(value: unknown): value is KnowledgeStatus {
  return value === "candidate" || value === "published" || value === "rejected" || value === "deprecated";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
