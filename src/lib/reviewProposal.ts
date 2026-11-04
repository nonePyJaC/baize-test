import { api, joinPath } from "./api";
import {
  proposeCaseRevision,
  previewCaseRevision,
  applyCaseRevision,
  readCaseChangeHistory,
  type CasePatch,
} from "./caseRevision";
import { collectDirectoryNodes, normalizeCasesDocument } from "./cases";
import type { StructuredTestCase } from "./types";
import { buildXMindBytes, parseOutline } from "./aiOutput";
import { casesDocumentToOutline, withStructuredCaseIds } from "./xmindImport";
import { validateCaseTemplate } from "./caseTemplate";

export type ReviewDecision =
  "pending" | "accepted" | "partial" | "retained" | "rejected" | "needs_qa";
export interface ReviewItem {
  item_id: string;
  target_case_id: string;
  action: "added" | "modified" | "deleted";
  before: StructuredTestCase | null;
  after: StructuredTestCase | null;
  reason: string;
  source_refs: string[];
  nature: "user_request" | "developer_suggestion" | "ai_suggestion";
  status: ReviewDecision;
  handling_reason?: string;
  event_ids?: string[];
}
export interface ReviewProposal {
  proposal_id: string;
  requirement_id: string;
  platform_id: string;
  items: ReviewItem[];
}
export function validateReviewProposal(
  raw: any,
  platformId: string,
  requirementId: string,
): ReviewProposal {
  if (
    !raw ||
    raw.platform_id !== platformId ||
    raw.requirement_id !== requirementId ||
    !raw.proposal_id ||
    !Array.isArray(raw.items) ||
    !raw.items.length
  )
    throw new Error("提案须包含唯一ID、匹配的平台/需求和非空items");
  const ids = new Set<string>();
  for (const item of raw.items) {
    if (
      !item.item_id ||
      ids.has(item.item_id) ||
      !item.target_case_id ||
      !item.reason?.trim() ||
      !Array.isArray(item.source_refs) ||
      !item.source_refs.length
    )
      throw new Error("提案条目缺少唯一ID、原因或来源");
    ids.add(item.item_id);
    if (
      !["user_request", "developer_suggestion", "ai_suggestion"].includes(
        item.nature,
      )
    )
      throw new Error("意见性质无效");
    if (
      !["added", "modified", "deleted"].includes(item.action) ||
      (item.action === "added" && (item.before !== null || !item.after)) ||
      (item.action === "deleted" && (!item.before || item.after !== null)) ||
      (item.action === "modified" && (!item.before || !item.after))
    )
      throw new Error("action与before/after不一致");
    for (const c of [item.before, item.after].filter(Boolean))
      if (
        typeof c !== "object" ||
        c.id !== item.target_case_id ||
        !Array.isArray(c.steps) ||
        !Array.isArray(c.preconditions)
      )
        throw new Error("before/after须为完整用例对象且ID匹配");
  }
  return raw;
}
export async function previewReview(
  requirementDir: string,
  proposal: ReviewProposal,
) {
  const raw = await api.readJsonFile(
    joinPath(requirementDir, "04-测试用例", "cases.json"),
  );
  if (!raw) throw new Error("当前用例集不存在");
  const current = normalizeCasesDocument(
    raw,
    proposal.requirement_id,
    "",
    proposal.platform_id,
  );
  const history = await readCaseChangeHistory(requirementDir);
  const patches: CasePatch[] = [];
  const applied = new Map<string, string[]>();
  for (const item of proposal.items.filter((i) =>
    ["accepted", "partial"].includes(i.status),
  )) {
    const ref = `${proposal.proposal_id}/${item.item_id}`;
    const prior = history.events.filter((e) => e.review_item_ref === ref);
    if (prior.length) {
      applied.set(
        item.item_id,
        prior.map((e) => String(e.event_id)),
      );
      continue;
    }
    if (!item.handling_reason?.trim())
      throw new Error(`请填写处理理由：${item.item_id}`);
    if (
      item.after &&
      !collectDirectoryNodes(current.tree).some(
        (d) => d.id === item.after!.directory_id,
      )
    )
      throw new Error(`目标目录不存在：${item.item_id}，请先在用例页创建目录`);
    patches.push({
      case_id: item.target_case_id,
      before: item.before,
      after: item.after,
      reason: `${item.reason}\n处理理由：${item.handling_reason}`,
      source: "approved_ai_proposal",
      origin: "ai",
      review_item_ref: ref,
    });
  }
  // Keep before snapshots exact; renamed/rebuilt IDs are never inferred from titles.
  const revision = {
    proposal_id: proposal.proposal_id,
    base_fingerprint: "",
    patches,
  };
  return {
    current,
    applied,
    preview: previewCaseRevision(current, revision),
    revision,
  };
}
export async function applyReview(
  requirementDir: string,
  proposal: ReviewProposal,
) {
  const view = await previewReview(requirementDir, proposal);
  if (view.preview.some((e) => e.conflict))
    throw new Error(
      `基线冲突：${view.preview
        .filter((e) => e.conflict)
        .map((e) => e.case_id)
        .join("、")}；请对照历史核对人工决定`,
    );
  for (const item of proposal.items)
    if (item.status !== "pending" && !item.handling_reason?.trim())
      throw new Error(`处理理由必填：${item.item_id}`);
  if (view.revision.patches.length) {
    const revision = await proposeCaseRevision(
      view.current,
      view.revision.patches,
    );
    const result = await applyCaseRevision(
      requirementDir,
      revision,
      view.current,
    );
    result.events.forEach((e) => {
      const item = proposal.items.find(
        (i) => `${proposal.proposal_id}/${i.item_id}` === e.review_item_ref,
      );
      if (item) view.applied.set(item.item_id, [e.event_id]);
    });
  }
  return {
    ...proposal,
    items: proposal.items.map((i) => ({
      ...i,
      event_ids: view.applied.get(i.item_id) || i.event_ids || [],
    })),
  };
}

export function reviewHasUnresolved(proposal: ReviewProposal) {
  return proposal.items.some(
    (i) =>
      ["pending", "needs_qa"].includes(i.status) ||
      (["accepted", "partial"].includes(i.status) && !i.event_ids?.length),
  );
}

export async function createFinalCandidate(
  rootPath: string,
  requirementDir: string,
) {
  const path = joinPath(rootPath, requirementDir, "04-测试用例", "cases.json");
  const bytes = await api.readBinaryFile(path);
  const current = normalizeCasesDocument(
    JSON.parse(new TextDecoder().decode(bytes)),
    "",
    "",
  );
  const outline = casesDocumentToOutline(current);
  const violations = validateCaseTemplate(parseOutline(outline.outline));
  if (violations.length)
    throw new Error(`候选模板不合规：${violations.join("；")}`);
  const generated = await withStructuredCaseIds(
    await buildXMindBytes(rootPath, outline.title, outline.outline),
    current,
  );
  const id = crypto.randomUUID();
  const output = joinPath(
    rootPath,
    requirementDir,
    "04-测试用例",
    `candidate-final-${id}.xmind`,
  );
  await api.createBinaryFile(output, generated);
  return output;
}
