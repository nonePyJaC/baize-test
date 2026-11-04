//! AI 会话的受控工具层：模型只能通过这里读写工作区文件。
//!
//! 读取范围为整个工作区（不含 `.blackbox`）。写入、删除、移动只能发生在会话关联需求目录下的
//! 02/03/04/07/08 标准目录中，01/05/06 只读。所有写操作都经过 `ensure_ai_write_allowed`：
//! 先做范围与结构校验，再复用 workspace 的需求锁与受管子树检查。07/08 下的报告与知识候选
//! 不套用受管子树规则，改由结构化文件名黑名单约束。不走 `write_ai_task_outputs` 这类任务产物内部写入。

use base64::Engine;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use crate::sessions::{find_approval, load_session, take_approval, AiSession};
use crate::workspace::{
    chrono_now, ensure_client_write_allowed, ensure_not_managed_path, load_initialized_workspace,
    path_starts_with_ignore_case, standard_requirement_directories, write_atomic_bytes,
    write_internal_text_file, WorkspaceConfig,
};

pub mod journal;
mod lifecycle;

use self::journal::{journaled, validate_run_id, RunScope};

const MAX_TEXT_BYTES: usize = 512 * 1024;
const WRITE_TOOLS: &[&str] = &[
    "create_file",
    "update_file",
    "create_directory",
    "delete_path",
    "move_path",
    "add_questions",
    "update_coverage",
];
const WRITABLE_DIRS: &[&str] = &[
    "02-需求理解与答疑",
    "03-测试计划",
    "04-测试用例",
    "07-测试报告",
    "08-知识候选",
];
const REPORT_AND_KNOWLEDGE_DIRS: &[&str] = &["07-测试报告", "08-知识候选"];
const PROTECTED_FILE_NAMES: &[&str] = &[
    "requirement.yaml",
    "activity.json",
    "activity.corrupt.json",
    "cases.json",
    "questions.json",
    "knowledge.json",
    "knowledge-candidates.json",
    "report.json",
    "run.json",
    "manifest.json",
    "progress.json",
    "result.json",
    "coverage.json",
    "case-events.json",
];
const XMIND_DIR: &str = "04-测试用例";
const XMIND_MAX_BYTES: usize = 20 * 1024 * 1024;
const APPROVAL_REQUIRED: &str = "APPROVAL_REQUIRED:";
const XMIND_AUTHORIZATION_HINT: &str = "APPROVAL_REQUIRED:删除或移动 XMind 测试用例需要用户授权";
const BINARY_EXTENSIONS: &[&str] = &[
    "xmind", "docx", "xlsx", "pptx", "pdf", "zip", "png", "jpg", "jpeg", "gif", "webp",
];

#[derive(Debug, Clone, Serialize)]
pub struct AiToolResult {
    pub tool: String,
    pub output: serde_json::Value,
    pub changed_paths: Vec<String>,
}

#[derive(Deserialize)]
struct PathArgs {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
struct ContentArgs {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct MoveArgs {
    from: String,
    to: String,
}

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
struct DirEntryItem {
    is_file: bool,
    name: String,
    path: String,
    size: u64,
}

fn parse_args<T: DeserializeOwned>(arguments: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(arguments).map_err(|e| format!("工具参数不正确：{}", e))
}

/// codex-skills 是工作区旁边的独立资料仓库（需求、接口、联调文档），AI 通过 codex-skills/ 前缀只读访问。
fn codex_skills_root(root: &Path) -> PathBuf {
    root.parent().unwrap_or(root).join("codex-skills")
}

fn relative_text(root: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(root) {
        return rel.to_string_lossy().replace('\\', "/");
    }
    if let Ok(rel) = path.strip_prefix(codex_skills_root(root)) {
        return format!("codex-skills/{}", rel.to_string_lossy().replace('\\', "/"));
    }
    path.to_string_lossy().replace('\\', "/")
}

fn resolve_workspace_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = relative.trim().replace('\\', "/");
    if normalized.contains(':') {
        return Err("只能使用工作区内的相对路径".to_string());
    }
    let mut components = Path::new(&normalized).components().peekable();
    let mut base = root.to_path_buf();
    if matches!(components.peek(), Some(Component::Normal(name)) if name.eq_ignore_ascii_case("codex-skills"))
    {
        components.next();
        base = codex_skills_root(root);
        if !base.is_dir() {
            return Err("codex-skills 目录不存在（应是工作区旁边的独立资料库）".to_string());
        }
    }
    let mut target = base.clone();
    for component in components {
        match component {
            Component::Normal(name) if name.eq_ignore_ascii_case(".blackbox") => {
                return Err(".blackbox 协议目录由客户端内部管理".to_string());
            }
            Component::Normal(name) => target.push(name),
            Component::CurDir => {}
            _ => return Err("只能使用工作区内的相对路径，不能包含 .. 或绝对路径".to_string()),
        }
    }
    if target.as_path() == root {
        return Err("请指定工作区内的具体文件或目录".to_string());
    }
    ensure_within_root(&base, &target)?;
    Ok(target)
}

fn ensure_within_root(root: &Path, target: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut existing = target;
    while !existing.exists() {
        existing = existing.parent().ok_or("路径无效")?;
    }
    if existing
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        Ok(())
    } else {
        Err("路径超出工作区范围".to_string())
    }
}

fn mode_allows_writes(mode: &str) -> bool {
    matches!(mode, "code" | "smart" | "bypass")
}

fn session_requirement_dir(
    root: &Path,
    config: &WorkspaceConfig,
    session: &AiSession,
) -> Result<PathBuf, String> {
    let requirement_id = session
        .requirement_id
        .as_deref()
        .ok_or("未关联需求的会话只读，请先为会话关联需求")?;
    if requirement_id.is_empty()
        || requirement_id.contains(['/', '\\', ':'])
        || matches!(requirement_id, "." | "..")
    {
        return Err("会话关联的需求编号不合法".to_string());
    }
    let mut dirs = config
        .platforms
        .iter()
        .filter(|platform| {
            session
                .platform_id
                .as_deref()
                .map_or(true, |id| platform.id == id)
        })
        .map(|platform| root.join(&platform.path).join(requirement_id))
        .filter(|dir| dir.join("requirement.yaml").is_file())
        .collect::<Vec<_>>();
    match dirs.len() {
        1 => Ok(dirs.remove(0)),
        0 => Err("未找到会话关联的需求目录".to_string()),
        _ => Err("该需求编号存在于多个平台，无法确定写入目录".to_string()),
    }
}

fn ensure_session_can_write(session: &AiSession) -> Result<(), String> {
    match session.permission_mode.as_str() {
        "ask" => Err(format!("{}写入文件需要用户逐次审批", APPROVAL_REQUIRED)),
        mode if mode_allows_writes(mode) => Ok(()),
        mode => Err(format!("当前权限模式「{}」不允许写入文件（只读）", mode)),
    }
}

fn ensure_approved_session(session: &AiSession) -> Result<(), String> {
    if session.permission_mode == "plan" {
        return Err("计划模式为只读，不能执行写入审批".to_string());
    }
    Ok(())
}

fn is_xmind_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("xmind"))
}

fn contains_xmind(path: &Path) -> bool {
    if is_xmind_file(path) {
        return true;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::read_dir(path)
            .map(|entries| entries.flatten().any(|entry| contains_xmind(&entry.path())))
            .unwrap_or(false),
        _ => false,
    }
}

fn is_binary_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    BINARY_EXTENSIONS.contains(&extension.as_str())
}

fn is_change_record_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    CHANGE_RECORD_SUFFIXES.iter().any(|suffix| {
        name.len() >= suffix.len()
            && name.as_bytes()[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
    })
}

fn ensure_ai_write_allowed(
    requirement_dir: &Path,
    path: &Path,
    content: Option<&[u8]>,
) -> Result<(), String> {
    if is_change_record_file(path) {
        return Err("XMind 修改记录由 write_xmind 维护，AI 不能直接写入、删除或移动".to_string());
    }
    ensure_ai_write_gate(requirement_dir, path, content)
}

fn ensure_ai_write_gate(
    requirement_dir: &Path,
    path: &Path,
    content: Option<&[u8]>,
) -> Result<(), String> {
    let rel = path
        .strip_prefix(requirement_dir)
        .map_err(|_| "AI 只能操作会话关联需求目录内的文件".to_string())?;
    let Some(Component::Normal(top)) = rel.components().next() else {
        return Err("不能直接操作需求根目录".to_string());
    };
    let top = top.to_string_lossy();
    if !WRITABLE_DIRS
        .iter()
        .any(|dir| top.eq_ignore_ascii_case(dir))
    {
        return Err(format!(
            "AI 只能写入 {} 下的文件，01/05/06 为只读",
            WRITABLE_DIRS.join("、")
        ));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if path.components().any(|p| p.as_os_str() == "integrations") {
        return Err("集成映射、迁移备份和发布回执由客户端受控命令维护".into());
    }
    if name.ends_with(".decisions.json") {
        return Err("评审处理记录由客户端人工确认维护".into());
    }
    if name.starts_with("revision-proposal-") && name.ends_with(".json") {
        if path.exists() {
            return Err("既有修订提案只读；请新增唯一ID的提案版本".into());
        }
        if let Some(bytes) = content {
            let value: serde_json::Value =
                serde_json::from_slice(bytes).map_err(|e| format!("提案JSON无效：{e}"))?;
            if !value["proposal_id"].is_string()
                || !value["requirement_id"].is_string()
                || !value["platform_id"].is_string()
                || !value["items"].as_array().is_some_and(|a| !a.is_empty())
            {
                return Err("提案缺少ID、平台、需求或items".into());
            }
            let mut ids = HashSet::new();
            for item in value["items"].as_array().unwrap() {
                if !item["item_id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && ids.insert(id))
                    || !item["target_case_id"].is_string()
                    || item["status"] != "pending"
                    || !item["reason"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty())
                    || !item["source_refs"]
                        .as_array()
                        .is_some_and(|a| !a.is_empty())
                {
                    return Err("提案条目必须有唯一ID、稳定用例ID、原因、来源和pending状态".into());
                }
            }
        }
    }
    if name.starts_with("knowledge-proposal-") && name.ends_with(".json") {
        if path.exists() {
            return Err("既有知识提案只读，请使用新ID".into());
        }
        if let Some(bytes) = content {
            let value: serde_json::Value =
                serde_json::from_slice(bytes).map_err(|e| format!("知识提案JSON无效：{e}"))?;
            let items = value["candidates"]
                .as_array()
                .ok_or("知识提案缺少candidates")?;
            if value["registry_type"] != "candidate" {
                return Err("知识只能写candidate提案".into());
            }
            for item in items {
                if !item["source_refs"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
                    || !item["evidence_status"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
                    || item.get("rule_diff").is_none()
                    || item.get("applicable_scope").is_none()
                {
                    return Err(
                        "每条知识需source_refs、evidence_status、rule_diff、applicable_scope"
                            .into(),
                    );
                }
            }
        }
    }
    if PROTECTED_FILE_NAMES
        .iter()
        .any(|protected| name.eq_ignore_ascii_case(protected))
    {
        return Err(format!("{} 由客户端业务流程管理，AI 不能修改", name));
    }
    if content.is_some() && is_binary_file(path) {
        return Err(if is_xmind_file(path) {
            "XMind 文件请使用 write_xmind 工具生成或重新生成".to_string()
        } else {
            "二进制文件不能通过 AI 文本工具写入".to_string()
        });
    }
    if content.is_some_and(|bytes| bytes.len() > MAX_TEXT_BYTES) {
        return Err("单次写入内容超过 512KB 上限".to_string());
    }
    if !REPORT_AND_KNOWLEDGE_DIRS
        .iter()
        .any(|dir| top.eq_ignore_ascii_case(dir))
    {
        ensure_not_managed_path(path)?;
    }
    ensure_client_write_allowed(path, content)
}

fn ensure_not_standard_structure(requirement_dir: &Path, path: &Path) -> Result<(), String> {
    let rel = relative_text(requirement_dir, path);
    let is_structure = standard_requirement_directories()
        .iter()
        .any(|dir| path_starts_with_ignore_case(&dir.to_string_lossy().replace('\\', "/"), &rel));
    if is_structure {
        return Err("标准目录结构不能删除、改名或移动".to_string());
    }
    Ok(())
}

fn ensure_move_allowed(requirement_dir: &Path, from: &Path, to: &Path) -> Result<(), String> {
    ensure_ai_write_allowed(requirement_dir, from, None)?;
    ensure_ai_write_allowed(requirement_dir, to, None)?;
    if fs::symlink_metadata(from)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
            ensure_move_allowed(requirement_dir, &entry.path(), &to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn list_directory(root: &Path, path: &str) -> Result<serde_json::Value, String> {
    let dir = match path.trim() {
        "" | "." => root.to_path_buf(),
        relative => resolve_workspace_path(root, relative)?,
    };
    if !dir.is_dir() {
        return Err(format!("目录不存在：{}", path));
    }
    let mut entries = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| !entry.file_name().eq_ignore_ascii_case(".blackbox"))
        .map(|entry| DirEntryItem {
            is_file: entry.path().is_file(),
            name: entry.file_name().to_string_lossy().to_string(),
            path: relative_text(root, &entry.path()),
            size: entry.metadata().map(|meta| meta.len()).unwrap_or(0),
        })
        .collect::<Vec<_>>();
    entries.sort();
    Ok(serde_json::json!({ "path": relative_text(root, &dir), "entries": entries }))
}

fn read_file(root: &Path, path: &str) -> Result<serde_json::Value, String> {
    let target = resolve_workspace_path(root, path)?;
    if !target.is_file() {
        return Err(format!("文件不存在：{}", path));
    }
    if target.metadata().map_err(|e| e.to_string())?.len() > MAX_TEXT_BYTES as u64 {
        return Err("文件超过 512KB，不能整体读取".to_string());
    }
    let content =
        fs::read_to_string(&target).map_err(|e| format!("文件不是 UTF-8 文本，无法读取：{}", e))?;
    Ok(serde_json::json!({ "path": relative_text(root, &target), "content": content }))
}

fn create_file(
    root: &Path,
    requirement_dir: &Path,
    args: ContentArgs,
    scope: Option<RunScope>,
) -> Result<String, String> {
    let target = resolve_workspace_path(root, &args.path)?;
    ensure_ai_write_allowed(requirement_dir, &target, Some(args.content.as_bytes()))?;
    if target.exists() {
        return Err("目标文件已存在，AI 不能直接覆盖；请使用 update_file 修改".to_string());
    }
    journaled(scope, "create", &target, None, || {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
        if let Err(error) = file
            .write_all(args.content.as_bytes())
            .and_then(|_| file.sync_all())
        {
            let _ = fs::remove_file(&target);
            return Err(error.to_string());
        }
        Ok(())
    })?;
    Ok(relative_text(root, &target))
}

fn update_file(
    root: &Path,
    requirement_dir: &Path,
    args: ContentArgs,
    scope: Option<RunScope>,
) -> Result<String, String> {
    let target = resolve_workspace_path(root, &args.path)?;
    ensure_ai_write_allowed(requirement_dir, &target, Some(args.content.as_bytes()))?;
    if !target.is_file() {
        return Err("目标文件不存在，请使用 create_file 新建".to_string());
    }
    journaled(scope, "write", &target, None, || {
        write_internal_text_file(&target, args.content)
    })?;
    Ok(relative_text(root, &target))
}

fn create_directory(
    root: &Path,
    requirement_dir: &Path,
    path: &str,
    scope: Option<RunScope>,
) -> Result<String, String> {
    let target = resolve_workspace_path(root, path)?;
    ensure_ai_write_allowed(requirement_dir, &target, None)?;
    journaled(scope, "mkdir", &target, None, || {
        fs::create_dir_all(&target).map_err(|e| e.to_string())
    })?;
    Ok(relative_text(root, &target))
}

fn delete_path(
    root: &Path,
    requirement_dir: &Path,
    path: &str,
    authorized: bool,
    scope: Option<RunScope>,
) -> Result<String, String> {
    let target = resolve_workspace_path(root, path)?;
    ensure_ai_write_allowed(requirement_dir, &target, None)?;
    ensure_not_standard_structure(requirement_dir, &target)?;
    if is_xmind_file(&target) && !authorized {
        return Err(XMIND_AUTHORIZATION_HINT.to_string());
    }
    let metadata = fs::symlink_metadata(&target).map_err(|_| format!("目标不存在：{}", path))?;
    journaled(scope, "delete", &target, None, || {
        if metadata.is_dir() {
            if fs::read_dir(&target)
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
            {
                return Err("目录不为空，请先删除其中的文件".to_string());
            }
            fs::remove_dir(&target).map_err(|e| e.to_string())
        } else {
            fs::remove_file(&target).map_err(|e| e.to_string())
        }
    })?;
    Ok(relative_text(root, &target))
}

fn move_path(
    root: &Path,
    requirement_dir: &Path,
    args: MoveArgs,
    authorized: bool,
    scope: Option<RunScope>,
) -> Result<(String, String), String> {
    let from = resolve_workspace_path(root, &args.from)?;
    let to = resolve_workspace_path(root, &args.to)?;
    fs::symlink_metadata(&from).map_err(|_| format!("源目标不存在：{}", args.from))?;
    if fs::symlink_metadata(&to).is_ok() {
        return Err(format!("目标已存在，禁止覆盖：{}", args.to));
    }
    if to.starts_with(&from) {
        return Err("不能把文件夹移动到它自己内部".to_string());
    }
    ensure_not_standard_structure(requirement_dir, &from)?;
    ensure_move_allowed(requirement_dir, &from, &to)?;
    if contains_xmind(&from) && !authorized {
        return Err(XMIND_AUTHORIZATION_HINT.to_string());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    journaled(scope, "move", &to, Some(&from), || {
        fs::rename(&from, &to).map_err(|e| e.to_string())
    })?;
    Ok((relative_text(root, &from), relative_text(root, &to)))
}

const QA_DIRECTORY: &str = "02-需求理解与答疑";
const QUESTIONS_FILE: &str = "questions.json";
const QUESTIONS_PER_CALL: usize = 50;
const QUESTION_MAX_CHARS: usize = 1000;
const PLAN_DIRECTORY: &str = "03-测试计划";
const COVERAGE_FILE: &str = "coverage.json";
const COVERAGE_PER_CALL: usize = 100;

#[derive(Deserialize)]
struct QuestionsArgs {
    questions: Vec<QuestionInput>,
}

#[derive(Deserialize)]
struct QuestionInput {
    question: String,
    priority: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    impact: Vec<String>,
    #[serde(default)]
    source: Option<String>,
}

fn question_number(id: &str) -> Option<u32> {
    id.strip_prefix("Q-")?.parse().ok()
}

/// 只追加疑问：编号接在已有最大编号之后；已有条目（包括人工答复）保持不变；问题文本与已有条目相同的跳过。
fn add_questions(
    root: &Path,
    requirement_dir: &Path,
    requirement_id: &str,
    arguments: serde_json::Value,
    scope: Option<RunScope>,
) -> Result<(serde_json::Value, Vec<String>), String> {
    let args: QuestionsArgs = parse_args(arguments)?;
    if args.questions.is_empty() || args.questions.len() > QUESTIONS_PER_CALL {
        return Err(format!("每次追加 1 至 {} 条疑问", QUESTIONS_PER_CALL));
    }
    let target = requirement_dir.join(QA_DIRECTORY).join(QUESTIONS_FILE);
    let existed = target.is_file();
    let mut document = if existed {
        let text = fs::read_to_string(&target).map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            format!(
                "questions.json 不是有效的 JSON，已停止追加，请人工检查：{}",
                e
            )
        })?;
        if !value["questions"].is_array() {
            return Err("questions.json 缺少 questions 数组，已停止追加，请人工检查".to_string());
        }
        value
    } else {
        serde_json::json!({ "version": "1.0", "requirement_id": requirement_id, "questions": [] })
    };
    let existing = document["questions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut texts: HashSet<String> = existing
        .iter()
        .filter_map(|item| item["question"].as_str())
        .map(|text| text.trim().to_string())
        .collect();
    let mut next = existing
        .iter()
        .filter_map(|item| item["id"].as_str().and_then(question_number))
        .max()
        .unwrap_or(0)
        + 1;
    let now = chrono_now();
    let mut added: Vec<String> = Vec::new();
    let mut fresh: Vec<serde_json::Value> = Vec::new();
    let mut skipped = 0usize;
    for (index, item) in args.questions.into_iter().enumerate() {
        let position = index + 1;
        let text = item.question.trim().to_string();
        if text.is_empty() {
            return Err(format!("第 {} 条疑问的内容不能为空", position));
        }
        if text.chars().count() > QUESTION_MAX_CHARS {
            return Err(format!(
                "第 {} 条疑问超过 {} 字",
                position, QUESTION_MAX_CHARS
            ));
        }
        if !matches!(item.priority.as_str(), "P0" | "P1" | "P2") {
            return Err(format!("第 {} 条疑问的优先级必须是 P0、P1 或 P2", position));
        }
        if !texts.insert(text.clone()) {
            skipped += 1;
            continue;
        }
        let id = format!("Q-{:02}", next);
        next += 1;
        let impact: Vec<String> = item
            .impact
            .iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .take(10)
            .collect();
        let source = item
            .source
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        fresh.push(serde_json::json!({
            "id": id,
            "question": text,
            "priority": item.priority,
            "category": item.category.trim().chars().take(60).collect::<String>(),
            "status": "pending",
            "owner": null,
            "source": source,
            "impact": impact,
            "answer": null,
            "answer_format": "markdown",
            "attachments": [],
            "created_at": now,
            "answered_at": null,
            "version": 1,
        }));
        added.push(id);
    }
    let relative = relative_text(root, &target);
    let output = serde_json::json!({
        "path": relative,
        "added": added,
        "skipped_duplicates": skipped,
    });
    if fresh.is_empty() {
        return Ok((output, Vec::new()));
    }
    if let Some(list) = document["questions"].as_array_mut() {
        list.extend(fresh);
    }
    let content = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    ensure_client_write_allowed(&target, Some(content.as_bytes()))?;
    let operation = if existed { "write" } else { "create" };
    journaled(scope, operation, &target, None, || {
        write_internal_text_file(&target, content)
    })?;
    Ok((output, vec![relative]))
}

#[derive(Deserialize)]
struct CoverageArgs {
    items: Vec<CoverageInput>,
}

#[derive(Deserialize)]
struct CoverageInput {
    #[serde(rename = "ref")]
    reference: String,
    #[serde(default)]
    kind: String,
    title: String,
    #[serde(default)]
    source: String,
    coverage: String,
    #[serde(default)]
    cases: Vec<String>,
    #[serde(default)]
    note: String,
}

fn coverage_number(id: &str) -> Option<u32> {
    id.strip_prefix("COV-")?.parse().ok()
}

fn trimmed(value: &str, max: usize, field: &str) -> Result<String, String> {
    let text = value.trim().to_string();
    if text.chars().count() > max {
        return Err(format!("覆盖项{}超过 {} 字", field, max));
    }
    Ok(text)
}

/// 覆盖追溯矩阵：AI 登记/更新覆盖项，按 ref 匹配去重。
/// 豁免（exempt）只能由人在「覆盖追溯」页面确认：AI 不能把任何条目标记为 exempt，
/// 已豁免条目保留豁免状态，仅更新描述与关联用例等字段。
fn update_coverage(
    root: &Path,
    requirement_dir: &Path,
    requirement_id: &str,
    arguments: serde_json::Value,
    scope: Option<RunScope>,
) -> Result<(serde_json::Value, Vec<String>), String> {
    let args: CoverageArgs = parse_args(arguments)?;
    if args.items.is_empty() || args.items.len() > COVERAGE_PER_CALL {
        return Err(format!("每次更新 1 至 {} 条覆盖项", COVERAGE_PER_CALL));
    }
    let target = requirement_dir.join(PLAN_DIRECTORY).join(COVERAGE_FILE);
    let existed = target.is_file();
    let mut document = if existed {
        let text = fs::read_to_string(&target).map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            format!(
                "coverage.json 不是有效的 JSON，已停止更新，请人工检查：{}",
                e
            )
        })?;
        if !value["items"].is_array() {
            return Err("coverage.json 缺少 items 数组，已停止更新，请人工检查".to_string());
        }
        value
    } else {
        serde_json::json!({ "version": "1.0", "requirement_id": requirement_id, "items": [] })
    };
    let items = document["items"].as_array().cloned().unwrap_or_default();
    let mut next = items
        .iter()
        .filter_map(|item| item["id"].as_str().and_then(coverage_number))
        .max()
        .unwrap_or(0)
        + 1;
    let now = chrono_now();
    let mut added: Vec<String> = Vec::new();
    let mut updated: Vec<String> = Vec::new();
    let mut exempt_kept = 0usize;
    let mut merged = items;
    for (index, item) in args.items.into_iter().enumerate() {
        let position = index + 1;
        let reference = trimmed(&item.reference, 120, "ref")
            .map_err(|e| format!("第 {} 条：{}", position, e))?;
        if reference.is_empty() {
            return Err(format!("第 {} 条覆盖项的 ref 不能为空", position));
        }
        let title =
            trimmed(&item.title, 200, "title").map_err(|e| format!("第 {} 条：{}", position, e))?;
        if title.is_empty() {
            return Err(format!("第 {} 条覆盖项的 title 不能为空", position));
        }
        let kind_raw =
            trimmed(&item.kind, 20, "kind").map_err(|e| format!("第 {} 条：{}", position, e))?;
        let kind = match kind_raw.as_str() {
            "task" | "interface" | "rule" | "shared_surface" | "other" => kind_raw,
            "" => "other".to_string(),
            other => return Err(format!("第 {} 条覆盖项的 kind 无效：{}", position, other)),
        };
        let source = trimmed(&item.source, 300, "source")
            .map_err(|e| format!("第 {} 条：{}", position, e))?;
        let coverage = trimmed(&item.coverage, 20, "coverage")?;
        if !matches!(coverage.as_str(), "covered" | "partial" | "none") {
            return Err(format!(
                "第 {} 条覆盖项的 coverage 只能是 covered、partial 或 none；豁免标记只能由人在「覆盖追溯」页确认",
                position
            ));
        }
        if item.cases.len() > 20 {
            return Err(format!("第 {} 条覆盖项最多关联 20 条用例", position));
        }
        let cases: Vec<String> = item
            .cases
            .iter()
            .map(|value| trimmed(value, 300, "cases").unwrap_or_default())
            .filter(|value| !value.is_empty())
            .collect();
        let note =
            trimmed(&item.note, 500, "note").map_err(|e| format!("第 {} 条：{}", position, e))?;
        let existing_index = merged.iter().position(|entry| {
            entry["ref"]
                .as_str()
                .map(|text| text.trim().eq_ignore_ascii_case(&reference))
                .unwrap_or(false)
        });
        if let Some(at) = existing_index {
            let entry = &mut merged[at];
            let id = entry["id"].as_str().unwrap_or_default().to_string();
            let exempt = entry["coverage"].as_str() == Some("exempt");
            entry["title"] = serde_json::json!(title);
            entry["kind"] = serde_json::json!(kind);
            entry["source"] = serde_json::json!(source);
            entry["cases"] = serde_json::json!(cases);
            entry["note"] = serde_json::json!(note);
            if exempt {
                exempt_kept += 1;
            } else {
                entry["coverage"] = serde_json::json!(coverage);
            }
            entry["updated_at"] = serde_json::json!(now);
            entry["updated_by"] = serde_json::json!("ai");
            updated.push(id);
        } else {
            let id = format!("COV-{:02}", next);
            next += 1;
            merged.push(serde_json::json!({
                "id": id,
                "ref": reference,
                "kind": kind,
                "title": title,
                "source": source,
                "coverage": coverage,
                "cases": cases,
                "note": note,
                "exempt_reason": null,
                "exempt_by": null,
                "created_at": now,
                "updated_at": now,
                "updated_by": "ai",
            }));
            added.push(id);
        }
    }
    let relative = relative_text(root, &target);
    let output = serde_json::json!({
        "path": relative,
        "added": added,
        "updated": updated,
        "exempt_kept": exempt_kept,
    });
    document["items"] = serde_json::json!(merged);
    let content = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    ensure_client_write_allowed(&target, Some(content.as_bytes()))?;
    let operation = if existed { "write" } else { "create" };
    journaled(scope, operation, &target, None, || {
        write_internal_text_file(&target, content)
    })?;
    Ok((output, vec![relative]))
}

fn written(path: String) -> (serde_json::Value, Vec<String>) {
    (serde_json::json!({ "path": path }), vec![path.clone()])
}

#[tauri::command]
pub fn run_ai_session_tool(
    root_path: String,
    session_id: String,
    tool_name: String,
    arguments: serde_json::Value,
    run_id: Option<String>,
) -> Result<AiToolResult, String> {
    let (root, config) = load_initialized_workspace(&root_path)?;
    let session = load_session(&root, &session_id)?;
    if WRITE_TOOLS.contains(&tool_name.as_str()) {
        session_requirement_dir(&root, &config, &session)?;
        ensure_session_can_write(&session)?;
    }
    if let Some(id) = run_id.as_deref() {
        validate_run_id(id)?;
    }
    execute_session_tool(
        &root,
        &config,
        &session,
        &tool_name,
        arguments,
        false,
        run_id.as_deref(),
    )
}

#[tauri::command]
pub fn run_approved_ai_session_tool(
    root_path: String,
    session_id: String,
    approval_id: String,
) -> Result<AiToolResult, String> {
    let (root, config) = load_initialized_workspace(&root_path)?;
    let session = load_session(&root, &session_id)?;
    ensure_approved_session(&session)?;
    let approval = find_approval(&root, &session_id, &approval_id)?;
    if approval.tool == "write_xmind" {
        return Err("XMind 审批请通过写入流程执行".to_string());
    }
    let approval = take_approval(&root, &session_id, &approval_id, &approval.tool, None)?;
    execute_session_tool(
        &root,
        &config,
        &session,
        &approval.tool,
        approval.arguments,
        true,
        approval.run_id.as_deref(),
    )
}

fn execute_session_tool(
    root: &Path,
    config: &WorkspaceConfig,
    session: &AiSession,
    tool_name: &str,
    arguments: serde_json::Value,
    authorized: bool,
    run_id: Option<&str>,
) -> Result<AiToolResult, String> {
    let requirement_dir = || session_requirement_dir(root, config, session);
    let scope = run_id.map(|run_id| RunScope {
        root,
        session_id: session.id.as_str(),
        run_id,
    });
    let (output, changed_paths) = match tool_name {
        "read_case_lifecycle_context" => (
            lifecycle::read(root, &requirement_dir()?, &arguments)?,
            Vec::new(),
        ),
        "list_directory" => {
            let args: PathArgs = parse_args(arguments)?;
            (list_directory(&root, &args.path)?, Vec::new())
        }
        "read_file" => {
            let args: PathArgs = parse_args(arguments)?;
            (read_file(&root, &args.path)?, Vec::new())
        }
        "create_file" => written(create_file(
            &root,
            &requirement_dir()?,
            parse_args(arguments)?,
            scope,
        )?),
        "update_file" => written(update_file(
            &root,
            &requirement_dir()?,
            parse_args(arguments)?,
            scope,
        )?),
        "create_directory" => {
            let args: PathArgs = parse_args(arguments)?;
            written(create_directory(
                &root,
                &requirement_dir()?,
                &args.path,
                scope,
            )?)
        }
        "delete_path" => {
            let args: PathArgs = parse_args(arguments)?;
            written(delete_path(
                &root,
                &requirement_dir()?,
                &args.path,
                authorized,
                scope,
            )?)
        }
        "move_path" => {
            let args: MoveArgs = parse_args(arguments)?;
            let (from, to) = move_path(&root, &requirement_dir()?, args, authorized, scope)?;
            (
                serde_json::json!({ "from": from, "to": to }),
                vec![from, to],
            )
        }
        "add_questions" => add_questions(
            root,
            &requirement_dir()?,
            session.requirement_id.as_deref().unwrap_or_default(),
            arguments,
            scope,
        )?,
        "update_coverage" => update_coverage(
            root,
            &requirement_dir()?,
            session.requirement_id.as_deref().unwrap_or_default(),
            arguments,
            scope,
        )?,
        other => return Err(format!("未知工具：{}", other)),
    };
    Ok(AiToolResult {
        tool: tool_name.to_string(),
        output,
        changed_paths,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct AiSideFile {
    pub kind: String,
    pub content: String,
}

const XMIND_SIDE_FILE_MAX_BYTES: usize = 32 * 1024 * 1024;
const CHANGE_RECORD_SUFFIXES: &[&str] = &[".xmind.changes.json", ".xmind.changes.md"];

#[tauri::command]
pub fn write_ai_session_xmind(
    root_path: String,
    session_id: String,
    path: String,
    content_base64: String,
    run_id: Option<String>,
) -> Result<AiToolResult, String> {
    write_xmind_with_side_files(
        root_path,
        session_id,
        path,
        content_base64,
        Vec::new(),
        None,
        "write_xmind",
        run_id,
    )
}

#[tauri::command]
pub fn write_ai_session_xmind_with_records(
    root_path: String,
    session_id: String,
    path: String,
    content_base64: String,
    side_files: Vec<AiSideFile>,
    run_id: Option<String>,
) -> Result<AiToolResult, String> {
    write_xmind_with_side_files(
        root_path,
        session_id,
        path,
        content_base64,
        side_files,
        None,
        "write_xmind",
        run_id,
    )
}

#[tauri::command]
pub fn write_ai_session_xmind_approved(
    root_path: String,
    session_id: String,
    approval_id: String,
    path: String,
    content_base64: String,
    side_files: Vec<AiSideFile>,
) -> Result<AiToolResult, String> {
    write_xmind_with_side_files(
        root_path,
        session_id,
        path,
        content_base64,
        side_files,
        Some(approval_id),
        "write_xmind",
        None,
    )
}

pub(crate) fn write_ai_session_xmind_approved_for_tool(
    root_path: String,
    session_id: String,
    approval_id: String,
    approval_tool: &str,
    path: String,
    content_base64: String,
    side_files: Vec<AiSideFile>,
) -> Result<AiToolResult, String> {
    write_xmind_with_side_files(
        root_path,
        session_id,
        path,
        content_base64,
        side_files,
        Some(approval_id),
        approval_tool,
        None,
    )
}

fn write_xmind_with_side_files(
    root_path: String,
    session_id: String,
    path: String,
    content_base64: String,
    side_files: Vec<AiSideFile>,
    approval_id: Option<String>,
    approval_tool: &str,
    run_id: Option<String>,
) -> Result<AiToolResult, String> {
    let (root, config) = load_initialized_workspace(&root_path)?;
    let session = load_session(&root, &session_id)?;
    let requirement_dir = session_requirement_dir(&root, &config, &session)?;
    if approval_id.is_some() {
        ensure_approved_session(&session)?;
    } else {
        ensure_session_can_write(&session)?;
    }
    let target = resolve_workspace_path(&root, &path)?;
    if !is_xmind_file(&target) {
        return Err("write_xmind 只能写入 .xmind 文件".to_string());
    }
    ensure_ai_write_allowed(&requirement_dir, &target, None)?;
    let in_test_case_dir = target
        .strip_prefix(&requirement_dir)
        .ok()
        .and_then(|rel| rel.components().next())
        .is_some_and(
            |top| matches!(top, Component::Normal(name) if name.eq_ignore_ascii_case(XMIND_DIR)),
        );
    if !in_test_case_dir {
        return Err(format!("XMind 测试用例只能写入 {XMIND_DIR} 目录"));
    }
    if target.is_dir() {
        return Err("目标是文件夹，无法写入 XMind".to_string());
    }
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let mut sidecars = Vec::new();
    for side in &side_files {
        let suffix = match side.kind.as_str() {
            "changes_json" => "changes.json",
            "changes_md" => "changes.md",
            _ => return Err("不支持的 XMind 旁路文件类型".to_string()),
        };
        if side.content.len() > XMIND_SIDE_FILE_MAX_BYTES {
            return Err("XMind 修改记录超过 32MB 上限".to_string());
        }
        let sidecar = target.with_file_name(format!("{file_name}.{suffix}"));
        ensure_ai_write_gate(&requirement_dir, &sidecar, None)?;
        sidecars.push((sidecar, side.content.clone()));
    }
    let existed = target.is_file();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64.trim())
        .map_err(|_| "XMind 内容不是有效的 base64".to_string())?;
    if bytes.len() > XMIND_MAX_BYTES {
        return Err("XMind 文件超过 20MB 上限".to_string());
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err("内容不是有效的 XMind 压缩包".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let approval_run = match approval_id.as_deref() {
        Some(id) => {
            take_approval(&root, &session_id, id, approval_tool, Some(path.as_str()))?.run_id
        }
        None => None,
    };
    let run_id = approval_run.or(run_id);
    if let Some(id) = run_id.as_deref() {
        validate_run_id(id)?;
    }
    let scope = run_id.as_deref().map(|run_id| RunScope {
        root: root.as_path(),
        session_id: session_id.as_str(),
        run_id,
    });
    journaled(scope, "write", &target, None, || {
        write_atomic_bytes(&target, &bytes)
    })?;
    let mut changed_paths = vec![relative_text(&root, &target)];
    for (sidecar, content) in sidecars {
        journaled(scope, "write", &sidecar, None, || {
            write_atomic_bytes(&sidecar, content.as_bytes())
        })
        .map_err(|error| format!("XMind 已写入，但修改记录写入失败：{error}"))?;
        changed_paths.push(relative_text(&root, &sidecar));
    }
    Ok(AiToolResult {
        tool: "write_xmind".to_string(),
        output: serde_json::json!({
            "path": changed_paths[0],
            "action": if existed { "updated" } else { "created" },
            "bytes": bytes.len(),
        }),
        changed_paths,
    })
}

#[tauri::command]
pub fn read_ai_session_xmind(root_path: String, path: String) -> Result<Option<String>, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let target = resolve_workspace_path(&root, &path)?;
    if !is_xmind_file(&target) {
        return Err("只能读取 .xmind 文件".to_string());
    }
    let metadata = match target.metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Err(format!("目标不是文件：{}", path));
    }
    if metadata.len() > XMIND_MAX_BYTES as u64 {
        return Err("XMind 文件超过 20MB 上限".to_string());
    }
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

const AI_DOCUMENT_MAX_BYTES: u64 = 20 * 1024 * 1024;

#[tauri::command]
pub fn read_ai_session_file(root_path: String, path: String) -> Result<Option<String>, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let target = resolve_workspace_path(&root, &path)?;
    let metadata = match target.metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Err(format!("目标不是文件：{}", path));
    }
    if metadata.len() > AI_DOCUMENT_MAX_BYTES {
        return Err("文件超过 20MB，AI 不能读取".to_string());
    }
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::create_ai_session;
    use crate::workspace::{
        create_requirement, init_fixture_workspace, lock_requirement, RequirementDraft,
    };
    use serde_json::json;

    const REQUIREMENT: &str = "projects/示例平台/AI-1001";

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn ai_session_file_reads_stay_inside_workspace() {
        use base64::Engine;
        let (root, root_path) = setup("blackbox-client-ai-file-read-test");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/说明.docx"), b"PK\x03\x04doc").unwrap();
        let encoded = read_ai_session_file(root_path.clone(), "docs/说明.docx".to_string())
            .unwrap()
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            b"PK\x03\x04doc"
        );
        assert!(
            read_ai_session_file(root_path.clone(), "docs/缺失.docx".to_string())
                .unwrap()
                .is_none()
        );
        assert!(read_ai_session_file(root_path.clone(), "docs".to_string()).is_err());
        assert!(
            read_ai_session_file(root_path.clone(), ".blackbox/workspace.yaml".to_string())
                .is_err()
        );
        assert!(read_ai_session_file(root_path.clone(), "../escape.docx".to_string()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_session_reads_reach_codex_skills_but_writes_do_not() {
        use base64::Engine;
        let (root, root_path) = setup("blackbox-client-ai-codex-skills-test");
        let skills_root = root.parent().unwrap().join("codex-skills");
        let _ = fs::remove_dir_all(&skills_root);
        let docs = skills_root.join("business/AI-1001");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("接口文档.md"), "接口字段说明").unwrap();

        let encoded = read_ai_session_file(
            root_path.clone(),
            "codex-skills/business/AI-1001/接口文档.md".to_string(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap()
            )
            .unwrap(),
            "接口字段说明"
        );
        assert!(
            read_ai_session_file(root_path.clone(), "codex-skills/../secret.txt".to_string())
                .is_err()
        );

        let code = session(&root_path, "资料只读", true, "code");
        let listing = in_run(
            &root_path,
            &code,
            "run-skills",
            "list_directory",
            json!({ "path": "codex-skills/business" }),
        )
        .unwrap();
        let entry = &listing.output["entries"][0];
        assert_eq!(entry["name"], "AI-1001");
        assert_eq!(entry["path"], "codex-skills/business/AI-1001");

        let error = in_run(
            &root_path,
            &code,
            "run-skills",
            "create_file",
            json!({ "path": "codex-skills/business/AI-1001/新文件.md", "content": "x" }),
        )
        .unwrap_err();
        assert!(error.contains("只能操作会话关联需求目录"), "{error}");

        fs::remove_dir_all(&skills_root).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    use super::journal::{apply_ai_session_restore, list_ai_session_runs, plan_ai_session_restore};

    fn in_run(
        root_path: &str,
        session_id: &str,
        run_id: &str,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<AiToolResult, String> {
        run_ai_session_tool(
            root_path.to_string(),
            session_id.to_string(),
            tool.to_string(),
            arguments,
            Some(run_id.to_string()),
        )
    }

    #[test]
    fn ai_run_journal_restores_every_change() {
        let (root, root_path) = setup("blackbox-client-ai-restore-test");
        let dir = root.join(REQUIREMENT);
        let code = session(&root_path, "还原会话", true, "code");
        let plan_dir = format!("{REQUIREMENT}/03-测试计划");
        fs::create_dir_all(dir.join("03-测试计划")).unwrap();
        fs::write(dir.join("03-测试计划/旧.md"), "旧内容").unwrap();
        fs::write(dir.join("03-测试计划/待删.md"), "待删内容").unwrap();
        fs::write(dir.join("03-测试计划/待移.md"), "待移内容").unwrap();
        in_run(
            &root_path,
            &code,
            "run-a",
            "create_file",
            json!({ "path": format!("{plan_dir}/新建.md"), "content": "新内容" }),
        )
        .unwrap();
        in_run(
            &root_path,
            &code,
            "run-a",
            "update_file",
            json!({ "path": format!("{plan_dir}/旧.md"), "content": "改后" }),
        )
        .unwrap();
        in_run(
            &root_path,
            &code,
            "run-a",
            "delete_path",
            json!({ "path": format!("{plan_dir}/待删.md") }),
        )
        .unwrap();
        in_run(&root_path, &code, "run-a", "move_path", json!({ "from": format!("{plan_dir}/待移.md"), "to": format!("{plan_dir}/已移/待移.md") })).unwrap();
        in_run(
            &root_path,
            &code,
            "run-a",
            "create_directory",
            json!({ "path": format!("{plan_dir}/空目录") }),
        )
        .unwrap();

        let runs = list_ai_session_runs(root_path.clone(), code.clone()).unwrap();
        assert_eq!(runs[0].run_id, "run-a");
        assert_eq!(runs[0].changes, 5);
        assert_eq!(runs[0].pending, 5);

        let items =
            plan_ai_session_restore(root_path.clone(), code.clone(), "run-a".to_string()).unwrap();
        assert_eq!(items.len(), 5);
        assert!(items.iter().all(|item| item.status == "ready"), "{items:?}");

        let outcome =
            apply_ai_session_restore(root_path.clone(), code.clone(), "run-a".to_string()).unwrap();
        assert_eq!(outcome.restored, 5, "{:?}", outcome.items);
        assert_eq!(outcome.conflicts, 0);
        assert!(!dir.join("03-测试计划/新建.md").exists());
        assert_eq!(
            fs::read_to_string(dir.join("03-测试计划/旧.md")).unwrap(),
            "旧内容"
        );
        assert_eq!(
            fs::read_to_string(dir.join("03-测试计划/待删.md")).unwrap(),
            "待删内容"
        );
        assert_eq!(
            fs::read_to_string(dir.join("03-测试计划/待移.md")).unwrap(),
            "待移内容"
        );
        assert!(!dir.join("03-测试计划/空目录").exists());
        assert!(root
            .join(".blackbox/trash")
            .join(&code)
            .join("run-a")
            .is_dir());
        assert_eq!(
            list_ai_session_runs(root_path.clone(), code.clone()).unwrap()[0].pending,
            0
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_run_restore_refuses_paths_changed_after_the_run() {
        let (root, root_path) = setup("blackbox-client-ai-restore-conflict-test");
        let dir = root.join(REQUIREMENT);
        let code = session(&root_path, "冲突会话", true, "code");
        let draft = format!("{REQUIREMENT}/03-测试计划/草稿.md");
        fs::create_dir_all(dir.join("03-测试计划")).unwrap();
        fs::write(dir.join("03-测试计划/草稿.md"), "原文").unwrap();
        in_run(
            &root_path,
            &code,
            "run-b",
            "update_file",
            json!({ "path": draft, "content": "AI 改动" }),
        )
        .unwrap();
        fs::write(dir.join("03-测试计划/草稿.md"), "人工修改").unwrap();
        let outcome =
            apply_ai_session_restore(root_path.clone(), code.clone(), "run-b".to_string()).unwrap();
        assert_eq!(outcome.restored, 0);
        assert_eq!(outcome.conflicts, 1);
        assert_eq!(
            fs::read_to_string(dir.join("03-测试计划/草稿.md")).unwrap(),
            "人工修改"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_run_restore_keeps_change_records_and_trashes_new_xmind() {
        use base64::Engine;
        let (root, root_path) = setup("blackbox-client-ai-restore-xmind-test");
        let dir = root.join(REQUIREMENT);
        let code = session(&root_path, "XMind还原", true, "code");
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"PK\x03\x04case");
        super::write_ai_session_xmind_with_records(
            root_path.clone(),
            code.clone(),
            format!("{REQUIREMENT}/04-测试用例/登录.xmind"),
            encoded,
            vec![
                AiSideFile {
                    kind: "changes_json".to_string(),
                    content: "{}".to_string(),
                },
                AiSideFile {
                    kind: "changes_md".to_string(),
                    content: "# 变更".to_string(),
                },
            ],
            Some("run-c".to_string()),
        )
        .unwrap();
        let outcome =
            apply_ai_session_restore(root_path.clone(), code.clone(), "run-c".to_string()).unwrap();
        assert_eq!(outcome.restored, 1, "{:?}", outcome.items);
        assert_eq!(outcome.skipped, 2);
        assert!(!dir.join("04-测试用例/登录.xmind").exists());
        assert!(dir.join("04-测试用例/登录.xmind.changes.json").is_file());
        assert!(dir.join("04-测试用例/登录.xmind.changes.md").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    fn setup(name: &str) -> (PathBuf, String) {
        let root = temp_root(name);
        let root_path = root.to_string_lossy().to_string();
        init_fixture_workspace(root_path.clone(), "AI工具测试工作区".to_string()).unwrap();
        create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "AI-1001".to_string(),
                name: "AI工具测试".to_string(),
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
        (root, root_path)
    }

    fn session(root_path: &str, title: &str, linked: bool, mode: &str) -> String {
        create_ai_session(
            root_path.to_string(),
            title.to_string(),
            None,
            linked.then(|| "AI-1001".to_string()),
            mode.to_string(),
        )
        .unwrap()
        .id
    }

    fn write_ai_session_xmind(
        root_path: String,
        session_id: String,
        path: String,
        content_base64: String,
    ) -> Result<AiToolResult, String> {
        super::write_ai_session_xmind(root_path, session_id, path, content_base64, None)
    }

    fn write_ai_session_xmind_with_records(
        root_path: String,
        session_id: String,
        path: String,
        content_base64: String,
        side_files: Vec<AiSideFile>,
    ) -> Result<AiToolResult, String> {
        super::write_ai_session_xmind_with_records(
            root_path,
            session_id,
            path,
            content_base64,
            side_files,
            None,
        )
    }

    fn request_ai_approval(
        root_path: String,
        session_id: String,
        tool_call_id: String,
        tool: String,
        arguments: serde_json::Value,
        paths: Vec<String>,
        reason: String,
    ) -> Result<crate::sessions::AiApproval, String> {
        crate::sessions::request_ai_approval(
            root_path,
            session_id,
            tool_call_id,
            tool,
            arguments,
            paths,
            reason,
            None,
        )
    }

    fn call(
        root_path: &str,
        session_id: &str,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<AiToolResult, String> {
        run_ai_session_tool(
            root_path.to_string(),
            session_id.to_string(),
            tool.to_string(),
            arguments,
            None,
        )
    }

    fn create(
        root_path: &str,
        session_id: &str,
        path: &str,
        content: &str,
    ) -> Result<AiToolResult, String> {
        call(
            root_path,
            session_id,
            "create_file",
            json!({ "path": path, "content": content }),
        )
    }

    fn update(
        root_path: &str,
        session_id: &str,
        path: &str,
        content: &str,
    ) -> Result<AiToolResult, String> {
        call(
            root_path,
            session_id,
            "update_file",
            json!({ "path": path, "content": content }),
        )
    }

    fn remove(root_path: &str, session_id: &str, path: &str) -> Result<AiToolResult, String> {
        call(
            root_path,
            session_id,
            "delete_path",
            json!({ "path": path }),
        )
    }

    fn move_to(
        root_path: &str,
        session_id: &str,
        from: &str,
        to: &str,
    ) -> Result<AiToolResult, String> {
        call(
            root_path,
            session_id,
            "move_path",
            json!({ "from": from, "to": to }),
        )
    }

    #[test]
    fn resolves_only_paths_inside_workspace() {
        let root = temp_root("blackbox-client-ai-path-test");
        assert!(resolve_workspace_path(&root, "projects/示例平台/a.md").is_ok());
        assert!(resolve_workspace_path(&root, "knowledge\\示例平台\\b.md").is_ok());
        for relative in [
            "",
            ".",
            "../escape.md",
            "projects/../../escape.md",
            "/etc/passwd",
            "C:/Windows/a.md",
            ".blackbox/workspace.yaml",
            "projects/.blackbox/session.json",
        ] {
            assert!(
                resolve_workspace_path(&root, relative).is_err(),
                "{relative} should be rejected"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_writes_follow_requirement_scope_and_structure() {
        let (root, root_path) = setup("blackbox-client-ai-scope-test");
        let linked = session(&root_path, "代码会话", true, "code");
        let unlinked = session(&root_path, "无需求会话", false, "code");
        let plan = session(&root_path, "计划会话", true, "plan");
        let draft = format!("{REQUIREMENT}/03-测试计划/AI草稿.md");

        assert!(create(&root_path, &linked, &draft, "初稿").is_ok());
        assert!(update(&root_path, &linked, &draft, "修订稿").is_ok());
        assert_eq!(fs::read_to_string(root.join(&draft)).unwrap(), "修订稿");
        assert!(create(
            &root_path,
            &linked,
            &format!("{REQUIREMENT}/07-测试报告/报告.md"),
            "报告"
        )
        .is_ok());
        assert!(create(
            &root_path,
            &linked,
            &format!("{REQUIREMENT}/08-知识候选/候选.md"),
            "候选"
        )
        .is_ok());
        assert!(call(
            &root_path,
            &linked,
            "create_directory",
            json!({ "path": format!("{REQUIREMENT}/07-测试报告/第一轮") })
        )
        .is_ok());

        for path in [
            format!("{REQUIREMENT}/01-需求资料/需求文档/原始.md"),
            format!("{REQUIREMENT}/05-开发资源/前端/a.md"),
            format!("{REQUIREMENT}/06-测试执行与证据/run.md"),
            format!("{REQUIREMENT}/notes.md"),
            format!("{REQUIREMENT}/新目录/a.md"),
            "knowledge/示例平台/notes.md".to_string(),
        ] {
            assert!(
                create(&root_path, &linked, &path, "x").is_err(),
                "{path} should be rejected"
            );
        }
        for path in [
            format!("{REQUIREMENT}/07-测试报告/report.json"),
            format!("{REQUIREMENT}/08-知识候选/knowledge-candidates.json"),
            format!("{REQUIREMENT}/08-知识候选/Knowledge-Candidates.JSON"),
            format!("{REQUIREMENT}/08-知识候选/knowledge.json"),
            format!("{REQUIREMENT}/03-测试计划/requirement.yaml"),
            format!("{REQUIREMENT}/03-测试计划/activity.json"),
            format!("{REQUIREMENT}/04-测试用例/cases.json"),
            format!("{REQUIREMENT}/02-需求理解与答疑/questions.json"),
        ] {
            let error = create(&root_path, &linked, &path, "x").unwrap_err();
            assert!(error.contains("由客户端业务流程管理"), "{path}: {error}");
        }
        for path in [
            format!("{REQUIREMENT}/04-测试用例/versions/v1.json"),
            format!("{REQUIREMENT}/04-测试用例/Versions/v1.json"),
            format!("{REQUIREMENT}/04-测试用例/reviews/r1.md"),
        ] {
            let error = create(&root_path, &linked, &path, "x").unwrap_err();
            assert!(error.contains("对应业务功能管理"), "{path}: {error}");
        }
        for path in [
            format!("{REQUIREMENT}/03-测试计划/diagram.xmind"),
            "../escape.md".to_string(),
            ".blackbox/sessions/x/session.json".to_string(),
            ".BLACKBOX/sessions/x/session.json".to_string(),
        ] {
            assert!(
                create(&root_path, &linked, &path, "x").is_err(),
                "{path} should be rejected"
            );
        }

        let error = create(&root_path, &unlinked, &draft, "x").unwrap_err();
        assert!(error.contains("未关联需求"), "{error}");
        assert!(create(&root_path, &plan, &draft, "x").is_err());
        assert!(call(
            &root_path,
            &plan,
            "list_directory",
            json!({ "path": REQUIREMENT })
        )
        .is_ok());
        let listing = call(&root_path, &plan, "list_directory", json!({ "path": "" })).unwrap();
        assert!(!listing.output.to_string().contains(".blackbox"));
        assert!(call(&root_path, &unlinked, "read_file", json!({ "path": draft })).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_delete_and_move_respect_structure_and_protection() {
        let (root, root_path) = setup("blackbox-client-ai-move-test");
        let dir = root.join(REQUIREMENT);
        let code = session(&root_path, "代码会话", true, "code");

        assert!(create(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/草稿.md"),
            "x"
        )
        .is_ok());
        assert!(call(
            &root_path,
            &code,
            "create_directory",
            json!({ "path": format!("{REQUIREMENT}/03-测试计划/临时") })
        )
        .is_ok());
        assert!(remove(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/临时")
        )
        .is_ok());
        assert!(remove(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/草稿.md")
        )
        .is_ok());
        assert!(!dir.join("03-测试计划/草稿.md").exists());

        for path in [
            format!("{REQUIREMENT}/03-测试计划"),
            format!("{REQUIREMENT}/02-需求理解与答疑"),
            format!("{REQUIREMENT}/02-需求理解与答疑/attachments"),
        ] {
            let error = remove(&root_path, &code, &path).unwrap_err();
            assert!(error.contains("标准目录"), "{path}: {error}");
        }

        fs::create_dir_all(dir.join("07-测试报告/子")).unwrap();
        fs::write(dir.join("07-测试报告/子/report.md"), "报告").unwrap();
        let error =
            remove(&root_path, &code, &format!("{REQUIREMENT}/07-测试报告/子")).unwrap_err();
        assert!(error.contains("目录不为空"), "{error}");
        fs::write(dir.join("07-测试报告/子/report.json"), "{}").unwrap();
        let error = remove(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/07-测试报告/子/report.json"),
        )
        .unwrap_err();
        assert!(error.contains("由客户端业务流程管理"), "{error}");
        fs::write(dir.join("01-需求资料/需求文档/原始.md"), "客户原文").unwrap();
        assert!(remove(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/01-需求资料/需求文档/原始.md")
        )
        .is_err());
        assert!(dir.join("01-需求资料/需求文档/原始.md").is_file());

        assert!(create(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/移动稿.md"),
            "x"
        )
        .is_ok());
        let moved = move_to(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/移动稿.md"),
            &format!("{REQUIREMENT}/07-测试报告/移动稿.md"),
        )
        .unwrap();
        assert_eq!(moved.changed_paths.len(), 2);
        assert!(dir.join("07-测试报告/移动稿.md").is_file());
        assert!(!dir.join("03-测试计划/移动稿.md").exists());

        assert!(create(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/07-测试报告/已有.md"),
            "x"
        )
        .is_ok());
        assert!(create(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/占位.md"),
            "x"
        )
        .is_ok());
        let error = move_to(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/占位.md"),
            &format!("{REQUIREMENT}/07-测试报告/已有.md"),
        )
        .unwrap_err();
        assert!(error.contains("目标已存在"), "{error}");
        assert!(move_to(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/01-需求资料/需求文档/原始.md"),
            &format!("{REQUIREMENT}/03-测试计划/原始.md"),
        )
        .is_err());
        assert!(move_to(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/占位.md"),
            &format!("{REQUIREMENT}/05-开发资源/前端/占位.md"),
        )
        .is_err());
        let error = move_to(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划"),
            &format!("{REQUIREMENT}/07-测试报告/03-测试计划"),
        )
        .unwrap_err();
        assert!(error.contains("标准目录"), "{error}");

        fs::create_dir_all(dir.join("03-测试计划/子3")).unwrap();
        fs::write(dir.join("03-测试计划/子3/report.json"), "{}").unwrap();
        assert!(move_to(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/子3"),
            &format!("{REQUIREMENT}/07-测试报告/子3"),
        )
        .is_err());
        assert!(move_to(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/子3"),
            &format!("{REQUIREMENT}/03-测试计划/子3/内"),
        )
        .is_err());

        fs::create_dir_all(dir.join("03-测试计划/子4")).unwrap();
        fs::write(dir.join("03-测试计划/子4/a.md"), "x").unwrap();
        assert!(move_to(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/子4"),
            &format!("{REQUIREMENT}/07-测试报告/子4"),
        )
        .is_ok());
        assert!(dir.join("07-测试报告/子4/a.md").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_xmind_tools_follow_test_case_dir_and_authorization_rules() {
        use base64::Engine;
        let (root, root_path) = setup("blackbox-client-ai-xmind-test");
        let dir = root.join(REQUIREMENT);
        let code = session(&root_path, "代码会话", true, "code");
        let plan = session(&root_path, "计划会话", true, "plan");
        let unlinked = session(&root_path, "无需求会话", false, "code");
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let case_path = format!("{REQUIREMENT}/04-测试用例/登录用例.xmind");
        let first = b"PK\x03\x04first".to_vec();
        let second = b"PK\x03\x04second".to_vec();

        let created = write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            case_path.clone(),
            encode(&first),
        )
        .unwrap();
        assert_eq!(created.output["action"], "created");
        assert_eq!(
            fs::read(dir.join("04-测试用例/登录用例.xmind")).unwrap(),
            first
        );
        let updated = write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            case_path.clone(),
            encode(&second),
        )
        .unwrap();
        assert_eq!(updated.output["action"], "updated");
        assert_eq!(
            fs::read(dir.join("04-测试用例/登录用例.xmind")).unwrap(),
            second
        );
        let read_back = read_ai_session_xmind(root_path.clone(), case_path.clone())
            .unwrap()
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(read_back)
                .unwrap(),
            second
        );

        let error = write_ai_session_xmind(
            root_path.clone(),
            plan.clone(),
            case_path.clone(),
            encode(&first),
        )
        .unwrap_err();
        assert!(error.contains("不允许写入文件"), "{error}");
        let error = write_ai_session_xmind(
            root_path.clone(),
            unlinked.clone(),
            case_path.clone(),
            encode(&first),
        )
        .unwrap_err();
        assert!(error.contains("未关联需求"), "{error}");
        let error = write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            format!("{REQUIREMENT}/03-测试计划/登录用例.xmind"),
            encode(&first),
        )
        .unwrap_err();
        assert!(error.contains("04-测试用例"), "{error}");
        let error = write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            format!("{REQUIREMENT}/04-测试用例/登录用例.md"),
            encode(&first),
        )
        .unwrap_err();
        assert!(error.contains("只能写入 .xmind"), "{error}");
        let error = write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            case_path.clone(),
            "!!!".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("base64"), "{error}");
        let error = write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            case_path.clone(),
            encode(b"not zip"),
        )
        .unwrap_err();
        assert!(error.contains("压缩包"), "{error}");
        let error = write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            format!("{REQUIREMENT}/04-测试用例/versions/v1.xmind"),
            encode(&first),
        )
        .unwrap_err();
        assert!(error.contains("对应业务功能管理"), "{error}");
        assert!(write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            format!("{REQUIREMENT}/01-需求资料/登录用例.xmind"),
            encode(&first),
        )
        .is_err());

        let error = create(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/04-测试用例/手写.xmind"),
            "x",
        )
        .unwrap_err();
        assert!(error.contains("write_xmind"), "{error}");
        let error = remove(&root_path, &code, &case_path).unwrap_err();
        assert!(error.contains("授权"), "{error}");
        let error = move_to(
            &root_path,
            &code,
            &case_path,
            &format!("{REQUIREMENT}/03-测试计划/登录用例.xmind"),
        )
        .unwrap_err();
        assert!(error.contains("授权"), "{error}");
        assert!(dir.join("04-测试用例/登录用例.xmind").is_file());
        assert!(read_ai_session_xmind(root_path.clone(), ".blackbox/x.xmind".to_string()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_xmind_side_files_follow_guards_and_size_limit() {
        use base64::Engine;
        let (root, root_path) = setup("blackbox-client-ai-xmind-records-test");
        let dir = root.join(REQUIREMENT);
        let code = session(&root_path, "代码会话", true, "code");
        let plan = session(&root_path, "计划会话", true, "plan");
        let case_path = format!("{REQUIREMENT}/04-测试用例/登录用例.xmind");
        let package = base64::engine::general_purpose::STANDARD.encode(b"PK\x03\x04package");
        let side = |kind: &str, content: &str| AiSideFile {
            kind: kind.to_string(),
            content: content.to_string(),
        };

        assert!(read_ai_session_xmind(root_path.clone(), case_path.clone())
            .unwrap()
            .is_none());
        let written = write_ai_session_xmind_with_records(
            root_path.clone(),
            code.clone(),
            case_path.clone(),
            package.clone(),
            vec![side("changes_json", "[]"), side("changes_md", "# 修改记录")],
        )
        .unwrap();
        assert_eq!(
            written.changed_paths,
            vec![
                format!("{REQUIREMENT}/04-测试用例/登录用例.xmind"),
                format!("{REQUIREMENT}/04-测试用例/登录用例.xmind.changes.json"),
                format!("{REQUIREMENT}/04-测试用例/登录用例.xmind.changes.md"),
            ]
        );
        assert_eq!(
            fs::read_to_string(dir.join("04-测试用例/登录用例.xmind.changes.json")).unwrap(),
            "[]"
        );
        assert_eq!(
            fs::read_to_string(dir.join("04-测试用例/登录用例.xmind.changes.md")).unwrap(),
            "# 修改记录"
        );

        let error = write_ai_session_xmind_with_records(
            root_path.clone(),
            code.clone(),
            case_path.clone(),
            package.clone(),
            vec![side("other", "x")],
        )
        .unwrap_err();
        assert!(error.contains("不支持的 XMind 旁路文件类型"), "{error}");
        let oversized = "a".repeat(XMIND_SIDE_FILE_MAX_BYTES + 1);
        let error = write_ai_session_xmind_with_records(
            root_path.clone(),
            code.clone(),
            case_path.clone(),
            package.clone(),
            vec![side("changes_md", &oversized)],
        )
        .unwrap_err();
        assert!(error.contains("超过 32MB"), "{error}");
        let error = write_ai_session_xmind_with_records(
            root_path.clone(),
            plan.clone(),
            case_path.clone(),
            package.clone(),
            vec![side("changes_json", "[]")],
        )
        .unwrap_err();
        assert!(error.contains("不允许写入文件"), "{error}");
        let error = write_ai_session_xmind_with_records(
            root_path.clone(),
            code.clone(),
            format!("{REQUIREMENT}/04-测试用例/versions/v1.xmind"),
            package.clone(),
            vec![side("changes_json", "[]")],
        )
        .unwrap_err();
        assert!(error.contains("对应业务功能管理"), "{error}");
        let record = format!("{REQUIREMENT}/04-测试用例/登录用例.xmind.changes.md");
        let error = update(&root_path, &code, &record, "篡改").unwrap_err();
        assert!(error.contains("修改记录"), "{error}");
        let error = create(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/04-测试用例/其他用例.XMIND.CHANGES.JSON"),
            "[]",
        )
        .unwrap_err();
        assert!(error.contains("修改记录"), "{error}");
        let error = remove(&root_path, &code, &record).unwrap_err();
        assert!(error.contains("修改记录"), "{error}");
        let error = move_to(
            &root_path,
            &code,
            &record,
            &format!("{REQUIREMENT}/03-测试计划/登录用例.xmind.changes.md"),
        )
        .unwrap_err();
        assert!(error.contains("修改记录"), "{error}");
        assert_eq!(
            fs::read_to_string(dir.join("04-测试用例/登录用例.xmind.changes.md")).unwrap(),
            "# 修改记录"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn approval_flow_gates_ask_writes_xmind_delete_and_overwrite() {
        use crate::sessions::decide_ai_approval;
        use base64::Engine;
        let (root, root_path) = setup("blackbox-client-ai-approval-test");
        let dir = root.join(REQUIREMENT);
        let ask = session(&root_path, "询问会话", true, "ask");
        let code = session(&root_path, "代码会话", true, "code");
        let plan = session(&root_path, "计划会话", true, "plan");
        let draft = format!("{REQUIREMENT}/03-测试计划/审批草稿.md");
        let case_path = format!("{REQUIREMENT}/04-测试用例/审批用例.xmind");
        let package = base64::engine::general_purpose::STANDARD.encode(b"PK\x03\x04case");

        let error = create(&root_path, &ask, &draft, "初稿").unwrap_err();
        assert!(error.starts_with("APPROVAL_REQUIRED:"), "{error}");
        assert!(!dir.join("03-测试计划/审批草稿.md").exists());

        let approval = request_ai_approval(
            root_path.clone(),
            ask.clone(),
            "call-1".to_string(),
            "create_file".to_string(),
            json!({ "path": draft.clone(), "content": "初稿" }),
            vec![draft.clone()],
            "询问模式写入".to_string(),
        )
        .unwrap();
        assert_eq!(approval.status, "pending");
        let error =
            run_approved_ai_session_tool(root_path.clone(), ask.clone(), approval.id.clone())
                .unwrap_err();
        assert!(error.contains("尚未获得用户批准"), "{error}");
        decide_ai_approval(root_path.clone(), ask.clone(), approval.id.clone(), true).unwrap();
        let executed =
            run_approved_ai_session_tool(root_path.clone(), ask.clone(), approval.id.clone())
                .unwrap();
        assert_eq!(executed.tool, "create_file");
        assert_eq!(
            fs::read_to_string(dir.join("03-测试计划/审批草稿.md")).unwrap(),
            "初稿"
        );
        let error =
            run_approved_ai_session_tool(root_path.clone(), ask.clone(), approval.id.clone())
                .unwrap_err();
        assert!(error.contains("已经执行过"), "{error}");

        let rejected_path = format!("{REQUIREMENT}/03-测试计划/被拒.md");
        let rejected = request_ai_approval(
            root_path.clone(),
            ask.clone(),
            "call-2".to_string(),
            "create_file".to_string(),
            json!({ "path": rejected_path.clone(), "content": "x" }),
            vec![rejected_path.clone()],
            "询问模式写入".to_string(),
        )
        .unwrap();
        decide_ai_approval(root_path.clone(), ask.clone(), rejected.id.clone(), false).unwrap();
        let error = decide_ai_approval(root_path.clone(), ask.clone(), rejected.id.clone(), true)
            .unwrap_err();
        assert!(error.contains("已处理"), "{error}");
        assert!(
            run_approved_ai_session_tool(root_path.clone(), ask.clone(), rejected.id.clone())
                .is_err()
        );
        assert!(!dir.join("03-测试计划/被拒.md").exists());

        write_ai_session_xmind(
            root_path.clone(),
            code.clone(),
            case_path.clone(),
            package.clone(),
        )
        .unwrap();
        let error = remove(&root_path, &code, &case_path).unwrap_err();
        assert!(error.starts_with("APPROVAL_REQUIRED:"), "{error}");
        let delete = request_ai_approval(
            root_path.clone(),
            code.clone(),
            "call-3".to_string(),
            "delete_path".to_string(),
            json!({ "path": case_path.clone() }),
            vec![case_path.clone()],
            "删除 XMind 测试用例".to_string(),
        )
        .unwrap();
        decide_ai_approval(root_path.clone(), code.clone(), delete.id.clone(), true).unwrap();
        run_approved_ai_session_tool(root_path.clone(), code.clone(), delete.id.clone()).unwrap();
        assert!(!dir.join("04-测试用例/审批用例.xmind").exists());

        let overwrite = request_ai_approval(
            root_path.clone(),
            code.clone(),
            "call-4".to_string(),
            "write_xmind".to_string(),
            json!({ "path": case_path.clone() }),
            vec![case_path.clone()],
            "人工修改后的覆盖".to_string(),
        )
        .unwrap();
        let error = write_ai_session_xmind_approved(
            root_path.clone(),
            code.clone(),
            overwrite.id.clone(),
            case_path.clone(),
            package.clone(),
            Vec::new(),
        )
        .unwrap_err();
        assert!(error.contains("尚未获得用户批准"), "{error}");
        decide_ai_approval(root_path.clone(), code.clone(), overwrite.id.clone(), true).unwrap();
        let error = write_ai_session_xmind_approved(
            root_path.clone(),
            code.clone(),
            overwrite.id.clone(),
            format!("{REQUIREMENT}/04-测试用例/其他.xmind"),
            package.clone(),
            Vec::new(),
        )
        .unwrap_err();
        assert!(error.contains("不一致"), "{error}");
        let written = write_ai_session_xmind_approved(
            root_path.clone(),
            code.clone(),
            overwrite.id.clone(),
            case_path.clone(),
            package.clone(),
            Vec::new(),
        )
        .unwrap();
        assert_eq!(written.output["action"], "created");
        assert!(write_ai_session_xmind_approved(
            root_path.clone(),
            code.clone(),
            overwrite.id.clone(),
            case_path.clone(),
            package.clone(),
            Vec::new(),
        )
        .is_err());

        let plan_dir = format!("{REQUIREMENT}/03-测试计划/计划目录");
        let plan_request = request_ai_approval(
            root_path.clone(),
            plan.clone(),
            "call-5".to_string(),
            "create_directory".to_string(),
            json!({ "path": plan_dir.clone() }),
            vec![plan_dir.clone()],
            "只读会话".to_string(),
        )
        .unwrap();
        decide_ai_approval(
            root_path.clone(),
            plan.clone(),
            plan_request.id.clone(),
            true,
        )
        .unwrap();
        let error =
            run_approved_ai_session_tool(root_path.clone(), plan.clone(), plan_request.id.clone())
                .unwrap_err();
        assert!(error.contains("计划模式为只读"), "{error}");
        assert!(!dir.join("03-测试计划/计划目录").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unlinked_sessions_refuse_writes_before_approval() {
        use base64::Engine;
        let (root, root_path) = setup("blackbox-client-ai-unlinked-test");
        let chat = session(&root_path, "聊天会话", false, "ask");
        let error = create(&root_path, &chat, "03-测试计划/草稿.md", "x").unwrap_err();
        assert!(error.contains("未关联需求"), "{error}");
        assert!(!error.starts_with("APPROVAL_REQUIRED:"), "{error}");
        let package = base64::engine::general_purpose::STANDARD.encode(b"PK\x03\x04chat");
        let error = write_ai_session_xmind_with_records(
            root_path.clone(),
            chat.clone(),
            "04-测试用例/聊天.xmind".to_string(),
            package,
            Vec::new(),
        )
        .unwrap_err();
        assert!(error.contains("未关联需求"), "{error}");
        assert!(!error.starts_with("APPROVAL_REQUIRED:"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn add_questions_appends_and_keeps_existing_answers() {
        let (root, root_path) = setup("blackbox-client-ai-questions-test");
        let code = session(&root_path, "代码会话", true, "code");
        let qa_file = root
            .join(REQUIREMENT)
            .join("02-需求理解与答疑/questions.json");
        let first = call(
            &root_path,
            &code,
            "add_questions",
            json!({ "questions": [
                { "question": "本期是否包含报表？", "priority": "P0", "category": "范围、版本与资料", "source": "02-需求理解与答疑/需求答疑.md" },
                { "question": "金额口径如何确定？", "priority": "P1" }
            ] }),
        )
        .unwrap();
        assert_eq!(first.output["added"], json!(["Q-01", "Q-02"]));
        assert_eq!(
            first.changed_paths,
            vec![format!("{REQUIREMENT}/02-需求理解与答疑/questions.json")]
        );
        let mut document: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&qa_file).unwrap()).unwrap();
        assert_eq!(document["requirement_id"], json!("AI-1001"));
        assert_eq!(document["questions"][0]["status"], json!("pending"));
        assert_eq!(document["questions"][0]["answer"], json!(null));

        document["questions"][0]["answer"] = json!("包含报表");
        document["questions"][0]["status"] = json!("answered");
        fs::write(&qa_file, serde_json::to_string_pretty(&document).unwrap()).unwrap();

        let second = call(
            &root_path,
            &code,
            "add_questions",
            json!({ "questions": [
                { "question": "金额口径如何确定？", "priority": "P1" },
                { "question": "APP 是否需要同步改版？", "priority": "P2" }
            ] }),
        )
        .unwrap();
        assert_eq!(second.output["added"], json!(["Q-03"]));
        assert_eq!(second.output["skipped_duplicates"], json!(1));
        let document: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&qa_file).unwrap()).unwrap();
        let items = document["questions"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["answer"], json!("包含报表"));
        assert_eq!(items[0]["status"], json!("answered"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn add_questions_validates_items_and_follows_session_gates() {
        let (root, root_path) = setup("blackbox-client-ai-questions-gate-test");
        let code = session(&root_path, "代码会话", true, "code");
        let ask = session(&root_path, "询问会话", true, "ask");
        let plan = session(&root_path, "计划会话", true, "plan");
        let unlinked = session(&root_path, "无需求会话", false, "code");
        let one = |priority: &str, text: &str| json!({ "questions": [{ "question": text, "priority": priority }] });
        let error = call(&root_path, &code, "add_questions", one("P9", "问题")).unwrap_err();
        assert!(error.contains("P0、P1 或 P2"), "{error}");
        let error = call(&root_path, &code, "add_questions", one("P0", "   ")).unwrap_err();
        assert!(error.contains("不能为空"), "{error}");
        let error = call(
            &root_path,
            &code,
            "add_questions",
            json!({ "questions": [] }),
        )
        .unwrap_err();
        assert!(error.contains("每次追加"), "{error}");
        let error = call(&root_path, &plan, "add_questions", one("P0", "问题")).unwrap_err();
        assert!(error.contains("只读"), "{error}");
        let error = call(&root_path, &unlinked, "add_questions", one("P0", "问题")).unwrap_err();
        assert!(error.contains("未关联需求"), "{error}");
        let error = call(&root_path, &ask, "add_questions", one("P0", "问题")).unwrap_err();
        assert!(error.starts_with("APPROVAL_REQUIRED:"), "{error}");
        assert!(!root
            .join(REQUIREMENT)
            .join("02-需求理解与答疑/questions.json")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn add_questions_stops_when_requirement_is_locked() {
        let (root, root_path) = setup("blackbox-client-ai-questions-lock-test");
        let code = session(&root_path, "代码会话", true, "code");
        lock_requirement(
            root_path.clone(),
            "projects/示例平台".to_string(),
            "AI-1001".to_string(),
            "task-ai-questions".to_string(),
            "验证疑问门禁".to_string(),
            "用户".to_string(),
        )
        .unwrap();
        let error = call(
            &root_path,
            &code,
            "add_questions",
            json!({ "questions": [{ "question": "锁定后的问题", "priority": "P0" }] }),
        )
        .unwrap_err();
        assert!(error.contains("需求目录已锁定"), "{error}");
        assert!(!root
            .join(REQUIREMENT)
            .join("02-需求理解与答疑/questions.json")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn add_questions_runs_only_after_approval_in_ask_mode() {
        use crate::sessions::decide_ai_approval;
        let (root, root_path) = setup("blackbox-client-ai-questions-approval-test");
        let ask = session(&root_path, "询问会话", true, "ask");
        let qa_file = root
            .join(REQUIREMENT)
            .join("02-需求理解与答疑/questions.json");
        let arguments = json!({ "questions": [{ "question": "待审批的问题", "priority": "P0" }] });
        let error = call(&root_path, &ask, "add_questions", arguments.clone()).unwrap_err();
        assert!(error.starts_with("APPROVAL_REQUIRED:"), "{error}");
        let approval = request_ai_approval(
            root_path.clone(),
            ask.clone(),
            "call-questions".to_string(),
            "add_questions".to_string(),
            arguments,
            vec![format!("{REQUIREMENT}/02-需求理解与答疑/questions.json")],
            "询问模式追加疑问".to_string(),
        )
        .unwrap();
        assert!(!qa_file.exists());
        decide_ai_approval(root_path.clone(), ask.clone(), approval.id.clone(), true).unwrap();
        let executed =
            run_approved_ai_session_tool(root_path.clone(), ask.clone(), approval.id.clone())
                .unwrap();
        assert_eq!(executed.tool, "add_questions");
        let document: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&qa_file).unwrap()).unwrap();
        assert_eq!(document["questions"][0]["id"], json!("Q-01"));
        assert_eq!(document["questions"][0]["status"], json!("pending"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_writes_stop_when_requirement_is_locked() {
        let (root, root_path) = setup("blackbox-client-ai-lock-test");
        let code = session(&root_path, "代码会话", true, "code");
        let draft = format!("{REQUIREMENT}/03-测试计划/草稿.md");
        assert!(create(&root_path, &code, &draft, "初稿").is_ok());
        lock_requirement(
            root_path.clone(),
            "projects/示例平台".to_string(),
            "AI-1001".to_string(),
            "task-ai-1".to_string(),
            "验证工具层门禁".to_string(),
            "用户".to_string(),
        )
        .unwrap();

        let error = update(&root_path, &code, &draft, "锁定后").unwrap_err();
        assert!(error.contains("需求目录已锁定"), "{error}");
        let error = create(
            &root_path,
            &code,
            &format!("{REQUIREMENT}/03-测试计划/新稿.md"),
            "x",
        )
        .unwrap_err();
        assert!(error.contains("需求目录已锁定"), "{error}");
        let error = remove(&root_path, &code, &draft).unwrap_err();
        assert!(error.contains("需求目录已锁定"), "{error}");
        let error = move_to(
            &root_path,
            &code,
            &draft,
            &format!("{REQUIREMENT}/07-测试报告/草稿.md"),
        )
        .unwrap_err();
        assert!(error.contains("需求目录已锁定"), "{error}");
        use base64::Engine;
        let case_xmind = format!("{REQUIREMENT}/04-测试用例/锁定用例.xmind");
        let package = base64::engine::general_purpose::STANDARD.encode(b"PK\x03\x04locked");
        let error = write_ai_session_xmind(root_path.clone(), code.clone(), case_xmind, package)
            .unwrap_err();
        assert!(error.contains("需求目录已锁定"), "{error}");
        assert!(call(&root_path, &code, "read_file", json!({ "path": draft })).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_coverage_upserts_items_and_preserves_user_exemptions() {
        let (root, root_path) = setup("blackbox-client-ai-coverage-test");
        let code = session(&root_path, "代码会话", true, "code");
        let coverage_file = root.join(REQUIREMENT).join("03-测试计划/coverage.json");
        let first = call(
            &root_path,
            &code,
            "update_coverage",
            json!({ "items": [
                { "ref": "TSK-PAY-001", "kind": "task", "title": "维护总部收款类型", "coverage": "none", "note": "待补充" },
                { "ref": "POST /ghost/financial/paymentCategory/create", "kind": "interface", "title": "新增总部收款类型", "coverage": "covered", "cases": ["tc-p0-功能测试: 新增记账收款类型并选择固定记账协议成功"] }
            ] }),
        )
        .unwrap();
        assert_eq!(first.output["added"], json!(["COV-01", "COV-02"]));
        assert_eq!(
            first.changed_paths,
            vec![format!("{REQUIREMENT}/03-测试计划/coverage.json")]
        );
        let document: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&coverage_file).unwrap()).unwrap();
        assert_eq!(document["requirement_id"], json!("AI-1001"));
        assert_eq!(document["items"][0]["coverage"], json!("none"));

        // 用户把第一条标记为豁免
        let mut document = document;
        document["items"][0]["coverage"] = json!("exempt");
        document["items"][0]["exempt_reason"] = json!("后端内部任务");
        document["items"][0]["exempt_by"] = json!("user");
        fs::write(
            &coverage_file,
            serde_json::to_string_pretty(&document).unwrap(),
        )
        .unwrap();

        // AI 同 ref 更新：豁免状态保留，其余字段更新
        let second = call(
            &root_path,
            &code,
            "update_coverage",
            json!({ "items": [
                { "ref": "tsk-pay-001", "kind": "task", "title": "维护总部收款类型（修订）", "coverage": "covered", "cases": ["tc-p0-功能测试: x"] },
                { "ref": "TSK-PAY-015", "kind": "task", "title": "收款类型搜索索引", "coverage": "none" }
            ] }),
        )
        .unwrap();
        assert_eq!(second.output["updated"], json!(["COV-01"]));
        assert_eq!(second.output["added"], json!(["COV-03"]));
        assert_eq!(second.output["exempt_kept"], json!(1));
        let document: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&coverage_file).unwrap()).unwrap();
        let items = document["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["coverage"], json!("exempt"));
        assert_eq!(items[0]["exempt_reason"], json!("后端内部任务"));
        assert_eq!(items[0]["title"], json!("维护总部收款类型（修订）"));
        assert_eq!(items[0]["cases"], json!(["tc-p0-功能测试: x"]));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_coverage_rejects_exempt_and_generic_file_tools() {
        let (root, root_path) = setup("blackbox-client-ai-coverage-gate-test");
        let code = session(&root_path, "代码会话", true, "code");
        let ask = session(&root_path, "询问会话", true, "ask");
        let plan = session(&root_path, "计划会话", true, "plan");
        let unlinked = session(&root_path, "无需求会话", false, "code");
        let one = |coverage: &str| json!({ "items": [{ "ref": "TSK-1", "title": "任务", "coverage": coverage }] });
        let error = call(&root_path, &code, "update_coverage", one("exempt")).unwrap_err();
        assert!(error.contains("豁免标记只能由人"), "{error}");
        let error = call(&root_path, &code, "update_coverage", one("done")).unwrap_err();
        assert!(error.contains("covered、partial 或 none"), "{error}");
        let error = call(
            &root_path,
            &code,
            "update_coverage",
            json!({ "items": [{ "ref": "  ", "title": "任务", "coverage": "none" }] }),
        )
        .unwrap_err();
        assert!(error.contains("ref 不能为空"), "{error}");
        let error = call(&root_path, &plan, "update_coverage", one("none")).unwrap_err();
        assert!(error.contains("只读"), "{error}");
        let error = call(&root_path, &unlinked, "update_coverage", one("none")).unwrap_err();
        assert!(error.contains("未关联需求"), "{error}");
        let error = call(&root_path, &ask, "update_coverage", one("none")).unwrap_err();
        assert!(error.starts_with("APPROVAL_REQUIRED:"), "{error}");
        // coverage.json 不能通过通用文件工具创建或修改
        let target = format!("{REQUIREMENT}/03-测试计划/coverage.json");
        let error = create(&root_path, &code, &target, "{}").unwrap_err();
        assert!(error.contains("由客户端业务流程管理"), "{error}");
        assert!(!root
            .join(REQUIREMENT)
            .join("03-测试计划/coverage.json")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }
}
