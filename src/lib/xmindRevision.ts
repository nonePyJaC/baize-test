import { api, joinPath } from "./api";
import { normalizeCasesDocument, newCase } from "./cases";
import { applyCaseRevision, bytesOf, commitRevision, createCaseChangeEvent, eventLogWrite, proposeCaseRevision, readRevisionFile, type CasePatch, type RevisionWrite } from "./caseRevision";
import { parseXMind } from "./xmindImport";
import type { CaseSnapshot, ChangeRecord } from "./xmindCases";
import type { CasesDocument, StructuredTestCase } from "./types";

const normalizedPath = (path: string) => path.replace(/\\/g, "/");
export function requirementOfXmind(path: string): string {
  const normalized = normalizedPath(path);
  const index = normalized.lastIndexOf("/04-测试用例/");
  if (index < 0) throw new Error("请将可编辑脑图放在需求的 04-测试用例 目录");
  return normalized.slice(0, index);
}
function fieldsFromSnapshot(item: CaseSnapshot): Partial<StructuredTestCase> {
  return { title: `tc-${item.priority}-${item.testType}: ${item.title}`, priority: Number(item.priority.replace("p", "")) as 0 | 1 | 2, test_type: item.testType,
    preconditions: item.preconditions, expected_results: item.expectedResults,
    steps: item.steps.map((action, index) => ({ order: index + 1, action, expected: index === item.steps.length - 1 ? item.expectedResults : [] })) };
}
/** ZIP and sidecar projections commit with the same semantic event as cases.json. */
export async function saveXmindRevision(path: string, expected: Uint8Array, output: Uint8Array, record: ChangeRecord, history: ChangeRecord[], markdown: string) {
  const requirementDir = requirementOfXmind(path);
  const writes: RevisionWrite[] = [{ path, expected: Array.from(expected), content: Array.from(output) }];
  for (const [suffix, content] of [[".changes.json", JSON.stringify(history, null, 2)], [".changes.md", markdown]]) {
    const sidePath = `${path}${suffix}`;
    const info = await api.getPathInfo(sidePath);
    writes.push({ path: sidePath, expected: info.exists ? Array.from(await api.readBinaryFile(sidePath)) : null, content: Array.from(new TextEncoder().encode(content)) });
  }
  const currentFile = await readRevisionFile(joinPath(requirementDir, "04-测试用例", "cases.json"));
  const current = currentFile.value ? normalizeCasesDocument(currentFile.value, "", "") : null;
  const matched = current?.cases.find((item) => (item.id === record.caseId && (!item.source || normalizedPath(item.source.file) === normalizedPath(path))) || (item.source?.topic_id === record.caseId && normalizedPath(item.source.file) === normalizedPath(path)));
  const linked = current && (matched || normalizedPath(String(current.metadata?.source_file || "")) === normalizedPath(path) || current.cases.some((item) => item.source && normalizedPath(item.source.file) === normalizedPath(path)));
  if (linked && !matched) throw new Error(`脑图用例 ${record.caseId} 尚未映射到当前用例集，请在差异预览中确认映射；没有写入文件`);
  if (matched && record.before) {
    const expectedFields = fieldsFromSnapshot(record.before);
    if (Object.keys(expectedFields).some((key) => key === "title"
      ? String(matched.title).replace(/^tc-p\d+-[^:：]*[:：]\s*/, "") !== record.before!.title
      : JSON.stringify(matched[key]) !== JSON.stringify(expectedFields[key as keyof typeof expectedFields]))) throw new Error("当前设计集与脑图上次读取内容不同，请先在差异预览中合并；草稿保留");
  }
  const before = matched || (record.before ? { ...newCase("unimported"), id: record.caseId, ...fieldsFromSnapshot(record.before) } : null);
  const after = record.after ? { ...(before || newCase("unimported")), id: before?.id || record.caseId, ...fieldsFromSnapshot(record.after) } : null;
  if (after && matched?.source) after.source = { ...matched.source, baseline: { ...after, source: undefined } };
  const patch: CasePatch = { case_id: before?.id || record.caseId, before, after, source: "xmind_editor", origin: "human", reason: record.reason || "" };
  const event = { ...createCaseChangeEvent(patch), event_id: record.id, source_file: path, source_topic: record.caseId };
  if (current && matched) {
    const proposal = await proposeCaseRevision(current, [patch]);
    await applyCaseRevision(requirementDir, proposal, current, current.tree, writes, [event]);
  } else {
    writes.push(await eventLogWrite(requirementDir, [event]));
    await commitRevision(requirementDir, record.id, writes);
  }
}

export interface ExternalXmindDiff { id: string; kind: string; before: StructuredTestCase | null; after: StructuredTestCase | null; conflict: boolean; note: string }
/** Stable IDs only. Rebuilt topic IDs remain unmatched and require individual decisions. */
export async function previewExternalXmind(current: CasesDocument, path: string): Promise<{ incoming: CasesDocument; entries: ExternalXmindDiff[] }> {
  const raw = await parseXMind(await api.readBinaryFile(path), path);
  const incoming = normalizeCasesDocument(raw, current.requirement_id, current.platform, current.platform_id);
  const scoped = current.cases.filter((item) => item.source ? normalizedPath(item.source.file) === normalizedPath(path) : normalizedPath(String(current.metadata?.source_file || "")) === normalizedPath(path));
  const entries: ExternalXmindDiff[] = [];
  const found = new Set<string>();
  for (const item of scoped) {
    const candidate = incoming.cases.find((other) => other.id === item.id || (Boolean(item.source?.topic_id) && item.source?.topic_id === other.source?.topic_id && (!item.source?.sheet_id || item.source.sheet_id === other.source?.sheet_id)));
    if (candidate) found.add(candidate.id);
    const next = candidate ? { ...item, ...candidate, id: item.id, directory_id: candidate.directory_id === item.source?.directory_id ? item.directory_id : candidate.directory_id, source: candidate.source } : null;
    const baseline = item.source?.baseline;
    const fields = ["title", "priority", "test_type", "preconditions", "steps", "expected_results", "directory_id"] as const;
    const changed = !next || fields.some((key) => JSON.stringify(item[key]) !== JSON.stringify(next[key]));
    if (changed) entries.push({ id: item.id, kind: next ? "修改/移动" : "未匹配（可能删除或重建ID）", before: item, after: next,
      conflict: !baseline || fields.some((key) => JSON.stringify(item[key]) !== JSON.stringify(baseline[key])),
      note: baseline ? "按最后同步内容比较；请确认采用或保留" : "缺少最后同步基线，需人工确认" });
  }
  for (const item of incoming.cases) if (!found.has(item.id)) entries.push({ id: item.id, kind: "未匹配（可能新增或重建ID）", before: null, after: item, conflict: true, note: "不能凭标题合并；可选择旧ID进行映射，或确认新增" });
  return { incoming, entries };
}
