import { invoke } from "@tauri-apps/api/core";
import type {
  ApiExecution,
  ApiImportSource,
  ApiLibrary,
  ApiRequest,
  ApiResponse,
  ApiEnvironment,
  ApiProject,
} from "./apiDebug";
import { normalizeApiLibrary, projectApiRequest } from "./apiWorkbench";
import {
  evaluateApiAssertions,
  newApiLibrary,
  redactApiExecution,
} from "./apiDebug";
import type { ScriptInput, ScriptOutput } from "./apiScriptRuntime";
const native = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const storageKey = "baize-api-debug-library";
export const apiDebugBackend = {
  load: async (): Promise<ApiLibrary> =>
    normalizeApiLibrary(
      await (native()
        ? invoke("load_api_debug_library")
        : JSON.parse(localStorage.getItem(storageKey) || "null") ||
          newApiLibrary()),
    ),
  save: async (document: ApiLibrary): Promise<ApiLibrary> => {
    if (native())
      return invoke("save_api_debug_library", {
        document,
        expectedRevision: document.revision,
      });
    const old = JSON.parse(localStorage.getItem(storageKey) || "null");
    if ((old?.revision || 0) !== document.revision)
      throw Error("接口库已更新，请重新载入后合并");
    const next = { ...document, revision: document.revision + 1 };
    localStorage.setItem(storageKey, JSON.stringify(next));
    return next;
  },
  discover: async (rootPath: string): Promise<ApiImportSource[]> => {
    if (!native()) throw Error("目录扫描请在桌面客户端使用，也可直接导入文件");
    return invoke("discover_api_debug_sources", { rootPath });
  },
  execute: async (input: {
    id: string;
    method: string;
    url: string;
    headers: ApiRequest["headers"];
    body: string;
    timeout_ms: number;
    follow_redirects?: boolean;
    insecure_tls?: boolean;
  }): Promise<ApiResponse> => {
    if (!native()) throw Error("真实 HTTP 请求请在桌面客户端执行");
    return invoke("execute_api_debug_request", { input });
  },
  cancel: async (requestId: string): Promise<void> => {
    if (native()) await invoke("cancel_api_debug_request", { requestId });
  },
};
export function executeApiScript(
  input: ScriptInput,
  signal?: AbortSignal,
): Promise<ScriptOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./apiScript.worker.ts", import.meta.url),
      { type: "module" },
    );
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      fn();
    };
    const cancel = () => finish(() => reject(Error("已停止接口脚本")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            Error(
              input.response
                ? "后置脚本超过 5 秒，响应已保留，请检查脚本后重新判定"
                : "前置脚本超过 5 秒，已停止，未发送请求",
            ),
          ),
        ),
      5000,
    );
    worker.onmessage = (e) =>
      finish(() =>
        e.data.ok ? resolve(e.data.result) : reject(Error(e.data.error)),
      );
    worker.onerror = (e) =>
      finish(() => reject(Error(`接口脚本执行失败：${e.message}`)));
    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    worker.postMessage(input);
  });
}
export async function runApiRequest(
  request: ApiRequest,
  environment: ApiEnvironment | undefined,
  signal?: AbortSignal,
  onId?: (id: string) => void,
  scriptRunner = executeApiScript,
  project?: ApiProject,
): Promise<ApiExecution> {
  const id = crypto.randomUUID();
  onId?.(id);
  const result: ApiExecution = {
    id,
    project_id: request.project_id,
    request_id: request.id,
    request_name: request.name,
    environment_id: environment?.id || "",
    environment_name: environment?.name || "无环境",
    created_at: new Date().toISOString(),
    request: {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    },
    checks: [],
    outcome: "unverified",
    logs: [],
  };
  const cancel = () => {
    void apiDebugBackend.cancel(id);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (
      environment?.project_id &&
      request.project_id &&
      environment.project_id !== request.project_id
    )
      throw Error("环境不属于当前项目");
    request = projectApiRequest(request, project);
    const prepared = await scriptRunner(
      {
        request,
        variables: { ...request.variables, ...environment?.variables },
        collection_variables: request.variables,
        environment_variables: { ...environment?.variables },
      },
      signal,
    );
    if (signal?.aborted) throw Error("已停止接口请求");
    result.request = {
      method: prepared.method,
      url: prepared.url,
      headers: prepared.headers,
      body: prepared.body,
      follow_redirects: request.follow_redirects || false,
      insecure_tls: request.insecure_tls || false,
    };
    result.logs = prepared.logs;
    result.variable_updates = {
      environment: prepared.environment_variables,
      collection: prepared.collection_variables,
    };
    const response = await apiDebugBackend.execute({
      id,
      ...result.request,
      timeout_ms: request.timeout_ms || 30000,
    });
    result.response = response;
    const tested = await scriptRunner(
      {
        request: { ...request, ...result.request },
        variables: prepared.variables,
        collection_variables: prepared.collection_variables,
        environment_variables: prepared.environment_variables,
        response,
      },
      signal,
    );
    result.logs.push(...tested.logs);
    result.variable_updates = {
      environment: tested.environment_variables,
      collection: tested.collection_variables,
    };
    result.checks = [
      ...evaluateApiAssertions(request.assertions, response),
      ...tested.checks,
    ];
    if (response.truncated) {
      result.error = "响应超过 4 MB，展示内容已截断，请人工确认完整结果";
      result.outcome = "unverified";
    } else
      result.outcome = result.checks.length
        ? result.checks.every((c) => c.passed)
          ? "passed"
          : "failed"
        : "unverified";
  } catch (error) {
    result.error = String(error);
    result.outcome = signal?.aborted ? "stopped" : "failed";
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  return result;
}
export const executionEvidence = (result: ApiExecution) =>
  JSON.stringify(redactApiExecution(result), null, 2);
