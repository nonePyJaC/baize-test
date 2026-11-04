import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  apiAiPrompt,
  parseApiAiDraft,
  type ApiAiDraft,
} from "../lib/apiWorkbench";
import type { ApiProject, ApiRequest } from "../lib/apiDebug";

export default function ApiAiGenerator({
  project,
  request,
  caseText,
  onApply,
  onClose,
}: {
  project: ApiProject;
  request?: ApiRequest;
  caseText: string;
  onApply: (draft: ApiAiDraft) => Promise<boolean>;
  onClose: () => void;
}) {
  const [cases, setCases] = useState(caseText),
    [instructions, setInstructions] = useState(""),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<ApiAiDraft | null>(null),
    [reference, setReference] = useState(false);
  const run = useRef(""),
    stopped = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopped.current = true;
      if (run.current) void api.cancelAiSessionRun(run.current);
    };
  }, []);
  const prompt = () =>
    apiAiPrompt(project, reference ? request : undefined, cases, instructions);
  const generate = async () => {
    setBusy(true);
    setError("");
    setPreview(null);
    stopped.current = false;
    try {
      const { model_provider: p } = await api.loadClientPreferences();
      if (stopped.current) return;
      if (!p.enabled || !p.base_url || !p.model || !p.api_key)
        throw Error(
          "请先在“设置 → 模型服务”配置并启用内置 AI；也可以复制提示词，粘贴其他 Agent 返回的 JSON 草稿",
        );
      run.current = `api-script-${crypto.randomUUID()}`;
      const result = await api.chatCompletionStream(
        run.current,
        p.base_url,
        p.api_key,
        p.model,
        [
          {
            role: "system",
            content:
              "你是接口测试工程师。严格根据给出的资料生成可执行的请求和测试脚本，只输出指定 JSON。未确认的业务事实写 notes。",
          },
          { role: "user", content: prompt() },
        ],
        [],
        8192,
      );
      if (stopped.current || !mounted.current) return;
      if (typeof result.content !== "string")
        throw Error("模型未返回文本草稿，请重新生成");
      setText(result.content);
      setPreview(parseApiAiDraft(result.content, project.id));
    } catch (e) {
      if (mounted.current)
        setError(stopped.current ? "已停止生成，现有草稿已保留" : String(e));
    } finally {
      run.current = "";
      if (mounted.current) setBusy(false);
    }
  };
  const stop = () => {
    stopped.current = true;
    if (run.current) void api.cancelAiSessionRun(run.current);
  };
  const close = () => {
    if (
      (text || busy) &&
      !window.confirm(
        busy ? "停止 AI 生成并关闭？" : "关闭并放弃未加入接口库的 AI 草稿？",
      )
    )
      return;
    stop();
    onClose();
  };
  const review = () => {
    setError("");
    try {
      setPreview(parseApiAiDraft(text, project.id));
    } catch (e) {
      setPreview(null);
      setError(String(e));
    }
  };
  const apply = async () => {
    setSaving(true);
    setError("");
    try {
      const draft = parseApiAiDraft(text, project.id);
      if (await onApply(draft)) onClose();
      else setError("草稿未保存，当前内容已保留");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop api-debug-overlay">
      <div
        className="modal api-debug-import-modal api-ai-modal"
        role="dialog"
        aria-label="AI 生成接口脚本"
      >
        <div className="modal-header">
          <h2>AI 生成接口脚本 · {project.name}</h2>
          <button className="text-button" disabled={saving} onClick={close}>
            关闭
          </button>
        </div>
        <p className="field-help">
          从当前测试用例或粘贴的用例生成请求、Pre-request 和
          Tests。项目鉴权配置自动继承，实际发送由你操作。
        </p>
        <label className="field-label">
          接口测试用例（前置条件、步骤、期望结果）
          <textarea
            className="field-input api-debug-code"
            disabled={busy || saving}
            value={cases}
            onChange={(e) => setCases(e.target.value)}
            placeholder="粘贴用例和接口文档；从测试执行打开时会自动带入当前用例"
          />
        </label>
        <label className="field-label">
          接口约定与补充资料
          <textarea
            className="field-input"
            rows={3}
            disabled={busy || saving}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="如接口路径、请求字段、业务成功码、签名规则；缺少的信息会列为待配置项"
          />
        </label>
        {request && (
          <label className="settings-check">
            <input
              type="checkbox"
              checked={reference}
              disabled={busy || saving}
              onChange={(e) => setReference(e.target.checked)}
            />
            参考当前接口的 URL、Headers 和 Body（请先确认正文可发送给模型）
          </label>
        )}
        <div className="api-debug-actions">
          <button
            className="button button-primary"
            disabled={busy || saving || !cases.trim()}
            onClick={() => void generate()}
          >
            AI 生成草稿
          </button>
          {busy && (
            <button className="button button-danger" onClick={stop}>
              停止生成
            </button>
          )}
          <button
            className="button button-ghost"
            disabled={busy || saving || !cases.trim()}
            onClick={() =>
              void navigator.clipboard
                .writeText(prompt())
                .catch((e) => setError(String(e)))
            }
          >
            复制提示词给其他 Agent
          </button>
        </div>
        <label className="field-label">
          草稿 JSON（可编辑，也可粘贴其他 Agent 返回的结果）
          <textarea
            className="field-input api-debug-code"
            disabled={busy || saving}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            placeholder='{"notes":[],"requests":[…]}'
          />
        </label>
        <button
          className="button button-ghost"
          disabled={busy || saving || !text.trim()}
          onClick={review}
        >
          校验并预览草稿
        </button>
        {preview && (
          <div className="api-ai-preview">
            <strong>待加入 {preview.requests.length} 个请求</strong>
            {preview.notes.map((note, i) => (
              <p className="unlock-warning" key={i}>
                {note}
              </p>
            ))}
            {preview.requests.map((r) => (
              <details key={r.id}>
                <summary>
                  {r.method} · {r.name}
                </summary>
                <p className="mono">{r.url}</p>
                <pre className="api-debug-output">{r.body}</pre>
                <strong>Pre-request</strong>
                <pre className="api-debug-output">
                  {r.pre_script || "继承项目脚本"}
                </pre>
                <strong>Tests / 断言</strong>
                <pre className="api-debug-output">
                  {r.test_script}
                  {r.assertions.length
                    ? "\n" + JSON.stringify(r.assertions, null, 2)
                    : ""}
                </pre>
              </details>
            ))}
            <button
              className="button button-primary"
              disabled={busy || saving}
              onClick={() => void apply()}
            >
              确认加入当前项目
            </button>
            <small>
              加入后可编辑、绑定用例并发送；现有接口和用例内容均保留。
            </small>
          </div>
        )}
        {busy && <p role="status">AI 正在生成脚本…</p>}
        {error && (
          <p role="alert" className="unlock-warning">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
