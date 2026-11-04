import React, { useRef, useState } from "react";
import {
  authDescription,
  importApiProjectSettings,
  parseApiVariables,
} from "../lib/apiWorkbench";
import type {
  ApiAuth,
  ApiHeader,
  ApiProject,
  ApiScriptTemplate,
} from "../lib/apiDebug";

export function ApiAuthEditor({
  value,
  onChange,
  inherit = false,
  disabled = false,
}: {
  value?: ApiAuth;
  onChange: (v: ApiAuth) => void;
  inherit?: boolean;
  disabled?: boolean;
}) {
  const auth = value || { type: inherit ? "inherit" : "none" };
  const input = (
    key: keyof ApiAuth,
    label: string,
    placeholder: string,
    password = false,
  ) => (
    <label className="field-label" key={key}>
      {label}
      <input
        className="field-input mono"
        type={password ? "password" : "text"}
        autoComplete="off"
        disabled={disabled}
        value={String(auth[key] || "")}
        placeholder={placeholder}
        onChange={(e) => onChange({ ...auth, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="api-auth-editor">
      <label className="field-label">
        鉴权类型
        <select
          className="field-input"
          disabled={disabled}
          value={auth.type}
          onChange={(e) =>
            onChange({ ...auth, type: e.target.value as ApiAuth["type"] })
          }
        >
          {(inherit
            ? ["inherit", "none", "bearer", "basic", "apikey"]
            : ["none", "bearer", "basic", "apikey"]
          ).map((type) => (
            <option key={type} value={type}>
              {authDescription({ type: type as ApiAuth["type"] })}
            </option>
          ))}
        </select>
      </label>
      {auth.type === "bearer" && input("token", "Token", "{{TOKEN}}", true)}
      {auth.type === "basic" && (
        <>
          {input("username", "用户名", "{{USERNAME}}")}
          {input("password", "密码", "{{PASSWORD}}", true)}
        </>
      )}
      {auth.type === "apikey" && (
        <>
          {input("key", "Key 名称", "X-API-Key")}
          {input("value", "Key 值", "{{API_KEY}}", true)}
          <label className="field-label">
            添加位置
            <select
              className="field-input"
              disabled={disabled}
              value={auth.location || "header"}
              onChange={(e) =>
                onChange({
                  ...auth,
                  location: e.target.value as "header" | "query",
                })
              }
            >
              <option value="header">Header</option>
              <option value="query">Query 参数</option>
            </select>
          </label>
        </>
      )}
      {auth.type === "inherit" && (
        <p className="field-help">
          使用项目的鉴权配置和公共 Headers。签名由 Pre-request 脚本生成。
        </p>
      )}
    </div>
  );
}
export function ApiHeadersEditor({
  value,
  onChange,
  disabled = false,
  kind = "Header",
}: {
  value: ApiHeader[];
  onChange: (v: ApiHeader[]) => void;
  disabled?: boolean;
  kind?: string;
}) {
  const change = (i: number, patch: Partial<ApiHeader>) =>
    onChange(value.map((v, n) => (i === n ? { ...v, ...patch } : v)));
  return (
    <div className="api-kv-editor">
      {value.map((h, i) => (
        <div className="api-kv-row" key={i}>
          <input
            aria-label={`启用 ${kind} ${i + 1}`}
            type="checkbox"
            disabled={disabled}
            checked={h.enabled !== false}
            onChange={(e) => change(i, { enabled: e.target.checked })}
          />
          <input
            className="field-input mono"
            aria-label={`${kind} 名称 ${i + 1}`}
            disabled={disabled}
            placeholder="Key"
            value={h.key}
            onChange={(e) => change(i, { key: e.target.value })}
          />
          <input
            className="field-input mono"
            aria-label={`${kind} 值 ${i + 1}`}
            disabled={disabled}
            placeholder="Value 或 {{变量}}"
            value={h.value}
            onChange={(e) => change(i, { value: e.target.value })}
          />
          <button
            className="text-button"
            disabled={disabled}
            onClick={() => onChange(value.filter((_, n) => n !== i))}
          >
            删除
          </button>
        </div>
      ))}
      <button
        className="text-button"
        disabled={disabled}
        onClick={() =>
          onChange([...value, { key: "", value: "", enabled: true }])
        }
      >
        添加 {kind}
      </button>
    </div>
  );
}
export default function ApiProjectSettings({
  project,
  scripts,
  onSave,
  onClose,
}: {
  project: ApiProject;
  scripts: ApiScriptTemplate[];
  onSave: (value: ApiProject) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(project)),
    [tab, setTab] = useState("auth"),
    [variables, setVariables] = useState(
      JSON.stringify(project.variables, null, 2),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [changed, setChanged] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const configFile = useRef<HTMLInputElement>(null);
  const update = (patch: Partial<ApiProject>) => {
    setDraft((v) => ({ ...v, ...patch }));
    setChanged(true);
  };
  const close = () => {
    if (!changed || window.confirm("项目配置尚未保存，放弃修改？")) onClose();
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (!draft.name.trim()) throw Error("请填写项目名称");
      const next = {
        ...draft,
        name: draft.name.trim(),
        variables: parseApiVariables(variables),
      };
      if (await onSave(next)) onClose();
      else setError("项目未保存，请查看接口工作台提示；编辑仍保留");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop api-debug-overlay">
      <div
        className="modal api-debug-import-modal"
        role="dialog"
        aria-label="项目配置"
      >
        <div className="modal-header">
          <h2>项目配置 · {project.name}</h2>
          <button className="text-button" disabled={busy} onClick={close}>
            关闭
          </button>
        </div>
        <label className="field-label">
          项目名称
          <input
            className="field-input"
            disabled={busy}
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        <div className="api-debug-actions">
          <button
            className="button button-ghost"
            disabled={busy}
            onClick={() => configFile.current?.click()}
          >
            导入鉴权 / Headers 配置 JSON
          </button>
          <small>
            支持 headers 对象或数组，以及
            auth、variables、pre_script、test_script。
          </small>
        </div>
        <input
          type="file"
          ref={configFile}
          hidden
          accept=".json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              void f
                .text()
                .then((text) => {
                  const next = importApiProjectSettings(text, {
                    ...draft,
                    variables: parseApiVariables(variables),
                  });
                  update(next);
                  setVariables(JSON.stringify(next.variables, null, 2));
                  setError("");
                })
                .catch((e) => setError(String(e)));
            e.target.value = "";
          }}
        />
        <nav className="api-debug-tabs">
          {[
            ["auth", "Authorization"],
            ["headers", "公共 Headers"],
            ["variables", "项目变量"],
            ["pre_script", "Pre-request"],
            ["test_script", "Tests"],
          ].map(([id, label]) => (
            <button
              key={id}
              disabled={busy}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <p className="field-help">
          此项目的请求默认继承这些配置；环境变量覆盖同名项目变量。鉴权参数只保存在本机。
        </p>
        {tab === "auth" && (
          <ApiAuthEditor
            value={draft.auth}
            disabled={busy}
            onChange={(v) => update({ auth: v })}
          />
        )}
        {tab === "headers" && (
          <ApiHeadersEditor
            value={draft.headers}
            disabled={busy}
            onChange={(v) => update({ headers: v })}
          />
        )}
        {tab === "variables" && (
          <label className="field-label">
            变量 JSON（如 BASE_URL、APP_KEY、APP_SECRET、TOKEN）
            <textarea
              className="field-input api-debug-code"
              disabled={busy}
              value={variables}
              onChange={(e) => {
                setVariables(e.target.value);
                setChanged(true);
              }}
            />
          </label>
        )}
        {(tab === "pre_script" || tab === "test_script") && (
          <>
            <div className="api-debug-actions">
              <button
                className="button button-ghost"
                disabled={busy}
                onClick={() => file.current?.click()}
              >
                导入 .js / .txt
              </button>
              {tab === "pre_script" && (
                <select
                  className="field-input"
                  disabled={busy}
                  value=""
                  aria-label="项目签名模板"
                  onChange={(e) => {
                    const s = scripts.find((s) => s.id === e.target.value);
                    if (s)
                      update({
                        pre_script: s.content,
                        signature_mode: s.signature_mode || "script",
                      });
                  }}
                >
                  <option value="">从当前项目脚本库载入</option>
                  {scripts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <input
              type="file"
              accept=".js,.txt"
              hidden
              ref={file}
              onChange={(e) => {
                const f = e.target.files?.[0],
                  target = tab;
                if (f)
                  void f
                    .text()
                    .then((text) => update({ [target]: text }))
                    .catch((e) => setError(String(e)));
                e.target.value = "";
              }}
            />
            <textarea
              className="field-input api-debug-code"
              aria-label={
                tab === "pre_script" ? "项目公共前置脚本" : "项目公共测试脚本"
              }
              disabled={busy}
              value={draft[tab as "pre_script" | "test_script"]}
              onChange={(e) => update({ [tab]: e.target.value })}
            />
            {tab === "pre_script" && (
              <label className="field-label">
                签名处理
                <select
                  className="field-input"
                  disabled={busy}
                  value={draft.signature_mode || "script"}
                  onChange={(e) =>
                    update({
                      signature_mode: e.target.value as "script" | "aliyun",
                    })
                  }
                >
                  <option value="script">由脚本处理签名</option>
                  <option value="aliyun">阿里云网关（按最终报文签名）</option>
                </select>
              </label>
            )}
            <small>
              执行顺序：项目 Pre-request → 请求 Pre-request → 发送 → 项目 Tests
              → 请求 Tests。可使用 CryptoJS 和同步 pm.* API。
            </small>
          </>
        )}
        {error && (
          <p role="alert" className="unlock-warning">
            {error}
          </p>
        )}
        <button
          className="button button-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存项目配置"}
        </button>
      </div>
    </div>
  );
}
