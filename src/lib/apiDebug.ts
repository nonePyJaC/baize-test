export interface ApiHeader {
  key: string;
  value: string;
  enabled?: boolean;
}
export interface ApiAssertion {
  id: string;
  target: "status" | "json" | "text" | "header";
  path: string;
  operator: "equals" | "contains" | "exists";
  expected: string;
}
export interface ApiParameter {
  label: string;
  path: string;
  type?: "number" | "string";
}
export interface ApiRequest {
  id: string;
  project_id?: string;
  auth?: ApiAuth;
  name: string;
  group: string;
  method: string;
  url: string;
  headers: ApiHeader[];
  query_params?: ApiHeader[];
  body: string;
  pre_script: string;
  test_script: string;
  variables: Record<string, string>;
  environment_id?: string;
  assertions: ApiAssertion[];
  parameters?: ApiParameter[];
  source?: string;
  timeout_ms?: number;
  signature_mode?: "script" | "aliyun";
  follow_redirects?: boolean;
  insecure_tls?: boolean;
}
export interface ApiEnvironment {
  id: string;
  project_id?: string;
  name: string;
  variables: Record<string, string>;
}
export interface ApiHeaderTemplate {
  id: string;
  project_id?: string;
  name: string;
  headers: ApiHeader[];
}
export interface ApiScriptTemplate {
  id: string;
  project_id?: string;
  name: string;
  content: string;
  signature_mode?: "script" | "aliyun";
}
export interface ApiLibrary {
  version: number;
  revision: number;
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  bindings: Record<string, string>;
  history: ApiExecution[];
  header_templates?: ApiHeaderTemplate[];
  scripts?: ApiScriptTemplate[];
  projects?: ApiProject[];
}
export interface ApiAuth {
  type: "inherit" | "none" | "bearer" | "basic" | "apikey";
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  value?: string;
  location?: "header" | "query";
}
export interface ApiProject {
  id: string;
  name: string;
  variables: Record<string, string>;
  headers: ApiHeader[];
  auth: ApiAuth;
  pre_script: string;
  test_script: string;
  signature_mode?: "script" | "aliyun";
}
export interface ApiResponse {
  status: number;
  headers: ApiHeader[];
  body: string;
  elapsed_ms: number;
  size: number;
  truncated: boolean;
  url: string;
}
export interface ApiCheck {
  name: string;
  passed: boolean;
  actual?: string;
  expected?: string;
}
export interface ApiExecution {
  id: string;
  project_id?: string;
  request_id: string;
  request_name: string;
  environment_id: string;
  created_at: string;
  environment_name?: string;
  request: {
    method: string;
    url: string;
    headers: ApiHeader[];
    body: string;
    follow_redirects?: boolean;
    insecure_tls?: boolean;
  };
  response?: ApiResponse;
  checks: ApiCheck[];
  outcome: "passed" | "failed" | "unverified" | "stopped";
  logs: string[];
  error?: string;
  variable_updates?: {
    environment?: Record<string, string>;
    collection?: Record<string, string>;
  };
}
export interface ApiImportSource {
  path: string;
  name: string;
  kind: string;
  size: number;
}
export const newApiLibrary = (): ApiLibrary => ({
  version: 1,
  revision: 0,
  requests: [],
  environments: [],
  bindings: {},
  history: [],
});
export const newApiRequest = (): ApiRequest => ({
  id: crypto.randomUUID(),
  name: "新建接口",
  group: "我的接口",
  method: "POST",
  url: "",
  headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
  body: "{}",
  pre_script: "",
  test_script: "",
  variables: {},
  assertions: [],
});
export const apiBindingKey = (
  workspace: string,
  platform: string,
  requirement: string,
  caseId: string,
) => JSON.stringify([workspace, platform, requirement, caseId]);
export function apiCaseVerdict(
  execution: ApiExecution,
  currentStatus: string,
): { status: string; resetRetest: boolean } {
  if (
    execution.outcome === "passed" &&
    execution.response &&
    !execution.response.truncated &&
    execution.checks.length > 0 &&
    execution.checks.every((c) => c.passed)
  )
    return { status: "passed", resetRetest: true };
  if (execution.outcome === "failed")
    return {
      status: execution.response ? "failed" : "blocked",
      resetRetest: Boolean(execution.response),
    };
  return { status: currentStatus, resetRetest: false };
}
export function stripJsonComments(text: string): string {
  let result = "",
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      n = text[i + 1];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      result += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      result += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") result += "\n";
        i++;
      }
      i++;
      continue;
    }
    result += c;
  }
  return result;
}
export function parseLosslessJson(text: string): unknown {
  return JSON.parse(
    stripJsonComments(text).replace(
      /("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m, s, n) =>
        s || (/^-?\d{16,}$/.test(n) ? `"___BAIZE_BIGINT_${n}___"` : m),
    ),
  );
}
export function stringifyLosslessJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /"___BAIZE_BIGINT_(-?\d+)___"/g,
    "$1",
  );
}
export function jsonPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  return parts.reduce<unknown>(
    (v, p) =>
      v !== null && typeof v === "object"
        ? (v as Record<string, unknown>)[p]
        : undefined,
    value,
  );
}
export function updateApiParameter(
  body: string,
  path: string,
  value: string,
  numeric = false,
): string {
  const obj = parseLosslessJson(body) as Record<string, unknown>;
  const parts = path.split(".");
  let current = obj;
  for (const key of parts.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object")
      throw Error(`报文中不存在 ${path}`);
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = numeric
    ? value === ""
      ? null
      : /^-?\d{16,}$/.test(value)
        ? `___BAIZE_BIGINT_${value}___`
        : Number.isNaN(Number(value))
          ? value
          : Number(value)
    : value;
  return stringifyLosslessJson(obj);
}
export function evaluateApiAssertions(
  assertions: ApiAssertion[],
  response: ApiResponse,
): ApiCheck[] {
  let parsed: unknown;
  try {
    parsed = parseLosslessJson(response.body);
  } catch {
    /* text response */
  }
  return assertions.map((a) => {
    const actual =
      a.target === "status"
        ? response.status
        : a.target === "json"
          ? jsonPath(parsed, a.path)
          : a.target === "header"
            ? response.headers.find(
                (h) => h.key.toLowerCase() === a.path.toLowerCase(),
              )?.value
            : response.body;
    const text = (
      typeof actual === "object" ? JSON.stringify(actual) : String(actual ?? "")
    ).replace(/^___BAIZE_BIGINT_(-?\d+)___$/, "$1");
    const passed =
      a.operator === "exists"
        ? actual !== undefined && actual !== null
        : a.operator === "contains"
          ? text.includes(a.expected)
          : text === a.expected;
    return {
      name: `${a.target}${a.path ? ` ${a.path}` : ""} ${a.operator}`,
      passed,
      actual: text,
      expected: a.expected,
    };
  });
}
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const strings = (v: unknown): Record<string, string> =>
  Array.isArray(v)
    ? Object.fromEntries(
        v
          .filter(
            (x) =>
              asRecord(x).disabled !== true && asRecord(x).enabled !== false,
          )
          .map((x) => {
            const r = asRecord(x);
            return [String(r.key || ""), String(r.value ?? "")];
          })
          .filter(([k]) => k),
      )
    : Object.fromEntries(
        Object.entries(asRecord(v)).map(([k, v]) => [k, String(v ?? "")]),
      );
const scriptText = (events: unknown, kind: string): string =>
  Array.isArray(events)
    ? events
        .filter((x) => asRecord(x).listen === kind)
        .map((x) => {
          const s = asRecord(asRecord(x).script).exec;
          return Array.isArray(s) ? s.join("\n") : String(s || "");
        })
        .join("\n")
    : "";
const headers = (value: unknown): ApiHeader[] =>
  Array.isArray(value)
    ? value.map((v) => {
        const x = asRecord(v);
        return {
          key: String(x.key || ""),
          value: String(x.value ?? ""),
          enabled: x.disabled !== true && x.enabled !== false,
        };
      })
    : Object.entries(asRecord(value)).map(([key, value]) => ({
        key,
        value: String(value),
        enabled: true,
      }));
const stableId = (source: string, kind: string, key: string) =>
  JSON.stringify([source.replace(/\\/g, "/"), kind, key]);
export function importApiDocument(
  content: string,
  source: string,
): {
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  warnings: string[];
  header_templates?: ApiHeaderTemplate[];
  scripts?: ApiScriptTemplate[];
} {
  const data = asRecord(JSON.parse(content.replace(/^\uFEFF/, "")));
  const result: ReturnType<typeof importApiDocument> = {
    requests: [],
    environments: [],
    warnings: [],
  };
  const create = (key: string, changes: Partial<ApiRequest>) => ({
    ...newApiRequest(),
    id: stableId(source, "request", key),
    source,
    ...changes,
  });
  if (Array.isArray(data.collections)) {
    const scripts = new Map(
      (Array.isArray(data.scripts) ? data.scripts : []).map((x) => [
        String(asRecord(x).id),
        String(asRecord(x).content || ""),
      ]),
    );
    result.scripts = (Array.isArray(data.scripts) ? data.scripts : []).map(
      (v) => {
        const s = asRecord(v);
        return {
          id: stableId(source, "script", String(s.id)),
          name: String(s.name || s.id),
          content: String(s.content || ""),
          signature_mode: s.id === "foton-sign" ? "aliyun" : "script",
        };
      },
    );
    result.header_templates = (
      Array.isArray(data.templates) ? data.templates : []
    ).map((v) => {
      const t = asRecord(v);
      return {
        id: stableId(source, "headers", String(t.id)),
        name: String(t.name || t.id),
        headers: headers(t.headers),
      };
    });
    for (const e of Array.isArray(data.environments) ? data.environments : []) {
      const env = asRecord(e);
      result.environments.push({
        id: stableId(source, "env", String(env.id)),
        name: String(env.name || env.id),
        variables: strings(env.variables),
      });
    }
    const walk = (rows: unknown[], group: string) =>
      rows.forEach((v) => {
        const r = asRecord(v),
          name = String(r.name || "未命名");
        if (Array.isArray(r.children)) {
          walk(r.children, [group, name].filter(Boolean).join("/"));
          return;
        }
        result.requests.push(
          create(String(r.id || [group, name].join("/")), {
            name,
            group,
            method: String(r.method || "POST"),
            url: String(r.url || ""),
            headers: headers(r.headers),
            body: String(r.body || ""),
            pre_script: scripts.get(String(r.scriptId)) || "",
            signature_mode: r.scriptId === "foton-sign" ? "aliyun" : "script",
            environment_id: r.envId
              ? stableId(source, "env", String(r.envId))
              : undefined,
          }),
        );
      });
    walk(data.collections, "");
  } else if (Array.isArray(data.item)) {
    const collectionVariables = strings(data.variable);
    const authConfig = (auth: unknown): ApiAuth | undefined => {
      const a = asRecord(auth),
        kind = String(a.type || "");
      const v = strings(a[kind]);
      if (!kind || kind === "inherit") return undefined;
      if (kind === "noauth") return { type: "none" };
      if (kind === "bearer") return { type: "bearer", token: v.token || "" };
      if (kind === "basic")
        return {
          type: "basic",
          username: v.username || "",
          password: v.password || "",
        };
      if (kind === "apikey")
        return {
          type: "apikey",
          key: v.key || "",
          value: v.value || "",
          location: v.in === "query" ? "query" : "header",
        };
      result.warnings.push(`鉴权 ${kind} 需要在项目或请求中补充配置`);
      return undefined;
    };
    const walk = (
      rows: unknown[],
      group: string,
      pre: string,
      tests: string,
      auth: unknown,
    ) =>
      rows.forEach((v) => {
        const n = asRecord(v),
          name = String(n.name || "未命名");
        const before = [pre, scriptText(n.event, "prerequest")]
            .filter(Boolean)
            .join("\n"),
          after = [tests, scriptText(n.event, "test")]
            .filter(Boolean)
            .join("\n");
        if (Array.isArray(n.item)) {
          walk(
            n.item,
            [group, name].filter(Boolean).join("/"),
            before,
            after,
            n.auth || auth,
          );
          return;
        }
        const r =
            typeof n.request === "string"
              ? { url: n.request }
              : asRecord(n.request),
          body = asRecord(r.body),
          url =
            typeof r.url === "string"
              ? r.url
              : String(asRecord(r.url).raw || "");
        const mode = String(body.mode || "raw");
        if (!["raw", "urlencoded"].includes(mode)) {
          result.warnings.push(
            `${name} 使用 ${mode} 报文，请检查后转换为原始报文`,
          );
        }
        let raw = String(body.raw || "");
        if (mode === "urlencoded")
          raw = new URLSearchParams(strings(body.urlencoded)).toString();
        const hs = headers(r.header);
        if (
          mode === "urlencoded" &&
          !hs.some((h) => h.key.toLowerCase() === "content-type")
        )
          hs.push({
            key: "Content-Type",
            value: "application/x-www-form-urlencoded",
          });
        result.requests.push(
          create([group, name].join("/"), {
            name,
            group,
            method: String(r.method || "GET"),
            url,
            headers: hs,
            auth: authConfig(r.auth || auth),
            body: raw,
            pre_script: before,
            test_script: after,
            variables: collectionVariables,
          }),
        );
      });
    walk(
      data.item,
      String(asRecord(data.info).name || "Postman"),
      scriptText(data.event, "prerequest"),
      scriptText(data.event, "test"),
      data.auth,
    );
    const missing = new Set<string>();
    for (const request of result.requests)
      for (const match of request.url.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const key = match[1];
        if (
          !key.startsWith("$") &&
          !Object.entries(collectionVariables).some(
            ([k, v]) => k.toLowerCase() === key.toLowerCase() && v,
          )
        )
          missing.add(key);
      }
    for (const request of result.requests)
      for (const match of request.pre_script.matchAll(
        /pm\.environment\.get\(\s*['"]([^'"]+)['"]\s*\)/g,
      )) {
        const key = match[1];
        if (
          !Object.entries(collectionVariables).some(
            ([k, v]) => k.toLowerCase() === key.toLowerCase() && v,
          )
        )
          missing.add(key);
      }
    if (missing.size) {
      const id = stableId(source, "env", "postman-required");
      result.environments.push({
        id,
        name: `${String(asRecord(data.info).name || "Postman")}（待配置）`,
        variables: Object.fromEntries([...missing].map((k) => [k, ""])),
      });
      for (const request of result.requests) request.environment_id = id;
      result.warnings.push(
        `此集合未导出完整环境，请补齐：${[...missing].join("、")}`,
      );
    }
  } else if (data.cameraType && data.originalPayload) {
    const payload = asRecord(data.originalPayload),
      alarm = payload.alarmInfoPlate ? "alarmInfoPlate" : "AlarmInfoPlate",
      plate = asRecord(asRecord(payload[alarm]).result).plateResult
        ? "plateResult"
        : "PlateResult";
    const base = `originalPayload.${alarm}`;
    const parameters: ApiParameter[] = [
      { label: "摄像头类型", path: "cameraType" },
      { label: "车牌", path: `${base}.result.${plate}.license` },
      {
        label: "设备序列号",
        path: `${base}.${alarm === "alarmInfoPlate" ? "seriaIno" : "serialno"}`,
      },
      { label: "IP 地址", path: `${base}.ipaddr` },
      { label: "设备名称", path: `${base}.deviceName` },
      { label: "通道", path: `${base}.channel`, type: "number" },
      {
        label: "触发类型",
        path: `${base}.result.${plate}.triggerType`,
        type: "number",
      },
      {
        label: "方向",
        path: `${base}.result.${plate}.direction`,
        type: "number",
      },
      { label: "识别时间", path: `${base}.result.${plate}.recotime` },
      { label: "门店编码", path: "vehicleInsuranceInfo.shop_external_code" },
      { label: "保险车牌", path: "vehicleInsuranceInfo.auto_license" },
      {
        label: "触发时间戳",
        path: "vehicleInsuranceInfo.trigger_time",
        type: "number",
      },
      { label: "触发时间", path: "vehicleInsuranceInfo.trigger_time_local" },
      { label: "截止日期", path: "vehicleInsuranceInfo.end_date" },
    ];
    result.requests.push(
      create("camera", {
        name: `米米 ${String(data.cameraType)}`,
        group: "米米/摄像头",
        url: "{{MIMI_URL}}",
        body: content.trim(),
        parameters: parameters.filter(
          (p) => jsonPath(data, p.path) !== undefined,
        ),
      }),
    );
    result.environments.push({
      id: stableId(source, "env", "mimi-pre"),
      name: "米米（待配置）",
      variables: {
        MIMI_URL: "",
      },
    });
    result.warnings.push("请在米米环境中填写 MIMI_URL 后发送，客户端不预置业务系统地址");
    result.requests[0].environment_id = result.environments[0].id;
  } else if (Array.isArray(data.values)) {
    result.environments.push({
      id: stableId(source, "env", String(data.name || "环境")),
      name: String(data.name || "环境"),
      variables: strings(data.values),
    });
  } else if (data.openapi || data.swagger) {
    const server = String(
      asRecord(Array.isArray(data.servers) ? data.servers[0] : null).url ||
        "{{BASE_URL}}",
    );
    for (const [path, pathItem] of Object.entries(asRecord(data.paths)))
      for (const [method, operation] of Object.entries(asRecord(pathItem))) {
        if (
          ![
            "get",
            "post",
            "put",
            "patch",
            "delete",
            "head",
            "options",
          ].includes(method)
        )
          continue;
        const op = asRecord(operation),
          media = asRecord(
            asRecord(asRecord(op.requestBody).content)["application/json"],
          );
        const sample = media.example ?? asRecord(media.schema).example;
        result.requests.push(
          create(`${method} ${path}`, {
            name: String(
              op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
            ),
            group: "OpenAPI",
            method: method.toUpperCase(),
            url: server + path.replace(/\{([^}]+)\}/g, "{{$1}}"),
            body: sample === undefined ? "" : JSON.stringify(sample, null, 2),
          }),
        );
      }
    result.warnings.push(
      "OpenAPI 已导入路径与示例，请补齐参数、认证和业务断言后执行",
    );
  } else {
    throw Error(
      "未识别此文件：支持原工具 data.json、Postman、米米报文、OpenAPI 和 Postman 环境",
    );
  }
  return result;
}
export function mergeApiImport(
  library: ApiLibrary,
  imported: ReturnType<typeof importApiDocument>,
): ApiLibrary {
  // Re-import never overwrites an edited request or environment with the same stable source identity.
  const merge = <T extends { id: string }>(old: T[], rows: T[]) => [
    ...old,
    ...rows.filter((r) => !old.some((v) => v.id === r.id)),
  ];
  return {
    ...library,
    requests: merge(library.requests, imported.requests),
    environments: merge(library.environments, imported.environments),
    header_templates: merge(
      library.header_templates || [],
      imported.header_templates || [],
    ),
    scripts: merge(library.scripts || [], imported.scripts || []),
  };
}
export function importApiCurl(command: string): ApiRequest {
  const tokens: string[] = [];
  let token = "",
    quote = "",
    escape = false,
    started = false;
  for (const c of command.replace(/\\\r?\n|\^\r?\n/g, " ")) {
    if (escape) {
      token += c;
      escape = false;
      started = true;
      continue;
    }
    if (c === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      else token += c;
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += c;
    started = true;
  }
  if (quote) throw Error("cURL 引号未闭合");
  if (started) tokens.push(token);
  if (!/^curl(?:\.exe)?$/i.test(tokens.shift() || ""))
    throw Error("请粘贴 cURL 命令");
  const r = newApiRequest();
  r.name = "导入的 cURL";
  r.headers = [];
  r.method = "GET";
  r.body = "";
  let explicitMethod = false,
    dataUsed = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-X" || t === "--request") {
      r.method = tokens[++i] || "GET";
      explicitMethod = true;
    } else if (t === "-H" || t === "--header") {
      const h = tokens[++i] || "",
        p = h.indexOf(":");
      if (p >= 0)
        r.headers.push({ key: h.slice(0, p), value: h.slice(p + 1).trim() });
    } else if (
      [
        "-d",
        "--data",
        "--data-raw",
        "--data-binary",
        "--data-urlencode",
      ].includes(t)
    ) {
      let body = tokens[++i] || "";
      if (body.startsWith("@") && t !== "--data-raw")
        throw Error("请将 cURL 文件引用替换为实际报文后导入");
      if (t === "--data-urlencode") {
        const p = body.indexOf("=");
        body =
          p < 0
            ? encodeURIComponent(body)
            : `${body.slice(0, p)}=${encodeURIComponent(body.slice(p + 1))}`;
      }
      r.body = dataUsed ? r.body + "&" + body : body;
      dataUsed = true;
      if (!explicitMethod) r.method = "POST";
    } else if (t === "--url") r.url = tokens[++i] || "";
    else if (t === "-b" || t === "--cookie")
      r.headers.push({ key: "Cookie", value: tokens[++i] || "" });
    else if (t === "--location" || t === "-L") r.follow_redirects = true;
    else if (t === "--insecure" || t === "-k") r.insecure_tls = true;
    else if (/^https?:\/\//i.test(t) || t.startsWith("{{")) r.url = t;
    else if (!["--compressed", "--globoff", "-s", "--silent"].includes(t))
      throw Error(`暂不支持 cURL 选项 ${t}，请先转为 URL / Headers / 原始报文`);
  }
  if (!r.url) throw Error("cURL 缺少 URL");
  if (
    dataUsed &&
    !r.headers.some((h) => h.key.toLowerCase() === "content-type")
  )
    r.headers.push({
      key: "Content-Type",
      value: "application/x-www-form-urlencoded",
    });
  return r;
}
export function redactApiExecution(result: ApiExecution): ApiExecution {
  const sensitive =
    /authorization|cookie|token|secret|signature|app.key|x-ca-key/i;
  const hide = (rows: ApiHeader[]) =>
    rows.map((h) => (sensitive.test(h.key) ? { ...h, value: "[已隐藏]" } : h));
  const url = result.request.url.replace(
    /([?&](?:[^=&]*(?:token|secret|key|signature)[^=&]*)=)[^&]*/gi,
    "$1[已隐藏]",
  );
  return {
    ...result,
    logs: [],
    variable_updates: undefined,
    request: { ...result.request, url, headers: hide(result.request.headers) },
    response: result.response
      ? { ...result.response, headers: hide(result.response.headers) }
      : undefined,
  };
}
