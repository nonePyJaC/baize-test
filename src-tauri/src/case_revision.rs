//! Optimistic, recoverable multi-file saves for case revision operations.
use crate::workspace::{ensure_client_write_allowed, write_atomic_bytes};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

pub(crate) static CASE_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Human-only publication input. Stage and execution facts are never changed.
#[tauri::command]
pub fn confirm_case_finalization(
    requirement_dir: String,
    expected: Vec<u8>,
    confirmed_by: String,
    note: String,
    proposal_refs: Vec<String>,
    source_runs: Vec<String>,
    confirmation_id: String,
) -> Result<serde_json::Value, String> {
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    let _guard = CASE_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    if confirmed_by.trim().is_empty() || note.trim().is_empty() {
        return Err("确认人和定稿说明必填".into());
    }
    if confirmation_id.is_empty()
        || !confirmation_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("确认操作ID无效".into());
    }
    let root = Path::new(&requirement_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = root.join("04-测试用例").join("cases.json");
    ensure_client_write_allowed(&path, Some(&expected))?;
    if fs::read(&path).map_err(|e| e.to_string())? != expected {
        return Err("当前集已变化，请重新预览定稿".into());
    }
    let mut data: Value = serde_json::from_slice(&expected).map_err(|e| e.to_string())?;
    let source_fingerprint = format!("{:x}", Sha256::digest(&expected));
    let cases = data["cases"].as_array().ok_or("当前集缺少cases")?;
    if cases.is_empty() {
        return Err("空用例集不能定稿".into());
    }
    let ids: Vec<Value> = cases.iter().map(|c| c["id"].clone()).collect();
    let versions = root.join("04-测试用例").join("versions");
    ensure_client_write_allowed(&versions.join("manifest.json"), None)?;
    fs::create_dir_all(&versions).map_err(|e| e.to_string())?;
    if !versions
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        return Err("版本目录超出需求范围".into());
    }
    for entry in fs::read_dir(&versions)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
    {
        if !entry.file_name().to_string_lossy().starts_with('v') {
            continue;
        }
        if let Ok(bytes) = fs::read(entry.path().join("manifest.json")) {
            if let Ok(old) = serde_json::from_slice::<Value>(&bytes) {
                if old["confirmation_id"] == confirmation_id {
                    if old["source_fingerprint"] != source_fingerprint
                        || old["confirmed_by"] != confirmed_by
                        || old["note"] != note
                        || old["source_proposals"] != json!(proposal_refs)
                        || old["source_run_ids"] != json!(source_runs)
                    {
                        return Err("相同确认ID的载荷已变化".into());
                    }
                    return Ok(old);
                }
            }
        }
    }
    let mut proposal_sources = Vec::new();
    for reference in &proposal_refs {
        let relative = Path::new(reference);
        if relative
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
            || !relative.starts_with(Path::new("03-测试计划").join("reviews"))
        {
            return Err("提案来源必须位于当前需求reviews目录".into());
        }
        let proposal = root.join(relative);
        if !proposal
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(&root)
        {
            return Err("提案超出当前需求".into());
        }
        let decisions = proposal.with_file_name(format!(
            "{}.decisions.json",
            proposal
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("提案路径无效")?
        ));
        let p = fs::read(&proposal).map_err(|e| e.to_string())?;
        let d = fs::read(&decisions).map_err(|e| e.to_string())?;
        let decision: Value = serde_json::from_slice(&d).map_err(|e| e.to_string())?;
        let items = decision["items"].as_array().ok_or("提案缺少处理记录")?;
        if items.iter().any(|i| {
            !matches!(
                i["status"].as_str(),
                Some("accepted" | "partial" | "retained" | "rejected")
            ) || !i["handling_reason"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
                || matches!(i["status"].as_str(), Some("accepted" | "partial"))
                    && !i["event_ids"].as_array().is_some_and(|a| !a.is_empty())
        }) {
            return Err("来源提案仍有待处理、答疑或未应用项".into());
        }
        proposal_sources.push(json!({"path":reference,"fingerprint":format!("{:x}",Sha256::digest(&p)),"decisions_fingerprint":format!("{:x}",Sha256::digest(&d))}));
    }
    let next = fs::read_dir(&versions)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|e| {
            e.file_name()
                .to_str()?
                .strip_prefix('v')?
                .parse::<u64>()
                .ok()
        })
        .max()
        .unwrap_or(0)
        + 1;
    let version_id = format!("v{next}");
    data["version_id"] = json!(version_id);
    let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    let fingerprint = format!("{:x}", Sha256::digest(&bytes));
    let events_path = root.join("04-测试用例").join("case-events.json");
    let events: Value = if events_path.exists() {
        serde_json::from_slice(&fs::read(&events_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        json!({"events":[]})
    };
    let mut sources = Vec::new();
    for run in &source_runs {
        if !run.starts_with("run-") || Path::new(run).components().count() != 1 {
            return Err("来源轮次无效".into());
        }
        for file in ["run.json", "cases-snapshot.json", "results.json"] {
            let p = root.join("06-测试执行与证据").join(run).join(file);
            let b = fs::read(&p).map_err(|e| e.to_string())?;
            sources.push(
                json!({"run_id":run,"file":file,"fingerprint":format!("{:x}", Sha256::digest(&b))}),
            );
        }
    }
    let manifest = json!({"version_id":version_id,"version":next,"fingerprint":fingerprint,
        "requirement_id":data["requirement_id"],"platform_id":data["platform_id"],"case_count":ids.len(),"case_ids":ids,
        "created_at":crate::workspace::chrono_now(),"created_by":confirmed_by,"confirmed_by":confirmed_by,
        "note":note,"source_proposals":proposal_refs,"proposal_sources":proposal_sources,"source_runs":sources,
        "confirmation_id":confirmation_id,"source_fingerprint":source_fingerprint,"source_run_ids":source_runs,
        "source_event_ids":events["events"].as_array().unwrap_or(&Vec::new()).iter().map(|e| e["event_id"].clone()).collect::<Vec<_>>(),
        "confirmation_status":"confirmed","publication_status":"pending",
        "execution_claim":"定稿不继承旧PASS；新增或实质修改需要匹配修订的执行证据"});
    let stage = versions.join(format!(".pending-{version_id}"));
    fs::create_dir(&stage)
        .map_err(|e| format!("存在未完成的定稿目录，请核对：{} ({e})", stage.display()))?;
    // An incomplete staging directory is never listed as a formal vN.
    write_atomic_bytes(&stage.join("cases.json"), &bytes)?;
    write_atomic_bytes(
        &stage.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )?;
    fs::rename(&stage, versions.join(&version_id)).map_err(|e| e.to_string())?;
    Ok(manifest)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RevisionWrite {
    pub path: String,
    /// None means the file must not exist (creation, never a blind overwrite).
    pub expected: Option<Vec<u8>>,
    pub content: Vec<u8>,
}

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct RevisionOutcome {
    pub applied: bool,
    pub failed: Vec<String>,
    pub conflicts: Vec<String>,
    pub changed_paths: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    state: String,
    writes: Vec<RevisionWrite>,
}

fn allowed_path(root: &Path, path: &str) -> bool {
    let target = Path::new(path);
    let Ok(relative) = target.strip_prefix(root) else {
        return false;
    };
    let parts: Vec<_> = relative.components().collect();
    if parts
        .iter()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return false;
    }
    let names: Vec<_> = parts
        .iter()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect();
    match names.as_slice() {
        [dir, name] if dir == "04-测试用例" => {
            name == "cases.json"
                || name == "case-events.json"
                || name.ends_with(".xmind")
                || name.ends_with(".xmind.changes.json")
                || name.ends_with(".xmind.changes.md")
        }
        [dir, run, name] if dir == "06-测试执行与证据" && run.starts_with("run-") => {
            matches!(
                name.as_ref(),
                "run.json" | "cases-snapshot.json" | "results.json"
            )
        }
        _ => {
            names.first().is_some_and(|dir| dir == "04-测试用例")
                && !names
                    .iter()
                    .any(|part| part == "versions" || part == "revision-transactions")
                && names.last().is_some_and(|name| {
                    name.ends_with(".xmind")
                        || name.ends_with(".xmind.changes.json")
                        || name.ends_with(".xmind.changes.md")
                })
        }
    }
}

fn current(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {}", path.display(), e)),
    }
}

fn write_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    write_atomic_bytes(
        path,
        &serde_json::to_vec(journal).map_err(|e| e.to_string())?,
    )
}

fn rollback(journal: &Journal, interrupted_remove: Option<&Path>) -> Result<(), String> {
    for write in journal.writes.iter().rev() {
        let path = Path::new(&write.path);
        let bytes = current(path)?;
        // Never roll back an unrelated external edit after a crash.
        if bytes == write.expected {
            continue;
        }
        if bytes.as_deref() != Some(write.content.as_slice())
            && !(interrupted_remove == Some(path) && bytes.is_none() && write.expected.is_some())
        {
            return Err(format!("恢复冲突，保留备份与磁盘内容：{}", write.path));
        }
        match &write.expected {
            Some(bytes) => write_atomic_bytes(path, bytes)?,
            None => fs::remove_file(path).map_err(|e| e.to_string())?,
        }
    }
    Ok(())
}

#[tauri::command]
pub fn commit_case_revision(
    requirement_dir: String,
    transaction_id: String,
    writes: Vec<RevisionWrite>,
) -> Result<RevisionOutcome, String> {
    let _guard = CASE_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    commit(Path::new(&requirement_dir), &transaction_id, writes)
}

fn commit(root: &Path, id: &str, writes: Vec<RevisionWrite>) -> Result<RevisionOutcome, String> {
    commit_with_writer(root, id, writes, write_atomic_bytes)
}

fn commit_with_writer(
    root: &Path,
    id: &str,
    writes: Vec<RevisionWrite>,
    mut writer: impl FnMut(&Path, &[u8]) -> Result<(), String>,
) -> Result<RevisionOutcome, String> {
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("无效的修订操作ID".into());
    }
    if !root.is_absolute() || !root.is_dir() {
        return Err("需求目录不存在".into());
    }
    let mut seen = std::collections::HashSet::new();
    for write in &writes {
        if !allowed_path(root, &write.path) || !seen.insert(&write.path) {
            return Err(format!("不允许的修订路径或重复路径：{}", write.path));
        }
        // Resolve the existing parent, rejecting symlinks escaping the requirement.
        let mut parent = PathBuf::from(&write.path);
        while !parent.exists() {
            if !parent.pop() {
                return Err("无效路径".into());
            }
        }
        if !parent
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(root.canonicalize().map_err(|e| e.to_string())?)
        {
            return Err("修订路径越出需求目录".into());
        }
        ensure_client_write_allowed(Path::new(&write.path), Some(&write.content))?;
    }
    let journal_dir = root.join("04-测试用例").join("revision-transactions");
    fs::create_dir_all(&journal_dir).map_err(|e| e.to_string())?;
    // Recover pending transactions before accepting another write.
    for entry in fs::read_dir(&journal_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let mut journal: Journal =
            serde_json::from_slice(&fs::read(entry.path()).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if journal.state == "pending" {
            if journal.writes.iter().any(|w| !allowed_path(root, &w.path)) {
                return Err("恢复日志含非法路径".into());
            }
            rollback(&journal, None)?;
            journal.state = "rolled_back".into();
            write_journal(&entry.path(), &journal)?;
        }
    }
    let journal_path = journal_dir.join(format!("{}.json", id));
    if journal_path.exists() {
        let previous: Journal =
            serde_json::from_slice(&fs::read(&journal_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if previous.writes != writes {
            return Err("同一操作ID不能用于不同内容".into());
        }
        if previous.state == "committed" {
            return Ok(RevisionOutcome {
                applied: true,
                changed_paths: writes.iter().map(|w| w.path.clone()).collect(),
                ..Default::default()
            });
        }
    }
    let mut outcome = RevisionOutcome::default();
    for write in &writes {
        if current(Path::new(&write.path))? != write.expected {
            outcome.conflicts.push(write.path.clone());
        }
    }
    if !outcome.conflicts.is_empty() {
        return Ok(outcome);
    }
    let mut journal = Journal {
        state: "pending".into(),
        writes,
    };
    write_journal(&journal_path, &journal)?;
    for write in &journal.writes {
        if let Err(error) = writer(Path::new(&write.path), &write.content) {
            outcome.failed.push(format!("{}: {}", write.path, error));
            match rollback(&journal, Some(Path::new(&write.path))) {
                Ok(()) => {
                    journal.state = "rolled_back".into();
                    write_journal(&journal_path, &journal)?;
                }
                Err(error) => outcome.failed.push(error),
            }
            return Ok(outcome);
        }
    }
    journal.state = "committed".into();
    write_journal(&journal_path, &journal)?;
    outcome.applied = true;
    outcome.changed_paths = journal.writes.iter().map(|w| w.path.clone()).collect();
    Ok(outcome)
}

/// Readers obtain a consistent projection while a business transaction is committing.
#[tauri::command]
pub fn read_case_revision_files(file_paths: Vec<String>) -> Result<Vec<Vec<u8>>, String> {
    let _guard = CASE_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    file_paths
        .iter()
        .map(|path| fs::read(path).map_err(|e| format!("{}: {}", path, e)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalization_checks_disk_preserves_facts_and_retries_once() {
        let root = fixture();
        let data =
            br#"{"requirement_id":"FIX","platform_id":"mock","cases":[{"id":"stable"}]}"#.to_vec();
        fs::write(root.join("04-测试用例").join("cases.json"), &data).unwrap();
        let run = root.join("06-测试执行与证据").join("run-fixture");
        fs::create_dir_all(&run).unwrap();
        for file in ["run.json", "cases-snapshot.json", "results.json"] {
            fs::write(run.join(file), b"{\"status\":\"passed\"}").unwrap();
        }
        let call = |expected| {
            confirm_case_finalization(
                root.to_string_lossy().into(),
                expected,
                "fixture user".into(),
                "fixture confirmation".into(),
                vec![],
                vec!["run-fixture".into()],
                "confirm-fixture".into(),
            )
        };
        assert!(call(b"changed".to_vec()).is_err());
        let first = call(data.clone()).unwrap();
        let second = call(data).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["version_id"], "v1");
        assert_eq!(first["source_runs"].as_array().unwrap().len(), 3);
        assert_eq!(
            fs::read(run.join("results.json")).unwrap(),
            b"{\"status\":\"passed\"}"
        );
        assert!(!root
            .join("04-测试用例")
            .join("versions")
            .join("v2")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "baize-revision-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("04-测试用例")).unwrap();
        root
    }
    fn write(root: &Path, name: &str, before: Option<&[u8]>, after: &[u8]) -> RevisionWrite {
        RevisionWrite {
            path: root.join("04-测试用例").join(name).to_string_lossy().into(),
            expected: before.map(|v| v.to_vec()),
            content: after.to_vec(),
        }
    }
    #[test]
    fn conflict_changes_nothing_and_retry_is_idempotent() {
        let root = fixture();
        let writes = vec![
            write(&root, "cases.json", None, b"[]"),
            write(&root, "case-events.json", Some(b"old"), b"new"),
        ];
        assert!(!commit(&root, "event-1", writes.clone()).unwrap().applied);
        assert!(!root.join("04-测试用例/cases.json").exists());
        fs::write(root.join("04-测试用例/case-events.json"), b"old").unwrap();
        assert!(commit(&root, "event-1", writes.clone()).unwrap().applied);
        assert!(commit(&root, "event-1", writes).unwrap().applied);
        assert!(!commit(
            &root,
            "invalid",
            vec![write(&root, "versions/v1/cases.json", None, b"oops")]
        )
        .is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recovers_interrupted_write_preserving_external_changes() {
        let root = fixture();
        let w = write(&root, "cases.json", Some(b"before"), b"after");
        let journal = Journal {
            state: "pending".into(),
            writes: vec![w.clone()],
        };
        fs::write(&w.path, b"after").unwrap();
        rollback(&journal, None).unwrap();
        assert_eq!(fs::read(&w.path).unwrap(), b"before");
        fs::write(&w.path, b"human").unwrap();
        assert!(rollback(&journal, None).is_err());
        assert_eq!(fs::read(&w.path).unwrap(), b"human");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_second_write_restores_every_file() {
        let root = fixture();
        fs::write(root.join("04-测试用例/cases.json"), b"original").unwrap();
        fs::write(root.join("04-测试用例/case-events.json"), b"history").unwrap();
        let writes = vec![
            write(&root, "cases.json", Some(b"original"), b"changed"),
            write(&root, "case-events.json", Some(b"history"), b"new-history"),
        ];
        let mut count = 0;
        let result = commit_with_writer(&root, "failure", writes, |path, bytes| {
            count += 1;
            if count == 2 {
                // Reproduce Windows remove-before-rename failure in the existing atomic helper.
                fs::remove_file(path).unwrap();
                return Err("injected rename failure".into());
            }
            write_atomic_bytes(path, bytes)
        })
        .unwrap();
        assert!(!result.applied);
        assert_eq!(
            fs::read(root.join("04-测试用例/cases.json")).unwrap(),
            b"original"
        );
        assert_eq!(
            fs::read(root.join("04-测试用例/case-events.json")).unwrap(),
            b"history"
        );
        assert!(!result.failed.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
