use notify::event::{ModifyKind, RemoveKind, RenameMode};
use notify::{
    Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::llm::{chat_completion, ChatMessage};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub version: String,
    pub workspace: WorkspaceInfo,
    #[serde(default = "default_directories")]
    pub directories: HashMap<String, String>,
    #[serde(default)]
    pub platforms: Vec<PlatformInfo>,
    #[serde(default)]
    pub defaults: WorkspaceDefaults,
    #[serde(default = "default_index_config")]
    pub index: IndexConfig,
    #[serde(default = "default_watcher_config")]
    pub watcher: WatcherConfig,
    #[serde(default = "default_backup_config")]
    pub backup: BackupConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspaceDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_defaults: Option<serde_json::Value>,
    #[serde(default)]
    pub platform_id: Option<String>,
    #[serde(default)]
    pub case_template_id: Option<String>,
    #[serde(default)]
    pub report_template_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceOpenResult {
    pub config: WorkspaceConfig,
    pub initialized: bool,
    pub legacy_directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexConfig {
    pub engine: String,
    pub db_path: String,
    pub fts_enabled: bool,
    pub ignore_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherConfig {
    pub enabled: bool,
    pub debounce_ms: u64,
    pub ignore_patterns: Vec<String>,
}

pub const WORKSPACE_EVENT: &str = "workspace://file-change";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEvent {
    pub event_type: String,
    pub path: String,
    pub old_path: Option<String>,
    pub is_directory: bool,
    pub occurred_at: String,
}

pub struct WorkspaceWatcherState {
    watcher: Mutex<Option<WorkspaceWatcherHandle>>,
    generation: AtomicU64,
}

impl Default for WorkspaceWatcherState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

struct WorkspaceWatcherHandle {
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for WorkspaceWatcherHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct PendingRename {
    path: PathBuf,
    is_directory: bool,
    recorded_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupConfig {
    pub auto_enabled: bool,
    pub interval_hours: u64,
    pub max_backups: u64,
    pub include_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub name: String,
    pub created_at: String,
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_defaults: Option<serde_json::Value>,
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub knowledge_path: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformDraft {
    pub id: String,
    pub name: String,
    pub path: String,
    pub knowledge_path: String,
    #[serde(default)]
    pub description: String,
}

/// 需求与云效工作项的绑定：用于测试执行中提交缺陷挂到对应云效需求下
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RequirementYunxiao {
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub workitem_id: String,
    #[serde(default)]
    pub workitem_serial: String,
    #[serde(default)]
    pub workitem_subject: String,
    #[serde(default)]
    pub sprint_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequirementDraft {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub owner: String,
    pub planned_test_date: Option<String>,
    pub planned_release_date: Option<String>,
    #[serde(default)]
    pub applications: Vec<ApplicationInfo>,
    #[serde(default = "default_requirement_stage")]
    pub initial_stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yunxiao: Option<RequirementYunxiao>,
    #[serde(flatten, default)]
    pub extensions: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTaskFileInput {
    pub path: String,
    #[serde(default)]
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiKnowledgeScope {
    pub scope: String,
    #[serde(default)]
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTaskDraft {
    pub task_type: String,
    pub platform_id: String,
    pub requirement_id: String,
    pub objective: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub input_files: Vec<AiTaskFileInput>,
    #[serde(default)]
    pub knowledge_scope: Vec<AiKnowledgeScope>,
    #[serde(default)]
    pub allowed_paths: Vec<String>,
    #[serde(default)]
    pub forbidden_paths: Vec<String>,
    pub output_dir: String,
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub lock_requirement: bool,
    /// 客户端生成的提示词模板（可被内置 AI 优化）。存在时写入 prompt.md，
    /// 并作为任务详情里可复制的派发词，task.md 仍保留标准任务说明。
    #[serde(default)]
    pub prompt_override: Option<String>,
    /// 执行方式：external（派发给外部AI）或 builtin（客户端模型直接执行）。
    #[serde(default)]
    pub execution_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTaskFile {
    pub path: String,
    pub fingerprint: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTaskInfo {
    pub task_id: String,
    pub task_type: String,
    pub platform_id: String,
    pub requirement_id: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub objective: String,
    pub acceptance_criteria: Vec<String>,
    pub task_dir: String,
    pub input_files: Vec<AiTaskFile>,
    pub knowledge_scope: Vec<AiKnowledgeScope>,
    pub allowed_paths: Vec<String>,
    pub forbidden_paths: Vec<String>,
    pub output_dir: String,
    pub output_schema: Option<serde_json::Value>,
    pub lock_requirement: bool,
    pub requirement_locked: bool,
    pub execution_mode: String,
    pub dispatch_text: String,
    pub progress: AiTaskProgress,
    pub result: AiTaskResult,
    pub file_changes: FileChanges,
    pub validation: AiTaskValidation,
    pub artifact_count: usize,
    pub awaiting_confirmation: bool,
    pub review_status: String,
    pub review_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiTaskProgress {
    pub status: String,
    pub updated_at: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiTaskOutput {
    pub path: String,
    #[serde(rename = "type", default)]
    pub output_type: String,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiTaskResultValidation {
    #[serde(default)]
    pub passed: bool,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiTaskResult {
    #[serde(default)]
    pub outputs: Vec<AiTaskOutput>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub validation: AiTaskResultValidation,
    #[serde(default)]
    pub pending_items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiTaskArtifactCheck {
    pub path: String,
    pub exists: bool,
    pub in_scope: bool,
    pub json_valid: Option<bool>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiTaskValidation {
    pub passed: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub out_of_scope_paths: Vec<String>,
    pub artifacts: Vec<AiTaskArtifactCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTaskActionResult {
    pub task: AiTaskInfo,
    pub requirement: Option<RequirementMeta>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct GitResource {
    pub id: String,
    pub application_name: String,
    pub local_path: String,
    pub repository_url: String,
    pub current_branch: String,
    pub current_commit: String,
    pub expected_branch: String,
    pub app_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequirementMeta {
    pub version: String,
    pub requirement: RequirementInfo,
    pub status: String,
    pub current_stage: String,
    pub schedule: ScheduleInfo,
    pub applications: Vec<ApplicationInfo>,
    #[serde(default)]
    pub git_resources: Vec<GitResource>,
    pub client_access: ClientAccess,
    #[serde(default)]
    pub stage_checklist: Vec<serde_json::Value>,
    #[serde(default)]
    pub blockers: Vec<serde_json::Value>,
    #[serde(default)]
    pub pending_reviews: Vec<serde_json::Value>,
    #[serde(default)]
    pub next_actions: Vec<serde_json::Value>,
    #[serde(default)]
    pub versions: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yunxiao: Option<RequirementYunxiao>,
    #[serde(flatten, default)]
    pub extensions: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequirementInfo {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub owner: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleInfo {
    pub planned_test_date: Option<String>,
    pub planned_release_date: Option<String>,
    pub actual_test_date: Option<String>,
    pub actual_release_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationInfo {
    pub name: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientAccess {
    pub mode: String,
    pub locked_at: Option<String>,
    pub locked_by: Option<String>,
    pub task_id: Option<String>,
    pub note: String,
    pub snapshot_path: Option<String>,
}

impl Default for ClientAccess {
    fn default() -> Self {
        ClientAccess {
            mode: "unlocked".to_string(),
            locked_at: None,
            locked_by: None,
            task_id: None,
            note: String::new(),
            snapshot_path: None,
        }
    }
}

/// 打开工作区：读取根目录下的 .blackbox/workspace.yaml
#[tauri::command]
pub fn open_workspace(root_path: String) -> Result<WorkspaceOpenResult, String> {
    let root = Path::new(&root_path);
    ensure_readable_directory(root)?;
    let config_path = root.join(".blackbox").join("workspace.yaml");
    let legacy_directories = detect_legacy_directories(root);
    if !config_path.exists() {
        return Ok(WorkspaceOpenResult {
            config: WorkspaceConfig {
                version: "1.0".to_string(),
                workspace: WorkspaceInfo {
                    name: workspace_name(root),
                    created_at: chrono_now(),
                    root_path: root.to_string_lossy().to_string(),
                },
                directories: default_directories(),
                platforms: Vec::new(),
                defaults: WorkspaceDefaults::default(),
                index: default_index_config(),
                watcher: default_watcher_config(),
                backup: default_backup_config(),
            },
            initialized: false,
            legacy_directories,
        });
    }
    let mut config = read_workspace_config(root)?;
    normalize_platforms(&mut config);
    config.workspace.root_path = root.to_string_lossy().to_string();
    Ok(WorkspaceOpenResult {
        config,
        initialized: true,
        legacy_directories,
    })
}

#[tauri::command]
pub fn start_workspace_watcher(
    root_path: String,
    generation: u64,
    app: AppHandle,
    state: State<'_, WorkspaceWatcherState>,
) -> Result<bool, String> {
    if generation < state.generation.load(Ordering::Acquire) {
        return Ok(false);
    }
    state.generation.store(generation, Ordering::Release);

    let previous = state
        .watcher
        .lock()
        .map_err(|_| "文件监听器状态不可用".to_string())?
        .take();
    drop(previous);

    let opened = open_workspace(root_path.clone())?;
    if !opened.initialized || !opened.config.watcher.enabled {
        return Ok(false);
    }

    let root = Path::new(&root_path).to_path_buf();
    ensure_readable_directory(&root)?;
    let mut ignore_patterns = default_watcher_ignore_patterns();
    ignore_patterns.extend(opened.config.index.ignore_patterns);
    ignore_patterns.extend(opened.config.watcher.ignore_patterns);
    ignore_patterns.sort();
    ignore_patterns.dedup();

    let debounce = Duration::from_millis(opened.config.watcher.debounce_ms.max(50));
    let (sender, receiver) = mpsc::channel::<notify::Result<NotifyEvent>>();
    let mut watcher = notify::recommended_watcher(move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| format!("创建文件监听器失败：{}", error))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| format!("监听工作区失败：{}", error))?;

    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let worker_app = app.clone();
    let worker_root = root.clone();
    let worker_patterns = ignore_patterns;
    let worker = thread::Builder::new()
        .name("blackbox-workspace-watcher".to_string())
        .spawn(move || {
            run_workspace_watcher(
                receiver,
                worker_stop,
                worker_app,
                worker_root,
                worker_patterns,
                debounce,
            );
        })
        .map_err(|error| format!("启动文件监听线程失败：{}", error))?;

    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "文件监听器状态不可用".to_string())?;
    *guard = Some(WorkspaceWatcherHandle {
        _watcher: watcher,
        stop,
        worker: Some(worker),
    });
    Ok(true)
}

#[tauri::command]
pub fn stop_workspace_watcher(
    generation: u64,
    state: State<'_, WorkspaceWatcherState>,
) -> Result<(), String> {
    if generation != state.generation.load(Ordering::Acquire) {
        return Ok(());
    }
    let watcher = state
        .watcher
        .lock()
        .map_err(|_| "文件监听器状态不可用".to_string())?
        .take();
    drop(watcher);
    Ok(())
}

/// 初始化工作区：在根目录下创建 .blackbox 目录和 workspace.yaml
#[tauri::command]
pub fn init_workspace(root_path: String, name: String) -> Result<WorkspaceOpenResult, String> {
    let root = Path::new(&root_path);
    ensure_readable_directory(root)?;
    let blackbox_dir = root.join(".blackbox");
    let config_path = blackbox_dir.join("workspace.yaml");
    if config_path.exists() {
        return open_workspace(root_path);
    }

    fs::create_dir_all(blackbox_dir.join("tasks")).map_err(|e| e.to_string())?;
    fs::create_dir_all(blackbox_dir.join("migrations")).map_err(|e| e.to_string())?;
    fs::create_dir_all(blackbox_dir.join("logs")).map_err(|e| e.to_string())?;

    let created_at = chrono_now();
    let workspace_name = if name.trim().is_empty() {
        workspace_name(root)
    } else {
        name.trim().to_string()
    };
    let config = WorkspaceConfig {
        version: "1.0".to_string(),
        workspace: WorkspaceInfo {
            name: workspace_name.clone(),
            created_at: created_at.clone(),
            root_path: root.to_string_lossy().to_string(),
        },
        directories: default_directories(),
        platforms: default_platforms(),
        defaults: WorkspaceDefaults::default(),
        index: default_index_config(),
        watcher: default_watcher_config(),
        backup: default_backup_config(),
    };

    let yaml_str = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
    write_internal_text_file(&config_path, yaml_str)?;

    for relative_path in standard_workspace_directories() {
        fs::create_dir_all(root.join(relative_path)).map_err(|e| e.to_string())?;
    }

    let workspace_readme = root.join("WORKSPACE.md");
    if !workspace_readme.exists() {
        let content = format!(
            "# 白泽工作区说明\n\n> 本文件由白泽客户端生成，供客户端和外部AI共同阅读。\n\n## 工作区标识\n\n- 工作区名称：{}\n- 协议版本：1.0\n- 创建时间：{}\n- 工作区根目录：{}\n\n## 目录角色\n\n- `.blackbox/`：客户端内部协议、任务、迁移记录和日志。\n- `templates/`：XMind、Excel、报告和任务模板。\n- `projects/`：按平台和需求组织的业务资料。\n- `knowledge/`：通用及平台知识库。\n- `tools/`：解析、校验和导出工具，以及工作流规范。\n- `archive/`：已归档资料。\n- `../codex-skills/`（工作区旁边的独立资料库）：需求、接口和联调等开发文档；AI 可按 `codex-skills/` 前缀的相对路径只读访问，不要修改。\n\n## 需求目录与阶段\n\n- 需求目录为 `projects/<平台>/<需求编号>/`。客户端创建需求时会生成以下标准目录，缺失时请先告知用户补齐：\n  - `01-需求资料`（`需求文档`、`需求截图`）：客户原始资料，AI 只读。\n  - `02-需求理解与答疑`：需求理解、需求答疑文档；附件放 `attachments/`；疑问条目记录在 `questions.json`，只追加。\n  - `03-测试计划`：测试计划；`reviews/` 存放用例复盘记录，是修改用例的参考资料。\n  - `04-测试用例`：XMind 用例；`exports/`、`reviews/`、`versions/` 由客户端维护。\n  - `05-开发资源`（`前端`、`后端`）：开发参考资料，AI 只读。\n  - `06-测试执行与证据`：测试轮次、结果与证据，AI 只读。\n  - `07-测试报告`：测试报告。\n  - `08-知识候选`：知识提案，知识发布需人工确认。\n- 需求阶段（`requirement.yaml` 的 `current_stage`）只能由人在客户端推进，AI 不推进阶段。\n- 派生文档（需求理解、需求答疑、测试计划、用例等）不要写入 `01-需求资料`。\n\n## AI使用须知\n\n1. 先阅读本文件和 `.blackbox/workspace.yaml`。\n2. 需求元数据保存在各需求目录的 `requirement.yaml`，由客户端维护，不要手改。\n3. 新工作使用AI会话；运行、审批与还原由后端维护。`.blackbox/tasks/` 仅保留历史任务与收尾。\n4. 会话工具按关联平台/需求及权限门禁写入；外派只生成普通Markdown和修订建议，不创建旧任务包。\n5. 评审提案先保存到 `03-测试计划/reviews/`，由人预览应用并确认正式版本。报告写入 `07-测试报告/`，知识仅新增 `08-知识候选/knowledge-proposal-<唯一ID>.json`，发布由人确认。\n",
            workspace_name,
            created_at,
            root.to_string_lossy(),
        );
        write_internal_text_file(&workspace_readme, content)?;
    }

    Ok(WorkspaceOpenResult {
        config,
        initialized: true,
        legacy_directories: detect_legacy_directories(root),
    })
}

/// 扫描平台：从 workspace.yaml 的注册表读取客户平台
#[tauri::command]
pub fn scan_platforms_cmd(root_path: String) -> Result<Vec<PlatformInfo>, String> {
    Ok(open_workspace(root_path)?.config.platforms)
}

#[tauri::command]
pub fn create_platform(root_path: String, input: PlatformDraft) -> Result<WorkspaceConfig, String> {
    let (root, mut config) = load_initialized_workspace(&root_path)?;
    let id = validate_platform_id(&input.id)?;
    let name = validate_platform_name(&input.name)?;
    let path = validate_platform_directory(
        &input.path,
        config
            .directories
            .get("projects")
            .map(String::as_str)
            .unwrap_or("projects"),
        "项目目录",
    )?;
    let knowledge_path = validate_platform_directory(
        &input.knowledge_path,
        config
            .directories
            .get("knowledge")
            .map(String::as_str)
            .unwrap_or("knowledge"),
        "知识目录",
    )?;

    if config.platforms.iter().any(|platform| platform.id == id) {
        return Err(format!("平台 ID 已存在：{}", id));
    }
    if Path::new(&path) == Path::new(&knowledge_path) {
        return Err("项目目录和知识目录不能相同".to_string());
    }
    if platform_paths_conflict(&config.platforms, &path, &knowledge_path, None) {
        return Err("项目目录或知识目录已被其他平台使用".to_string());
    }

    let timestamp = chrono_now();
    let platform = PlatformInfo {
        integration_defaults: None,
        id,
        name,
        path,
        knowledge_path,
        status: "active".to_string(),
        description: input.description.trim().to_string(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };

    fs::create_dir_all(root.join(&platform.path)).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join(&platform.knowledge_path)).map_err(|e| e.to_string())?;
    config.platforms.push(platform);
    write_platform_registry(&root, &config.platforms)?;
    config.workspace.root_path = root.to_string_lossy().to_string();
    Ok(config)
}

#[tauri::command]
pub fn update_platform(
    root_path: String,
    platform_id: String,
    name: String,
    description: String,
    status: String,
) -> Result<WorkspaceConfig, String> {
    let (root, mut config) = load_initialized_workspace(&root_path)?;
    let name = validate_platform_name(&name)?;
    let status = validate_platform_status(&status)?;
    let platform = config
        .platforms
        .iter_mut()
        .find(|platform| platform.id == platform_id)
        .ok_or_else(|| format!("平台不存在：{}", platform_id))?;

    platform.name = name;
    platform.description = description.trim().to_string();
    platform.status = status;
    platform.updated_at = chrono_now();
    write_platform_registry(&root, &config.platforms)?;
    config.workspace.root_path = root.to_string_lossy().to_string();
    Ok(config)
}

#[tauri::command]
pub fn delete_platform(root_path: String, platform_id: String) -> Result<WorkspaceConfig, String> {
    let (root, mut config) = load_initialized_workspace(&root_path)?;
    let index = config
        .platforms
        .iter()
        .position(|platform| platform.id == platform_id)
        .ok_or_else(|| format!("平台不存在：{}", platform_id))?;
    let platform = &config.platforms[index];
    if platform_has_associations(&root, &config, platform) {
        return Err("平台已存在关联需求、模板、知识或任务，只能归档，不能删除注册".to_string());
    }

    config.platforms.remove(index);
    write_platform_registry(&root, &config.platforms)?;
    config.workspace.root_path = root.to_string_lossy().to_string();
    Ok(config)
}

fn read_workspace_config(root: &Path) -> Result<WorkspaceConfig, String> {
    let config_path = root.join(".blackbox").join("workspace.yaml");
    let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    serde_yaml::from_str(&content).map_err(|e| e.to_string())
}

pub(crate) fn load_initialized_workspace(
    root_path: &str,
) -> Result<(PathBuf, WorkspaceConfig), String> {
    let root = Path::new(root_path);
    ensure_readable_directory(root)?;
    if !root.join(".blackbox").join("workspace.yaml").exists() {
        return Err("工作区尚未初始化，无法管理平台".to_string());
    }
    let mut config = read_workspace_config(root)?;
    normalize_platforms(&mut config);
    config.workspace.root_path = root.to_string_lossy().to_string();
    Ok((root.to_path_buf(), config))
}

fn normalize_platforms(config: &mut WorkspaceConfig) {
    let timestamp = chrono_now();
    for platform in &mut config.platforms {
        if platform.status.trim().is_empty() {
            platform.status = "active".to_string();
        }
        if platform.created_at.trim().is_empty() {
            platform.created_at = timestamp.clone();
        }
        if platform.updated_at.trim().is_empty() {
            platform.updated_at = platform.created_at.clone();
        }
    }
}

fn validate_platform_id(value: &str) -> Result<String, String> {
    let id = value.trim();
    if id.is_empty()
        || !id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err(
            "平台 ID 只能使用字母、数字、短横线和下划线，且必须以字母或数字开头".to_string(),
        );
    }
    Ok(id.to_string())
}

fn validate_platform_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("平台显示名称不能为空".to_string());
    }
    Ok(name.to_string())
}

fn validate_platform_status(value: &str) -> Result<String, String> {
    match value.trim() {
        "active" => Ok("active".to_string()),
        "archived" => Ok("archived".to_string()),
        _ => Err("平台状态只能是 active 或 archived".to_string()),
    }
}

fn validate_platform_directory(value: &str, base: &str, label: &str) -> Result<String, String> {
    let normalized = validate_relative_path(value, label)?;
    let relative = Path::new(&normalized);
    let base_path = Path::new(base);
    if relative == base_path || !relative.starts_with(base_path) {
        return Err(format!("{}必须位于 {} 目录下", label, base));
    }
    Ok(normalized)
}

fn validate_relative_path(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "{}必须是工作区内的相对路径，不能包含 .. 或绝对路径",
            label
        ));
    }
    let normalized = path.to_string_lossy().to_string();
    if normalized.is_empty() || normalized == "." {
        return Err(format!("{}不能为空", label));
    }
    Ok(normalized)
}

fn default_requirement_stage() -> String {
    "draft".to_string()
}

fn validate_requirement_id(value: &str) -> Result<String, String> {
    let id = value.trim();
    if id.is_empty()
        || id == "."
        || id == ".."
        || id.chars().any(|character| {
            character == '/' || character == '\\' || character == ':' || character.is_control()
        })
    {
        return Err("需求编号不能为空，且不能包含路径分隔符、冒号或控制字符".to_string());
    }
    Ok(id.to_string())
}

fn validate_requirement_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("需求名称不能为空".to_string());
    }
    Ok(name.to_string())
}

fn validate_requirement_stage(value: &str) -> Result<String, String> {
    let stage = value.trim();
    if matches!(
        stage,
        "draft"
            | "collecting"
            | "analyzing"
            | "pending_qa"
            | "planning"
            | "testcase_design"
            | "testcase_review"
            | "ready_for_test"
            | "testing"
            | "pending_report"
            | "completed"
            | "archived"
    ) {
        Ok(stage.to_string())
    } else {
        Err(format!("不支持的需求初始状态：{}", stage))
    }
}

fn requirement_stage_label(stage: &str) -> &'static str {
    match stage {
        "draft" => "草稿",
        "collecting" => "资料收集中",
        "analyzing" => "需求理解中",
        "pending_qa" => "待答疑",
        "planning" => "测试计划中",
        "testcase_design" => "用例设计中",
        "testcase_review" => "用例评审中",
        "ready_for_test" => "待提测",
        "testing" => "测试执行中",
        "pending_report" => "待报告",
        "completed" => "已完成",
        "archived" => "已归档",
        _ => "草稿",
    }
}

/// 需求阶段顺序：archived 位于末尾，但归档/恢复通过独立动作处理，不走相邻推进
const REQUIREMENT_STAGE_ORDER: &[&str] = &[
    "draft",
    "collecting",
    "analyzing",
    "pending_qa",
    "planning",
    "testcase_design",
    "testcase_review",
    "ready_for_test",
    "testing",
    "pending_report",
    "completed",
    "archived",
];

fn normalize_optional_date(value: Option<String>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let date = value.trim();
    if date.is_empty() {
        return Ok(None);
    }
    let valid = date.len() == 10
        && date.as_bytes().get(4) == Some(&b'-')
        && date.as_bytes().get(7) == Some(&b'-')
        && date
            .chars()
            .enumerate()
            .all(|(index, character)| index == 4 || index == 7 || character.is_ascii_digit());
    if !valid {
        return Err(format!("{}必须使用 YYYY-MM-DD 格式", label));
    }
    Ok(Some(date.to_string()))
}

fn normalize_applications(
    applications: Vec<ApplicationInfo>,
) -> Result<Vec<ApplicationInfo>, String> {
    let mut normalized = Vec::new();
    for application in applications {
        let name = application.name.trim();
        let branch = application.branch.trim();
        if name.is_empty() && branch.is_empty() {
            continue;
        }
        if name.is_empty() {
            return Err("涉及应用名称不能为空".to_string());
        }
        normalized.push(ApplicationInfo {
            name: name.to_string(),
            branch: branch.to_string(),
        });
    }
    Ok(normalized)
}

fn normalize_git_resources(resources: Vec<GitResource>) -> Result<Vec<GitResource>, String> {
    let mut normalized = Vec::new();
    for resource in resources {
        let id = resource.id.trim();
        let application_name = resource.application_name.trim();
        let local_path = resource.local_path.trim();
        if id.is_empty() && application_name.is_empty() && local_path.is_empty() {
            continue;
        }
        if id.is_empty() {
            return Err("Git资源ID不能为空".to_string());
        }
        if !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        }) {
            return Err("Git资源ID只能使用字母、数字、短横线和下划线".to_string());
        }
        if application_name.is_empty() {
            return Err("Git资源应用名称不能为空".to_string());
        }
        if local_path.is_empty() {
            return Err(format!("Git资源“{}”的本地路径不能为空", application_name));
        }
        if normalized.iter().any(|item: &GitResource| item.id == id) {
            return Err(format!("Git资源ID重复：{}", id));
        }
        let app_type = match resource.app_type.trim() {
            "frontend" | "backend" | "other" => resource.app_type.trim(),
            _ => "other",
        };
        normalized.push(GitResource {
            id: id.to_string(),
            application_name: application_name.to_string(),
            local_path: local_path.to_string(),
            repository_url: resource.repository_url.trim().to_string(),
            current_branch: resource.current_branch.trim().to_string(),
            current_commit: resource.current_commit.trim().to_string(),
            expected_branch: resource.expected_branch.trim().to_string(),
            app_type: app_type.to_string(),
        });
    }
    Ok(normalized)
}

pub(crate) fn write_atomic_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let temporary_path = path.with_file_name(format!(".{}.blackbox-tmp", file_name));
    fs::write(&temporary_path, content).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|e| {
            let _ = fs::remove_file(&temporary_path);
            e.to_string()
        })?;
    }
    fs::rename(&temporary_path, path).map_err(|e| {
        let _ = fs::remove_file(&temporary_path);
        e.to_string()
    })
}

pub(crate) fn write_internal_text_file(path: &Path, content: String) -> Result<(), String> {
    write_atomic_bytes(path, content.as_bytes())
}

fn write_workspace_text_file(path: &Path, content: String) -> Result<(), String> {
    ensure_client_write_allowed(path, Some(content.as_bytes()))?;
    write_atomic_bytes(path, content.as_bytes())
}

fn find_requirement_metadata(path: &Path) -> Result<Option<(PathBuf, RequirementMeta)>, String> {
    let mut current = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };
    loop {
        let metadata_path = current.join("requirement.yaml");
        if metadata_path.is_file() {
            let content = fs::read_to_string(&metadata_path).map_err(|e| e.to_string())?;
            let meta: RequirementMeta =
                serde_yaml::from_str(&content).map_err(|e| format!("无法读取需求锁状态：{}", e))?;
            return Ok(Some((current, meta)));
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    Ok(None)
}

pub(crate) fn ensure_client_write_allowed(
    path: &Path,
    content: Option<&[u8]>,
) -> Result<(), String> {
    let Some((_requirement_dir, existing)) = find_requirement_metadata(path)? else {
        return Ok(());
    };
    if existing.client_access.mode == "locked_for_ai" {
        return Err(format!(
            "需求目录已锁定，客户端禁止写入（任务：{}）",
            existing
                .client_access
                .task_id
                .as_deref()
                .unwrap_or("未关联任务")
        ));
    }
    if path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("requirement.yaml"))
    {
        let Some(content) = content else {
            return Err("requirement.yaml 必须通过需求保存服务写入".to_string());
        };
        let submitted: RequirementMeta = serde_yaml::from_slice(content)
            .map_err(|_| "requirement.yaml 必须通过需求保存服务写入".to_string())?;
        if submitted.client_access != existing.client_access {
            return Err("需求锁状态只能通过锁定或解锁确认命令修改".to_string());
        }
    }
    Ok(())
}

fn platform_paths_conflict(
    platforms: &[PlatformInfo],
    path: &str,
    knowledge_path: &str,
    skip_id: Option<&str>,
) -> bool {
    let path = Path::new(path);
    let knowledge_path = Path::new(knowledge_path);
    platforms
        .iter()
        .filter(|platform| skip_id != Some(platform.id.as_str()))
        .any(|platform| {
            let existing_path = Path::new(&platform.path);
            let existing_knowledge_path = Path::new(&platform.knowledge_path);
            existing_path == path
                || existing_knowledge_path == knowledge_path
                || existing_path == knowledge_path
                || existing_knowledge_path == path
        })
}

fn platform_has_associations(
    root: &Path,
    config: &WorkspaceConfig,
    platform: &PlatformInfo,
) -> bool {
    let project_path = root.join(&platform.path);
    let knowledge_path = root.join(&platform.knowledge_path);
    let templates_path = root.join(
        config
            .directories
            .get("templates")
            .map(String::as_str)
            .unwrap_or("templates"),
    );
    let tasks_path = root
        .join(
            config
                .directories
                .get("blackbox")
                .map(String::as_str)
                .unwrap_or(".blackbox"),
        )
        .join("tasks");
    directory_has_files(&project_path)
        || directory_has_files(&knowledge_path)
        || directory_contains_platform_reference(&templates_path, &platform.id)
        || directory_contains_platform_reference(&tasks_path, &platform.id)
}

fn directory_has_files(path: &Path) -> bool {
    path.is_dir()
        && walkdir::WalkDir::new(path)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_type().is_file())
}

fn directory_contains_platform_reference(path: &Path, platform_id: &str) -> bool {
    if !path.is_dir() {
        return false;
    }
    let yaml_reference = format!("platform_id: {}", platform_id);
    let yaml_quoted_reference = format!("platform_id: \"{}\"", platform_id);
    let json_reference = format!("\"platform_id\":\"{}\"", platform_id);
    let json_spaced_reference = format!("\"platform_id\": \"{}\"", platform_id);
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .any(|content| {
            content.contains(&yaml_reference)
                || content.contains(&yaml_quoted_reference)
                || content.contains(&json_reference)
                || content.contains(&json_spaced_reference)
        })
}

fn write_platform_registry(root: &Path, platforms: &[PlatformInfo]) -> Result<(), String> {
    let config_path = root.join(".blackbox").join("workspace.yaml");
    let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let mut document: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
    let mapping = document
        .as_mapping_mut()
        .ok_or_else(|| "workspace.yaml 根节点必须是对象".to_string())?;
    mapping.insert(
        serde_yaml::Value::String("platforms".to_string()),
        serde_yaml::to_value(platforms).map_err(|e| e.to_string())?,
    );
    let updated = serde_yaml::to_string(&document).map_err(|e| e.to_string())?;
    write_internal_text_file(&config_path, updated)
}

#[tauri::command]
pub fn save_workspace_config(
    root_path: String,
    mut config: WorkspaceConfig,
) -> Result<WorkspaceConfig, String> {
    let root = Path::new(&root_path);
    ensure_readable_directory(root)?;
    let config_path = root.join(".blackbox").join("workspace.yaml");
    if !config_path.is_file() {
        return Err("工作区尚未初始化，无法保存设置".to_string());
    }
    if let Some(platform_id) = config.defaults.platform_id.as_deref() {
        let platform_id = platform_id.trim();
        if !platform_id.is_empty()
            && !config
                .platforms
                .iter()
                .any(|platform| platform.id == platform_id)
        {
            return Err(format!("默认平台不存在：{}", platform_id));
        }
        config.defaults.platform_id = (!platform_id.is_empty()).then(|| platform_id.to_string());
    }
    config.defaults.case_template_id = config
        .defaults
        .case_template_id
        .take()
        .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    config.defaults.report_template_id = config
        .defaults
        .report_template_id
        .take()
        .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    config.watcher.debounce_ms = config.watcher.debounce_ms.max(50);
    config.watcher.ignore_patterns = config
        .watcher
        .ignore_patterns
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect();
    config.watcher.ignore_patterns.sort();
    config.watcher.ignore_patterns.dedup();
    config.backup.interval_hours = config.backup.interval_hours.max(1);
    config.backup.max_backups = config.backup.max_backups.max(1);

    let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let mut document: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
    let mapping = document
        .as_mapping_mut()
        .ok_or_else(|| "workspace.yaml 根节点必须是对象".to_string())?;
    mapping.insert(
        serde_yaml::Value::String("defaults".to_string()),
        serde_yaml::to_value(&config.defaults).map_err(|e| e.to_string())?,
    );
    mapping.insert(
        serde_yaml::Value::String("watcher".to_string()),
        serde_yaml::to_value(&config.watcher).map_err(|e| e.to_string())?,
    );
    mapping.insert(
        serde_yaml::Value::String("backup".to_string()),
        serde_yaml::to_value(&config.backup).map_err(|e| e.to_string())?,
    );
    let updated = serde_yaml::to_string(&document).map_err(|e| e.to_string())?;
    write_internal_text_file(&config_path, updated)?;
    Ok(open_workspace(root_path)?.config)
}

fn ensure_readable_directory(root: &Path) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("工作区目录不存在或不是目录: {}", root.display()));
    }
    fs::read_dir(root)
        .map(|_| ())
        .map_err(|error| format!("工作区目录不可读取: {}", error))
}

fn workspace_name(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "工作区".to_string())
}

fn detect_legacy_directories(root: &Path) -> Vec<String> {
    [
        "requirement",
        "requirement_images",
        "testCase",
        "testcasePlan",
        "testReport",
        "business_understanding",
    ]
    .iter()
    .filter(|name| root.join(name).exists())
    .map(|name| (*name).to_string())
    .collect()
}

fn standard_workspace_directories() -> Vec<PathBuf> {
    vec![
        PathBuf::from(".blackbox").join("tasks"),
        PathBuf::from(".blackbox").join("migrations"),
        PathBuf::from(".blackbox").join("logs"),
        PathBuf::from("projects"),
        PathBuf::from("templates").join("testcase").join("xmind"),
        PathBuf::from("templates").join("testcase").join("excel"),
        PathBuf::from("templates").join("report"),
        PathBuf::from("templates").join("prompts"),
        PathBuf::from("knowledge").join("通用"),
        PathBuf::from("tools"),
        PathBuf::from("archive"),
    ]
}

pub(crate) fn standard_requirement_directories() -> Vec<PathBuf> {
    vec![
        PathBuf::from("01-需求资料").join("需求文档"),
        PathBuf::from("01-需求资料").join("需求截图"),
        PathBuf::from("02-需求理解与答疑").join("attachments"),
        PathBuf::from("03-测试计划"),
        PathBuf::from("03-测试计划").join("reviews"),
        PathBuf::from("04-测试用例").join("exports"),
        PathBuf::from("04-测试用例").join("reviews"),
        PathBuf::from("04-测试用例").join("versions"),
        PathBuf::from("05-开发资源").join("前端"),
        PathBuf::from("05-开发资源").join("后端"),
        PathBuf::from("06-测试执行与证据"),
        PathBuf::from("07-测试报告"),
        PathBuf::from("08-知识候选"),
    ]
}

/// 创建需求并生成标准需求目录
#[tauri::command]
pub fn create_requirement(
    root_path: String,
    platform_id: String,
    input: RequirementDraft,
) -> Result<RequirementMeta, String> {
    let (root, config) = load_initialized_workspace(&root_path)?;
    let platform = config
        .platforms
        .iter()
        .find(|platform| platform.id == platform_id)
        .ok_or_else(|| format!("平台不存在：{}", platform_id))?;
    if platform.status == "archived" {
        return Err("归档平台不能创建新需求".to_string());
    }

    let requirement_id = validate_requirement_id(&input.id)?;
    let requirement_name = validate_requirement_name(&input.name)?;
    let initial_stage = validate_requirement_stage(&input.initial_stage)?;
    let platform_dir = root.join(&platform.path);
    fs::create_dir_all(&platform_dir).map_err(|e| e.to_string())?;
    let requirement_dir = platform_dir.join(&requirement_id);
    if requirement_dir.exists() {
        return Err(format!("当前平台下需求编号已存在：{}", requirement_id));
    }

    let applications = normalize_applications(input.applications)?;
    let created_at = chrono_now();
    let meta = RequirementMeta {
        version: "1.0".to_string(),
        requirement: RequirementInfo {
            id: requirement_id,
            name: requirement_name,
            platform: platform.id.clone(),
            owner: input.owner.trim().to_string(),
            created_at,
        },
        status: requirement_stage_label(&initial_stage).to_string(),
        current_stage: initial_stage,
        schedule: ScheduleInfo {
            planned_test_date: normalize_optional_date(input.planned_test_date, "计划提测日期")?,
            planned_release_date: normalize_optional_date(
                input.planned_release_date,
                "计划上线日期",
            )?,
            actual_test_date: None,
            actual_release_date: None,
        },
        applications,
        git_resources: Vec::new(),
        client_access: ClientAccess::default(),
        stage_checklist: Vec::new(),
        blockers: Vec::new(),
        pending_reviews: Vec::new(),
        next_actions: Vec::new(),
        versions: Vec::new(),
        yunxiao: input.yunxiao,
        extensions: input.extensions,
    };

    for relative_path in standard_requirement_directories() {
        fs::create_dir_all(requirement_dir.join(relative_path)).map_err(|e| e.to_string())?;
    }
    let yaml_str = serde_yaml::to_string(&meta).map_err(|e| e.to_string())?;
    write_internal_text_file(&requirement_dir.join("requirement.yaml"), yaml_str)?;
    let _ = append_activity_event(
        &requirement_dir,
        &platform.id,
        &meta.requirement.id,
        RequirementActivityInput {
            action: "requirement_created".to_string(),
            actor: Some("user".to_string()),
            summary: format!(
                "创建需求 {}（{}），初始阶段：{}",
                meta.requirement.id,
                meta.requirement.name,
                requirement_stage_label(&meta.current_stage)
            ),
            ..RequirementActivityInput::default()
        },
    );
    Ok(meta)
}

const AI_TASK_TYPES: &[&str] = &[
    "requirement_inventory",
    "requirement_analysis",
    "question_extraction",
    "answer_impact_analysis",
    "test_plan_generation",
    "testcase_directory_suggestion",
    "testcase_generation",
    "testcase_validation",
    "coverage_check",
    "dev_impact_comparison",
    "review_revision_suggestion",
    "xmind_export",
    "report_generation",
    "knowledge_distillation",
];

fn validate_ai_task_type(value: &str) -> Result<String, String> {
    let task_type = value.trim();
    if AI_TASK_TYPES.contains(&task_type) {
        Ok(task_type.to_string())
    } else {
        Err(format!("不支持的AI任务类型：{}", task_type))
    }
}

fn validate_task_id(value: &str) -> Result<String, String> {
    let task_id = value.trim();
    if task_id.is_empty()
        || !task_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("任务ID只能使用字母、数字、短横线和下划线".to_string());
    }
    Ok(task_id.to_string())
}

fn normalize_task_paths(
    paths: Vec<String>,
    label: &str,
    required: bool,
) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for value in paths {
        if value.trim().is_empty() {
            continue;
        }
        let path = validate_relative_path(&value, label)?;
        if !normalized.iter().any(|existing| existing == &path) {
            normalized.push(path);
        }
    }
    if required && normalized.is_empty() {
        return Err(format!("{}至少需要填写一项", label));
    }
    Ok(normalized)
}

fn normalize_task_inputs(
    root: &Path,
    inputs: Vec<AiTaskFileInput>,
) -> Result<Vec<AiTaskFile>, String> {
    let mut normalized = Vec::new();
    for input in inputs {
        let path = validate_relative_path(&input.path, "输入文件")?;
        if normalized
            .iter()
            .any(|existing: &AiTaskFile| existing.path == path)
        {
            continue;
        }
        let full_path = root.join(&path);
        if !full_path.is_file() {
            return Err(format!("输入文件不存在或不是文件：{}", path));
        }
        let content =
            fs::read(&full_path).map_err(|e| format!("读取输入文件失败 {}：{}", path, e))?;
        normalized.push(AiTaskFile {
            path,
            fingerprint: sha256_hex(&content),
            role: if input.role.trim().is_empty() {
                "任务输入".to_string()
            } else {
                input.role.trim().to_string()
            },
        });
    }
    Ok(normalized)
}

fn normalize_knowledge_scope(
    scopes: Vec<AiKnowledgeScope>,
    config: &WorkspaceConfig,
    default_platform_id: &str,
) -> Result<Vec<AiKnowledgeScope>, String> {
    let mut normalized = Vec::new();
    for item in scopes {
        let scope = item.scope.trim();
        let platform = match scope {
            "general" => None,
            "platform" => {
                let platform_id = item
                    .platform
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(default_platform_id)
                    .trim()
                    .to_string();
                if !config
                    .platforms
                    .iter()
                    .any(|platform| platform.id == platform_id)
                {
                    return Err(format!("知识范围引用的平台不存在：{}", platform_id));
                }
                Some(platform_id)
            }
            "requirement" => Some(default_platform_id.to_string()),
            _ => return Err(format!("不支持的知识范围：{}", scope)),
        };
        let candidate = AiKnowledgeScope {
            scope: scope.to_string(),
            platform,
        };
        if !normalized.iter().any(|existing: &AiKnowledgeScope| {
            existing.scope == candidate.scope && existing.platform == candidate.platform
        }) {
            normalized.push(candidate);
        }
    }
    Ok(normalized)
}

fn knowledge_scope_paths(
    config: &WorkspaceConfig,
    current_platform: &PlatformInfo,
    requirement_id: &str,
    scopes: &[AiKnowledgeScope],
) -> Vec<String> {
    let knowledge_root = config
        .directories
        .get("knowledge")
        .map(String::as_str)
        .unwrap_or("knowledge");
    let mut paths = Vec::new();
    for scope in scopes {
        let path = match scope.scope.as_str() {
            "general" => Path::new(knowledge_root).join("通用"),
            "platform" => config
                .platforms
                .iter()
                .find(|platform| scope.platform.as_deref() == Some(platform.id.as_str()))
                .map(|platform| PathBuf::from(&platform.knowledge_path))
                .unwrap_or_else(|| Path::new(knowledge_root).join(&current_platform.id)),
            "requirement" => Path::new(&current_platform.path)
                .join(requirement_id)
                .join("08-知识候选"),
            _ => continue,
        };
        let relative = path.to_string_lossy().replace('\\', "/");
        if !paths.iter().any(|existing| existing == &relative) {
            paths.push(relative);
        }
    }
    paths
}

fn generate_ai_task_id(root: &Path, requirement_id: &str) -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let token =
        sha256_hex(format!("{}:{}:{}", root.display(), requirement_id, chrono_now()).as_bytes());
    format!("task-{}-{}", stamp, &token[..8])
}

fn render_ai_task_markdown(
    root: &Path,
    task_id: &str,
    task_type: &str,
    platform: &PlatformInfo,
    requirement: &RequirementMeta,
    objective: &str,
    acceptance_criteria: &[String],
    input_files: &[AiTaskFile],
    knowledge_paths: &[String],
    allowed_paths: &[String],
    forbidden_paths: &[String],
    output_dir: &str,
    output_schema: Option<&serde_json::Value>,
    requirement_locked: bool,
) -> String {
    let task_dir = Path::new(".blackbox").join("tasks").join(task_id);
    let inputs = if input_files.is_empty() {
        "- （本任务未指定额外输入文件，请按任务目标读取工作区内公开资料。）\n".to_string()
    } else {
        input_files
            .iter()
            .map(|file| {
                format!(
                    "- `{}`\n  - SHA256：`{}`\n  - 资料角色：{}\n",
                    file.path, file.fingerprint, file.role
                )
            })
            .collect::<Vec<_>>()
            .join("")
    };
    let knowledge = if knowledge_paths.is_empty() {
        "- （未指定知识范围）\n".to_string()
    } else {
        knowledge_paths
            .iter()
            .map(|path| format!("- `{}`\n", path))
            .collect::<Vec<_>>()
            .join("")
    };
    let criteria = acceptance_criteria
        .iter()
        .map(|criterion| format!("- {}\n", criterion))
        .collect::<Vec<_>>()
        .join("");
    let allowed = allowed_paths
        .iter()
        .map(|path| format!("- `{}`\n", path))
        .collect::<Vec<_>>()
        .join("");
    let forbidden = forbidden_paths
        .iter()
        .map(|path| format!("- `{}`\n", path))
        .collect::<Vec<_>>()
        .join("");
    let output_contract = output_schema
        .map(|schema| serde_json::to_string_pretty(schema).unwrap_or_else(|_| "{}".to_string()))
        .unwrap_or_else(|| "{}".to_string());

    format!(
        "# 白泽 AI任务\n\n> 这是可直接交给 Codex、Devin、CLI、IDE 或其他目录型 AI 的标准任务说明。客户端不内嵌聊天或模型，所有协作以工作区文件为准。\n\n## 任务标识\n\n- 任务 ID：`{task_id}`\n- 任务类型：`{task_type}`\n- 工作区：`{root}`\n- 平台：{platform_name}（`{platform_id}`）\n- 需求：{requirement_name}（`{requirement_id}`）\n- 任务目录：`{task_dir}`\n- 创建时需求锁：{locked}\n\n## 目标\n\n{objective}\n\n## 完成标准\n\n{criteria}\n\n## 开始前必须阅读\n\n1. 工作区根目录的 `WORKSPACE.md`。\n2. `.blackbox/workspace.yaml`。\n3. `{task_dir}/manifest.json`、`inputs.json`、`write-scope.json` 和 `output-schema.json`。\n4. 下方列出的输入文件和知识范围。\n\n## 输入文件\n\n{inputs}\n## 知识范围\n\n{knowledge}\n## 写入范围\n\n### 允许新增或修改\n\n{allowed}\n### 禁止新增或修改\n\n{forbidden}\n## 输出\n\n- 主要输出目录：`{output_dir}`\n- 如需结构化输出，必须符合 `output-schema.json`：\n\n```json\n{output_contract}\n```\n\n不要把结果只写在聊天窗口中；必须将产物保存到允许路径，并使用工作区相对路径记录产物。\n\n## 完成时必须更新\n\n1. 开始执行前，将 `{task_dir}/progress.json` 更新为 `running`，同时填写 `updated_at` 和当前 `message`。\n2. 执行过程中持续更新 `progress.json` 的状态和消息。\n3. 完成后将 `progress.json` 更新为 `completed` 或 `failed`。\n4. 在 `{task_dir}/result.json` 写入 `outputs`、`summary`、`validation` 和 `pending_items`；`outputs[].path` 必须是工作区相对路径。\n5. 不要修改 `requirement.yaml`、`.blackbox` 内部协议或禁止路径；不要删除或覆盖已确认资料。\n\n## 交接说明\n\n请在同一工作区根目录执行本任务。若输入文件缺失、写入范围不足或业务口径不明确，应在 `progress.json` 和 `result.json` 中说明，不要猜测或伪造结论。\n",
        task_id = task_id,
        task_type = task_type,
        root = root.to_string_lossy(),
        platform_name = platform.name,
        platform_id = platform.id,
        requirement_name = requirement.requirement.name,
        requirement_id = requirement.requirement.id,
        task_dir = task_dir.to_string_lossy(),
        locked = if requirement_locked { "是" } else { "否" },
        objective = objective,
        criteria = criteria,
        inputs = inputs,
        knowledge = knowledge,
        allowed = allowed,
        forbidden = forbidden,
        output_dir = output_dir,
        output_contract = output_contract,
    )
}

fn default_task_result() -> AiTaskResult {
    AiTaskResult {
        outputs: Vec::new(),
        summary: String::new(),
        validation: AiTaskResultValidation::default(),
        pending_items: Vec::new(),
    }
}

fn read_task_progress(
    task_dir: &Path,
    fallback_status: &str,
    fallback_updated_at: &str,
) -> (AiTaskProgress, Vec<String>) {
    let path = task_dir.join("progress.json");
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            return (
                AiTaskProgress {
                    status: fallback_status.to_string(),
                    updated_at: fallback_updated_at.to_string(),
                    message: String::new(),
                },
                vec![format!("无法读取 progress.json：{}", error)],
            );
        }
    };
    match serde_json::from_str::<AiTaskProgress>(&content) {
        Ok(mut progress) => {
            if progress.status.trim().is_empty() {
                progress.status = fallback_status.to_string();
            }
            if progress.updated_at.trim().is_empty() {
                progress.updated_at = fallback_updated_at.to_string();
            }
            (progress, Vec::new())
        }
        Err(error) => (
            AiTaskProgress {
                status: fallback_status.to_string(),
                updated_at: fallback_updated_at.to_string(),
                message: "progress.json 暂时无法解析，等待外部AI完成写入".to_string(),
            },
            vec![format!("progress.json 不是有效JSON：{}", error)],
        ),
    }
}

fn read_task_result(task_dir: &Path) -> (AiTaskResult, Vec<String>) {
    let path = task_dir.join("result.json");
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            return (
                default_task_result(),
                vec![format!("无法读取 result.json：{}", error)],
            );
        }
    };
    match serde_json::from_str::<AiTaskResult>(&content) {
        Ok(result) => (result, Vec::new()),
        Err(error) => (
            default_task_result(),
            vec![format!("result.json 不是有效JSON：{}", error)],
        ),
    }
}

fn task_snapshot_exclusions(root: &Path, task_dir: &Path) -> Vec<PathBuf> {
    vec![
        task_dir.parent().unwrap_or(task_dir).to_path_buf(),
        root.join(".blackbox").join("snapshots"),
        root.join(".blackbox").join("logs"),
    ]
}

fn read_task_file_changes(task_dir: &Path, root: &Path) -> (FileChanges, Vec<String>) {
    let baseline_path = task_dir.join("baseline.json");
    let content = match fs::read_to_string(&baseline_path) {
        Ok(content) => content,
        Err(_) => {
            return (
                FileChanges::default(),
                vec!["任务基线快照不存在，无法计算完整的任务期间文件变化。".to_string()],
            );
        }
    };
    let old_snapshot = match serde_json::from_str::<HashMap<String, FileEntry>>(&content) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return (
                FileChanges::default(),
                vec![format!("任务基线快照无法解析：{}", error)],
            );
        }
    };
    let exclusions = task_snapshot_exclusions(root, task_dir);
    match generate_file_snapshot_excluding(root, &exclusions) {
        Ok(new_snapshot) => (compare_snapshots(&old_snapshot, &new_snapshot), Vec::new()),
        Err(error) => (
            FileChanges::default(),
            vec![format!("扫描任务期间文件变化失败：{}", error)],
        ),
    }
}

fn normalize_task_result_path(value: &str, label: &str) -> Result<String, String> {
    Ok(validate_relative_path(value, label)?.replace('\\', "/"))
}

fn task_path_matches(pattern: &str, path: &str) -> bool {
    let normalized_pattern = pattern.trim().replace('\\', "/");
    let normalized_path = path.trim().replace('\\', "/");
    if normalized_pattern.is_empty() {
        return false;
    }
    if glob_matches(&normalized_pattern, &normalized_path) {
        return true;
    }
    normalized_pattern
        .strip_suffix("/*")
        .or_else(|| normalized_pattern.strip_suffix("/**"))
        .is_some_and(|base| {
            normalized_path == base || normalized_path.starts_with(&format!("{}/", base))
        })
}

fn task_path_in_scope(path: &str, allowed_paths: &[String], forbidden_paths: &[String]) -> bool {
    let normalized = path.replace('\\', "/");
    allowed_paths
        .iter()
        .any(|pattern| task_path_matches(pattern, &normalized))
        && !forbidden_paths
            .iter()
            .any(|pattern| task_path_matches(pattern, &normalized))
}

fn json_type_matches(value: &serde_json::Value, expected: &str) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn validate_json_schema_basic(
    value: &serde_json::Value,
    schema: &serde_json::Value,
    location: &str,
    errors: &mut Vec<String>,
) {
    if let Some(expected) = schema.get("type").and_then(|item| item.as_str()) {
        if !json_type_matches(value, expected) {
            errors.push(format!("{} 类型应为 {}", location, expected));
            return;
        }
    } else if let Some(types) = schema.get("type").and_then(|item| item.as_array()) {
        if !types
            .iter()
            .filter_map(|item| item.as_str())
            .any(|item| json_type_matches(value, item))
        {
            errors.push(format!("{} 类型不符合Schema", location));
            return;
        }
    }
    if let Some(enum_values) = schema.get("enum").and_then(|item| item.as_array()) {
        if !enum_values.iter().any(|candidate| candidate == value) {
            errors.push(format!("{} 不在Schema允许的枚举值内", location));
        }
    }
    if let Some(required) = schema.get("required").and_then(|item| item.as_array()) {
        if let Some(object) = value.as_object() {
            for field in required.iter().filter_map(|item| item.as_str()) {
                if !object.contains_key(field) {
                    errors.push(format!("{} 缺少必填字段 {}", location, field));
                }
            }
        }
    }
    if let (Some(object), Some(properties)) = (
        value.as_object(),
        schema.get("properties").and_then(|item| item.as_object()),
    ) {
        for (field, field_schema) in properties {
            if let Some(field_value) = object.get(field) {
                validate_json_schema_basic(
                    field_value,
                    field_schema,
                    &format!("{}.{}", location, field),
                    errors,
                );
            }
        }
    }
    if let (Some(items), Some(item_schema)) = (value.as_array(), schema.get("items")) {
        for (index, item) in items.iter().enumerate() {
            validate_json_schema_basic(
                item,
                item_schema,
                &format!("{}[{}]", location, index),
                errors,
            );
        }
    }
    if let Some(min_items) = schema.get("minItems").and_then(|item| item.as_u64()) {
        if value
            .as_array()
            .is_some_and(|items| items.len() < min_items as usize)
        {
            errors.push(format!("{} 至少需要 {} 项", location, min_items));
        }
    }
    if let Some(min_length) = schema.get("minLength").and_then(|item| item.as_u64()) {
        if value
            .as_str()
            .is_some_and(|text| text.chars().count() < min_length as usize)
        {
            errors.push(format!("{} 长度不能少于 {}", location, min_length));
        }
    }
}

fn validate_ai_task_result(
    root: &Path,
    result: &AiTaskResult,
    output_schema: Option<&serde_json::Value>,
    allowed_paths: &[String],
    forbidden_paths: &[String],
    changes: &FileChanges,
    parse_warnings: &[String],
    change_warnings: &[String],
) -> AiTaskValidation {
    let mut validation = AiTaskValidation {
        passed: true,
        errors: Vec::new(),
        warnings: Vec::new(),
        out_of_scope_paths: Vec::new(),
        artifacts: Vec::new(),
    };
    validation.errors.extend(parse_warnings.iter().cloned());
    validation.warnings.extend(change_warnings.iter().cloned());
    if !result.validation.passed && !result.validation.errors.is_empty() {
        validation.warnings.extend(
            result
                .validation
                .errors
                .iter()
                .map(|error| format!("外部AI自检：{}", error)),
        );
    }

    for output in &result.outputs {
        let mut check = AiTaskArtifactCheck {
            path: output.path.clone(),
            exists: false,
            in_scope: false,
            json_valid: None,
            errors: Vec::new(),
        };
        let path = match normalize_task_result_path(&output.path, "产物路径") {
            Ok(path) => path,
            Err(error) => {
                check.errors.push(error);
                validation.errors.extend(check.errors.iter().cloned());
                validation.artifacts.push(check);
                continue;
            }
        };
        check.in_scope = task_path_in_scope(&path, allowed_paths, forbidden_paths);
        if !check.in_scope {
            let message = format!("产物路径越出写入范围：{}", path);
            check.errors.push(message.clone());
            validation.errors.push(message);
            validation.out_of_scope_paths.push(path.clone());
        }
        let full_path = root.join(&path);
        check.exists = full_path.is_file();
        if !check.exists {
            let message = format!("result.json 声明的产物不存在：{}", path);
            check.errors.push(message.clone());
            validation.errors.push(message);
        }
        let is_json = output.output_type.eq_ignore_ascii_case("json")
            || path.to_ascii_lowercase().ends_with(".json");
        if is_json && check.exists {
            match fs::read_to_string(&full_path)
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
            {
                Some(value) => {
                    check.json_valid = Some(true);
                    if let Some(schema) = output_schema {
                        let mut schema_errors = Vec::new();
                        validate_json_schema_basic(&value, schema, &path, &mut schema_errors);
                        check.errors.extend(schema_errors.iter().cloned());
                        validation.errors.extend(schema_errors);
                    }
                }
                None => {
                    check.json_valid = Some(false);
                    let message = format!("JSON产物无法解析：{}", path);
                    check.errors.push(message.clone());
                    validation.errors.push(message);
                }
            }
        }
        validation.artifacts.push(check);
    }

    let mut changed_paths = changes.added.clone();
    changed_paths.extend(changes.modified.clone());
    changed_paths.extend(changes.deleted.clone());
    for movement in &changes.moved {
        changed_paths.push(movement.from.clone());
        changed_paths.push(movement.to.clone());
    }
    changed_paths.sort();
    changed_paths.dedup();
    for path in changed_paths {
        if !task_path_in_scope(&path, allowed_paths, forbidden_paths) {
            let normalized = path.replace('\\', "/");
            if !validation.out_of_scope_paths.contains(&normalized) {
                validation.out_of_scope_paths.push(normalized.clone());
                validation
                    .errors
                    .push(format!("任务期间修改路径越出写入范围：{}", normalized));
            }
        }
    }
    validation.passed = validation.errors.is_empty();
    validation
}

fn effective_task_status(
    manifest_status: &str,
    progress_status: &str,
    review_status: &str,
) -> String {
    if review_status == "accepted" {
        return "completed".to_string();
    }
    if review_status == "rejected" {
        return "failed".to_string();
    }
    match progress_status.trim() {
        "pending" | "running" | "waiting_review" | "completed" | "failed" => {
            if progress_status == "completed" {
                "waiting_review".to_string()
            } else {
                progress_status.to_string()
            }
        }
        _ => manifest_status.to_string(),
    }
}

fn read_ai_task_info(task_dir: &Path, root: &Path) -> Result<AiTaskInfo, String> {
    let manifest_path = task_dir.join("manifest.json");
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let text = |key: &str| {
        manifest
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("manifest.json缺少字段：{}", key))
    };
    let task_id = validate_task_id(&text("task_id")?)?;
    let task_type = text("task_type")?;
    let platform_id = manifest
        .get("platform_id")
        .or_else(|| manifest.get("platform"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let requirement_id = text("requirement_id")?;
    let manifest_status = text("status")?;
    let created_at = text("created_at")?;
    let manifest_updated_at = manifest
        .get("updated_at")
        .and_then(|value| value.as_str())
        .unwrap_or(&created_at)
        .to_string();
    let objective = manifest
        .get("objective")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let acceptance_criteria = manifest
        .get("acceptance_criteria")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let inputs: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(task_dir.join("inputs.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let input_files = serde_json::from_value(
        inputs
            .get("files")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;
    let knowledge_scope = serde_json::from_value(
        inputs
            .get("knowledge_scope")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;
    let write_scope: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(task_dir.join("write-scope.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let allowed_paths = serde_json::from_value::<Vec<String>>(
        write_scope
            .get("allowed_paths")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;
    let forbidden_paths = serde_json::from_value::<Vec<String>>(
        write_scope
            .get("forbidden_paths")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;
    let output_dir = write_scope
        .get("output_dir")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .replace('\\', "/");
    let mut parse_warnings = Vec::new();
    let output_schema = match fs::read_to_string(task_dir.join("output-schema.json")) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(value) if value != serde_json::json!({}) => Some(value),
            Ok(_) => None,
            Err(error) => {
                parse_warnings.push(format!("output-schema.json 不是有效JSON：{}", error));
                None
            }
        },
        Err(error) => {
            parse_warnings.push(format!("无法读取 output-schema.json：{}", error));
            None
        }
    };
    let (progress, progress_warnings) =
        read_task_progress(task_dir, &manifest_status, &manifest_updated_at);
    parse_warnings.extend(progress_warnings);
    let (result, result_warnings) = read_task_result(task_dir);
    parse_warnings.extend(result_warnings);
    let (file_changes, change_warnings) = read_task_file_changes(task_dir, root);
    let lock_requirement = manifest
        .get("lock_requirement")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let requirement_locked = manifest
        .get("requirement_locked")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let execution_mode = manifest
        .get("execution_mode")
        .and_then(|value| value.as_str())
        .unwrap_or("external")
        .to_string();
    let review_status = manifest
        .get("review_status")
        .and_then(|value| value.as_str())
        .unwrap_or("pending")
        .to_string();
    let review_note = manifest
        .get("review_note")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let status = effective_task_status(&manifest_status, &progress.status, &review_status);
    let updated_at = if progress.updated_at > manifest_updated_at {
        progress.updated_at.clone()
    } else {
        manifest_updated_at
    };
    let validation = validate_ai_task_result(
        root,
        &result,
        output_schema.as_ref(),
        &allowed_paths,
        &forbidden_paths,
        &file_changes,
        &parse_warnings,
        &change_warnings,
    );
    let awaiting_confirmation = review_status == "pending"
        && (status == "waiting_review"
            || (!result.outputs.is_empty() && progress.status != "failed"));
    let task_dir = task_dir
        .strip_prefix(root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let task_dir_path = root.join(&task_dir);
    let dispatch_text = fs::read_to_string(task_dir_path.join("prompt.md"))
        .or_else(|_| fs::read_to_string(task_dir_path.join("task.md")))
        .unwrap_or_default();
    Ok(AiTaskInfo {
        task_id,
        task_type,
        platform_id,
        requirement_id,
        status,
        created_at,
        updated_at,
        objective,
        acceptance_criteria,
        task_dir,
        input_files,
        knowledge_scope,
        allowed_paths,
        forbidden_paths,
        output_dir,
        output_schema,
        lock_requirement,
        requirement_locked,
        execution_mode,
        dispatch_text,
        progress,
        result: result.clone(),
        file_changes,
        validation,
        artifact_count: result.outputs.len(),
        awaiting_confirmation,
        review_status,
        review_note,
    })
}

/// 创建标准AI任务包，并按选项锁定关联需求目录
#[tauri::command]
pub fn create_ai_task(root_path: String, input: AiTaskDraft) -> Result<AiTaskInfo, String> {
    let (root, config) = load_initialized_workspace(&root_path)?;
    let task_type = validate_ai_task_type(&input.task_type)?;
    let platform_id = input.platform_id.trim().to_string();
    let platform = config
        .platforms
        .iter()
        .find(|platform| platform.id == platform_id)
        .ok_or_else(|| format!("平台不存在：{}", platform_id))?;
    if platform.status == "archived" {
        return Err("归档平台不能创建新的AI任务".to_string());
    }
    let requirement_id = validate_requirement_id(&input.requirement_id)?;
    let (_requirement_dir, _meta_path, requirement) =
        load_requirement_for_access(&root_path, &platform.path, &requirement_id)?;
    if requirement.requirement.platform != platform.id {
        return Err("需求所属平台与任务选择的平台不一致".to_string());
    }
    let objective = input.objective.trim().to_string();
    if objective.is_empty() {
        return Err("任务目标不能为空".to_string());
    }
    let acceptance_criteria = input
        .acceptance_criteria
        .into_iter()
        .map(|criterion| criterion.trim().to_string())
        .filter(|criterion| !criterion.is_empty())
        .collect::<Vec<_>>();
    if acceptance_criteria.is_empty() {
        return Err("完成标准至少需要填写一项".to_string());
    }
    if input.lock_requirement && requirement.client_access.mode == "locked_for_ai" {
        return Err(format!(
            "需求已锁定，请先完成解锁确认（任务：{}）",
            requirement
                .client_access
                .task_id
                .as_deref()
                .unwrap_or("未关联任务")
        ));
    }
    let input_files = normalize_task_inputs(&root, input.input_files)?;
    let knowledge_scope = normalize_knowledge_scope(input.knowledge_scope, &config, &platform.id)?;
    let knowledge_paths =
        knowledge_scope_paths(&config, platform, &requirement_id, &knowledge_scope);
    let allowed_paths = normalize_task_paths(input.allowed_paths, "允许写入路径", true)?;
    let mut forbidden_paths = normalize_task_paths(input.forbidden_paths, "禁止写入路径", false)?;
    let requirement_relative_dir = Path::new(&platform.path).join(&requirement_id);
    let protected_paths = [
        Path::new(".blackbox")
            .join("**")
            .to_string_lossy()
            .replace('\\', "/"),
        requirement_relative_dir
            .join("requirement.yaml")
            .to_string_lossy()
            .replace('\\', "/"),
    ];
    for path in protected_paths {
        if !forbidden_paths.iter().any(|existing| existing == &path) {
            forbidden_paths.push(path);
        }
    }
    let output_dir = validate_relative_path(&input.output_dir, "目标输出目录")?;
    let output_schema = input.output_schema.filter(|value| !value.is_null());
    if output_schema
        .as_ref()
        .is_some_and(|value| !value.is_object())
    {
        return Err("输出Schema必须是JSON对象".to_string());
    }

    let blackbox_dir = config
        .directories
        .get("blackbox")
        .map(String::as_str)
        .unwrap_or(".blackbox");
    let tasks_dir = root.join(blackbox_dir).join("tasks");
    fs::create_dir_all(&tasks_dir).map_err(|e| e.to_string())?;
    let mut task_id = generate_ai_task_id(&root, &requirement_id);
    while tasks_dir.join(&task_id).exists() {
        task_id = format!(
            "{}-{}",
            generate_ai_task_id(&root, &requirement_id),
            task_id.len()
        );
    }
    let task_dir = tasks_dir.join(&task_id);
    fs::create_dir_all(task_dir.join("logs")).map_err(|e| e.to_string())?;
    let created_at = chrono_now();
    let requirement_locked =
        requirement.client_access.mode == "locked_for_ai" || input.lock_requirement;
    if input.lock_requirement {
        lock_requirement(
            root_path,
            platform.path.clone(),
            requirement_id.clone(),
            task_id.clone(),
            objective.clone(),
            "用户".to_string(),
        )?;
    }
    let baseline =
        generate_file_snapshot_excluding(&root, &task_snapshot_exclusions(&root, &task_dir))?;
    write_internal_text_file(
        &task_dir.join("baseline.json"),
        serde_json::to_string_pretty(&baseline).map_err(|e| e.to_string())?,
    )?;
    let task_markdown = render_ai_task_markdown(
        &root,
        &task_id,
        &task_type,
        platform,
        &requirement,
        &objective,
        &acceptance_criteria,
        &input_files,
        &knowledge_paths,
        &allowed_paths,
        &forbidden_paths,
        &output_dir,
        output_schema.as_ref(),
        requirement_locked,
    );
    let manifest = serde_json::json!({
        "version": "1.0",
        "task_id": task_id,
        "task_type": task_type,
        "requirement_id": requirement_id,
        "platform": platform.id,
        "platform_id": platform.id,
        "status": "pending",
        "created_at": created_at,
        "updated_at": created_at,
        "started_at": serde_json::Value::Null,
        "completed_at": serde_json::Value::Null,
        "previous_task_id": serde_json::Value::Null,
        "ai_tool": serde_json::Value::Null,
        "objective": objective,
        "acceptance_criteria": acceptance_criteria,
        "output_dir": output_dir,
        "lock_requirement": input.lock_requirement,
        "requirement_locked": requirement_locked,
        "execution_mode": input.execution_mode.clone().unwrap_or_else(|| "external".to_string()),
        "review_status": "pending",
        "reviewed_at": serde_json::Value::Null,
        "review_note": "",
    });
    let inputs_json = serde_json::json!({
        "files": input_files,
        "knowledge_scope": knowledge_scope,
        "knowledge_paths": knowledge_paths,
        "templates": [],
    });
    let write_scope_json = serde_json::json!({
        "allowed_paths": allowed_paths,
        "forbidden_paths": forbidden_paths,
        "output_dir": output_dir,
    });
    let progress_json = serde_json::json!({
        "status": "pending",
        "updated_at": created_at,
        "message": "任务已创建，等待外部AI执行",
    });
    let result_json = serde_json::json!({
        "outputs": [],
        "summary": "",
        "validation": { "passed": false, "errors": [] },
        "pending_items": ["等待外部AI更新 result.json"],
    });
    write_internal_text_file(&task_dir.join("task.md"), task_markdown.clone())?;
    if let Some(prompt) = input
        .prompt_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let resolved_prompt = prompt.replace("{{task_id}}", &task_id);
        write_internal_text_file(&task_dir.join("prompt.md"), resolved_prompt)?;
    }
    write_internal_text_file(
        &task_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )?;
    write_internal_text_file(
        &task_dir.join("inputs.json"),
        serde_json::to_string_pretty(&inputs_json).map_err(|e| e.to_string())?,
    )?;
    write_internal_text_file(
        &task_dir.join("write-scope.json"),
        serde_json::to_string_pretty(&write_scope_json).map_err(|e| e.to_string())?,
    )?;
    write_internal_text_file(
        &task_dir.join("output-schema.json"),
        serde_json::to_string_pretty(
            &output_schema
                .clone()
                .unwrap_or_else(|| serde_json::json!({})),
        )
        .map_err(|e| e.to_string())?,
    )?;
    write_internal_text_file(
        &task_dir.join("progress.json"),
        serde_json::to_string_pretty(&progress_json).map_err(|e| e.to_string())?,
    )?;
    write_internal_text_file(
        &task_dir.join("result.json"),
        serde_json::to_string_pretty(&result_json).map_err(|e| e.to_string())?,
    )?;

    let requirement_dir = root.join(&platform.path).join(&requirement_id);
    let task_markdown_ref = task_dir
        .strip_prefix(&root)
        .map(|path| format!("{}/task.md", path.to_string_lossy().replace('\\', "/")))
        .unwrap_or_else(|_| format!(".blackbox/tasks/{}/task.md", task_id));
    let _ = append_activity_event(
        &requirement_dir,
        &platform.id,
        &requirement_id,
        RequirementActivityInput {
            action: "ai_task_created".to_string(),
            summary: format!("创建AI任务 {}（{}）", task_id, task_type),
            object_id: Some(task_id.clone()),
            refs: vec![task_markdown_ref],
            ..RequirementActivityInput::default()
        },
    );

    read_ai_task_info(&task_dir, &root)
}

fn write_task_progress(task_dir: &Path, status: &str, message: &str) -> Result<(), String> {
    let path = task_dir.join("progress.json");
    let mut progress: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(object) = progress.as_object_mut() {
        object.insert("status".to_string(), serde_json::json!(status));
        object.insert("message".to_string(), serde_json::json!(message));
        object.insert("updated_at".to_string(), serde_json::json!(chrono_now()));
    }
    write_internal_text_file(
        &path,
        serde_json::to_string_pretty(&progress).map_err(|e| e.to_string())?,
    )
}

fn ai_task_output_file_name(task_type: &str) -> &'static str {
    match task_type {
        "requirement_analysis" | "requirement_inventory" => "需求理解.md",
        "test_plan_generation" => "测试计划.md",
        "testcase_generation" | "testcase_directory_suggestion" => "用例草稿.md",
        "testcase_validation" | "coverage_check" => "用例检查.md",
        "dev_impact_comparison" | "review_revision_suggestion" => "评审建议.md",
        "report_generation" => "测试报告草稿.md",
        "knowledge_distillation" => "知识候选.md",
        _ => "ai-output.md",
    }
}

/// 使用客户端配置的 OpenAI 兼容模型直接执行 AI 任务，并把产物写回工作区。
#[tauri::command]
pub async fn run_ai_task(
    root_path: String,
    task_id: String,
    base_url: String,
    api_key: String,
    model: String,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<AiTaskInfo, String> {
    let (root, _config, task_dir, manifest) = load_ai_task_context(&root_path, &task_id)?;
    let task_type = manifest
        .get("task_type")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let prompt_text = fs::read_to_string(task_dir.join("prompt.md"))
        .or_else(|_| fs::read_to_string(task_dir.join("task.md")))
        .unwrap_or_default();
    if prompt_text.trim().is_empty() {
        return Err("任务缺少 task.md / prompt.md，无法执行".to_string());
    }
    let write_scope: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(task_dir.join("write-scope.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let output_dir = write_scope
        .get("output_dir")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .replace('\\', "/");
    if output_dir.trim().is_empty() {
        return Err("任务未指定输出目录".to_string());
    }
    let allowed_paths: Vec<String> = serde_json::from_value(
        write_scope
            .get("allowed_paths")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;
    let forbidden_paths: Vec<String> = serde_json::from_value(
        write_scope
            .get("forbidden_paths")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;

    let inputs: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(task_dir.join("inputs.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let input_files: Vec<AiTaskFileInput> = serde_json::from_value(
        inputs
            .get("files")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;
    let mut input_sections = Vec::new();
    for file in &input_files {
        let absolute = root.join(file.path.replace('\\', "/"));
        let content = match fs::read_to_string(&absolute) {
            Ok(text) => text.chars().take(20000).collect::<String>(),
            Err(_) => {
                "（二进制或办公文档，客户端未提取正文，请结合文件名、需求元数据和需求理解文档作答）"
                    .to_string()
            }
        };
        input_sections.push(format!(
            "### {}\n角色：{}\n\n{}",
            file.path, file.role, content
        ));
    }

    write_task_progress(&task_dir, "running", "客户端模型开始执行任务")?;

    let system = "你是白泽工作台的软件测试专家。请直接完成用户给出的任务，只输出最终产物正文（Markdown），不要寒暄，不要解释你将要做什么。";
    let user = format!(
        "{prompt}\n\n## 输入文件内容\n\n{inputs}\n",
        prompt = prompt_text,
        inputs = if input_sections.is_empty() {
            "（无）".to_string()
        } else {
            input_sections.join("\n\n")
        }
    );

    let reply = chat_completion(
        base_url,
        api_key,
        model,
        vec![
            ChatMessage {
                role: "system".to_string(),
                content: serde_json::json!(system),
            },
            ChatMessage {
                role: "user".to_string(),
                content: serde_json::json!(user),
            },
        ],
        temperature,
        max_tokens,
    )
    .await;

    let content = match reply {
        Ok(content) => content,
        Err(error) => {
            let _ =
                write_task_progress(&task_dir, "failed", &format!("客户端模型执行失败：{error}"));
            return Err(format!("客户端模型执行失败：{error}"));
        }
    };

    let file_name = ai_task_output_file_name(&task_type);
    let output_rel = format!("{}/{}", output_dir.trim_end_matches('/'), file_name);
    if !task_path_in_scope(&output_rel, &allowed_paths, &forbidden_paths) {
        let _ = write_task_progress(&task_dir, "failed", "模型输出路径不在允许范围内");
        return Err(format!("模型输出路径不在允许范围内：{}", output_rel));
    }
    let output_absolute = root.join(&output_rel);
    if let Some(parent) = output_absolute.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&output_absolute, &content).map_err(|e| e.to_string())?;

    let summary: String = content
        .chars()
        .take(200)
        .collect::<String>()
        .replace('\n', " ");
    let result_json = serde_json::json!({
        "outputs": [{
            "path": output_rel,
            "type": "markdown",
            "summary": summary,
        }],
        "summary": summary,
        "validation": { "passed": true, "errors": [] },
        "pending_items": [],
    });
    write_internal_text_file(
        &task_dir.join("result.json"),
        serde_json::to_string_pretty(&result_json).map_err(|e| e.to_string())?,
    )?;
    write_task_progress(&task_dir, "completed", "客户端模型已完成任务")?;

    read_ai_task_info(&task_dir, &root)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTaskOutputInput {
    pub path: String,
    #[serde(default, rename = "type")]
    pub output_type: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, rename = "contentBase64")]
    pub content_base64: Option<String>,
}

/// 写入客户端模型生成的产物，并更新 result.json / progress.json。
///
/// 产物由前端生成（md/docx/xmind/xlsx），这里统一做写入范围校验并落盘，
/// 使用内部写入绕过需求锁（需求锁只限制客户端业务写入，不限制AI任务产物）。
#[tauri::command]
pub fn write_ai_task_outputs(
    root_path: String,
    task_id: String,
    outputs: Vec<AiTaskOutputInput>,
    summary: String,
    pending_items: Vec<String>,
) -> Result<AiTaskInfo, String> {
    let (root, _config, task_dir, _manifest) = load_ai_task_context(&root_path, &task_id)?;
    if outputs.is_empty() {
        return Err("模型没有返回任何产物".to_string());
    }
    let write_scope: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(task_dir.join("write-scope.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let allowed_paths: Vec<String> = serde_json::from_value(
        write_scope
            .get("allowed_paths")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;
    let forbidden_paths: Vec<String> = serde_json::from_value(
        write_scope
            .get("forbidden_paths")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;

    let mut result_outputs = Vec::new();
    for output in &outputs {
        let relative = output.path.replace('\\', "/");
        if !task_path_in_scope(&relative, &allowed_paths, &forbidden_paths) {
            return Err(format!("产物路径不在允许范围内：{}", relative));
        }
        let absolute = root.join(&relative);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if let Some(encoded) = output.content_base64.as_deref() {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|e| format!("产物 {} base64 解码失败：{}", relative, e))?;
            fs::write(&absolute, bytes).map_err(|e| e.to_string())?;
        } else {
            let content = output.content.clone().unwrap_or_default();
            fs::write(&absolute, content).map_err(|e| e.to_string())?;
        }
        result_outputs.push(serde_json::json!({
            "path": relative,
            "type": output.output_type,
            "summary": output.summary,
        }));
    }

    let result_json = serde_json::json!({
        "outputs": result_outputs,
        "summary": summary,
        "validation": { "passed": true, "errors": [] },
        "pending_items": pending_items,
    });
    write_internal_text_file(
        &task_dir.join("result.json"),
        serde_json::to_string_pretty(&result_json).map_err(|e| e.to_string())?,
    )?;
    write_task_progress(&task_dir, "completed", "客户端模型已完成任务")?;

    read_ai_task_info(&task_dir, &root)
}

/// 读取工作区内已经生成的标准AI任务包
#[tauri::command]
pub fn list_ai_tasks(root_path: String) -> Result<Vec<AiTaskInfo>, String> {
    let (root, config) = load_initialized_workspace(&root_path)?;
    let blackbox_dir = config
        .directories
        .get("blackbox")
        .map(String::as_str)
        .unwrap_or(".blackbox");
    let tasks_dir = root.join(blackbox_dir).join("tasks");
    if !tasks_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut tasks = fs::read_dir(tasks_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| read_ai_task_info(&entry.path(), &root).ok())
        .collect::<Vec<_>>();
    tasks.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(tasks)
}

fn load_ai_task_context(
    root_path: &str,
    task_id: &str,
) -> Result<(PathBuf, WorkspaceConfig, PathBuf, serde_json::Value), String> {
    let (root, config) = load_initialized_workspace(root_path)?;
    let task_id = validate_task_id(task_id)?;
    let blackbox_dir = config
        .directories
        .get("blackbox")
        .map(String::as_str)
        .unwrap_or(".blackbox");
    let task_dir = root.join(blackbox_dir).join("tasks").join(&task_id);
    if !task_dir.is_dir() {
        return Err(format!("AI任务不存在：{}", task_id));
    }
    let manifest = serde_json::from_str(
        &fs::read_to_string(task_dir.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("manifest.json 不是有效JSON：{}", e))?;
    Ok((root, config, task_dir, manifest))
}

fn write_ai_task_manifest(task_dir: &Path, manifest: &serde_json::Value) -> Result<(), String> {
    write_internal_text_file(
        &task_dir.join("manifest.json"),
        serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?,
    )
}

fn task_platform_and_requirement(
    root: &Path,
    config: &WorkspaceConfig,
    manifest: &serde_json::Value,
) -> Result<(PlatformInfo, RequirementMeta), String> {
    let platform_id = manifest
        .get("platform_id")
        .or_else(|| manifest.get("platform"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| "manifest.json 缺少 platform_id".to_string())?;
    let platform = config
        .platforms
        .iter()
        .find(|item| item.id == platform_id)
        .cloned()
        .ok_or_else(|| format!("任务关联的平台不存在：{}", platform_id))?;
    let requirement_id = manifest
        .get("requirement_id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "manifest.json 缺少 requirement_id".to_string())?;
    let requirement_path = root
        .join(&platform.path)
        .join(validate_requirement_id(requirement_id)?);
    let content = fs::read_to_string(requirement_path.join("requirement.yaml"))
        .map_err(|e| format!("读取任务关联需求失败：{}", e))?;
    let requirement = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
    Ok((platform, requirement))
}

fn update_task_review_manifest(
    task_dir: &Path,
    mut manifest: serde_json::Value,
    status: &str,
    review_status: &str,
    note: &str,
    requirement_locked: Option<bool>,
) -> Result<serde_json::Value, String> {
    let now = chrono_now();
    manifest["status"] = serde_json::Value::String(status.to_string());
    manifest["updated_at"] = serde_json::Value::String(now.clone());
    manifest["review_status"] = serde_json::Value::String(review_status.to_string());
    manifest["reviewed_at"] = serde_json::Value::String(now);
    manifest["review_note"] = serde_json::Value::String(note.trim().to_string());
    if status == "completed" || status == "failed" {
        manifest["completed_at"] = serde_json::Value::String(chrono_now());
    }
    if let Some(locked) = requirement_locked {
        manifest["requirement_locked"] = serde_json::Value::Bool(locked);
    }
    write_ai_task_manifest(task_dir, &manifest)?;
    Ok(manifest)
}

/// 在任务关联需求的活动台账中追加事件（best-effort，不阻断任务操作本身）
fn record_task_activity(
    root: &Path,
    config: &WorkspaceConfig,
    manifest: &serde_json::Value,
    action: &str,
    summary: &str,
    object_id: Option<String>,
    refs: Vec<String>,
) {
    let Ok((platform, requirement)) = task_platform_and_requirement(root, config, manifest) else {
        return;
    };
    let req_dir = root.join(&platform.path).join(&requirement.requirement.id);
    let _ = append_activity_event(
        &req_dir,
        &platform.id,
        &requirement.requirement.id,
        RequirementActivityInput {
            action: action.to_string(),
            summary: summary.to_string(),
            object_id,
            refs,
            ..RequirementActivityInput::default()
        },
    );
}

fn validate_task_ready_for_review(info: &AiTaskInfo) -> Result<(), String> {
    if !info.awaiting_confirmation {
        return Err("任务尚未进入待确认状态，请等待 progress.json 标记 completed".to_string());
    }
    if !info.validation.passed {
        return Err(format!(
            "结果基础校验未通过：{}",
            info.validation.errors.join("；")
        ));
    }
    Ok(())
}

fn read_task_action_result(
    root: &Path,
    task_dir: &Path,
    config: &WorkspaceConfig,
    warnings: Vec<String>,
) -> Result<AiTaskActionResult, String> {
    let task = read_ai_task_info(task_dir, root)?;
    let (_, requirement) = task_platform_and_requirement(
        root,
        config,
        &serde_json::from_str(
            &fs::read_to_string(task_dir.join("manifest.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?,
    )?;
    Ok(AiTaskActionResult {
        task,
        requirement: Some(requirement),
        warnings,
    })
}

fn rebind_requirement_task(
    root_path: &str,
    platform_path: &str,
    requirement_id: &str,
    previous_task_id: &str,
    next_task_id: &str,
    note: &str,
) -> Result<RequirementMeta, String> {
    let (req_path, meta_path, mut meta) =
        load_requirement_for_access(root_path, platform_path, requirement_id)?;
    ensure_locked(&meta)?;
    if meta.client_access.task_id.as_deref() != Some(previous_task_id) {
        return Err("需求当前锁定任务已变化，不能覆盖其他任务的锁状态".to_string());
    }
    let snapshot = generate_file_snapshot(&req_path)?;
    let snapshot_path = format!(
        ".blackbox/snapshots/{}.json",
        sha256_hex(format!("{}:{}", requirement_id, next_task_id).as_bytes())
    );
    write_atomic_bytes(
        &Path::new(root_path).join(&snapshot_path),
        serde_json::to_string_pretty(&snapshot)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )?;
    meta.client_access.task_id = Some(next_task_id.to_string());
    meta.client_access.locked_at = Some(chrono_now());
    meta.client_access.note = note.trim().to_string();
    meta.client_access.snapshot_path = Some(snapshot_path);
    write_internal_text_file(
        &meta_path,
        serde_yaml::to_string(&meta).map_err(|e| e.to_string())?,
    )?;
    Ok(meta)
}

#[tauri::command]
pub fn accept_ai_task_result(
    root_path: String,
    task_id: String,
) -> Result<AiTaskActionResult, String> {
    let (root, config, task_dir, manifest) = load_ai_task_context(&root_path, &task_id)?;
    let info = read_ai_task_info(&task_dir, &root)?;
    validate_task_ready_for_review(&info)?;
    update_task_review_manifest(
        &task_dir,
        manifest.clone(),
        "completed",
        "accepted",
        "",
        None,
    )?;
    record_task_activity(
        &root,
        &config,
        &manifest,
        "ai_task_accepted",
        &format!("接受AI任务结果（{}）", task_id),
        Some(task_id.clone()),
        Vec::new(),
    );
    read_task_action_result(&root, &task_dir, &config, Vec::new())
}

#[tauri::command]
pub fn reject_ai_task_result(
    root_path: String,
    task_id: String,
    note: String,
) -> Result<AiTaskActionResult, String> {
    let (root, config, task_dir, manifest) = load_ai_task_context(&root_path, &task_id)?;
    let info = read_ai_task_info(&task_dir, &root)?;
    if !info.awaiting_confirmation {
        return Err("任务尚未进入待确认状态，不能拒绝结果".to_string());
    }
    let note = if note.trim().is_empty() {
        "用户拒绝结果，需求保持锁定".to_string()
    } else {
        note.trim().to_string()
    };
    update_task_review_manifest(
        &task_dir,
        manifest.clone(),
        "failed",
        "rejected",
        &note,
        None,
    )?;
    record_task_activity(
        &root,
        &config,
        &manifest,
        "ai_task_rejected",
        &format!("拒绝AI任务结果（{}）：{}", task_id, note),
        Some(task_id.clone()),
        Vec::new(),
    );
    read_task_action_result(&root, &task_dir, &config, vec![note])
}

#[tauri::command]
pub fn accept_and_unlock_ai_task(
    root_path: String,
    task_id: String,
) -> Result<AiTaskActionResult, String> {
    let (root, config, task_dir, manifest) = load_ai_task_context(&root_path, &task_id)?;
    let info = read_ai_task_info(&task_dir, &root)?;
    validate_task_ready_for_review(&info)?;
    let (platform, requirement) = task_platform_and_requirement(&root, &config, &manifest)?;
    let mut warnings = Vec::new();
    if requirement.client_access.mode == "locked_for_ai" {
        if requirement.client_access.task_id.as_deref() != Some(info.task_id.as_str()) {
            return Err("需求当前由其他AI任务锁定，不能直接接受并解锁".to_string());
        }
        let unlock = accept_unlock_requirement(
            root_path.clone(),
            platform.path,
            requirement.requirement.id.clone(),
        )?;
        warnings.extend(unlock.warnings);
    }
    update_task_review_manifest(
        &task_dir,
        manifest.clone(),
        "completed",
        "accepted",
        "",
        Some(false),
    )?;
    record_task_activity(
        &root,
        &config,
        &manifest,
        "ai_task_accepted",
        &format!("接受AI任务结果并解锁（{}）", task_id),
        Some(task_id.clone()),
        Vec::new(),
    );
    read_task_action_result(&root, &task_dir, &config, warnings)
}

#[tauri::command]
pub fn redispatch_ai_task(
    root_path: String,
    task_id: String,
) -> Result<AiTaskActionResult, String> {
    let (root, config, task_dir, manifest) = load_ai_task_context(&root_path, &task_id)?;
    let info = read_ai_task_info(&task_dir, &root)?;
    if matches!(info.status.as_str(), "pending" | "running") {
        return Err("任务尚未完成，不能重新派发".to_string());
    }
    let (platform, requirement) = task_platform_and_requirement(&root, &config, &manifest)?;
    let requirement_is_locked = requirement.client_access.mode == "locked_for_ai";
    if requirement_is_locked
        && requirement.client_access.task_id.as_deref() != Some(info.task_id.as_str())
    {
        return Err("需求当前由其他AI任务锁定，不能重新派发此任务".to_string());
    }
    let prompt_override = fs::read_to_string(task_dir.join("prompt.md"))
        .ok()
        .map(|prompt| prompt.replace(&info.task_id, "{{task_id}}"));
    let draft = AiTaskDraft {
        task_type: info.task_type.clone(),
        platform_id: info.platform_id.clone(),
        requirement_id: info.requirement_id.clone(),
        objective: info.objective.clone(),
        acceptance_criteria: info.acceptance_criteria.clone(),
        input_files: info
            .input_files
            .iter()
            .map(|file| AiTaskFileInput {
                path: file.path.clone(),
                role: file.role.clone(),
            })
            .collect(),
        knowledge_scope: info.knowledge_scope.clone(),
        allowed_paths: info.allowed_paths.clone(),
        forbidden_paths: info.forbidden_paths.clone(),
        output_dir: info.output_dir.clone(),
        output_schema: info.output_schema.clone(),
        lock_requirement: info.lock_requirement && !requirement_is_locked,
        prompt_override,
        execution_mode: Some(info.execution_mode.clone()),
    };
    let next = create_ai_task(root_path.clone(), draft)?;
    let next_task_dir = root.join(&next.task_dir);
    let mut next_manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(next_task_dir.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    next_manifest["previous_task_id"] = serde_json::Value::String(info.task_id.clone());
    next_manifest["lock_requirement"] =
        serde_json::Value::Bool(info.lock_requirement || requirement_is_locked);
    next_manifest["requirement_locked"] =
        serde_json::Value::Bool(info.requirement_locked || requirement_is_locked);
    write_ai_task_manifest(&next_task_dir, &next_manifest)?;
    if requirement_is_locked {
        rebind_requirement_task(
            &root_path,
            &platform.path,
            &requirement.requirement.id,
            &info.task_id,
            &next.task_id,
            &next.objective,
        )?;
    }
    record_task_activity(
        &root,
        &config,
        &manifest,
        "ai_task_redispatched",
        &format!("重新派发AI任务 {}（原任务 {}）", next.task_id, info.task_id),
        Some(next.task_id.clone()),
        Vec::new(),
    );
    read_task_action_result(
        &root,
        &next_task_dir,
        &config,
        vec![format!("已从任务 {} 重新派发", info.task_id)],
    )
}

/// 扫描需求：从平台目录下识别需求
#[tauri::command]
pub fn scan_requirements(
    root_path: String,
    platform_path: String,
) -> Result<Vec<RequirementMeta>, String> {
    let platform_dir = Path::new(&root_path).join(&platform_path);
    let mut requirements = Vec::new();
    if !platform_dir.exists() {
        return Ok(requirements);
    }
    if let Ok(entries) = fs::read_dir(&platform_dir) {
        for entry in entries.flatten() {
            let req_path = entry.path();
            if !req_path.is_dir() {
                continue;
            }
            let meta_path = req_path.join("requirement.yaml");
            if meta_path.exists() {
                let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
                let mut meta: RequirementMeta =
                    serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
                overlay_integration_references(&req_path, &mut meta);
                requirements.push(meta);
            }
        }
    }
    requirements.sort_by(|left, right| left.requirement.id.cmp(&right.requirement.id));
    Ok(requirements)
}

/// 测试资产：需求 04-测试用例 目录下的 XMind/Excel 用例文件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestAssetInfo {
    pub platform_id: String,
    pub platform_name: String,
    pub requirement_id: String,
    pub requirement_name: String,
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub kind: String,
    pub size: u64,
    pub modified: String,
    pub cases_json_exists: bool,
}

fn read_requirement_name(requirement_dir: &Path) -> Option<String> {
    let content = fs::read_to_string(requirement_dir.join("requirement.yaml")).ok()?;
    let meta: RequirementMeta = serde_yaml::from_str(&content).ok()?;
    Some(meta.requirement.name)
}

fn format_modified_time(metadata: &fs::Metadata) -> String {
    match metadata.modified() {
        Ok(time) => {
            let datetime: chrono::DateTime<chrono::Local> = time.into();
            datetime.to_rfc3339()
        }
        Err(_) => String::new(),
    }
}

/// 扫描工作区内所有需求的测试用例资产（新结构：projects/<平台>/<需求>/04-测试用例/）
#[tauri::command]
pub fn scan_test_assets(root_path: String) -> Result<Vec<TestAssetInfo>, String> {
    let root = Path::new(&root_path);
    let config = open_workspace(root_path.clone())?.config;
    let mut assets = Vec::new();

    for platform in &config.platforms {
        let platform_dir = root.join(&platform.path);
        if !platform_dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&platform_dir)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let requirement_dir = entry.path();
            if !requirement_dir.is_dir() {
                continue;
            }
            let cases_dir = requirement_dir.join("04-测试用例");
            if !cases_dir.is_dir() {
                continue;
            }
            let requirement_id = entry.file_name().to_string_lossy().to_string();
            let requirement_name =
                read_requirement_name(&requirement_dir).unwrap_or_else(|| requirement_id.clone());
            let cases_json_exists = cases_dir.join("cases.json").exists();

            for item in walkdir::WalkDir::new(&cases_dir)
                .max_depth(3)
                .into_iter()
                .filter_map(|item| item.ok())
            {
                let path = item.path();
                if !item.file_type().is_file() {
                    continue;
                }
                let extension = path
                    .extension()
                    .map(|value| value.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                let kind = match extension.as_str() {
                    "xmind" => "xmind",
                    "xlsx" | "xls" => "excel",
                    _ => continue,
                };
                let metadata = match item.metadata() {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                let relative_path = path
                    .strip_prefix(root)
                    .map(|value| value.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
                assets.push(TestAssetInfo {
                    platform_id: platform.id.clone(),
                    platform_name: platform.name.clone(),
                    requirement_id: requirement_id.clone(),
                    requirement_name: requirement_name.clone(),
                    name: path
                        .file_name()
                        .map(|value| value.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: path.to_string_lossy().replace('\\', "/"),
                    relative_path,
                    kind: kind.to_string(),
                    size: metadata.len(),
                    modified: format_modified_time(&metadata),
                    cases_json_exists,
                });
            }
        }
    }

    assets.sort_by(|left, right| {
        (&left.platform_id, &left.requirement_id, &left.name).cmp(&(
            &right.platform_id,
            &right.requirement_id,
            &right.name,
        ))
    });
    Ok(assets)
}

/// 读取单个需求元数据
#[tauri::command]
pub fn read_requirement(
    root_path: String,
    platform_path: String,
    requirement_id: String,
) -> Result<RequirementMeta, String> {
    let req_path = Path::new(&root_path)
        .join(&platform_path)
        .join(&requirement_id)
        .join("requirement.yaml");
    if !req_path.exists() {
        return Err(format!("需求元数据不存在: {:?}", req_path));
    }
    let content = fs::read_to_string(&req_path).map_err(|e| e.to_string())?;
    let mut meta: RequirementMeta = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
    overlay_integration_references(req_path.parent().unwrap(), &mut meta);
    Ok(meta)
}

fn overlay_integration_references(root: &Path, meta: &mut RequirementMeta) {
    let refs = crate::integrations::migration::requirement_references(root);
    if refs.is_empty() {
        return;
    }
    let values = meta
        .extensions
        .entry("external_refs".into())
        .or_insert_with(|| serde_json::json!([]));
    if let Some(values) = values.as_array_mut() {
        for r in refs {
            if !values.iter().any(|v| {
                v["connection_id"] == r["connection_id"]
                    && v["entity_type"] == r["entity_type"]
                    && v["external_id"] == r["external_id"]
            }) {
                values.push(r);
            }
        }
    }
}

/// 保存需求元数据
#[tauri::command]
pub fn save_requirement(
    root_path: String,
    platform_path: String,
    requirement_id: String,
    mut meta: RequirementMeta,
) -> Result<(), String> {
    let requirement_id = validate_requirement_id(&requirement_id)?;
    if meta.requirement.id != requirement_id {
        return Err("需求编号创建后不可修改".to_string());
    }
    let req_dir = Path::new(&root_path)
        .join(&platform_path)
        .join(&requirement_id);
    let req_path = req_dir.join("requirement.yaml");
    if !req_path.exists() {
        return Err("需求元数据不存在，不能直接保存".to_string());
    }
    let existing_content = fs::read_to_string(&req_path).map_err(|e| e.to_string())?;
    let existing: RequirementMeta =
        serde_yaml::from_str(&existing_content).map_err(|e| e.to_string())?;
    if existing.requirement.id != meta.requirement.id
        || existing.requirement.platform != meta.requirement.platform
    {
        return Err("需求编号和所属平台创建后不可修改".to_string());
    }
    if existing.client_access.mode == "locked_for_ai" {
        return Err(format!(
            "需求已锁定，客户端写入已禁止（任务：{}）",
            existing
                .client_access
                .task_id
                .as_deref()
                .unwrap_or("未关联任务")
        ));
    }
    if existing.client_access != meta.client_access {
        return Err("需求锁状态只能通过锁定或解锁确认命令修改".to_string());
    }
    let _ = validate_requirement_name(&meta.requirement.name)?;
    let _ = validate_requirement_stage(&meta.current_stage)?;
    let _ = normalize_optional_date(meta.schedule.planned_test_date.clone(), "计划提测日期")?;
    let _ = normalize_optional_date(meta.schedule.planned_release_date.clone(), "计划上线日期")?;
    let _ = normalize_applications(meta.applications.clone())?;
    meta.git_resources = normalize_git_resources(meta.git_resources)?;
    let mut submitted = serde_yaml::to_value(&meta).map_err(|e| e.to_string())?;
    let previous: serde_yaml::Value =
        serde_yaml::from_str(&existing_content).map_err(|e| e.to_string())?;
    preserve_unknown_requirement_fields(&mut submitted, &previous);
    let yaml_str = serde_yaml::to_string(&submitted).map_err(|e| e.to_string())?;
    write_workspace_text_file(&req_path, yaml_str)
}

/// Preserve extension fields in objects, including nested metadata. Arrays are deliberate replacements.
fn preserve_unknown_requirement_fields(next: &mut serde_yaml::Value, old: &serde_yaml::Value) {
    if let (Some(next), Some(old)) = (next.as_mapping_mut(), old.as_mapping()) {
        for (key, value) in old {
            if let Some(current) = next.get_mut(key) {
                preserve_unknown_requirement_fields(current, value);
            } else {
                next.insert(key.clone(), value.clone());
            }
        }
    }
}

/// 锁定需求目录
#[tauri::command]
pub fn lock_requirement(
    root_path: String,
    platform_path: String,
    requirement_id: String,
    task_id: String,
    note: String,
    user: String,
) -> Result<RequirementMeta, String> {
    let requirement_id = validate_requirement_id(&requirement_id)?;
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() {
        return Err("AI任务ID不能为空".to_string());
    }
    let (req_path, meta_path, mut meta) =
        load_requirement_for_access(&root_path, &platform_path, &requirement_id)?;

    if meta.client_access.mode == "locked_for_ai" {
        return Err("需求已锁定，请先完成解锁确认".to_string());
    }

    let snapshot = generate_file_snapshot(&req_path)?;
    let snapshot_path = format!(
        ".blackbox/snapshots/{}.json",
        sha256_hex(format!("{}:{}", requirement_id, task_id).as_bytes())
    );
    let snapshot_full = Path::new(&root_path).join(&snapshot_path);
    let snapshot_json = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    write_atomic_bytes(&snapshot_full, snapshot_json.as_bytes())?;

    meta.client_access = ClientAccess {
        mode: "locked_for_ai".to_string(),
        locked_at: Some(chrono_now()),
        locked_by: Some(user.trim().to_string()),
        task_id: Some(task_id.clone()),
        note: note.trim().to_string(),
        snapshot_path: Some(snapshot_path),
    };

    let yaml_str = serde_yaml::to_string(&meta).map_err(|e| e.to_string())?;
    write_internal_text_file(&meta_path, yaml_str)?;
    let _ = append_activity_event(
        &req_path,
        &meta.requirement.platform,
        &requirement_id,
        RequirementActivityInput {
            action: "requirement_locked".to_string(),
            actor: Some(user.trim().to_string()).filter(|value| !value.is_empty()),
            summary: format!("锁定需求目录，交由AI任务处理（{}）", task_id),
            object_id: Some(task_id),
            ..RequirementActivityInput::default()
        },
    );
    Ok(meta)
}

#[tauri::command]
pub fn scan_requirement_changes(
    root_path: String,
    platform_path: String,
    requirement_id: String,
) -> Result<UnlockPreview, String> {
    let requirement_id = validate_requirement_id(&requirement_id)?;
    let (req_path, _meta_path, meta) =
        load_requirement_for_access(&root_path, &platform_path, &requirement_id)?;
    ensure_locked(&meta)?;
    let (changes, warnings) = read_requirement_changes(&root_path, &req_path, &meta)?;
    let scanned_at = chrono_now();
    write_unlock_log(
        &root_path,
        &platform_path,
        &requirement_id,
        &meta,
        "scan",
        &changes,
        &warnings,
        None,
    )?;
    Ok(UnlockPreview {
        requirement: meta,
        changes,
        warnings,
        scanned_at,
    })
}

#[tauri::command]
pub fn accept_unlock_requirement(
    root_path: String,
    platform_path: String,
    requirement_id: String,
) -> Result<UnlockResult, String> {
    let requirement_id = validate_requirement_id(&requirement_id)?;
    let (req_path, meta_path, mut meta) =
        load_requirement_for_access(&root_path, &platform_path, &requirement_id)?;
    ensure_locked(&meta)?;
    let (changes, warnings) = read_requirement_changes(&root_path, &req_path, &meta)?;
    write_unlock_log(
        &root_path,
        &platform_path,
        &requirement_id,
        &meta,
        "accepted",
        &changes,
        &warnings,
        None,
    )?;

    let unlocked_task_id = meta.client_access.task_id.clone();
    meta.client_access = ClientAccess::default();
    let yaml_str = serde_yaml::to_string(&meta).map_err(|e| e.to_string())?;
    write_internal_text_file(&meta_path, yaml_str)?;
    let _ = append_activity_event(
        &req_path,
        &meta.requirement.platform,
        &requirement_id,
        RequirementActivityInput {
            action: "requirement_unlocked".to_string(),
            summary: format!(
                "接受外部产物并解锁，文件变化 {} 项{}",
                changes.total,
                unlocked_task_id
                    .as_deref()
                    .map(|task| format!("（任务：{}）", task))
                    .unwrap_or_default()
            ),
            object_id: unlocked_task_id,
            ..RequirementActivityInput::default()
        },
    );
    Ok(UnlockResult {
        requirement: meta,
        changes,
        warnings,
        action: "accepted".to_string(),
    })
}

#[tauri::command]
pub fn force_unlock_requirement(
    root_path: String,
    platform_path: String,
    requirement_id: String,
    reason: String,
) -> Result<UnlockResult, String> {
    let requirement_id = validate_requirement_id(&requirement_id)?;
    let (req_path, meta_path, mut meta) =
        load_requirement_for_access(&root_path, &platform_path, &requirement_id)?;
    ensure_locked(&meta)?;
    let (changes, mut warnings) = match read_requirement_changes(&root_path, &req_path, &meta) {
        Ok(result) => result,
        Err(error) => (FileChanges::default(), vec![error]),
    };
    warnings.push("此次解锁由用户强制执行，未逐项校验外部产物。".to_string());
    write_unlock_log(
        &root_path,
        &platform_path,
        &requirement_id,
        &meta,
        "forced",
        &changes,
        &warnings,
        Some(reason.trim()),
    )?;

    let unlocked_task_id = meta.client_access.task_id.clone();
    meta.client_access = ClientAccess::default();
    let yaml_str = serde_yaml::to_string(&meta).map_err(|e| e.to_string())?;
    write_internal_text_file(&meta_path, yaml_str)?;
    let _ = append_activity_event(
        &req_path,
        &meta.requirement.platform,
        &requirement_id,
        RequirementActivityInput {
            action: "requirement_unlocked".to_string(),
            summary: format!(
                "强制解锁{}（原因：{}）",
                unlocked_task_id
                    .as_deref()
                    .map(|task| format!("，任务：{}", task))
                    .unwrap_or_default(),
                reason.trim()
            ),
            object_id: unlocked_task_id,
            ..RequirementActivityInput::default()
        },
    );
    Ok(UnlockResult {
        requirement: meta,
        changes,
        warnings,
        action: "forced".to_string(),
    })
}

fn load_requirement_for_access(
    root_path: &str,
    platform_path: &str,
    requirement_id: &str,
) -> Result<(PathBuf, PathBuf, RequirementMeta), String> {
    let req_path = Path::new(root_path)
        .join(platform_path)
        .join(requirement_id);
    let meta_path = req_path.join("requirement.yaml");
    if !meta_path.exists() {
        return Err("需求不存在".to_string());
    }
    let content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let meta: RequirementMeta = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
    Ok((req_path, meta_path, meta))
}

fn ensure_locked(meta: &RequirementMeta) -> Result<(), String> {
    if meta.client_access.mode == "locked_for_ai" {
        Ok(())
    } else {
        Err("需求未锁定".to_string())
    }
}

// —— BB-16E：需求活动台账（activity.json）与阶段流转 ————————————————————

/// 需求活动事件：只保存摘要、相对引用和对象ID，不保存密钥或整份正文
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RequirementActivityEvent {
    pub id: String,
    pub occurred_at: String,
    pub action: String,
    pub actor: String,
    pub summary: String,
    pub from_stage: Option<String>,
    pub to_stage: Option<String>,
    pub object_id: Option<String>,
    pub refs: Vec<String>,
}

/// 需求目录下的 activity.json 台账文档
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RequirementActivity {
    pub version: String,
    pub requirement_id: String,
    pub platform_id: String,
    pub updated_at: String,
    pub events: Vec<RequirementActivityEvent>,
}

impl RequirementActivity {
    fn empty(requirement_id: &str, platform_id: &str) -> Self {
        RequirementActivity {
            version: "1.0".to_string(),
            requirement_id: requirement_id.to_string(),
            platform_id: platform_id.to_string(),
            updated_at: chrono_now(),
            events: Vec::new(),
        }
    }
}

impl Default for RequirementActivity {
    fn default() -> Self {
        RequirementActivity::empty("", "")
    }
}

/// 前端追加活动事件的输入；id 与 occurred_at 由后端生成
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RequirementActivityInput {
    pub action: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub from_stage: Option<String>,
    #[serde(default)]
    pub to_stage: Option<String>,
    #[serde(default)]
    pub object_id: Option<String>,
    #[serde(default)]
    pub refs: Vec<String>,
}

fn load_activity_document(
    req_dir: &Path,
    platform_id: &str,
    requirement_id: &str,
) -> Result<RequirementActivity, String> {
    let path = req_dir.join("activity.json");
    if !path.exists() {
        return Ok(RequirementActivity::empty(requirement_id, platform_id));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match serde_json::from_str::<RequirementActivity>(&content) {
        Ok(mut doc) => {
            doc.requirement_id = requirement_id.to_string();
            doc.platform_id = platform_id.to_string();
            Ok(doc)
        }
        Err(_) => {
            // 损坏的活动文件不静默丢弃：保留为 activity.corrupt.json 后重建空台账
            let backup = req_dir.join("activity.corrupt.json");
            let _ = fs::rename(&path, &backup);
            Ok(RequirementActivity::empty(requirement_id, platform_id))
        }
    }
}

fn append_activity_event(
    req_dir: &Path,
    platform_id: &str,
    requirement_id: &str,
    input: RequirementActivityInput,
) -> Result<RequirementActivityEvent, String> {
    let action = input.action.trim();
    if action.is_empty() {
        return Err("活动事件类型不能为空".to_string());
    }
    let mut doc = load_activity_document(req_dir, platform_id, requirement_id)?;
    let now = chrono_now();
    let event = RequirementActivityEvent {
        id: format!(
            "act-{}-{}",
            chrono::Local::now().format("%Y%m%d%H%M%S%3f"),
            doc.events.len() + 1
        ),
        occurred_at: now.clone(),
        action: action.to_string(),
        actor: input
            .actor
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "user".to_string()),
        summary: input.summary.trim().chars().take(300).collect(),
        from_stage: input.from_stage,
        to_stage: input.to_stage,
        object_id: input
            .object_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        refs: input
            .refs
            .iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect(),
    };
    doc.events.push(event.clone());
    doc.updated_at = now;
    write_internal_text_file(
        &req_dir.join("activity.json"),
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
    )?;
    Ok(event)
}

/// 恢复归档需求时回读最近一次归档来源阶段；没有记录时回到“已完成”
fn last_archived_from_stage(req_dir: &Path) -> Option<String> {
    let content = fs::read_to_string(req_dir.join("activity.json")).ok()?;
    let doc: RequirementActivity = serde_json::from_str(&content).ok()?;
    doc.events
        .iter()
        .rev()
        .find(|event| event.action == "stage_archive")
        .and_then(|event| event.from_stage.clone())
}

/// 追加一条需求活动记录。台账走内部写入通道：
/// 锁定中仍需要能记录“接受/拒绝任务、解锁”等客户端动作，因此不经 ensure_client_write_allowed。
#[tauri::command]
pub fn append_requirement_activity(
    root_path: String,
    platform_path: String,
    requirement_id: String,
    event: RequirementActivityInput,
) -> Result<RequirementActivityEvent, String> {
    let requirement_id = validate_requirement_id(&requirement_id)?;
    let (req_path, _meta_path, meta) =
        load_requirement_for_access(&root_path, &platform_path, &requirement_id)?;
    append_activity_event(
        &req_path,
        &meta.requirement.platform,
        &requirement_id,
        event,
    )
}

/// 读取需求活动台账；文件不存在时返回空文档
#[tauri::command]
pub fn read_requirement_activity(
    root_path: String,
    platform_path: String,
    requirement_id: String,
) -> Result<RequirementActivity, String> {
    let requirement_id = validate_requirement_id(&requirement_id)?;
    let (req_path, _meta_path, meta) =
        load_requirement_for_access(&root_path, &platform_path, &requirement_id)?;
    load_activity_document(&req_path, &meta.requirement.platform, &requirement_id)
}

/// 需求阶段流转：推进一格/退回一格（必填原因）/归档/恢复。
/// 不允许跳过多个阶段；锁定时拒绝客户端流转；状态写回 requirement.yaml 并追加活动事件。
#[tauri::command]
pub fn transition_requirement_stage(
    root_path: String,
    platform_path: String,
    requirement_id: String,
    action: String,
    reason: String,
    note: String,
) -> Result<RequirementMeta, String> {
    let requirement_id = validate_requirement_id(&requirement_id)?;
    let (req_path, meta_path, mut meta) =
        load_requirement_for_access(&root_path, &platform_path, &requirement_id)?;
    if meta.client_access.mode == "locked_for_ai" {
        return Err(format!(
            "需求目录已锁定，客户端不能调整阶段（任务：{}）",
            meta.client_access
                .task_id
                .as_deref()
                .unwrap_or("未关联任务")
        ));
    }
    let current = meta.current_stage.clone();
    let index = REQUIREMENT_STAGE_ORDER
        .iter()
        .position(|stage| *stage == current)
        .ok_or_else(|| format!("需求当前阶段不可识别：{}", current))?;
    let (to_stage, summary, action_label) = match action.trim() {
        "advance" => {
            let next = REQUIREMENT_STAGE_ORDER
                .get(index + 1)
                .copied()
                .unwrap_or("archived");
            if next == "archived" {
                return Err("已是最后业务阶段；如需归档请使用归档动作".to_string());
            }
            (
                next.to_string(),
                format!(
                    "推进阶段：{} → {}",
                    requirement_stage_label(&current),
                    requirement_stage_label(next)
                ),
                "stage_advance",
            )
        }
        "retreat" => {
            if current == "archived" {
                return Err("已归档需求请使用恢复动作".to_string());
            }
            if index == 0 {
                return Err("已是首个阶段，无法继续退回".to_string());
            }
            let reason = reason.trim();
            if reason.is_empty() {
                return Err("退回阶段必须填写原因".to_string());
            }
            let previous = REQUIREMENT_STAGE_ORDER[index - 1];
            (
                previous.to_string(),
                format!(
                    "退回阶段：{} → {}（原因：{}）",
                    requirement_stage_label(&current),
                    requirement_stage_label(previous),
                    reason
                ),
                "stage_retreat",
            )
        }
        "archive" => {
            if current == "archived" {
                return Err("需求已归档".to_string());
            }
            (
                "archived".to_string(),
                format!("归档需求（原阶段：{}）", requirement_stage_label(&current)),
                "stage_archive",
            )
        }
        "restore" => {
            if current != "archived" {
                return Err("需求未归档".to_string());
            }
            let target =
                last_archived_from_stage(&req_path).unwrap_or_else(|| "completed".to_string());
            (
                target.clone(),
                format!("恢复需求：已归档 → {}", requirement_stage_label(&target)),
                "stage_restore",
            )
        }
        other => return Err(format!("不支持的阶段动作：{}", other)),
    };
    let note = note.trim();
    let summary = if note.is_empty() {
        summary
    } else {
        format!("{}；备注：{}", summary, note)
    };
    meta.current_stage = to_stage.clone();
    meta.status = requirement_stage_label(&to_stage).to_string();
    write_internal_text_file(
        &meta_path,
        serde_yaml::to_string(&meta).map_err(|e| e.to_string())?,
    )?;
    let _ = append_activity_event(
        &req_path,
        &meta.requirement.platform,
        &requirement_id,
        RequirementActivityInput {
            action: action_label.to_string(),
            actor: Some("user".to_string()),
            summary,
            from_stage: Some(current),
            to_stage: Some(to_stage),
            object_id: None,
            refs: Vec::new(),
        },
    );
    Ok(meta)
}

fn read_requirement_changes(
    root_path: &str,
    req_path: &Path,
    meta: &RequirementMeta,
) -> Result<(FileChanges, Vec<String>), String> {
    let Some(snapshot_path) = &meta.client_access.snapshot_path else {
        return Ok((
            FileChanges::default(),
            vec!["锁定前文件快照不存在，变化清单不完整。".to_string()],
        ));
    };
    let snapshot_full = Path::new(root_path).join(snapshot_path);
    if !snapshot_full.exists() {
        return Ok((
            FileChanges::default(),
            vec!["锁定前文件快照文件不存在，变化清单不完整。".to_string()],
        ));
    }
    let snapshot_str = fs::read_to_string(&snapshot_full).map_err(|e| e.to_string())?;
    let old_snapshot: HashMap<String, FileEntry> =
        serde_json::from_str(&snapshot_str).map_err(|e| e.to_string())?;
    let new_snapshot = generate_file_snapshot(req_path)?;
    Ok((compare_snapshots(&old_snapshot, &new_snapshot), Vec::new()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlockPreview {
    pub requirement: RequirementMeta,
    pub changes: FileChanges,
    pub warnings: Vec<String>,
    pub scanned_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlockResult {
    pub requirement: RequirementMeta,
    pub changes: FileChanges,
    pub warnings: Vec<String>,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub fingerprint: String,
    pub size: u64,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FileMove {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FileChanges {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
    pub moved: Vec<FileMove>,
    pub total: usize,
}

fn generate_file_snapshot(dir: &Path) -> Result<HashMap<String, FileEntry>, String> {
    generate_file_snapshot_excluding(dir, &[])
}

fn generate_file_snapshot_excluding(
    dir: &Path,
    exclusions: &[PathBuf],
) -> Result<HashMap<String, FileEntry>, String> {
    let mut snapshot = HashMap::new();
    if !dir.exists() {
        return Ok(snapshot);
    }
    for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if exclusions
            .iter()
            .any(|excluded| entry.path().starts_with(excluded))
        {
            continue;
        }
        if entry.file_type().is_file() {
            // 需求活动台账是客户端内部文件：锁定期间也会被追加，
            // 不计入任务期间变化 / 解锁差异，避免把自身写入误判为外部产物
            let file_name = entry.file_name().to_string_lossy();
            if file_name == "activity.json" || file_name == "activity.corrupt.json" {
                continue;
            }
            let rel_path = entry
                .path()
                .strip_prefix(dir)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if rel_path.is_empty() {
                continue;
            }
            let mut file = fs::File::open(entry.path()).map_err(|e| e.to_string())?;
            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer).map_err(|e| e.to_string())?;
            let fingerprint = fingerprint_for_file(entry.path(), &buffer);
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            snapshot.insert(
                rel_path.clone(),
                FileEntry {
                    path: rel_path,
                    fingerprint,
                    size: metadata.len(),
                    modified: format!("{:?}", metadata.modified().map_err(|e| e.to_string())?),
                },
            );
        }
    }
    Ok(snapshot)
}

fn fingerprint_for_file(path: &Path, content: &[u8]) -> String {
    if path.file_name().and_then(|name| name.to_str()) == Some("requirement.yaml") {
        if let Ok(text) = std::str::from_utf8(content) {
            if let Ok(mut meta) = serde_yaml::from_str::<RequirementMeta>(text) {
                meta.client_access = ClientAccess::default();
                if let Ok(normalized) = serde_yaml::to_string(&meta) {
                    return sha256_hex(normalized.as_bytes());
                }
            }
        }
    }
    sha256_hex(content)
}

fn compare_snapshots(
    old: &HashMap<String, FileEntry>,
    new: &HashMap<String, FileEntry>,
) -> FileChanges {
    let mut added_entries: Vec<(String, FileEntry)> = new
        .iter()
        .filter(|(path, _)| !old.contains_key(*path))
        .map(|(path, entry)| (path.clone(), entry.clone()))
        .collect();
    let mut deleted_entries: Vec<(String, FileEntry)> = old
        .iter()
        .filter(|(path, _)| !new.contains_key(*path))
        .map(|(path, entry)| (path.clone(), entry.clone()))
        .collect();
    let mut modified = new
        .iter()
        .filter_map(|(path, entry)| {
            old.get(path).and_then(|old_entry| {
                (old_entry.fingerprint != entry.fingerprint).then(|| path.clone())
            })
        })
        .collect::<Vec<_>>();
    let mut moved = Vec::new();
    let mut added = Vec::new();
    for (new_path, new_entry) in added_entries.drain(..) {
        if let Some(index) = deleted_entries
            .iter()
            .position(|(_, old_entry)| old_entry.fingerprint == new_entry.fingerprint)
        {
            let (old_path, _) = deleted_entries.remove(index);
            moved.push(FileMove {
                from: old_path,
                to: new_path,
            });
        } else {
            added.push(new_path);
        }
    }
    let deleted = deleted_entries
        .into_iter()
        .map(|(path, _)| path)
        .collect::<Vec<_>>();
    added.sort();
    modified.sort();
    let mut deleted = deleted;
    deleted.sort();
    moved.sort_by(|left, right| left.from.cmp(&right.from).then(left.to.cmp(&right.to)));
    let total = added.len() + modified.len() + deleted.len() + moved.len();
    FileChanges {
        added,
        modified,
        deleted,
        moved,
        total,
    }
}

fn write_unlock_log(
    root_path: &str,
    platform_path: &str,
    requirement_id: &str,
    meta: &RequirementMeta,
    action: &str,
    changes: &FileChanges,
    warnings: &[String],
    reason: Option<&str>,
) -> Result<(), String> {
    let logs_path = Path::new(root_path).join(".blackbox").join("logs");
    fs::create_dir_all(&logs_path).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let token = sha256_hex(format!("{}:{}:{}", platform_path, requirement_id, stamp).as_bytes());
    let log_path = logs_path.join(format!("requirement-unlock-{}.json", token));
    let record = serde_json::json!({
        "version": "1.0",
        "action": action,
        "requirement_id": requirement_id,
        "platform_path": platform_path,
        "task_id": meta.client_access.task_id,
        "locked_at": meta.client_access.locked_at,
        "occurred_at": chrono_now(),
        "reason": reason.unwrap_or_default(),
        "changes": changes,
        "warnings": warnings,
    });
    let content = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    write_atomic_bytes(&log_path, content.as_bytes())
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

fn default_index_config() -> IndexConfig {
    IndexConfig {
        engine: "sqlite".to_string(),
        db_path: ".blackbox/index.sqlite".to_string(),
        fts_enabled: true,
        ignore_patterns: vec![
            ".blackbox/index.sqlite".to_string(),
            ".blackbox/logs/*".to_string(),
            "node_modules/*".to_string(),
            "target/*".to_string(),
            "dist/*".to_string(),
            ".git/*".to_string(),
            "__pycache__/*".to_string(),
            "*.pyc".to_string(),
            "*.tmp".to_string(),
        ],
    }
}

fn default_watcher_config() -> WatcherConfig {
    WatcherConfig {
        enabled: true,
        debounce_ms: 500,
        ignore_patterns: default_watcher_ignore_patterns(),
    }
}

fn default_watcher_ignore_patterns() -> Vec<String> {
    vec![
        ".blackbox/index.sqlite".to_string(),
        ".blackbox/logs/*".to_string(),
        "node_modules/*".to_string(),
        "target/*".to_string(),
        "dist/*".to_string(),
        ".git/*".to_string(),
        "__pycache__/*".to_string(),
        "*.tmp".to_string(),
    ]
}

fn run_workspace_watcher(
    receiver: mpsc::Receiver<notify::Result<NotifyEvent>>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
    root: PathBuf,
    ignore_patterns: Vec<String>,
    debounce: Duration,
) {
    let mut pending_rename: Option<PendingRename> = None;
    while !stop.load(Ordering::Relaxed) {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(first) => {
                let mut batch = vec![first];
                let deadline = Instant::now() + debounce;
                while Instant::now() < deadline {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match receiver.recv_timeout(remaining) {
                        Ok(next) => batch.push(next),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                for result in batch {
                    if let Ok(event) = result {
                        process_notify_event(
                            event,
                            &root,
                            &ignore_patterns,
                            &app,
                            &mut pending_rename,
                        );
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }

        if pending_rename
            .as_ref()
            .is_some_and(|pending| pending.recorded_at.elapsed() >= debounce)
        {
            if let Some(pending) = pending_rename.take() {
                emit_workspace_event(
                    &app,
                    &root,
                    &ignore_patterns,
                    "remove",
                    &pending.path,
                    None,
                    pending.is_directory,
                );
            }
        }
    }
}

fn process_notify_event(
    event: NotifyEvent,
    root: &Path,
    ignore_patterns: &[String],
    app: &AppHandle,
    pending_rename: &mut Option<PendingRename>,
) {
    let Some(first_path) = event.paths.first() else {
        return;
    };
    match event.kind {
        EventKind::Create(_) => {
            for path in event.paths {
                emit_workspace_event(
                    app,
                    root,
                    ignore_patterns,
                    "create",
                    &path,
                    None,
                    path.is_dir(),
                );
            }
        }
        EventKind::Remove(remove_kind) => {
            let is_directory = matches!(remove_kind, RemoveKind::Folder);
            for path in event.paths {
                emit_workspace_event(
                    app,
                    root,
                    ignore_patterns,
                    "remove",
                    &path,
                    None,
                    is_directory || path.is_dir(),
                );
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            *pending_rename = None;
            let old_path = &event.paths[0];
            let new_path = &event.paths[1];
            emit_workspace_event(
                app,
                root,
                ignore_patterns,
                "rename",
                new_path,
                Some(old_path),
                old_path.is_dir() || new_path.is_dir(),
            );
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            if let Some(previous) = pending_rename.take() {
                emit_workspace_event(
                    app,
                    root,
                    ignore_patterns,
                    "remove",
                    &previous.path,
                    None,
                    previous.is_directory,
                );
            }
            *pending_rename = Some(PendingRename {
                path: first_path.clone(),
                is_directory: first_path.is_dir(),
                recorded_at: Instant::now(),
            });
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            if let Some(previous) = pending_rename.take() {
                emit_workspace_event(
                    app,
                    root,
                    ignore_patterns,
                    "rename",
                    first_path,
                    Some(&previous.path),
                    previous.is_directory || first_path.is_dir(),
                );
            } else {
                emit_workspace_event(
                    app,
                    root,
                    ignore_patterns,
                    "create",
                    first_path,
                    None,
                    first_path.is_dir(),
                );
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Any))
        | EventKind::Modify(ModifyKind::Name(RenameMode::Other)) => {
            let old_path = event.paths.get(1).map(|path| path.as_path());
            emit_workspace_event(
                app,
                root,
                ignore_patterns,
                "rename",
                first_path,
                old_path,
                first_path.is_dir() || old_path.is_some_and(|path| path.is_dir()),
            );
        }
        EventKind::Modify(_) | EventKind::Any => {
            for path in event.paths {
                emit_workspace_event(
                    app,
                    root,
                    ignore_patterns,
                    "modify",
                    &path,
                    None,
                    path.is_dir(),
                );
            }
        }
        EventKind::Access(_) | EventKind::Other => {}
    }
}

fn emit_workspace_event(
    app: &AppHandle,
    root: &Path,
    ignore_patterns: &[String],
    event_type: &str,
    path: &Path,
    old_path: Option<&Path>,
    is_directory: bool,
) {
    if is_ignored_path(root, path, ignore_patterns)
        || old_path.is_some_and(|old| is_ignored_path(root, old, ignore_patterns))
    {
        return;
    }
    let event = WorkspaceEvent {
        event_type: event_type.to_string(),
        path: path.to_string_lossy().to_string(),
        old_path: old_path.map(|old| old.to_string_lossy().to_string()),
        is_directory,
        occurred_at: chrono_now(),
    };
    let _ = app.emit(WORKSPACE_EVENT, event);
}

fn is_ignored_path(root: &Path, path: &Path, ignore_patterns: &[String]) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    if relative.is_empty() {
        return false;
    }
    let components: Vec<&str> = relative
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if components.iter().any(|part| {
        matches!(
            *part,
            "node_modules" | "target" | "dist" | ".git" | "__pycache__"
        )
    }) {
        return true;
    }
    let file_name = components.last().copied().unwrap_or_default();
    if file_name.ends_with(".tmp") {
        return true;
    }
    ignore_patterns.iter().any(|pattern| {
        let pattern = pattern.replace('\\', "/");
        let base = pattern
            .strip_suffix("/*")
            .or_else(|| pattern.strip_suffix("/**"));
        base.is_some_and(|base| relative == base || relative.starts_with(&format!("{}/", base)))
            || glob_matches(&pattern, &relative)
            || glob_matches(&pattern, file_name)
    })
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    let mut states = vec![vec![false; value.len() + 1]; pattern.len() + 1];
    states[0][0] = true;
    for index in 0..pattern.len() {
        for value_index in 0..=value.len() {
            if !states[index][value_index] {
                continue;
            }
            if pattern[index] == '*' {
                states[index + 1][value_index] = true;
                if value_index < value.len() {
                    states[index][value_index + 1] = true;
                }
            } else if value_index < value.len() && pattern[index] == value[value_index] {
                states[index + 1][value_index + 1] = true;
            }
        }
    }
    states[pattern.len()][value.len()]
}

fn default_backup_config() -> BackupConfig {
    BackupConfig {
        auto_enabled: true,
        interval_hours: 24,
        max_backups: 10,
        include_cache: false,
    }
}

fn default_directories() -> HashMap<String, String> {
    let mut dirs = HashMap::new();
    dirs.insert("projects".to_string(), "projects".to_string());
    dirs.insert("templates".to_string(), "templates".to_string());
    dirs.insert("knowledge".to_string(), "knowledge".to_string());
    dirs.insert("tools".to_string(), "tools".to_string());
    dirs.insert("archive".to_string(), "archive".to_string());
    dirs.insert("blackbox".to_string(), ".blackbox".to_string());
    dirs
}

fn default_platforms() -> Vec<PlatformInfo> {
    Vec::new()
}

pub(crate) fn chrono_now() -> String {
    chrono::Local::now().to_rfc3339()
}

/// 创建工作区内的业务目录
#[tauri::command]
pub fn create_directory(dir_path: String) -> Result<(), String> {
    let path = Path::new(&dir_path);
    ensure_client_write_allowed(path, None)?;
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

/// 写入二进制文件（用于需求附件和截图）
#[tauri::command]
pub fn write_binary_file(file_path: String, content: Vec<u8>) -> Result<(), String> {
    let _guard = crate::case_revision::CASE_WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let path = Path::new(&file_path);
    ensure_client_write_allowed(path, None)?;
    write_atomic_bytes(path, &content)
}

#[tauri::command]
pub fn create_binary_file(file_path: String, content: Vec<u8>) -> Result<(), String> {
    let path = Path::new(&file_path);
    ensure_client_write_allowed(path, None)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("目标二进制文件已存在，禁止直接覆盖：{}", file_path)
            } else {
                error.to_string()
            }
        })?;
    if let Err(error) = file.write_all(&content).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

/// 读取二进制文件
#[tauri::command]
pub fn read_binary_file(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(&file_path).map_err(|e| e.to_string())
}

/// 读取文件内容
#[tauri::command]
pub fn read_text_file(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

/// 写入文件内容
#[tauri::command]
pub fn write_text_file(file_path: String, content: String) -> Result<(), String> {
    let _guard = crate::case_revision::CASE_WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    write_workspace_text_file(Path::new(&file_path), content)
}

/// 列出目录内容
#[tauri::command]
pub fn list_directory(dir_path: String) -> Result<Vec<DirEntryInfo>, String> {
    let mut entries = Vec::new();
    if !Path::new(&dir_path).exists() {
        return Ok(entries);
    }
    if let Ok(dir_entries) = fs::read_dir(&dir_path) {
        for entry in dir_entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = path.is_dir();
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
                .unwrap_or_default();
            entries.push(DirEntryInfo {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                size,
                modified,
            });
        }
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathInfo {
    pub exists: bool,
    pub is_file: bool,
    pub is_directory: bool,
    pub size: u64,
    pub modified: String,
}

/// 返回路径基础信息，供系统外部打开服务做前置校验
#[tauri::command]
pub fn get_path_info(path: String) -> Result<PathInfo, String> {
    match fs::metadata(Path::new(&path)) {
        Ok(metadata) => Ok(PathInfo {
            exists: true,
            is_file: metadata.is_file(),
            is_directory: metadata.is_dir(),
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .map(|time| chrono::DateTime::<chrono::Local>::from(time).to_rfc3339())
                .unwrap_or_default(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PathInfo {
            exists: false,
            is_file: false,
            is_directory: false,
            size: 0,
            modified: String::new(),
        }),
        Err(error) => Err(format!("读取路径信息失败：{}", error)),
    }
}

/// 保存JSON文件
#[tauri::command]
pub fn save_json_file(file_path: String, data: serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    write_text_file(file_path, content)
}

/// Optimistic save for human-authored answer/coverage drafts.
#[tauri::command]
pub fn save_json_file_if_unchanged(
    file_path: String,
    expected_json: Option<serde_json::Value>,
    data: serde_json::Value,
) -> Result<(), String> {
    let _guard = crate::case_revision::CASE_WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let path = Path::new(&file_path);
    let content = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
    ensure_client_write_allowed(path, Some(&content))?;
    let current = match fs::read(path) {
        Ok(bytes) => {
            Some(serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|e| e.to_string())?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if current != expected_json {
        return Err("磁盘已有新版本，请合并后保存；当前草稿保留".into());
    }
    write_atomic_bytes(path, &content)
}

/// 仅创建JSON文件，不覆盖已有业务数据
#[tauri::command]
pub fn create_json_file(file_path: String, data: serde_json::Value) -> Result<(), String> {
    let _guard = crate::case_revision::CASE_WRITE_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let path = Path::new(&file_path);
    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    ensure_client_write_allowed(path, Some(content.as_bytes()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("目标JSON文件已存在，禁止直接覆盖：{}", file_path)
            } else {
                error.to_string()
            }
        })?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

/// 读取JSON文件
#[tauri::command]
pub fn read_json_file(file_path: String) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// 通用资料操作的受管路径拦截：.blackbox 协议目录、需求内受管子树不可以通过
/// create_text_file/rename_path/delete_path/import_files 这类泛型资料命令增删改
pub(crate) fn ensure_not_managed_path(path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|part| part.as_os_str().eq_ignore_ascii_case(".blackbox"))
    {
        return Err(".blackbox 协议目录由客户端内部管理".to_string());
    }
    if let Some((requirement_dir, _)) = find_requirement_metadata(path)? {
        let rel = path
            .strip_prefix(&requirement_dir)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        const MANAGED_PATHS: &[&str] = &[
            "04-测试用例/cases.json",
            "02-需求理解与答疑/questions.json",
            "02-需求理解与答疑/attachments/内嵌图",
            "activity.json",
            "activity.corrupt.json",
            "04-测试用例/versions",
            "04-测试用例/reviews",
            "06-测试执行与证据",
            "07-测试报告",
            "08-知识候选",
        ];
        if MANAGED_PATHS
            .iter()
            .any(|managed| path_starts_with_ignore_case(&rel, managed))
        {
            return Err("该路径由对应业务功能管理，不能通过资料操作修改".to_string());
        }
    }
    Ok(())
}

pub(crate) fn path_starts_with_ignore_case(path: &str, prefix: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let prefix_parts: Vec<&str> = prefix.split('/').collect();
    parts.len() >= prefix_parts.len()
        && parts
            .iter()
            .zip(&prefix_parts)
            .all(|(part, expected)| part.eq_ignore_ascii_case(expected))
}

/// 仅创建文本文件，不覆盖已有内容（用于资料页新建 Markdown 文档）
#[tauri::command]
pub fn create_text_file(file_path: String, content: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    ensure_not_managed_path(path)?;
    ensure_client_write_allowed(path, Some(content.as_bytes()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("目标文件已存在，禁止直接覆盖：{}", file_path)
            } else {
                error.to_string()
            }
        })?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

/// 同目录重命名文件或文件夹；目标已存在时拒绝覆盖
#[tauri::command]
pub fn rename_path(from_path: String, to_path: String) -> Result<(), String> {
    let from = Path::new(&from_path);
    let to = Path::new(&to_path);
    if !from.exists() {
        return Err(format!("目标不存在，无法重命名：{}", from_path));
    }
    if from.file_name().and_then(|name| name.to_str()) == Some("requirement.yaml") {
        return Err("requirement.yaml 由需求服务管理，不能重命名".to_string());
    }
    if from.is_dir() && from.join("requirement.yaml").is_file() {
        return Err("需求根目录不能通过资料操作重命名".to_string());
    }
    if from.parent() != to.parent() {
        return Err("资料页仅支持同目录重命名，移动文件请使用系统文件管理器".to_string());
    }
    if to.exists() {
        return Err(format!("目标已存在，禁止覆盖：{}", to_path));
    }
    ensure_not_managed_path(from)?;
    ensure_not_managed_path(to)?;
    ensure_client_write_allowed(from, None)?;
    ensure_client_write_allowed(to, None)?;
    fs::rename(from, to).map_err(|e| e.to_string())
}

/// 删除文件或空目录；目录不为空时拒绝删除
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("目标不存在：{}", path));
    }
    if target.file_name().and_then(|name| name.to_str()) == Some("requirement.yaml") {
        return Err("requirement.yaml 由需求服务管理，不能删除".to_string());
    }
    ensure_not_managed_path(target)?;
    ensure_client_write_allowed(target, None)?;
    if target.is_dir() {
        if target.join("requirement.yaml").is_file() {
            return Err("需求根目录不能通过资料操作删除".to_string());
        }
        let mut entries = fs::read_dir(target).map_err(|e| e.to_string())?;
        if entries.next().is_some() {
            return Err("目录不为空，请先清空后再删除".to_string());
        }
        fs::remove_dir(target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(target).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSourceItem {
    pub source_path: String,
    pub name: String,
    /// 同名冲突策略：auto（存在即失败）| rename（自动重命名）| overwrite（覆盖）| skip（跳过）
    pub strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResultItem {
    pub name: String,
    pub source_path: String,
    pub target_path: Option<String>,
    /// imported | renamed | overwritten | skipped | failed
    pub status: String,
    pub message: String,
}

/// 受控导入：把外部文件复制到工作区目标目录，不通过 Shell 命令
#[tauri::command]
pub fn import_files(
    target_dir: String,
    sources: Vec<ImportSourceItem>,
) -> Result<Vec<ImportResultItem>, String> {
    let dir = Path::new(&target_dir);
    ensure_not_managed_path(dir)?;
    ensure_client_write_allowed(dir, None)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    Ok(sources
        .into_iter()
        .map(|item| import_single_file(dir, item))
        .collect())
}

fn import_single_file(dir: &Path, item: ImportSourceItem) -> ImportResultItem {
    let name = item.name.trim();
    let result = |status: &str, target_path: Option<String>, message: String| ImportResultItem {
        name: name.to_string(),
        source_path: item.source_path.clone(),
        target_path,
        status: status.to_string(),
        message,
    };
    if name.is_empty()
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| "\\/:*?\"<>|".contains(c) || c.is_control())
    {
        return result("failed", None, format!("文件名包含非法字符：{}", name));
    }
    let source = Path::new(&item.source_path);
    if !source.is_file() {
        return result(
            "failed",
            None,
            format!("源文件不存在或不是文件：{}", item.source_path),
        );
    }
    let mut status = "imported";
    let mut target = dir.join(name);
    if target.exists() {
        match item.strategy.as_str() {
            "skip" => {
                return result("skipped", None, "同名文件已存在，按策略跳过".to_string());
            }
            "overwrite" => status = "overwritten",
            "rename" => {
                target = unique_child_path(dir, name);
                status = "renamed";
            }
            _ => {
                return result(
                    "failed",
                    None,
                    format!("同名文件已存在，未指定处理策略：{}", name),
                );
            }
        }
    }
    if let Err(error) = ensure_client_write_allowed(&target, None) {
        return result("failed", None, error);
    }
    match fs::copy(source, &target) {
        Ok(_) => result(
            status,
            Some(target.to_string_lossy().to_string()),
            String::new(),
        ),
        Err(error) => result("failed", None, format!("复制失败：{}", error)),
    }
}

fn unique_child_path(dir: &Path, name: &str) -> PathBuf {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|s| s.to_str());
    for index in 2..1000 {
        let candidate = match ext {
            Some(ext) if !ext.is_empty() => format!("{} ({}).{}", stem, index, ext),
            _ => format!("{} ({})", stem, index),
        };
        let target = dir.join(&candidate);
        if !target.exists() {
            return target;
        }
    }
    dir.join(name)
}

// —— BB-16D：客户端审计日志与运行日志收口 ————————————————————

/// 客户端操作日志输入：固定字段，detail 只保存摘要文本，禁止写入密钥/Token
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceLogInput {
    pub level: String,
    pub module: String,
    pub action: String,
    pub result: String,
    pub detail: String,
}

/// 归一化后的日志记录：兼容客户端审计 JSONL 与既有业务操作 JSON（如解锁记录）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceLogRecord {
    pub file: String,
    pub line: u32,
    pub occurred_at: String,
    pub level: String,
    pub module: String,
    pub action: String,
    pub result: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceLogFileError {
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceLogList {
    pub entries: Vec<WorkspaceLogRecord>,
    pub errors: Vec<WorkspaceLogFileError>,
}

const LOG_DETAIL_LIMIT: usize = 600;
const LOG_SCAN_FILE_LIMIT: usize = 80;
const LOG_ENTRY_LIMIT: usize = 500;

fn workspace_logs_dir(root: &Path) -> PathBuf {
    root.join(".blackbox").join("logs")
}

fn sanitize_log_level(level: &str) -> String {
    match level.trim().to_ascii_lowercase().as_str() {
        "warn" | "warning" => "warning".to_string(),
        "error" | "err" | "fatal" => "error".to_string(),
        _ => "info".to_string(),
    }
}

fn sanitize_log_text(value: &str, limit: usize) -> String {
    let single_line = value.replace('\r', " ").replace('\n', " ");
    if single_line.chars().count() > limit {
        let truncated: String = single_line.chars().take(limit).collect();
        format!("{}…", truncated)
    } else {
        single_line
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "cookie",
        "authorization",
        "credential",
        "apikey",
        "api_key",
    ]
    .iter()
    .any(|sensitive| lower.contains(sensitive))
}

/// 追加一条客户端审计日志到 .blackbox/logs/client-<日期>.jsonl（JSON Lines，一行一条）
#[tauri::command]
pub fn append_workspace_log(root_path: String, entry: WorkspaceLogInput) -> Result<(), String> {
    let root = Path::new(&root_path);
    let logs_dir = workspace_logs_dir(root);
    fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
    let file_name = format!("client-{}.jsonl", chrono::Local::now().format("%Y%m%d"));
    let record = serde_json::json!({
        "occurred_at": chrono_now(),
        "level": sanitize_log_level(&entry.level),
        "module": sanitize_log_text(entry.module.trim(), 60),
        "action": sanitize_log_text(entry.action.trim(), 80),
        "result": sanitize_log_text(entry.result.trim(), 120),
        "detail": sanitize_log_text(entry.detail.trim(), LOG_DETAIL_LIMIT),
        "source": "client",
    });
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join(file_name))
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| e.to_string())
}

fn module_from_file_name(file_name: &str) -> String {
    let stem = file_name.rsplit(|c| c == '.').last().unwrap_or(file_name);
    let base = stem.split('-').next().unwrap_or("").trim();
    match base {
        "requirement" if stem.contains("unlock") => "需求锁定".to_string(),
        "client" => "客户端".to_string(),
        "migration" => "迁移".to_string(),
        "" => "工作区".to_string(),
        other => other.to_string(),
    }
}

fn record_string_field(value: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|item| item.as_str()) {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
    }
    String::new()
}

fn compact_json_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => sanitize_log_text(text, 120),
        serde_json::Value::Number(_) | serde_json::Value::Bool(_) => value.to_string(),
        serde_json::Value::Null => String::new(),
        other => {
            let raw = serde_json::to_string(other).unwrap_or_default();
            sanitize_log_text(&raw, 120)
        }
    }
}

/// 把一条任意 JSON 日志记录归一化为统一的运行日志行；过滤密钥类字段
fn normalize_log_record(
    value: &serde_json::Value,
    file_name: &str,
    line: u32,
    fallback_time: &str,
) -> WorkspaceLogRecord {
    let object = value.as_object();
    let get = |keys: &[&str]| -> String {
        if object.is_some() {
            record_string_field(value, keys)
        } else {
            String::new()
        }
    };
    let occurred_at = {
        let found = get(&[
            "occurred_at",
            "time",
            "timestamp",
            "created_at",
            "changed_at",
            "updated_at",
        ]);
        if found.is_empty() {
            fallback_time.to_string()
        } else {
            found
        }
    };
    let warnings_non_empty = object
        .and_then(|map| map.get("warnings"))
        .and_then(|item| item.as_array())
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    let mut level = sanitize_log_level(&get(&["level", "severity", "log_level"]));
    if level == "info" && warnings_non_empty {
        level = "warning".to_string();
    }
    let result = get(&["result", "outcome", "status", "action_result"]);
    let result_lower = result.to_ascii_lowercase();
    if level == "info"
        && (result_lower.contains("fail")
            || result_lower.contains("error")
            || result.contains("拒绝")
            || result.contains("失败"))
    {
        level = "error".to_string();
    }
    let module = {
        let found = get(&["module", "source", "component"]);
        if found.is_empty() || found == "client" && !file_name.starts_with("client-") {
            module_from_file_name(file_name)
        } else {
            found
        }
    };
    let action = get(&["action", "event", "operation", "kind", "command"]);
    // detail：剩余字段压缩为 key=value 摘要，跳过已消费字段与敏感字段
    const CONSUMED: &[&str] = &[
        "occurred_at",
        "time",
        "timestamp",
        "created_at",
        "changed_at",
        "updated_at",
        "level",
        "severity",
        "log_level",
        "module",
        "source",
        "component",
        "action",
        "event",
        "operation",
        "kind",
        "command",
        "result",
        "outcome",
        "status",
        "action_result",
        "version",
    ];
    let mut detail_parts: Vec<String> = Vec::new();
    if let Some(map) = object {
        for (key, item) in map {
            if CONSUMED.contains(&key.as_str()) || is_sensitive_key(key) {
                continue;
            }
            let rendered = compact_json_value(item);
            if rendered.is_empty() {
                continue;
            }
            detail_parts.push(format!("{}={}", key, rendered));
            if detail_parts.join(" ").chars().count() > LOG_DETAIL_LIMIT {
                break;
            }
        }
    }
    WorkspaceLogRecord {
        file: file_name.to_string(),
        line,
        occurred_at,
        level,
        module,
        action,
        result,
        detail: sanitize_log_text(&detail_parts.join(" "), LOG_DETAIL_LIMIT),
    }
}

/// 读取 .blackbox/logs 下的客户端审计与业务操作日志；单个文件解析失败不阻断其他日志
#[tauri::command]
pub fn list_workspace_logs(root_path: String) -> Result<WorkspaceLogList, String> {
    let root = Path::new(&root_path);
    let logs_dir = workspace_logs_dir(root);
    let mut files = match fs::read_dir(&logs_dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| entry.path().is_file())
            .filter_map(|entry| {
                let path = entry.path();
                let ext = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if ext != "json" && ext != "jsonl" && ext != "log" {
                    return None;
                }
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .map(|time| chrono::DateTime::<chrono::Local>::from(time).to_rfc3339())
                    .unwrap_or_default();
                Some((path, modified))
            })
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("读取日志目录失败：{}", error)),
    };
    files.sort_by(|left, right| right.1.cmp(&left.1));
    files.truncate(LOG_SCAN_FILE_LIMIT);

    let mut entries: Vec<WorkspaceLogRecord> = Vec::new();
    let mut errors: Vec<WorkspaceLogFileError> = Vec::new();
    for (path, modified) in files {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) => {
                errors.push(WorkspaceLogFileError {
                    file: file_name,
                    message: format!("读取失败：{}", error),
                });
                continue;
            }
        };
        if file_name.ends_with(".jsonl") || file_name.ends_with(".log") {
            let mut broken_lines = 0u32;
            for (index, line) in content.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(trimmed) {
                    Ok(value) => entries.push(normalize_log_record(
                        &value,
                        &file_name,
                        index as u32 + 1,
                        &modified,
                    )),
                    Err(_) => broken_lines += 1,
                }
            }
            if broken_lines > 0 {
                errors.push(WorkspaceLogFileError {
                    file: file_name,
                    message: format!("{} 行不是有效JSON，已跳过", broken_lines),
                });
            }
        } else {
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(value) => entries.push(normalize_log_record(&value, &file_name, 0, &modified)),
                Err(error) => errors.push(WorkspaceLogFileError {
                    file: file_name,
                    message: format!("不是有效JSON：{}", error),
                }),
            }
        }
    }
    entries.sort_by(|left, right| right.occurred_at.cmp(&left.occurred_at));
    entries.truncate(LOG_ENTRY_LIMIT);
    Ok(WorkspaceLogList { entries, errors })
}

// —— BB-16F：工作区全局搜索 ————————————————————————————————

/// 全局搜索单条结果；result_type 决定前端打开与定位方式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSearchResult {
    /// requirement | file | case | ai_task | run | report | knowledge
    pub result_type: String,
    pub title: String,
    pub subtitle: String,
    /// 绝对路径：file 为文件本身，业务对象为载体文件或目录
    pub path: String,
    #[serde(default)]
    pub platform_id: Option<String>,
    #[serde(default)]
    pub requirement_id: Option<String>,
    /// caseId / taskId / runId / reportId / knowledgeId
    #[serde(default)]
    pub object_id: Option<String>,
    /// 命中字段说明或文本片段
    pub matched_text: String,
    /// 知识条目作用域（general/platform/requirement），其他类型为 None
    #[serde(default)]
    pub scope: Option<String>,
    pub is_directory: bool,
    pub score: i64,
}

/// 参与文本内容搜索的扩展名白名单；其余按文件名匹配
const SEARCH_TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "json", "yaml", "yml", "log", "csv", "xml", "html", "htm", "css",
    "py", "ts", "tsx", "js", "jsx", "rs", "toml", "ini", "conf", "jsonl", "sql", "sh",
];
/// 单文件内容搜索大小上限，避免大型文件阻塞界面
const SEARCH_FILE_SIZE_LIMIT: u64 = 512 * 1024;
/// 遍历条目上限，防止异常巨大的工作区拖垮一次查询
const SEARCH_WALK_ENTRY_LIMIT: usize = 80_000;
/// 文件名/路径命中上限：路径前缀命中（如需求编号目录）不能淹没其他分组
const SEARCH_FILE_RESULT_LIMIT: usize = 150;
const SEARCH_CONTENT_RESULT_LIMIT: usize = 120;

struct SearchHit {
    score: i64,
    field: String,
    value: String,
}

fn search_field_score(
    query: &str,
    value: &str,
    exact: i64,
    prefix: i64,
    contains: i64,
) -> Option<i64> {
    if value.trim().is_empty() {
        return None;
    }
    let value_lower = value.to_lowercase();
    if value_lower == query {
        Some(exact)
    } else if value_lower.starts_with(query) {
        Some(prefix)
    } else if value_lower.contains(query) {
        Some(contains)
    } else {
        None
    }
}

fn search_best(query: &str, fields: &[(&str, &str, i64, i64, i64)]) -> Option<SearchHit> {
    let mut best: Option<SearchHit> = None;
    for (label, value, exact, prefix, contains) in fields {
        if let Some(score) = search_field_score(query, value, *exact, *prefix, *contains) {
            if best.as_ref().is_none_or(|hit| score > hit.score) {
                best = Some(SearchHit {
                    score,
                    field: (*label).to_string(),
                    value: value.trim().to_string(),
                });
            }
        }
    }
    best
}

fn search_hit_text(hit: &SearchHit) -> String {
    truncate_search_text(&format!("{}：{}", hit.field, hit.value), 120)
}

fn truncate_search_text(value: &str, limit: usize) -> String {
    let text = value.trim();
    if text.chars().count() <= limit {
        return text.to_string();
    }
    format!("{}…", text.chars().take(limit).collect::<String>())
}

fn search_normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// 需求目录与平台归属：最长前缀优先，保证嵌套目录归属最近的需求
fn search_locate_requirement(
    normalized_path: &str,
    requirement_dirs: &[(String, String, String)],
) -> Option<(String, String)> {
    let mut best: Option<&(String, String, String)> = None;
    for entry in requirement_dirs {
        if normalized_path == entry.0 || normalized_path.starts_with(&format!("{}/", entry.0)) {
            if best.is_none_or(|current| entry.0.len() > current.0.len()) {
                best = Some(entry);
            }
        }
    }
    best.map(|entry| (entry.1.clone(), entry.2.clone()))
}

fn search_locate_knowledge_scope(
    normalized_path: &str,
    knowledge_dirs: &[(String, Option<String>)],
) -> Option<Option<String>> {
    for (dir, platform_id) in knowledge_dirs {
        if normalized_path == *dir || normalized_path.starts_with(&format!("{}/", dir)) {
            return Some(platform_id.clone());
        }
    }
    None
}

/// 业务结构文件命中后不再做纯文本内容匹配，避免同一条内容重复出现
fn search_is_structured_name(file_name: &str) -> bool {
    matches!(
        file_name,
        "requirement.yaml"
            | "cases.json"
            | "run.json"
            | "report.json"
            | "knowledge.json"
            | "knowledge-candidates.json"
            | "manifest.json"
            | "progress.json"
            | "result.json"
    )
}

fn search_text_file(path: &Path, query: &str, file_size: u64) -> Option<String> {
    if file_size > SEARCH_FILE_SIZE_LIMIT {
        return None;
    }
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !SEARCH_TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let content_lower = content.to_lowercase();
    if !content_lower.contains(query) {
        return None;
    }
    for (index, line) in content.lines().enumerate() {
        if line.to_lowercase().contains(query) {
            return Some(truncate_search_text(
                &format!("L{} {}", index + 1, line.trim()),
                160,
            ));
        }
    }
    Some("内容匹配".to_string())
}

fn search_json_string<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
    value.get(key).and_then(|item| item.as_str()).unwrap_or("")
}

fn search_json_strings(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|item| item.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn search_case_directory_titles(tree: &serde_json::Value, map: &mut HashMap<String, String>) {
    let id = search_json_string(tree, "id");
    let title = search_json_string(tree, "title");
    if !id.is_empty() {
        map.insert(id.to_string(), title.to_string());
    }
    if let Some(children) = tree.get("children").and_then(|value| value.as_array()) {
        for child in children {
            search_case_directory_titles(child, map);
        }
    }
}

#[derive(Default)]
struct SearchBucket {
    items: Vec<WorkspaceSearchResult>,
    file_hits: usize,
    content_hits: usize,
}

impl SearchBucket {
    fn push(&mut self, result: WorkspaceSearchResult) {
        self.items.push(result);
    }

    fn push_file(&mut self, result: WorkspaceSearchResult, content_match: bool) {
        if content_match {
            if self.content_hits >= SEARCH_CONTENT_RESULT_LIMIT {
                return;
            }
            self.content_hits += 1;
        } else {
            if self.file_hits >= SEARCH_FILE_RESULT_LIMIT {
                return;
            }
            self.file_hits += 1;
        }
        self.items.push(result);
    }
}

/// 全局搜索：walkdir 遍历 + 忽略规则，结构化对象优先解析标准 JSON/YAML，
/// 文本文件做受限内容匹配；后台执行，结果按评分排序并截断。
#[tauri::command]
pub async fn search_workspace(
    root_path: String,
    query: String,
    platform_id: Option<String>,
    requirement_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_inner(&root_path, &query, platform_id, requirement_id, limit)
    })
    .await
    .map_err(|error| format!("搜索任务执行失败：{}", error))?
}

fn search_workspace_inner(
    root_path: &str,
    query: &str,
    context_platform_id: Option<String>,
    context_requirement_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let (root, config) = load_initialized_workspace(root_path)?;
    let max_results = limit.unwrap_or(200).clamp(1, 500);

    let mut ignore_patterns = default_watcher_ignore_patterns();
    ignore_patterns.extend(config.index.ignore_patterns.clone());
    ignore_patterns.extend(config.watcher.ignore_patterns.clone());
    ignore_patterns.sort();
    ignore_patterns.dedup();

    // 需求目录 → (platform_id, requirement_id)，用于结果归属与上下文加权
    let mut requirement_dirs: Vec<(String, String, String)> = Vec::new();
    let mut platform_names: HashMap<String, String> = HashMap::new();
    for platform in &config.platforms {
        platform_names.insert(platform.id.clone(), platform.name.clone());
        let platform_dir = root.join(&platform.path);
        if let Ok(entries) = fs::read_dir(&platform_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.join("requirement.yaml").is_file() {
                    requirement_dirs.push((
                        search_normalize_path(&path),
                        platform.id.clone(),
                        entry.file_name().to_string_lossy().to_string(),
                    ));
                }
            }
        }
    }

    // 知识目录 → scope（通用或平台），候选文件走需求目录归属
    let knowledge_root = config
        .directories
        .get("knowledge")
        .cloned()
        .unwrap_or_else(|| "knowledge".to_string());
    let mut knowledge_dirs: Vec<(String, Option<String>)> = vec![(
        search_normalize_path(&root.join(&knowledge_root).join("通用")),
        None,
    )];
    for platform in &config.platforms {
        let dir = if platform.knowledge_path.is_empty() {
            root.join(&knowledge_root).join(&platform.name)
        } else {
            root.join(&platform.knowledge_path)
        };
        knowledge_dirs.push((search_normalize_path(&dir), Some(platform.id.clone())));
    }

    let blackbox_dir = config
        .directories
        .get("blackbox")
        .cloned()
        .unwrap_or_else(|| ".blackbox".to_string());
    let tasks_root = search_normalize_path(&root.join(&blackbox_dir).join("tasks"));
    let snapshots_root = search_normalize_path(&root.join(&blackbox_dir).join("snapshots"));

    let mut bucket = SearchBucket::default();
    let mut visited = 0usize;

    let walker = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_ignored_path(&root, entry.path(), &ignore_patterns));

    for entry in walker.filter_map(|item| item.ok()) {
        visited += 1;
        if visited > SEARCH_WALK_ENTRY_LIMIT {
            break;
        }
        let path = entry.path();
        if path == root.as_path() {
            continue;
        }
        let normalized = search_normalize_path(path);
        let relative = normalized
            .strip_prefix(&format!("{}/", search_normalize_path(&root)))
            .unwrap_or(&normalized)
            .to_string();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().is_dir();
        let (platform_id, requirement_id) =
            search_locate_requirement(&normalized, &requirement_dirs)
                .map(|(p, r)| (Some(p), Some(r)))
                .unwrap_or((None, None));
        let context_boost = |score: i64| -> i64 {
            let mut next = score;
            if context_requirement_id
                .as_deref()
                .is_some_and(|id| requirement_id.as_deref() == Some(id))
            {
                next += 15;
            }
            if context_platform_id
                .as_deref()
                .is_some_and(|id| platform_id.as_deref() == Some(id))
            {
                next += 8;
            }
            next
        };

        // 1. 文件名 / 相对路径匹配（文件和目录都算）
        if let Some(hit) = search_best(
            &query,
            &[
                ("文件名", file_name.as_str(), 90, 70, 50),
                ("路径", relative.as_str(), 60, 35, 25),
            ],
        ) {
            bucket.push_file(
                WorkspaceSearchResult {
                    result_type: "file".to_string(),
                    title: file_name.clone(),
                    subtitle: relative.clone(),
                    path: normalized.clone(),
                    platform_id: platform_id.clone(),
                    requirement_id: requirement_id.clone(),
                    object_id: None,
                    matched_text: search_hit_text(&hit),
                    scope: None,
                    is_directory: is_dir,
                    score: context_boost(hit.score),
                },
                false,
            );
        }

        if is_dir {
            continue;
        }

        // 2. 结构化业务对象解析
        let in_tasks = normalized.starts_with(&format!("{}/", tasks_root));
        match file_name.as_str() {
            "requirement.yaml" => {
                if let Ok(meta) = serde_yaml::from_str::<RequirementMeta>(
                    &fs::read_to_string(path).unwrap_or_default(),
                ) {
                    if let Some(hit) = search_best(
                        &query,
                        &[
                            ("需求编号", meta.requirement.id.as_str(), 100, 85, 65),
                            ("需求名称", meta.requirement.name.as_str(), 90, 70, 50),
                            ("负责人", meta.requirement.owner.as_str(), 50, 40, 30),
                            ("当前阶段", meta.status.as_str(), 40, 30, 20),
                        ],
                    ) {
                        let platform_name = platform_id
                            .as_deref()
                            .and_then(|id| platform_names.get(id).cloned())
                            .unwrap_or_default();
                        bucket.push(WorkspaceSearchResult {
                            result_type: "requirement".to_string(),
                            title: meta.requirement.id.clone(),
                            subtitle: [
                                platform_name,
                                meta.requirement.name.clone(),
                                meta.status.clone(),
                            ]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                            path: search_normalize_path(
                                &path.parent().map(Path::to_path_buf).unwrap_or_default(),
                            ),
                            platform_id: platform_id.clone(),
                            requirement_id: Some(meta.requirement.id.clone()),
                            object_id: Some(meta.requirement.id.clone()),
                            matched_text: search_hit_text(&hit),
                            scope: None,
                            is_directory: false,
                            score: context_boost(hit.score),
                        });
                    }
                }
            }
            "cases.json" => {
                // 只解析 04-测试用例 下的活动用例集，versions 下的快照只做文件名匹配
                let parent_name = path
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                if parent_name == "04-测试用例" {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(
                        &fs::read_to_string(path).unwrap_or_default(),
                    ) {
                        let mut dir_titles: HashMap<String, String> = HashMap::new();
                        if let Some(tree) = value.get("tree") {
                            search_case_directory_titles(tree, &mut dir_titles);
                        }
                        if let Some(cases) = value.get("cases").and_then(|item| item.as_array()) {
                            for case in cases {
                                let case_id = search_json_string(case, "id").to_string();
                                let title = search_json_string(case, "title").to_string();
                                let tags = search_json_strings(case, "tags").join(" ");
                                let refs = search_json_strings(case, "requirement_refs").join(" ");
                                let test_type = search_json_string(case, "test_type");
                                let status = search_json_string(case, "status");
                                if let Some(hit) = search_best(
                                    &query,
                                    &[
                                        ("用例ID", case_id.as_str(), 100, 85, 60),
                                        ("用例标题", title.as_str(), 90, 72, 52),
                                        ("标签", tags.as_str(), 55, 45, 35),
                                        ("需求点", refs.as_str(), 45, 35, 25),
                                        ("测试类型", test_type, 40, 30, 20),
                                    ],
                                ) {
                                    let directory_title = dir_titles
                                        .get(search_json_string(case, "directory_id"))
                                        .cloned()
                                        .unwrap_or_default();
                                    let priority = case
                                        .get("priority")
                                        .and_then(|item| item.as_i64())
                                        .unwrap_or(1);
                                    bucket.push(WorkspaceSearchResult {
                                        result_type: "case".to_string(),
                                        title: title.clone(),
                                        subtitle: [
                                            requirement_id.clone().unwrap_or_default(),
                                            format!("P{}", priority),
                                            test_type.to_string(),
                                            directory_title,
                                        ]
                                        .into_iter()
                                        .filter(|part| !part.is_empty())
                                        .collect::<Vec<_>>()
                                        .join(" · "),
                                        path: normalized.clone(),
                                        platform_id: platform_id.clone(),
                                        requirement_id: requirement_id.clone(),
                                        object_id: Some(case_id),
                                        matched_text: search_hit_text(&hit),
                                        scope: None,
                                        is_directory: false,
                                        score: context_boost(hit.score)
                                            + if status == "deprecated" { -15 } else { 0 },
                                    });
                                }
                            }
                        }
                    }
                }
            }
            "run.json" => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(
                    &fs::read_to_string(path).unwrap_or_default(),
                ) {
                    let run_id = search_json_string(&value, "run_id").to_string();
                    let name = search_json_string(&value, "name").to_string();
                    let environment = search_json_string(&value, "environment");
                    let executor = search_json_string(&value, "executor");
                    let branch = search_json_string(&value, "branch");
                    if let Some(hit) = search_best(
                        &query,
                        &[
                            ("轮次ID", run_id.as_str(), 100, 80, 60),
                            ("轮次名称", name.as_str(), 90, 70, 50),
                            ("测试环境", environment, 50, 40, 30),
                            ("执行人", executor, 50, 40, 30),
                            ("分支", branch, 40, 30, 20),
                        ],
                    ) {
                        bucket.push(WorkspaceSearchResult {
                            result_type: "run".to_string(),
                            title: if name.is_empty() {
                                run_id.clone()
                            } else {
                                name.clone()
                            },
                            subtitle: [
                                requirement_id.clone().unwrap_or_default(),
                                environment.to_string(),
                                executor.to_string(),
                            ]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                            path: normalized.clone(),
                            platform_id: platform_id.clone(),
                            requirement_id: requirement_id.clone(),
                            object_id: Some(if run_id.is_empty() {
                                path.parent()
                                    .and_then(|dir| dir.file_name())
                                    .map(|name| name.to_string_lossy().to_string())
                                    .unwrap_or_default()
                            } else {
                                run_id.clone()
                            }),
                            matched_text: search_hit_text(&hit),
                            scope: None,
                            is_directory: false,
                            score: context_boost(hit.score),
                        });
                    }
                }
            }
            "report.json" => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(
                    &fs::read_to_string(path).unwrap_or_default(),
                ) {
                    let report_id = search_json_string(&value, "report_id").to_string();
                    let output_path = search_json_string(&value, "output_path").to_string();
                    let run_id = search_json_string(&value, "run_id");
                    let output_name = output_path
                        .rsplit(|ch| ch == '/' || ch == '\\')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    if let Some(hit) = search_best(
                        &query,
                        &[
                            ("报告ID", report_id.as_str(), 100, 80, 60),
                            ("输出文件", output_name.as_str(), 90, 70, 50),
                            ("关联轮次", run_id, 60, 45, 30),
                        ],
                    ) {
                        // 优先定位输出产物；不存在时回到 report.json 让前端降级到报告页
                        // output_path 相对需求目录：<req>/07-测试报告/<report>/report.json 上两级
                        let report_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
                        let output_abs = report_dir
                            .parent()
                            .and_then(|dir| dir.parent())
                            .map(|dir| dir.join(&output_path));
                        let target = output_abs
                            .filter(|candidate| !output_path.is_empty() && candidate.is_file())
                            .map(|candidate| search_normalize_path(&candidate))
                            .unwrap_or_else(|| normalized.clone());
                        bucket.push(WorkspaceSearchResult {
                            result_type: "report".to_string(),
                            title: if output_name.is_empty() {
                                report_id.clone()
                            } else {
                                output_name
                            },
                            subtitle: [
                                requirement_id.clone().unwrap_or_default(),
                                report_id.clone(),
                                search_json_string(&value, "created_at").to_string(),
                            ]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                            path: target,
                            platform_id: platform_id.clone(),
                            requirement_id: requirement_id.clone(),
                            object_id: Some(report_id),
                            matched_text: search_hit_text(&hit),
                            scope: None,
                            is_directory: false,
                            score: context_boost(hit.score),
                        });
                    }
                }
            }
            "knowledge.json" | "knowledge-candidates.json" => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(
                    &fs::read_to_string(path).unwrap_or_default(),
                ) {
                    let items = value
                        .get("items")
                        .or_else(|| value.get("candidates"))
                        .and_then(|item| item.as_array());
                    let scope_platform =
                        search_locate_knowledge_scope(&normalized, &knowledge_dirs);
                    if let Some(items) = items {
                        for item in items {
                            let item_id = search_json_string(item, "id").to_string();
                            let title = search_json_string(item, "title").to_string();
                            let body = search_json_string(item, "body");
                            let tags = search_json_strings(item, "tags").join(" ");
                            let status = search_json_string(item, "status");
                            let item_scope = search_json_string(item, "scope").to_string();
                            if let Some(hit) = search_best(
                                &query,
                                &[
                                    ("知识ID", item_id.as_str(), 95, 75, 55),
                                    ("知识标题", title.as_str(), 90, 70, 50),
                                    ("标签", tags.as_str(), 55, 45, 35),
                                    ("正文", body, 0, 0, 25),
                                ],
                            ) {
                                let (item_platform, item_requirement) = match &scope_platform {
                                    Some(found) => (
                                        found.clone(),
                                        item.get("requirement_id")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string)
                                            .or(requirement_id.clone()),
                                    ),
                                    None => (
                                        item.get("platform_id")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string)
                                            .or(platform_id.clone()),
                                        item.get("requirement_id")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_string)
                                            .or(requirement_id.clone()),
                                    ),
                                };
                                bucket.push(WorkspaceSearchResult {
                                    result_type: "knowledge".to_string(),
                                    title: title.clone(),
                                    subtitle: [
                                        search_json_string(item, "knowledge_type").to_string(),
                                        status.to_string(),
                                        item_requirement.clone().unwrap_or_default(),
                                    ]
                                    .into_iter()
                                    .filter(|part| !part.is_empty())
                                    .collect::<Vec<_>>()
                                    .join(" · "),
                                    path: normalized.clone(),
                                    platform_id: item_platform,
                                    requirement_id: item_requirement,
                                    object_id: Some(item_id),
                                    matched_text: search_hit_text(&hit),
                                    scope: if item_scope.is_empty() {
                                        None
                                    } else {
                                        Some(item_scope)
                                    },
                                    is_directory: false,
                                    score: context_boost(hit.score),
                                });
                            }
                        }
                    }
                }
            }
            "manifest.json" if in_tasks => {
                if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(
                    &fs::read_to_string(path).unwrap_or_default(),
                ) {
                    let task_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
                    let progress = fs::read_to_string(task_dir.join("progress.json"))
                        .ok()
                        .and_then(|content| {
                            serde_json::from_str::<serde_json::Value>(&content).ok()
                        });
                    let task_id = search_json_string(&manifest, "task_id").to_string();
                    let task_type = search_json_string(&manifest, "task_type");
                    let objective = search_json_string(&manifest, "objective");
                    let status = progress
                        .as_ref()
                        .map(|value| search_json_string(value, "status"))
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| search_json_string(&manifest, "status"));
                    let task_platform = search_json_string(&manifest, "platform_id").to_string();
                    let task_requirement =
                        search_json_string(&manifest, "requirement_id").to_string();
                    if let Some(hit) = search_best(
                        &query,
                        &[
                            ("任务ID", task_id.as_str(), 100, 82, 60),
                            ("任务目标", objective, 80, 60, 40),
                            ("任务类型", task_type, 60, 45, 30),
                            ("任务状态", status, 40, 30, 20),
                        ],
                    ) {
                        let mut task_score = hit.score;
                        if context_requirement_id
                            .as_deref()
                            .is_some_and(|id| task_requirement == id)
                        {
                            task_score += 15;
                        }
                        if context_platform_id
                            .as_deref()
                            .is_some_and(|id| task_platform == id)
                        {
                            task_score += 8;
                        }
                        bucket.push(WorkspaceSearchResult {
                            result_type: "ai_task".to_string(),
                            title: task_id.clone(),
                            subtitle: [
                                task_type.to_string(),
                                status.to_string(),
                                format!("{}/{}", task_platform, task_requirement),
                            ]
                            .into_iter()
                            .filter(|part| !part.trim_matches('/').is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                            path: search_normalize_path(&task_dir),
                            platform_id: if task_platform.is_empty() {
                                None
                            } else {
                                Some(task_platform)
                            },
                            requirement_id: if task_requirement.is_empty() {
                                None
                            } else {
                                Some(task_requirement)
                            },
                            object_id: Some(task_id),
                            matched_text: search_hit_text(&hit),
                            scope: None,
                            is_directory: false,
                            score: task_score,
                        });
                    }
                }
            }
            _ => {}
        }

        // 3. 普通文本内容匹配；结构化文件与快照目录跳过，避免重复与噪声
        let structured = search_is_structured_name(&file_name)
            || normalized.starts_with(&format!("{}/", snapshots_root));
        if !structured {
            if let Some(snippet) = search_text_file(
                path,
                &query,
                entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            ) {
                bucket.push_file(
                    WorkspaceSearchResult {
                        result_type: "file".to_string(),
                        title: file_name.clone(),
                        subtitle: relative.clone(),
                        path: normalized.clone(),
                        platform_id: platform_id.clone(),
                        requirement_id: requirement_id.clone(),
                        object_id: None,
                        matched_text: snippet,
                        scope: None,
                        is_directory: false,
                        score: context_boost(20),
                    },
                    true,
                );
            }
        }
    }

    let mut results = bucket.items;
    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.title.cmp(&right.title))
    });
    results.truncate(max_results);
    Ok(results)
}

#[cfg(test)]
pub(crate) fn init_fixture_workspace(
    root_path: String,
    name: String,
) -> Result<WorkspaceOpenResult, String> {
    init_workspace(root_path.clone(), name)?;
    create_platform(
        root_path.clone(),
        PlatformDraft {
            id: "foton".to_string(),
            name: "示例平台".to_string(),
            path: "projects/示例平台".to_string(),
            knowledge_path: "knowledge/示例平台".to_string(),
            description: "合成测试平台".to_string(),
        },
    )?;
    open_workspace(root_path)
}

#[cfg(test)]
mod tests {
    #[test]
    fn fresh_workspace_has_no_business_platforms_and_reopen_preserves_user_platforms() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("baize-fresh-workspace-{unique}"));
        fs::create_dir(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        let opened = super::init_workspace(root_path.clone(), "新工作区".into()).unwrap();
        assert!(opened.config.platforms.is_empty());
        assert_eq!(fs::read_dir(root.join("projects")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("knowledge")).unwrap().count(), 1);
        create_platform(
            root_path.clone(),
            PlatformDraft {
                id: "demo".into(),
                name: "示例平台".into(),
                path: "projects/demo".into(),
                knowledge_path: "knowledge/demo".into(),
                description: String::new(),
            },
        )
        .unwrap();
        let reopened = super::init_workspace(root_path, "不应覆盖已有名称".into()).unwrap();
        assert_eq!(reopened.config.platforms.len(), 1);
        assert_eq!(reopened.config.platforms[0].id, "demo");
        assert_eq!(reopened.config.workspace.name, "新工作区");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_directory_reports_rfc3339_modified_time() {
        let dir = std::env::temp_dir().join("blackbox-client-list-directory-time-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("shot.png"), b"png").unwrap();
        let entries = list_directory(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(
            chrono::DateTime::parse_from_rfc3339(&entries[0].modified).is_ok(),
            "修改时间不是 RFC3339 格式：{}",
            entries[0].modified
        );
        fs::remove_dir_all(dir).unwrap();
    }

    use super::*;
    #[test]
    fn watcher_ignores_build_and_temporary_paths() {
        let root = Path::new("C:/workspace");
        let patterns = default_watcher_ignore_patterns();
        assert!(is_ignored_path(
            root,
            Path::new("C:/workspace/node_modules/pkg/index.js"),
            &patterns
        ));
        assert!(is_ignored_path(
            root,
            Path::new("C:/workspace/target/debug/app"),
            &patterns
        ));
        assert!(is_ignored_path(
            root,
            Path::new("C:/workspace/dist/index.js"),
            &patterns
        ));
        assert!(is_ignored_path(
            root,
            Path::new("C:/workspace/.git/HEAD"),
            &patterns
        ));
        assert!(is_ignored_path(
            root,
            Path::new("C:/workspace/.blackbox/index.sqlite"),
            &patterns
        ));
        assert!(is_ignored_path(
            root,
            Path::new("C:/workspace/notes.tmp"),
            &patterns
        ));
        assert!(!is_ignored_path(
            root,
            Path::new("C:/workspace/projects/需求/说明.md"),
            &patterns
        ));
    }

    #[test]
    fn glob_match_supports_custom_ignore_patterns() {
        assert!(glob_matches(
            "projects/*/requirement.yaml",
            "projects/示例平台/requirement.yaml"
        ));
        assert!(glob_matches("*.log", "client.log"));
        assert!(!glob_matches("*.log", "client.md"));
    }

    #[test]
    fn validates_platform_id_format() {
        assert_eq!(validate_platform_id("johnson").unwrap(), "johnson");
        assert!(validate_platform_id("../johnson").is_err());
        assert!(validate_platform_id("示例项目平台").is_err());
    }

    #[test]
    fn validates_platform_directories_are_scoped() {
        assert!(validate_platform_directory("projects/示例项目", "projects", "项目目录").is_ok());
        assert!(validate_platform_directory("knowledge/示例项目", "projects", "项目目录").is_err());
        assert!(
            validate_platform_directory("projects/../outside", "projects", "项目目录").is_err()
        );
    }

    #[test]
    fn validates_platform_status() {
        assert_eq!(validate_platform_status("active").unwrap(), "active");
        assert_eq!(validate_platform_status("archived").unwrap(), "archived");
        assert!(validate_platform_status("deleted").is_err());
    }

    #[test]
    fn workspace_guide_describes_requirement_directories() {
        let root =
            std::env::temp_dir().join(format!("blackbox-client-guide-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        init_fixture_workspace(root.to_string_lossy().to_string(), "测试工作区".to_string())
            .unwrap();
        let guide = fs::read_to_string(root.join("WORKSPACE.md")).unwrap();
        assert!(guide.contains("## 需求目录与阶段"));
        for directory in standard_requirement_directories() {
            let top = directory
                .components()
                .next()
                .unwrap()
                .as_os_str()
                .to_string_lossy()
                .into_owned();
            assert!(guide.contains(&top), "WORKSPACE.md 缺少目录说明：{top}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn creates_requirement_standard_tree_and_persists_metadata() {
        let root = std::env::temp_dir().join(format!(
            "blackbox-client-requirement-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();

        init_fixture_workspace(root_path.clone(), "测试工作区".to_string()).unwrap();
        let meta = create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "DEMO-1001".to_string(),
                name: "大客户".to_string(),
                owner: "测试负责人".to_string(),
                planned_test_date: Some("2026-09-01".to_string()),
                planned_release_date: Some("2026-09-15".to_string()),
                applications: vec![ApplicationInfo {
                    name: "门店PC端".to_string(),
                    branch: "release/demo-1001".to_string(),
                }],
                initial_stage: "collecting".to_string(),
                yunxiao: None,
                extensions: Default::default(),
            },
        )
        .unwrap();

        assert_eq!(meta.requirement.platform, "foton");
        assert_eq!(meta.current_stage, "collecting");
        assert_eq!(meta.status, "资料收集中");
        for relative_path in standard_requirement_directories() {
            assert!(root
                .join("projects")
                .join("示例平台")
                .join("DEMO-1001")
                .join(relative_path)
                .is_dir());
        }
        assert!(root
            .join("projects")
            .join("示例平台")
            .join("DEMO-1001")
            .join("requirement.yaml")
            .is_file());
        assert!(create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "DEMO-1001".to_string(),
                name: "重复需求".to_string(),
                owner: String::new(),
                planned_test_date: None,
                planned_release_date: None,
                applications: Vec::new(),
                initial_stage: "draft".to_string(),
                yunxiao: None,
                extensions: Default::default(),
            },
        )
        .is_err());
        assert_eq!(
            scan_requirements(root_path, "projects/示例平台".to_string())
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_json_file_without_overwriting_existing_data() {
        let root = std::env::temp_dir().join(format!(
            "blackbox-client-json-create-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file_path = root.join("04-测试用例").join("cases.json");
        let file_path_string = file_path.to_string_lossy().to_string();

        create_json_file(
            file_path_string.clone(),
            serde_json::json!({ "version": 1 }),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&file_path).unwrap())
                .unwrap()["version"],
            serde_json::json!(1)
        );
        assert!(create_json_file(file_path_string, serde_json::json!({ "version": 2 })).is_err());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&file_path).unwrap())
                .unwrap()["version"],
            serde_json::json!(1)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_binary_file_without_overwriting_existing_delivery() {
        let root = std::env::temp_dir().join(format!(
            "blackbox-client-binary-create-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file_path = root.join("exports").join("cases.xmind");
        let file_path_string = file_path.to_string_lossy().to_string();

        create_binary_file(file_path_string.clone(), vec![1, 2, 3]).unwrap();
        assert_eq!(fs::read(&file_path).unwrap(), vec![1, 2, 3]);
        assert!(create_binary_file(file_path_string, vec![9]).is_err());
        assert_eq!(fs::read(&file_path).unwrap(), vec![1, 2, 3]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_platform_and_prevents_deleting_associated_data() {
        let root = std::env::temp_dir().join(format!(
            "blackbox-client-platform-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();

        init_fixture_workspace(root_path.clone(), "测试工作区".to_string()).unwrap();
        let created = create_platform(
            root_path.clone(),
            PlatformDraft {
                id: "johnson".to_string(),
                name: "示例项目".to_string(),
                path: "projects/示例项目".to_string(),
                knowledge_path: "knowledge/示例项目".to_string(),
                description: "平台测试".to_string(),
            },
        )
        .unwrap();
        assert!(root.join("projects").join("示例项目").is_dir());
        assert!(root.join("knowledge").join("示例项目").is_dir());
        assert!(created
            .platforms
            .iter()
            .any(|platform| platform.id == "johnson"));

        let archived = update_platform(
            root_path.clone(),
            "johnson".to_string(),
            "示例项目平台".to_string(),
            "已归档平台".to_string(),
            "archived".to_string(),
        )
        .unwrap();
        assert_eq!(
            archived
                .platforms
                .iter()
                .find(|platform| platform.id == "johnson")
                .unwrap()
                .status,
            "archived"
        );
        let reopened = open_workspace(root_path.clone()).unwrap();
        assert_eq!(
            reopened
                .config
                .platforms
                .iter()
                .find(|platform| platform.id == "johnson")
                .unwrap()
                .name,
            "示例项目平台"
        );

        fs::write(
            root.join("projects").join("示例项目").join("requirement.yaml"),
            "platform: johnson",
        )
        .unwrap();
        assert!(delete_platform(root_path, "johnson".to_string()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn locks_requirement_writes_and_requires_two_phase_unlock_confirmation() {
        let root =
            std::env::temp_dir().join(format!("blackbox-client-lock-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();

        init_fixture_workspace(root_path.clone(), "锁定测试工作区".to_string()).unwrap();
        create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "LOCK-1001".to_string(),
                name: "目录锁测试".to_string(),
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
        let requirement_dir = root.join("projects").join("示例平台").join("LOCK-1001");
        let original_path = requirement_dir.join("原始资料.md");
        write_text_file(
            original_path.to_string_lossy().to_string(),
            "锁定前内容".to_string(),
        )
        .unwrap();

        let locked = lock_requirement(
            root_path.clone(),
            "projects/示例平台".to_string(),
            "LOCK-1001".to_string(),
            "task-lock-001".to_string(),
            "验证统一写入门禁".to_string(),
            "用户".to_string(),
        )
        .unwrap();
        assert_eq!(locked.client_access.mode, "locked_for_ai");
        assert!(write_text_file(
            requirement_dir
                .join("客户端不应写入.md")
                .to_string_lossy()
                .to_string(),
            "被拒绝".to_string(),
        )
        .is_err());
        assert!(write_binary_file(
            requirement_dir
                .join("客户端不应写入.png")
                .to_string_lossy()
                .to_string(),
            vec![1, 2, 3],
        )
        .is_err());

        fs::rename(&original_path, requirement_dir.join("移动后的资料.md")).unwrap();
        fs::write(requirement_dir.join("AI产物.md"), "外部AI写入").unwrap();

        let preview = scan_requirement_changes(
            root_path.clone(),
            "projects/示例平台".to_string(),
            "LOCK-1001".to_string(),
        )
        .unwrap();
        assert_eq!(preview.requirement.client_access.mode, "locked_for_ai");
        assert!(preview
            .changes
            .moved
            .iter()
            .any(|item| item.from == "原始资料.md" && item.to == "移动后的资料.md"));
        assert!(preview.changes.added.iter().any(|path| path == "AI产物.md"));
        assert!(!preview
            .changes
            .modified
            .iter()
            .any(|path| path == "requirement.yaml"));

        let accepted = accept_unlock_requirement(
            root_path.clone(),
            "projects/示例平台".to_string(),
            "LOCK-1001".to_string(),
        )
        .unwrap();
        assert_eq!(accepted.action, "accepted");
        assert_eq!(accepted.requirement.client_access.mode, "unlocked");
        write_text_file(
            requirement_dir
                .join("解锁后可写.md")
                .to_string_lossy()
                .to_string(),
            "客户端已恢复写入".to_string(),
        )
        .unwrap();
        assert!(root
            .join(".blackbox")
            .join("logs")
            .read_dir()
            .unwrap()
            .next()
            .is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_standard_ai_task_package_and_locks_requirement() {
        let root = std::env::temp_dir().join(format!(
            "blackbox-client-ai-task-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        init_fixture_workspace(root_path.clone(), "AI任务测试工作区".to_string()).unwrap();
        create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "DEMO-1001".to_string(),
                name: "大客户需求理解".to_string(),
                owner: "测试负责人".to_string(),
                planned_test_date: None,
                planned_release_date: None,
                applications: Vec::new(),
                initial_stage: "collecting".to_string(),
                yunxiao: None,
                extensions: Default::default(),
            },
        )
        .unwrap();

        let task = create_ai_task(
            root_path.clone(),
            AiTaskDraft {
                task_type: "requirement_analysis".to_string(),
                platform_id: "foton".to_string(),
                requirement_id: "DEMO-1001".to_string(),
                objective: "形成需求理解和疑问清单".to_string(),
                acceptance_criteria: vec![
                    "输出需求理解文档".to_string(),
                    "输出待确认疑问".to_string(),
                ],
                input_files: vec![AiTaskFileInput {
                    path: "projects/示例平台/DEMO-1001/requirement.yaml".to_string(),
                    role: "需求元数据".to_string(),
                }],
                knowledge_scope: vec![
                    AiKnowledgeScope {
                        scope: "general".to_string(),
                        platform: None,
                    },
                    AiKnowledgeScope {
                        scope: "platform".to_string(),
                        platform: Some("foton".to_string()),
                    },
                    AiKnowledgeScope {
                        scope: "requirement".to_string(),
                        platform: Some("foton".to_string()),
                    },
                ],
                allowed_paths: vec!["projects/示例平台/DEMO-1001/02-需求理解与答疑/**".to_string()],
                forbidden_paths: vec![".blackbox/**".to_string()],
                output_dir: "projects/示例平台/DEMO-1001/02-需求理解与答疑".to_string(),
                output_schema: Some(serde_json::json!({ "type": "object" })),
                lock_requirement: true,
                prompt_override: None,
                execution_mode: None,
            },
        )
        .unwrap();

        assert_eq!(task.task_type, "requirement_analysis");
        assert!(task.requirement_locked);
        assert!(task.dispatch_text.contains("progress.json"));
        let task_dir = root.join(&task.task_dir);
        for file_name in [
            "task.md",
            "manifest.json",
            "inputs.json",
            "write-scope.json",
            "output-schema.json",
            "progress.json",
            "result.json",
        ] {
            assert!(
                task_dir.join(file_name).is_file(),
                "缺少任务文件：{}",
                file_name
            );
        }
        assert!(task_dir.join("logs").is_dir());
        let locked = read_requirement(
            root_path.clone(),
            "projects/示例平台".to_string(),
            "DEMO-1001".to_string(),
        )
        .unwrap();
        assert_eq!(locked.client_access.mode, "locked_for_ai");
        assert_eq!(
            locked.client_access.task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        let listed = list_ai_tasks(root_path).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].dispatch_text.contains("AI任务"));
        assert_eq!(listed[0].input_files[0].fingerprint.len(), 64);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn receives_external_progress_validates_result_and_accepts_with_unlock() {
        let root = std::env::temp_dir().join(format!(
            "blackbox-client-bb07-task-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        init_fixture_workspace(root_path.clone(), "BB07任务中心测试".to_string()).unwrap();
        create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "BB07-1001".to_string(),
                name: "任务结果接收".to_string(),
                owner: String::new(),
                planned_test_date: None,
                planned_release_date: None,
                applications: Vec::new(),
                initial_stage: "analyzing".to_string(),
                yunxiao: None,
                extensions: Default::default(),
            },
        )
        .unwrap();

        let output_path = "projects/示例平台/BB07-1001/02-需求理解与答疑/result.json";
        let task = create_ai_task(
            root_path.clone(),
            AiTaskDraft {
                task_type: "requirement_analysis".to_string(),
                platform_id: "foton".to_string(),
                requirement_id: "BB07-1001".to_string(),
                objective: "接收外部AI结果".to_string(),
                acceptance_criteria: vec!["结果可校验并由用户确认".to_string()],
                input_files: Vec::new(),
                knowledge_scope: Vec::new(),
                allowed_paths: vec!["projects/示例平台/BB07-1001/02-需求理解与答疑/**".to_string()],
                forbidden_paths: Vec::new(),
                output_dir: "projects/示例平台/BB07-1001/02-需求理解与答疑".to_string(),
                output_schema: Some(serde_json::json!({
                    "type": "object",
                    "required": ["status"],
                    "properties": { "status": { "type": "string" } }
                })),
                lock_requirement: true,
                prompt_override: None,
                execution_mode: None,
            },
        )
        .unwrap();
        let task_dir = root.join(&task.task_dir);
        fs::write(
            task_dir.join("progress.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "running",
                "updated_at": chrono_now(),
                "message": "正在整理结果"
            }))
            .unwrap(),
        )
        .unwrap();
        let running = list_ai_tasks(root_path.clone()).unwrap();
        assert_eq!(running[0].status, "running");
        assert_eq!(running[0].progress.message, "正在整理结果");

        fs::write(
            root.join(output_path),
            serde_json::to_string_pretty(&serde_json::json!({ "status": "ok" })).unwrap(),
        )
        .unwrap();
        fs::write(
            task_dir.join("result.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "outputs": [{ "path": output_path, "type": "json", "summary": "结果文件" }],
                "summary": "外部AI已完成",
                "validation": { "passed": true, "errors": [] },
                "pending_items": []
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            task_dir.join("progress.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "completed",
                "updated_at": chrono_now(),
                "message": "结果已完成，等待确认"
            }))
            .unwrap(),
        )
        .unwrap();

        let waiting = list_ai_tasks(root_path.clone()).unwrap();
        assert_eq!(waiting[0].status, "waiting_review");
        assert!(waiting[0].awaiting_confirmation);
        assert!(waiting[0].validation.passed);
        assert_eq!(waiting[0].artifact_count, 1);
        assert!(waiting[0].validation.artifacts[0].exists);
        assert!(waiting[0]
            .file_changes
            .added
            .iter()
            .any(|path| path == output_path));

        let accepted = accept_and_unlock_ai_task(root_path.clone(), task.task_id.clone()).unwrap();
        assert_eq!(accepted.task.status, "completed");
        assert_eq!(accepted.task.review_status, "accepted");
        assert_eq!(accepted.requirement.unwrap().client_access.mode, "unlocked");
        assert!(root
            .join(".blackbox")
            .join("logs")
            .read_dir()
            .unwrap()
            .any(|entry| entry.is_ok()));
        fs::remove_dir_all(root).unwrap();
    }

    /// 诊断：扫描真实工作区，确认各平台需求能否被识别。
    /// 需设置 AITEST_WORKSPACE 环境变量后执行：
    /// `cargo test -- --ignored --nocapture scans_real_workspace`
    #[test]
    #[ignore = "需要 AITEST_WORKSPACE 环境变量"]
    fn scans_real_workspace_requirements() {
        let root = std::env::var("AITEST_WORKSPACE").unwrap_or_default();
        if root.trim().is_empty() {
            return;
        }
        let config = open_workspace(root.clone()).expect("打开工作区失败").config;
        for platform in &config.platforms {
            match scan_requirements(root.clone(), platform.path.clone()) {
                Ok(items) => println!(
                    "平台 {} ({}) 路径 {} -> 识别到 {} 条需求",
                    platform.name,
                    platform.id,
                    platform.path,
                    items.len()
                ),
                Err(error) => println!(
                    "平台 {} ({}) 路径 {} -> 解析失败：{}",
                    platform.name, platform.id, platform.path, error
                ),
            }
        }
        match scan_test_assets(root.clone()) {
            Ok(assets) => {
                println!("测试用例资产：共 {} 个文件", assets.len());
                for asset in assets.iter().take(5) {
                    println!(
                        "  {} / {} -> {}（{}，cases.json={}）",
                        asset.platform_name,
                        asset.requirement_id,
                        asset.name,
                        asset.kind,
                        asset.cases_json_exists
                    );
                }
            }
            Err(error) => println!("测试用例资产扫描失败：{error}"),
        }
    }

    #[test]
    fn searches_workspace_objects_and_text() {
        let root = std::env::temp_dir().join(format!(
            "blackbox-client-search-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        init_fixture_workspace(root_path.clone(), "搜索测试工作区".to_string()).unwrap();
        create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "DEMO-1001".to_string(),
                name: "大客户定价".to_string(),
                owner: "测试负责人".to_string(),
                planned_test_date: None,
                planned_release_date: None,
                applications: Vec::new(),
                initial_stage: "collecting".to_string(),
                yunxiao: None,
                extensions: Default::default(),
            },
        )
        .unwrap();
        let requirement_dir = root.join("projects").join("示例平台").join("DEMO-1001");
        fs::write(
            requirement_dir.join("04-测试用例").join("cases.json"),
            serde_json::to_string(&serde_json::json!({
                "version": "1.0",
                "requirement_id": "DEMO-1001",
                "platform": "示例平台",
                "tree": { "id": "dir-root", "title": "全部用例", "node_type": "platform", "children": [
                    { "id": "dir-pay", "title": "支付", "node_type": "module", "children": [] }
                ] },
                "cases": [{
                    "id": "case-001",
                    "title": "tc-p0-功能测试: 定金原路退回",
                    "directory_id": "dir-pay",
                    "priority": 0,
                    "test_type": "功能测试",
                    "preconditions": [],
                    "steps": [],
                    "tags": ["退款"],
                    "platforms": [],
                    "requirement_refs": [],
                    "asset_refs": [],
                    "requires_evidence": false,
                    "automation_status": "none",
                    "created_by": "user",
                    "version": 1,
                    "status": "confirmed"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            requirement_dir
                .join("01-需求资料")
                .join("需求文档")
                .join("说明.md"),
            "# 需求说明\n\n定金退回需要原路返回。\n",
        )
        .unwrap();

        // 需求编号命中
        let results = search_workspace_inner(&root_path, "demo-1001", None, None, None).unwrap();
        assert!(results.iter().any(|item| item.result_type == "requirement"
            && item.object_id.as_deref() == Some("DEMO-1001")));

        // 用例标题命中（中英混合）
        let results = search_workspace_inner(&root_path, "定金原路", None, None, None).unwrap();
        let case_hit = results
            .iter()
            .find(|item| item.result_type == "case")
            .expect("应命中用例标题");
        assert_eq!(case_hit.object_id.as_deref(), Some("case-001"));
        assert_eq!(case_hit.requirement_id.as_deref(), Some("DEMO-1001"));

        // 文本内容命中 markdown
        let results = search_workspace_inner(&root_path, "原路返回", None, None, None).unwrap();
        assert!(results
            .iter()
            .any(|item| item.result_type == "file" && item.title == "说明.md"));

        // 忽略目录不参与搜索
        let results = search_workspace_inner(&root_path, "搜索测试", None, None, None).unwrap();
        assert!(!results
            .iter()
            .any(|item| item.subtitle.contains("node_modules") || item.subtitle.contains(".git/")));

        // 空查询不返回结果
        assert!(search_workspace_inner(&root_path, "  ", None, None, None)
            .unwrap()
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
