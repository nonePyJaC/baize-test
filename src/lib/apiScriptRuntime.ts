import CryptoJS from "crypto-js";
import forge from "node-forge";
import type { ApiCheck, ApiHeader, ApiRequest, ApiResponse } from "./apiDebug";
import { stripJsonComments } from "./apiDebug";
export interface ScriptInput {
  request: ApiRequest;
  variables: Record<string, string>;
  response?: ApiResponse;
  environment_variables?: Record<string, string>;
  collection_variables?: Record<string, string>;
}
export interface ScriptOutput {
  method: string;
  url: string;
  headers: ApiHeader[];
  body: string;
  variables: Record<string, string>;
  logs: string[];
  checks: ApiCheck[];
  environment_variables?: Record<string, string>;
  collection_variables?: Record<string, string>;
}
export function replaceApiVariables(
  text: string,
  values: Record<string, string>,
): string {
  const vars = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, key) => {
    const dynamic = key.toLowerCase();
    if (dynamic === "$timestamp") return String(Math.floor(Date.now() / 1000));
    if (dynamic === "$guid" || dynamic === "$randomuuid")
      return crypto.randomUUID();
    if (dynamic === "$localtime") {
      const d = new Date(),
        pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    return vars[dynamic] ?? m;
  });
}
const normalize = (s: string) => s.replace(/\r\n?/g, "\n");
export function runApiScript(input: ScriptInput): ScriptOutput {
  const logs: string[] = [],
    checks: ApiCheck[] = [],
    variables = { ...input.variables },
    r = input.request;
  let hs = r.headers
    .filter((h) => h.enabled !== false && h.key.trim())
    .map((h) => ({ ...h, value: replaceApiVariables(h.value, variables) }));
  const get = (key: string) =>
    hs.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
  const put = (h: ApiHeader) => {
    hs = hs.filter((x) => x.key.toLowerCase() !== h.key.toLowerCase());
    hs.push({ key: h.key, value: String(h.value), enabled: true });
  };
  const headers = {
    get,
    each: (fn: (h: ApiHeader) => void) => hs.forEach(fn),
    add: put,
    upsert: put,
    remove: (key: string) => {
      hs = hs.filter((h) => h.key.toLowerCase() !== key.toLowerCase());
    },
    toObject: () => Object.fromEntries(hs.map((h) => [h.key, h.value])),
  };
  const initialUrl = replaceApiVariables(r.url, variables);
  const resolveUrl = () => {
    try {
      return new URL(replaceApiVariables(r.url, variables));
    } catch {
      const keys = [...r.url.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(
        (m) => m[1],
      );
      throw Error(
        `URL 无效，请检查环境变量${keys.length ? "：" + keys.join("、") : ""}`,
      );
    }
  };
  const urlObject = {
    get path() {
      return resolveUrl().pathname.split("/").filter(Boolean);
    },
    query: {
      each: (fn: (p: { key: string; value: string }) => void) =>
        resolveUrl().searchParams.forEach((value, key) => fn({ key, value })),
    },
    toString: () => replaceApiVariables(r.url, variables),
    getPath: () => resolveUrl().pathname,
    getPathWithQuery: () => {
      const url = resolveUrl();
      return url.pathname + url.search;
    },
  };
  let raw = normalize(replaceApiVariables(r.body, variables));
  if ((get("Content-Type") || "").includes("json"))
    raw = stripJsonComments(raw);
  const body = {
    raw,
    urlencoded: {
      each: (fn: (p: { key: string; value: string }) => void) =>
        new URLSearchParams(body.raw).forEach((value, key) =>
          fn({ key, value }),
        ),
    },
    update: (value: unknown) => {
      body.raw = typeof value === "string" ? value : JSON.stringify(value);
    },
  };
  const store = {
    get: (key: string) => {
      const found = Object.keys(variables).find(
        (k) => k.toLowerCase() === key.toLowerCase(),
      );
      return found ? variables[found] : undefined;
    },
    set: (key: string, value: unknown) => {
      const found = Object.keys(variables).find(
        (k) => k.toLowerCase() === key.toLowerCase(),
      );
      variables[found || key] = String(value);
    },
    unset: (key: string) => {
      for (const k of Object.keys(variables))
        if (k.toLowerCase() === key.toLowerCase()) delete variables[k];
    },
    replaceIn: (s: string) => replaceApiVariables(s, variables),
    toObject: () => ({ ...variables }),
  };
  const scopedStore = (scope: Record<string, string> | undefined) =>
    !scope
      ? store
      : {
          get: (key: string) => scope[key],
          set: (key: string, value: unknown) => {
            scope[key] = String(value);
            variables[key] = String(value);
          },
          unset: (key: string) => {
            delete scope[key];
            delete variables[key];
          },
          replaceIn: store.replaceIn,
          toObject: () => ({ ...scope }),
        };
  const envVariables = input.environment_variables && {
    ...input.environment_variables,
  };
  const collectionVariables = input.collection_variables && {
    ...input.collection_variables,
  };
  const expect = (value: unknown) => {
    let negate = false,
      deep = false;
    const check = (ok: boolean) => {
      if (negate ? ok : !ok) throw Error(`断言不匹配：${String(value)}`);
    };
    const api: Record<string, unknown> = {
      equal: (v: unknown) =>
        check(deep ? JSON.stringify(v) === JSON.stringify(value) : value === v),
      eql: (v: unknown) => check(JSON.stringify(value) === JSON.stringify(v)),
      include: (v: unknown) =>
        check(
          typeof value === "string"
            ? value.includes(String(v))
            : Array.isArray(value) && value.includes(v),
        ),
      above: (v: number) => check(Number(value) > v),
      below: (v: number) => check(Number(value) < v),
      match: (v: RegExp) => check(v.test(String(value))),
      property: (key: string) => {
        check(value !== null && typeof value === "object" && key in value);
        return expect((value as Record<string, unknown>)?.[key]);
      },
      lengthOf: (n: number) =>
        check((value as { length?: number })?.length === n),
    };
    for (const key of ["to", "be", "have", "and", "that", "is"])
      Object.defineProperty(api, key, { get: () => api });
    Object.defineProperty(api, "not", {
      get: () => {
        negate = !negate;
        return api;
      },
    });
    Object.defineProperty(api, "deep", {
      get: () => {
        deep = true;
        return api;
      },
    });
    for (const [key, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
      ["undefined", undefined],
    ] as const)
      Object.defineProperty(api, key, {
        get: () => {
          check(value === v);
          return api;
        },
      });
    Object.defineProperty(api, "exist", {
      get: () => {
        check(value !== null && value !== undefined);
        return api;
      },
    });
    return api;
  };
  const response = input.response;
  const pm = {
    environment: scopedStore(envVariables),
    globals: store,
    collectionVariables: scopedStore(collectionVariables),
    variables: store,
    request: { method: r.method, url: urlObject, headers, body },
    response: response
      ? {
          code: response.status,
          status: String(response.status),
          responseTime: response.elapsed_ms,
          headers: {
            get: (key: string) =>
              response.headers.find(
                (h) => h.key.toLowerCase() === key.toLowerCase(),
              )?.value,
          },
          json: () => JSON.parse(response.body),
          text: () => response.body,
          to: {
            have: {
              status: (code: number) => {
                if (response.status !== code)
                  throw Error(`HTTP ${response.status}，预期 ${code}`);
              },
            },
          },
        }
      : undefined,
    test: (name: string, fn: () => void) => {
      try {
        if (fn.length > 0 || fn.constructor.name === "AsyncFunction")
          throw Error("当前支持同步 pm.test，请将异步步骤拆成独立请求");
        const value: unknown = fn();
        if (value && typeof (value as Promise<unknown>).then === "function") {
          void Promise.resolve(value).catch(() => {});
          throw Error("异步测试尚未支持，不会自动判为通过");
        }
        checks.push({ name, passed: true });
      } catch (e) {
        checks.push({ name, passed: false, actual: String(e) });
      }
    },
    expect,
  };
  const log = (...args: unknown[]) =>
    logs.push(
      args
        .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
        .join(" "),
    );
  const legacyHeaders = Object.fromEntries(
    hs.flatMap((h) => [
      [h.key, h.value],
      [h.key.toLowerCase(), h.value],
    ]),
  );
  let legacyData: unknown = {};
  try {
    legacyData = JSON.parse(body.raw);
  } catch {
    legacyData = Object.fromEntries(new URLSearchParams(body.raw));
  }
  const legacy = {
    method: r.method,
    get url() {
      return replaceApiVariables(r.url, variables);
    },
    headers: legacyHeaders,
    data: legacyData,
    body,
  };
  const code = response ? r.test_script : r.pre_script;
  let scriptValue: unknown;
  if (code.trim())
    scriptValue = new Function(
      "pm",
      "CryptoJS",
      "console",
      "request",
      "postman",
      "require",
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      code,
    )(
      pm,
      CryptoJS,
      { log, info: log, warn: log, error: log },
      legacy,
      {
        setGlobalVariable: store.set,
        getGlobalVariable: store.get,
        clearGlobalVariable: store.unset,
        setEnvironmentVariable: store.set,
      },
      (name: string) => {
        if (name === "crypto-js") return CryptoJS;
        if (name === "jsrsasign")
          return {
            KEYUTIL: {
              getKey: (pem: string) => {
                const key = forge.pki.publicKeyFromPem(pem);
                return {
                  encrypt: (text: string) =>
                    forge.util.bytesToHex(
                      key.encrypt(
                        forge.util.encodeUtf8(String(text)),
                        "RSAES-PKCS1-V1_5",
                      ),
                    ),
                };
              },
            },
            hextob64: (hex: string) =>
              forge.util.encode64(forge.util.hexToBytes(hex)),
          };
        throw Error(`脚本模块未支持：${name}`);
      },
      () => {
        throw Error("脚本内独立网络请求尚未支持，请在接口列表中配置并发送");
      },
      () => {
        throw Error("脚本内独立网络请求尚未支持，请在接口列表中配置并发送");
      },
      () => {
        throw Error("脚本内 WebSocket 尚未支持");
      },
    );
  if (
    scriptValue &&
    typeof (scriptValue as Promise<unknown>).then === "function"
  ) {
    void Promise.resolve(scriptValue).catch(() => {});
    throw Error("异步前后置脚本尚未支持，请使用同步脚本或拆成独立请求");
  }
  let finalUrl = replaceApiVariables(pm.request.url.toString(), variables);
  const finalBody = normalize(replaceApiVariables(body.raw, variables));
  hs = hs.map((h) => ({
    ...h,
    value: replaceApiVariables(h.value, variables),
  }));
  if (!response && r.auth && !["inherit", "none"].includes(r.auth.type)) {
    const auth = r.auth,
      resolve = (value?: string) => replaceApiVariables(value || "", variables);
    if (auth.type === "bearer")
      put({ key: "Authorization", value: `Bearer ${resolve(auth.token)}` });
    if (auth.type === "basic")
      put({
        key: "Authorization",
        value: `Basic ${CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(`${resolve(auth.username)}:${resolve(auth.password)}`))}`,
      });
    if (auth.type === "apikey") {
      const key = resolve(auth.key),
        value = resolve(auth.value);
      if (!key.trim()) throw Error("API Key 名称尚未配置");
      if (auth.location === "query") {
        const u = new URL(finalUrl);
        u.searchParams.set(key, value);
        finalUrl = u.toString();
      } else put({ key, value });
    }
  }
  if (!response && r.signature_mode === "aliyun") {
    const key = store.get("APP_KEY") || get("X-Ca-Key"),
      secret = store.get("APP_SECRET");
    if (!key || !secret)
      throw Error("阿里云网关签名缺少 APP_KEY 或 APP_SECRET");
    const contentType = get("Content-Type") || "application/json",
      accept = get("Accept") || "application/json",
      stage = store.get("X_CA_STAGE") || get("X-Ca-Stage") || "TEST",
      date = new Date().toUTCString(),
      nonce = crypto.randomUUID();
    const md5 =
      finalBody && finalBody !== "{}"
        ? CryptoJS.MD5(finalBody).toString(CryptoJS.enc.Base64)
        : "";
    for (const h of [
      { key: "Accept", value: accept },
      { key: "Content-Type", value: contentType },
      { key: "Date", value: date },
      { key: "X-Ca-Key", value: key },
      { key: "X-Ca-Nonce", value: nonce },
      { key: "X-Ca-Stage", value: stage },
      { key: "X-Ca-SignatureMethod", value: "HmacSHA256" },
      {
        key: "X-Ca-Signature-Headers",
        value: "x-ca-key,x-ca-nonce,x-ca-stage",
      },
    ])
      put(h);
    headers.remove("Content-MD5");
    if (md5) put({ key: "Content-MD5", value: md5 });
    const u = new URL(finalUrl),
      query = [...u.searchParams.entries()]
        .sort(([a, av], [b, bv]) =>
          a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1,
        )
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
    const canonical = [
      pm.request.method,
      accept,
      md5,
      contentType,
      date,
      `x-ca-key:${key}`,
      `x-ca-nonce:${nonce}`,
      `x-ca-stage:${stage}`,
      u.pathname + (query ? "?" + query : ""),
    ].join("\n");
    put({
      key: "X-Ca-Signature",
      value: CryptoJS.HmacSHA256(canonical, secret).toString(
        CryptoJS.enc.Base64,
      ),
    });
  }
  if (!response) {
    for (const text of [finalUrl, finalBody, ...hs.map((h) => h.value)])
      if (/\{\{[^{}]+\}\}/.test(text))
        throw Error(
          `仍有未替换的环境变量：${[...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]).join("、")}，请补全后执行`,
        );
    try {
      new URL(finalUrl);
    } catch {
      resolveUrl();
      throw Error("最终 URL 无效");
    }
    if ((get("Content-Type") || "").includes("json") && finalBody.trim())
      JSON.parse(finalBody);
  }
  return {
    method: pm.request.method,
    url: finalUrl,
    headers: hs,
    body: finalBody,
    variables,
    logs,
    checks,
    environment_variables: envVariables,
    collection_variables: collectionVariables,
  };
}
