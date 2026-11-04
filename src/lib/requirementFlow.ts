// BB-16E：需求阶段自动检查、阶段检查项规范化与活动记录辅助。
// 自动检查只基于工作区文件做只读探测，结果用于提示，不会替用户自动推进阶段。

import { api, joinPath } from "./api";
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type QuestionsData,
  type RequirementActivityInput,
  type StageAutoCheck,
  type StageChecklistItem,
} from "./types";

const QA_DIRECTORY = "02-需求理解与答疑";
const PLAN_DIRECTORY = "03-测试计划";
const CASES_DIRECTORY = "04-测试用例";
const EXECUTION_DIRECTORY = "06-测试执行与证据";
const REPORT_DIRECTORY = "07-测试报告";

/** 阶段推进目标（相邻下一阶段）；最后一格为 completed，archived 走独立归档动作 */
export function stageAdvanceTarget(stage: string): string | null {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0) return null;
  const next = STAGE_ORDER[index + 1];
  return next && next !== "archived" ? next : null;
}

/** 阶段退回目标（相邻上一阶段） */
export function stageRetreatTarget(stage: string): string | null {
  const index = STAGE_ORDER.indexOf(stage);
  return index > 0 ? STAGE_ORDER[index - 1] : null;
}

/** 规范化 requirement.yaml 中的 stage_checklist 项（容错旧数据） */
export function normalizeStageChecklist(items: unknown): StageChecklistItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const label = typeof raw.label === "string" ? raw.label.trim() : typeof raw.title === "string" ? raw.title.trim() : "";
    if (!label) return [];
    return [{
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `check-${index + 1}`,
      stage: typeof raw.stage === "string" && raw.stage.trim() ? raw.stage.trim() : "draft",
      label,
      kind: raw.kind === "auto" ? "auto" : "manual",
      done: raw.done === true,
      done_at: typeof raw.done_at === "string" && raw.done_at ? raw.done_at : null,
      note: typeof raw.note === "string" ? raw.note : "",
      source: typeof raw.source === "string" ? raw.source : "",
    }];
  });
}

/**
 * 按阶段对工作区文件做轻量探测，计算每个阶段的“完成条件”提示。
 * 首轮覆盖：需求理解/待答疑/测试计划/用例设计/用例评审/测试执行/待报告/已完成。
 */
export async function computeStageAutoChecks(
  rootPath: string,
  platformPath: string,
  requirementId: string,
): Promise<StageAutoCheck[]> {
  const reqDir = joinPath(rootPath, platformPath, requirementId);
  const checks: StageAutoCheck[] = [];
  const pathInfo = async (rel: string) => api.getPathInfo(joinPath(reqDir, rel)).catch(() => null);
  const fileExists = async (rel: string) => (await pathInfo(rel))?.is_file === true;
  const listDir = async (rel: string) => api.listDirectory(joinPath(reqDir, rel)).catch(() => []);
  const readJson = async (rel: string) => {
    try {
      return await api.readJsonFile(joinPath(reqDir, rel));
    } catch {
      return null;
    }
  };

  // 需求理解：02-需求理解与答疑 下存在理解类文档
  const qaFiles = await listDir(QA_DIRECTORY);
  const understanding = qaFiles.some((file) => !file.is_dir && /\.(md|markdown|txt|docx)$/i.test(file.name));
  checks.push({
    id: "understanding-doc",
    stage: "analyzing",
    label: "需求理解文档已编写",
    source: QA_DIRECTORY,
    status: understanding ? "passed" : "attention",
    detail: understanding ? "已找到需求理解文档" : "未找到需求理解文档",
  });

  // 待答疑：questions.json 存在并统计 P0 未关闭数量
  const questionsRel = joinPath(QA_DIRECTORY, "questions.json");
  if (!(await fileExists(questionsRel))) {
    checks.push({
      id: "questions-p0",
      stage: "pending_qa",
      label: "P0疑问已全部关闭",
      source: questionsRel,
      status: "attention",
      detail: "questions.json 不存在",
    });
  } else {
    const data = (await readJson(questionsRel)) as QuestionsData | null;
    if (!data || !Array.isArray(data.questions)) {
      checks.push({
        id: "questions-p0",
        stage: "pending_qa",
        label: "P0疑问已全部关闭",
        source: questionsRel,
        status: "unavailable",
        detail: "questions.json 解析失败",
      });
    } else {
      const open = data.questions.filter((item) => item.priority === "P0" && !["answered", "no_need", "void"].includes(item.status));
      checks.push({
        id: "questions-p0",
        stage: "pending_qa",
        label: "P0疑问已全部关闭",
        source: questionsRel,
        status: open.length === 0 ? "passed" : "attention",
        detail: open.length === 0 ? "P0疑问已全部关闭" : `P0未关闭 ${open.length} 条`,
      });
    }
  }

  // 测试计划：03-测试计划 下存在计划文档
  const planFiles = await listDir(PLAN_DIRECTORY);
  const hasPlan = planFiles.some((file) => !file.is_dir);
  checks.push({
    id: "test-plan",
    stage: "planning",
    label: "测试计划文档已编写",
    source: PLAN_DIRECTORY,
    status: hasPlan ? "passed" : "attention",
    detail: hasPlan ? "测试计划目录已有文档" : "测试计划目录为空",
  });

  // 用例设计：cases.json 存在且包含用例
  const casesRel = joinPath(CASES_DIRECTORY, "cases.json");
  if (!(await fileExists(casesRel))) {
    checks.push({
      id: "cases-exist",
      stage: "testcase_design",
      label: "结构化用例已生成",
      source: casesRel,
      status: "attention",
      detail: "cases.json 不存在",
    });
  } else {
    const data = await readJson(casesRel);
    const count = Array.isArray(data?.cases) ? data.cases.length : 0;
    checks.push({
      id: "cases-exist",
      stage: "testcase_design",
      label: "结构化用例已生成",
      source: casesRel,
      status: count > 0 ? "passed" : "attention",
      detail: count > 0 ? `cases.json 共 ${count} 条用例` : "cases.json 没有用例",
    });
  }

  // 用例评审：versions 下至少一个正式版本目录
  const versionEntries = await listDir(joinPath(CASES_DIRECTORY, "versions"));
  const versionCount = versionEntries.filter((entry) => entry.is_dir).length;
  checks.push({
    id: "case-version",
    stage: "testcase_review",
    label: "至少提交一个正式用例版本",
    source: joinPath(CASES_DIRECTORY, "versions"),
    status: versionCount > 0 ? "passed" : "attention",
    detail: versionCount > 0 ? `已有 ${versionCount} 个正式版本` : "尚未提交正式版本",
  });

  // 测试执行：存在测试轮次（run.json）
  const runEntries = (await listDir(EXECUTION_DIRECTORY)).filter((entry) => entry.is_dir);
  const runs = (
    await Promise.all(
      runEntries.map(async (entry) => ({
        name: entry.name,
        valid: await fileExists(joinPath(EXECUTION_DIRECTORY, entry.name, "run.json")),
      })),
    )
  ).filter((entry) => entry.valid);
  checks.push({
    id: "test-run",
    stage: "testing",
    label: "已创建测试轮次",
    source: EXECUTION_DIRECTORY,
    status: runs.length > 0 ? "passed" : "attention",
    detail: runs.length > 0 ? `已创建 ${runs.length} 个测试轮次` : "尚未创建测试轮次",
  });

  // 待报告：执行范围内用例均有明确状态（非 not_executed）
  if (!runs.length) {
    checks.push({
      id: "run-results",
      stage: "pending_report",
      label: "执行范围内用例均有结果",
      source: joinPath(EXECUTION_DIRECTORY, "*/results.json"),
      status: "attention",
      detail: "没有可检查的测试轮次",
    });
  } else {
    let total = 0;
    let done = 0;
    let broken = 0;
    for (const run of runs) {
      const runDoc = await readJson(joinPath(EXECUTION_DIRECTORY, run.name, "run.json"));
      const resultsDoc = await readJson(joinPath(EXECUTION_DIRECTORY, run.name, "results.json"));
      if (!runDoc || !resultsDoc) {
        broken += 1;
        continue;
      }
      const scope: string[] = Array.isArray(runDoc?.execution_scope?.case_ids) ? runDoc.execution_scope.case_ids : [];
      const list: Array<{ case_id?: string; status?: string }> = Array.isArray(resultsDoc?.results) ? resultsDoc.results : [];
      const statusMap = new Map(list.map((item) => [item.case_id, item.status]));
      total += scope.length;
      done += scope.filter((id) => statusMap.has(id) && statusMap.get(id) !== "not_executed").length;
    }
    checks.push({
      id: "run-results",
      stage: "pending_report",
      label: "执行范围内用例均有结果",
      source: joinPath(EXECUTION_DIRECTORY, "*/results.json"),
      status: total > 0 && done >= total ? "passed" : "attention",
      detail: broken > 0 ? `${broken} 个轮次结果读取失败` : `已明确 ${done}/${total} 条用例结果`,
    });
  }

  // 已完成：07-测试报告 下存在报告产物
  const reportEntries = await listDir(REPORT_DIRECTORY);
  const hasReport = reportEntries.length > 0;
  checks.push({
    id: "report-exists",
    stage: "completed",
    label: "已生成测试报告",
    source: REPORT_DIRECTORY,
    status: hasReport ? "passed" : "attention",
    detail: hasReport ? "已生成测试报告" : "尚未生成报告",
  });

  return checks;
}

/** 追加需求活动记录（fire-and-forget）：活动台账是辅助记录，失败不阻断业务操作 */
export function recordActivity(
  rootPath: string,
  platformPath: string,
  requirementId: string,
  input: RequirementActivityInput,
): void {
  if (!rootPath.trim() || !platformPath.trim() || !requirementId.trim() || !input.action?.trim()) return;
  void api
    .appendRequirementActivity(rootPath, platformPath, requirementId, {
      action: input.action.trim(),
      actor: input.actor || "user",
      summary: (input.summary || "").trim().slice(0, 300),
      from_stage: input.from_stage ?? null,
      to_stage: input.to_stage ?? null,
      object_id: input.object_id ?? null,
      refs: input.refs ?? [],
    })
    .catch(() => undefined);
}

/** 绝对路径 → 工作区相对路径（活动台账 refs 统一使用工作区相对路径） */
export function toWorkspaceRelative(rootPath: string, path: string): string {
  const root = rootPath.replace(/[\\/]+$/, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** 活动事件动作 → 展示标签 */
export const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  requirement_created: "创建需求",
  requirement_updated: "编辑需求",
  stage_advance: "推进阶段",
  stage_retreat: "退回阶段",
  stage_archive: "归档需求",
  stage_restore: "恢复需求",
  blocker_added: "新增阻塞项",
  blocker_closed: "关闭阻塞项",
  checklist_updated: "更新检查项",
  ai_task_created: "创建AI任务",
  ai_task_accepted: "接受任务结果",
  ai_task_rejected: "拒绝任务结果",
  ai_task_redispatched: "重新派发任务",
  cases_imported: "导入用例",
  cases_saved: "保存用例",
  case_version_committed: "提交用例版本",
  test_run_created: "创建测试轮次",
  test_results_saved: "保存执行结果",
  report_generated: "生成报告",
  knowledge_published: "发布知识",
  requirement_locked: "锁定需求",
  requirement_unlocked: "解锁需求",
  coverage_exempt: "豁免覆盖项",
  coverage_unexempt: "取消覆盖豁免",
  yunxiao_bug_submitted: "提交云效缺陷",
  yunxiao_requirement_linked: "绑定云效需求",
};

export function activityActionLabel(action: string): string {
  return ACTIVITY_ACTION_LABELS[action] || action;
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] || stage;
}
