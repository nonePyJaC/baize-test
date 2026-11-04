use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, future::Future, pin::Pin};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Connection {
    pub connection_id: String,
    pub provider_id: String,
    pub display_name: String,
    pub enabled: bool,
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub config: BTreeMap<String, String>,
}
impl Connection {
    pub fn setting(&self, key: &str) -> String {
        self.config.get(key).cloned().unwrap_or_default()
    }
    /// Identifies the instance, not credentials. A token rotation preserves mappings.
    pub fn instance(&self) -> Value {
        super::provider(self)
            .map(|p| p.instance(self))
            .unwrap_or_else(|_| serde_json::json!([self.provider_id, self.connection_id]))
    }
}
pub type PortFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
/// Operations are grouped by independent capabilities; providers reject unsupported ones.
pub trait IntegrationPort: Send + Sync {
    fn instance(&self, c: &Connection) -> Value {
        serde_json::json!([c.provider_id, c.connection_id])
    }
    fn simulated(&self) -> bool {
        false
    }
    fn supports_case_move(&self) -> bool {
        true
    }
    fn capabilities(&self) -> &'static [&'static str];
    fn call<'a>(
        &'a self,
        connection: &'a Connection,
        operation: &'a str,
        args: &'a Value,
    ) -> PortFuture<'a>;
}
pub fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}
pub fn list(value: Value) -> Vec<Value> {
    if let Some(a) = value.as_array() {
        return a.clone();
    }
    for k in ["items", "result", "data", "list", "testcases"] {
        if let Some(v) = value.get(k) {
            let a = list(v.clone());
            if !a.is_empty() {
                return a;
            }
        }
    }
    Vec::new()
}
pub fn reference(c: &Connection, kind: &str, id: &str, title: &str) -> Value {
    serde_json::json!({"connection_id":c.connection_id,"provider_id":c.provider_id,"entity_type":kind,
        "external_id":id,"display_key":id,"title":title,"linked_at":crate::workspace::chrono_now()})
}
