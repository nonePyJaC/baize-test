//! Public integration boundary. Legacy yunxiao commands remain for recorded history only.
mod memory;
pub mod migration;
pub mod ports;
pub mod publication;
mod state_io;
mod yunxiao;
use ports::*;
use serde_json::{json, Value};

pub fn adapter(c: &Connection) -> Result<Box<dyn IntegrationPort>, String> {
    if !c.enabled {
        return Err("连接已关闭；本地业务与历史引用仍可使用".into());
    }
    if c.connection_id.trim().is_empty() {
        return Err("缺少connection_id".into());
    }
    provider(c)
}
pub fn provider(c: &Connection) -> Result<Box<dyn IntegrationPort>, String> {
    match c.provider_id.as_str() {
        "yunxiao" => Ok(Box::new(yunxiao::Yunxiao)),
        "memory" => Ok(Box::new(memory::Memory)),
        _ => Err("未注册的外部系统".into()),
    }
}
pub async fn call(c: &Connection, operation: &str, args: &Value) -> Result<Value, String> {
    let port = adapter(c)?;
    let capability = match operation {
        "validate" | "projects" | "iterations" | "members" => "identity",
        "requirements" | "requirement" => "requirements",
        "create_test_task" => "tasks",
        "defect_form" | "resolve_defect" | "create_defect" => "defects",
        "retry_attachments" => "attachments",
        "plans" | "create_plan" => "plans",
        "repositories" | "directories" | "cases" | "case" | "testcase_fields" | "publish_case" => {
            "cases"
        }
        "capabilities" => return Ok(json!(port.capabilities())),
        _ => return Err(format!("未知集成操作：{operation}")),
    };
    if !port.capabilities().contains(&capability) {
        return Err(format!("此连接不支持{capability}，本地业务可继续"));
    }
    port.call(c, operation, args).await
}
#[tauri::command]
pub async fn integration_call(
    connection: Connection,
    operation: String,
    args: Value,
) -> Result<Value, String> {
    // Publication is deliberately not a raw API operation available to the UI/model.
    if operation == "publish_case" {
        return Err("请使用正式定稿发布接口".into());
    }
    call(&connection, &operation, &args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn independent_capabilities_and_non_vendor_ids() {
        let c = Connection {
            connection_id: "second".into(),
            provider_id: "memory".into(),
            enabled: true,
            ..Default::default()
        };
        assert!(call(&c, "plans", &json!({})).await.is_err());
        let p = call(&c, "projects", &json!({})).await.unwrap();
        assert_eq!(p[0]["external_id"], "project/alpha");
        assert!(p[0]["external_id"].as_str().unwrap().len() != 24);
        let mut other = c.clone();
        other.connection_id = "other".into();
        assert_ne!(
            call(&other, "projects", &json!({})).await.unwrap()[0]["connection_id"],
            p[0]["connection_id"]
        );
    }
    #[tokio::test]
    async fn attachment_retry_keeps_created_identity() {
        let mut c = Connection {
            connection_id: "attachment-fixture".into(),
            provider_id: "memory".into(),
            enabled: true,
            ..Default::default()
        };
        c.config
            .insert("fail_attachments_once".into(), "true".into());
        let r=call(&c,"create_defect",&json!({"title":"Fixture","fields":{"impact":"wide"},"attachments":[{"id":"img-a","name":"fixture.png","data_base64":"AA=="}],"description":"Actual [[IMG:img-a]]"})).await.unwrap();
        assert_eq!(r["status"], "attachments_partial");
        let done = call(&c, "retry_attachments", &r).await.unwrap();
        assert_eq!(done["status"], "created");
        assert_eq!(r["reference"], done["reference"]);
    }
}
