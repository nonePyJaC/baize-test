import { api, joinPath } from "./api";
import { changedCaseFields, createCaseId, fingerprintCases, normalizeCasesDocument, updateCasesMetadata } from "./cases";
import { invalidateBusinessData } from "./businessEvents";
import type { CasesDocument, StructuredTestCase, TestCaseResult, TestResultsDocument, TestRunDocument } from "./types";

export type CaseChangeAction = "added" | "modified" | "deleted" | "moved" | "restored" | "split" | "merged";
export interface CaseChangeEvent {
  event_id: string; case_id: string; action: CaseChangeAction;
  source: string; actor: string | null; created_at: string; reason: string | null;
  before: StructuredTestCase | null; after: StructuredTestCase | null;
  changed_fields: string[]; base_revision: number; next_revision: number;
  run_id?: string; source_file?: string; source_topic?: string; review_item_ref?: string;
  related_event_ids?: string[]; related_case_ids?: string[];
  origin: "human" | "ai" | "system" | "legacy"; authority: string;
}
export interface CasePatch {
  case_id: string; before: StructuredTestCase | null; after: StructuredTestCase | null;
  reason: string; source: string; origin: CaseChangeEvent["origin"];
  actor?: string | null; review_item_ref?: string; related_case_ids?: string[];
  directory_path_changed?: boolean;
  action?: CaseChangeAction;
  base_revision?: number;
}
export interface CaseRevisionProposal { proposal_id: string; base_fingerprint: string; patches: CasePatch[] }
export interface RevisionWrite { path: string; expected: number[] | null; content: number[] }
export interface RevisionOutcome { applied: boolean; failed: string[]; conflicts: string[]; changed_paths: string[] }
const encoder = new TextEncoder();
export const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2));
export const revisionOf = (item: StructuredTestCase | null) => item ? typeof item.revision === "number" ? item.revision : item.version || 1 : 0;
export function caseContentEqual(a: StructuredTestCase | null, b: StructuredTestCase | null): boolean {
  if (!a || !b) return a === b;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export function requiresRetest(before: StructuredTestCase, after: StructuredTestCase): boolean {
  // Owner/tag changes are metadata-only; title and behavioral edits remain conservative.
  return changedCaseFields(before, after).some((field) => !["标签", "负责人", "关联需求点", "证据要求", "自动化状态", "用例状态"].includes(field));
}
export function createCaseChangeEvent(patch: CasePatch, runId?: string): CaseChangeEvent {
  if (patch.before?.id !== undefined && patch.before.id !== patch.case_id || patch.after?.id !== undefined && patch.after.id !== patch.case_id) throw new Error("补丁ID与用例ID不一致");
  if (patch.before && !patch.reason.trim()) throw new Error("修改或删除必须填写原因");
  const moved = patch.before && patch.after && (patch.before.directory_id !== patch.after.directory_id || patch.directory_path_changed);
  const fields = patch.before && patch.after ? changedCaseFields(patch.before, patch.after) : [patch.after ? "新增" : "删除"];
  return {
    event_id: createCaseId("event"), case_id: patch.case_id,
    action: patch.action || (!patch.before ? "added" : !patch.after ? "deleted" : moved && !fields.length ? "moved" : "modified"),
    source: patch.source, origin: patch.origin, authority: patch.origin === "human" ? "manual" : "approved_proposal",
    actor: patch.actor || null, created_at: new Date().toISOString(), reason: patch.reason.trim() || null,
    before: patch.before, after: patch.after,
    changed_fields: [...fields, ...(moved ? ["目录移动"] : [])],
    base_revision: patch.base_revision ?? revisionOf(patch.before), next_revision: (patch.base_revision ?? revisionOf(patch.before)) + 1,
    run_id: runId, review_item_ref: patch.review_item_ref, related_case_ids: patch.related_case_ids,
    source_file: patch.after?.source?.file || patch.before?.source?.file,
    source_topic: patch.after?.source?.topic_id || patch.before?.source?.topic_id,
  };
}

export async function proposeCaseRevision(base: CasesDocument, patches: CasePatch[]): Promise<CaseRevisionProposal> {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (ids.has(patch.case_id)) throw new Error(`同一提案重复用例ID：${patch.case_id}`);
    ids.add(patch.case_id);
    if (!caseContentEqual(base.cases.find((item) => item.id === patch.case_id) || null, patch.before)) throw new Error(`提案基线不匹配：${patch.case_id}`);
  }
  return { proposal_id: createCaseId("proposal"), base_fingerprint: await fingerprintCases(base), patches };
}
export function previewCaseRevision(current: CasesDocument, proposal: CaseRevisionProposal) {
  return proposal.patches.map((patch) => ({ ...patch, conflict: !caseContentEqual(current.cases.find((item) => item.id === patch.case_id) || null, patch.before), changed_fields: patch.before && patch.after ? [...changedCaseFields(patch.before, patch.after), ...(patch.before.directory_id !== patch.after.directory_id ? ["目录移动"] : [])] : [patch.after ? "新增" : "删除"] }));
}
export async function readRevisionFile(path: string): Promise<{ bytes: Uint8Array | null; value: any }> {
  // Missing and unreadable are deliberately different: permission/corruption must not become creation.
  const info = await api.getPathInfo(path);
  if (!info.exists) return { bytes: null, value: null };
  const bytes = await api.readBinaryFile(path);
  return { bytes, value: JSON.parse(new TextDecoder().decode(bytes)) };
}
export function jsonWrite(path: string, before: Uint8Array | null, after: unknown): RevisionWrite {
  return { path, expected: before ? Array.from(before) : null, content: Array.from(bytesOf(after)) };
}
export async function commitRevision(requirementDir: string, id: string, writes: RevisionWrite[]): Promise<RevisionOutcome> {
  const result = await api.commitCaseRevision(requirementDir, id, writes);
  if (!result.applied) throw new Error(`未提交，草稿已保留。${result.conflicts.length ? `磁盘冲突：${result.conflicts.join("、")}` : result.failed.join("；")}`);
  invalidateBusinessData(result.changed_paths);
  return result;
}
export async function eventLogWrite(requirementDir: string, events: CaseChangeEvent[]): Promise<RevisionWrite> {
  const path = joinPath(requirementDir, "04-测试用例", "case-events.json");
  const file = await readRevisionFile(path);
  const existing: CaseChangeEvent[] = file.value?.events || [];
  return jsonWrite(path, file.bytes, { version: "1.1", events: [...existing, ...events.filter((e) => !existing.some((old) => old.event_id === e.event_id))] });
}

/** Projection keeps old facts in history and deletion tombstones, never removes evidence. */
export function projectExecutionRevision(snapshot: CasesDocument, run: TestRunDocument, results: TestResultsDocument, events: CaseChangeEvent[]) {
  let nextSnapshot = { ...snapshot, cases: [...snapshot.cases] };
  const nextResults: TestResultsDocument = structuredClone(results);
  nextResults.case_events = [...(nextResults.case_events || []), ...events];
  nextResults.result_history = [...(nextResults.result_history || [])];
  nextResults.tombstones = [...(nextResults.tombstones || [])];
  nextResults.case_change_history = [...(nextResults.case_change_history || [])];
  const scope = new Set(run.execution_scope.case_ids.length ? run.execution_scope.case_ids : results.results.filter((item) => !item.deleted).map((item) => item.case_id));
  for (const event of events) {
    if (!event.after) scope.delete(event.case_id); else if (!event.before) scope.add(event.case_id);
    const old = nextResults.results.find((r) => r.case_id === event.case_id);
    if (old && event.before && old.case_revision === undefined) old.case_revision = event.base_revision;
    if (old && event.before) nextResults.result_history.push({ event_id: event.event_id,
      case: old.case_revision !== event.base_revision ? nextResults.result_history.find((fact) => fact.result.case_id === old.case_id && fact.result.case_revision === old.case_revision)?.case || event.before : event.before,
      result: { ...structuredClone(old), case_revision: old.case_revision ?? event.base_revision } });
    nextSnapshot.cases = nextSnapshot.cases.filter((item) => item.id !== event.case_id);
    const position = snapshot.cases.findIndex((item) => item.id === event.case_id);
    if (event.after) nextSnapshot.cases.splice(position < 0 ? nextSnapshot.cases.length : position, 0, { ...event.after, revision: event.next_revision });
    if (!event.after) {
      nextResults.tombstones.push({ event_id: event.event_id, case_id: event.case_id, case: event.before, result: old ? structuredClone(old) : null, reason: event.reason, deleted_at: event.created_at });
      if (old) old.deleted = true;
    } else if (!old || old.deleted) {
      if (old?.deleted) nextResults.results = nextResults.results.filter((item) => item !== old);
      nextResults.results.push({ case_id: event.case_id, status: "not_executed", actual_result: "", notes: "", severity: "none", defect_url: "", evidence: [], updated_at: event.created_at, case_revision: event.next_revision });
    } else {
      if (event.before && requiresRetest(event.before, event.after) && old.status !== "not_executed") old.needs_retest = true;
      else if (!old.needs_retest) old.case_revision = event.next_revision;
    }
    nextResults.case_change_history.push({ id: event.event_id, event_id: event.event_id, changed_at: event.created_at, action: event.action, case_id: event.case_id, title: (event.after || event.before)?.title || event.case_id, reason: event.reason || "", changed_fields: event.changed_fields, before: event.before, after: event.after });
  }
  const now = new Date().toISOString();
  nextSnapshot = updateCasesMetadata(nextSnapshot, now);
  nextResults.updated_at = now;
  return { snapshot: nextSnapshot, results: nextResults, run: { ...run, working_revision: (typeof run.working_revision === "number" ? run.working_revision : 0) + 1, execution_scope: { ...run.execution_scope, case_ids: [...scope] }, updated_at: now } };
}

export async function applyCaseRevision(requirementDir: string, proposal: CaseRevisionProposal, current: CasesDocument, nextTree = current.tree, extraWrites: RevisionWrite[] = [], events?: CaseChangeEvent[], nextMetadata = current.metadata) {
  const preview = previewCaseRevision(current, proposal);
  const conflicts = preview.filter((entry) => entry.conflict);
  if (conflicts.length) throw new Error(`当前设计集存在冲突，待处理ID：${conflicts.map((item) => item.case_id).join("、")}；未应用任何文件`);
  const changes = events || proposal.patches.map((patch) => createCaseChangeEvent(patch));
  if (changes.length !== proposal.patches.length || new Set(changes.map((event) => event.case_id)).size !== changes.length
    || changes.some((event) => {
      const patch = proposal.patches.find((item) => item.case_id === event.case_id);
      return !patch || !caseContentEqual(event.before, patch.before) || !caseContentEqual(event.after, patch.after) || event.reason !== (patch.reason.trim() || null);
    })) throw new Error("事件与已预览提案不一致，拒绝提交");
  const log = await readRevisionFile(joinPath(requirementDir, "04-测试用例", "case-events.json"));
  for (const event of changes.filter((entry) => !entry.before && entry.after)) {
    const previousEvents = (log.value?.events || []).filter((entry: CaseChangeEvent) => entry.case_id === event.case_id);
    const last = previousEvents[previousEvents.length - 1];
    if (last?.action === "deleted" && event.action !== "restored") throw new Error(`用例 ${event.case_id} 有删除墓碑；必须人工明确选择恢复，不能作为新增自动恢复`);
  }
  const file = await readRevisionFile(joinPath(requirementDir, "04-测试用例", "cases.json"));
  // Current is the exact read base. No title matching and no silent partial application.
  if ((!file.value && current.cases.length) || (file.value && !sameDocument(file.value, current))) throw new Error("当前设计集磁盘版本已变化，草稿保留，请重新预览差异");
  const map = new Map(current.cases.map((item) => [item.id, item]));
  for (const event of changes) {
    if (event.after) map.set(event.case_id, { ...event.after, revision: event.next_revision }); else map.delete(event.case_id);
  }
  const document = updateCasesMetadata({ ...current, metadata: nextMetadata, tree: nextTree, cases: [...map.values()] });
  const writes = [jsonWrite(joinPath(requirementDir, "04-测试用例", "cases.json"), file.bytes, document), await eventLogWrite(requirementDir, changes), ...extraWrites];
  const outcome = await commitRevision(requirementDir, proposal.proposal_id, writes);
  return { ...outcome, document, events: changes };
}
export function sameDocument(a: CasesDocument, b: CasesDocument): boolean {
  const left = normalizeCasesDocument(a, b.requirement_id, b.platform, b.platform_id);
  const right = normalizeCasesDocument(b, b.requirement_id, b.platform, b.platform_id);
  return JSON.stringify(left.tree) === JSON.stringify(right.tree) && left.cases.length === right.cases.length && left.cases.every((item) => caseContentEqual(item, right.cases.find((other) => other.id === item.id) || null));
}

export function mergeCaseDraft(base: CasesDocument, draft: CasesDocument, disk: CasesDocument) {
  const ids = new Set([...base.cases, ...draft.cases, ...disk.cases].map((item) => item.id));
  const conflicts: Array<{ id: string; before: StructuredTestCase | null; local: StructuredTestCase | null; disk: StructuredTestCase | null }> = [];
  const merged: StructuredTestCase[] = [];
  for (const id of ids) {
    const before = base.cases.find((item) => item.id === id) || null;
    const local = draft.cases.find((item) => item.id === id) || null;
    const external = disk.cases.find((item) => item.id === id) || null;
    const localChanged = !caseContentEqual(before, local), diskChanged = !caseContentEqual(before, external);
    if (localChanged && diskChanged && !caseContentEqual(local, external)) conflicts.push({ id, before, local, disk: external });
    const choice = localChanged ? local : external;
    if (choice) merged.push(choice);
  }
  const treeConflict = JSON.stringify(base.tree) !== JSON.stringify(draft.tree) && JSON.stringify(base.tree) !== JSON.stringify(disk.tree) && JSON.stringify(draft.tree) !== JSON.stringify(disk.tree);
  return { document: { ...disk, cases: merged, tree: JSON.stringify(base.tree) === JSON.stringify(draft.tree) ? disk.tree : draft.tree }, conflicts, treeConflict };
}

/** Read legacy logs without inventing missing reasons, actors, dates or revisions. */
export function normalizeLegacyChange(raw: Record<string, any>): Record<string, unknown> {
  return { ...raw, event_id: raw.event_id || raw.id || null, case_id: raw.case_id || raw.caseId || null,
    action: raw.action || raw.changeType || (!raw.before ? "added" : !raw.after ? "deleted" : "modified"),
    created_at: raw.created_at || raw.changed_at || raw.changedAt || null,
    reason: raw.reason || null, reason_status: raw.reason ? "recorded" : "历史未记录",
    actor: raw.actor || null, origin: raw.origin || "legacy", base_revision: raw.base_revision ?? null, next_revision: raw.next_revision ?? null };
}

export async function readCaseChangeHistory(requirementDir: string, runPath?: string) {
  const log = await readRevisionFile(joinPath(requirementDir, "04-测试用例", "case-events.json"));
  const execution = runPath ? (await readRevisionFile(joinPath(runPath, "results.json"))).value as TestResultsDocument | null : null;
  const events = new Map<string, Record<string, unknown>>();
  for (const raw of [...(log.value?.events || []), ...(execution?.case_events || []), ...(execution?.case_change_history || [])]) {
    const normalized = normalizeLegacyChange(raw);
    const key = String(normalized.event_id || `legacy-${events.size}`);
    if (!events.has(key)) events.set(key, normalized);
  }
  const tombstones = [...(execution?.tombstones || [])];
  const legacyDeleted = (execution?.case_change_history || []).filter((event) => event.action === "deleted" && !tombstones.some((entry) => entry.event_id === event.id));
  return { events: [...events.values()], tombstones, legacy_deleted: legacyDeleted.map((event) => ({ ...event, result: null, history_note: "历史执行信息未记录，无法恢复" })) };
}
