import {
  newApiRequest,
  parseLosslessJson,
  type ApiAuth,
  type ApiHeader,
  type ApiLibrary,
  type ApiProject,
  type ApiRequest,
} from "./apiDebug";

export const DEFAULT_API_PROJECT = "api-project-default";
export function newApiProject(name = "新项目"): ApiProject {
  return {
    id: crypto.randomUUID(),
    name,
    variables: {},
    headers: [],
    auth: { type: "none" },
    pre_script: "",
    test_script: "",
  };
}
// Older libraries keep every request ID and binding, so previously bound cases still open correctly.
export function normalizeApiLibrary(library: ApiLibrary): ApiLibrary {
  const projects = library.projects?.length
    ? library.projects
    : [{ ...newApiProject("默认项目"), id: DEFAULT_API_PROJECT }];
  const projectId = projects[0].id;
  const scoped = <T extends { project_id?: string }>(items: T[]) =>
    items.map((item) => ({
      ...item,
      project_id: item.project_id || projectId,
    }));
  return {
    ...library,
    version: 2,
    projects,
    requests: scoped(library.requests),
    environments: scoped(library.environments),
    scripts: scoped(library.scripts || []),
    header_templates: scoped(library.header_templates || []),
    history: library.history.map((h) => ({
      ...h,
      project_id:
        h.project_id ||
        library.requests.find((r) => r.id === h.request_id)?.project_id ||
        projectId,
    })),
  };
}
export function scopeApiImport<
  T extends {
    requests: ApiRequest[];
    environments: { id: string; project_id?: string }[];
    scripts?: { id: string; project_id?: string }[];
    header_templates?: { id: string; project_id?: string }[];
  },
>(input: T, projectId: string): T {
  const id = (value: string) => JSON.stringify([projectId, value]);
  const scoped = <U extends { id: string; project_id?: string }>(items: U[]) =>
    items.map((v) => ({ ...v, id: id(v.id), project_id: projectId }));
  return {
    ...input,
    requests: input.requests.map((r) => ({
      ...r,
      id: id(r.id),
      project_id: projectId,
      environment_id: r.environment_id
        ? id(r.environment_id)
        : r.environment_id,
    })),
    environments: scoped(input.environments),
    scripts: scoped(input.scripts || []),
    header_templates: scoped(input.header_templates || []),
  };
}
export function projectApiRequest(
  request: ApiRequest,
  project?: ApiProject,
): ApiRequest {
  if (project && request.project_id && request.project_id !== project.id)
    throw Error("请求与项目不一致，请重新选择项目");
  const headers = [...(project?.headers || [])];
  for (const h of request.headers) {
    const index = headers.findIndex(
      (v) => v.key.toLowerCase() === h.key.toLowerCase(),
    );
    if (index >= 0) headers.splice(index, 1);
    headers.push(h);
  }
  return {
    ...request,
    headers,
    auth:
      !request.auth || request.auth.type === "inherit"
        ? project?.auth || { type: "none" }
        : request.auth,
    variables: { ...project?.variables, ...request.variables },
    pre_script: [project?.pre_script, request.pre_script]
      .filter(Boolean)
      .map((s) => `{\n${s}\n}`)
      .join("\n;\n"),
    test_script: [project?.test_script, request.test_script]
      .filter(Boolean)
      .map((s) => `{\n${s}\n}`)
      .join("\n;\n"),
    signature_mode:
      request.signature_mode || project?.signature_mode || "script",
  };
}
export function authDescription(auth?: ApiAuth): string {
  return {
    inherit: "继承项目",
    none: "无鉴权",
    bearer: "Bearer Token",
    basic: "Basic Auth",
    apikey: "API Key",
  }[auth?.type || "none"];
}
export function importApiProjectSettings(
  text: string,
  project: ApiProject,
): ApiProject {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object")
    throw Error("配置应为 JSON 对象或 Headers 数组");
  const next = structuredClone(project);
  const headers = Array.isArray(value) ? value : value.headers;
  if (headers)
    next.headers = Array.isArray(headers)
      ? headers.map((h) => ({
          key: String(h.key || ""),
          value: String(h.value ?? ""),
          enabled: h.enabled !== false,
        }))
      : Object.entries(headers).map(([key, value]) => ({
          key,
          value: String(value),
          enabled: true,
        }));
  if (value.auth) {
    if (!["none", "bearer", "basic", "apikey"].includes(value.auth.type))
      throw Error("鉴权类型支持 none、bearer、basic、apikey");
    next.auth = { ...value.auth };
  }
  if (value.variables)
    next.variables = {
      ...next.variables,
      ...parseApiVariables(JSON.stringify(value.variables)),
    };
  for (const key of ["pre_script", "test_script"] as const)
    if (typeof value[key] === "string") next[key] = value[key];
  if (value.signature_mode === "aliyun" || value.signature_mode === "script")
    next.signature_mode = value.signature_mode;
  if (
    !headers &&
    !value.auth &&
    !value.variables &&
    typeof value.pre_script !== "string" &&
    typeof value.test_script !== "string"
  )
    throw Error("未找到 headers、auth、variables 或脚本字段");
  return next;
}
export function parseApiVariables(text: string): Record<string, string> {
  const value = parseLosslessJson(text);
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw Error("变量应为 JSON 对象");
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (typeof v === "object" && v !== null)
        throw Error(`变量 ${k} 应为文本或数字`);
      return [k, String(v ?? "").replace(/^___BAIZE_BIGINT_(-?\d+)___$/, "$1")];
    }),
  );
}
export function apiQueryRows(url: string): ApiHeader[] {
  const query = url.split("#")[0].split("?").slice(1).join("?");
  if (!query) return [];
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      return v;
    }
  };
  return query.split("&").map((part) => {
    const at = part.indexOf("=");
    return {
      key: decode(at < 0 ? part : part.slice(0, at)),
      value: decode(at < 0 ? "" : part.slice(at + 1)),
      enabled: true,
    };
  });
}
export function urlWithApiQuery(url: string, rows: ApiHeader[]): string {
  const fragment = url.includes("#")
    ? "#" + url.split("#").slice(1).join("#")
    : "";
  const base = url.split("#")[0].split("?")[0];
  const encode = (v: string) =>
    encodeURIComponent(v).replace(
      /%7B%7B(.*?)%7D%7D/g,
      (_, key) => `{{${decodeURIComponent(key)}}}`,
    );
  const query = rows
    .filter((r) => r.enabled !== false && r.key)
    .map((r) => `${encode(r.key)}=${encode(r.value)}`)
    .join("&");
  return base + (query ? "?" + query : "") + fragment;
}
export function apiAiPrompt(
  project: ApiProject,
  request: ApiRequest | undefined,
  cases: string,
  instructions: string,
): string {
  return `根据接口测试用例生成白泽接口调试草稿。只输出 JSON 对象，不运行请求。项目：${project.name}。
本地已配置的项目变量名：${Object.keys(project.variables).join(", ")}。鉴权方式：${authDescription(project.auth)}。公共 Headers 名：${project.headers.map((h) => h.key).join(", ")}。项目公共前置脚本${project.pre_script ? "已配置，运行时会自动先执行" : "未配置"}。
用例与补充说明：\n${cases}\n${instructions}
参考接口（仅当前请求的定义，不含项目凭据）：${request ? JSON.stringify({ name: request.name, method: request.method, url: request.url.replace(/([?&](?:token|secret|key|password|signature|authorization)=)[^&#]*/gi, "$1{{LOCAL_VALUE}}"), body: request.body, headers: request.headers.filter((h) => h.enabled !== false).map((h) => ({ key: h.key, value: /authorization|cookie|token|secret|key|signature/i.test(h.key) && !h.value.includes("{{") ? "{{LOCAL_VALUE}}" : h.value })) }) : "无"}
格式：{"notes":["缺少的接口资料或需要人工确认的地方"],"requests":[{"name":"用例场景","group":"模块","method":"POST","url":"{{BASE_URL}}/接口路径","headers":[{"key":"Content-Type","value":"application/json"}],"body":"原始请求字符串","variables":{},"pre_script":"JavaScript","test_script":"pm.test('业务期望',()=>{pm.expect(pm.response.code).to.equal(200);});","assertions":[{"target":"json","path":"$.code","operator":"equals","expected":"0"}]}]}。
规则：逐个场景保留用例前置条件、操作和期望；一个场景可拆多个有序请求，名称标序号。不要编造接口地址、业务字段、成功码或断言，资料不足写 notes 和待配置变量。负向用例按其预期失败码断言，不统一要求200。用 {{变量名}} 引用本地鉴权，不输出真实凭据。不要重复项目公共签名脚本。支持同步 pm.environment/pm.collectionVariables/pm.variables get/set/unset、pm.request.headers.upsert、pm.request.body.update、pm.response.json()/text()、pm.test、pm.expect 的 equal/eql/include/property/match/exist，CryptoJS 或 require('crypto-js')。不支持 pm.sendRequest/fetch/axios、异步脚本和 npm 任意模块，需登录或准备数据时拆为独立请求并在 notes 说明执行顺序。长整数原样留在 body 字符串，不转成JS数值。仅在用例期望明确时生成断言，否则 notes 标记待补充。`;
}
export interface ApiAiDraft {
  notes: string[];
  requests: ApiRequest[];
}
export function parseApiAiDraft(text: string, projectId: string): ApiAiDraft {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const value = JSON.parse(clean);
  if (!value || !Array.isArray(value.requests) || !value.requests.length)
    throw Error("草稿需要包含非空 requests 数组");
  const requests = value.requests.map(
    (item: Record<string, unknown>, i: number) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.url !== "string" ||
        !item.url.trim()
      )
        throw Error(`第 ${i + 1} 个请求缺少 URL 或变量占位符`);
      const method = String(item.method || "GET").toUpperCase();
      if (
        !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
          method,
        )
      )
        throw Error(`第 ${i + 1} 个请求方法无效`);
      const r: ApiRequest = {
        ...newApiRequest(),
        project_id: projectId,
        name: String(item.name || `AI 接口 ${i + 1}`),
        group: String(item.group || "AI 生成"),
        method,
        url: item.url,
        body: typeof item.body === "string" ? item.body : "",
        pre_script: typeof item.pre_script === "string" ? item.pre_script : "",
        test_script:
          typeof item.test_script === "string" ? item.test_script : "",
        source: "AI 用例生成（人工确认）",
      };
      if (Array.isArray(item.headers))
        r.headers = item.headers.map((h) => ({
          key: String(h.key || ""),
          value: String(h.value ?? ""),
          enabled: h.enabled !== false,
        }));
      r.variables = parseApiVariables(JSON.stringify(item.variables || {}));
      if (Array.isArray(item.assertions))
        r.assertions = item.assertions.map((a) => {
          if (
            !["status", "json", "text", "header"].includes(a.target) ||
            !["equals", "contains", "exists"].includes(a.operator)
          )
            throw Error(`第 ${i + 1} 个请求有不支持的断言`);
          return {
            id: crypto.randomUUID(),
            target: a.target,
            operator: a.operator,
            path: String(a.path || ""),
            expected: String(a.expected ?? ""),
          };
        });
      return r;
    },
  );
  return {
    notes: Array.isArray(value.notes) ? value.notes.map(String) : [],
    requests,
  };
}
