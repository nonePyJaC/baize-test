import React, { useEffect, useState } from "react";
import { api, joinPath } from "../lib/api";
import type {
  AiTaskInfo,
  AiTaskType,
  ClientPreferences,
  WorkspaceConfig,
} from "../lib/types";
import AiSessionPanel from "./AiSessionPanel";
import { systemOpen } from "../lib/systemOpen";
export const TASK_TYPE_LABELS: Record<AiTaskType, string> = {
  requirement_inventory: "需求资料盘点",
  requirement_analysis: "需求理解生成",
  question_extraction: "疑问提取与归并",
  answer_impact_analysis: "答复影响分析",
  test_plan_generation: "测试计划生成",
  testcase_directory_suggestion: "用例目录建议",
  testcase_generation: "结构化用例生成",
  testcase_validation: "用例规范检查",
  coverage_check: "需求—用例覆盖检查",
  dev_impact_comparison: "开发方案影响比对",
  review_revision_suggestion: "评审修订建议",
  xmind_export: "XMind/Excel模板化导出",
  report_generation: "测试报告草稿生成",
  knowledge_distillation: "知识蒸馏候选",
};

export default function AiTaskWorkspace({
  workspace,
  initialTaskId,
  initialPlatformId,
  initialRequirementId,
  initialPath,
  focusKey,
  onTaskCreated,
  onRightContext,
}: {
  workspace: WorkspaceConfig;
  initialTaskId?: string;
  initialPlatformId?: string;
  initialRequirementId?: string;
  initialPath?: string;
  focusKey?: number;
  onTaskCreated?: (task: AiTaskInfo) => void;
  onRightContext?: import("../lib/workbench").RightContextReporter;
}) {
  const [preferences, setPreferences] = useState<ClientPreferences | null>(
    null,
  );
  const [history, setHistory] = useState(Boolean(initialTaskId));
  const [tasks, setTasks] = useState<AiTaskInfo[]>([]);
  const [error, setError] = useState("");
  const root = workspace.workspace.root_path;
  useEffect(() => {
    api
      .loadClientPreferences()
      .then(setPreferences)
      .catch((e) => setError(String(e)));
  }, [root]);
  useEffect(() => {
    setHistory(Boolean(initialTaskId));
  }, [initialTaskId, focusKey]);
  const refresh = () =>
    api
      .listAiTasks(root)
      .then(setTasks)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    if (history) void refresh();
  }, [history, root]);
  if (!history)
    return (
      <AiSessionPanel
        rootPath={root}
        platforms={workspace.platforms}
        provider={preferences?.model_provider ?? null}
        onBack={() => setHistory(true)}
        initialPlatformId={initialPlatformId}
        initialRequirementId={initialRequirementId}
        focusKey={focusKey}
        initialPath={initialPath}
        onRightContext={onRightContext}
      />
    );
  return (
    <div className="workspace-view">
      <section className="document-header">
        <h1>历史AI任务</h1>
        <button
          className="button button-primary"
          onClick={() => setHistory(false)}
        >
          进入AI会话
        </button>
      </section>
      <p>
        旧任务仅保留历史和收尾。新工作请进入AI会话；锁定需求可在需求概览扫描差异并确认解锁。
      </p>
      {error && <div className="modal-error">{error}</div>}
      {tasks
        .filter((t) => !initialTaskId || t.task_id === initialTaskId)
        .map((task) => (
          <section className="panel-section" key={task.task_id}>
            <h2>
              {TASK_TYPE_LABELS[task.task_type]} · {task.task_id}
            </h2>
            <p>
              {task.platform_id} / {task.requirement_id} · {task.status} ·{" "}
              {task.requirement_locked
                ? "需求仍锁定，请到需求概览确认解锁"
                : "未锁定"}
            </p>
            <pre style={{ whiteSpace: "pre-wrap" }}>{task.dispatch_text}</pre>
            {task.result.outputs.map((output, i) => (
              <button
                className="button button-ghost"
                key={i}
                onClick={() =>
                  void systemOpen.openFile(
                    output.path.includes(":") || output.path.startsWith("/")
                      ? output.path
                      : joinPath(root, output.path),
                  )
                }
              >
                {output.path}
              </button>
            ))}
            {task.awaiting_confirmation && (
              <button
                className="button button-ghost"
                onClick={async () => {
                  try {
                    const result = await api.acceptAiTaskResult(
                      root,
                      task.task_id,
                    );
                    onTaskCreated?.(result.task);
                    await refresh();
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                确认历史结果（保留需求锁）
              </button>
            )}
          </section>
        ))}
    </div>
  );
}
