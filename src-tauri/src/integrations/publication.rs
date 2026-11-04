//! Confirmed immutable version -> preview -> checkpointed receipts. Never edits versions/runs.
use super::{call, ports::*};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublicationInput {
    pub requirement_dir: String,
    pub version_id: String,
    pub fingerprint: String,
    pub repository: String,
    pub directory: String,
    pub case_ids: Vec<String>,
}
fn lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(Default::default)
}
pub fn digest(v: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(v).unwrap()))
}
fn root(input: &PublicationInput) -> Result<PathBuf, String> {
    if !input.version_id.starts_with('v') || input.version_id[1..].parse::<u64>().is_err() {
        return Err("正式版本ID无效".into());
    }
    requirement_root(&input.requirement_dir)
}
fn requirement_root(requirement_dir: &str) -> Result<PathBuf, String> {
    let root = Path::new(requirement_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.join("requirement.yaml").is_file() {
        return Err("不是有效需求目录".into());
    }
    Ok(root)
}
/// Return only human-confirmed versions whose manifest, identity, and content hash still agree.
pub fn list_confirmed_versions(requirement_dir: &str) -> Result<Value, String> {
    let root = requirement_root(requirement_dir)?;
    let requirement: Value = serde_yaml::from_slice(
        &fs::read(root.join("requirement.yaml")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let requirement_id = text(&requirement["requirement"], "id");
    let platform_id = text(&requirement["requirement"], "platform");
    if requirement_id.is_empty() || platform_id.is_empty() {
        return Err("需求元数据缺少需求或平台标识".into());
    }

    let versions_path = root.join("04-测试用例").join("versions");
    let versions_root = match versions_path.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({
                "requirement_id": requirement_id,
                "platform_id": platform_id,
                "latest_version_id": Value::Null,
                "versions": [],
            }));
        }
        Err(error) => return Err(error.to_string()),
    };
    if !versions_root.starts_with(&root) {
        return Err("正式版本目录超出需求范围".into());
    }

    let mut verified = Vec::<(u64, Value)>::new();
    for entry in fs::read_dir(&versions_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(number) = name
            .strip_prefix('v')
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|number| *number > 0)
        else {
            continue;
        };
        let version_dir = match entry.path().canonicalize() {
            Ok(path) if path.starts_with(&versions_root) => path,
            _ => continue,
        };
        let manifest_path = version_dir.join("manifest.json").canonicalize();
        let cases_path = version_dir.join("cases.json").canonicalize();
        let (Ok(manifest_path), Ok(cases_path)) = (manifest_path, cases_path) else {
            continue;
        };
        if !manifest_path.starts_with(&version_dir) || !cases_path.starts_with(&version_dir) {
            continue;
        }
        let manifest: Value = match fs::read(&manifest_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(value) => value,
            None => continue,
        };
        if manifest["confirmation_status"] != "confirmed"
            || text(&manifest, "version_id") != name
            || text(&manifest, "confirmed_by").trim().is_empty()
        {
            continue;
        }
        let cases_bytes = match fs::read(&cases_path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let fingerprint = format!("{:x}", Sha256::digest(&cases_bytes));
        if text(&manifest, "fingerprint") != fingerprint {
            continue;
        }
        let cases_doc: Value = match serde_json::from_slice(&cases_bytes) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if text(&cases_doc, "requirement_id") != requirement_id
            || text(&cases_doc, "platform_id") != platform_id
            || text(&manifest, "requirement_id") != requirement_id
            || text(&manifest, "platform_id") != platform_id
        {
            continue;
        }
        let Some(cases) = cases_doc["cases"].as_array() else {
            continue;
        };
        let case_ids: Vec<String> = cases
            .iter()
            .filter_map(|case| case["id"].as_str().map(str::to_string))
            .collect();
        if case_ids.is_empty()
            || case_ids.len() != cases.len()
            || case_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != case_ids.len()
            || manifest["case_ids"] != json!(case_ids)
            || manifest["case_count"]
                .as_u64()
                .is_some_and(|count| count as usize != case_ids.len())
        {
            continue;
        }
        verified.push((
            number,
            json!({
                "version_id": name,
                "fingerprint": fingerprint,
                "case_count": case_ids.len(),
                "case_ids": case_ids,
                "confirmed_at": manifest["created_at"],
                "confirmed_by": manifest["confirmed_by"],
            }),
        ));
    }
    verified.sort_by_key(|(number, _)| *number);
    let latest_version_id = verified
        .last()
        .map(|(_, version)| version["version_id"].clone())
        .unwrap_or(Value::Null);
    let versions: Vec<Value> = verified.into_iter().map(|(_, version)| version).collect();
    Ok(json!({
        "requirement_id": requirement_id,
        "platform_id": platform_id,
        "latest_version_id": latest_version_id,
        "versions": versions,
    }))
}
fn version(input: &PublicationInput) -> Result<Value, String> {
    let root = root(input)?;
    let dir = root
        .join("04-测试用例")
        .join("versions")
        .join(&input.version_id);
    if !dir
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        return Err("版本超出需求范围".into());
    }
    let m: Value =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let bytes = fs::read(dir.join("cases.json")).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if m["confirmation_status"] != "confirmed"
        || m["fingerprint"] != input.fingerprint
        || hash != input.fingerprint
        || m["version_id"] != input.version_id
        || text(&m, "confirmed_by").is_empty()
    {
        return Err("发布源未人工确认或版本指纹变化，请重新核对定稿".into());
    }
    let doc: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let requirement: Value = serde_yaml::from_slice(
        &fs::read(root.join("requirement.yaml")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if requirement["requirement"]["id"] != doc["requirement_id"]
        || requirement["requirement"]["platform"] != doc["platform_id"]
    {
        return Err("正式版本不属于当前需求/平台".into());
    }
    let ids = doc["cases"]
        .as_array()
        .ok_or("版本缺少用例")?
        .iter()
        .map(|v| text(v, "id"))
        .collect::<Vec<_>>();
    if input.case_ids.is_empty()
        || input.case_ids.iter().any(|id| !ids.contains(id))
        || input
            .case_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != input.case_ids.len()
    {
        return Err("发布用例ID为空、重复或不属于正式版本".into());
    }
    if m["case_ids"] != json!(ids)
        || m["requirement_id"] != doc["requirement_id"]
        || m["platform_id"] != doc["platform_id"]
    {
        return Err("manifest与正式用例身份不一致".into());
    }
    Ok(doc)
}
fn path(c: &Connection, i: &PublicationInput) -> Result<PathBuf, String> {
    let base = root(i)?.join("04-测试用例").join("integrations");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    if !base
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root(i)?)
    {
        return Err("集成状态目录越界".into());
    }
    let scope = digest(&json!([c.connection_id, i.repository]));
    Ok(base.join(format!("{scope}.json")))
}
fn load(c: &Connection, i: &PublicationInput) -> Result<Value, String> {
    let p = path(c, i)?;
    let state=super::state_io::read(&p)?.unwrap_or_else(||json!({"schema_version":1,"connection_id":c.connection_id,"instance":c.instance(),"repository":i.repository,"mappings":{},"receipts":[]}));
    if state["instance"] != c.instance() {
        return Err("连接实例已变更，请使用新的connection_id；历史映射保留".into());
    }
    Ok(state)
}
fn save(c: &Connection, i: &PublicationInput, s: &Value) -> Result<(), String> {
    let p = path(c, i)?;
    crate::workspace::ensure_client_write_allowed(&p, None)?;
    super::state_io::write(&p, s)
}

fn yunxiao_owner_issue(c: &Connection, case: &Value) -> Option<(&'static str, String)> {
    if c.provider_id != "yunxiao" {
        return None;
    }
    let Some(owners) = case["owners"]
        .as_array()
        .filter(|owners| !owners.is_empty())
    else {
        return Some((
            "missing_owner",
            "缺少负责人；请在 AI 对话中指定并关联云效组织成员".into(),
        ));
    };
    if owners.len() != 1 {
        return Some(("invalid_owner", "云效用例目前只支持一个负责人".into()));
    }
    let owner = &owners[0];
    if owner["entity_type"] != "member"
        || owner["connection_id"] != c.connection_id
        || owner["provider_id"] != c.provider_id
        || owner["external_id"]
            .as_str()
            .map_or(true, |id| id.trim().is_empty())
    {
        return Some((
            "invalid_owner",
            "负责人尚未关联到当前云效连接的成员ID".into(),
        ));
    }
    None
}

pub async fn preview(c: &Connection, i: &PublicationInput) -> Result<Value, String> {
    let _guard = lock().lock().await;
    preview_inner(c, i).await
}
async fn preview_inner(c: &Connection, i: &PublicationInput) -> Result<Value, String> {
    super::adapter(c)?;
    let doc = version(i)?;
    let state = load(c, i)?;
    let fields = list(call(c, "testcase_fields", &json!({"repository": i.repository})).await?);
    let mut items = Vec::new();
    for case in doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| i.case_ids.contains(&text(v, "id")))
    {
        let id = text(case, "id");
        let custom = match super::yunxiao::resolve_case_fields(&fields, case) {
            Ok(custom) => custom,
            Err(error) => {
                let hash = digest(&json!([case, i.directory]));
                items.push(json!({"case_id":id,"title":case["title"],"action":"invalid_fields","digest":hash,"error":error}));
                continue;
            }
        };
        let hash = digest(&json!([case, i.directory, custom]));
        if let Some((action, error)) = yunxiao_owner_issue(c, case) {
            items.push(json!({"case_id":id,"title":case["title"],"action":action,"digest":hash,"error":error}));
            continue;
        }
        let old = &state["mappings"][&id];
        let mut action = if old.is_null() {
            "new"
        } else if old["status"] == "sending" || old["status"] == "uncertain" {
            "unmapped"
        } else if old["digest"] == hash {
            "unchanged"
        } else {
            "update"
        };
        let remote = text(old, "external_id");
        if !remote.is_empty() {
            match call(
                c,
                "case",
                &json!({"repository":i.repository,"external_id":remote}),
            )
            .await
            {
                Ok(v) => {
                    if old.get("remote_digest").is_some() && old["remote_digest"] != digest(&v) {
                        action = "conflict";
                    }
                    if !super::adapter(c)?.supports_case_move()
                        && old.get("target_directory").is_some()
                        && old["target_directory"] != i.directory
                        && v["directory_ref"] != i.directory
                    {
                        action = "conflict";
                    }
                }
                Err(_) => action = "conflict",
            }
        }
        items.push(json!({"case_id":id,"title":case["title"],"action":action,"digest":hash,"external_id":remote,"custom_field_values":custom}));
    }
    let all_ids = doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| text(v, "id"))
        .collect::<Vec<_>>();
    if let Some(m) = state["mappings"].as_object() {
        for (id, mapping) in m {
            if !all_ids.contains(id) && mapping["archived"] != true {
                items.push(json!({"case_id":id,"title":mapping["title"],"action":"proposed_archive","external_id":mapping["external_id"],"digest":mapping["digest"]}));
            }
        }
    }
    let manifest = fs::read(
        root(i)?
            .join("04-测试用例")
            .join("versions")
            .join(&i.version_id)
            .join("manifest.json"),
    )
    .map_err(|e| e.to_string())?;
    let token = digest(&json!([i, &items, &state, digest(&json!(manifest))]));
    let receipt = json!({"schema_version":1,"connection_id":c.connection_id,"provider_id":c.provider_id,"version_id":i.version_id,"fingerprint":i.fingerprint,"repository":i.repository,"directory":i.directory,"status":"preview","simulated":super::adapter(c)?.simulated(),"updated_at":crate::workspace::chrono_now(),"items":items});
    Ok(
        json!({"input":i,"connection_id":c.connection_id,"items":items,"preview_token":token,"receipt":receipt}),
    )
}
pub async fn execute(
    c: &Connection,
    i: &PublicationInput,
    token: &str,
    archives: &[String],
) -> Result<Value, String> {
    execute_cancellable(c, i, token, archives, None).await
}
pub async fn execute_cancellable(
    c: &Connection,
    i: &PublicationInput,
    token: &str,
    archives: &[String],
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<Value, String> {
    let _guard = lock().lock().await;
    let plan = preview_inner(c, i).await?;
    if plan["preview_token"] != token {
        return Err("源版本、远端或发布映射已变化，请重新预览并确认".into());
    }
    if let Some(item) = plan["items"].as_array().and_then(|items| {
        items.iter().find(|item| {
            matches!(
                item["action"].as_str(),
                Some("missing_owner" | "invalid_owner" | "invalid_fields")
            )
        })
    }) {
        return Err(format!(
            "发布未执行：用例「{}」{}",
            text(item, "title"),
            text(item, "error")
        ));
    }
    let doc = version(i)?;
    let mut state = load(c, i)?;
    let mut receipt = plan["receipt"].clone();
    receipt["status"] = json!("running");
    let index = state["receipts"].as_array().unwrap().len();
    state["receipts"]
        .as_array_mut()
        .unwrap()
        .push(receipt.clone());
    save(c, i, &state)?;
    for n in 0..receipt["items"].as_array().unwrap().len() {
        if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::SeqCst)) {
            receipt["status"] = json!("interrupted");
            state["receipts"][index] = receipt.clone();
            save(c, i, &state)?;
            return Ok(receipt);
        }
        version(i)?;
        let item = receipt["items"][n].clone();
        let id = text(&item, "case_id");
        let action = text(&item, "action");
        if action == "proposed_archive" {
            if archives.contains(&id) {
                state["mappings"][&id]["archived"] = json!(true);
                receipt["items"][n]["action"] = json!("archived_locally");
            }
        } else if action == "new" || action == "update" {
            let case = doc["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == id)
                .unwrap();
            let mut mapping = item.clone();
            mapping["status"] = json!("sending");
            state["mappings"][&id] = mapping.clone();
            state["receipts"][index] = receipt.clone();
            save(c, i, &state)?;
            let args = json!({"repository":i.repository,"directory":i.directory,"case":case,"external_id":item["external_id"],"digest":item["digest"],"custom_field_values":item["custom_field_values"]});
            match call(c, "publish_case", &args).await {
                Ok(v) => {
                    mapping["external_id"] = v["external_id"].clone();
                    mapping["status"] = json!("success");
                    mapping["archived"] = json!(false);
                    mapping["target_directory"] = json!(i.directory);
                    // Save the ID immediately. A failed follow-up read must never lose creation identity.
                    state["mappings"][&id] = mapping.clone();
                    save(c, i, &state)?;
                    if let Ok(remote) = call(
                        c,
                        "case",
                        &json!({"repository":i.repository,"external_id":v["external_id"]}),
                    )
                    .await
                    {
                        mapping["remote_digest"] = json!(digest(&remote));
                    }
                    state["mappings"][&id] = mapping;
                    receipt["items"][n]["action"] = json!("success");
                    receipt["items"][n]["external_id"] = v["external_id"].clone();
                    receipt["items"][n]["remote_receipt"] = v;
                }
                Err(e) => {
                    // A timeout may have committed remotely. Only definitely unsent memory failures auto-retry.
                    if e.starts_with("NOT_COMMITTED:") {
                        if action == "new" {
                            state["mappings"].as_object_mut().unwrap().remove(&id);
                        } else {
                            state["mappings"][&id]["status"] = json!("failed");
                        }
                    } else {
                        state["mappings"][&id]["status"] = json!("uncertain");
                    }
                    receipt["items"][n]["action"] = json!("failed");
                    receipt["items"][n]["error"] = json!(e);
                }
            }
        }
        state["receipts"][index] = receipt.clone();
        save(c, i, &state)?;
        if let Err(error) = version(i) {
            receipt["status"] = json!("source_changed");
            receipt["error"] = json!(error);
            state["receipts"][index] = receipt.clone();
            save(c, i, &state)?;
            return Ok(receipt);
        }
    }
    let done = receipt["items"].as_array().unwrap().iter().all(|v| {
        matches!(
            v["action"].as_str(),
            Some("success" | "unchanged" | "proposed_archive" | "archived_locally")
        )
    });
    receipt["status"] = json!(if done {
        if super::adapter(c)?.simulated() {
            "simulated"
        } else {
            "published"
        }
    } else {
        "partial"
    });
    receipt["updated_at"] = json!(crate::workspace::chrono_now());
    state["receipts"][index] = receipt.clone();
    save(c, i, &state)?;
    Ok(receipt)
}
#[tauri::command]
pub async fn preview_publication(
    connection: Connection,
    input: PublicationInput,
) -> Result<Value, String> {
    preview(&connection, &input).await
}
#[tauri::command]
pub async fn execute_publication(
    connection: Connection,
    input: PublicationInput,
    preview_token: String,
    archive_ids: Vec<String>,
) -> Result<Value, String> {
    execute(&connection, &input, &preview_token, &archive_ids).await
}
#[tauri::command]
pub async fn publication_history(
    connection: Connection,
    input: PublicationInput,
) -> Result<Value, String> {
    let _g = lock().lock().await;
    Ok(load(&connection, &input)?["receipts"].clone())
}
#[tauri::command]
pub async fn list_publication_history(
    requirement_dir: String,
    connection_id: Option<String>,
) -> Result<Value, String> {
    let _g = lock().lock().await;
    let root = Path::new(&requirement_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.join("requirement.yaml").is_file() {
        return Err("不是有效需求".into());
    }
    let base = root.join("04-测试用例").join("integrations");
    if !base.exists() {
        return Ok(json!([]));
    }
    if !base
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("状态目录越界".into());
    }
    let names = fs::read_dir(&base)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|e| {
            e.path()
                .file_stem()
                .and_then(|s| s.to_str())
                .map(String::from)
        })
        .collect::<std::collections::BTreeSet<_>>();
    let mut receipts = Vec::new();
    for name in names {
        if let Some(v) = super::state_io::read(&base.join(format!("{name}.json")))? {
            if connection_id
                .as_ref()
                .is_none_or(|id| v["connection_id"] == *id)
            {
                if let Some(r) = v["receipts"].as_array() {
                    receipts.extend(r.clone());
                }
            }
        }
    }
    Ok(json!(receipts))
}
/// Explicit recovery: read the exact remote ID, never guess by matching titles.
#[tauri::command]
pub async fn reconcile_publication(
    connection: Connection,
    input: PublicationInput,
    case_id: String,
    external_id: String,
    note: String,
) -> Result<Value, String> {
    let _g = lock().lock().await;
    if note.trim().is_empty() || external_id.trim().is_empty() {
        return Err("远端ID和人工核对说明必填".into());
    }
    let doc = version(&input)?;
    let case = doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == case_id)
        .ok_or("用例不属于版本")?;
    let remote = call(
        &connection,
        "case",
        &json!({"repository":input.repository,"external_id":external_id}),
    )
    .await?;
    let mut state = load(&connection, &input)?;
    if state["mappings"]
        .as_object()
        .unwrap()
        .iter()
        .any(|(id, v)| id != &case_id && v["external_id"] == external_id)
    {
        return Err("此远端ID已映射其他本地用例".into());
    }
    state["mappings"][&case_id] = json!({"external_id":external_id,"title":case["title"],"status":"reconciled","remote_digest":digest(&remote),"note":note,"digest":"requires_update","reconciled_at":crate::workspace::chrono_now()});
    save(&connection, &input, &state)?;
    Ok(state["mappings"][&case_id].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn yunxiao_publication_requires_one_member_from_the_same_connection() {
        let connection = Connection {
            connection_id: "yunxiao-1".into(),
            provider_id: "yunxiao".into(),
            enabled: true,
            ..Default::default()
        };
        assert_eq!(
            yunxiao_owner_issue(&connection, &json!({"owners":[]}))
                .unwrap()
                .0,
            "missing_owner"
        );
        let owner = json!({
            "connection_id":"yunxiao-1",
            "provider_id":"yunxiao",
            "entity_type":"member",
            "external_id":"member-1",
            "title":"李四"
        });
        assert!(yunxiao_owner_issue(&connection, &json!({"owners":[owner]})).is_none());
        let wrong_org_owner = json!({
            "connection_id":"other-yunxiao",
            "provider_id":"yunxiao",
            "entity_type":"member",
            "external_id":"member-1",
            "title":"李四"
        });
        assert_eq!(
            yunxiao_owner_issue(&connection, &json!({"owners":[wrong_org_owner]}))
                .unwrap()
                .0,
            "invalid_owner"
        );
    }

    struct Fixture {
        root: PathBuf,
        c: Connection,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "baize-integration-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("requirement.yaml"),"requirement: {id: FIX, name: Fixture, platform: memory, owner: test, created_at: ''}\nversion: '1.0'\nstatus: active\ncurrent_stage: testing\nschedule: {planned_test_date: null, planned_release_date: null, actual_test_date: null, actual_release_date: null}\napplications: []\nclient_access: {mode: unlocked, task_id: null, locked_at: null, note: '', locked_by: null, snapshot_path: null}\n").unwrap();
            let c = Connection {
                connection_id: format!("fixture-{}", root.file_name().unwrap().to_string_lossy()),
                provider_id: "memory".into(),
                enabled: true,
                ..Default::default()
            };
            Self { root, c }
        }
        fn version(&self, id: &str, cases: Value) -> PublicationInput {
            let dir = self.root.join("04-测试用例").join("versions").join(id);
            fs::create_dir_all(&dir).unwrap();
            let ids = cases
                .as_array()
                .unwrap()
                .iter()
                .map(|v| text(v, "id"))
                .collect::<Vec<_>>();
            let doc = json!({"requirement_id":"FIX","platform_id":"memory","cases":cases});
            let bytes = serde_json::to_vec(&doc).unwrap();
            let fp = format!("{:x}", Sha256::digest(&bytes));
            fs::write(dir.join("cases.json"), bytes).unwrap();
            fs::write(dir.join("manifest.json"),serde_json::to_vec(&json!({"version_id":id,"fingerprint":fp,"confirmation_status":"confirmed","confirmed_by":"human","case_ids":ids,"requirement_id":"FIX","platform_id":"memory"})).unwrap()).unwrap();
            PublicationInput {
                requirement_dir: self.root.to_string_lossy().into(),
                version_id: id.into(),
                fingerprint: fp,
                repository: "library/default".into(),
                directory: "folder/root".into(),
                case_ids: ids,
            }
        }
    }
    #[test]
    fn confirmed_versions_only_include_intact_human_finalizations() {
        let f = Fixture::new();
        let first = f.version("v1", json!([{"id":"case-a","title":"A"}]));
        f.version("v2", json!([{"id":"case-b","title":"B"}]));

        let pending_manifest = f.root.join("04-测试用例/versions/v2/manifest.json");
        let mut pending: Value =
            serde_json::from_slice(&fs::read(&pending_manifest).unwrap()).unwrap();
        pending["confirmation_status"] = json!("pending");
        fs::write(&pending_manifest, serde_json::to_vec(&pending).unwrap()).unwrap();

        let result = list_confirmed_versions(&first.requirement_dir).unwrap();
        assert_eq!(result["latest_version_id"], "v1");
        assert_eq!(result["versions"].as_array().unwrap().len(), 1);
        assert_eq!(result["versions"][0]["version_id"], "v1");
        assert_eq!(result["versions"][0]["fingerprint"], first.fingerprint);
        assert_eq!(result["versions"][0]["case_ids"], json!(["case-a"]));

        fs::write(
            f.root.join("04-测试用例/versions/v1/cases.json"),
            b"tampered",
        )
        .unwrap();
        let result = list_confirmed_versions(&first.requirement_dir).unwrap();
        assert_eq!(result["latest_version_id"], Value::Null);
        assert!(result["versions"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn idempotent_publish_new_version_rename_move_delete_and_isolation() {
        let f = Fixture::new();
        let i = f.version(
            "v1",
            json!([{"id":"stable-a","title":"A"},{"id":"stable-b","title":"B"}]),
        );
        let p = preview(&f.c, &i).await.unwrap();
        let r = execute(&f.c, &i, &text(&p, "preview_token"), &[])
            .await
            .unwrap();
        assert_eq!(r["status"], "simulated");
        let remote = text(&r["items"][0], "external_id");
        let p = preview(&f.c, &i).await.unwrap();
        assert!(p["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["action"] == "unchanged"));
        assert!(execute(&f.c, &i, "stale-preview", &[]).await.is_err());
        let mut next = f.version(
            "v2",
            json!([{"id":"stable-a","title":"Renamed"},{"id":"stable-c","title":"New"}]),
        );
        next.directory = "folder/moved".into();
        let p = preview(&f.c, &next).await.unwrap();
        assert_eq!(p["items"][0]["action"], "update");
        assert_eq!(p["items"][2]["action"], "proposed_archive");
        let r = execute(&f.c, &next, &text(&p, "preview_token"), &[])
            .await
            .unwrap();
        assert_eq!(r["items"][0]["external_id"], remote);
        assert!(load(&f.c, &next).unwrap()["mappings"]["stable-b"].is_object());
        let mut other = f.c.clone();
        other.connection_id.push_str("-other");
        let p = preview(&other, &next).await.unwrap();
        assert_eq!(p["items"][0]["action"], "new");
        let bytes = fs::read(f.root.join("04-测试用例/versions/v1/cases.json")).unwrap();
        assert!(String::from_utf8(bytes).unwrap().contains("stable-b"));
    }
    #[tokio::test]
    async fn partial_success_only_failed_item_retried_and_unknown_never_recreated() {
        let f = Fixture::new();
        let i = f.version(
            "v1",
            json!([{"id":"a","title":"A"},{"id":"b","title":"[fail]"}]),
        );
        let p = preview(&f.c, &i).await.unwrap();
        let r = execute(&f.c, &i, &text(&p, "preview_token"), &[])
            .await
            .unwrap();
        assert_eq!(r["status"], "partial");
        let p = preview(&f.c, &i).await.unwrap();
        assert_eq!(p["items"][0]["action"], "unchanged");
        assert_eq!(p["items"][1]["action"], "new");
        let mut state = load(&f.c, &i).unwrap();
        state["mappings"]["b"] = json!({"status":"sending","external_id":""});
        save(&f.c, &i, &state).unwrap();
        let p = preview(&f.c, &i).await.unwrap();
        assert_eq!(p["items"][1]["action"], "unmapped");
        let r = execute(&f.c, &i, &text(&p, "preview_token"), &[])
            .await
            .unwrap();
        assert_eq!(r["items"][1]["action"], "unmapped");
        let pth = path(&f.c, &i).unwrap();
        fs::rename(&pth, pth.with_extension("pending")).unwrap();
        assert_eq!(
            load(&f.c, &i).unwrap()["mappings"]["b"]["status"],
            "sending"
        );
    }
    #[tokio::test]
    async fn remote_conflict_and_changed_formal_bytes_reject() {
        let f = Fixture::new();
        let i = f.version("v1", json!([{"id":"a","title":"A"}]));
        let p = preview(&f.c, &i).await.unwrap();
        let r = execute(&f.c, &i, &text(&p, "preview_token"), &[])
            .await
            .unwrap();
        call(&f.c,"publish_case",&json!({"external_id":r["items"][0]["external_id"],"case":{"title":"remote human"},"digest":"changed"})).await.unwrap();
        assert_eq!(
            preview(&f.c, &i).await.unwrap()["items"][0]["action"],
            "conflict"
        );
        fs::write(f.root.join("04-测试用例/versions/v1/cases.json"), b"{}").unwrap();
        assert!(preview(&f.c, &i).await.is_err());
    }
}
