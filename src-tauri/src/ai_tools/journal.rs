use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    ensure_ai_write_gate, ensure_move_allowed, is_change_record_file, relative_text,
    session_requirement_dir,
};
use crate::sessions::{load_session, sessions_dir};
use crate::workspace::{
    chrono_now, load_initialized_workspace, write_atomic_bytes, write_internal_text_file,
};

#[derive(Clone, Copy)]
pub(crate) struct RunScope<'a> {
    pub root: &'a Path,
    pub session_id: &'a str,
    pub run_id: &'a str,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct PathState {
    pub exists: bool,
    pub kind: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct JournalEntry {
    pub seq: u64,
    pub op: String,
    pub path: String,
    pub from: Option<String>,
    pub before: PathState,
    pub after: Option<PathState>,
    pub backup: Option<String>,
    pub restored: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct JournalFile {
    pub run_id: String,
    pub created_at: String,
    pub entries: Vec<JournalEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreItem {
    pub seq: u64,
    pub path: String,
    pub action: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreOutcome {
    pub restored: usize,
    pub skipped: usize,
    pub conflicts: usize,
    pub items: Vec<RestoreItem>,
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunSummary {
    pub run_id: String,
    pub created_at: String,
    pub changes: usize,
    pub pending: usize,
}

pub(crate) fn validate_run_id(run_id: &str) -> Result<&str, String> {
    let valid = !run_id.is_empty()
        && run_id.len() <= 80
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(run_id)
    } else {
        Err("运行编号不合法".to_string())
    }
}

fn run_dir(root: &Path, session_id: &str, run_id: &str) -> PathBuf {
    sessions_dir(root)
        .join(session_id)
        .join("runs")
        .join(run_id)
}

fn journal_path(dir: &Path) -> PathBuf {
    dir.join("journal.json")
}

fn load_journal(dir: &Path, run_id: &str) -> Result<JournalFile, String> {
    let path = journal_path(dir);
    if !path.is_file() {
        return Ok(JournalFile {
            run_id: run_id.to_string(),
            created_at: String::new(),
            entries: Vec::new(),
        });
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| format!("运行记录无法解析：{error}"))
}

fn save_journal(dir: &Path, journal: &JournalFile) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let text = serde_json::to_string_pretty(journal).map_err(|error| error.to_string())?;
    write_internal_text_file(&journal_path(dir), text)
}

fn sha256_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn capture(path: &Path) -> Result<PathState, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PathState::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    if metadata.is_dir() {
        return Ok(PathState {
            exists: true,
            kind: "dir".to_string(),
            sha256: String::new(),
        });
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(PathState {
        exists: true,
        kind: "file".to_string(),
        sha256: sha256_of(&bytes),
    })
}

pub(crate) fn journaled<T>(
    scope: Option<RunScope>,
    op: &str,
    path: &Path,
    from: Option<&Path>,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let Some(scope) = scope else {
        return action();
    };
    let dir = run_dir(scope.root, scope.session_id, scope.run_id);
    let source = from.unwrap_or(path);
    let before = capture(source)?;
    let backup = if from.is_none() && before.kind == "file" {
        Some(fs::read(source).map_err(|error| error.to_string())?)
    } else {
        None
    };
    let mut journal = load_journal(&dir, scope.run_id)?;
    if journal.created_at.is_empty() {
        journal.created_at = chrono_now();
    }
    let seq = journal.entries.len() as u64 + 1;
    let backup_name = match backup {
        Some(bytes) => {
            let name = format!("{seq}.bin");
            fs::create_dir_all(dir.join("backups")).map_err(|error| error.to_string())?;
            fs::write(dir.join("backups").join(&name), bytes).map_err(|error| error.to_string())?;
            Some(name)
        }
        None => None,
    };
    journal.entries.push(JournalEntry {
        seq,
        op: op.to_string(),
        path: relative_text(scope.root, path),
        from: from.map(|item| relative_text(scope.root, item)),
        before,
        after: None,
        backup: backup_name,
        restored: false,
        created_at: chrono_now(),
    });
    save_journal(&dir, &journal)?;
    let result = action();
    let after = capture(path)?;
    if let Some(entry) = journal.entries.iter_mut().find(|entry| entry.seq == seq) {
        entry.after = Some(after);
    }
    save_journal(&dir, &journal)?;
    result
}

enum Undo {
    RestoreBytes,
    RestoreDir,
    Trash,
    RemoveDir,
    MoveBack,
}

impl Undo {
    fn label(&self) -> &'static str {
        match self {
            Undo::RestoreBytes => "恢复原内容",
            Undo::RestoreDir => "恢复文件夹",
            Undo::Trash => "移入回收区",
            Undo::RemoveDir => "删除空文件夹",
            Undo::MoveBack => "移回原位置",
        }
    }
}

enum Step {
    Noop,
    Skip(String),
    Conflict(String),
    Do(Undo),
}

fn decide(
    entry: &JournalEntry,
    target_now: &PathState,
    source_now: &PathState,
    backup_ready: bool,
    target: &Path,
) -> Step {
    let Some(after) = entry.after.as_ref() else {
        return Step::Conflict("操作结果未记录，无法判断能否还原".to_string());
    };
    if entry.from.is_none() && entry.before == *after {
        return Step::Noop;
    }
    match entry.op.as_str() {
        "move" if target_now != after => Step::Conflict("移动后的文件已被修改或移走".to_string()),
        "move" if source_now.exists => Step::Conflict("原位置已被其他内容占用".to_string()),
        "move" => Step::Do(Undo::MoveBack),
        "write" | "create" | "delete" | "mkdir" if target_now != after => {
            Step::Conflict("本次运行之后该路径又被修改".to_string())
        }
        "write" | "create" if entry.before.exists && !backup_ready => {
            Step::Conflict("备份缺失，无法恢复原内容".to_string())
        }
        "write" | "create" if entry.before.exists => Step::Do(Undo::RestoreBytes),
        "write" | "create" if is_change_record_file(target) => {
            Step::Skip("旁路修改记录按规则保留，未删除".to_string())
        }
        "write" | "create" => Step::Do(Undo::Trash),
        "delete" if entry.before.kind == "dir" => Step::Do(Undo::RestoreDir),
        "delete" if !backup_ready => Step::Conflict("备份缺失，无法恢复原文件".to_string()),
        "delete" => Step::Do(Undo::RestoreBytes),
        "mkdir" => Step::Do(Undo::RemoveDir),
        other => Step::Conflict(format!("未知的运行操作：{other}")),
    }
}

fn gate(requirement_dir: &Path, undo: &Undo, target: &Path, source: &Path) -> Result<(), String> {
    match undo {
        Undo::MoveBack => ensure_move_allowed(requirement_dir, target, source),
        _ => ensure_ai_write_gate(requirement_dir, target, None),
    }
}

fn gated(step: Step, requirement_dir: &Path, target: &Path, source: &Path) -> Step {
    match step {
        Step::Do(undo) => match gate(requirement_dir, &undo, target, source) {
            Ok(()) => Step::Do(undo),
            Err(reason) => Step::Conflict(reason),
        },
        other => other,
    }
}

fn locations(root: &Path, dir: &Path, entry: &JournalEntry) -> (PathBuf, PathBuf, Option<PathBuf>) {
    let target = root.join(&entry.path);
    let source = entry
        .from
        .as_ref()
        .map_or_else(|| target.clone(), |from| root.join(from));
    let backup = entry
        .backup
        .as_ref()
        .map(|name| dir.join("backups").join(name));
    (target, source, backup)
}

fn state_in(sim: &mut HashMap<PathBuf, PathState>, path: &Path) -> Result<PathState, String> {
    if let Some(state) = sim.get(path) {
        return Ok(state.clone());
    }
    let state = capture(path)?;
    sim.insert(path.to_path_buf(), state.clone());
    Ok(state)
}

fn remember(
    sim: &mut HashMap<PathBuf, PathState>,
    entry: &JournalEntry,
    undo: &Undo,
    target: &Path,
    source: &Path,
) {
    match undo {
        Undo::RestoreBytes | Undo::RestoreDir => {
            sim.insert(target.to_path_buf(), entry.before.clone());
        }
        Undo::Trash | Undo::RemoveDir => {
            sim.insert(target.to_path_buf(), PathState::default());
        }
        Undo::MoveBack => {
            sim.insert(target.to_path_buf(), PathState::default());
            sim.insert(source.to_path_buf(), entry.before.clone());
        }
    }
}

fn item(entry: &JournalEntry, action: &str, status: &str, reason: Option<String>) -> RestoreItem {
    RestoreItem {
        seq: entry.seq,
        path: entry.path.clone(),
        action: action.to_string(),
        status: status.to_string(),
        reason,
    }
}

fn plan(
    root: &Path,
    requirement_dir: &Path,
    session_id: &str,
    run_id: &str,
) -> Result<Vec<RestoreItem>, String> {
    let dir = run_dir(root, session_id, run_id);
    let journal = load_journal(&dir, run_id)?;
    let mut sim: HashMap<PathBuf, PathState> = HashMap::new();
    let mut items = Vec::new();
    for entry in journal.entries.iter().rev().filter(|entry| !entry.restored) {
        let (target, source, backup) = locations(root, &dir, entry);
        let target_now = state_in(&mut sim, &target)?;
        let source_now = state_in(&mut sim, &source)?;
        let backup_ready = backup.as_ref().is_some_and(|path| path.is_file());
        let step = decide(entry, &target_now, &source_now, backup_ready, &target);
        let step = gated(step, requirement_dir, &target, &source);
        items.push(match &step {
            Step::Noop => item(entry, "none", "noop", Some("无实际变化".to_string())),
            Step::Skip(reason) => item(entry, "skip", "skipped", Some(reason.clone())),
            Step::Conflict(reason) => item(entry, "conflict", "conflict", Some(reason.clone())),
            Step::Do(undo) => item(entry, undo.label(), "ready", None),
        });
        if let Step::Do(undo) = step {
            remember(&mut sim, entry, &undo, &target, &source);
        }
    }
    Ok(items)
}

fn execute(
    trash_root: &Path,
    entry: &JournalEntry,
    undo: &Undo,
    target: &Path,
    source: &Path,
    backup: Option<&Path>,
) -> Result<(), String> {
    match undo {
        Undo::RestoreBytes => {
            let backup = backup.ok_or_else(|| "备份缺失，无法恢复原内容".to_string())?;
            let bytes = fs::read(backup).map_err(|error| error.to_string())?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            write_atomic_bytes(target, &bytes)
        }
        Undo::RestoreDir => fs::create_dir_all(target).map_err(|error| error.to_string()),
        Undo::Trash => {
            let name = target
                .file_name()
                .map(|name| name.to_os_string())
                .unwrap_or_else(|| "未命名文件".into());
            let destination = trash_root.join(entry.seq.to_string()).join(name);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(target, &destination).map_err(|error| error.to_string())
        }
        Undo::RemoveDir => {
            if fs::read_dir(target)
                .map_err(|error| error.to_string())?
                .next()
                .is_some()
            {
                return Err("文件夹内仍有其他内容，未删除".to_string());
            }
            fs::remove_dir(target).map_err(|error| error.to_string())
        }
        Undo::MoveBack => {
            if let Some(parent) = source.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(target, source).map_err(|error| error.to_string())
        }
    }
}

fn apply(
    root: &Path,
    requirement_dir: &Path,
    session_id: &str,
    run_id: &str,
) -> Result<RestoreOutcome, String> {
    let dir = run_dir(root, session_id, run_id);
    let mut journal = load_journal(&dir, run_id)?;
    let trash_root = root
        .join(".blackbox")
        .join("trash")
        .join(session_id)
        .join(run_id);
    let order: Vec<usize> = (0..journal.entries.len())
        .rev()
        .filter(|&index| !journal.entries[index].restored)
        .collect();
    let mut items = Vec::new();
    let mut changed_paths = Vec::new();
    for index in order {
        let entry = journal.entries[index].clone();
        let (target, source, backup) = locations(root, &dir, &entry);
        let target_now = capture(&target)?;
        let source_now = capture(&source)?;
        let backup_ready = backup.as_ref().is_some_and(|path| path.is_file());
        let step = decide(&entry, &target_now, &source_now, backup_ready, &target);
        let step = gated(step, requirement_dir, &target, &source);
        let outcome = match step {
            Step::Do(undo) => {
                match execute(
                    &trash_root,
                    &entry,
                    &undo,
                    &target,
                    &source,
                    backup.as_deref(),
                ) {
                    Ok(()) => {
                        journal.entries[index].restored = true;
                        save_journal(&dir, &journal)?;
                        changed_paths.push(entry.path.clone());
                        item(&entry, undo.label(), "done", None)
                    }
                    Err(reason) => item(&entry, undo.label(), "conflict", Some(reason)),
                }
            }
            Step::Noop => {
                journal.entries[index].restored = true;
                item(&entry, "none", "noop", Some("无实际变化".to_string()))
            }
            Step::Skip(reason) => item(&entry, "skip", "skipped", Some(reason)),
            Step::Conflict(reason) => item(&entry, "conflict", "conflict", Some(reason)),
        };
        items.push(outcome);
    }
    save_journal(&dir, &journal)?;
    let restored = items.iter().filter(|item| item.status == "done").count();
    let skipped = items.iter().filter(|item| item.status == "skipped").count();
    let conflicts = items
        .iter()
        .filter(|item| item.status == "conflict")
        .count();
    Ok(RestoreOutcome {
        restored,
        skipped,
        conflicts,
        items,
        changed_paths,
    })
}

fn is_change(entry: &JournalEntry) -> bool {
    entry.from.is_some()
        || entry
            .after
            .as_ref()
            .is_some_and(|after| *after != entry.before)
}

fn list_runs(root: &Path, session_id: &str) -> Result<Vec<RunSummary>, String> {
    let base = sessions_dir(root).join(session_id).join("runs");
    let Ok(entries) = fs::read_dir(&base) else {
        return Ok(Vec::new());
    };
    let mut runs = Vec::new();
    for dir_entry in entries.flatten() {
        let run_id = dir_entry.file_name().to_string_lossy().to_string();
        if validate_run_id(&run_id).is_err() {
            continue;
        }
        let journal = load_journal(&dir_entry.path(), &run_id)?;
        let changes: Vec<&JournalEntry> = journal
            .entries
            .iter()
            .filter(|entry| is_change(entry))
            .collect();
        let pending = changes.iter().filter(|entry| !entry.restored).count();
        runs.push(RunSummary {
            run_id,
            created_at: journal.created_at,
            changes: changes.len(),
            pending,
        });
    }
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(runs)
}

fn restore_context(
    root_path: &str,
    session_id: &str,
    run_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let (root, config) = load_initialized_workspace(root_path)?;
    let session = load_session(&root, session_id)?;
    let requirement_dir = session_requirement_dir(&root, &config, &session)?;
    validate_run_id(run_id)?;
    Ok((root, requirement_dir))
}

#[tauri::command]
pub fn list_ai_session_runs(
    root_path: String,
    session_id: String,
) -> Result<Vec<RunSummary>, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    load_session(&root, &session_id)?;
    list_runs(&root, &session_id)
}

#[tauri::command]
pub fn plan_ai_session_restore(
    root_path: String,
    session_id: String,
    run_id: String,
) -> Result<Vec<RestoreItem>, String> {
    let (root, requirement_dir) = restore_context(&root_path, &session_id, &run_id)?;
    plan(&root, &requirement_dir, &session_id, &run_id)
}

#[tauri::command]
pub fn apply_ai_session_restore(
    root_path: String,
    session_id: String,
    run_id: String,
) -> Result<RestoreOutcome, String> {
    let (root, requirement_dir) = restore_context(&root_path, &session_id, &run_id)?;
    apply(&root, &requirement_dir, &session_id, &run_id)
}
