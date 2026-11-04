//! HTTP debugging and local request-library storage. No business endpoint is called during import.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};
use tauri::Manager;
use tokio::sync::oneshot;

#[derive(Default)]
pub struct ApiDebugState {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}
static LIBRARY_LOCK: Mutex<()> = Mutex::new(());
fn library_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("api-debug-library.json"))
}
fn read_library(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(
            json!({"version":1,"revision":0,"requests":[],"environments":[],"bindings":{},"history":[]}),
        );
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("接口库读取失败，原文件已保留：{e}"))
}
#[tauri::command]
pub fn load_api_debug_library(app: tauri::AppHandle) -> Result<Value, String> {
    let _guard = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
    read_library(&library_path(&app)?)
}
#[tauri::command]
pub fn save_api_debug_library(
    app: tauri::AppHandle,
    mut document: Value,
    expected_revision: u64,
) -> Result<Value, String> {
    let _guard = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
    let path = library_path(&app)?;
    let old = read_library(&path)?;
    if old["revision"].as_u64().unwrap_or(0) != expected_revision {
        return Err("接口库已在其他页面更新，请重新载入后合并；当前编辑未丢弃".into());
    }
    if !document["requests"].is_array()
        || !document["environments"].is_array()
        || !document["bindings"].is_object()
    {
        return Err("接口库格式不完整".into());
    }
    document["revision"] = json!(expected_revision + 1);
    if path.exists() {
        crate::workspace::write_atomic_bytes(
            &path.with_extension("json.bak"),
            &fs::read(&path).map_err(|e| e.to_string())?,
        )?;
    }
    crate::workspace::write_atomic_bytes(
        &path,
        &serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?,
    )?;
    Ok(document)
}
#[derive(Serialize)]
pub struct ApiImportSource {
    path: String,
    name: String,
    kind: String,
    size: u64,
}
#[tauri::command]
pub fn discover_api_debug_sources(root_path: String) -> Result<Vec<ApiImportSource>, String> {
    let root = Path::new(&root_path);
    if !root.is_dir() {
        return Err("请选择原接口工具所在目录".into());
    }
    let mut found = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some(".venv" | "venv" | "node_modules" | "__pycache__" | ".git" | "dist" | "build")
            )
        })
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|s| s.to_str()) != Some("json")
        {
            continue;
        }
        let size = entry.metadata().map_err(|e| e.to_string())?.len();
        if size > 20 * 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let json_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let Ok(v) = serde_json::from_slice::<Value>(json_bytes) else {
            continue;
        };
        let kind = if v["collections"].is_array() {
            "legacy"
        } else if v["item"].is_array() {
            "postman"
        } else if v.get("cameraType").is_some() && v.get("originalPayload").is_some() {
            "mimi"
        } else if v["openapi"].is_string() || v["swagger"].is_string() {
            "openapi"
        } else if v["values"].is_array() && v.get("name").is_some() {
            "environment"
        } else {
            continue;
        };
        found.push(ApiImportSource {
            path: entry.path().to_string_lossy().to_string(),
            name: entry
                .path()
                .strip_prefix(root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string(),
            kind: kind.into(),
            size,
        });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}
#[derive(Deserialize, Serialize, Clone)]
pub struct HttpHeader {
    pub key: String,
    pub value: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
}
fn enabled() -> bool {
    true
}
#[derive(Deserialize)]
pub struct HttpDebugInput {
    pub id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub follow_redirects: bool,
    #[serde(default)]
    pub insecure_tls: bool,
}
#[derive(Serialize)]
pub struct HttpDebugResponse {
    status: u16,
    headers: Vec<HttpHeader>,
    body: String,
    elapsed_ms: u128,
    size: usize,
    truncated: bool,
    url: String,
}
async fn send(input: HttpDebugInput) -> Result<HttpDebugResponse, String> {
    let url = reqwest::Url::parse(&input.url).map_err(|e| format!("URL 无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("接口调试支持 HTTP 和 HTTPS".into());
    }
    let method = reqwest::Method::from_bytes(input.method.as_bytes()).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .redirect(if input.follow_redirects {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        })
        .danger_accept_invalid_certs(input.insecure_tls)
        .timeout(std::time::Duration::from_millis(if input.timeout_ms == 0 {
            30_000
        } else {
            input.timeout_ms.clamp(100, 300_000)
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.request(method, url);
    for header in input
        .headers
        .iter()
        .filter(|h| h.enabled && !h.key.trim().is_empty())
    {
        if ["content-length", "transfer-encoding", "connection", "host"]
            .iter()
            .any(|k| header.key.eq_ignore_ascii_case(k))
        {
            continue;
        }
        request = request.header(header.key.trim(), &header.value);
    }
    let start = Instant::now();
    let mut response = request
        .body(input.body.into_bytes())
        .send()
        .await
        .map_err(|e| format!("接口请求失败：{e}"))?;
    let status = response.status().as_u16();
    let url = response.url().to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(k, v)| HttpHeader {
            key: k.to_string(),
            value: v.to_str().unwrap_or("").into(),
            enabled: true,
        })
        .collect();
    let mut bytes = Vec::new();
    let mut truncated = false;
    const LIMIT: usize = 4 * 1024 * 1024;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        let available = LIMIT - bytes.len();
        bytes.extend_from_slice(&chunk[..available.min(chunk.len())]);
        if chunk.len() > available {
            truncated = true;
            break;
        }
    }
    Ok(HttpDebugResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
        elapsed_ms: start.elapsed().as_millis(),
        size: bytes.len(),
        truncated,
        url,
    })
}
#[tauri::command]
pub async fn execute_api_debug_request(
    state: tauri::State<'_, ApiDebugState>,
    input: HttpDebugInput,
) -> Result<HttpDebugResponse, String> {
    let id = input.id.clone();
    let (tx, rx) = oneshot::channel();
    {
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if running.contains_key(&id) {
            return Err("该接口请求正在执行".into());
        }
        running.insert(id.clone(), tx);
    }
    let result = tokio::select! { r = send(input) => r, _ = rx => Err("已停止接口请求；服务端可能已处理，请核对响应或业务数据后再重试".into()) };
    state.running.lock().map_err(|e| e.to_string())?.remove(&id);
    result
}
#[tauri::command]
pub fn cancel_api_debug_request(
    state: tauri::State<'_, ApiDebugState>,
    request_id: String,
) -> Result<(), String> {
    if let Some(tx) = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id)
    {
        let _ = tx.send(());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    #[test]
    fn discovers_import_formats_and_bom_without_scanning_virtualenv() {
        let root = std::env::temp_dir().join(format!(
            "baize-api-discovery-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("米米")).unwrap();
        fs::create_dir_all(root.join(".venv")).unwrap();
        fs::write(
            root.join("legacy.json"),
            b"\xef\xbb\xbf{\"collections\":[]}",
        )
        .unwrap();
        fs::write(root.join("postman.json"), br#"{"item":[]}"#).unwrap();
        fs::write(
            root.join("米米").join("camera.json"),
            br#"{"cameraType":"FIXTURE","originalPayload":{}}"#,
        )
        .unwrap();
        fs::write(
            root.join(".venv").join("ignored.json"),
            br#"{"collections":[]}"#,
        )
        .unwrap();
        fs::write(root.join("results.json"), br#"{"results":[]}"#).unwrap();
        let found = discover_api_debug_sources(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(found.len(), 3);
        for kind in ["legacy", "postman", "mimi"] {
            assert!(found.iter().any(|s| s.kind == kind));
        }
        assert!(fs::canonicalize(&root)
            .unwrap()
            .starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn raw_body_is_unchanged_and_error_status_keeps_response() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/negative", server.local_addr().unwrap());
        let body = "{\"id\":16067299772662317098,\"url\":\"http://local/\"}";
        let expected = body.to_string();
        let task = thread::spawn(move || {
            let (mut s, _) = server.accept().unwrap();
            s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut b = [0u8; 4096];
            loop {
                let n = s.read(&mut b).unwrap();
                assert!(n > 0, "request ended before the expected body");
                bytes.extend_from_slice(&b[..n]);
                if String::from_utf8_lossy(&bytes).ends_with(&expected) {
                    break;
                }
            }
            let reply = "{\"code\":\"EXPECTED_FAILURE\"}";
            write!(s,"HTTP/1.1 422 Expected\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{reply}",reply.len()).unwrap();
        });
        let result = send(HttpDebugInput {
            id: "fixture".into(),
            method: "POST".into(),
            url,
            headers: vec![],
            body: body.into(),
            timeout_ms: 5000,
            follow_redirects: false,
            insecure_tls: false,
        })
        .await
        .unwrap();
        assert_eq!(result.status, 422);
        assert!(result.body.contains("EXPECTED_FAILURE"));
        assert!(!result.truncated);
        task.join().unwrap();
    }
}
