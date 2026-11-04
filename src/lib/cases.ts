import {
  CASE_AUTOMATION_STATUSES,
  CASE_STATUSES,
  CASE_TEST_TYPES,
  type CaseDiffResult,
  type CaseDirectoryNode,
  type CasePriority,
  type CasesDocument,
  type StructuredCaseStep,
  type StructuredCaseOwnerValue,
  type StructuredTestCase,
} from "./types";

export function createCaseId(prefix = "case"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeCasesDocument(value: unknown, requirementId: string, platformName: string, platformId?: string): CasesDocument {
  const raw = isRecord(value) ? value : {};
  const tree = normalizeDirectoryNode(raw.tree, `directory-${requirementId || "root"}`, true);
  const directoryIds = new Set(collectDirectoryNodes(tree).map((node) => node.id));
  const rawCases = Array.isArray(raw.cases) ? raw.cases : [];
  const cases = rawCases.filter(isRecord).map((item, index) => normalizeCase(item, tree.id, index, directoryIds));
  const rawMetadata = isRecord(raw.metadata) ? raw.metadata : {};
  return {
    ...raw,
    version: typeof raw.version === "string" ? raw.version : "1.0",
    requirement_id: typeof raw.requirement_id === "string" && raw.requirement_id.trim() ? raw.requirement_id : requirementId,
    platform: typeof raw.platform === "string" && raw.platform.trim() ? raw.platform : platformName,
    ...(typeof raw.platform_id === "string" && raw.platform_id.trim() ? { platform_id: raw.platform_id } : platformId ? { platform_id: platformId } : {}),
    tree,
    cases,
    metadata: {
      ...rawMetadata,
      total_count: cases.length,
      directory_count: collectDirectoryNodes(tree).length,
    },
  };
}

export function updateCasesMetadata(document: CasesDocument, updatedAt = new Date().toISOString()): CasesDocument {
  return {
    ...document,
    metadata: {
      ...(document.metadata || {}),
      total_count: document.cases.length,
      directory_count: collectDirectoryNodes(document.tree).length,
      last_modified: updatedAt,
    },
  };
}

export function collectDirectoryNodes(node: CaseDirectoryNode): CaseDirectoryNode[] {
  if (node.node_type === "case_ref") return [];
  return [node, ...node.children.flatMap(collectDirectoryNodes)];
}

export function findDirectoryNode(node: CaseDirectoryNode, id: string): CaseDirectoryNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const match = findDirectoryNode(child, id);
    if (match) return match;
  }
  return null;
}

export function directoryIds(node: CaseDirectoryNode): string[] {
  return collectDirectoryNodes(node).map((item) => item.id);
}

export function caseDirectoryIds(node: CaseDirectoryNode): Set<string> {
  return new Set(directoryIds(node));
}

export function cloneCasesDocument(document: CasesDocument): CasesDocument {
  return JSON.parse(JSON.stringify(document)) as CasesDocument;
}

export function parseListValue(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function listValue(values: string[]): string {
  return values.join(", ");
}

export function normalizePriority(value: unknown): CasePriority {
  const numeric = Number(value);
  return numeric === 0 || numeric === 1 ? numeric : 2;
}

export function priorityLabel(priority: number): string {
  return `P${normalizePriority(priority)}`;
}

export function automationLabel(value: string): string {
  return ({ none: "未规划", planned: "已规划", in_progress: "进行中", completed: "已完成" } as Record<string, string>)[value] || value;
}

export function statusLabel(value: string): string {
  return ({ draft: "草稿", pending_review: "待评审", confirmed: "已确认", deprecated: "已废弃" } as Record<string, string>)[value] || value;
}

export async function fingerprintCases(document: CasesDocument): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function compareCaseDocuments(before: CasesDocument, after: CasesDocument): CaseDiffResult {
  const beforeMap = new Map(before.cases.map((item) => [item.id, item]));
  const afterMap = new Map(after.cases.map((item) => [item.id, item]));
  const added = [...afterMap.values()]
    .filter((item) => !beforeMap.has(item.id))
    .map((item) => ({ id: item.id, title: item.title, fields: ["新增"], after: item }));
  const deleted = [...beforeMap.values()]
    .filter((item) => !afterMap.has(item.id))
    .map((item) => ({ id: item.id, title: item.title, fields: ["删除"], before: item }));
  const modified: CaseDiffResult["modified"] = [];
  const moved: CaseDiffResult["moved"] = [];

  for (const [id, previous] of beforeMap) {
    const current = afterMap.get(id);
    if (!current) continue;
    const fields = changedCaseFields(previous, current);
    if (fields.length) modified.push({ id, title: current.title, fields, before: previous, after: current });
    if (previous.directory_id !== current.directory_id) {
      moved.push({ id, title: current.title, fields: ["目录移动"], before: previous, after: current });
    }
  }
  return { added, deleted, modified, moved };
}

export function caseActions(item: Pick<StructuredTestCase, "steps">): string[] {
  return item.steps.map((step) => step.action).filter((value) => value.trim());
}

export function caseExpectedResults(item: Pick<StructuredTestCase, "steps"> & { expected_results?: string[] }): string[] {
  return Array.isArray(item.expected_results) ? item.expected_results : item.steps.flatMap((step) => step.expected);
}

export function changedCaseFields(before: StructuredTestCase, after: StructuredTestCase): string[] {
  const fields: string[] = [];
  if (before.title !== after.title) fields.push("标题");
  if (before.priority !== after.priority) fields.push("优先级");
  if (before.test_type !== after.test_type) fields.push("测试类型");
  if (!sameValue(before.preconditions, after.preconditions)) fields.push("前置条件");
  if (!sameValue(caseActions(before), caseActions(after))) fields.push("操作步骤");
  if (!sameValue(caseExpectedResults(before), caseExpectedResults(after))) fields.push("期望结果");
  if (!sameValue(before.tags, after.tags)) fields.push("标签");
  if (!sameValue(before.owners || [], after.owners || [])) fields.push("负责人");
  if (!sameValue(before.platforms, after.platforms)) fields.push("适用平台/端");
  if (!sameValue(before.requirement_refs, after.requirement_refs)) fields.push("关联需求点");
  if (before.requires_evidence !== after.requires_evidence) fields.push("证据要求");
  if (before.automation_status !== after.automation_status) fields.push("自动化状态");
  if (before.status !== after.status) fields.push("用例状态");
  return fields;
}

export function newCase(directoryId: string): StructuredTestCase {
  return {
    id: createCaseId(),
    title: "tc-p2-功能测试: 新测试场景",
    directory_id: directoryId,
    priority: 2,
    test_type: "功能测试",
    preconditions: [],
    steps: [{ order: 1, action: "", expected: [] }],
    expected_results: [],
    owners: [],
    tags: [],
    platforms: [],
    requirement_refs: [],
    asset_refs: [],
    requires_evidence: false,
    automation_status: "none",
    created_by: "manual",
    version: 1,
    status: "draft",
  };
}

export function newDirectory(title: string, nodeType: "module" | "section" = "module"): CaseDirectoryNode {
  return { id: createCaseId("directory"), title, node_type: nodeType, children: [] };
}

function normalizeDirectoryNode(value: unknown, fallbackId: string, isRoot = false): CaseDirectoryNode {
  const raw = isRecord(value) ? value : {};
  const children = Array.isArray(raw.children)
    ? raw.children.filter(isRecord).map((child, index) => normalizeDirectoryNode(child, `${fallbackId}-${index}`))
    : [];
  return {
    ...raw,
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : fallbackId,
    title: typeof raw.title === "string" ? raw.title : "未命名目录",
    node_type: typeof raw.node_type === "string" && raw.node_type.trim() ? raw.node_type : isRoot ? "platform" : "module",
    children,
  };
}

function normalizeCase(raw: Record<string, unknown>, rootId: string, index: number, directoryIds: Set<string>): StructuredTestCase {
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  const normalizedSteps = rawSteps.filter(isRecord).map((step, stepIndex) => normalizeStep(step, stepIndex));
  const expectedResults = Array.isArray(raw.expected_results) ? stringArray(raw.expected_results) : normalizedSteps.flatMap((step) => step.expected);
  const steps = expectedResults.length && normalizedSteps.length
    ? normalizedSteps.map((step, stepIndex) => ({ ...step, expected: stepIndex === normalizedSteps.length - 1 ? expectedResults : [] }))
    : normalizedSteps;
  const directoryId = typeof raw.directory_id === "string" && directoryIds.has(raw.directory_id) ? raw.directory_id : rootId;
  return {
    ...raw,
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : createCaseId(`case-${index}`),
    title: typeof raw.title === "string" ? raw.title : "未命名测试用例",
    directory_id: directoryId,
    priority: normalizePriority(raw.priority),
    test_type: typeof raw.test_type === "string" && raw.test_type.trim() ? raw.test_type : CASE_TEST_TYPES[0],
    preconditions: stringArray(raw.preconditions),
    steps,
    expected_results: expectedResults,
    ...(Array.isArray(raw.owners)
      ? {
          owners: raw.owners.filter((owner) => typeof owner === "string" || isRecord(owner)) as StructuredCaseOwnerValue[],
        }
      : {}),
    tags: stringArray(raw.tags),
    platforms: stringArray(raw.platforms),
    requirement_refs: stringArray(raw.requirement_refs),
    asset_refs: stringArray(raw.asset_refs),
    requires_evidence: raw.requires_evidence === true,
    automation_status: typeof raw.automation_status === "string" && CASE_AUTOMATION_STATUSES.includes(raw.automation_status as typeof CASE_AUTOMATION_STATUSES[number]) ? raw.automation_status : "none",
    created_by: typeof raw.created_by === "string" ? raw.created_by : "manual",
    version: Number.isInteger(raw.version) && Number(raw.version) > 0 ? Number(raw.version) : 1,
    status: typeof raw.status === "string" && CASE_STATUSES.includes(raw.status as typeof CASE_STATUSES[number]) ? raw.status : "draft",
  };
}

function normalizeStep(raw: Record<string, unknown>, index: number): StructuredCaseStep {
  return {
    order: Number.isInteger(raw.order) ? Number(raw.order) : index + 1,
    action: typeof raw.action === "string" ? raw.action : "",
    expected: stringArray(raw.expected),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
