/** Legacy metadata reader/writer retained for old integrations; current UI uses ExternalPlanPicker. */
import type { YunxiaoTestPlanLink } from "./types";

export interface YunxiaoTestPlanItem {
  id: string;
  name: string;
  projectId: string;
  sprintId: string;
  startDate: string;
  endDate: string;
  managers: string[];
}

function dateText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function normalizeTestPlanItem(raw: Record<string, unknown>): YunxiaoTestPlanItem | null {
  const id = String(raw.testPlanIdentifier || raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || "").trim(),
    projectId: String(raw.spaceIdentifier || raw.projectIdentifier || ""),
    sprintId: String(raw.sprintIdentifier || ""),
    startDate: dateText(raw.startDate),
    endDate: dateText(raw.endDate),
    managers: Array.isArray(raw.managers) ? raw.managers.map((value) => String(value)) : [],
  };
}

export function testPlanLink(plan: { id: string; name: string; projectId?: string; projectName?: string; sprintId?: string; sprintName?: string }): YunxiaoTestPlanLink {
  return {
    id: plan.id,
    name: plan.name,
    project_id: plan.projectId || null,
    project_name: plan.projectName || null,
    sprint_id: plan.sprintId || null,
    sprint_name: plan.sprintName || null,
    linked_at: new Date().toISOString(),
  };
}

export function readTestPlanLink(metadata: Record<string, unknown> | undefined): YunxiaoTestPlanLink | null {
  const link = metadata?.yunxiao_test_plan as YunxiaoTestPlanLink | null | undefined;
  return link && typeof link.id === "string" && link.id ? link : null;
}

export function withTestPlanLink(metadata: Record<string, unknown> | undefined, link: YunxiaoTestPlanLink | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(metadata || {}) };
  if (link) next.yunxiao_test_plan = link;
  else delete next.yunxiao_test_plan;
  return next;
}
