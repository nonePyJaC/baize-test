//! Explicit, reversible sidecar migration. Historical originals are never rewritten.
use super::{ports::*, publication::digest};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
static LOCK: Mutex<()> = Mutex::new(());
/// Compatibility overlay: binds only exact stored IDs from an explicitly confirmed original connection.
pub fn requirement_references(root: &Path) -> Vec<Value> {
    let path = root
        .join("04-测试用例")
        .join("integrations")
        .join("legacy-references.json");
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    let Ok(sidecar) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    let Ok(original) = fs::read(root.join("requirement.yaml")) else {
        return Vec::new();
    };
    let hash = digest(&json!(original));
    let mut refs = Vec::new();
    if let Some(rows) = sidecar["rows"].as_array() {
        for row in rows {
            if row["source"] == "requirement.yaml" && row["source_fingerprint"] == hash {
                if let Some(values) = row["references"].as_array() {
                    for value in values {
                        let legacy = &value["legacy"];
                        let id = text(legacy, "workitem_id");
                        if value["kind"] == "requirement" && !id.is_empty() {
                            refs.push(json!({"connection_id":sidecar["connection_id"],"provider_id":"yunxiao","entity_type":"requirement","external_id":id,"display_key":text(legacy,"workitem_serial"),"title":text(legacy,"workitem_subject"),"project_ref":text(legacy,"project_id"),"linked_at":"","role":"source"}));
                        }
                    }
                }
            }
        }
    }
    refs
}
fn source(root: &Path) -> Result<Value, String> {
    let mut rows = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some("integrations" | "01-需求资料" | "05-开发资源")
            )
        })
    {
        let e = entry.map_err(|e| e.to_string())?;
        if !e.file_type().is_file() {
            continue;
        }
        let name = e.file_name().to_str().unwrap_or("");
        if !matches!(
            name,
            "requirement.yaml" | "results.json" | "manifest.json" | "cases.json"
        ) {
            continue;
        }
        let bytes = fs::read(e.path()).map_err(|e| e.to_string())?;
        let value: Value = if name.ends_with("yaml") {
            serde_yaml::from_slice(&bytes).map_err(|e| e.to_string())?
        } else {
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
        };
        let mut refs = Vec::new();
        if let Some(y) = value.get("yunxiao") {
            refs.push(json!({"kind":"requirement","legacy":y}));
        }
        if let Some(p) = value
            .get("yunxiao_test_plan")
            .or_else(|| value["metadata"].get("yunxiao_test_plan"))
        {
            refs.push(json!({"kind":"plan","legacy":p}));
        }
        if let Some(results) = value["results"].as_array() {
            for r in results {
                if r.get("yunxiao_bug_id").is_some() {
                    refs.push(json!({"kind":"defect","case_id":r["case_id"],"external_id":r["yunxiao_bug_id"],"display_key":r["yunxiao_bug_serial"],"title":r["yunxiao_bug_subject"],"defect_url":r["defect_url"]}));
                }
            }
        }
        if !refs.is_empty() {
            rows.push(json!({"source":e.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\',"/"),"source_fingerprint":digest(&json!(bytes)),"references":refs,"missing_mapping":"必须由人选择原连接；不按名称推断ID"}));
        }
    }
    Ok(json!(rows))
}
fn target(dir: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = Path::new(dir).canonicalize().map_err(|e| e.to_string())?;
    if !root.join("requirement.yaml").exists() {
        return Err("不是需求目录".into());
    }
    let base = root.join("04-测试用例").join("integrations");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    if !base
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        return Err("目录越界".into());
    }
    Ok((root, base))
}
#[tauri::command]
pub fn preview_integration_migration(requirement_dir: String) -> Result<Value, String> {
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    let (root, _) = target(&requirement_dir)?;
    let rows = source(&root)?;
    Ok(
        json!({"rows":rows,"fingerprint":digest(&rows),"strategy":"旁路关联；不改正式版本、执行原件和未知业务字段"}),
    )
}
#[tauri::command]
pub fn apply_integration_migration(
    requirement_dir: String,
    connection: Connection,
    expected: String,
) -> Result<Value, String> {
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    if connection.provider_id != "yunxiao" {
        return Err("旧云效字段必须选择原云效连接".into());
    }
    let (root, base) = target(&requirement_dir)?;
    let rows = source(&root)?;
    if digest(&rows) != expected {
        return Err("迁移来源变化，请重新预览".into());
    }
    let p = base.join("legacy-references.json");
    crate::workspace::ensure_client_write_allowed(&p, None)?;
    let next = json!({"schema_version":1,"connection_id":connection.connection_id,"instance":connection.instance(),"source_fingerprint":expected,"rows":rows});
    if p.exists() {
        let bytes = fs::read(&p).map_err(|e| e.to_string())?;
        let old: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if old == next {
            return Ok(old);
        }
        return Err("已有不同迁移，请先核对或还原；不会覆盖原关联".into());
    }
    let backup = base.join("legacy-references.backup.json");
    crate::workspace::write_atomic_bytes(
        &backup,
        &serde_json::to_vec(&json!({"before":null,"after":next})).unwrap(),
    )?;
    crate::workspace::write_atomic_bytes(&p, &serde_json::to_vec_pretty(&next).unwrap())?;
    Ok(next)
}
#[tauri::command]
pub fn restore_integration_migration(requirement_dir: String) -> Result<(), String> {
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    let (_, base) = target(&requirement_dir)?;
    let p = base.join("legacy-references.json");
    let b: Value = serde_json::from_slice(
        &fs::read(base.join("legacy-references.backup.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if !p.exists() {
        return Ok(());
    }
    let now: Value = serde_json::from_slice(&fs::read(&p).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if now != b["after"] {
        return Err("旁路关联已被修改，拒绝覆盖".into());
    }
    crate::workspace::ensure_client_write_allowed(&p, None)?;
    fs::remove_file(p).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sidecar_migration_is_idempotent_reversible_and_preserves_originals() {
        let root = std::env::temp_dir().join(format!(
            "baize-migration-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let doc = json!({"version":"1.0","requirement":{"id":"FIX","name":"Fixture","platform":"test","owner":"","created_at":""},"status":"active","current_stage":"testing","schedule":{"planned_test_date":null,"planned_release_date":null,"actual_test_date":null,"actual_release_date":null},"applications":[],"client_access":{"mode":"unlocked","note":""},"yunxiao":{"project_id":"p","workitem_id":"legacy-id"},"unknown":{"keep":true}});
        let original = serde_yaml::to_string(&doc).unwrap();
        fs::write(root.join("requirement.yaml"), &original).unwrap();
        let dir = root.to_string_lossy().to_string();
        let p = preview_integration_migration(dir.clone()).unwrap();
        assert_eq!(p["rows"].as_array().unwrap().len(), 1);
        let c = Connection {
            connection_id: "original-org".into(),
            provider_id: "yunxiao".into(),
            ..Default::default()
        };
        let first =
            apply_integration_migration(dir.clone(), c.clone(), text(&p, "fingerprint")).unwrap();
        assert_eq!(
            first,
            apply_integration_migration(dir.clone(), c, text(&p, "fingerprint")).unwrap()
        );
        assert_eq!(
            fs::read_to_string(root.join("requirement.yaml")).unwrap(),
            original
        );
        restore_integration_migration(dir.clone()).unwrap();
        restore_integration_migration(dir).unwrap();
        assert!(!root
            .join("04-测试用例/integrations/legacy-references.json")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }
}
