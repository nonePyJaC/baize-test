//! OpenAI 兼容大模型调用。
//!
//! API Key 由用户在客户端「设置 → 模型服务」中自行配置，仅保存在本机客户端偏好中，
//! 不写入工作区文件，也不会进入 AI 任务派发词。请求在 Rust 侧发起，
//! 不经过 webview，规避 CSP/CORS。

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    /// 纯文本时为字符串；多模态时可以是 OpenAI 兼容的 content 数组
    /// （如 `[{"type":"text",...},{"type":"image_url",...}]`）。
    pub content: serde_json::Value,
}

/// 会话工具调用使用的消息：assistant 可携带 tool_calls，tool 消息需要 tool_call_id。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolMessage {
    pub role: String,
    pub content: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("创建HTTP客户端失败：{error}"))
}

fn shorten(body: &str) -> String {
    let text = body.trim().replace(['\r', '\n'], " ");
    text.chars().take(300).collect()
}

fn resolve_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("请先填写模型服务 Base URL".to_string());
    }
    Ok(trimmed.to_string())
}

fn provider_request(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<(String, String, String), String> {
    let base = resolve_base_url(base_url)?;
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("请先填写模型服务 API Key".to_string());
    }
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("请先填写模型名称".to_string());
    }
    Ok((base, api_key, model))
}

/// 发送 chat/completions 请求，返回响应原文。
async fn post_chat_completion(
    base: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<String, String> {
    let client = http_client()?;
    let response = client
        .post(format!("{base}/chat/completions"))
        .header("Authorization", format!("Bearer {api_key}"))
        .json(body)
        .send()
        .await
        .map_err(|error| format!("连接模型服务失败：{error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("API Key 无效或没有权限，请检查模型服务配置".to_string());
    }
    if !status.is_success() {
        return Err(format!(
            "模型服务返回 HTTP {}：{}",
            status.as_u16(),
            shorten(&text)
        ));
    }
    Ok(text)
}

/// 调用 OpenAI 兼容的 chat/completions，返回首条回复文本。
#[tauri::command]
pub async fn chat_completion(
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    let (base, api_key, model) = provider_request(&base_url, &api_key, &model)?;
    let body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.3),
        "max_tokens": max_tokens.unwrap_or(4096),
        "stream": false,
    });
    let text = post_chat_completion(&base, &api_key, &body).await?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("解析模型响应失败：{error}（{}）", shorten(&text)))?;
    value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .map(|content| content.to_string())
        .ok_or_else(|| {
            format!(
                "模型响应缺少 choices[0].message.content（{}）",
                shorten(&text)
            )
        })
}

/// 带工具定义的模型调用：返回完整的 assistant 消息（content 与 tool_calls）。
#[tauri::command]
pub async fn chat_completion_with_tools(
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatToolMessage>,
    tools: Vec<serde_json::Value>,
    max_tokens: Option<u32>,
) -> Result<serde_json::Value, String> {
    let (base, api_key, model) = provider_request(&base_url, &api_key, &model)?;
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": max_tokens.unwrap_or(4096),
        "stream": false,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    let text = post_chat_completion(&base, &api_key, &body).await?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("解析模型响应失败：{error}（{}）", shorten(&text)))?;
    value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .cloned()
        .map(|message| message_with_usage(message, &value))
        .ok_or_else(|| format!("模型响应缺少 choices[0].message（{}）", shorten(&text)))
}

fn message_with_usage(
    mut message: serde_json::Value,
    response: &serde_json::Value,
) -> serde_json::Value {
    if let Some(usage) = response.get("usage").filter(|usage| usage.is_object()) {
        message["usage"] = usage.clone();
    }
    message
}

const STREAM_EVENT: &str = "ai-session-stream";
const STREAM_POLL: Duration = Duration::from_millis(200);
const STREAM_IDLE_LIMIT: Duration = Duration::from_secs(180);
pub const RUN_CANCELLED: &str = "RUN_CANCELLED";

type RunFlag = Arc<AtomicBool>;

fn run_flags() -> &'static Mutex<HashMap<String, RunFlag>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, RunFlag>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct RunRegistration(String);

impl RunRegistration {
    fn register(run_id: &str) -> Result<(Self, RunFlag), String> {
        let flag = RunFlag::default();
        run_flags()
            .lock()
            .map_err(|_| "运行状态不可用".to_string())?
            .insert(run_id.to_string(), flag.clone());
        Ok((Self(run_id.to_string()), flag))
    }
}

impl Drop for RunRegistration {
    fn drop(&mut self) {
        if let Ok(mut flags) = run_flags().lock() {
            flags.remove(&self.0);
        }
    }
}

#[tauri::command]
pub fn cancel_ai_session_run(run_id: String) -> bool {
    let Ok(flags) = run_flags().lock() else {
        return false;
    };
    let prefix = format!("{run_id}::");
    let mut matched = false;
    for (key, flag) in flags.iter() {
        if key == &run_id || key.starts_with(&prefix) {
            flag.store(true, Ordering::SeqCst);
            matched = true;
        }
    }
    matched
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStreamEvent {
    run_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<usize>,
    chars: usize,
}

pub(crate) const REPETITION_FINISH: &str = "repetition";
const REPEAT_CHECK_BYTES: usize = 256;
const REPEAT_MIN_CHARS: usize = 80;
const REPEAT_MAX_PERIOD: usize = 200;

/// 回复末尾是否连续重复同一段文字（模型退化循环）。返回重复段开始的字节位置。
fn repetition_start(text: &str) -> Option<usize> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    for period in 1..=REPEAT_MAX_PERIOD.min(n / 2) {
        let mut start = n - period;
        while start > 0 && chars[start - 1].1 == chars[start - 1 + period].1 {
            start -= 1;
        }
        if n - start < REPEAT_MIN_CHARS.max(3 * period) {
            continue;
        }
        if chars[n - period..]
            .iter()
            .filter(|item| item.1.is_alphanumeric())
            .count()
            < 2
        {
            continue;
        }
        return Some(chars[start].0);
    }
    None
}

#[derive(Default)]
struct PartialToolCall {
    id: Option<String>,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct StreamAccumulator {
    content: String,
    calls: BTreeMap<usize, PartialToolCall>,
    finish_reason: Option<String>,
    usage: Option<serde_json::Value>,
    checked: usize,
    repeat_cut: Option<usize>,
}

pub(crate) enum StreamUpdate {
    Text(String),
    Reasoning(usize),
    Tool {
        index: usize,
        name: String,
        chars: usize,
    },
}

impl StreamAccumulator {
    fn push_data(&mut self, data: &str) -> Result<Vec<StreamUpdate>, String> {
        let value: serde_json::Value = serde_json::from_str(data)
            .map_err(|error| format!("解析模型流式响应失败：{error}（{}）", shorten(data)))?;
        if let Some(message) = value.pointer("/error/message").and_then(|m| m.as_str()) {
            return Err(format!("模型服务返回错误：{message}"));
        }
        if let Some(usage) = value.get("usage").filter(|usage| usage.is_object()) {
            self.usage = Some(usage.clone());
        }
        let mut updates = Vec::new();
        let Some(choice) = value.get("choices").and_then(|choices| choices.get(0)) else {
            return Ok(updates);
        };
        if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(updates);
        };
        if let Some(text) = delta
            .get("content")
            .and_then(|c| c.as_str())
            .filter(|text| !text.is_empty())
        {
            self.content.push_str(text);
            self.watch_repetition();
            updates.push(StreamUpdate::Text(text.to_string()));
        }
        if let Some(text) = delta
            .get("reasoning_content")
            .and_then(|c| c.as_str())
            .filter(|text| !text.is_empty())
        {
            updates.push(StreamUpdate::Reasoning(text.chars().count()));
        }
        let items = delta
            .get("tool_calls")
            .and_then(|calls| calls.as_array())
            .into_iter()
            .flatten();
        for (position, item) in items.enumerate() {
            let index = item
                .get("index")
                .and_then(|i| i.as_u64())
                .map_or(position, |i| i as usize);
            let call = self.calls.entry(index).or_default();
            if let Some(id) = item
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                call.id = Some(id.to_string());
            }
            if let Some(name) = item
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                if call.name.is_empty() {
                    call.name = name.to_string();
                }
            }
            if let Some(arguments) = item.pointer("/function/arguments").and_then(|v| v.as_str()) {
                call.arguments.push_str(arguments);
            }
            updates.push(StreamUpdate::Tool {
                index,
                name: call.name.clone(),
                chars: call.arguments.chars().count(),
            });
        }
        Ok(updates)
    }

    fn watch_repetition(&mut self) {
        if self.repeat_cut.is_none() && self.content.len() >= self.checked + REPEAT_CHECK_BYTES {
            self.checked = self.content.len();
            self.repeat_cut = repetition_start(&self.content);
        }
    }

    fn repeating(&self) -> bool {
        self.repeat_cut.is_some()
    }

    fn finish(mut self, run_id: &str) -> Result<serde_json::Value, String> {
        if let Some(cut) = self.repeat_cut.or_else(|| repetition_start(&self.content)) {
            let kept = self.content[..cut].trim_end().len();
            self.content.truncate(kept);
            self.calls.clear();
            self.finish_reason = Some(REPETITION_FINISH.to_string());
        }
        let mut tool_calls = Vec::new();
        for (index, call) in self.calls {
            if call.name.trim().is_empty() {
                return Err("模型返回的工具调用缺少名称".to_string());
            }
            let arguments = if call.arguments.trim().is_empty() {
                "{}".to_string()
            } else {
                call.arguments
            };
            tool_calls.push(json!({
                "id": call.id.unwrap_or_else(|| format!("{run_id}-{index}")),
                "type": "function",
                "function": { "name": call.name, "arguments": arguments },
            }));
        }
        let content = if self.content.is_empty() {
            serde_json::Value::Null
        } else {
            json!(self.content)
        };
        let mut message = json!({ "role": "assistant", "content": content });
        if !tool_calls.is_empty() {
            message["tool_calls"] = json!(tool_calls);
        }
        if let Some(reason) = self.finish_reason {
            message["finish_reason"] = json!(reason);
        }
        if let Some(usage) = self.usage {
            message["usage"] = usage;
        }
        Ok(message)
    }
}

fn take_line(buffer: &mut Vec<u8>) -> Option<String> {
    let position = buffer.iter().position(|byte| *byte == b'\n')?;
    let line: Vec<u8> = buffer.drain(..=position).collect();
    Some(
        String::from_utf8_lossy(&line)
            .trim_end_matches(['\r', '\n'])
            .to_string(),
    )
}

fn emit_update(app: &tauri::AppHandle, run_id: &str, update: StreamUpdate) {
    let event = match update {
        StreamUpdate::Text(delta) => AiStreamEvent {
            run_id: run_id.to_string(),
            kind: "text",
            delta: Some(delta),
            name: None,
            index: None,
            chars: 0,
        },
        StreamUpdate::Reasoning(chars) => AiStreamEvent {
            run_id: run_id.to_string(),
            kind: "reasoning",
            delta: None,
            name: None,
            index: None,
            chars,
        },
        StreamUpdate::Tool { index, name, chars } => AiStreamEvent {
            run_id: run_id.to_string(),
            kind: "tool",
            delta: None,
            name: Some(name),
            index: Some(index),
            chars,
        },
    };
    let _ = app.emit(STREAM_EVENT, event);
}

fn process_line(
    line: &str,
    accumulator: &mut StreamAccumulator,
    saw_data: &mut bool,
    on_update: &mut impl FnMut(StreamUpdate),
) -> Result<bool, String> {
    let Some(data) = line.trim().strip_prefix("data:") else {
        return Ok(false);
    };
    *saw_data = true;
    let data = data.trim();
    if data == "[DONE]" {
        return Ok(true);
    }
    if data.is_empty() {
        return Ok(false);
    }
    for update in accumulator.push_data(data)? {
        on_update(update);
    }
    Ok(false)
}

fn stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("创建HTTP客户端失败：{error}"))
}

fn message_from_plain_body(text: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| {
        format!(
            "模型服务没有返回流式数据，且响应无法解析：{error}（{}）",
            shorten(text)
        )
    })?;
    value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .cloned()
        .map(|message| message_with_usage(message, &value))
        .ok_or_else(|| format!("模型响应缺少 choices[0].message（{}）", shorten(text)))
}

#[tauri::command]
pub async fn chat_completion_stream(
    app: tauri::AppHandle,
    run_id: String,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatToolMessage>,
    tools: Vec<serde_json::Value>,
    max_tokens: Option<u32>,
) -> Result<serde_json::Value, String> {
    let (base, api_key, model) = provider_request(&base_url, &api_key, &model)?;
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": max_tokens.unwrap_or(4096),
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    stream_chat_request(&base, &api_key, &body, &run_id, |update| {
        emit_update(&app, &run_id, update)
    })
    .await
}

pub(crate) struct ModelEndpoint {
    pub base: String,
    pub api_key: String,
    pub model: String,
}

pub(crate) fn endpoint(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<ModelEndpoint, String> {
    let (base, api_key, model) = provider_request(base_url, api_key, model)?;
    Ok(ModelEndpoint {
        base,
        api_key,
        model,
    })
}

/// 会话运行使用的流式调用：与 `chat_completion_stream` 共用解析与取消机制，增量通过回调交给后端运行时。
pub(crate) async fn stream_model(
    run_id: &str,
    endpoint: &ModelEndpoint,
    messages: Vec<serde_json::Value>,
    tools: &[serde_json::Value],
    max_tokens: u32,
    on_update: impl FnMut(StreamUpdate),
) -> Result<serde_json::Value, String> {
    let mut body = json!({
        "model": endpoint.model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    stream_chat_request(&endpoint.base, &endpoint.api_key, &body, run_id, on_update).await
}

async fn open_stream(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    body: &serde_json::Value,
    include_usage: bool,
) -> Result<reqwest::Response, String> {
    let mut payload = body.clone();
    if include_usage {
        payload["stream_options"] = json!({ "include_usage": true });
    }
    let response = client
        .post(format!("{base}/chat/completions"))
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("连接模型服务失败：{error}"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("API Key 无效或没有权限，请检查模型服务配置".to_string());
    }
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "模型服务返回 HTTP {}：{}",
            status.as_u16(),
            shorten(&text)
        ));
    }
    Ok(response)
}

async fn stream_chat_request(
    base: &str,
    api_key: &str,
    body: &serde_json::Value,
    run_id: &str,
    mut on_update: impl FnMut(StreamUpdate),
) -> Result<serde_json::Value, String> {
    let (_registration, cancelled) = RunRegistration::register(run_id)?;
    let client = stream_client()?;
    let mut response = match open_stream(&client, base, api_key, body, true).await {
        Err(error) if error.contains("stream_options") || error.contains("include_usage") => {
            open_stream(&client, base, api_key, body, false).await?
        }
        other => other?,
    };
    let mut accumulator = StreamAccumulator::default();
    let mut buffer: Vec<u8> = Vec::new();
    let mut raw: Vec<u8> = Vec::new();
    let mut saw_data = false;
    let mut last_activity = Instant::now();
    'read: loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(RUN_CANCELLED.to_string());
        }
        match tokio::time::timeout(STREAM_POLL, response.chunk()).await {
            Err(_) => {
                if last_activity.elapsed() > STREAM_IDLE_LIMIT {
                    return Err(format!(
                        "模型超过 {} 秒没有返回内容，已中止，请重试",
                        STREAM_IDLE_LIMIT.as_secs()
                    ));
                }
            }
            Ok(Err(error)) => return Err(format!("读取模型回复失败：{error}")),
            Ok(Ok(None)) => break 'read,
            Ok(Ok(Some(chunk))) => {
                last_activity = Instant::now();
                raw.extend_from_slice(&chunk);
                buffer.extend_from_slice(&chunk);
                while let Some(line) = take_line(&mut buffer) {
                    if process_line(&line, &mut accumulator, &mut saw_data, &mut on_update)?
                        || accumulator.repeating()
                    {
                        break 'read;
                    }
                }
            }
        }
    }
    if !buffer.is_empty() && !accumulator.repeating() {
        let line = String::from_utf8_lossy(&buffer).to_string();
        process_line(&line, &mut accumulator, &mut saw_data, &mut on_update)?;
    }
    if !saw_data {
        return message_from_plain_body(&String::from_utf8_lossy(&raw));
    }
    accumulator.finish(run_id)
}

/// 校验模型服务配置是否可用。
#[tauri::command]
pub async fn verify_model_provider(
    base_url: String,
    api_key: String,
    model: String,
) -> Result<String, String> {
    let reply = chat_completion(
        base_url,
        api_key,
        model.clone(),
        vec![ChatMessage {
            role: "user".to_string(),
            content: json!("回复 OK 两个字母即可"),
        }],
        Some(0.0),
        Some(8),
    )
    .await?;
    Ok(format!("{model}：{}", reply.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_accumulates_text_and_split_tool_arguments() {
        let mut accumulator = StreamAccumulator::default();
        accumulator
            .push_data(r#"{"choices":[{"delta":{"content":"你"}}]}"#)
            .unwrap();
        accumulator
            .push_data(r#"{"choices":[{"delta":{"content":"好"}}]}"#)
            .unwrap();
        accumulator.push_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}"#).unwrap();
        accumulator.push_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a.md\"}"}}]}}]}"#).unwrap();
        accumulator
            .push_data(r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#)
            .unwrap();
        let message = accumulator.finish("run-1").unwrap();
        assert_eq!(message["content"], "你好");
        assert_eq!(message["tool_calls"][0]["id"], "c1");
        assert_eq!(message["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(
            message["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"a.md"}"#
        );
        assert_eq!(message["finish_reason"], "tool_calls");
    }

    #[test]
    fn stream_reports_reasoning_and_plain_text_reply() {
        let mut accumulator = StreamAccumulator::default();
        let updates = accumulator
            .push_data(r#"{"choices":[{"delta":{"reasoning_content":"想一想"}}]}"#)
            .unwrap();
        assert!(matches!(updates.as_slice(), [StreamUpdate::Reasoning(3)]));
        accumulator
            .push_data(r#"{"choices":[{"delta":{"content":"完成"}}]}"#)
            .unwrap();
        let message = accumulator.finish("run-2").unwrap();
        assert_eq!(message["content"], "完成");
        assert!(message.get("tool_calls").is_none());
    }

    #[test]
    fn stream_errors_are_reported_to_the_caller() {
        let mut accumulator = StreamAccumulator::default();
        let Err(error) = accumulator.push_data(r#"{"error":{"message":"额度不足"}}"#) else {
            panic!("错误响应应当返回错误");
        };
        assert!(error.contains("额度不足"));
    }

    #[test]
    fn sse_lines_survive_split_utf8_chunks() {
        let mut buffer = Vec::new();
        let bytes = "data: {\"a\":\"测试\"}\n\n".as_bytes();
        buffer.extend_from_slice(&bytes[..9]);
        assert!(take_line(&mut buffer).is_none());
        buffer.extend_from_slice(&bytes[9..]);
        assert_eq!(take_line(&mut buffer).unwrap(), "data: {\"a\":\"测试\"}");
        assert_eq!(take_line(&mut buffer).unwrap(), "");
    }

    #[test]
    fn plain_json_body_is_accepted_when_provider_ignores_streaming() {
        let message = message_from_plain_body(
            r#"{"choices":[{"message":{"role":"assistant","content":"ok"}}]}"#,
        )
        .unwrap();
        assert_eq!(message["content"], "ok");
    }

    #[test]
    fn cancel_flag_is_visible_until_the_run_ends() {
        let (registration, flag) = RunRegistration::register("test-run-cancel").unwrap();
        assert!(cancel_ai_session_run("test-run-cancel".to_string()));
        assert!(flag.load(Ordering::SeqCst));
        drop(registration);
        assert!(!cancel_ai_session_run("test-run-cancel".to_string()));
    }

    fn serve_sse(events: Vec<(String, u64)>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    return;
                }
                head.push(byte[0]);
            }
            let text = String::from_utf8_lossy(&head).to_lowercase();
            let length = text
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let mut request_body = vec![0u8; length];
            let _ = stream.read_exact(&mut request_body);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            );
            for (event, pause) in events {
                if stream.write_all(event.as_bytes()).is_err() {
                    return;
                }
                let _ = stream.flush();
                std::thread::sleep(Duration::from_millis(pause));
            }
        });
        format!("http://{address}/v1")
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        use std::io::Read;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                return String::new();
            }
            head.push(byte[0]);
        }
        let text = String::from_utf8_lossy(&head).to_lowercase();
        let length = text
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        let _ = stream.read_exact(&mut body);
        String::from_utf8_lossy(&body).to_string()
    }

    fn serve_sse_rejecting_stream_options(events: Vec<(String, u64)>) -> String {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let request = read_http_request(&mut stream);
                if request.contains("stream_options") {
                    let body = r#"{"error":{"message":"Unsupported parameter: stream_options"}}"#;
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    );
                    continue;
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                );
                for (event, pause) in &events {
                    if stream.write_all(event.as_bytes()).is_err() {
                        return;
                    }
                    let _ = stream.flush();
                    std::thread::sleep(Duration::from_millis(*pause));
                }
                return;
            }
        });
        format!("http://{address}/v1")
    }

    #[test]
    fn repeated_reply_text_is_cut_and_marked_as_repetition() {
        let mut accumulator = StreamAccumulator::default();
        let delta =
            |text: &str| json!({ "choices": [{ "delta": { "content": text } }] }).to_string();
        accumulator.push_data(&delta("我先读取资料。\n")).unwrap();
        for _ in 0..300 {
            accumulator
                .push_data(&delta("- list_directory：成功\n"))
                .unwrap();
        }
        let message = accumulator.finish("test-repeat").unwrap();
        assert_eq!(message["finish_reason"], json!("repetition"));
        assert_eq!(message["content"], json!("我先读取资料。"));
    }

    #[test]
    fn ordinary_tables_and_separators_are_not_cut() {
        let table: String = (0..60)
            .map(|index| format!("| 用例{index} | 门店端 | 待确认 | 是 |\n"))
            .collect();
        assert_eq!(repetition_start(&table), None);
        let separators = format!("需求说明\n{}\n后续章节", "-".repeat(120));
        assert_eq!(repetition_start(&separators), None);
    }

    fn stream_body() -> serde_json::Value {
        json!({ "model": "test-model", "messages": [], "stream": true })
    }

    #[test]
    fn streamed_reply_is_assembled_from_sse_events() {
        let base = serve_sse(vec![
            (r#"data: {"choices":[{"delta":{"content":"你"}}]}"#.to_string() + "\n\n", 0),
            (r#"data: {"choices":[{"delta":{"content":"好"}}]}"#.to_string() + "\n\n", 0),
            (r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}"#.to_string() + "\n\n", 0),
            (r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.md\"}"}}]}}]}"#.to_string() + "\n\n", 0),
            (r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#.to_string() + "\n\n", 0),
            ("data: [DONE]\n\n".to_string(), 0),
        ]);
        let mut updates = Vec::new();
        let message = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(stream_chat_request(
                &base,
                "key",
                &stream_body(),
                "test-stream-1",
                |update| updates.push(update),
            ))
            .unwrap();
        assert_eq!(message["content"], "你好");
        assert_eq!(message["tool_calls"][0]["id"], "c1");
        assert_eq!(message["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(
            message["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"a.md"}"#
        );
        assert!(updates
            .iter()
            .any(|update| matches!(update, StreamUpdate::Text(text) if text == "你")));
        assert!(updates.iter().any(
            |update| matches!(update, StreamUpdate::Tool { name, .. } if name == "read_file")
        ));
    }

    #[test]
    fn streamed_reply_survives_slow_chunks() {
        let base = serve_sse(vec![
            (
                r#"data: {"choices":[{"delta":{"content":"甲"}}]}"#.to_string() + "\n\n",
                450,
            ),
            (
                r#"data: {"choices":[{"delta":{"content":"乙"}}]}"#.to_string() + "\n\n",
                450,
            ),
            (
                r#"data: {"choices":[{"delta":{"content":"丙"}}]}"#.to_string() + "\n\n",
                450,
            ),
            ("data: [DONE]\n\n".to_string(), 0),
        ]);
        let message = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(stream_chat_request(
                &base,
                "key",
                &stream_body(),
                "test-stream-slow",
                |_| {},
            ))
            .unwrap();
        assert_eq!(message["content"], "甲乙丙");
    }

    #[test]
    fn cancelling_a_run_stops_the_stream_before_the_next_event() {
        let base = serve_sse(vec![
            (
                r#"data: {"choices":[{"delta":{"content":"开始"}}]}"#.to_string() + "\n\n",
                3000,
            ),
            (
                r#"data: {"choices":[{"delta":{"content":"结束"}}]}"#.to_string() + "\n\n",
                0,
            ),
        ]);
        let started = std::time::Instant::now();
        let mut texts = 0;
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(stream_chat_request(
                &base,
                "key",
                &stream_body(),
                "test-stream-cancel",
                |update| {
                    if matches!(update, StreamUpdate::Text(_)) {
                        texts += 1;
                        cancel_ai_session_run("test-stream-cancel".to_string());
                    }
                },
            ));
        assert_eq!(result.unwrap_err(), RUN_CANCELLED);
        assert_eq!(texts, 1);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn stream_retries_without_stream_options_when_the_provider_rejects_them() {
        let base = serve_sse_rejecting_stream_options(vec![
            (
                r#"data: {"choices":[{"delta":{"content":"好"}}]}"#.to_string() + "\n\n",
                0,
            ),
            ("data: [DONE]\n\n".to_string(), 0),
        ]);
        let message = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(stream_chat_request(
                &base,
                "key",
                &stream_body(),
                "test-stream-fallback",
                |_| {},
            ))
            .unwrap();
        assert_eq!(message["content"], "好");
    }

    #[test]
    fn stream_usage_is_kept_on_the_assembled_message() {
        let mut accumulator = StreamAccumulator::default();
        accumulator
            .push_data(r#"{"choices":[{"delta":{"content":"完成"}}]}"#)
            .unwrap();
        accumulator
            .push_data(r#"{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":30,"total_tokens":1230}}"#)
            .unwrap();
        let message = accumulator.finish("run-usage").unwrap();
        assert_eq!(message["usage"]["prompt_tokens"], 1200);
        assert_eq!(message["usage"]["completion_tokens"], 30);
    }

    #[test]
    fn plain_completion_keeps_usage() {
        let response = json!({
            "choices": [{ "message": { "role": "assistant", "content": "ok" } }],
            "usage": { "prompt_tokens": 7, "completion_tokens": 2 }
        });
        let message = message_with_usage(response["choices"][0]["message"].clone(), &response);
        assert_eq!(message["usage"]["prompt_tokens"], 7);
        assert_eq!(message["content"], "ok");
    }

    #[test]
    fn cancelling_a_parent_run_also_cancels_its_child_requests() {
        let (parent, parent_flag) = RunRegistration::register("test-parent-run").unwrap();
        let (child, child_flag) = RunRegistration::register("test-parent-run::summary-0").unwrap();
        assert!(cancel_ai_session_run("test-parent-run".to_string()));
        assert!(parent_flag.load(Ordering::SeqCst));
        assert!(child_flag.load(Ordering::SeqCst));
        drop(parent);
        drop(child);
    }

    #[test]
    fn tool_fields_are_only_sent_when_present() {
        let plain = serde_json::to_value(ChatToolMessage {
            role: "user".to_string(),
            content: json!("你好"),
            tool_calls: None,
            tool_call_id: None,
        })
        .unwrap();
        assert!(plain.get("tool_calls").is_none());
        assert!(plain.get("tool_call_id").is_none());

        let result = serde_json::to_value(ChatToolMessage {
            role: "tool".to_string(),
            content: json!("{\"ok\":true}"),
            tool_calls: None,
            tool_call_id: Some("call_1".to_string()),
        })
        .unwrap();
        assert_eq!(result["tool_call_id"], "call_1");
    }
}
