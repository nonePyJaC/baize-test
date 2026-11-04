//! Read-only lifecycle index. Raw records are paged, never silently truncated.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

fn inventory(root: &Path, dir: &Path, out: &mut Vec<Value>) -> Result<(), String> {
    let mut entries = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            // Transaction byte backups are not business evidence.
            if entry.file_name() != "revision-transactions" {
                inventory(root, &path, out)?;
            }
        } else {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            out.push(json!({"path": super::relative_text(root, &path), "bytes": bytes.len(),
                "fingerprint": format!("{:x}", Sha256::digest(&bytes)), "read_status":"indexed_only"}));
        }
    }
    Ok(())
}

fn page(items: &[Value], args: &Value) -> Value {
    let start = (args["offset"].as_u64().unwrap_or(0) as usize).min(items.len());
    let end =
        (start + args["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize).min(items.len());
    json!({"total":items.len(), "offset":start, "read_range":[start,end], "has_more":end<items.len(),
        "next_offset": if end<items.len() {Some(end)} else {None}, "items": &items[start..end]})
}

pub(super) fn read(root: &Path, requirement: &Path, args: &Value) -> Result<Value, String> {
    let section = args["section"].as_str().unwrap_or("inventory");
    if section == "records" {
        let path =
            super::resolve_workspace_path(root, args["path"].as_str().ok_or("records 需要 path")?)?;
        if !path.starts_with(requirement) {
            return Err("只能读取当前需求证据".into());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let key = args["key"].as_str().unwrap_or("events");
        let records = if let Some(list) = value.as_array() {
            list
        } else {
            value
                .get(key)
                .and_then(Value::as_array)
                .ok_or("指定字段不是记录数组")?
        };
        let mut result = page(records, args);
        result["source"] = json!(super::relative_text(root, &path));
        result["fingerprint"] = json!(format!("{:x}", Sha256::digest(&bytes)));
        return Ok(result);
    }
    let mut files = Vec::new();
    inventory(root, requirement, &mut files)?;
    if section == "inventory" {
        return Ok(page(&files, args));
    }
    if section != "summary" {
        return Err("section 只能为 inventory/summary/records".into());
    }
    let mut counts = BTreeMap::<String, usize>::new();
    let mut findings = Vec::new();
    let mut versions = Vec::new();
    let mut statuses = BTreeMap::<String, Vec<Value>>::new();
    let mut legacy_ids = Vec::new();
    for file in &files {
        let relative = file["path"].as_str().unwrap_or_default();
        if !relative.ends_with(".json") {
            continue;
        }
        let path = super::resolve_workspace_path(root, relative)?;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let data: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) => {
                findings
                    .push(json!({"kind":"invalid_json","source":relative,"detail":e.to_string()}));
                continue;
            }
        };
        if let Some(cases) = data["cases"].as_array() {
            versions.push(json!({"source":relative,"fingerprint":file["fingerprint"],
                "case_ids":cases.iter().map(|c| &c["id"]).collect::<Vec<_>>()}));
        }
        for key in [
            "events",
            "case_events",
            "case_change_history",
            "tombstones",
            "changes",
            "results",
        ] {
            let list = if let Some(a) = data.get(key).and_then(Value::as_array) {
                a
            } else if key == "changes" {
                if let Some(a) = data.as_array() {
                    a
                } else {
                    continue;
                }
            } else {
                continue;
            };
            for (index, row) in list.iter().enumerate() {
                let case_id = row["case_id"]
                    .as_str()
                    .or(row["caseId"].as_str())
                    .unwrap_or_default();
                if key == "results" && !case_id.is_empty() {
                    statuses.entry(case_id.into()).or_default().push(json!({"source":relative,"status":row["status"],"case_revision":row["case_revision"],"deleted":row["deleted"]}));
                } else if !case_id.is_empty() {
                    legacy_ids.push((case_id.to_string(), relative.to_string(), key, index));
                }
                if row["before"]["title"].is_string()
                    && row["after"]["title"].is_string()
                    && row["before"]["title"] != row["after"]["title"]
                    && row["before"]["expected_results"] == row["after"]["expected_results"]
                {
                    findings.push(json!({"kind":"title_expectation_review","source":relative,"key":key,"index":index,"case_id":case_id,"note":"标题已变而整体期望未变，请人工核验；不是自动判错"}));
                }
                let action = row["action"]
                    .as_str()
                    .or(row["changeType"].as_str())
                    .unwrap_or("unknown");
                let origin = row["origin"].as_str().unwrap_or("legacy_unknown");
                *counts
                    .entry(format!("{key}/{origin}/{action}"))
                    .or_default() += 1;
                let reason = row["reason"].as_str().unwrap_or("");
                let kind = if key == "results" && row["needs_retest"] == true {
                    "needs_retest"
                } else if key == "results" && row["status"] == "not_executed" {
                    "not_executed"
                } else if action == "deleted" && reason.contains("重写") {
                    "replacement_pending"
                } else if action == "deleted"
                    && (reason.contains("其他") || reason.contains("范围"))
                {
                    "scope_decision"
                } else if key != "results" && reason.trim().is_empty() {
                    "missing_reason"
                } else {
                    continue;
                };
                findings.push(
                    json!({"kind":kind,"source":relative,"key":key,"index":index,
                    "case_id":row.get("case_id").or(row.get("caseId")),"reason":reason}),
                );
            }
        }
    }
    let known_ids = versions
        .iter()
        .flat_map(|v| {
            v["case_ids"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
        })
        .collect::<std::collections::BTreeSet<_>>();
    for (id, source, key, index) in legacy_ids {
        if !known_ids.contains(id.as_str()) {
            findings.push(json!({"kind":"unmapped_legacy_case","case_id":id,"source":source,"key":key,"index":index}));
        }
    }
    for (id, rows) in statuses {
        if rows.len() > 1
            && rows.iter().skip(1).any(|r| {
                r["case_revision"] != rows[0]["case_revision"] || r["status"] != rows[0]["status"]
            })
        {
            findings.push(json!({"kind":"cross_run_difference","case_id":id,"sources":rows,"note":"跨轮状态或修订不同，需核对时间/版本，不推断为业务矛盾"}));
        }
    }
    let current_source =
        super::relative_text(root, &requirement.join("04-测试用例").join("cases.json"));
    let current_ids = versions
        .iter()
        .find(|v| v["source"] == current_source)
        .and_then(|v| v["case_ids"].as_array())
        .cloned()
        .unwrap_or_default();
    let has_current = versions.iter().any(|v| v["source"] == current_source);
    let diffs = versions.iter().filter(|v| has_current && v["source"] != current_source).map(|v| {
        let before = v["case_ids"].as_array().unwrap();
        json!({"source":v["source"],"fingerprint":v["fingerprint"],"added_ids":current_ids.iter().filter(|id| !before.contains(id)).collect::<Vec<_>>(),
            "removed_ids":before.iter().filter(|id| !current_ids.contains(id)).collect::<Vec<_>>()})
    }).collect::<Vec<_>>();
    let mut result = page(&findings, args);
    result["version_diffs_against_current"] = json!(diffs);
    result["counts"] = json!(counts);
    result["versions"] = json!(versions);
    result["indexed_files"] = json!(files.len());
    result["note"] = json!("确定性索引已扫描全部JSON；正文、图片、逐项冲突与标题/期望一致性仍需追读。计数按来源，不跨旧日志猜测去重。missing_reason 不代表用户无决定；范围与替代分类是检索线索，需核对原文。版本case_ids可按ID比对，不按标题映射。所有资料默认未阅读全文。");
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_all_1703_records() {
        let rows = (0..1703).map(|i| json!({"id":i})).collect::<Vec<_>>();
        let mut offset = 0;
        let mut seen = 0;
        loop {
            let p = page(&rows, &json!({"offset":offset,"limit":100}));
            seen += p["items"].as_array().unwrap().len();
            if !p["has_more"].as_bool().unwrap() {
                break;
            }
            offset = p["next_offset"].as_u64().unwrap();
        }
        assert_eq!(seen, 1703);
    }
}
