//! 云效（阿里云 DevOps / Yunxiao）个人访问令牌校验与项目/工作项查询。
//!
//! 令牌由用户在客户端「设置 → 云效集成」中自行配置，仅保存在本机客户端偏好中，
//! 不写入工作区文件，也不会进入 AI 任务派发词。

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

const DEFAULT_BASE_URL: &str = "https://openapi-rdc.aliyuncs.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YunxiaoIdentity {
    pub organization_id: String,
    pub organization_name: String,
    pub user_id: String,
    pub user_name: String,
    pub base_url: String,
}

fn resolve_base_url(base_url: Option<&str>) -> String {
    let trimmed = base_url.unwrap_or("").trim().trim_end_matches('/');
    if trimmed.is_empty() {
        DEFAULT_BASE_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

fn shorten(body: &str) -> String {
    let text = body.trim().replace(['\r', '\n'], " ");
    text.chars().take(200).collect()
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("创建HTTP客户端失败：{error}"))
}

fn parse_response(status: reqwest::StatusCode, body: &str) -> Result<serde_json::Value, String> {
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(
            "令牌无效或已过期，请在云效「个人设置 → 个人访问令牌」重新生成后填写".to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!(
            "云效返回 HTTP {}：{}",
            status.as_u16(),
            shorten(body)
        ));
    }
    serde_json::from_str(body)
        .map_err(|error| format!("解析云效响应失败：{error}（{}）", shorten(body)))
}

async fn get_json(
    client: &reqwest::Client,
    url: String,
    token: &str,
) -> Result<serde_json::Value, String> {
    let response = client
        .get(url)
        .header("x-yunxiao-token", token)
        .send()
        .await
        .map_err(|error| format!("连接云效失败：{error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_response(status, &body)
}

async fn post_json(
    client: &reqwest::Client,
    url: String,
    token: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let response = client
        .post(url)
        .header("x-yunxiao-token", token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("连接云效失败：{error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    parse_response(status, &text)
}

fn trim_token(token: String) -> Result<String, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("请先填写云效个人访问令牌".to_string());
    }
    Ok(token)
}

/// 云效访问凭据：前端从客户端偏好传入；AI 会话随运行任务携带。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct YunxiaoAuth {
    pub token: String,
    pub base_url: String,
    pub org_id: String,
}

impl YunxiaoAuth {
    fn client(&self) -> Result<(reqwest::Client, String, String), String> {
        let token = self.token.trim().to_string();
        if token.is_empty() {
            return Err("未配置云效令牌：请在「设置 → 云效集成」填写并校验令牌".to_string());
        }
        let base = resolve_base_url(if self.base_url.trim().is_empty() {
            None
        } else {
            Some(self.base_url.trim())
        });
        Ok((http_client()?, base, self.org_id.trim().to_string()))
    }
}

/// TestHub 资源 URL：中心版在路径中携带 organizationId。
fn testhub_url(base: &str, org_id: &str, suffix: &str) -> String {
    if org_id.is_empty() {
        format!("{base}/oapi/v1/testhub{suffix}")
    } else {
        format!("{base}/oapi/v1/testhub/organizations/{org_id}{suffix}")
    }
}

/// 列出云效测试管理的用例库。
pub(crate) async fn testhub_list_repos(
    auth: &YunxiaoAuth,
    name: Option<&str>,
) -> Result<serde_json::Value, String> {
    let (client, base, org) = auth.client()?;
    let mut url = testhub_url(&base, &org, "/testRepo/list?page=1&perPage=100");
    if let Some(name) = name.filter(|value| !value.trim().is_empty()) {
        url.push_str(&format!("&name={}", urlencoding(name.trim())));
    }
    get_json(&client, url, &token_of(auth)).await
}

fn token_of(auth: &YunxiaoAuth) -> String {
    auth.token.trim().to_string()
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// 列出用例库下的测试用例目录（扁平结构，含 parentId 可拼成树）。
pub(crate) async fn testhub_list_directories(
    auth: &YunxiaoAuth,
    test_repo_id: &str,
) -> Result<serde_json::Value, String> {
    let (client, base, org) = auth.client()?;
    get_json(
        &client,
        testhub_url(
            &base,
            &org,
            &format!("/testRepos/{test_repo_id}/directories"),
        ),
        &token_of(auth),
    )
    .await
}

/// 搜索用例库中的测试用例，可按目录与标题关键字过滤。
pub(crate) async fn testhub_search_testcases(
    auth: &YunxiaoAuth,
    test_repo_id: &str,
    directory_id: Option<&str>,
    keyword: Option<&str>,
    page: i64,
) -> Result<serde_json::Value, String> {
    let (client, base, org) = auth.client()?;
    let mut groups = vec![];
    if let Some(k) = keyword.filter(|value| !value.trim().is_empty()) {
        groups.push(vec![json!({
            "fieldIdentifier": "subject",
            "operator": "CONTAINS",
            "value": [k.trim()],
            "toValue": serde_json::Value::Null,
            "className": "string",
            "format": "input"
        })]);
    }
    let mut body = json!({
        "page": page.max(1),
        "perPage": 100,
        "orderBy": "gmtCreate",
        "sort": "desc",
    });
    if !groups.is_empty() {
        let conditions = serde_json::to_string(&json!({ "conditionGroups": groups }))
            .map_err(|e| e.to_string())?;
        body["conditions"] = json!(conditions);
    }
    if let Some(dir) = directory_id.filter(|value| !value.trim().is_empty()) {
        body["directoryId"] = json!(dir.trim());
    }
    post_json(
        &client,
        testhub_url(
            &base,
            &org,
            &format!("/testRepos/{test_repo_id}/testcases:search"),
        ),
        &token_of(auth),
        body,
    )
    .await
}

/// 读取用例库的字段配置（优先级、类型等自定义字段的字段 id 与选项 id）。
pub(crate) async fn testhub_list_testcase_fields(
    auth: &YunxiaoAuth,
    test_repo_id: &str,
) -> Result<serde_json::Value, String> {
    let (client, base, org) = auth.client()?;
    get_json(
        &client,
        testhub_url(
            &base,
            &org,
            &format!("/testRepos/{test_repo_id}/testcases/fields"),
        ),
        &token_of(auth),
    )
    .await
}

/// 获取单条测试用例详情。
pub(crate) async fn testhub_get_testcase(
    auth: &YunxiaoAuth,
    test_repo_id: &str,
    testcase_id: &str,
) -> Result<serde_json::Value, String> {
    let (client, base, org) = auth.client()?;
    get_json(
        &client,
        testhub_url(
            &base,
            &org,
            &format!("/testRepos/{test_repo_id}/testcases/{testcase_id}"),
        ),
        &token_of(auth),
    )
    .await
}

/// 在用例库中创建测试用例（测试用例上传）。
pub(crate) async fn testhub_create_testcase(
    auth: &YunxiaoAuth,
    test_repo_id: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (client, base, org) = auth.client()?;
    post_json(
        &client,
        testhub_url(&base, &org, &format!("/testRepos/{test_repo_id}/testcases")),
        &token_of(auth),
        payload,
    )
    .await
}

/// OAPI UpdateTestCase (PUT); kept at the vendor boundary.
pub(crate) async fn testhub_update_testcase(
    auth: &YunxiaoAuth,
    repo: &str,
    id: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (client, base, org) = auth.client()?;
    let response = client
        .put(testhub_url(
            &base,
            &org,
            &format!("/testRepos/{repo}/testcases/{id}"),
        ))
        .header("x-yunxiao-token", token_of(auth))
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if status.is_success() && body.trim().is_empty() {
        return Ok(json!({"id":id}));
    }
    parse_response(status, &body)
}

/// 在用例库中创建目录。
pub(crate) async fn testhub_create_directory(
    auth: &YunxiaoAuth,
    test_repo_id: &str,
    name: &str,
    parent_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let (client, base, org) = auth.client()?;
    let mut body = json!({ "name": name.trim() });
    if let Some(parent) = parent_id.filter(|value| !value.trim().is_empty()) {
        body["parentIdentifier"] = json!(parent.trim());
    }
    post_json(
        &client,
        testhub_url(
            &base,
            &org,
            &format!("/testRepos/{test_repo_id}/directories"),
        ),
        &token_of(auth),
        body,
    )
    .await
}

/// 校验云效个人访问令牌，返回令牌对应的组织与用户信息。
#[tauri::command]
pub async fn verify_yunxiao_token(
    token: String,
    base_url: Option<String>,
) -> Result<YunxiaoIdentity, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;

    let organizations = get_json(
        &client,
        format!("{base}/oapi/v1/platform/organizations?page=1&perPage=1"),
        &token,
    )
    .await?;
    let first = organizations
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| "该令牌未关联任何云效组织，请检查令牌权限".to_string())?;

    let organization_id = first
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let organization_name = first
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let user = get_json(&client, format!("{base}/oapi/v1/platform/user"), &token).await?;
    let user_id = user
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let user_name = user
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if organization_id.is_empty() && user_id.is_empty() {
        return Err("令牌可访问，但未返回组织或用户信息，请检查令牌权限范围".to_string());
    }

    Ok(YunxiaoIdentity {
        organization_id,
        organization_name,
        user_id,
        user_name,
        base_url: base,
    })
}

/// 列出云效项目。
#[tauri::command]
pub async fn list_yunxiao_projects(
    token: String,
    base_url: Option<String>,
    org_id: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;

    let mut groups = vec![];
    if let Some(n) = name {
        groups.push(vec![json!({
            "fieldIdentifier": "name",
            "operator": "CONTAINS",
            "value": [n],
            "toValue": serde_json::Value::Null,
            "className": "string",
            "format": "input"
        })]);
    }
    // 云效把空 conditionGroups 理解为“不匹配任何”：无条件时传 [[]]（一个空条件组=查全部）
    let conditions = json!({ "conditionGroups": if groups.is_empty() { vec![Vec::<serde_json::Value>::new()] } else { groups } });
    let body = json!({
        "conditions": serde_json::to_string(&conditions).map_err(|e| e.to_string())?,
        "category": "Project",
        "page": 1,
        "perPage": 50
    });
    post_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/projects:search"),
        &token,
        body,
    )
    .await
}

/// 列出项目下迭代。
#[tauri::command]
pub async fn list_yunxiao_sprints(
    token: String,
    base_url: Option<String>,
    org_id: String,
    project_id: String,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    get_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/projects/{project_id}/sprints?page=1&perPage=200"),
        &token,
    )
    .await
}

/// 搜索云效工作项。
fn workitem_items(value: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(items) = value.as_array() {
        return items.clone();
    }
    for key in ["items", "result", "data", "list"] {
        if let Some(inner) = value.get(key) {
            let items = workitem_items(inner);
            if !items.is_empty() {
                return items;
            }
        }
    }
    Vec::new()
}

#[tauri::command]
pub async fn search_yunxiao_workitems(
    token: String,
    base_url: Option<String>,
    org_id: String,
    project_id: String,
    category: String,
    keyword: Option<String>,
    sprint_id: Option<String>,
    assigned_to: Option<String>,
    participants: Option<Vec<String>>,
    serial_number: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;

    let mut conditions = Vec::new();
    // 单号（如 DEMO-1000）走 serialNumber 字段；云效不支持 EQ，用 CONTAINS 由调用方精确过滤
    if let Some(sn) = serial_number {
        conditions.push(json!({
            "fieldIdentifier": "serialNumber",
            "operator": "CONTAINS",
            "value": [sn],
            "toValue": serde_json::Value::Null,
            "className": "string",
            "format": "input"
        }));
    }
    if let Some(k) = keyword {
        conditions.push(json!({
            "fieldIdentifier": "subject",
            "operator": "CONTAINS",
            "value": [k],
            "toValue": serde_json::Value::Null,
            "className": "string",
            "format": "input"
        }));
    }
    if let Some(s) = sprint_id {
        conditions.push(json!({
            "fieldIdentifier": "sprint",
            "operator": "CONTAINS",
            "value": [s],
            "toValue": serde_json::Value::Null,
            "className": "list",
            "format": "multiList"
        }));
    }
    if let Some(a) = assigned_to {
        conditions.push(json!({
            "fieldIdentifier": "assignedTo",
            "operator": "CONTAINS",
            "value": [a],
            "toValue": serde_json::Value::Null,
            "className": "list",
            "format": "multiList"
        }));
    }
    if let Some(p) = participants {
        conditions.push(json!({
            "fieldIdentifier": "participants",
            "operator": "CONTAINS",
            "value": p,
            "toValue": serde_json::Value::Null,
            "className": "list",
            "format": "multiList"
        }));
    }
    // 云效 conditionGroups 外层是 OR、内层是 AND；多个条件必须放在同一个内层组。
    let condition_groups = if conditions.is_empty() {
        vec![Vec::<serde_json::Value>::new()]
    } else {
        vec![conditions]
    };
    let conditions = json!({ "conditionGroups": condition_groups });
    let body = json!({
        "category": category,
        "spaceId": project_id,
        "spaceType": "Project",
        "page": 1,
        "perPage": 100,
        "conditions": serde_json::to_string(&conditions).map_err(|e| e.to_string())?
    });
    let result = post_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/workitems:search"),
        &token,
        body,
    )
    .await?;
    let mut seen = std::collections::HashSet::new();
    let items = workitem_items(&result)
        .into_iter()
        .filter(|item| {
            item["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && seen.insert(id.to_string()))
        })
        .collect::<Vec<_>>();
    Ok(json!(items))
}

/// 获取单个云效工作项详情。
#[tauri::command]
pub async fn get_yunxiao_workitem(
    token: String,
    base_url: Option<String>,
    org_id: String,
    workitem_id: String,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    get_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/workitems/{workitem_id}"),
        &token,
    )
    .await
}

/// 列出父工作项下的子任务。
#[tauri::command]
pub async fn list_yunxiao_sub_workitems(
    token: String,
    base_url: Option<String>,
    org_id: String,
    project_id: String,
    parent_id: String,
) -> Result<serde_json::Value, String> {
    let _ = project_id;
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    // 云效的子项不是通过 workitems:search 的 parentId 条件返回，而是关联项接口。
    let relations = get_json(
        &client,
        format!(
            "{base}/oapi/v1/projex/organizations/{org_id}/workitems/{parent_id}/relationRecords?relationType=SUB"
        ),
        &token,
    )
    .await?;
    let mut seen = std::collections::HashSet::new();
    let ids = workitem_items(&relations)
        .into_iter()
        .filter(|item| {
            item["relationType"]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case("SUB"))
        })
        .filter_map(|item| item["resourceId"].as_str().map(str::to_string))
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect::<Vec<_>>();
    let mut items = Vec::new();
    for id in ids {
        if let Ok(detail) = get_json(
            &client,
            format!("{base}/oapi/v1/projex/organizations/{org_id}/workitems/{id}"),
            &token,
        )
        .await
        {
            items.push(detail);
        }
    }
    Ok(json!(items))
}

async fn resolve_workitem_type_by_category(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    org_id: &str,
    project_id: &str,
    category: &str,
) -> Result<String, String> {
    let url =
        format!("{base}/oapi/v1/projex/organizations/{org_id}/projects/{project_id}/workitemTypes");
    let types = get_json(client, format!("{url}?category={category}"), token).await?;
    let list = types
        .as_array()
        .ok_or_else(|| "工作项类型接口未返回数组".to_string())?;
    list.iter()
        .find(|item| {
            item.get("categoryId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                == category
        })
        .and_then(|item| item.get("id").and_then(|v| v.as_str()).map(String::from))
        .ok_or_else(|| format!("该项目下未找到「{category}」类型，请检查云效项目配置"))
}

async fn resolve_task_workitem_type(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    org_id: &str,
    project_id: &str,
) -> Result<String, String> {
    resolve_workitem_type_by_category(client, base, token, org_id, project_id, "Task").await
}

/// 在云效下创建测试子任务，并返回完整详情。
#[tauri::command]
pub async fn create_yunxiao_test_task(
    token: String,
    base_url: Option<String>,
    org_id: String,
    project_id: String,
    parent_id: String,
    sprint_id: String,
    subject: String,
    assigned_to: String,
    priority_value: Option<String>,
    workitem_type_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;

    let workitem_type_id = match workitem_type_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => resolve_task_workitem_type(&client, &base, &token, &org_id, &project_id).await?,
    };

    let mut custom_fields = serde_json::Map::new();
    if let Some(p) = priority_value {
        custom_fields.insert("priority".to_string(), json!(p));
    }

    let mut body = json!({
        "spaceId": project_id,
        "workitemTypeId": workitem_type_id,
        "parentId": parent_id.clone(),
        "subject": subject,
        "assignedTo": assigned_to,
        "participants": [assigned_to],
        "customFieldValues": custom_fields
    });
    if !sprint_id.trim().is_empty() {
        body["sprint"] = json!(sprint_id);
    }
    let created = post_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/workitems"),
        &token,
        body,
    )
    .await?;

    let workitem_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if workitem_id.is_empty() {
        return Ok(created);
    }
    let detail = get_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/workitems/{workitem_id}"),
        &token,
    )
    .await?;
    if let Some(parent) = detail.get("parentId").and_then(|value| value.as_str()) {
        if !parent.is_empty() && parent != parent_id {
            return Err(format!(
                "云效返回的子任务父项为 {parent}，与当前需求 {parent_id} 不一致；请核对云效项目/需求绑定"
            ));
        }
    }
    Ok(detail)
}

/// 列出组织成员（缺陷负责人/验证者等 user 类型字段的候选项）。
#[tauri::command]
pub async fn list_yunxiao_org_members(
    token: String,
    base_url: Option<String>,
    org_id: String,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    let mut members: Vec<serde_json::Value> = vec![];
    for page in 1..=10 {
        let items = get_json(
            &client,
            format!(
                "{base}/oapi/v1/platform/organizations/{org_id}/members?page={page}&perPage=100"
            ),
            &token,
        )
        .await?;
        let list = items.as_array().cloned().unwrap_or_default();
        let done = list.len() < 100;
        members.extend(list);
        if done {
            break;
        }
    }
    Ok(json!(members))
}

/// 列出项目的工作项类型（含各类型的 id/categoryId，供前端按 category 取 Bug/Task 类型）。
/// 云效要求必须带 category 参数，否则返回 400。
#[tauri::command]
pub async fn list_yunxiao_workitem_types(
    token: String,
    base_url: Option<String>,
    org_id: String,
    project_id: String,
    category: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    let category = category.unwrap_or_else(|| "Bug".to_string());
    get_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/projects/{project_id}/workitemTypes?category={category}"),
        &token,
    )
    .await
}

/// 查询项目下某工作项类型的字段定义（含必填标记与枚举选项 id）。
#[tauri::command]
pub async fn list_yunxiao_workitem_type_fields(
    token: String,
    base_url: Option<String>,
    org_id: String,
    project_id: String,
    workitem_type_id: String,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    get_json(
        &client,
        format!(
            "{base}/oapi/v1/projex/organizations/{org_id}/projects/{project_id}/workitemTypes/{workitem_type_id}/fields"
        ),
        &token,
    )
    .await
}

/// 在云效需求下创建缺陷（Bug 子工作项），并返回完整详情。
#[tauri::command]
pub async fn create_yunxiao_bug(
    token: String,
    base_url: Option<String>,
    org_id: String,
    project_id: String,
    parent_id: Option<String>,
    subject: String,
    description: Option<String>,
    assigned_to: String,
    sprint_id: Option<String>,
    priority_value: Option<String>,
    custom_field_values: Option<serde_json::Value>,
    verifier: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;

    let workitem_type_id =
        resolve_workitem_type_by_category(&client, &base, &token, &org_id, &project_id, "Bug")
            .await?;

    // 必填自定义字段（如严重程度 seriousLevel、优先级 priority）由前端按字段定义传入；
    // priority_value 为兼容参数，显式 custom_field_values 优先
    let mut custom_fields = custom_field_values
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    if let Some(p) = priority_value.filter(|value| !value.trim().is_empty()) {
        custom_fields
            .entry("priority".to_string())
            .or_insert_with(|| json!(p));
    }

    let mut body = serde_json::Map::new();
    body.insert("spaceId".to_string(), json!(project_id));
    body.insert("workitemTypeId".to_string(), json!(workitem_type_id));
    if let Some(parent) = parent_id.filter(|value| !value.trim().is_empty()) {
        body.insert("parentId".to_string(), json!(parent));
    }
    body.insert("subject".to_string(), json!(subject));
    body.insert("assignedTo".to_string(), json!(assigned_to));
    body.insert("participants".to_string(), json!([assigned_to]));
    if let Some(verifier) = verifier.filter(|value| !value.trim().is_empty()) {
        body.insert("verifier".to_string(), json!(verifier));
    }
    if let Some(sprint) = sprint_id.filter(|value| !value.trim().is_empty()) {
        body.insert("sprint".to_string(), json!(sprint));
    }
    if let Some(desc) = description.filter(|value| !value.trim().is_empty()) {
        body.insert("description".to_string(), json!(desc));
    }
    body.insert(
        "customFieldValues".to_string(),
        serde_json::Value::Object(custom_fields),
    );

    let created = post_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/workitems"),
        &token,
        serde_json::Value::Object(body),
    )
    .await?;

    let workitem_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if workitem_id.is_empty() {
        return Ok(created);
    }
    get_json(
        &client,
        format!("{base}/oapi/v1/projex/organizations/{org_id}/workitems/{workitem_id}"),
        &token,
    )
    .await
    .or_else(|_| Ok(created))
}

/// 向已存在的云效工作项上传附件（缺陷截图等），返回 embedUrl/embedHtml 等字段。
#[tauri::command]
pub async fn upload_yunxiao_workitem_attachment(
    token: String,
    base_url: Option<String>,
    org_id: String,
    workitem_id: String,
    file_name: String,
    data_base64: String,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|error| format!("解析附件内容失败：{error}"))?;
    if bytes.is_empty() {
        return Err("附件内容为空".to_string());
    }
    let name = if file_name.trim().is_empty() {
        "screenshot.png".to_string()
    } else {
        file_name.trim().to_string()
    };
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes).file_name(name),
    );
    let response = client
        .post(format!(
            "{base}/oapi/v1/projex/organizations/{org_id}/workitems/{workitem_id}/attachments"
        ))
        .header("x-yunxiao-token", token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("连接云效失败：{error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_response(status, &body)
}

/// 更新云效工作项；当前用于缺陷创建后回填带贴图 embedUrl 的富文本描述。
#[tauri::command]
pub async fn update_yunxiao_workitem(
    token: String,
    base_url: Option<String>,
    org_id: String,
    workitem_id: String,
    description: String,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    let response = client
        .put(format!(
            "{base}/oapi/v1/projex/organizations/{org_id}/workitems/{workitem_id}"
        ))
        .header("x-yunxiao-token", token)
        .json(&json!({ "description": description }))
        .send()
        .await
        .map_err(|error| format!("连接云效失败：{error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.as_u16() == 204 || body.trim().is_empty() {
        return if status.is_success() {
            Ok(json!({ "ok": true }))
        } else {
            Err(format!(
                "云效返回 HTTP {}：{}",
                status.as_u16(),
                shorten(&body)
            ))
        };
    }
    parse_response(status, &body)
}

/// 列出云效测试管理的用例库。
#[tauri::command]
pub async fn list_yunxiao_test_repos(
    token: String,
    base_url: Option<String>,
    org_id: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let auth = YunxiaoAuth {
        token: trim_token(token)?,
        base_url: base_url.unwrap_or_default(),
        org_id,
    };
    testhub_list_repos(&auth, name.as_deref()).await
}

/// 列出用例库下的测试用例目录。
#[tauri::command]
pub async fn list_yunxiao_testcase_directories(
    token: String,
    base_url: Option<String>,
    org_id: String,
    test_repo_id: String,
) -> Result<serde_json::Value, String> {
    let auth = YunxiaoAuth {
        token: trim_token(token)?,
        base_url: base_url.unwrap_or_default(),
        org_id,
    };
    testhub_list_directories(&auth, test_repo_id.trim()).await
}

/// 搜索用例库中的测试用例。
#[tauri::command]
pub async fn search_yunxiao_testcases(
    token: String,
    base_url: Option<String>,
    org_id: String,
    test_repo_id: String,
    directory_id: Option<String>,
    keyword: Option<String>,
    page: Option<i64>,
) -> Result<serde_json::Value, String> {
    let auth = YunxiaoAuth {
        token: trim_token(token)?,
        base_url: base_url.unwrap_or_default(),
        org_id,
    };
    testhub_search_testcases(
        &auth,
        test_repo_id.trim(),
        directory_id.as_deref(),
        keyword.as_deref(),
        page.unwrap_or(1),
    )
    .await
}

/// 获取单条测试用例详情。
#[tauri::command]
pub async fn get_yunxiao_testcase(
    token: String,
    base_url: Option<String>,
    org_id: String,
    test_repo_id: String,
    testcase_id: String,
) -> Result<serde_json::Value, String> {
    let auth = YunxiaoAuth {
        token: trim_token(token)?,
        base_url: base_url.unwrap_or_default(),
        org_id,
    };
    testhub_get_testcase(&auth, test_repo_id.trim(), testcase_id.trim()).await
}

/// 测试计划的创建参数，字段与客户端「新建测试计划」表单一一对应。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TestPlanDraft {
    pub name: String,
    pub description: String,
    pub start_date: String,
    pub end_date: String,
    pub manager_identifiers: Vec<String>,
    pub member_identifiers: Vec<String>,
    pub project_identifier: String,
    pub sprint_identifier: String,
    pub scope: String,
}

fn is_plan_date(value: &str) -> bool {
    value.len() == 10
        && value.chars().enumerate().all(|(index, ch)| {
            if index == 4 || index == 7 {
                ch == '-'
            } else {
                ch.is_ascii_digit()
            }
        })
}

fn trimmed_values(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn test_plan_body(draft: &TestPlanDraft) -> Result<serde_json::Value, String> {
    let name = draft.name.trim();
    if name.is_empty() {
        return Err("请填写测试计划名称".to_string());
    }
    if name.chars().count() > 100 {
        return Err("测试计划名称不能超过100个字符".to_string());
    }
    let managers = trimmed_values(&draft.manager_identifiers);
    if managers.is_empty() {
        return Err("请至少选择一位测试计划管理员".to_string());
    }
    let start = draft.start_date.trim();
    let end = draft.end_date.trim();
    for date in [start, end].into_iter().filter(|value| !value.is_empty()) {
        if !is_plan_date(date) {
            return Err(format!("日期格式应为 yyyy-MM-dd：{date}"));
        }
    }
    if !start.is_empty() && !end.is_empty() && start > end {
        return Err("结束日期不能早于开始日期".to_string());
    }
    let project = draft.project_identifier.trim();
    let sprint = draft.sprint_identifier.trim();
    if !sprint.is_empty() && project.is_empty() {
        return Err("选择迭代时需要同时选择所属项目".to_string());
    }
    let scope = if draft.scope.trim() == "private" {
        "private"
    } else {
        "public"
    };
    let mut body = json!({
        "name": name,
        "managerIdentifiers": managers,
        "scope": scope,
    });
    for (key, value) in [
        ("description", draft.description.trim()),
        ("startDate", start),
        ("endDate", end),
        ("projectIdentifier", project),
        ("sprintIdentifier", sprint),
    ] {
        if !value.is_empty() {
            body[key] = json!(value);
        }
    }
    let members = trimmed_values(&draft.member_identifiers);
    if !members.is_empty() {
        body["memberIdentifiers"] = json!(members);
    }
    Ok(body)
}

fn test_plan_list_url(
    base: &str,
    org_id: &str,
    name: Option<&str>,
    project_id: Option<&str>,
) -> String {
    let mut url =
        format!("{base}/oapi/v1/projex/organizations/{org_id}/testPlan/list?page=1&perPage=100");
    if let Some(value) = name.map(str::trim).filter(|value| !value.is_empty()) {
        url.push_str(&format!("&name={}", urlencoding(value)));
    }
    if let Some(value) = project_id.map(str::trim).filter(|value| !value.is_empty()) {
        url.push_str(&format!("&projectIdentifier={}", urlencoding(value)));
    }
    url
}

/// 按名称（模糊）搜索云效测试计划，可限定所属项目。
#[tauri::command]
pub async fn list_yunxiao_test_plans(
    token: String,
    base_url: Option<String>,
    org_id: String,
    name: Option<String>,
    project_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    post_json(
        &client,
        test_plan_list_url(&base, &org_id, name.as_deref(), project_id.as_deref()),
        &token,
        json!({}),
    )
    .await
}

/// 在云效中新建测试计划，响应包含新计划的 id。
#[tauri::command]
pub async fn create_yunxiao_test_plan(
    token: String,
    base_url: Option<String>,
    org_id: String,
    draft: TestPlanDraft,
) -> Result<serde_json::Value, String> {
    let token = trim_token(token)?;
    let base = resolve_base_url(base_url.as_deref());
    let client = http_client()?;
    let body = test_plan_body(&draft)?;
    post_json(
        &client,
        format!("{base}/oapi/v1/testhub/organizations/{org_id}/testPlans"),
        &token,
        body,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_draft() -> TestPlanDraft {
        TestPlanDraft {
            name: " 示例项目内修 ".to_string(),
            description: "内修车".to_string(),
            start_date: "2026-10-19".to_string(),
            end_date: "2026-10-27".to_string(),
            manager_identifiers: vec!["u-1".to_string()],
            member_identifiers: vec!["u-2".to_string(), " ".to_string()],
            project_identifier: "p-1".to_string(),
            sprint_identifier: "s-1".to_string(),
            scope: "private".to_string(),
        }
    }

    #[test]
    fn test_plan_body_maps_form_fields() {
        let body = test_plan_body(&plan_draft()).unwrap();
        assert_eq!(body["name"], "示例项目内修");
        assert_eq!(body["description"], "内修车");
        assert_eq!(body["startDate"], "2026-10-19");
        assert_eq!(body["endDate"], "2026-10-27");
        assert_eq!(body["managerIdentifiers"], json!(["u-1"]));
        assert_eq!(body["memberIdentifiers"], json!(["u-2"]));
        assert_eq!(body["projectIdentifier"], "p-1");
        assert_eq!(body["sprintIdentifier"], "s-1");
        assert_eq!(body["scope"], "private");
    }

    #[test]
    fn test_plan_body_omits_empty_optional_fields_and_defaults_scope_to_public() {
        let mut draft = plan_draft();
        draft.description = String::new();
        draft.start_date = String::new();
        draft.end_date = String::new();
        draft.member_identifiers = vec![];
        draft.project_identifier = String::new();
        draft.sprint_identifier = String::new();
        draft.scope = String::new();
        let body = test_plan_body(&draft).unwrap();
        for key in [
            "description",
            "startDate",
            "endDate",
            "memberIdentifiers",
            "projectIdentifier",
            "sprintIdentifier",
        ] {
            assert!(body.get(key).is_none(), "{key} should be omitted");
        }
        assert_eq!(body["name"], "示例项目内修");
        assert_eq!(body["managerIdentifiers"], json!(["u-1"]));
        assert_eq!(body["scope"], "public");
    }

    #[test]
    fn test_plan_body_rejects_invalid_drafts() {
        let mut no_name = plan_draft();
        no_name.name = "  ".to_string();
        assert!(test_plan_body(&no_name).is_err());
        let mut no_manager = plan_draft();
        no_manager.manager_identifiers = vec![" ".to_string()];
        assert!(test_plan_body(&no_manager).is_err());
        let mut bad_date = plan_draft();
        bad_date.start_date = "2026/10/19".to_string();
        assert!(test_plan_body(&bad_date).is_err());
        let mut reversed = plan_draft();
        reversed.start_date = "2026-10-30".to_string();
        assert!(test_plan_body(&reversed).is_err());
        let mut sprint_without_project = plan_draft();
        sprint_without_project.project_identifier = String::new();
        assert!(test_plan_body(&sprint_without_project).is_err());
    }

    #[test]
    fn test_plan_list_url_encodes_name_and_project() {
        let url = test_plan_list_url(
            "https://openapi-rdc.aliyuncs.com",
            "org-1",
            Some("示例项目 内修"),
            Some("p-1"),
        );
        assert_eq!(url, "https://openapi-rdc.aliyuncs.com/oapi/v1/projex/organizations/org-1/testPlan/list?page=1&perPage=100&name=%E7%A4%BA%E4%BE%8B%E9%A1%B9%E7%9B%AE%20%E5%86%85%E4%BF%AE&projectIdentifier=p-1");
        assert_eq!(
            test_plan_list_url("https://x", "org-1", None, Some("  ")),
            "https://x/oapi/v1/projex/organizations/org-1/testPlan/list?page=1&perPage=100"
        );
    }

    #[test]
    fn resolves_default_and_custom_base_urls() {
        assert_eq!(resolve_base_url(None), DEFAULT_BASE_URL);
        assert_eq!(resolve_base_url(Some("   ")), DEFAULT_BASE_URL);
        assert_eq!(
            resolve_base_url(Some("https://your-org.devops.aliyuncs.com/")),
            "https://your-org.devops.aliyuncs.com"
        );
    }

    #[test]
    fn shortens_long_error_bodies() {
        let body = "a".repeat(500);
        assert_eq!(shorten(&body).chars().count(), 200);
        assert_eq!(shorten("bad\nbody"), "bad body");
    }

    /// 真实令牌联通性校验。默认跳过，设置 YUNXIAO_ACCESS_TOKEN 后执行：
    /// `cargo test -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "需要 YUNXIAO_ACCESS_TOKEN 环境变量"]
    async fn verifies_real_token_when_env_present() {
        let token = std::env::var("YUNXIAO_ACCESS_TOKEN").unwrap_or_default();
        if token.trim().is_empty() {
            return;
        }
        let identity = verify_yunxiao_token(token, None)
            .await
            .expect("云效令牌校验失败");
        assert!(!identity.organization_id.is_empty(), "未返回组织ID");
        println!(
            "已连接云效：{}（{}）· {}",
            identity.organization_name, identity.organization_id, identity.user_name
        );
    }

    #[tokio::test]
    #[ignore = "需要网络"]
    async fn rejects_invalid_token() {
        let error = verify_yunxiao_token("pt-invalid-token-for-test".to_string(), None)
            .await
            .expect_err("无效令牌不应通过校验");
        assert!(error.contains("令牌无效"), "错误信息不符合预期：{error}");
    }
}
