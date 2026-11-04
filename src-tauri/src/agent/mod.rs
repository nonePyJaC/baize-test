//! 会话 Agent 运行时。
//!
//! - 运行状态在后端持有：每个会话同一时间只有一个运行，不同会话互不影响、可以并发。
//! - 界面只订阅 `agent-event`（含 session_id、run_id、seq），打开会话时用 `agent_snapshot` 接回进行中的运行。
//! - 文档解析与 XMind 生成暂由前端作为客户端工具执行：后端发出 `agent-client-request`，界面回填结果。
//! - 工作区文件的读写仍经 `ai_tools.rs` 的受控命令，门禁、审批与运行日志的语义不变。

mod model;
mod prompt;
mod run;
mod tools;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, State};
use tokio::sync::oneshot;

use crate::llm::RUN_CANCELLED;
use crate::sessions::{AiApproval, AiSessionMessage};

pub(crate) const EVENT_NAME: &str = "agent-event";
pub(crate) const CLIENT_EVENT_NAME: &str = "agent-client-request";
const CLIENT_POLL: Duration = Duration::from_millis(200);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(900);
const BUSY_MESSAGE: &str = "该会话正在处理中，请等待完成，或先点击「停止」";
const ARCHIVED_MESSAGE: &str = "会话已归档，请先取消归档后再继续";
static COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    COUNTER.fetch_add(1, Ordering::SeqCst)
}

fn new_run_id() -> String {
    format!(
        "run-{}-{}",
        chrono::Local::now().format("%Y%m%d%H%M%S%3f"),
        next_id()
    )
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 事件输出端：生产环境是 Tauri 应用句柄，测试中是记录器。
pub(crate) trait Sink: Send + Sync {
    fn emit(&self, name: &str, payload: Value);
}

impl Sink for tauri::AppHandle {
    fn emit(&self, name: &str, payload: Value) {
        let _ = Emitter::emit(self, name, payload);
    }
}

/// 来自界面的模型服务配置（与「设置 → 模型服务」一致，API Key 只在本机偏好中保存）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ProviderInput {
    pub enabled: bool,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub context_window_tokens: Option<u64>,
    pub compaction_trigger_tokens: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Resume {
    /// 审批处理完毕后继续
    Approval,
    /// 上次运行中断后从已保存的进度继续
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Job {
    Message { text: String, images: Vec<String> },
    Resume(Resume),
}

impl Job {
    fn reason(&self) -> &'static str {
        match self {
            Job::Message { .. } => "message",
            Job::Resume(Resume::Approval) => "approval",
            Job::Resume(Resume::Interrupted) => "interrupted",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct JobSpec {
    pub root_path: String,
    pub session_id: String,
    pub provider: ProviderInput,
    /// Legacy-only auth for recorded yunxiao tools. New calls resolve connections instead.
    pub yunxiao: Option<crate::yunxiao::YunxiaoAuth>,
    pub connections: Vec<crate::integrations::ports::Connection>,
    pub requirement_label: String,
    pub requirement_dir: String,
    pub job: Job,
}

/// 推送给界面的运行事件（字段名为 snake_case，与会话文件保持一致）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Event {
    RunStarted {
        reason: String,
    },
    Round {
        round: usize,
        context_tokens: u64,
        trigger_tokens: u64,
    },
    Text {
        delta: String,
    },
    Reasoning {
        chars: usize,
    },
    ToolArgs {
        name: String,
        chars: usize,
    },
    ToolStarted {
        id: String,
        name: String,
        detail: String,
    },
    ToolFinished {
        id: String,
        name: String,
        ok: bool,
    },
    Approval {
        approval: AiApproval,
    },
    Compacting {
        part: Option<usize>,
        total: Option<usize>,
    },
    Message {
        message: AiSessionMessage,
    },
    RunFinished {
        status: String,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamingTool {
    pub name: String,
    pub chars: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolLive {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub started_ms: i64,
}

/// 运行中的实时状态（供快照与界面展示，由事件逐条累积）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct LiveState {
    pub seq: u64,
    pub reason: String,
    pub round: usize,
    pub phase: String,
    pub text: String,
    pub reasoning_chars: usize,
    pub streaming_tool: Option<StreamingTool>,
    pub tool: Option<ToolLive>,
    pub compact_part: Option<usize>,
    pub compact_total: Option<usize>,
    pub approval_name: String,
    pub context_tokens: u64,
    pub trigger_tokens: u64,
    pub stopping: bool,
}

impl LiveState {
    fn apply(&mut self, event: &Event) {
        match event {
            Event::RunStarted { .. } => self.phase = "model".to_string(),
            Event::Round {
                round,
                context_tokens,
                trigger_tokens,
            } => {
                self.round = *round;
                self.phase = "model".to_string();
                self.text.clear();
                self.reasoning_chars = 0;
                self.streaming_tool = None;
                self.tool = None;
                self.compact_part = None;
                self.compact_total = None;
                self.context_tokens = *context_tokens;
                self.trigger_tokens = *trigger_tokens;
            }
            Event::Text { delta } => self.text.push_str(delta),
            Event::Reasoning { chars } => self.reasoning_chars += *chars,
            Event::ToolArgs { name, chars } => {
                self.streaming_tool = Some(StreamingTool {
                    name: name.clone(),
                    chars: *chars,
                })
            }
            Event::ToolStarted { id, name, detail } => {
                self.phase = "tool".to_string();
                self.text.clear();
                self.streaming_tool = None;
                self.tool = Some(ToolLive {
                    id: id.clone(),
                    name: name.clone(),
                    detail: detail.clone(),
                    started_ms: now_ms(),
                });
            }
            Event::ToolFinished { .. } => self.tool = None,
            Event::Approval { approval } => {
                self.phase = "approval".to_string();
                self.approval_name = approval.tool.clone();
            }
            Event::Compacting { part, total } => {
                self.phase = "compacting".to_string();
                self.compact_part = *part;
                self.compact_total = *total;
            }
            Event::Message { .. } => {}
            Event::RunFinished { status, .. } => {
                self.phase = status.clone();
                self.tool = None;
                self.streaming_tool = None;
            }
        }
    }
}

pub(crate) struct ActiveRun {
    pub run_id: String,
    pub cancel: AtomicBool,
    pub live: Mutex<LiveState>,
}

impl ActiveRun {
    fn new(run_id: String, reason: &str) -> Self {
        Self {
            run_id,
            cancel: AtomicBool::new(false),
            live: Mutex::new(LiveState {
                reason: reason.to_string(),
                ..Default::default()
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSnapshot {
    pub busy: bool,
    pub run_id: Option<String>,
    pub live: Option<LiveState>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDecision {
    pub approval: AiApproval,
    pub run_id: Option<String>,
}

/// 客户端工具请求（后端 → 界面）。
#[derive(Debug, Clone, Serialize)]
pub struct ClientRequest {
    pub request_id: String,
    pub session_id: String,
    pub run_id: String,
    pub kind: String,
    pub payload: Value,
}

type PendingMap = HashMap<String, (ClientRequest, oneshot::Sender<Result<Value, String>>)>;

#[derive(Default)]
pub(crate) struct ClientHub {
    pending: Mutex<PendingMap>,
}

impl ClientHub {
    fn lock(&self) -> MutexGuard<'_, PendingMap> {
        self.pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// 发出请求并等待界面回填；运行被停止时立即返回取消。
    pub(crate) async fn request(
        &self,
        sink: &dyn Sink,
        session_id: &str,
        run_id: &str,
        kind: &str,
        payload: Value,
        cancel: &AtomicBool,
    ) -> Result<Value, String> {
        let request = ClientRequest {
            request_id: format!("client-{}", next_id()),
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            payload,
        };
        let request_id = request.request_id.clone();
        let (sender, mut receiver) = oneshot::channel();
        self.lock()
            .insert(request_id.clone(), (request.clone(), sender));
        sink.emit(
            CLIENT_EVENT_NAME,
            serde_json::to_value(&request).unwrap_or(Value::Null),
        );
        let deadline = Instant::now() + CLIENT_TIMEOUT;
        loop {
            if cancel.load(Ordering::SeqCst) {
                self.lock().remove(&request_id);
                return Err(RUN_CANCELLED.to_string());
            }
            if let Ok(received) = tokio::time::timeout(CLIENT_POLL, &mut receiver).await {
                return received.unwrap_or_else(|_| Err("客户端工具通道已关闭".to_string()));
            }
            if Instant::now() >= deadline {
                self.lock().remove(&request_id);
                return Err("界面长时间没有响应，本次工具调用已放弃，请重试".to_string());
            }
        }
    }

    pub(crate) fn respond(&self, request_id: &str, result: Result<Value, String>) -> bool {
        let entry = self.lock().remove(request_id);
        entry.map_or(false, |(_, sender)| sender.send(result).is_ok())
    }

    pub(crate) fn pending(&self, session_id: Option<&str>) -> Vec<ClientRequest> {
        let mut items: Vec<ClientRequest> = self
            .lock()
            .values()
            .map(|(request, _)| request.clone())
            .filter(|request| session_id.map_or(true, |id| request.session_id == id))
            .collect();
        items.sort_by(|a, b| a.request_id.cmp(&b.request_id));
        items
    }
}

pub struct Runtime {
    sink: Arc<dyn Sink>,
    active: Mutex<HashMap<String, Arc<ActiveRun>>>,
    client: ClientHub,
}

/// Tauri 托管的运行时句柄：应用存续期间一直存在，界面刷新不影响其中的运行。
pub struct AgentState(Arc<Runtime>);

impl AgentState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let sink: Arc<dyn Sink> = Arc::new(app);
        Self(Arc::new(Runtime::new(sink)))
    }

    pub(crate) fn with_idle<T>(
        &self,
        session_id: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.0.with_idle(session_id, action)
    }
}

impl Runtime {
    pub(crate) fn new(sink: Arc<dyn Sink>) -> Self {
        Self {
            sink,
            active: Mutex::new(HashMap::new()),
            client: ClientHub::default(),
        }
    }

    fn lock_active(&self) -> MutexGuard<'_, HashMap<String, Arc<ActiveRun>>> {
        self.active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    #[cfg(test)]
    pub fn is_busy(&self, session_id: &str) -> bool {
        self.lock_active().contains_key(session_id)
    }

    pub fn active_sessions(&self) -> Vec<String> {
        self.lock_active().keys().cloned().collect()
    }

    pub(crate) fn with_idle<T>(
        &self,
        session_id: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let active = self.lock_active();
        if active.contains_key(session_id) {
            return Err(BUSY_MESSAGE.to_string());
        }
        action()
    }

    /// 启动一次运行；会话正在运行时返回错误（用户消息不排队）。
    pub fn start(self: &Arc<Self>, spec: JobSpec) -> Result<String, String> {
        self.kick(spec)?.ok_or_else(|| BUSY_MESSAGE.to_string())
    }

    /// 尝试启动一次运行：会话忙时返回 `Ok(None)`，由正在进行的运行在结束时自行续跑。
    pub fn kick(self: &Arc<Self>, spec: JobSpec) -> Result<Option<String>, String> {
        let (root, _config) = crate::workspace::load_initialized_workspace(&spec.root_path)?;
        let mut active = self.lock_active();
        if active.contains_key(&spec.session_id) {
            return Ok(None);
        }
        if crate::sessions::load_session(&root, &spec.session_id)?.archived {
            return Err(ARCHIVED_MESSAGE.to_string());
        }
        let run = Arc::new(ActiveRun::new(new_run_id(), spec.job.reason()));
        let run_id = run.run_id.clone();
        active.insert(spec.session_id.clone(), Arc::clone(&run));
        drop(active);
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move { runtime.execute(spec, run).await });
        Ok(Some(run_id))
    }

    /// 执行一个运行；正常完成且存在待续跑的审批时，在同一个会话槽位内接着执行续跑。
    async fn execute(self: Arc<Self>, mut spec: JobSpec, mut run: Arc<ActiveRun>) {
        loop {
            let result = match run::RunCtx::new(Arc::clone(&self), Arc::clone(&run), spec.clone()) {
                Ok(mut ctx) => run::execute_job(&mut ctx).await,
                Err(error) => Err(error),
            };
            let (status, error) = match result {
                Ok(run::Status::Completed) => ("completed", None),
                Ok(run::Status::Stopped) => ("stopped", None),
                Err(error) => ("failed", Some(error)),
            };
            self.publish(
                &run,
                &spec.session_id,
                Event::RunFinished {
                    status: status.to_string(),
                    error,
                },
            );
            let next = {
                let mut active = self.lock_active();
                if status == "completed" && run::follow_up_needed(&spec.root_path, &spec.session_id)
                {
                    let next = Arc::new(ActiveRun::new(new_run_id(), "approval"));
                    active.insert(spec.session_id.clone(), Arc::clone(&next));
                    Some(next)
                } else {
                    active.remove(&spec.session_id);
                    None
                }
            };
            match next {
                Some(next) => {
                    run = next;
                    spec.job = Job::Resume(Resume::Approval);
                }
                None => return,
            }
        }
    }

    pub(crate) fn publish(&self, run: &ActiveRun, session_id: &str, event: Event) {
        let seq = {
            let mut live = run.live.lock().unwrap_or_else(|poison| poison.into_inner());
            live.seq += 1;
            live.apply(&event);
            live.seq
        };
        self.emit_payload(session_id, &run.run_id, seq, &event);
    }

    /// 与运行无关的会话事件（如审批决定），run_id 为空。
    pub(crate) fn publish_session(&self, session_id: &str, event: Event) {
        self.emit_payload(session_id, "", 0, &event);
    }

    fn emit_payload(&self, session_id: &str, run_id: &str, seq: u64, event: &Event) {
        let mut payload = serde_json::to_value(event).unwrap_or_else(|_| json!({}));
        payload["session_id"] = json!(session_id);
        payload["run_id"] = json!(run_id);
        payload["seq"] = json!(seq);
        self.sink.emit(EVENT_NAME, payload);
    }

    pub fn snapshot(&self, session_id: &str) -> AgentSnapshot {
        let run = self.lock_active().get(session_id).cloned();
        match run {
            Some(run) => AgentSnapshot {
                busy: true,
                run_id: Some(run.run_id.clone()),
                live: Some(
                    run.live
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .clone(),
                ),
            },
            None => AgentSnapshot {
                busy: false,
                run_id: None,
                live: None,
            },
        }
    }

    /// 请求停止：设置取消标记，并取消正在进行的模型请求与摘要子请求。
    pub fn stop(&self, session_id: &str) -> bool {
        let run = self.lock_active().get(session_id).cloned();
        let Some(run) = run else {
            return false;
        };
        run.cancel.store(true, Ordering::SeqCst);
        run.live
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .stopping = true;
        crate::llm::cancel_ai_session_run(run.run_id.clone());
        true
    }
}

fn job_spec(
    root_path: String,
    session_id: String,
    provider: ProviderInput,
    yunxiao: Option<crate::yunxiao::YunxiaoAuth>,
    connections: Option<Vec<crate::integrations::ports::Connection>>,
    requirement_label: String,
    requirement_dir: String,
    job: Job,
) -> JobSpec {
    JobSpec {
        root_path,
        session_id,
        provider,
        yunxiao,
        connections: connections.unwrap_or_default(),
        requirement_label,
        requirement_dir,
        job,
    }
}

#[tauri::command]
pub async fn agent_start_turn(
    state: State<'_, AgentState>,
    root_path: String,
    session_id: String,
    text: String,
    images: Vec<String>,
    provider: ProviderInput,
    yunxiao: Option<crate::yunxiao::YunxiaoAuth>,
    connections: Option<Vec<crate::integrations::ports::Connection>>,
    requirement_label: String,
    requirement_dir: String,
) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() && images.is_empty() {
        return Err("消息不能为空".to_string());
    }
    state.0.start(job_spec(
        root_path,
        session_id,
        provider,
        yunxiao,
        connections,
        requirement_label,
        requirement_dir,
        Job::Message { text, images },
    ))
}

#[tauri::command]
pub async fn agent_resume(
    state: State<'_, AgentState>,
    root_path: String,
    session_id: String,
    reason: String,
    provider: ProviderInput,
    yunxiao: Option<crate::yunxiao::YunxiaoAuth>,
    connections: Option<Vec<crate::integrations::ports::Connection>>,
    requirement_label: String,
    requirement_dir: String,
) -> Result<String, String> {
    let resume = match reason.as_str() {
        "approval" => Resume::Approval,
        "interrupted" => Resume::Interrupted,
        _ => return Err("未知的续跑原因".to_string()),
    };
    state.0.start(job_spec(
        root_path,
        session_id,
        provider,
        yunxiao,
        connections,
        requirement_label,
        requirement_dir,
        Job::Resume(resume),
    ))
}

/// 记录审批决定；会话空闲时立即启动续跑（执行已批准的操作，并在没有待审批项时继续模型）。
#[tauri::command]
pub async fn agent_decide(
    state: State<'_, AgentState>,
    root_path: String,
    session_id: String,
    approval_id: String,
    approved: bool,
    provider: ProviderInput,
    yunxiao: Option<crate::yunxiao::YunxiaoAuth>,
    connections: Option<Vec<crate::integrations::ports::Connection>>,
    requirement_label: String,
    requirement_dir: String,
) -> Result<AgentDecision, String> {
    let (root, _config) = crate::workspace::load_initialized_workspace(&root_path)?;
    if crate::sessions::load_session(&root, &session_id)?.archived {
        return Err(ARCHIVED_MESSAGE.to_string());
    }
    let approval = run::decide(&state.0, &root_path, &session_id, &approval_id, approved)?;
    let run_id = state.0.kick(job_spec(
        root_path,
        session_id,
        provider,
        yunxiao,
        connections,
        requirement_label,
        requirement_dir,
        Job::Resume(Resume::Approval),
    ))?;
    Ok(AgentDecision { approval, run_id })
}

#[tauri::command]
pub fn agent_stop(state: State<'_, AgentState>, session_id: String) -> bool {
    state.0.stop(&session_id)
}

#[tauri::command]
pub fn agent_snapshot(state: State<'_, AgentState>, session_id: String) -> AgentSnapshot {
    state.0.snapshot(&session_id)
}

#[tauri::command]
pub fn agent_active_sessions(state: State<'_, AgentState>) -> Vec<String> {
    state.0.active_sessions()
}

#[tauri::command]
pub fn agent_pending_client_requests(
    state: State<'_, AgentState>,
    session_id: Option<String>,
) -> Vec<ClientRequest> {
    state.0.client.pending(session_id.as_deref())
}

#[tauri::command]
pub fn agent_respond_client_tool(
    state: State<'_, AgentState>,
    request_id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> bool {
    let outcome = if ok {
        Ok(result.unwrap_or(Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "客户端工具执行失败".to_string()))
    };
    state.0.client.respond(&request_id, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{create_ai_session, set_archived_at};

    struct SilentSink;

    impl Sink for SilentSink {
        fn emit(&self, _name: &str, _payload: Value) {}
    }

    fn runtime() -> Arc<Runtime> {
        Arc::new(Runtime::new(Arc::new(SilentSink)))
    }

    #[test]
    fn running_session_blocks_archive_and_delete_until_it_finishes() {
        let rt = runtime();
        rt.lock_active().insert(
            "session-a".to_string(),
            Arc::new(ActiveRun::new("run-1".to_string(), "message")),
        );
        assert_eq!(
            rt.with_idle("session-a", || Ok(1)).unwrap_err(),
            BUSY_MESSAGE
        );
        assert_eq!(rt.with_idle("session-b", || Ok(2)).unwrap(), 2);
        rt.lock_active().remove("session-a");
        assert_eq!(rt.with_idle("session-a", || Ok(3)).unwrap(), 3);
    }

    #[test]
    fn archived_session_refuses_to_start_a_run() {
        let root =
            std::env::temp_dir().join(format!("blackbox-agent-archive-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        crate::workspace::init_fixture_workspace(root_path.clone(), "归档测试".to_string())
            .unwrap();
        let session = create_ai_session(
            root_path.clone(),
            "归档会话".to_string(),
            None,
            None,
            "plan".to_string(),
        )
        .unwrap();
        set_archived_at(&root, &session.id, true).unwrap();
        let spec = JobSpec {
            root_path: root_path.clone(),
            session_id: session.id.clone(),
            provider: ProviderInput::default(),
            yunxiao: None,
            connections: Vec::new(),
            requirement_label: String::new(),
            requirement_dir: String::new(),
            job: Job::Message {
                text: "继续".to_string(),
                images: Vec::new(),
            },
        };
        assert_eq!(runtime().kick(spec).unwrap_err(), ARCHIVED_MESSAGE);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
