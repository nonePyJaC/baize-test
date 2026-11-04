//! 需求会话：一个需求可以有多个 AI 会话，会话内容持久化在工作区 `.blackbox/sessions/<会话ID>/`。
//!
//! 会话只保存对话与元数据（标题、关联需求、权限模式、归档状态）。
//! 会话中的文件修改不经过本模块：由受控工具层按权限模式执行并记录到消息中。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent::AgentState;
use crate::workspace::{chrono_now, load_initialized_workspace, write_internal_text_file};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AiSession {
    pub id: String,
    pub title: String,
    pub platform_id: Option<String>,
    pub requirement_id: Option<String>,
    pub permission_mode: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<AiSessionMessage>,
    pub approvals: Vec<AiApproval>,
    pub memory: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AiSessionMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    /// 工具调用记录：工具名、参数摘要、结果摘要、审批结果
    pub tool_calls: Vec<serde_json::Value>,
    /// 随消息附带的图片文件名（存放在会话的 attachments 目录下）
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AiApproval {
    pub id: String,
    pub status: String,
    pub tool_call_id: String,
    pub tool: String,
    pub arguments: serde_json::Value,
    pub paths: Vec<String>,
    pub reason: String,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub run_id: Option<String>,
    /// 审批结果是否已经通知过模型（旧数据视为已通知，避免续跑时误触发）
    #[serde(default = "notified_default")]
    pub notified: bool,
}

fn notified_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSessionSummary {
    pub id: String,
    pub title: String,
    pub platform_id: Option<String>,
    pub requirement_id: Option<String>,
    pub permission_mode: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
}

const PERMISSION_MODES: &[&str] = &["code", "smart", "ask", "plan", "bypass"];

static SESSION_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn write_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    SESSION_WRITE_LOCK
        .lock()
        .map_err(|_| "会话写入锁不可用".to_string())
}

pub(crate) fn sessions_dir(root: &Path) -> PathBuf {
    root.join(".blackbox").join("sessions")
}

/// 会话消息附带的图片目录（会话内部文件，删除会话时一并清除）。
fn session_attachments_dir(root: &Path, session_id: &str) -> PathBuf {
    sessions_dir(root).join(session_id).join("attachments")
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;

fn validate_image_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err("图片附件名不合法".to_string());
    }
    Ok(trimmed)
}

fn image_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

/// 保存粘贴的图片到会话附件目录，返回附件文件名。
#[tauri::command]
pub fn save_ai_session_image(
    root_path: String,
    session_id: String,
    content_base64: String,
    extension: String,
) -> Result<String, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    if !session_path(&root, &id).exists() {
        return Err(format!("会话不存在：{session_id}"));
    }
    let ext = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("不支持的图片格式：{extension}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64.trim())
        .map_err(|error| format!("图片数据无效：{error}"))?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if bytes.len() > IMAGE_MAX_BYTES {
        return Err("图片超过 10MB 上限".to_string());
    }
    let dir = session_attachments_dir(&root, &id);
    fs::create_dir_all(&dir).map_err(|error| format!("创建附件目录失败：{error}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let name = (0..100)
        .map(|index| format!("paste-{stamp}-{index}.{ext}"))
        .find(|candidate| !dir.join(candidate).exists())
        .ok_or_else(|| "附件文件名冲突".to_string())?;
    fs::write(dir.join(&name), &bytes).map_err(|error| format!("保存图片失败：{error}"))?;
    Ok(name)
}

/// 读取会话附件（图片）为 base64，供界面展示历史消息中的图片。
#[tauri::command]
pub fn read_ai_session_attachment(
    root_path: String,
    session_id: String,
    name: String,
) -> Result<Option<String>, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    let name = validate_image_name(&name)?;
    let path = session_attachments_dir(&root, &id).join(name);
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取附件失败：{error}")),
    }
}

/// 运行期间把附件文件名解析成 data URL，注入模型消息。
pub(crate) fn session_image_data_urls(
    root: &Path,
    session_id: &str,
    names: &[String],
) -> Result<Vec<String>, String> {
    let dir = session_attachments_dir(root, session_id);
    names
        .iter()
        .map(|name| {
            let name = validate_image_name(name)?;
            let bytes = fs::read(dir.join(name)).map_err(|_| format!("图片附件不存在：{name}"))?;
            Ok(format!(
                "data:{};base64,{}",
                image_mime(name),
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        })
        .collect()
}

/// 缺陷提交的不确定态回执：提交请求发出前写 pending，成功后写 submitted。
/// 超时或中断时保留 pending，提示先核对远端是否已创建，避免盲目重复提交。
fn pending_defect_path(root: &Path, id: &str) -> PathBuf {
    sessions_dir(root).join(id).join("pending-defect.json")
}

pub(crate) fn load_pending_defect(
    root: &Path,
    session_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let id = validate_session_id(session_id)?;
    match fs::read_to_string(pending_defect_path(root, &id)) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("缺陷提交回执不是有效JSON：{e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取缺陷提交回执失败：{error}")),
    }
}

pub(crate) fn save_pending_defect(
    root: &Path,
    session_id: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let id = validate_session_id(session_id)?;
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_internal_text_file(&pending_defect_path(root, &id), text)
}

fn validate_session_id(value: &str) -> Result<String, String> {
    let id = value.trim();
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("会话ID只能使用字母、数字、短横线和下划线".to_string());
    }
    Ok(id.to_string())
}

fn validate_permission_mode(value: &str) -> Result<String, String> {
    let mode = value.trim();
    if PERMISSION_MODES.contains(&mode) {
        Ok(mode.to_string())
    } else {
        Err(format!("权限模式只能是：{}", PERMISSION_MODES.join("、")))
    }
}

fn session_path(root: &Path, id: &str) -> PathBuf {
    sessions_dir(root).join(id).join("session.json")
}

fn read_session(path: &Path) -> Result<AiSession, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("会话文件不是有效JSON：{}", e))
}

fn write_session(path: &Path, session: &AiSession) -> Result<(), String> {
    let text = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    write_internal_text_file(path, text)
}

fn summarize(session: &AiSession) -> AiSessionSummary {
    AiSessionSummary {
        id: session.id.clone(),
        title: session.title.clone(),
        platform_id: session.platform_id.clone(),
        requirement_id: session.requirement_id.clone(),
        permission_mode: session.permission_mode.clone(),
        archived: session.archived,
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        message_count: session.messages.len(),
    }
}

fn new_session_id(root: &Path) -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut candidate = format!("session-{stamp}");
    let mut index = 2;
    while session_path(root, &candidate).exists() {
        candidate = format!("session-{stamp}-{index}");
        index += 1;
    }
    candidate
}

#[tauri::command]
pub fn list_ai_sessions(root_path: String) -> Result<Vec<AiSessionSummary>, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let dir = sessions_dir(&root);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut sessions = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| read_session(&entry.path().join("session.json")).ok())
        .map(|session| summarize(&session))
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub fn create_ai_session(
    root_path: String,
    title: String,
    platform_id: Option<String>,
    requirement_id: Option<String>,
    permission_mode: String,
) -> Result<AiSession, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let now = chrono_now();
    let id = new_session_id(&root);
    let session = AiSession {
        id: id.clone(),
        title: normalize_title(&title),
        platform_id: normalize_optional(platform_id),
        requirement_id: normalize_optional(requirement_id),
        permission_mode: validate_permission_mode(&permission_mode)?,
        archived: false,
        created_at: now.clone(),
        updated_at: now,
        messages: Vec::new(),
        approvals: Vec::new(),
        memory: serde_json::Value::Null,
    };
    write_session(&session_path(&root, &id), &session)?;
    Ok(session)
}

pub(crate) fn load_session(root: &Path, session_id: &str) -> Result<AiSession, String> {
    let id = validate_session_id(session_id)?;
    read_session(&session_path(root, &id))
}

#[tauri::command]
pub fn read_ai_session(root_path: String, session_id: String) -> Result<AiSession, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    load_session(&root, &session_id)
}

/// 更新会话元数据：标题、关联需求、权限模式。归档由 `set_ai_session_archived` 处理。消息通过 `append_ai_session_message` 追加。
#[tauri::command]
pub fn update_ai_session(
    root_path: String,
    session_id: String,
    title: Option<String>,
    platform_id: Option<Option<String>>,
    requirement_id: Option<Option<String>>,
    permission_mode: Option<String>,
) -> Result<AiSession, String> {
    let _guard = write_guard()?;
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    let path = session_path(&root, &id);
    let mut session = read_session(&path)?;
    if let Some(title) = title {
        session.title = normalize_title(&title);
    }
    if let Some(platform_id) = platform_id {
        session.platform_id = normalize_optional(platform_id);
    }
    if let Some(requirement_id) = requirement_id {
        session.requirement_id = normalize_optional(requirement_id);
    }
    if let Some(mode) = permission_mode {
        session.permission_mode = validate_permission_mode(&mode)?;
    }
    session.updated_at = chrono_now();
    write_session(&path, &session)?;
    Ok(session)
}

pub(crate) fn set_archived_at(
    root: &Path,
    session_id: &str,
    archived: bool,
) -> Result<AiSession, String> {
    let _guard = write_guard()?;
    let id = validate_session_id(session_id)?;
    let path = session_path(root, &id);
    let mut session = read_session(&path)?;
    session.archived = archived;
    session.updated_at = chrono_now();
    write_session(&path, &session)?;
    Ok(session)
}

#[tauri::command]
pub fn set_ai_session_archived(
    state: State<'_, AgentState>,
    root_path: String,
    session_id: String,
    archived: bool,
) -> Result<AiSession, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    state.with_idle(&id, || set_archived_at(&root, &id, archived))
}

pub(crate) fn delete_at(root: &Path, session_id: &str) -> Result<(), String> {
    let _guard = write_guard()?;
    let id = validate_session_id(session_id)?;
    let dir = sessions_dir(root).join(&id);
    if !dir.is_dir() {
        return Err("会话不存在".to_string());
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_ai_session(
    state: State<'_, AgentState>,
    root_path: String,
    session_id: String,
) -> Result<(), String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    state.with_idle(&id, || delete_at(&root, &id))
}

#[tauri::command]
pub fn update_ai_session_memory(
    root_path: String,
    session_id: String,
    memory: serde_json::Value,
) -> Result<AiSession, String> {
    let _guard = write_guard()?;
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    let path = session_path(&root, &id);
    let mut session = read_session(&path)?;
    if memory.to_string().len() > 200_000 {
        return Err("会话记忆超过 200KB 上限".to_string());
    }
    session.memory = memory;
    session.updated_at = chrono_now();
    write_session(&path, &session)?;
    Ok(session)
}

#[tauri::command]
pub fn append_ai_session_message(
    root_path: String,
    session_id: String,
    message: AiSessionMessage,
) -> Result<AiSession, String> {
    let _guard = write_guard()?;
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    let path = session_path(&root, &id);
    let mut session = read_session(&path)?;
    if !matches!(
        message.role.as_str(),
        "user" | "assistant" | "system" | "tool"
    ) {
        return Err("消息角色只能是 user、assistant、system 或 tool".to_string());
    }
    let mut message = message;
    if message.id.trim().is_empty() {
        message.id = format!("msg-{}", session.messages.len() + 1);
    }
    if message.created_at.trim().is_empty() {
        message.created_at = chrono_now();
    }
    session.messages.push(message);
    session.updated_at = chrono_now();
    write_session(&path, &session)?;
    Ok(session)
}

fn normalize_title(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "新会话".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

const APPROVABLE_TOOLS: &[&str] = &[
    "create_file",
    "update_file",
    "create_directory",
    "delete_path",
    "move_path",
    "write_xmind",
    "add_questions",
    "yunxiao_create_testcase",
    "yunxiao_create_directory",
];

#[tauri::command]
pub fn request_ai_approval(
    root_path: String,
    session_id: String,
    tool_call_id: String,
    tool: String,
    arguments: serde_json::Value,
    paths: Vec<String>,
    reason: String,
    run_id: Option<String>,
) -> Result<AiApproval, String> {
    let _guard = write_guard()?;
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    let path = session_path(&root, &id);
    let mut session = read_session(&path)?;
    if !APPROVABLE_TOOLS.contains(&tool.as_str()) {
        return Err("只能为受控写入工具申请审批".to_string());
    }
    let now = chrono_now();
    let approval = AiApproval {
        id: format!("apr-{}", session.approvals.len() + 1),
        status: "pending".to_string(),
        tool_call_id,
        tool,
        arguments,
        paths,
        reason: reason.trim().chars().take(200).collect(),
        created_at: now.clone(),
        decided_at: None,
        run_id: normalize_optional(run_id),
        notified: false,
    };
    session.approvals.push(approval.clone());
    session.updated_at = now;
    write_session(&path, &session)?;
    Ok(approval)
}

#[tauri::command]
pub fn decide_ai_approval(
    root_path: String,
    session_id: String,
    approval_id: String,
    approved: bool,
) -> Result<AiApproval, String> {
    let _guard = write_guard()?;
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let id = validate_session_id(&session_id)?;
    let path = session_path(&root, &id);
    let mut session = read_session(&path)?;
    let now = chrono_now();
    let approval = session
        .approvals
        .iter_mut()
        .find(|item| item.id == approval_id)
        .ok_or("审批记录不存在")?;
    if approval.status != "pending" {
        return Err("该审批已处理".to_string());
    }
    approval.status = if approved { "approved" } else { "rejected" }.to_string();
    approval.decided_at = Some(now.clone());
    let decided = approval.clone();
    session.updated_at = now;
    write_session(&path, &session)?;
    Ok(decided)
}

pub(crate) fn consume_approval(
    root: &Path,
    session_id: &str,
    approval_id: &str,
) -> Result<(), String> {
    let _guard = write_guard()?;
    let id = validate_session_id(session_id)?;
    let path = session_path(root, &id);
    let mut session = read_session(&path)?;
    if let Some(item) = session
        .approvals
        .iter_mut()
        .find(|item| item.id == approval_id && item.status == "approved")
    {
        item.status = "consumed".to_string();
        session.updated_at = chrono_now();
        write_session(&path, &session)?;
    }
    Ok(())
}

pub(crate) fn mark_approvals_notified(root: &Path, session_id: &str) -> Result<(), String> {
    let _guard = write_guard()?;
    let id = validate_session_id(session_id)?;
    let path = session_path(root, &id);
    let mut session = read_session(&path)?;
    let mut changed = false;
    for item in session
        .approvals
        .iter_mut()
        .filter(|item| item.status != "pending" && !item.notified)
    {
        item.notified = true;
        changed = true;
    }
    if changed {
        session.updated_at = chrono_now();
        write_session(&path, &session)?;
    }
    Ok(())
}

pub(crate) fn find_approval(
    root: &Path,
    session_id: &str,
    approval_id: &str,
) -> Result<AiApproval, String> {
    load_session(root, session_id)?
        .approvals
        .into_iter()
        .find(|item| item.id == approval_id)
        .ok_or_else(|| "审批记录不存在".to_string())
}

pub(crate) fn take_approval(
    root: &Path,
    session_id: &str,
    approval_id: &str,
    expected_tool: &str,
    expected_path: Option<&str>,
) -> Result<AiApproval, String> {
    let _guard = write_guard()?;
    let id = validate_session_id(session_id)?;
    let path = session_path(root, &id);
    let mut session = read_session(&path)?;
    let approval = session
        .approvals
        .iter_mut()
        .find(|item| item.id == approval_id)
        .ok_or("审批记录不存在")?;
    if approval.status != "approved" {
        return Err("该操作尚未获得用户批准，或已经执行过".to_string());
    }
    let path_matches = expected_path.map_or(true, |expected| {
        approval.paths.first().map(String::as_str) == Some(expected)
    });
    if approval.tool != expected_tool || !path_matches {
        return Err("审批内容与待执行操作不一致".to_string());
    }
    approval.status = "consumed".to_string();
    let taken = approval.clone();
    session.updated_at = chrono_now();
    write_session(&path, &session)?;
    Ok(taken)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_rejects_path_characters() {
        assert!(validate_session_id("session-20260101-000000").is_ok());
        assert!(validate_session_id("../escape").is_err());
        assert!(validate_session_id("a/b").is_err());
        assert!(validate_session_id("").is_err());
    }

    #[test]
    fn permission_mode_is_limited_to_known_modes() {
        assert!(validate_permission_mode("ask").is_ok());
        assert!(validate_permission_mode("bypass").is_ok());
        assert!(validate_permission_mode("yolo").is_err());
    }

    #[test]
    fn empty_title_gets_default_name() {
        assert_eq!(normalize_title("   "), "新会话");
        assert_eq!(normalize_title(" 示例平台维修单 "), "示例平台维修单");
    }

    #[test]
    fn archived_sessions_stay_listed_and_delete_removes_only_that_session() {
        let root =
            std::env::temp_dir().join(format!("blackbox-sessions-archive-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        crate::workspace::init_workspace(root_path.clone(), "会话测试".to_string()).unwrap();
        let keep = create_ai_session(
            root_path.clone(),
            "保留".to_string(),
            None,
            None,
            "plan".to_string(),
        )
        .unwrap();
        let gone = create_ai_session(
            root_path.clone(),
            "删除".to_string(),
            None,
            None,
            "plan".to_string(),
        )
        .unwrap();
        assert!(set_archived_at(&root, &gone.id, true).unwrap().archived);
        let listed = list_ai_sessions(root_path.clone()).unwrap();
        assert!(listed
            .iter()
            .any(|item| item.id == gone.id && item.archived));
        assert!(!set_archived_at(&root, &keep.id, false).unwrap().archived);
        delete_at(&root, &gone.id).unwrap();
        assert!(!sessions_dir(&root).join(&gone.id).exists());
        assert!(sessions_dir(&root)
            .join(&keep.id)
            .join("session.json")
            .is_file());
        assert!(delete_at(&root, &gone.id).is_err());
        assert!(delete_at(&root, "../escape").is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
