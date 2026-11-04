//! 单次运行：组装上下文、调用模型、执行工具、回填结果，并维护会话消息与记忆。

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Value};

use super::model::{
    self, Content, ContextPlan, Memory, MemorySummary, ModelMsg, ModelReply, Part, ReadEntry, Role,
    ToolCall,
};
use super::prompt;
use super::tools::{self, ToolOutcome};
use super::{ActiveRun, Event, Job, JobSpec, Resume, Runtime};
use crate::llm::{self, StreamUpdate, RUN_CANCELLED};
use crate::sessions::{self, AiApproval, AiSession, AiSessionMessage};
use crate::workspace::{chrono_now, load_initialized_workspace};

const MAX_OVERFLOW_RETRIES: usize = 2;
const REPEAT_LIMIT: usize = 3;
const FAKE_TOOL_LIMIT: usize = 3;
const CONTINUE_LIMIT: usize = 4;
const CALIBRATION_MIN: f64 = 0.4;
const CALIBRATION_MAX: f64 = 3.0;

pub(crate) enum Status {
    Completed,
    Stopped,
}

/// 一次运行的上下文：运行句柄、任务参数、工作区根目录与记忆。
pub(crate) struct RunCtx {
    pub rt: Arc<Runtime>,
    pub run: Arc<ActiveRun>,
    pub spec: JobSpec,
    pub root: PathBuf,
    pub memory: Memory,
    pub summary_calls: usize,
}

impl RunCtx {
    pub fn new(rt: Arc<Runtime>, run: Arc<ActiveRun>, spec: JobSpec) -> Result<Self, String> {
        let (root, _config) = load_initialized_workspace(&spec.root_path)?;
        Ok(Self {
            rt,
            run,
            spec,
            root,
            memory: Memory::default(),
            summary_calls: 0,
        })
    }

    pub fn root_path(&self) -> String {
        self.spec.root_path.clone()
    }

    pub fn session_id(&self) -> &str {
        &self.spec.session_id
    }

    pub fn cancelled(&self) -> bool {
        self.run.cancel.load(Ordering::SeqCst)
    }

    pub fn plan(&self) -> ContextPlan {
        model::context_plan(
            self.spec.provider.context_window_tokens,
            self.spec.provider.compaction_trigger_tokens,
        )
    }

    pub fn emit(&self, event: Event) {
        self.rt.publish(&self.run, &self.spec.session_id, event);
    }

    /// 客户端工具：请求界面执行（文档解析、XMind 生成），等待结果或取消。
    pub async fn client(&self, kind: &str, payload: Value) -> Result<Value, String> {
        self.rt
            .client
            .request(
                self.rt.sink.as_ref(),
                &self.spec.session_id,
                &self.run.run_id,
                kind,
                payload,
                &self.run.cancel,
            )
            .await
    }

    pub fn remember_read(&mut self, path: &str, total_chars: usize, digest: &str) {
        self.memory.remember_read(ReadEntry {
            path: path.to_string(),
            total_chars,
            digest: digest.to_string(),
            read_at: chrono_now(),
        });
        let _ = sessions::update_ai_session_memory(
            self.root_path(),
            self.spec.session_id.clone(),
            self.memory.to_value(),
        );
    }

    fn on_stream(&self, update: StreamUpdate) {
        match update {
            StreamUpdate::Text(delta) => self.emit(Event::Text { delta }),
            StreamUpdate::Reasoning(chars) => self.emit(Event::Reasoning { chars }),
            StreamUpdate::Tool { name, chars, .. } => self.emit(Event::ToolArgs { name, chars }),
        }
    }

    /// 追加一条会话消息并推送给界面。
    pub fn persist(
        &self,
        role: Role,
        content: String,
        tool_calls: Vec<Value>,
    ) -> Result<AiSessionMessage, String> {
        self.persist_full(role, content, tool_calls, Vec::new())
    }

    /// 追加一条带图片附件的会话消息（images 为会话 attachments 目录下的文件名）。
    pub fn persist_with_images(
        &self,
        role: Role,
        content: String,
        images: Vec<String>,
    ) -> Result<AiSessionMessage, String> {
        self.persist_full(role, content, Vec::new(), images)
    }

    fn persist_full(
        &self,
        role: Role,
        content: String,
        tool_calls: Vec<Value>,
        images: Vec<String>,
    ) -> Result<AiSessionMessage, String> {
        let message = AiSessionMessage {
            role: role.as_str().to_string(),
            content,
            tool_calls,
            images,
            ..Default::default()
        };
        let session = sessions::append_ai_session_message(
            self.root_path(),
            self.spec.session_id.clone(),
            message,
        )?;
        let saved = session
            .messages
            .last()
            .cloned()
            .ok_or_else(|| "消息写入失败".to_string())?;
        self.emit(Event::Message {
            message: saved.clone(),
        });
        Ok(saved)
    }
}

fn is_cancel(error: &str) -> bool {
    error.contains(RUN_CANCELLED)
}

/// 模型服务报告上下文超长（各家措辞不同，这里覆盖常见说法）。
fn is_overflow(error: &str) -> bool {
    const ENGLISH: &[&str] = &[
        "context length",
        "context_length",
        "context-length",
        "context window",
        "context_window",
        "maximum context",
        "too many tokens",
        "prompt is too long",
        "input is too long",
    ];
    let lower = error.to_lowercase();
    if ENGLISH.iter().any(|needle| lower.contains(needle)) {
        return true;
    }
    const CHINESE: &str = "上下文";
    const WORDS: &[&str] = &["超", "过长", "超出", "超过", "长度"];
    error.match_indices(CHINESE).any(|(index, _)| {
        let tail: String = error[index + CHINESE.len()..].chars().take(8).collect();
        WORDS.iter().any(|word| tail.contains(word))
    })
}

/// 执行一个任务（用户消息或续跑）。返回 Err 表示模型或存储失败，运行以 failed 结束。
pub(crate) async fn execute_job(ctx: &mut RunCtx) -> Result<Status, String> {
    let provider = ctx.spec.provider.clone();
    if !provider.enabled
        || provider.base_url.trim().is_empty()
        || provider.api_key.trim().is_empty()
        || provider.model.trim().is_empty()
    {
        return Err("请先在「设置 → 模型服务」中启用并配置模型".to_string());
    }
    let job = ctx.spec.job.clone();
    ctx.emit(Event::RunStarted {
        reason: job.reason().to_string(),
    });
    if job == Job::Resume(Resume::Approval) {
        tools::process_approved(ctx).await?;
        let session = sessions::load_session(&ctx.root, ctx.session_id())?;
        if session
            .approvals
            .iter()
            .any(|item| item.status == "pending")
        {
            return Ok(Status::Completed);
        }
    }
    let session = sessions::load_session(&ctx.root, ctx.session_id())?;
    let plan = ctx.plan();
    ctx.memory = match refresh_history_summary(ctx, &session, plan).await {
        Ok(memory) => memory,
        Err(_) => Memory::from_value(&session.memory),
    };
    let memory = ctx.memory.clone();
    let system = prompt::system_prompt(&prompt::PromptContext {
        requirement_label: ctx.spec.requirement_label.clone(),
        requirement_dir: ctx.spec.requirement_dir.clone(),
        permission_mode: session.permission_mode.clone(),
        memory_summary: memory.summary.as_ref().map(|item| item.text.clone()),
        read_index: memory.read_index.clone(),
    });
    let until = memory
        .summary
        .as_ref()
        .map(|item| item.until_message_id.as_str());
    let mut messages = vec![ModelMsg::text(Role::System, system)];
    messages.extend(model::history_for_model(
        &session.messages,
        until,
        plan.history,
    ));
    match &job {
        Job::Message { text, images } => {
            let urls = sessions::session_image_data_urls(&ctx.root, ctx.session_id(), images)?;
            ctx.persist_with_images(Role::User, text.clone(), images.clone())?;
            messages.push(if urls.is_empty() {
                ModelMsg::text(Role::User, text.clone())
            } else {
                let mut parts = Vec::with_capacity(urls.len() + 1);
                if !text.is_empty() {
                    parts.push(Part::Text(text.clone()));
                }
                parts.extend(urls.into_iter().map(Part::Image));
                ModelMsg {
                    role: Role::User,
                    content: Content::Parts(parts),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                }
            });
        }
        Job::Resume(Resume::Approval) => {
            sessions::mark_approvals_notified(&ctx.root, ctx.session_id())?;
            ctx.persist(Role::System, prompt::APPROVAL_NOTE.to_string(), Vec::new())?;
            messages.push(ModelMsg::text(Role::User, prompt::RESUME_GUIDANCE));
        }
        Job::Resume(Resume::Interrupted) => {
            ctx.persist(
                Role::System,
                prompt::INTERRUPTED_NOTE.to_string(),
                Vec::new(),
            )?;
            messages.push(ModelMsg::text(Role::User, prompt::INTERRUPTED_GUIDANCE));
        }
    }
    let mut state = LoopState {
        messages,
        trigger: plan.trigger,
        keep: plan.keep,
        calibration: 1.0,
        sent: 0,
    };
    drive(ctx, &mut state).await
}

struct LoopState {
    messages: Vec<ModelMsg>,
    trigger: u64,
    keep: u64,
    calibration: f64,
    sent: u64,
}

fn predicted(state: &LoopState) -> u64 {
    (model::estimate_messages(&state.messages) as f64 * state.calibration).round() as u64
}

fn calibrate(state: &mut LoopState, prompt_tokens: Option<u64>) {
    if let Some(tokens) = prompt_tokens {
        if tokens > 0 && state.sent > 0 {
            state.calibration =
                (tokens as f64 / state.sent as f64).clamp(CALIBRATION_MIN, CALIBRATION_MAX);
        }
    }
}

fn stop(ctx: &RunCtx) -> Result<Status, String> {
    ctx.persist(Role::System, prompt::STOP_NOTE.to_string(), Vec::new())?;
    Ok(Status::Stopped)
}

async fn drive(ctx: &mut RunCtx, state: &mut LoopState) -> Result<Status, String> {
    let mut previous = String::new();
    let mut repeated = 0usize;
    let mut warned = false;
    let mut round = 0usize;
    let mut fake_calls = 0usize;
    let mut continued = 0usize;
    loop {
        if ctx.cancelled() {
            return stop(ctx);
        }
        if let Err(error) = prepare_context(ctx, state, false).await {
            return if is_cancel(&error) {
                stop(ctx)
            } else {
                Err(error)
            };
        }
        if ctx.cancelled() {
            return stop(ctx);
        }
        round += 1;
        ctx.emit(Event::Round {
            round,
            context_tokens: predicted(state),
            trigger_tokens: state.trigger,
        });
        let reply = match call_with_recovery(ctx, state).await {
            Ok(reply) => reply,
            Err(error) if is_cancel(&error) => return stop(ctx),
            Err(error) => return Err(error),
        };
        calibrate(state, reply.prompt_tokens);
        if reply.tool_calls.is_empty() {
            let degenerate = reply.finish_reason.as_deref() == Some(llm::REPETITION_FINISH);
            if !degenerate && !model::mentions_tool_call(&reply.content) {
                ctx.persist(Role::Assistant, reply.content.clone(), Vec::new())?;
                if reply.finish_reason.as_deref() != Some("length") {
                    return Ok(Status::Completed);
                }
                if continued >= CONTINUE_LIMIT {
                    ctx.persist(
                        Role::System,
                        prompt::CONTINUE_LIMIT_NOTE.to_string(),
                        Vec::new(),
                    )?;
                    return Ok(Status::Completed);
                }
                continued += 1;
                state.messages.push(ModelMsg {
                    role: Role::Assistant,
                    content: text_content(&reply.content),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
                state
                    .messages
                    .push(ModelMsg::text(Role::User, prompt::CONTINUE_GUIDANCE));
                ctx.persist(Role::System, prompt::CONTINUE_NOTE.to_string(), Vec::new())?;
                continue;
            }
            let kept = model::strip_tool_summary(&reply.content);
            if !kept.is_empty() {
                ctx.persist(Role::Assistant, kept.clone(), Vec::new())?;
            }
            if fake_calls >= FAKE_TOOL_LIMIT {
                ctx.persist(
                    Role::System,
                    prompt::FAKE_TOOL_STOP_NOTE.to_string(),
                    Vec::new(),
                )?;
                return Ok(Status::Completed);
            }
            fake_calls += 1;
            if !kept.is_empty() {
                state.messages.push(ModelMsg {
                    role: Role::Assistant,
                    content: text_content(&kept),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
            }
            state
                .messages
                .push(ModelMsg::text(Role::User, prompt::FAKE_TOOL_GUIDANCE));
            ctx.persist(Role::System, prompt::FAKE_TOOL_NOTE.to_string(), Vec::new())?;
            continue;
        }
        let calls: Vec<ToolCall> = reply.tool_calls.clone();
        state.messages.push(ModelMsg {
            role: Role::Assistant,
            content: text_content(&reply.content),
            tool_calls: calls.clone(),
            tool_call_id: None,
        });
        ctx.persist(
            Role::Assistant,
            reply.content.clone(),
            calls
                .iter()
                .map(|call| {
                    json!({
                        "id": call.id,
                        "name": call.name,
                        "arguments": model::clip(&call.arguments, model::ARGUMENT_RECORD_CHARS),
                    })
                })
                .collect(),
        )?;
        let mut attachments: Vec<Part> = Vec::new();
        let reply_truncated = reply.finish_reason.as_deref() == Some("length");
        for call in &calls {
            if ctx.cancelled() {
                record_outcome(
                    ctx,
                    state,
                    call,
                    ToolOutcome::failure(prompt::NOT_RUN_NOTE),
                    None,
                )?;
                continue;
            }
            ctx.emit(Event::ToolStarted {
                id: call.id.clone(),
                name: call.name.clone(),
                detail: tool_detail(call),
            });
            let outcome = if reply_truncated && model::parse_arguments(&call.arguments).is_none() {
                ToolOutcome::failure(prompt::TRUNCATED_ARGS_NOTE)
            } else {
                limit_outcome(
                    tools::execute(ctx, call).await,
                    model::MAX_TOOL_RESULT_CHARS,
                )
            };
            let approval_id = match &outcome.approval {
                Some(request) => Some(request_approval(ctx, call, request)?),
                None => None,
            };
            ctx.emit(Event::ToolFinished {
                id: call.id.clone(),
                name: call.name.clone(),
                ok: outcome.ok,
            });
            attachments.extend(outcome.attachments.iter().cloned());
            record_outcome(ctx, state, call, outcome, approval_id)?;
        }
        if !attachments.is_empty() {
            state.messages.push(ModelMsg {
                role: Role::User,
                content: Content::Parts(attachments),
                tool_calls: Vec::new(),
                tool_call_id: None,
            });
        }
        let signature = calls
            .iter()
            .map(|call| format!("{}:{}", call.name, call.arguments))
            .collect::<Vec<_>>()
            .join("\n");
        repeated = if signature == previous {
            repeated + 1
        } else {
            1
        };
        previous = signature;
        if repeated < REPEAT_LIMIT {
            continue;
        }
        if warned {
            ctx.persist(
                Role::System,
                prompt::REPEAT_STOP_NOTE.to_string(),
                Vec::new(),
            )?;
            return Ok(Status::Completed);
        }
        warned = true;
        repeated = 0;
        state
            .messages
            .push(ModelMsg::text(Role::User, prompt::REPEAT_WARNING));
        ctx.persist(Role::System, prompt::REPEAT_NOTE.to_string(), Vec::new())?;
    }
}

fn text_content(text: &str) -> Content {
    if text.is_empty() {
        Content::Empty
    } else {
        Content::Text(text.to_string())
    }
}

async fn prepare_context(
    ctx: &mut RunCtx,
    state: &mut LoopState,
    force: bool,
) -> Result<(), String> {
    model::trim_images(&mut state.messages);
    if !force && predicted(state) <= state.trigger {
        return Ok(());
    }
    let cut = model::compaction_cut(&state.messages, state.keep);
    if cut > 1 {
        ctx.emit(Event::Compacting {
            part: None,
            total: None,
        });
        let lines: Vec<String> = state.messages[1..cut]
            .iter()
            .map(model::model_line)
            .collect();
        let chunk = ctx.plan().chunk;
        match rolling_summary(
            ctx,
            prompt::RUN_INSTRUCTION,
            lines,
            String::new(),
            chunk,
            true,
        )
        .await
        {
            Ok(summary) => {
                let note = ModelMsg::text(
                    Role::User,
                    format!("【较早过程的摘要（自动压缩）】\n{summary}"),
                );
                state.messages.splice(1..cut, [note]);
            }
            Err(error) if is_cancel(&error) || ctx.cancelled() => return Err(error),
            Err(_) => {}
        }
    }
    if predicted(state) > state.trigger {
        let (calibration, trigger) = (state.calibration, state.trigger);
        model::trim_tool_results(&mut state.messages, |messages| {
            (model::estimate_messages(messages) as f64 * calibration).round() as u64 <= trigger
        });
    }
    Ok(())
}

async fn call_with_recovery(ctx: &mut RunCtx, state: &mut LoopState) -> Result<ModelReply, String> {
    let mut attempt = 0usize;
    loop {
        state.sent = model::estimate_messages(&state.messages);
        match call_model(ctx, &state.messages).await {
            Ok(reply) => return Ok(reply),
            Err(error) => {
                if !is_overflow(&error) || attempt >= MAX_OVERFLOW_RETRIES || ctx.cancelled() {
                    return Err(error);
                }
                attempt += 1;
                prepare_context(ctx, state, true).await?;
            }
        }
    }
}

async fn call_model(ctx: &RunCtx, messages: &[ModelMsg]) -> Result<ModelReply, String> {
    let provider = &ctx.spec.provider;
    let endpoint = llm::endpoint(&provider.base_url, &provider.api_key, &provider.model)?;
    let wire: Vec<Value> = messages.iter().map(ModelMsg::wire).collect();
    let value = llm::stream_model(
        &ctx.run.run_id,
        &endpoint,
        wire,
        &prompt::connection_tool_schemas(&ctx.spec.connections),
        model::MODEL_MAX_TOKENS,
        |update| ctx.on_stream(update),
    )
    .await?;
    Ok(model::parse_reply(&value))
}

async fn summarize_once(
    ctx: &mut RunCtx,
    instruction: &str,
    body: String,
) -> Result<String, String> {
    ctx.summary_calls += 1;
    let child = format!("{}::summary-{}", ctx.run.run_id, ctx.summary_calls);
    let provider = &ctx.spec.provider;
    let endpoint = llm::endpoint(&provider.base_url, &provider.api_key, &provider.model)?;
    let wire = vec![
        ModelMsg::text(Role::System, instruction).wire(),
        ModelMsg::text(Role::User, body).wire(),
    ];
    let value = llm::stream_model(
        &child,
        &endpoint,
        wire,
        &[],
        model::SUMMARY_MAX_TOKENS,
        |_| {},
    )
    .await?;
    let text = value
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("模型没有返回摘要".to_string());
    }
    Ok(text)
}

async fn rolling_summary(
    ctx: &mut RunCtx,
    instruction: &str,
    lines: Vec<String>,
    previous: String,
    chunk_tokens: u64,
    compacting: bool,
) -> Result<String, String> {
    let chunks = model::chunk_lines(&lines, chunk_tokens);
    let total = chunks.len();
    let mut summary = previous;
    for (index, chunk) in chunks.iter().enumerate() {
        if ctx.cancelled() {
            return Err(RUN_CANCELLED.to_string());
        }
        if compacting {
            ctx.emit(Event::Compacting {
                part: Some(index + 1),
                total: Some(total),
            });
        }
        let head = if summary.is_empty() {
            String::new()
        } else {
            format!("[已有摘要]\n{summary}\n\n[新增过程]\n")
        };
        summary = summarize_once(ctx, instruction, format!("{head}{}", chunk.join("\n"))).await?;
    }
    Ok(summary)
}

/// 会话落盘消息过多时，把较早的部分合并进历史摘要（记忆）。失败时保留原记忆。
async fn refresh_history_summary(
    ctx: &mut RunCtx,
    session: &AiSession,
    plan: ContextPlan,
) -> Result<Memory, String> {
    let memory = Memory::from_value(&session.memory);
    let from = memory.summary.as_ref().map_or(0, |summary| {
        session
            .messages
            .iter()
            .position(|message| message.id == summary.until_message_id)
            .map_or(0, |index| index + 1)
    });
    let unsummarized: u64 = session
        .messages
        .get(from..)
        .unwrap_or(&[])
        .iter()
        .map(model::persisted_tokens)
        .sum();
    if unsummarized <= plan.history {
        return Ok(memory);
    }
    let tail = model::tail_start(&session.messages, plan.keep);
    if tail <= from {
        return Ok(memory);
    }
    ctx.emit(Event::Compacting {
        part: None,
        total: None,
    });
    let mut lines = Vec::new();
    if !memory.read_index.is_empty() {
        lines.push(format!(
            "[已读取资料要点]\n{}",
            model::read_index_text(&memory.read_index)
        ));
    }
    lines.extend(
        session.messages[from..tail]
            .iter()
            .map(model::persisted_line),
    );
    let previous = memory
        .summary
        .as_ref()
        .map(|item| item.text.clone())
        .unwrap_or_default();
    let text = rolling_summary(
        ctx,
        prompt::HISTORY_INSTRUCTION,
        lines,
        previous,
        plan.chunk,
        true,
    )
    .await?;
    let mut next = memory;
    next.summary = Some(MemorySummary {
        text,
        until_message_id: session.messages[tail - 1].id.clone(),
        updated_at: chrono_now(),
    });
    sessions::update_ai_session_memory(
        ctx.root_path(),
        ctx.spec.session_id.clone(),
        next.to_value(),
    )?;
    Ok(next)
}

fn tool_detail(call: &ToolCall) -> String {
    let args = model::parse_arguments(&call.arguments).unwrap_or_else(|| json!({}));
    if let Some(path) = args.get("path").and_then(Value::as_str) {
        return path.to_string();
    }
    match (
        args.get("from").and_then(Value::as_str),
        args.get("to").and_then(Value::as_str),
    ) {
        (Some(from), Some(to)) => format!("{from} → {to}"),
        _ => String::new(),
    }
}

/// 结果过长时不做静默截断：部分内容回填给模型可能导致它基于残缺数据改写文件。
fn limit_outcome(outcome: ToolOutcome, limit: usize) -> ToolOutcome {
    if !outcome.ok {
        return outcome;
    }
    let size = outcome
        .output
        .as_ref()
        .map_or(4, |value| value.to_string().chars().count());
    if size <= limit {
        return outcome;
    }
    ToolOutcome {
        ok: false,
        error: Some(format!(
            "工具结果过长（{size} 字符，上限 {limit}），未返回内容，请缩小读取范围"
        )),
        changed_paths: outcome.changed_paths,
        ..Default::default()
    }
}

fn request_approval(
    ctx: &RunCtx,
    call: &ToolCall,
    request: &tools::ApprovalRequest,
) -> Result<String, String> {
    let mut arguments = model::parse_arguments(&call.arguments).unwrap_or_else(|| json!({}));
    tools::bind_approval(ctx, &call.name, &mut arguments);
    let approval = sessions::request_ai_approval(
        ctx.root_path(),
        ctx.session_id().to_string(),
        call.id.clone(),
        call.name.clone(),
        arguments,
        request.paths.clone(),
        request.reason.clone(),
        Some(ctx.run.run_id.clone()),
    )?;
    ctx.emit(Event::Approval {
        approval: approval.clone(),
    });
    Ok(approval.id)
}

fn record_outcome(
    ctx: &RunCtx,
    state: &mut LoopState,
    call: &ToolCall,
    outcome: ToolOutcome,
    approval_id: Option<String>,
) -> Result<(), String> {
    let pending = approval_id
        .as_ref()
        .map(|id| format!("等待用户审批（{id}）"));
    let payload = match &approval_id {
        Some(id) => json!({
            "ok": false,
            "approval_required": true,
            "approval_id": id,
            "error": format!(
                "{}，已提交审批请求，等待用户批准后执行",
                outcome.error.clone().unwrap_or_else(|| "需要用户审批".to_string())
            ),
        }),
        None => tools::outcome_payload(&outcome),
    };
    state.messages.push(ModelMsg {
        role: Role::Tool,
        content: Content::Text(payload.to_string()),
        tool_calls: Vec::new(),
        tool_call_id: Some(call.id.clone()),
    });
    let content = match &pending {
        Some(text) => format!("{} {}", call.name, text),
        None if outcome.ok => format!("{} 执行成功", call.name),
        None => format!(
            "{} 执行失败：{}",
            call.name,
            outcome
                .error
                .clone()
                .unwrap_or_else(|| "未知错误".to_string())
        ),
    };
    let error = pending.clone().or_else(|| outcome.error.clone());
    let record = json!({
        "id": call.id,
        "name": call.name,
        "ok": outcome.ok,
        "changed_paths": outcome.changed_paths,
        "error": error,
    });
    ctx.persist(Role::Tool, content, vec![record])?;
    Ok(())
}

/// 用户在界面上做出审批决定：记录决定；拒绝时立即写入工具结果，让历史与界面都准确。
pub(crate) fn decide(
    rt: &Runtime,
    root_path: &str,
    session_id: &str,
    approval_id: &str,
    approved: bool,
) -> Result<AiApproval, String> {
    let decided = sessions::decide_ai_approval(
        root_path.to_string(),
        session_id.to_string(),
        approval_id.to_string(),
        approved,
    )?;
    if !approved {
        let record = json!({
            "id": decided.tool_call_id,
            "name": decided.tool,
            "ok": false,
            "changed_paths": [],
            "error": "用户拒绝了该操作",
        });
        let session = sessions::append_ai_session_message(
            root_path.to_string(),
            session_id.to_string(),
            AiSessionMessage {
                role: "tool".to_string(),
                content: format!("{} 已被用户拒绝，未执行", decided.tool),
                tool_calls: vec![record],
                ..Default::default()
            },
        )?;
        if let Some(saved) = session.messages.last() {
            rt.publish_session(
                session_id,
                Event::Message {
                    message: saved.clone(),
                },
            );
        }
    }
    rt.publish_session(
        session_id,
        Event::Approval {
            approval: decided.clone(),
        },
    );
    Ok(decided)
}

/// 运行结束后是否需要续跑：有已批准未执行的操作，或审批已全部处理但模型还没有收到结果。
pub(crate) fn follow_up_needed(root_path: &str, session_id: &str) -> bool {
    let Ok((root, _config)) = load_initialized_workspace(root_path) else {
        return false;
    };
    let Ok(session) = sessions::load_session(&root, session_id) else {
        return false;
    };
    let pending = session
        .approvals
        .iter()
        .any(|item| item.status == "pending");
    session
        .approvals
        .iter()
        .any(|item| item.status == "approved")
        || (!pending
            && session.approvals.iter().any(|item| {
                matches!(item.status.as_str(), "rejected" | "consumed") && !item.notified
            }))
}

#[cfg(test)]
mod tests {
    use super::super::{AgentSnapshot, ProviderInput, Sink, EVENT_NAME};
    use super::*;
    use crate::sessions::{create_ai_session, read_ai_session};
    use crate::workspace::{create_requirement, init_fixture_workspace, RequirementDraft};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    const REQUIREMENT: &str = "projects/示例平台/AI-1001";

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<Value>>,
    }

    impl Sink for RecordingSink {
        fn emit(&self, name: &str, payload: Value) {
            if name == EVENT_NAME {
                self.events.lock().unwrap().push(payload);
            }
        }
    }

    impl RecordingSink {
        fn kinds(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| event["kind"].as_str().map(str::to_string))
                .collect()
        }

        fn finished_status(&self) -> Option<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|event| event["kind"] == "run_finished")
                .and_then(|event| event["status"].as_str().map(str::to_string))
        }
    }

    struct FakeModel {
        base_url: String,
        requests: Arc<Mutex<Vec<Value>>>,
    }

    /// 本地假模型：按顺序返回 SSE 回复，超出时重复最后一条。
    fn fake_model(responses: Vec<String>, delay: Duration) -> FakeModel {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake model");
        let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&requests);
        std::thread::spawn(move || {
            let mut served = 0usize;
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let body = read_body(&mut stream);
                log.lock()
                    .unwrap()
                    .push(serde_json::from_str(&body).unwrap_or(Value::Null));
                let index = served.min(responses.len().saturating_sub(1));
                served += 1;
                std::thread::sleep(delay);
                let reply = responses.get(index).cloned().unwrap_or_default();
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        FakeModel { base_url, requests }
    }

    fn read_body(stream: &mut TcpStream) -> String {
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_end = loop {
            let read = match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return String::new(),
                Ok(count) => count,
            };
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
        };
        let headers = String::from_utf8_lossy(&buffer[..header_end]).to_lowercase();
        let length = headers
            .lines()
            .find_map(|line| {
                line.strip_prefix("content-length:")
                    .and_then(|value| value.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while buffer.len() < header_end + length {
            let read = match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            buffer.extend_from_slice(&chunk[..read]);
        }
        let end = (header_end + length).min(buffer.len());
        String::from_utf8_lossy(&buffer[header_end..end]).to_string()
    }

    fn sse_text(text: &str) -> String {
        format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [{ "delta": { "content": text } }] })
        )
    }

    fn sse_text_finish(text: &str, finish: &str) -> String {
        format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [{ "delta": { "content": text }, "finish_reason": finish }] })
        )
    }

    fn sse_tool(id: &str, name: &str, arguments: &str) -> String {
        format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0,
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": arguments },
            }] } }] })
        )
    }

    fn sse_tool_finish(id: &str, name: &str, arguments: &str, finish: &str) -> String {
        format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [{
                "delta": { "tool_calls": [{
                    "index": 0,
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": arguments },
                }] },
                "finish_reason": finish,
            }] })
        )
    }

    fn provider(model: &FakeModel) -> ProviderInput {
        ProviderInput {
            enabled: true,
            base_url: model.base_url.clone(),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            context_window_tokens: None,
            compaction_trigger_tokens: None,
        }
    }

    fn workspace(name: &str) -> (String, PathBuf) {
        let root = std::env::temp_dir().join(format!("agent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        init_fixture_workspace(root_path.clone(), "Agent测试工作区".to_string()).unwrap();
        create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "AI-1001".to_string(),
                name: "AI运行时测试".to_string(),
                owner: String::new(),
                planned_test_date: None,
                planned_release_date: None,
                applications: Vec::new(),
                initial_stage: "draft".to_string(),
                yunxiao: None,
                extensions: Default::default(),
            },
        )
        .unwrap();
        (root_path, root)
    }

    fn message_spec(
        root_path: &str,
        session_id: &str,
        provider: ProviderInput,
        text: &str,
    ) -> JobSpec {
        JobSpec {
            root_path: root_path.to_string(),
            session_id: session_id.to_string(),
            provider,
            yunxiao: None,
            connections: Vec::new(),
            requirement_label: "AI-1001".to_string(),
            requirement_dir: REQUIREMENT.to_string(),
            job: Job::Message {
                text: text.to_string(),
                images: Vec::new(),
            },
        }
    }

    fn resume_spec(
        root_path: &str,
        session_id: &str,
        provider: ProviderInput,
        resume: Resume,
    ) -> JobSpec {
        JobSpec {
            job: Job::Resume(resume),
            ..message_spec(root_path, session_id, provider, "")
        }
    }

    fn wait_idle(rt: &Runtime, session_id: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while rt.is_busy(session_id) {
            assert!(Instant::now() < deadline, "run did not finish in time");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn write_proposal(final_text: &str) -> Vec<String> {
        vec![
            sse_tool(
                "call-w",
                "create_file",
                &json!({
                    "path": format!("{REQUIREMENT}/02-需求理解与答疑/理解.md"),
                    "content": "# 需求理解\n登录验证码",
                })
                .to_string(),
            ),
            sse_text("已提交写入审批，等待你批准。"),
            sse_text(final_text),
        ]
    }

    #[test]
    fn message_run_reads_a_file_and_answers() {
        let (root_path, root) = workspace("read");
        let file = root
            .join(REQUIREMENT)
            .join("01-需求资料")
            .join("需求说明.md");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "登录需要验证码，失败三次锁定。").unwrap();
        let session_id = create_ai_session(
            root_path.clone(),
            "读取测试".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_tool(
                    "call-1",
                    "read_file",
                    &json!({ "path": format!("{REQUIREMENT}/01-需求资料/需求说明.md") })
                        .to_string(),
                ),
                sse_text("要点：登录需要验证码，失败三次锁定。"),
            ],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "读取需求说明",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|item| item.role.as_str())
            .collect();
        assert_eq!(roles, ["user", "assistant", "tool", "assistant"]);
        assert_eq!(session.messages[2].tool_calls[0]["ok"], json!(true));
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        for kind in ["run_started", "tool_started", "tool_finished", "message"] {
            assert!(
                sink.kinds().iter().any(|item| item == kind),
                "missing {kind}"
            );
        }
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].to_string().contains("登录需要验证码"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn message_with_image_reaches_the_model_as_parts() {
        let (root_path, root) = workspace("image-msg");
        let session_id = create_ai_session(
            root_path.clone(),
            "图片消息".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let image_name = crate::sessions::save_ai_session_image(
            root_path.clone(),
            session_id.clone(),
            "AAEC".to_string(),
            "png".to_string(),
        )
        .unwrap();
        let model = fake_model(vec![sse_text("看到了图片。")], Duration::ZERO);
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(JobSpec {
            job: Job::Message {
                text: "看这张截图".to_string(),
                images: vec![image_name.clone()],
            },
            ..message_spec(&root_path, &session_id, provider(&model), "")
        })
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        let user = session
            .messages
            .iter()
            .find(|item| item.role == "user")
            .unwrap();
        assert_eq!(user.images, vec![image_name]);
        assert_eq!(user.content, "看这张截图");
        let requests = model.requests.lock().unwrap();
        let last = requests.last().unwrap().to_string();
        assert!(
            last.contains("image_url"),
            "request missing image part: {last}"
        );
        assert!(last.contains("data:image/png;base64,"));
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn message_with_missing_image_fails() {
        let (root_path, root) = workspace("image-miss");
        let session_id = create_ai_session(
            root_path.clone(),
            "缺失图片".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(vec![sse_text("看到了图片。")], Duration::ZERO);
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(JobSpec {
            job: Job::Message {
                text: "看这张截图".to_string(),
                images: vec!["missing.png".to_string()],
            },
            ..message_spec(&root_path, &session_id, provider(&model), "")
        })
        .unwrap();
        wait_idle(&rt, &session_id);
        assert_eq!(sink.finished_status().as_deref(), Some("failed"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn text_describing_a_tool_call_does_not_end_the_run() {
        let (root_path, root) = workspace("fake-tool");
        let session_id = create_ai_session(
            root_path.clone(),
            "伪调用测试".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_text("我先读参考用例。\n本轮工具调用：\n- read_document：成功"),
                sse_text("我已用 read_file 确认了内容，结论如下。"),
            ],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "修改用例",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id).unwrap();
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|item| item.role.as_str())
            .collect();
        assert_eq!(roles, ["user", "assistant", "system", "assistant"]);
        assert!(session.messages[2].content.contains("没有真正执行"));
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].to_string().contains("真实的工具调用"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn repeated_fake_tool_text_stops_after_the_limit() {
        let (root_path, root) = workspace("fake-limit");
        let session_id = create_ai_session(
            root_path.clone(),
            "伪调用上限".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![sse_text("本轮工具调用：\n- read_document：成功")],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "读取资料",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id).unwrap();
        assert!(session
            .messages
            .iter()
            .any(|item| item.role == "system" && item.content.contains("已停止自动执行")));
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), FAKE_TOOL_LIMIT + 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn truncated_tool_arguments_get_a_split_hint_instead_of_executing() {
        let (root_path, root) = workspace("truncated-args");
        let session_id = create_ai_session(
            root_path.clone(),
            "截断测试".into(),
            None,
            Some("AI-1001".into()),
            "code".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_tool_finish(
                    "c1",
                    "write_xmind",
                    "{\"path\":\"a.xmind\",\"title\":\"合并\",\"outline\":\"未闭合的大纲",
                    "length",
                ),
                sse_text("大纲太长，我按模块拆成多个文件写入。"),
            ],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "合并用例",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        let tool = session
            .messages
            .iter()
            .find(|item| item.role == "tool")
            .expect("tool outcome");
        assert_eq!(tool.tool_calls[0]["ok"], json!(false));
        let error = tool.tool_calls[0]["error"].as_str().unwrap_or_default();
        assert!(error.contains("输出长度上限"), "{error}");
        assert!(error.contains("拆分"), "{error}");
        assert!(!root.join(REQUIREMENT).join("a.xmind").exists());
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        assert_eq!(model.requests.lock().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn approved_write_runs_after_the_decision_and_the_model_resumes() {
        let (root_path, root) = workspace("approve");
        let session_id = create_ai_session(
            root_path.clone(),
            "审批测试".into(),
            None,
            Some("AI-1001".into()),
            "ask".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(write_proposal("已写入需求理解文档。"), Duration::ZERO);
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "写一份需求理解",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        assert_eq!(session.approvals.len(), 1);
        let approval = session.approvals[0].clone();
        assert_eq!(approval.status, "pending");
        let target = root
            .join(REQUIREMENT)
            .join("02-需求理解与答疑")
            .join("理解.md");
        assert!(!target.exists());

        let decided = decide(&rt, &root_path, &session_id, &approval.id, true).unwrap();
        assert_eq!(decided.status, "approved");
        assert!(rt
            .kick(resume_spec(
                &root_path,
                &session_id,
                provider(&model),
                Resume::Approval
            ))
            .unwrap()
            .is_some());
        wait_idle(&rt, &session_id);

        assert!(target.is_file());
        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        assert_eq!(session.approvals[0].status, "consumed");
        assert!(session
            .messages
            .iter()
            .any(|item| item.role == "tool" && item.content == "create_file 已按审批执行"));
        assert_eq!(
            session.messages.last().unwrap().content,
            "已写入需求理解文档。"
        );
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].to_string().contains("审批已处理"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn yunxiao_write_asks_for_approval_instead_of_calling_http() {
        let (root_path, root) = workspace("yx-ask");
        let session_id = create_ai_session(
            root_path.clone(),
            "云效审批".into(),
            None,
            Some("AI-1001".into()),
            "ask".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_tool(
                    "call-yx",
                    "yunxiao_create_testcase",
                    &json!({ "test_repo_id": "repo-1", "subject": "登录用例" }).to_string(),
                ),
                sse_text("已提交审批。"),
            ],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(JobSpec {
            connections: Vec::new(),
            yunxiao: Some(crate::yunxiao::YunxiaoAuth {
                token: "pt-test".to_string(),
                org_id: "org-1".to_string(),
                ..Default::default()
            }),
            ..message_spec(&root_path, &session_id, provider(&model), "上传用例")
        })
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        assert_eq!(session.approvals.len(), 1);
        let approval = &session.approvals[0];
        assert_eq!(approval.tool, "yunxiao_create_testcase");
        assert_eq!(approval.status, "pending");
        assert!(approval.paths[0].contains("repo-1"));
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        decide(&rt, &root_path, &session_id, &approval.id, true).unwrap();
        rt.kick(JobSpec {
            yunxiao: Some(crate::yunxiao::YunxiaoAuth {
                token: "fixture-rotated".into(),
                org_id: "different-org".into(),
                ..Default::default()
            }),
            ..resume_spec(&root_path, &session_id, provider(&model), Resume::Approval)
        })
        .unwrap();
        wait_idle(&rt, &session_id);
        let replay = read_ai_session(root_path.clone(), session_id).unwrap();
        assert!(replay
            .messages
            .iter()
            .any(|m| m.role == "tool" && m.content.contains("旧审批无法识别原连接")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn yunxiao_read_without_token_reports_configuration() {
        let (root_path, root) = workspace("yx-none");
        let session_id = create_ai_session(
            root_path.clone(),
            "云效读取".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_tool("call-yx", "yunxiao_list_test_repos", &json!({}).to_string()),
                sse_text("需要先配置云效令牌。"),
            ],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "列出用例库",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id).unwrap();
        let tool = session
            .messages
            .iter()
            .find(|item| item.role == "tool")
            .expect("missing tool message");
        assert_eq!(tool.tool_calls[0]["ok"], json!(false));
        assert!(tool.tool_calls[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("未配置云效令牌"));
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn generic_tools_use_memory_ids_without_vendor_auth() {
        let (root_path, root) = workspace("external-memory");
        let session_id = create_ai_session(
            root_path.clone(),
            "外部连接".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_tool(
                    "ext",
                    "external_query",
                    &json!({"connection_id":"memory-a","operation":"projects","args":{}})
                        .to_string(),
                ),
                sse_text("读取完成"),
            ],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(JobSpec {
            connections: vec![crate::integrations::ports::Connection {
                connection_id: "memory-a".into(),
                provider_id: "memory".into(),
                enabled: true,
                ..Default::default()
            }],
            ..message_spec(&root_path, &session_id, provider(&model), "读取项目")
        })
        .unwrap();
        wait_idle(&rt, &session_id);
        let session = read_ai_session(root_path.clone(), session_id).unwrap();
        let tool = session.messages.iter().find(|m| m.role == "tool").unwrap();
        assert_eq!(tool.tool_calls[0]["ok"], true);
        let payload = model.requests.lock().unwrap().last().unwrap().to_string();
        assert!(payload.contains("project/alpha"));
        assert!(payload.contains("memory-a"));
        assert!(session.approvals.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejected_write_is_recorded_and_the_model_is_told() {
        let (root_path, root) = workspace("reject");
        let session_id = create_ai_session(
            root_path.clone(),
            "拒绝测试".into(),
            None,
            Some("AI-1001".into()),
            "ask".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(write_proposal("好的，已取消写入。"), Duration::ZERO);
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "写一份需求理解",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);
        let approval_id = read_ai_session(root_path.clone(), session_id.clone())
            .unwrap()
            .approvals[0]
            .id
            .clone();

        decide(&rt, &root_path, &session_id, &approval_id, false).unwrap();
        assert!(rt
            .kick(resume_spec(
                &root_path,
                &session_id,
                provider(&model),
                Resume::Approval
            ))
            .unwrap()
            .is_some());
        wait_idle(&rt, &session_id);

        assert!(!root
            .join(REQUIREMENT)
            .join("02-需求理解与答疑")
            .join("理解.md")
            .exists());
        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        assert_eq!(session.approvals[0].status, "rejected");
        assert!(session.approvals[0].notified);
        assert!(session
            .messages
            .iter()
            .any(|item| item.content == "create_file 已被用户拒绝，未执行"));
        assert_eq!(
            session.messages.last().unwrap().content,
            "好的，已取消写入。"
        );
        assert!(model.requests.lock().unwrap()[2]
            .to_string()
            .contains("已拒绝的操作没有执行"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn repeated_reply_is_cut_before_it_is_saved_or_fed_back() {
        let (root_path, root) = workspace("degenerate");
        let session_id = create_ai_session(
            root_path.clone(),
            "退化循环".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let degenerate = format!("我先读取资料。\n{}", "- list_directory：成功\n".repeat(400));
        let model = fake_model(
            vec![sse_text(&degenerate), sse_text("资料已读完，结论如下。")],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "读取资料",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id).unwrap();
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|item| item.role.as_str())
            .collect();
        assert_eq!(roles, ["user", "assistant", "system", "assistant"]);
        assert_eq!(session.messages[1].content, "我先读取资料。");
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].to_string().contains("真实的工具调用"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn truncated_text_reply_is_continued_instead_of_ending_the_run() {
        let (root_path, root) = workspace("continue");
        let session_id = create_ai_session(
            root_path.clone(),
            "续写测试".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_text_finish("第一部分：需求背景与目标。", "length"),
                sse_text("第二部分：测试范围与结论。"),
            ],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "写需求理解",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let session = read_ai_session(root_path.clone(), session_id).unwrap();
        let roles: Vec<&str> = session
            .messages
            .iter()
            .map(|item| item.role.as_str())
            .collect();
        assert_eq!(roles, ["user", "assistant", "system", "assistant"]);
        assert_eq!(session.messages[3].content, "第二部分：测试范围与结论。");
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].to_string().contains("直接续写"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn xmind_batches_reach_the_client_as_appends() {
        let (root_path, root) = workspace("xmind-batch");
        let session_id = create_ai_session(
            root_path.clone(),
            "分批写入".into(),
            None,
            Some("AI-1001".into()),
            "code".into(),
        )
        .unwrap()
        .id;
        let path = format!("{REQUIREMENT}/04-测试用例/分批用例.xmind");
        let model = fake_model(
            vec![
                sse_tool(
                    "call-b1",
                    "write_xmind",
                    &json!({ "path": path, "title": "分批用例", "outline": "模块A\n  用例1" })
                        .to_string(),
                ),
                sse_tool(
                    "call-b2",
                    "write_xmind",
                    &json!({
                        "path": path,
                        "title": "分批用例",
                        "outline": "模块B\n  用例2",
                        "append": true,
                    })
                    .to_string(),
                ),
                sse_text("已分两批写入。"),
            ],
            Duration::ZERO,
        );
        let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        {
            let rt = Arc::clone(&rt);
            let seen = Arc::clone(&seen);
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                while Instant::now() < deadline {
                    for request in rt.client.pending(None) {
                        seen.lock().unwrap().push(request.payload.clone());
                        rt.client
                            .respond(&request.request_id, Err("测试：仅记录载荷".to_string()));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
        }
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "分批写用例",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let payloads = seen.lock().unwrap();
        assert_eq!(payloads.len(), 2);
        assert_eq!(payloads[0]["append"], json!(false));
        assert_eq!(payloads[1]["append"], json!(true));
        assert_eq!(model.requests.lock().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn docx_with_prepared_markdown_is_read_without_client_extraction() {
        use std::fs;
        let (root_path, root) = workspace("docx-ready");
        let source = format!("{REQUIREMENT}/01-需求资料/需求文档/需求.docx");
        let docx = root.join(&source);
        fs::create_dir_all(docx.parent().unwrap()).unwrap();
        fs::write(&docx, b"docx-bytes").unwrap();
        let dir = crate::docx_assets::asset_dir_for_docx(&source, b"docx-bytes").unwrap();
        fs::create_dir_all(root.join(&dir)).unwrap();
        fs::write(
            root.join(&dir).join("正文.md"),
            "# 需求\n\n![图 001](img-001.png)",
        )
        .unwrap();
        let session_id = create_ai_session(
            root_path.clone(),
            "内嵌图测试".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_tool(
                    "call-doc",
                    "read_document",
                    &json!({ "path": source }).to_string(),
                ),
                sse_text("已读取需求。"),
            ],
            Duration::ZERO,
        );
        let extracted: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        {
            let rt = Arc::clone(&rt);
            let extracted = Arc::clone(&extracted);
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                while Instant::now() < deadline {
                    for request in rt.client.pending(None) {
                        extracted.lock().unwrap().push(request.kind.clone());
                        rt.client.respond(
                            &request.request_id,
                            Ok(json!({ "kind": "text", "text": "客户端提取的正文" })),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
        }
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "读取需求",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        assert!(extracted.lock().unwrap().is_empty());
        let requests = model.requests.lock().unwrap();
        let tool_result = requests[1].to_string();
        assert!(tool_result.contains("img-001.png"), "{tool_result}");
        assert!(tool_result.contains(&dir), "{tool_result}");
        assert!(!tool_result.contains("客户端提取的正文"), "{tool_result}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn identical_tool_calls_stop_after_a_warning() {
        let (root_path, root) = workspace("repeat");
        let session_id = create_ai_session(
            root_path.clone(),
            "重复测试".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![sse_tool(
                "call-r",
                "list_directory",
                &json!({ "path": REQUIREMENT }).to_string(),
            )],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "列目录",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        assert_eq!(model.requests.lock().unwrap().len(), 6);
        assert_eq!(sink.finished_status().as_deref(), Some("completed"));
        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        assert_eq!(
            session.messages.last().unwrap().content,
            prompt::REPEAT_STOP_NOTE
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stop_cancels_an_in_flight_model_call() {
        let (root_path, root) = workspace("stop");
        let session_id = create_ai_session(
            root_path.clone(),
            "停止测试".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![sse_text("不应看到的回复")],
            Duration::from_millis(1500),
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "写点什么",
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(rt.stop(&session_id));
        wait_idle(&rt, &session_id);

        assert_eq!(sink.finished_status().as_deref(), Some("stopped"));
        let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
        let last = session.messages.last().unwrap();
        assert_eq!(
            (last.role.as_str(), last.content.as_str()),
            ("system", prompt::STOP_NOTE)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn different_sessions_run_at_the_same_time() {
        let (root_path, root) = workspace("concurrent");
        let first = create_ai_session(
            root_path.clone(),
            "并发一".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let second = create_ai_session(
            root_path.clone(),
            "并发二".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(vec![sse_text("完成")], Duration::from_millis(800));
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        rt.start(message_spec(&root_path, &first, provider(&model), "任务一"))
            .unwrap();
        rt.start(message_spec(
            &root_path,
            &second,
            provider(&model),
            "任务二",
        ))
        .unwrap();
        assert!(rt.is_busy(&first) && rt.is_busy(&second));
        assert!(rt
            .start(message_spec(&root_path, &first, provider(&model), "重复"))
            .is_err());
        wait_idle(&rt, &first);
        wait_idle(&rt, &second);

        for session_id in [&first, &second] {
            let session = read_ai_session(root_path.clone(), session_id.clone()).unwrap();
            assert_eq!(session.messages.last().unwrap().content, "完成");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn read_document_waits_for_the_client_bridge() {
        let (root_path, root) = workspace("bridge");
        let file = root
            .join(REQUIREMENT)
            .join("01-需求资料")
            .join("接口说明.md");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "原文内容").unwrap();
        let session_id = create_ai_session(
            root_path.clone(),
            "桥接测试".into(),
            None,
            Some("AI-1001".into()),
            "plan".into(),
        )
        .unwrap()
        .id;
        let model = fake_model(
            vec![
                sse_tool(
                    "call-d",
                    "read_document",
                    &json!({ "path": format!("{REQUIREMENT}/01-需求资料/接口说明.md") })
                        .to_string(),
                ),
                sse_text("已读取接口说明。"),
            ],
            Duration::ZERO,
        );
        let sink = Arc::new(RecordingSink::default());
        let rt = Arc::new(Runtime::new(sink.clone()));
        {
            let rt = Arc::clone(&rt);
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                while Instant::now() < deadline {
                    for request in rt.client.pending(None) {
                        let answer = json!({ "kind": "text", "text": "接口：登录接口需要验证码" });
                        rt.client.respond(&request.request_id, Ok(answer));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
        }
        rt.start(message_spec(
            &root_path,
            &session_id,
            provider(&model),
            "读接口说明",
        ))
        .unwrap();
        wait_idle(&rt, &session_id);

        let requests = model.requests.lock().unwrap();
        assert!(requests[1].to_string().contains("登录接口需要验证码"));
        let snapshot: AgentSnapshot = rt.snapshot(&session_id);
        assert!(!snapshot.busy);
        let _ = std::fs::remove_dir_all(root);
    }
}
