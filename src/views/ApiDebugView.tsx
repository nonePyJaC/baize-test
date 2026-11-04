import React, { useEffect, useRef, useState } from "react";
import AppIcon from "../components/AppIcon";
import ApiProjectSettings, {
  ApiAuthEditor,
  ApiHeadersEditor,
} from "../components/ApiProjectSettings";
import ApiAiGenerator from "../components/ApiAiGenerator";
import {
  apiQueryRows,
  urlWithApiQuery,
  newApiProject,
  normalizeApiLibrary,
  scopeApiImport,
  type ApiAiDraft,
} from "../lib/apiWorkbench";
import { api, isTauri } from "../lib/api";
import { useDraftSave } from "../lib/draftGuard";
import {
  apiDebugBackend,
  executionEvidence,
  runApiRequest,
} from "../lib/apiDebugRuntime";
import {
  apiBindingKey,
  importApiCurl,
  importApiDocument,
  jsonPath,
  mergeApiImport,
  newApiLibrary,
  newApiRequest,
  parseLosslessJson,
  redactApiExecution,
  stringifyLosslessJson,
  updateApiParameter,
  type ApiAssertion,
  type ApiEnvironment,
  type ApiExecution,
  type ApiImportSource,
  type ApiLibrary,
  type ApiRequest,
} from "../lib/apiDebug";

export interface ApiCaseContext {
  workspace: string;
  platform: string;
  requirement: string;
  case_id: string;
  case_title: string;
  run_id: string;
  case_notes?: string;
}
interface Props {
  context?: ApiCaseContext;
  onApply?: (result: ApiExecution) => Promise<boolean>;
  onClose?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}
const verdict = (v: ApiExecution["outcome"]) =>
  ({
    passed: "断言通过",
    failed: "执行失败",
    unverified: "待人工确认",
    stopped: "已停止",
  })[v];
const pretty = (text: string) => {
  try {
    return stringifyLosslessJson(parseLosslessJson(text));
  } catch {
    return text;
  }
};
const defaultEnvironment = (
  r: ApiRequest | undefined,
  lib: ApiLibrary | null,
) =>
  r?.environment_id ??
  lib?.environments.find((e) => e.project_id === r?.project_id)?.id ??
  "";
export default function ApiDebugView({
  context,
  onApply,
  onClose,
  onDirtyChange,
}: Props) {
  const [library, setLibrary] = useState<ApiLibrary | null>(null),
    [selected, setSelected] = useState(""),
    [envId, setEnvId] = useState(""),
    [editor, setEditor] = useState("body");
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [filter, setFilter] = useState("");
  const [result, setResult] = useState<ApiExecution | null>(null),
    [resultTab, setResultTab] = useState("body");
  const [sources, setSources] = useState<ApiImportSource[]>([]),
    [chosen, setChosen] = useState<Set<string>>(new Set()),
    [sourceRoot, setSourceRoot] = useState(""),
    [scanBusy, setScanBusy] = useState(false);
  const [importPreview, setImportPreview] = useState<ReturnType<
      typeof importApiDocument
    > | null>(null),
    [importOpen, setImportOpen] = useState(false),
    [curl, setCurl] = useState("");
  const [environmentEditor, setEnvironmentEditor] = useState<{
      id: string;
      name: string;
      text: string;
    } | null>(null),
    [variablesText, setVariablesText] = useState("");
  const [invalidVariables, setInvalidVariables] = useState(false);
  const [projectId, setProjectId] = useState(""),
    [projectOpen, setProjectOpen] = useState(false),
    [aiOpen, setAiOpen] = useState(false),
    [openRequests, setOpenRequests] = useState<string[]>([]);
  const scriptFileRef = useRef<HTMLInputElement>(null);
  const current = useRef(library);
  current.current = library;
  const abort = useRef<AbortController | null>(null),
    liveResult = useRef("");
  const fileRef = useRef<HTMLInputElement>(null);
  const binding = context
    ? apiBindingKey(
        context.workspace,
        context.platform,
        context.requirement,
        context.case_id,
      )
    : "";
  const request = library?.requests.find((r) => r.id === selected),
    environment = library?.environments.find((e) => e.id === envId);
  const project = library?.projects?.find((p) => p.id === projectId);
  const projectRequests =
    library?.requests.filter((r) => r.project_id === projectId) || [];
  const projectEnvironments =
    library?.environments.filter((e) => e.project_id === projectId) || [];
  const projectScripts =
    library?.scripts?.filter((s) => s.project_id === projectId) || [];
  const projectHeaders =
    library?.header_templates?.filter((t) => t.project_id === projectId) || [];
  const adopt = (next: ApiLibrary) => {
    current.current = next;
    setLibrary(next);
  };
  const load = async () => {
    if (dirty && !window.confirm("重新载入会放弃未保存的接口编辑，是否继续？"))
      return;
    setError("");
    try {
      const data = normalizeApiLibrary(await apiDebugBackend.load());
      adopt(data);
      setResult(null);
      liveResult.current = "";
      const id =
        (binding && data.bindings[binding]) || data.requests[0]?.id || "";
      setSelected(id);
      setOpenRequests(id ? [id] : []);
      setProjectId(
        data.requests.find((r) => r.id === id)?.project_id ||
          data.projects?.[0]?.id ||
          "",
      );
      setEnvId(
        defaultEnvironment(
          data.requests.find((r) => r.id === id),
          data,
        ),
      );
      setVariablesText(
        JSON.stringify(
          data.requests.find((r) => r.id === id)?.variables || {},
          null,
          2,
        ),
      );
      setInvalidVariables(false);
      setDirty(false);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [binding]);
  useEffect(() => {
    onDirtyChange?.(
      dirty || busy || Boolean(environmentEditor) || projectOpen || aiOpen,
    );
  }, [dirty, busy, environmentEditor, projectOpen, aiOpen, onDirtyChange]);
  useEffect(() => {
    setVariablesText(JSON.stringify(request?.variables || {}, null, 2));
    setInvalidVariables(false);
  }, [request?.id]);
  const persist = async (doc = current.current): Promise<boolean> => {
    if (!doc || busy) return false;
    if (invalidVariables) {
      setError("请求变量 JSON 尚未完成，请修正后保存；编辑已保留");
      return false;
    }
    setSaving(true);
    setError("");
    try {
      const next = await apiDebugBackend.save(doc);
      adopt(next);
      setDirty(false);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  useDraftSave(async () => {
    if (environmentEditor || projectOpen || aiOpen) {
      setError("请先保存或关闭配置与 AI 草稿，再继续关闭");
      return false;
    }
    return persist();
  });
  const update = (change: Partial<ApiRequest>) => {
    if (!request || !current.current) return;
    adopt({
      ...current.current,
      requests: current.current.requests.map((r) =>
        r.id === request.id ? { ...r, ...change } : r,
      ),
    });
    setDirty(true);
    liveResult.current = "";
  };
  const choose = (r: ApiRequest) => {
    if (invalidVariables) {
      setError("请先完成当前接口的变量 JSON；编辑已保留");
      return;
    }
    setSelected(r.id);
    setProjectId(r.project_id || projectId);
    setOpenRequests((ids) => (ids.includes(r.id) ? ids : [...ids, r.id]));
    setEnvId(defaultEnvironment(r, current.current));
    setResult(null);
    liveResult.current = "";
  };
  const add = () => {
    if (invalidVariables) {
      setError("请先修正当前变量 JSON；编辑已保留");
      return;
    }
    const r = { ...newApiRequest(), project_id: projectId };
    adopt({
      ...(current.current || newApiLibrary()),
      requests: [...(current.current?.requests || []), r],
    });
    setDirty(true);
    choose(r);
  };
  const duplicate = () => {
    if (!request || !current.current || invalidVariables) return;
    const r = {
      ...structuredClone(request),
      id: crypto.randomUUID(),
      name: `${request.name}（副本）`,
    };
    adopt({ ...current.current, requests: [...current.current.requests, r] });
    setDirty(true);
    choose(r);
  };
  const remove = () => {
    if (
      !request ||
      !current.current ||
      invalidVariables ||
      !window.confirm(
        `从接口库删除“${request.name}”？原工具文件和历史证据会保留。`,
      )
    )
      return;
    const next = {
      ...current.current,
      requests: current.current.requests.filter((r) => r.id !== request.id),
      bindings: Object.fromEntries(
        Object.entries(current.current.bindings).filter(
          ([, id]) => id !== request.id,
        ),
      ),
    };
    adopt(next);
    setDirty(true);
    const remaining = next.requests.find((r) => r.project_id === projectId);
    setOpenRequests((ids) => ids.filter((id) => id !== request.id));
    if (remaining) choose(remaining);
    else setSelected("");
  };
  const bind = async () => {
    if (!binding || !request || !current.current) return;
    const next = {
      ...current.current,
      bindings: { ...current.current.bindings, [binding]: request.id },
    };
    if (await persist(next))
      setMessage("已绑定到当前用例；以后从该用例进入会自动选中此接口");
  };
  const send = async () => {
    if (
      !request ||
      busy ||
      saving ||
      projectOpen ||
      aiOpen ||
      environmentEditor ||
      importOpen
    )
      return;
    setError("");
    setMessage("");
    if (dirty && !(await persist())) return;
    const snapshot = structuredClone(request),
      env = environment ? structuredClone(environment) : undefined;
    setBusy(true);
    abort.current = new AbortController();
    try {
      const run = await runApiRequest(
        snapshot,
        env,
        abort.current.signal,
        undefined,
        undefined,
        project && structuredClone(project),
      );
      setResult(run);
      setResultTab("body");
      liveResult.current = run.id;
      const old = current.current;
      if (old) {
        const history = redactApiExecution(run);
        if (history.response && history.response.body.length > 100000)
          history.response = {
            ...history.response,
            body: history.response.body.slice(0, 100000),
            truncated: true,
          };
        const next = {
          ...old,
          history: [history, ...old.history].slice(0, 20),
          environments: old.environments.map((e) =>
            e.id === env?.id && run.variable_updates?.environment
              ? { ...e, variables: run.variable_updates.environment }
              : e,
          ),
          projects: old.projects?.map((p) =>
            p.id === projectId && run.variable_updates?.collection
              ? {
                  ...p,
                  variables: {
                    ...Object.fromEntries(
                      Object.entries(p.variables).filter(
                        ([key]) => key in snapshot.variables,
                      ),
                    ),
                    ...Object.fromEntries(
                      Object.entries(run.variable_updates.collection).filter(
                        ([key]) => !(key in snapshot.variables),
                      ),
                    ),
                  },
                }
              : p,
          ),
          requests: old.requests.map((r) =>
            r.id === snapshot.id && run.variable_updates?.collection
              ? {
                  ...r,
                  variables: Object.fromEntries(
                    Object.entries(run.variable_updates.collection).filter(
                      ([key]) => key in snapshot.variables,
                    ),
                  ),
                }
              : r,
          ),
        };
        try {
          adopt(await apiDebugBackend.save(next));
          setDirty(false);
        } catch (e) {
          adopt(next);
          setDirty(true);
          setError(`响应已保留，但接口历史保存失败：${String(e)}`);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };
  const scan = async () => {
    setScanBusy(true);
    setError("");
    try {
      const root = sourceRoot || (await api.chooseDirectory());
      if (!root) return;
      setSourceRoot(root);
      const rows = await apiDebugBackend.discover(root);
      setSources(rows);
      setChosen(new Set(rows.map((r) => r.path)));
      if (!rows.length)
        setMessage("未发现可导入文件，可使用“选择 JSON 文件”或粘贴 cURL");
    } catch (e) {
      setError(String(e));
    } finally {
      setScanBusy(false);
    }
  };
  const preview = async (
    files: Array<{ name: string; text: () => Promise<string> }>,
  ) => {
    setScanBusy(true);
    setError("");
    try {
      const all: ReturnType<typeof importApiDocument> = {
        requests: [],
        environments: [],
        warnings: [],
        header_templates: [],
        scripts: [],
      };
      for (const f of files) {
        try {
          const item = importApiDocument(await f.text(), f.name);
          all.requests.push(...item.requests);
          all.environments.push(...item.environments);
          all.header_templates!.push(...(item.header_templates || []));
          all.scripts!.push(...(item.scripts || []));
          all.warnings.push(...item.warnings);
        } catch (e) {
          all.warnings.push(`${f.name}：${String(e)}`);
        }
      }
      setImportPreview(all);
    } finally {
      setScanBusy(false);
    }
  };
  const chooseJsonFiles = async () => {
    if (!isTauri) {
      fileRef.current?.click();
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [{ name: "接口资料 JSON", extensions: ["json"] }],
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        await preview(
          paths.map((path) => ({
            name: path,
            text: () => api.readTextFile(path),
          })),
        );
      }
    } catch (error) {
      setError(String(error));
    }
  };
  const acceptImport = async () => {
    if (!importPreview || !current.current) return;
    const scoped = scopeApiImport(importPreview, projectId);
    const next = mergeApiImport(current.current, scoped);
    if (await persist(next)) {
      setMessage(
        `接口库现有 ${next.requests.length} 个请求、${next.environments.length} 个环境；重复导入保留已编辑内容`,
      );
      if (scoped.requests[0])
        choose(next.requests.find((r) => r.id === scoped.requests[0].id)!);
      setImportPreview(null);
      setImportOpen(false);
    }
  };
  const saveEnvironment = async () => {
    if (!environmentEditor || !current.current) return;
    try {
      const parsed = parseLosslessJson(environmentEditor.text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw Error("环境变量应为 JSON 对象");
      const env: ApiEnvironment = {
        id: environmentEditor.id,
        project_id: projectId,
        name: environmentEditor.name,
        variables: Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [
            k,
            String(v).replace(/^___BAIZE_BIGINT_(-?\d+)___$/, "$1"),
          ]),
        ),
      };
      const exists = current.current.environments.some((e) => e.id === env.id);
      const next = {
        ...current.current,
        requests: current.current.requests.map((r) =>
          r.id === request?.id ? { ...r, environment_id: env.id } : r,
        ),
        environments: exists
          ? current.current.environments.map((e) => (e.id === env.id ? env : e))
          : [...current.current.environments, env],
      };
      if (await persist(next)) {
        setEnvId(env.id);
        setEnvironmentEditor(null);
        liveResult.current = "";
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const changeAssertion = (id: string, patch: Partial<ApiAssertion>) =>
    update({
      assertions: request!.assertions.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
    });
  const close = () => {
    if (
      dirty &&
      !window.confirm("接口编辑尚未保存，关闭并放弃本次未保存编辑？")
    )
      return;
    onClose?.();
  };
  const displayParameter = (path: string) => {
    try {
      return String(
        jsonPath(parseLosslessJson(request?.body || "{}"), path) ?? "",
      );
    } catch {
      return "";
    }
  };
  const apply = async () => {
    if (!result || !onApply) return;
    setSaving(true);
    setError("");
    try {
      if (await onApply(result)) setMessage("已保存接口证据和当前用例结果");
      else setError("用例结果未保存，请检查执行页面提示；当前响应仍保留");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const chooseProject = (id: string) => {
    if (invalidVariables) {
      setError("请先完成当前请求的变量 JSON");
      return;
    }
    setProjectId(id);
    setResult(null);
    liveResult.current = "";
    const r = current.current?.requests.find((r) => r.project_id === id);
    if (r) choose(r);
    else {
      setSelected("");
      setEnvId("");
    }
  };
  const addProject = () => {
    if (!current.current || invalidVariables) return;
    const p = newApiProject(
      `新项目 ${(current.current.projects?.length || 0) + 1}`,
    );
    adopt({
      ...current.current,
      projects: [...(current.current.projects || []), p],
    });
    setDirty(true);
    setProjectId(p.id);
    setSelected("");
    setEnvId("");
    setResult(null);
    setProjectOpen(true);
  };
  const acceptAi = async (draft: ApiAiDraft) => {
    if (!current.current || invalidVariables) return false;
    const next = {
      ...current.current,
      requests: [...current.current.requests, ...draft.requests],
    };
    if (!(await persist(next))) return false;
    choose(draft.requests[0]);
    setEditor("tests");
    setMessage(
      `已加入 ${draft.requests.length} 个 AI 草稿请求，请检查变量与断言后发送${context ? "，并选择需要绑定当前用例的接口" : ""}`,
    );
    return true;
  };
  return (
    <section
      className="api-debug-view"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          void send();
        }
      }}
    >
      <header className="api-debug-heading">
        <div>
          <span className="eyebrow">HTTP / 接口测试</span>
          <h2>{context ? "用例接口调试" : "接口调试"}</h2>
          {context && (
            <small>
              {context.requirement} · {context.case_title}
            </small>
          )}
        </div>
        <div className="api-debug-actions">
          <button
            className="button button-primary"
            disabled={busy || saving || !project || invalidVariables}
            onClick={() => setAiOpen(true)}
          >
            AI 生成接口脚本
          </button>
          <button
            className="button button-ghost"
            disabled={busy || saving}
            onClick={() => {
              setImportOpen(true);
              setImportPreview(null);
            }}
          >
            导入
          </button>
          <button
            className="button button-ghost"
            disabled={busy || saving}
            onClick={() => void load()}
          >
            重新载入
          </button>
          <button
            className="button button-primary"
            disabled={busy || saving || !dirty}
            onClick={() => void persist()}
          >
            保存接口库{dirty ? " *" : ""}
          </button>
          {onClose && (
            <button
              className="button button-ghost"
              disabled={busy || saving}
              onClick={close}
            >
              关闭
            </button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="unlock-warning">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="field-help">
          {message}
        </p>
      )}
      {context?.case_notes && (
        <details>
          <summary>当前用例的步骤与期望</summary>
          <pre className="api-debug-output">{context.case_notes}</pre>
        </details>
      )}
      <div className="api-debug-layout">
        <aside className="api-debug-library">
          <label className="field-label">
            项目
            <select
              className="field-input"
              aria-label="接口项目"
              value={projectId}
              disabled={busy || saving || !library}
              onChange={(e) => chooseProject(e.target.value)}
            >
              {library?.projects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="api-debug-actions api-project-actions">
            <button
              className="text-button"
              disabled={busy || saving || !library}
              onClick={addProject}
            >
              新建项目
            </button>
            <button
              className="text-button"
              disabled={busy || saving || !project}
              onClick={() => setProjectOpen(true)}
            >
              项目配置
            </button>
          </div>
          <div className="api-debug-actions">
            <input
              className="field-input"
              placeholder="搜索接口 / 分组"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              className="button button-ghost"
              disabled={busy || !library}
              onClick={add}
            >
              新建
            </button>
          </div>
          {projectRequests
            .filter((r) =>
              `${r.group} ${r.name} ${r.url}`
                .toLowerCase()
                .includes(filter.toLowerCase()),
            )
            .map((r) => (
              <button
                className={`api-request-row ${selected === r.id ? "active" : ""}`}
                key={r.id}
                disabled={busy}
                onClick={() => choose(r)}
              >
                <small>{r.group}</small>
                <strong>
                  <span>{r.method}</span> {r.name}
                </strong>
              </button>
            ))}
          {library && !projectRequests.length && (
            <p className="field-help">
              从原工具目录、JSON 文件或 cURL 导入请求，也可新建接口。
            </p>
          )}
          <details>
            <summary>最近执行（本机）</summary>
            {library?.history
              .filter((h) => h.project_id === projectId)
              .map((h) => (
                <button
                  className="api-history-row"
                  key={h.id}
                  onClick={() => {
                    setResult(h);
                    liveResult.current = "";
                  }}
                >
                  {h.request_name} · {verdict(h.outcome)}
                  <small>{h.created_at}</small>
                </button>
              ))}
          </details>
        </aside>
        <main className="api-debug-main">
          <nav className="api-open-requests" aria-label="打开的接口">
            {projectRequests
              .filter((r) => openRequests.includes(r.id))
              .map((r) => (
                <button
                  key={r.id}
                  disabled={busy}
                  className={selected === r.id ? "active" : ""}
                  onClick={() => choose(r)}
                >
                  <span>{r.method}</span> {r.name}
                </button>
              ))}
          </nav>
          {request ? (
            <>
              <div className="api-debug-meta">
                <label className="field-label">
                  接口名称
                  <input
                    className="field-input"
                    value={request.name}
                    disabled={busy}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </label>
                <label className="field-label">
                  分组
                  <input
                    className="field-input"
                    value={request.group}
                    disabled={busy}
                    onChange={(e) => update({ group: e.target.value })}
                  />
                </label>
                <label className="field-label">
                  环境
                  <select
                    className="field-input"
                    disabled={busy}
                    value={envId}
                    onChange={(e) => {
                      setEnvId(e.target.value);
                      liveResult.current = "";
                      update({ environment_id: e.target.value });
                    }}
                  >
                    <option value="">无环境（请求自带变量）</option>
                    {projectEnvironments.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() =>
                    setEnvironmentEditor({
                      id: environment?.id || crypto.randomUUID(),
                      name: environment?.name || "新环境",
                      text: JSON.stringify(
                        environment?.variables || {},
                        null,
                        2,
                      ),
                    })
                  }
                >
                  配置环境
                </button>
              </div>
              <div className="api-debug-url">
                <select
                  className="field-input"
                  aria-label="请求方法"
                  value={request.method}
                  disabled={busy}
                  onChange={(e) => update({ method: e.target.value })}
                >
                  {[
                    "GET",
                    "POST",
                    "PUT",
                    "PATCH",
                    "DELETE",
                    "HEAD",
                    "OPTIONS",
                  ].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <input
                  className="field-input mono"
                  aria-label="请求 URL"
                  placeholder="https://... 或 {{BASE_URL}}/..."
                  value={request.url}
                  disabled={busy}
                  onChange={(e) =>
                    update({ url: e.target.value, query_params: undefined })
                  }
                />
                {busy ? (
                  <button
                    className="button button-danger"
                    onClick={() => abort.current?.abort()}
                  >
                    停止
                  </button>
                ) : (
                  <button
                    className="button button-primary"
                    disabled={saving || !request.url.trim()}
                    onClick={() => void send()}
                  >
                    <AppIcon name="play" size={14} />
                    发送
                  </button>
                )}
              </div>
              <div className="api-debug-actions">
                <button
                  className="text-button"
                  disabled={busy || saving || invalidVariables}
                  onClick={duplicate}
                >
                  复制接口
                </button>
                <button
                  className="text-button"
                  disabled={busy || saving || invalidVariables}
                  onClick={remove}
                >
                  删除接口
                </button>
                <details>
                  <summary>请求选项</summary>
                  <div className="api-debug-actions">
                    <label>
                      超时（毫秒）
                      <input
                        className="field-input"
                        type="number"
                        min={100}
                        max={300000}
                        value={request.timeout_ms || 30000}
                        disabled={busy}
                        onChange={(e) =>
                          update({
                            timeout_ms: Number(e.target.value) || 30000,
                          })
                        }
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={request.follow_redirects || false}
                        disabled={busy}
                        onChange={(e) =>
                          update({ follow_redirects: e.target.checked })
                        }
                      />
                      跟随重定向
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={request.insecure_tls || false}
                        disabled={busy}
                        onChange={(e) =>
                          update({ insecure_tls: e.target.checked })
                        }
                      />
                      跳过证书校验
                    </label>
                  </div>
                </details>
              </div>
              {context && (
                <div className="api-debug-actions">
                  <button
                    className="button button-ghost"
                    disabled={busy || saving}
                    onClick={() => void bind()}
                  >
                    {library?.bindings[binding] === request.id
                      ? "已绑定当前用例"
                      : "绑定到当前用例"}
                  </button>
                  <small>
                    保存结果只作用于当前轮次和用例；未设置断言时保留人工判定。
                  </small>
                </div>
              )}
              <nav className="api-debug-tabs">
                {[
                  ["params", "Params"],
                  ["auth", "Authorization"],
                  ["headers", "Headers"],
                  ["body", "Body"],
                  ["script", "Pre-request"],
                  ["tests", "Tests"],
                  ["assertions", `断言（${request.assertions.length}）`],
                  ["variables", "请求变量"],
                  ...(request.parameters?.length
                    ? [["parameters", "快捷参数"]]
                    : []),
                ].map(([id, label]) => (
                  <button
                    key={id}
                    className={editor === id ? "active" : ""}
                    onClick={() => setEditor(id)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {editor === "params" && (
                <>
                  <small>Query 参数会同步到 URL；支持 {"{{变量}}"}。</small>
                  <ApiHeadersEditor
                    kind="Query"
                    value={request.query_params || apiQueryRows(request.url)}
                    disabled={busy}
                    onChange={(query_params) =>
                      update({
                        query_params,
                        url: urlWithApiQuery(request.url, query_params),
                      })
                    }
                  />
                </>
              )}
              {editor === "auth" && (
                <>
                  <ApiAuthEditor
                    value={request.auth}
                    inherit
                    disabled={busy}
                    onChange={(auth) => update({ auth })}
                  />
                  <small>
                    项目：{project?.name}。公共 Headers
                    与脚本在“项目配置”维护，请求内同名 Header 覆盖公共值。
                  </small>
                </>
              )}
              {editor === "body" && (
                <>
                  <div className="api-debug-actions">
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        try {
                          update({
                            body: stringifyLosslessJson(
                              parseLosslessJson(request.body),
                            ),
                          });
                        } catch (e) {
                          setError(String(e));
                        }
                      }}
                    >
                      美化 JSON
                    </button>
                    <small>
                      支持 JSON
                      注释、环境变量；发送和签名使用同一份最终报文。Ctrl/⌘+Enter
                      发送。
                    </small>
                  </div>
                  <textarea
                    className="field-input api-debug-code"
                    aria-label="请求报文"
                    disabled={busy}
                    value={request.body}
                    onChange={(e) => update({ body: e.target.value })}
                  />
                </>
              )}
              {editor === "headers" && (
                <>
                  <label className="field-label">
                    应用原工具 Header 模板
                    <select
                      className="field-input"
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const template = projectHeaders.find(
                          (t) => t.id === e.target.value,
                        );
                        if (template) {
                          const keys = new Set(
                            template.headers.map((h) => h.key.toLowerCase()),
                          );
                          update({
                            headers: [
                              ...request.headers.filter(
                                (h) => !keys.has(h.key.toLowerCase()),
                              ),
                              ...structuredClone(template.headers),
                            ],
                          });
                        }
                      }}
                    >
                      <option value="">选择模板</option>
                      {projectHeaders.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ApiHeadersEditor
                    value={request.headers}
                    disabled={busy}
                    onChange={(headers) => update({ headers })}
                  />
                  {Boolean(project?.headers.length) && (
                    <details>
                      <summary>继承的项目 Headers（同名请求值优先）</summary>
                      <pre className="api-debug-output">
                        {project!.headers
                          .map(
                            (h) =>
                              `${h.enabled === false ? "# " : ""}${h.key}: ${h.value}`,
                          )
                          .join("\n")}
                      </pre>
                    </details>
                  )}
                </>
              )}
              {editor === "script" && (
                <>
                  <label className="field-label">
                    应用原工具脚本
                    <select
                      className="field-input"
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const script = projectScripts.find(
                          (s) => s.id === e.target.value,
                        );
                        if (script)
                          update({
                            pre_script: script.content,
                            signature_mode: script.signature_mode || "script",
                          });
                      }}
                    >
                      <option value="">选择脚本</option>
                      {projectScripts.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label">
                    签名方式
                    <select
                      className="field-input"
                      disabled={busy}
                      value={request.signature_mode || ""}
                      onChange={(e) =>
                        update({
                          signature_mode:
                            (e.target.value as "script" | "aliyun") ||
                            undefined,
                        })
                      }
                    >
                      <option value="">继承项目签名方式</option>
                      <option value="script">使用前置脚本</option>
                      <option value="aliyun">
                        阿里云网关（最终报文重新签名）
                      </option>
                    </select>
                  </label>
                  <small>
                    支持 pm.environment、pm.globals、pm.request、CryptoJS 和
                    legacy request。脚本最多运行 5 秒，可随请求停止。
                  </small>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => scriptFileRef.current?.click()}
                  >
                    导入 Pre-request 脚本文件
                  </button>
                  {project?.pre_script && (
                    <details>
                      <summary>已继承项目公共 Pre-request（先执行）</summary>
                      <pre className="api-debug-output">
                        {project.pre_script}
                      </pre>
                    </details>
                  )}
                  <textarea
                    className="field-input api-debug-code"
                    aria-label="前置脚本"
                    disabled={busy}
                    value={request.pre_script}
                    onChange={(e) => update({ pre_script: e.target.value })}
                  />
                </>
              )}
              {editor === "tests" && (
                <>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => scriptFileRef.current?.click()}
                  >
                    导入 Tests 脚本文件
                  </button>
                  {project?.test_script && (
                    <details>
                      <summary>已继承项目公共 Tests</summary>
                      <pre className="api-debug-output">
                        {project.test_script}
                      </pre>
                    </details>
                  )}
                  <small>
                    支持 pm.test、pm.expect、pm.response.json() /
                    text()；不兼容的脚本会明确报错。
                  </small>
                  <textarea
                    className="field-input api-debug-code"
                    aria-label="后置测试脚本"
                    disabled={busy}
                    value={request.test_script}
                    onChange={(e) => update({ test_script: e.target.value })}
                  />
                </>
              )}
              {editor === "variables" && (
                <label className="field-label">
                  请求 / 集合变量（JSON 对象，环境变量优先）
                  <textarea
                    className="field-input api-debug-code"
                    disabled={busy}
                    value={variablesText}
                    onChange={(e) => {
                      setVariablesText(e.target.value);
                      setDirty(true);
                      try {
                        const value = parseLosslessJson(e.target.value);
                        if (
                          !value ||
                          Array.isArray(value) ||
                          typeof value !== "object"
                        ) {
                          setInvalidVariables(true);
                          return;
                        }
                        setInvalidVariables(false);
                        update({
                          variables: Object.fromEntries(
                            Object.entries(value).map(([k, v]) => [
                              k,
                              String(v).replace(
                                /^___BAIZE_BIGINT_(-?\d+)___$/,
                                "$1",
                              ),
                            ]),
                          ),
                        });
                      } catch {
                        setInvalidVariables(true);
                      }
                    }}
                  />
                  {invalidVariables && (
                    <small>JSON 尚未完成，保存和切换接口前需要修正。</small>
                  )}
                </label>
              )}
              {editor === "assertions" && (
                <div className="api-debug-assertions">
                  <button
                    className="button button-ghost"
                    disabled={busy}
                    onClick={() =>
                      update({
                        assertions: [
                          ...request.assertions,
                          {
                            id: crypto.randomUUID(),
                            target: "status",
                            path: "",
                            operator: "equals",
                            expected: "200",
                          },
                        ],
                      })
                    }
                  >
                    添加断言
                  </button>
                  {request.assertions.map((a) => (
                    <div className="api-debug-assertion" key={a.id}>
                      <select
                        className="field-input"
                        aria-label="断言对象"
                        disabled={busy}
                        value={a.target}
                        onChange={(e) =>
                          changeAssertion(a.id, {
                            target: e.target.value as ApiAssertion["target"],
                          })
                        }
                      >
                        {[
                          ["status", "HTTP 状态"],
                          ["json", "JSON 字段"],
                          ["text", "响应文本"],
                          ["header", "响应 Header"],
                        ].map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                      <input
                        className="field-input"
                        disabled={busy}
                        placeholder="$.data.id / Header 名"
                        value={a.path}
                        onChange={(e) =>
                          changeAssertion(a.id, { path: e.target.value })
                        }
                      />
                      <select
                        className="field-input"
                        disabled={busy}
                        value={a.operator}
                        onChange={(e) =>
                          changeAssertion(a.id, {
                            operator: e.target
                              .value as ApiAssertion["operator"],
                          })
                        }
                      >
                        <option value="equals">等于</option>
                        <option value="contains">包含</option>
                        <option value="exists">存在</option>
                      </select>
                      <input
                        className="field-input"
                        disabled={busy || a.operator === "exists"}
                        placeholder="预期值"
                        value={a.expected}
                        onChange={(e) =>
                          changeAssertion(a.id, { expected: e.target.value })
                        }
                      />
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          update({
                            assertions: request.assertions.filter(
                              (v) => v.id !== a.id,
                            ),
                          })
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  {!request.assertions.length && (
                    <p className="field-help">
                      没有断言的响应只作为调试结果，不会自动将测试用例标为通过。
                    </p>
                  )}
                </div>
              )}
              {editor === "parameters" && (
                <div className="api-debug-parameters">
                  {request.parameters?.map((p) => (
                    <label className="field-label" key={p.path}>
                      {p.label}
                      <input
                        className="field-input"
                        disabled={busy}
                        value={displayParameter(p.path)}
                        onChange={(e) => {
                          try {
                            update({
                              body: updateApiParameter(
                                request.body,
                                p.path,
                                e.target.value,
                                p.type === "number",
                              ),
                            });
                          } catch (error) {
                            setError(String(error));
                          }
                        }}
                      />
                      <small>{p.path}</small>
                    </label>
                  ))}
                  <button
                    className="button button-ghost"
                    disabled={busy}
                    onClick={() => {
                      try {
                        let body = request.body;
                        const now = new Date(),
                          pad = (n: number) => String(n).padStart(2, "0"),
                          local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
                        for (const p of request.parameters || [])
                          if (p.path.endsWith("trigger_time"))
                            body = updateApiParameter(
                              body,
                              p.path,
                              String(Math.floor(now.getTime() / 1000)),
                              true,
                            );
                          else if (
                            p.path.endsWith("trigger_time_local") ||
                            p.path.endsWith("recotime")
                          )
                            body = updateApiParameter(body, p.path, local);
                        update({ body });
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    填充当前时间
                  </button>
                </div>
              )}
              {result && (
                <section className="api-debug-response">
                  <div className="api-debug-actions">
                    <strong>
                      {result.response
                        ? `HTTP ${result.response.status} · ${result.response.elapsed_ms} ms · ${result.response.size} bytes`
                        : "未收到响应"}
                    </strong>
                    <span>{verdict(result.outcome)}</span>
                    <button
                      className="text-button"
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          result.response?.body || result.error || "",
                        )
                      }
                    >
                      复制响应
                    </button>
                    {onApply && (
                      <button
                        className="button button-primary"
                        disabled={
                          busy ||
                          saving ||
                          liveResult.current !== result.id ||
                          result.request_id !== request.id
                        }
                        onClick={() => void apply()}
                      >
                        保存证据与用例结果
                      </button>
                    )}
                  </div>
                  {result.error && (
                    <p role="alert" className="unlock-warning">
                      {result.error}
                    </p>
                  )}
                  <nav className="api-debug-tabs">
                    {[
                      ["body", "响应"],
                      ["headers", "响应 Headers"],
                      ["checks", `断言结果（${result.checks.length}）`],
                      ["request", "实际请求"],
                      ["logs", "脚本日志"],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={resultTab === id ? "active" : ""}
                        onClick={() => setResultTab(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </nav>
                  <pre className="api-debug-output">
                    {resultTab === "body"
                      ? pretty(result.response?.body || "")
                      : resultTab === "headers"
                        ? JSON.stringify(
                            result.response?.headers || [],
                            null,
                            2,
                          )
                        : resultTab === "checks"
                          ? JSON.stringify(result.checks, null, 2)
                          : resultTab === "request"
                            ? JSON.stringify(
                                redactApiExecution(result).request,
                                null,
                                2,
                              )
                            : result.logs.join("\n")}
                  </pre>
                </section>
              )}
            </>
          ) : (
            <div className="inline-empty large">
              {library ? "选择或导入接口后开始调试。" : "正在读取本机接口库…"}
            </div>
          )}
        </main>
      </div>
      {importOpen && (
        <div className="modal-backdrop api-debug-overlay">
          <div className="modal api-debug-import-modal">
            <div className="modal-header">
              <h2>导入现有接口工具</h2>
              <button
                className="text-button"
                disabled={scanBusy || saving}
                onClick={() => setImportOpen(false)}
              >
                关闭
              </button>
            </div>
            <p>
              支持原工具 data.json、米米报文、Postman、OpenAPI、环境 JSON 及
              cURL。导入只读取原文件，预览确认后保存到本机接口库。
            </p>
            <div className="api-debug-actions">
              <input
                className="field-input"
                aria-label="原工具目录"
                value={sourceRoot}
                placeholder="选择或粘贴原工具目录"
                onChange={(e) => setSourceRoot(e.target.value)}
              />
              <button
                className="button button-ghost"
                disabled={scanBusy}
                onClick={() => void scan()}
              >
                扫描目录
              </button>
              <button
                className="button button-ghost"
                disabled={scanBusy}
                onClick={() => void chooseJsonFiles()}
              >
                选择 JSON 文件
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".json"
                hidden
                onChange={(e) => {
                  void preview(
                    Array.from(e.target.files || []).map((f) => ({
                      name: f.name,
                      text: () => f.text(),
                    })),
                  );
                  e.target.value = "";
                }}
              />
            </div>
            <div className="api-debug-sources">
              {sources.map((s) => (
                <label key={s.path}>
                  <input
                    type="checkbox"
                    checked={chosen.has(s.path)}
                    onChange={(e) =>
                      setChosen((old) => {
                        const next = new Set(old);
                        if (e.target.checked) next.add(s.path);
                        else next.delete(s.path);
                        return next;
                      })
                    }
                  />
                  {s.name} <small>{s.kind}</small>
                </label>
              ))}
            </div>
            {sources.length > 0 && (
              <button
                className="button button-ghost"
                disabled={scanBusy || !chosen.size}
                onClick={() =>
                  void preview(
                    sources
                      .filter((s) => chosen.has(s.path))
                      .map((s) => ({
                        name: s.path,
                        text: () => api.readTextFile(s.path),
                      })),
                  )
                }
              >
                预览所选文件
              </button>
            )}
            <details>
              <summary>粘贴 cURL</summary>
              <textarea
                className="field-input api-debug-code"
                aria-label="cURL 命令"
                value={curl}
                onChange={(e) => setCurl(e.target.value)}
              />
              <button
                className="button button-ghost"
                onClick={() => {
                  try {
                    setImportPreview({
                      requests: [importApiCurl(curl)],
                      environments: [],
                      warnings: [],
                    });
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                解析 cURL
              </button>
            </details>
            {importPreview && (
              <div role="status">
                <p>
                  预览：{importPreview.requests.length} 个请求，
                  {importPreview.environments.length} 个环境
                </p>
                <div className="api-debug-sources">
                  {importPreview.requests.map((r) => (
                    <div key={r.id}>
                      {r.group} / {r.name} · {r.method}
                    </div>
                  ))}
                  {importPreview.warnings.map((w, i) => (
                    <p className="unlock-warning" key={i}>
                      {w}
                    </p>
                  ))}
                </div>
                <button
                  className="button button-primary"
                  disabled={
                    saving ||
                    scanBusy ||
                    (!importPreview.requests.length &&
                      !importPreview.environments.length &&
                      !importPreview.scripts?.length &&
                      !importPreview.header_templates?.length)
                  }
                  onClick={() => void acceptImport()}
                >
                  确认导入
                </button>
              </div>
            )}
            {error && (
              <p role="alert" className="unlock-warning">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
      {environmentEditor && (
        <div className="modal-backdrop api-debug-overlay">
          <div className="modal api-debug-import-modal">
            <div className="modal-header">
              <h2>环境配置（仅本机保存）</h2>
              <button
                className="text-button"
                onClick={() => setEnvironmentEditor(null)}
              >
                关闭
              </button>
            </div>
            <label className="field-label">
              环境名称
              <input
                className="field-input"
                value={environmentEditor.name}
                onChange={(e) =>
                  setEnvironmentEditor({
                    ...environmentEditor,
                    name: e.target.value,
                  })
                }
              />
            </label>
            <label className="field-label">
              环境变量 JSON
              <textarea
                className="field-input api-debug-code"
                value={environmentEditor.text}
                onChange={(e) =>
                  setEnvironmentEditor({
                    ...environmentEditor,
                    text: e.target.value,
                  })
                }
              />
            </label>
            <button
              className="button button-primary"
              disabled={saving || !environmentEditor.name.trim()}
              onClick={() => void saveEnvironment()}
            >
              保存环境
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        </div>
      )}
      <input
        ref={scriptFileRef}
        hidden
        type="file"
        accept=".js,.txt"
        onChange={(e) => {
          const file = e.target.files?.[0],
            target = editor === "tests" ? "test_script" : "pre_script",
            id = request?.id;
          if (file)
            void file
              .text()
              .then((content) => {
                if (current.current?.requests.some((r) => r.id === id)) {
                  adopt({
                    ...current.current,
                    requests: current.current.requests.map((r) =>
                      r.id === id ? { ...r, [target]: content } : r,
                    ),
                  });
                  setDirty(true);
                  liveResult.current = "";
                }
              })
              .catch((e) => setError(String(e)));
          e.target.value = "";
        }}
      />
      {projectOpen && project && (
        <ApiProjectSettings
          project={project}
          scripts={projectScripts}
          onClose={() => setProjectOpen(false)}
          onSave={async (value) => {
            if (!current.current) return false;
            const ok = await persist({
              ...current.current,
              projects: current.current.projects?.map((p) =>
                p.id === value.id ? value : p,
              ),
            });
            if (ok) liveResult.current = "";
            return ok;
          }}
        />
      )}
      {aiOpen && project && (
        <ApiAiGenerator
          project={project}
          request={request}
          caseText={
            context ? `${context.case_title}\n${context.case_notes || ""}` : ""
          }
          onClose={() => setAiOpen(false)}
          onApply={acceptAi}
        />
      )}
    </section>
  );
}
export { executionEvidence };
