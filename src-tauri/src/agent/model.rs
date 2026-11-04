//! 会话模型消息、上下文预算、历史整理与记忆结构。全部为纯函数，便于单独验证。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sessions::AiSessionMessage;

pub const MODEL_MAX_TOKENS: u32 = 16_384;
pub const SUMMARY_MAX_TOKENS: u32 = 4000;
pub const MAX_TOOL_RESULT_CHARS: usize = 60_000;
pub const READ_CHUNK_CHARS: usize = 20_000;
pub const MAX_READ_CHUNK_CHARS: usize = 20_000;
pub const DEFAULT_CONTEXT_WINDOW_TOKENS: u64 = 1_000_000;
pub const DEFAULT_COMPACTION_TRIGGER_TOKENS: u64 = 500_000;
const MIN_WINDOW_TOKENS: u64 = 16_000;
const MIN_TRIGGER_TOKENS: u64 = 4_000;
const MIN_CHUNK_TOKENS: u64 = 4_000;
const MAX_CHUNK_TOKENS: u64 = 150_000;
const WINDOW_SAFETY_RATIO: f64 = 0.85;
const HISTORY_SHARE: f64 = 0.4;
const KEEP_SHARE: f64 = 0.2;
const CHUNK_SHARE: f64 = 0.25;
pub const KEEP_RECENT_RESULTS: usize = 6;
pub const KEEP_RECENT_IMAGES: usize = 2;
pub const SNIPPET_CHARS: usize = 600;
pub const TOOL_RESULT_SUMMARY_CHARS: usize = 6_000;
pub const ARGUMENT_RECORD_CHARS: usize = 2_000;
pub const IMAGE_TOKENS: u64 = 1_500;
const MESSAGE_OVERHEAD_TOKENS: u64 = 4;
pub const TRIM_SUFFIX: &str = "…（较早的工具结果已省略以节省上下文，需要时请重新读取）";
pub const IMAGE_OMITTED: &str = "（较早的图片已省略，需要时请重新读取）";
pub const DIGEST_CHARS: usize = 600;
pub const PROMPT_DIGEST_CHARS: usize = 160;
pub const PROMPT_READ_ENTRIES: usize = 30;
pub const MAX_READ_INDEX: usize = 60;

/// 上下文预算：窗口、压缩触发、历史带宽、保留原文的尾部与摘要分段大小（单位 token，粗估）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextPlan {
    pub window: u64,
    pub trigger: u64,
    pub history: u64,
    pub keep: u64,
    pub chunk: u64,
}

pub fn context_plan(window: Option<u64>, trigger: Option<u64>) -> ContextPlan {
    let window = window
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW_TOKENS)
        .max(MIN_WINDOW_TOKENS);
    let ceiling = ((window as f64 * WINDOW_SAFETY_RATIO).floor() as u64)
        .saturating_sub(MODEL_MAX_TOKENS as u64);
    let configured = trigger
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_COMPACTION_TRIGGER_TOKENS);
    let trigger = configured.min(ceiling).max(MIN_TRIGGER_TOKENS);
    ContextPlan {
        window,
        trigger,
        history: (trigger as f64 * HISTORY_SHARE).floor() as u64,
        keep: (trigger as f64 * KEEP_SHARE).floor() as u64,
        chunk: ((window as f64 * CHUNK_SHARE).floor() as u64)
            .clamp(MIN_CHUNK_TOKENS, MAX_CHUNK_TOKENS),
    }
}

/// 粗估 token：CJK 字符每个约 1 token，其余字符约 0.3 token。
pub fn estimate_tokens(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut other = 0u64;
    for character in text.chars() {
        if is_cjk(character) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + (other as f64 * 0.3).ceil() as u64
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32, 0x2E80..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        }
    }
}

#[derive(Debug, Clone)]
pub enum Part {
    Text(String),
    /// 图片以 data URL 形式提供
    Image(String),
}

#[derive(Debug, Clone)]
pub enum Content {
    Empty,
    Text(String),
    Parts(Vec<Part>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// 发送给模型的一条消息（运行期内存中的完整上下文，不等同于落盘的会话消息）。
#[derive(Debug, Clone)]
pub struct ModelMsg {
    pub role: Role,
    pub content: Content,
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
}

impl ModelMsg {
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self {
            role,
            content: Content::Text(text.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    pub fn wire(&self) -> Value {
        let mut value = json!({ "role": self.role.as_str() });
        value["content"] = match &self.content {
            Content::Empty => Value::Null,
            Content::Text(text) => json!(text),
            Content::Parts(parts) => Value::Array(
                parts
                    .iter()
                    .map(|part| match part {
                        Part::Text(text) => json!({ "type": "text", "text": text }),
                        Part::Image(url) => {
                            json!({ "type": "image_url", "image_url": { "url": url } })
                        }
                    })
                    .collect(),
            ),
        };
        if !self.tool_calls.is_empty() {
            value["tool_calls"] = Value::Array(
                self.tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.arguments },
                        })
                    })
                    .collect(),
            );
        }
        if let Some(id) = &self.tool_call_id {
            value["tool_call_id"] = json!(id);
        }
        value
    }

    pub fn tokens(&self) -> u64 {
        let content = match &self.content {
            Content::Empty => 0,
            Content::Text(text) => estimate_tokens(text),
            Content::Parts(parts) => parts
                .iter()
                .map(|part| match part {
                    Part::Text(text) => estimate_tokens(text),
                    Part::Image(_) => IMAGE_TOKENS,
                })
                .sum(),
        };
        let calls: u64 = self
            .tool_calls
            .iter()
            .map(|call| estimate_tokens(&format!("{}{}", call.name, call.arguments)))
            .sum();
        content + calls + MESSAGE_OVERHEAD_TOKENS
    }

    fn has_image(&self) -> bool {
        matches!(&self.content, Content::Parts(parts) if parts.iter().any(|part| matches!(part, Part::Image(_))))
    }
}

pub fn estimate_messages(messages: &[ModelMsg]) -> u64 {
    messages.iter().map(ModelMsg::tokens).sum()
}

/// 一次模型回复：正文、工具调用与服务商返回的输入 token（用于校准粗估）。
#[derive(Debug, Clone, Default)]
pub struct ModelReply {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub prompt_tokens: Option<u64>,
    /// 提供方返回的结束原因；`length` 表示回复被输出上限截断。
    pub finish_reason: Option<String>,
}

pub fn parse_reply(value: &Value) -> ModelReply {
    let tool_calls = value
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .map(|call| ToolCall {
                    id: call
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: call
                        .pointer("/function/name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    arguments: arguments_text(call.pointer("/function/arguments")),
                })
                .collect()
        })
        .unwrap_or_default();
    ModelReply {
        content: value
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        tool_calls,
        prompt_tokens: value
            .pointer("/usage/prompt_tokens")
            .and_then(Value::as_u64),
        finish_reason: value
            .get("finish_reason")
            .and_then(Value::as_str)
            .map(|reason| reason.to_string()),
    }
}

pub fn arguments_text(raw: Option<&Value>) -> String {
    match raw {
        Some(Value::String(text)) => text.clone(),
        None | Some(Value::Null) => "{}".to_string(),
        Some(other) => other.to_string(),
    }
}

pub fn parse_arguments(raw: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(if raw.trim().is_empty() { "{}" } else { raw }).ok()?;
    value.is_object().then_some(value)
}

pub fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() > limit {
        format!("{}…", text.chars().take(limit).collect::<String>())
    } else {
        text.to_string()
    }
}

pub fn digest_of(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(DIGEST_CHARS)
        .collect()
}

fn record_text(record: &Value, key: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 落盘消息的粗估 token（正文 + 工具调用名与参数）。
pub fn persisted_tokens(message: &AiSessionMessage) -> u64 {
    estimate_tokens(&message.content)
        + message
            .tool_calls
            .iter()
            .map(|call| {
                estimate_tokens(&format!(
                    "{}{}",
                    record_text(call, "name"),
                    record_text(call, "arguments")
                ))
            })
            .sum::<u64>()
}

/// 落盘消息用于摘要的一行文本。
pub fn persisted_line(message: &AiSessionMessage) -> String {
    let who = match message.role.as_str() {
        "user" => "你",
        "assistant" => "白泽",
        "tool" => "工具",
        _ => "系统",
    };
    let calls: Vec<String> = message
        .tool_calls
        .iter()
        .map(|call| {
            let failed = call.get("ok").and_then(Value::as_bool) == Some(false);
            format!(
                "{}{}",
                record_text(call, "name"),
                if failed { "（失败）" } else { "" }
            )
        })
        .collect();
    let suffix = if calls.is_empty() {
        String::new()
    } else {
        format!("（调用：{}）", calls.join("、"))
    };
    format!("[{who}] {}{suffix}", message.content)
}

fn content_text(content: &Content) -> String {
    match content {
        Content::Empty => String::new(),
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .map(|part| match part {
                Part::Text(text) => text.clone(),
                Part::Image(_) => "[图片]".to_string(),
            })
            .collect(),
    }
}

/// 运行期消息用于摘要的一行文本。
pub fn model_line(message: &ModelMsg) -> String {
    if message.role == Role::Tool {
        return format!(
            "[结果] {}",
            clip(&content_text(&message.content), TOOL_RESULT_SUMMARY_CHARS)
        );
    }
    let who = match message.role {
        Role::User => "你",
        Role::Assistant => "白泽",
        _ => "系统",
    };
    let mut line = format!("[{who}] {}", content_text(&message.content));
    let calls: Vec<String> = message
        .tool_calls
        .iter()
        .map(|call| format!("{} {}", call.name, clip(&call.arguments, 200)))
        .collect();
    if !calls.is_empty() {
        line.push_str(&format!("\n调用：{}", calls.join("；")));
    }
    line
}

pub fn chunk_lines(lines: &[String], chunk_tokens: u64) -> Vec<Vec<String>> {
    let mut chunks: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut size = 0u64;
    for line in lines {
        let tokens = estimate_tokens(line);
        if !current.is_empty() && size + tokens > chunk_tokens {
            chunks.push(std::mem::take(&mut current));
            size = 0;
        }
        current.push(line.clone());
        size += tokens;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// 落盘尾部的起点：从末尾向前累计，直到超过保留预算（至少保留最后一条）。
pub fn tail_start(messages: &[AiSessionMessage], keep: u64) -> usize {
    let mut size = 0u64;
    let mut start = messages.len();
    while start > 0 {
        let next = persisted_tokens(&messages[start - 1]);
        if start < messages.len() && size + next > keep {
            break;
        }
        size += next;
        start -= 1;
    }
    start
}

/// 历史消息：只保留用户与助手的文字。工具调用不写入历史：曾以「本轮工具调用」摘要附在助手消息后，
/// 模型会照着仿写出没有真正发起的调用和「成功」结果。
pub fn history_for_model(
    messages: &[AiSessionMessage],
    until: Option<&str>,
    budget: u64,
) -> Vec<ModelMsg> {
    let from = until
        .and_then(|id| messages.iter().position(|message| message.id == id))
        .map_or(0, |index| index + 1);
    let mut history = Vec::new();
    for message in messages.get(from..).unwrap_or(&[]) {
        let (role, content) = match message.role.as_str() {
            "user" => (Role::User, message.content.clone()),
            "assistant" => (Role::Assistant, strip_tool_summary(&message.content)),
            _ => continue,
        };
        if !content.trim().is_empty() {
            history.push(ModelMsg::text(role, content));
        }
    }
    keep_recent(history, budget)
}

/// 正文里出现了工具调用的文字描述而不是真实调用：「本轮工具调用」标注、<tool_call> 标记，
/// 或「- 工具名：结果」样式的行。模型从历史里学到这种写法后会仿写，需要识别并提示重发。
pub fn mentions_tool_call(content: &str) -> bool {
    content.lines().any(is_tool_mimicry)
}

/// 去掉正文里仿写的工具调用文字，只保留模型真正说的话。
pub fn strip_tool_summary(content: &str) -> String {
    content
        .lines()
        .filter(|line| !is_tool_mimicry(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn is_tool_mimicry(line: &str) -> bool {
    if line.contains("本轮工具调用") || line.contains("<tool_call") || line.contains("<function=")
    {
        return true;
    }
    let text = line.trim_start_matches(&['-', '*', ' '][..]);
    super::prompt::TOOL_NAMES.iter().any(|name| {
        text.strip_prefix(name)
            .map(|rest| {
                let rest = rest.trim_start();
                rest.starts_with('：') || rest.starts_with(':')
            })
            .unwrap_or(false)
    })
}

fn keep_recent(history: Vec<ModelMsg>, budget: u64) -> Vec<ModelMsg> {
    let mut kept: Vec<ModelMsg> = Vec::new();
    let mut total = 0u64;
    for message in history.into_iter().rev() {
        let size = estimate_tokens(&content_text(&message.content));
        if !kept.is_empty() && total + size > budget {
            break;
        }
        total += size;
        kept.push(message);
    }
    kept.reverse();
    kept
}

/// 压缩切点：保留尾部约 keep 个 token；切点落在用户消息或不带工具调用的助手消息上。返回 0 表示无法切分。
pub fn compaction_cut(messages: &[ModelMsg], keep: u64) -> usize {
    let mut size = 0u64;
    let mut start = messages.len();
    while start > 2 && size < keep {
        start -= 1;
        size += messages[start].tokens();
    }
    for index in start.max(2)..messages.len() {
        let message = &messages[index];
        if message.role == Role::User
            || (message.role == Role::Assistant && message.tool_calls.is_empty())
        {
            return index;
        }
    }
    0
}

/// 只保留最近的图片，较早的图片替换为说明文字（始终执行）。
pub fn trim_images(messages: &mut [ModelMsg]) {
    let indexes: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.has_image())
        .map(|(index, _)| index)
        .collect();
    let omit = indexes.len().saturating_sub(KEEP_RECENT_IMAGES);
    for &index in &indexes[..omit] {
        messages[index].content = Content::Text(IMAGE_OMITTED.to_string());
    }
}

/// 超出预算时，截短较早的工具结果；每截短一条都重新检查预算。
pub fn trim_tool_results(messages: &mut [ModelMsg], within_budget: impl Fn(&[ModelMsg]) -> bool) {
    let indexes: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role == Role::Tool)
        .map(|(index, _)| index)
        .collect();
    let limit = indexes.len().saturating_sub(KEEP_RECENT_RESULTS);
    for &index in &indexes[..limit] {
        if within_budget(messages) {
            break;
        }
        let text = match &messages[index].content {
            Content::Text(text) => text.clone(),
            _ => continue,
        };
        if text.chars().count() <= SNIPPET_CHARS || text.ends_with(TRIM_SUFFIX) {
            continue;
        }
        let head: String = text.chars().take(SNIPPET_CHARS).collect();
        messages[index].content = Content::Text(format!("{head}{TRIM_SUFFIX}"));
    }
}

/// 会话记忆：历史摘要与已读取资料的索引，保存在会话 `memory` 字段中。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Memory {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<MemorySummary>,
    #[serde(default)]
    pub read_index: Vec<ReadEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySummary {
    pub text: String,
    pub until_message_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadEntry {
    pub path: String,
    pub total_chars: usize,
    pub digest: String,
    pub read_at: String,
}

impl Memory {
    pub fn from_value(value: &Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or_default()
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub fn remember_read(&mut self, entry: ReadEntry) {
        self.read_index.retain(|item| item.path != entry.path);
        self.read_index.push(entry);
        let overflow = self.read_index.len().saturating_sub(MAX_READ_INDEX);
        self.read_index.drain(..overflow);
    }
}

pub fn read_index_text(entries: &[ReadEntry]) -> String {
    let start = entries.len().saturating_sub(PROMPT_READ_ENTRIES);
    entries[start..]
        .iter()
        .map(|entry| {
            format!(
                "- {}（{} 字）：{}",
                entry.path,
                entry.total_chars,
                entry
                    .digest
                    .chars()
                    .take(PROMPT_DIGEST_CHARS)
                    .collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(id: &str, role: &str, content: &str, tool_calls: Vec<Value>) -> AiSessionMessage {
        AiSessionMessage {
            id: id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            tool_calls,
            ..Default::default()
        }
    }

    #[test]
    fn estimate_counts_cjk_as_one_token_each() {
        assert_eq!(estimate_tokens("登录"), 2);
        assert_eq!(estimate_tokens("abcd"), 2);
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn plan_keeps_trigger_inside_the_window_budget() {
        let small = context_plan(Some(128_000), Some(500_000));
        assert_eq!(small.trigger, 108_800 - MODEL_MAX_TOKENS as u64);
        let default = context_plan(None, None);
        assert_eq!((default.window, default.trigger), (1_000_000, 500_000));
        assert_eq!((default.history, default.keep), (200_000, 100_000));
    }

    #[test]
    fn history_keeps_text_and_strips_tool_summary_lines() {
        let messages = vec![
            saved("m1", "user", "整理资料", vec![]),
            saved(
                "m2",
                "assistant",
                "我先读取资料。\n本轮工具调用：\n- read_file：成功",
                vec![
                    json!({"id": "c1", "name": "read_file", "arguments": "{}"}),
                    json!({"id": "c2", "name": "create_file", "arguments": "{}"}),
                ],
            ),
            saved(
                "m3",
                "tool",
                "",
                vec![json!({"id": "c1", "name": "read_file", "ok": true})],
            ),
            saved(
                "m4",
                "assistant",
                "",
                vec![json!({"id": "c3", "name": "list_directory", "arguments": "{}"})],
            ),
        ];
        let history = history_for_model(&messages, None, 1_000_000);
        assert_eq!(history.len(), 2);
        assert_eq!(content_text(&history[1].content), "我先读取资料。");
    }

    #[test]
    fn history_keeps_the_newest_messages_inside_the_budget() {
        let long = "字".repeat(300);
        let messages = vec![
            saved("m1", "user", &long, vec![]),
            saved("m2", "assistant", "短回复", vec![]),
        ];
        let history = history_for_model(&messages, None, 10);
        assert_eq!(history.len(), 1);
        assert_eq!(content_text(&history[0].content), "短回复");
    }

    #[test]
    fn compaction_cut_lands_on_a_user_boundary() {
        let messages = vec![
            ModelMsg::text(Role::System, "系统"),
            ModelMsg::text(Role::User, "u1"),
            ModelMsg::text(Role::Assistant, "a1"),
            ModelMsg::text(Role::User, "u2"),
            ModelMsg::text(Role::Assistant, "a2"),
            ModelMsg::text(Role::User, "u3"),
        ];
        assert_eq!(compaction_cut(&messages, 1), 5);
        assert_eq!(compaction_cut(&messages[..2], 1), 0);
    }

    #[test]
    fn trim_images_keeps_the_two_latest() {
        let image = || ModelMsg {
            role: Role::User,
            content: Content::Parts(vec![Part::Image("data:image/png;base64,AA".into())]),
            tool_calls: Vec::new(),
            tool_call_id: None,
        };
        let mut messages = vec![image(), image(), image()];
        trim_images(&mut messages);
        assert!(matches!(messages[0].content, Content::Text(ref text) if text == IMAGE_OMITTED));
        assert!(matches!(messages[1].content, Content::Parts(_)));
        assert!(matches!(messages[2].content, Content::Parts(_)));
    }

    #[test]
    fn memory_remembers_each_path_once_and_keeps_the_latest() {
        let mut memory = Memory::default();
        for index in 0..(MAX_READ_INDEX + 5) {
            memory.remember_read(ReadEntry {
                path: format!("p{}", index % 61),
                total_chars: index,
                digest: String::new(),
                read_at: String::new(),
            });
        }
        assert!(memory.read_index.len() <= MAX_READ_INDEX);
        assert_eq!(
            memory
                .read_index
                .iter()
                .filter(|item| item.path == "p0")
                .count(),
            1
        );
    }
}
