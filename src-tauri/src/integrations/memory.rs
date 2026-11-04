use super::ports::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};
pub struct Memory;
fn objects() -> &'static Mutex<BTreeMap<String, Value>> {
    static M: OnceLock<Mutex<BTreeMap<String, Value>>> = OnceLock::new();
    M.get_or_init(Default::default)
}
impl IntegrationPort for Memory {
    fn simulated(&self) -> bool {
        true
    }
    fn capabilities(&self) -> &'static [&'static str] {
        &[
            "identity",
            "requirements",
            "defects",
            "cases",
            "attachments",
        ]
    }
    fn call<'a>(&'a self, c: &'a Connection, op: &'a str, a: &'a Value) -> PortFuture<'a> {
        Box::pin(async move {
            let entity = |kind, id, title| reference(c, kind, id, title);
            Ok(match op {
                "validate" => json!({"user_id":"person/self","user_name":"内存用户"}),
                "projects" => json!([entity("project", "project/alpha", "内存项目")]),
                "iterations" => json!([entity("iteration", "cycle/spring", "春季")]),
                "members" => json!([entity("member", "person/self", "内存用户")]),
                "requirements" => json!([entity("requirement", "story/42", "内存需求")]),
                "requirement" => entity("requirement", &text(a, "external_id"), "内存需求"),
                "defect_form" => {
                    json!({"parent_required":false,"assignee_required":false,"fields":[{"id":"impact","label":"影响范围","required":true,"options":[{"id":"small","label":"单用户"},{"id":"wide","label":"全部用户"}]}]})
                }
                "resolve_defect" => json!([entity("defect", &text(a, "query"), "已有缺陷")]),
                "create_defect" => {
                    if a["fields"]["impact"].as_str().unwrap_or("").is_empty() {
                        return Err("请选择影响范围".into());
                    }
                    let mut m = objects().lock().unwrap();
                    let id = format!("issue/{}", m.len() + 1);
                    let r = entity("defect", &id, &text(a, "title"));
                    m.insert(format!("{}:{id}", c.connection_id), r.clone());
                    if c.setting("fail_attachments_once") == "true"
                        && a["attachments"].as_array().is_some_and(|a| !a.is_empty())
                    {
                        json!({"status":"attachments_partial","reference":r,"pending_attachments":a["attachments"],"warnings":["内存适配器模拟附件失败；重试只处理附件"],"description":a["description"],"embeds":{}})
                    } else {
                        json!({"status":"created","reference":r,"pending_attachments":[],"warnings":[],"description":a["description"],"embeds":{}})
                    }
                }
                "retry_attachments" => {
                    json!({"status":"created","reference":a["reference"],"pending_attachments":[],"warnings":[],"description":a["description"],"embeds":{}})
                }
                "repositories" => json!([entity("repository", "library/default", "内存用例库")]),
                "directories" => json!([entity("directory", "folder/root", "根目录")]),
                "cases" => json!([]),
                "testcase_fields" => json!([
                    {
                        "id": "tc.priority",
                        "name": "优先级",
                        "format": "list",
                        "options": [
                            {"id": "priority-p0", "value": "P0", "displayValue": "P0"},
                            {"id": "priority-p1", "value": "P1", "displayValue": "P1"},
                            {"id": "priority-p2", "value": "P2", "displayValue": "P2"},
                            {"id": "priority-p3", "value": "P3", "displayValue": "P3"}
                        ]
                    },
                    {
                        "id": "tc.type",
                        "name": "类型",
                        "format": "list",
                        "options": [
                            {"id": "type-functional", "value": "功能测试", "displayValue": "功能测试"},
                            {"id": "type-interface", "value": "接口测试", "displayValue": "接口测试"},
                            {"id": "type-performance", "value": "性能测试", "displayValue": "性能测试"}
                        ]
                    }
                ]),
                "case" => objects()
                    .lock()
                    .unwrap()
                    .get(&format!("{}:{}", c.connection_id, text(a, "external_id")))
                    .cloned()
                    .ok_or("内存对象不存在")?,
                "publish_case" => {
                    if a["case"]["title"]
                        .as_str()
                        .is_some_and(|s| s.contains("[fail]"))
                    {
                        return Err("NOT_COMMITTED:内存适配器模拟单项失败（请求未发送）".into());
                    }
                    let mut m = objects().lock().unwrap();
                    let mut id = text(a, "external_id");
                    if id.is_empty() {
                        id = format!("asset/{}", m.len() + 1);
                    }
                    m.insert(
                        format!("{}:{id}", c.connection_id),
                        json!({"case":a["case"],"digest":a["digest"],"directory_ref":a["directory"]}),
                    );
                    json!({"external_id":id,"digest":a["digest"],"simulated":true})
                }
                _ => return Err(format!("内存适配器不支持{op}")),
            })
        })
    }
}
