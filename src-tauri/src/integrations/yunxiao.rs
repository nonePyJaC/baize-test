//! Vendor protocol and field/HTML mapping. No core page needs these identifiers.
use super::ports::*;
use crate::yunxiao as y;
use serde_json::{json, Value};
pub struct Yunxiao;
fn remote_case(v: &Value) -> Value {
    let content = v["testSteps"]["content"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    json!({"external_id":v["id"],"display_key":v["customCode"],"title":v["subject"],"preconditions":v["preCondition"],"directory_ref":v["directory"]["id"],"modified_at":v["gmtModified"],
      "actions":if content.is_empty(){vec![text(&v["testSteps"],"stepContent")]}else{content.iter().map(|s|text(s,"step")).collect()},
      "expected_results":if content.is_empty(){vec![text(&v["testSteps"],"expectedResult")]}else{content.iter().map(|s|text(s,"expected")).collect()}})
}
fn opt(a: &Value, k: &str) -> Option<String> {
    let s = text(a, k);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
fn entity(c: &Connection, kind: &str, v: &Value) -> Value {
    let keys = if kind == "member" {
        vec!["userId", "id", "identifier"]
    } else {
        vec![
            "id",
            "identifier",
            "testRepoIdentifier",
            "testPlanIdentifier",
        ]
    };
    let id = keys.iter().find_map(|k| v[*k].as_str()).unwrap_or("");
    let title_keys = if kind == "member" {
        vec!["displayName", "name", "userName"]
    } else {
        vec!["subject", "name", "displayName"]
    };
    let title = title_keys
        .iter()
        .find_map(|k| v[*k].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("");
    let mut r = reference(c, kind, id, title);
    r["extensions"] = json!({"yunxiao":{"instance":c.instance()}});
    if let Some(key) = v["serialNumber"].as_str() {
        r["display_key"] = json!(key);
    }
    r["project_ref"] = v["space"]["id"].clone();
    r["description"] = v["description"].clone();
    if kind == "member" {
        r["search_terms"] = json!(["displayName", "name", "userName", "email"]
            .iter()
            .filter_map(|k| v[*k].as_str().filter(|s| !s.is_empty()))
            .collect::<Vec<_>>());
    }
    // Only expose URLs actually returned by the provider; never invent historical URLs.
    if let Some(url) = v["url"].as_str() {
        r["url"] = json!(url);
    }
    r
}
fn entities(c: &Connection, kind: &str, v: Value) -> Value {
    json!(list(v)
        .iter()
        .map(|v| entity(c, kind, v))
        .collect::<Vec<_>>())
}
fn option_default(value: &Value, options: &[Value]) -> Option<String> {
    if let Some(s) = value.as_str().filter(|s| !s.trim().is_empty()) {
        if let Some(o) = options.iter().find(|o| o["id"] == s || o["label"] == s) {
            return Some(text(o, "id"));
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(s) {
            if parsed != *value {
                return option_default(&parsed, options);
            }
        }
    } else if let Some(values) = value.as_array() {
        if values.len() == 1 {
            return option_default(&values[0], options);
        }
    } else if value.is_object() {
        for k in ["identifier", "id", "value"] {
            if let Some(default) = value.get(k).and_then(|v| option_default(v, options)) {
                return Some(default);
            }
        }
    }
    None
}
fn defect_form_fields(fields: Value) -> Vec<Value> {
    list(fields)
        .iter()
        .filter(|f| {
            f["showWhenCreate"] != false
                && f["required"] == true
                && matches!(f["format"].as_str(), Some("list" | "multiList"))
        })
        .map(|f| {
            let raw_options: Vec<_> = f["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|o| o["disabled"] != true)
                .collect();
            let options: Vec<Value> = raw_options
                .iter()
                .filter_map(|o| {
                    let id = ["identifier", "id"]
                        .iter()
                        .find_map(|k| o[*k].as_str().filter(|s| !s.is_empty()))?;
                    let label = ["displayValue", "value", "name"]
                        .iter()
                        .find_map(|k| o[*k].as_str().filter(|s| !s.is_empty()))
                        .unwrap_or(id);
                    Some(json!({"id":id,"label":label}))
                })
                .collect();
            let declared = f
                .get("defaultValue")
                .filter(|v| !v.is_null() && **v != json!("") && **v != json!([]));
            let default = if let Some(value) = declared {
                option_default(value, &options)
            } else {
                raw_options
                    .iter()
                    .find(|o| o["isDefault"] == true || o["default"] == true)
                    .and_then(|o| option_default(o, &options))
                    .or_else(|| {
                        // Preserve the established Yunxiao dialog defaults using this project's option IDs.
                        let id = text(f, "id").to_ascii_lowercase();
                        let name = text(f, "name");
                        let priority = id == "priority" || name == "优先级";
                        let severity = matches!(id.as_str(), "seriouslevel" | "severity")
                            || name == "严重程度";
                        options
                            .iter()
                            .find(|o| {
                                let label: String = text(o, "label")
                                    .chars()
                                    .filter(|ch| {
                                        !ch.is_whitespace()
                                            && !matches!(
                                                *ch,
                                                '-' | '－' | '—' | '_' | ':' | '：' | '、' | '.'
                                            )
                                    })
                                    .collect::<String>()
                                    .to_lowercase();
                                (priority && matches!(label.as_str(), "中" | "中等" | "medium"))
                                    || (severity && matches!(label.as_str(), "3一般" | "一般"))
                            })
                            .map(|o| text(o, "id"))
                    })
            };
            let mut field =
                json!({"id":f["id"],"label":f["name"],"required":f["required"],"options":options});
            if let Some(default) = default {
                field["default_value"] = json!(default);
            }
            field
        })
        .collect()
}
#[derive(Debug)]
pub struct CasePayloads {
    pub create: Value,
    pub update: Value,
}

fn case_subject(title: &str) -> String {
    let trimmed = title.trim();
    for separator in [':', '：'] {
        if let Some((prefix, rest)) = trimmed.split_once(separator) {
            if prefix.trim_start().to_lowercase().starts_with("tc-") {
                return rest.trim().to_string();
            }
        }
    }
    trimmed.to_string()
}

fn find_case_field<'a>(fields: &'a [Value], ids: &[&str], names: &[&str]) -> Option<&'a Value> {
    fields.iter().find(|field| {
        ids.iter().any(|id| {
            field["id"]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(id))
        }) || names.iter().any(|name| {
            field["name"]
                .as_str()
                .is_some_and(|value| value.trim() == *name)
        })
    })
}

fn option_id(field: &Value, wanted: &[String]) -> Option<String> {
    let options = field["options"].as_array()?;
    options.iter().find_map(|option| {
        let matched = ["displayValue", "value", "valueEn", "id"]
            .iter()
            .any(|key| {
                option[*key].as_str().is_some_and(|text| {
                    wanted
                        .iter()
                        .any(|value| text.trim().eq_ignore_ascii_case(value))
                })
            });
        matched.then(|| {
            option["id"]
                .as_str()
                .or_else(|| option["value"].as_str())
                .unwrap_or_default()
                .to_string()
        })
    })
}

fn option_labels(field: &Value) -> String {
    field["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    option["displayValue"]
                        .as_str()
                        .or_else(|| option["value"].as_str())
                })
                .collect::<Vec<_>>()
                .join("、")
        })
        .filter(|labels| !labels.is_empty())
        .unwrap_or_else(|| "无可用选项".to_string())
}

/// 把本地 priority/test_type 映射成云效字段 id -> 选项 id；标题前缀只用于展示，不再进入 subject。
pub fn resolve_case_fields(fields: &[Value], case: &Value) -> Result<Value, String> {
    let mut custom = serde_json::Map::new();
    if let Some(field) = find_case_field(fields, &["tc.priority", "priority"], &["优先级"]) {
        let priority = case["priority"]
            .as_u64()
            .or_else(|| {
                case["priority"]
                    .as_str()
                    .and_then(|value| value.trim().trim_start_matches(['P', 'p']).parse().ok())
            })
            .unwrap_or(2);
        let wanted = vec![
            format!("P{priority}"),
            format!("p{priority}"),
            format!("{priority}"),
        ];
        let option = option_id(field, &wanted).ok_or_else(|| {
            format!(
                "云效优先级字段没有匹配 P{priority} 的选项（可选：{}）",
                option_labels(field)
            )
        })?;
        custom.insert(
            field["id"]
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .unwrap_or("tc.priority")
                .to_string(),
            json!(option),
        );
    }
    if let Some(field) = find_case_field(
        fields,
        &["tc.type", "type", "caseType"],
        &["类型", "用例类型"],
    ) {
        let test_type = case["test_type"].as_str().unwrap_or_default().trim();
        if !test_type.is_empty() {
            let option = option_id(field, &[test_type.to_string()]).ok_or_else(|| {
                format!(
                    "云效用例类型字段没有匹配「{test_type}」的选项（可选：{}）",
                    option_labels(field)
                )
            })?;
            custom.insert(
                field["id"]
                    .as_str()
                    .filter(|id| !id.trim().is_empty())
                    .unwrap_or("tc.type")
                    .to_string(),
                json!(option),
            );
        }
    }
    Ok(Value::Object(custom))
}

pub fn case_payload(a: &Value, connection: &Connection) -> Result<CasePayloads, String> {
    let c = &a["case"];
    let actions = if let Some(v) = c["actions"].as_array() {
        v.iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        c["steps"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .map(|s| text(s, "action"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let expected = if let Some(v) = c["expected_results"].as_array() {
        v.iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        text(c, "expected_result")
    };
    let pre = c["preconditions"]
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let owners = c["owners"]
        .as_array()
        .filter(|owners| !owners.is_empty())
        .ok_or("用例缺少负责人；请先通过 AI 对话指定并关联云效组织成员")?;
    if owners.len() != 1 {
        return Err("云效用例目前只支持一个负责人".into());
    }
    let owner = &owners[0];
    let owner_id = owner["external_id"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
        .ok_or("负责人尚未关联云效成员ID；请通过 external_query 查询成员后重新指派")?;
    if owner["entity_type"] != "member"
        || owner["provider_id"] != connection.provider_id
        || owner["connection_id"] != connection.connection_id
    {
        return Err("负责人引用不属于当前云效连接，请重新查询并指派成员".into());
    }
    let subject = case_subject(&text(c, "title"));
    if subject.is_empty() {
        return Err("用例标题为空".into());
    }
    let custom = a["custom_field_values"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let steps = json!({"contentType":"TABLE","content":[{"step":actions,"expected":expected}]});
    let mut create = json!({
        "subject": subject,
        "directoryId": a["directory"],
        "preCondition": pre,
        "preConditionFormat": "TEXT",
        "assignedTo": owner_id,
        "testSteps": steps,
    });
    let mut update = json!({
        "subject": subject,
        "preCondition": pre,
        "preConditionFormat": "TEXT",
        "assignedTo": owner_id,
        "testSteps": steps,
    });
    if !custom.is_empty() {
        create["customFieldValues"] = Value::Object(custom.clone());
        if let Some(target) = update.as_object_mut() {
            for (field, value) in custom {
                target.insert(field, value);
            }
        }
    }
    Ok(CasePayloads { create, update })
}
fn html(s: &str, embeds: &Value) -> String {
    let mut escaped = s
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    if let Some(map) = embeds.as_object() {
        for (key, url) in map {
            if let Some(url) = url
                .as_str()
                .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
            {
                escaped = escaped.replace(
                    &format!("[[IMG:{key}]]"),
                    &format!(
                        "<img src=\"{}\" />",
                        url.replace('&', "&amp;").replace('"', "&quot;")
                    ),
                );
            }
        }
    }
    escaped.replace('\n', "<br />")
}
async fn attachments(c: &Connection, a: &Value) -> Result<Value, String> {
    let r = &a["reference"];
    if r["connection_id"] != c.connection_id || r["provider_id"] != c.provider_id {
        return Err("附件回执不属于此连接".into());
    }
    if r["extensions"]["yunxiao"]["instance"] != c.instance() {
        return Err("附件回执的原连接实例已变化，请恢复原组织配置后重试；不会向新组织上传".into());
    }
    let mut embeds = a["embeds"].as_object().cloned().unwrap_or_default();
    let mut pending = Vec::new();
    let mut warnings = Vec::new();
    for file in a["pending_attachments"].as_array().unwrap_or(&Vec::new()) {
        match y::upload_yunxiao_workitem_attachment(
            c.setting("access_token"),
            Some(c.setting("base_url")),
            c.setting("organization_id"),
            text(r, "external_id"),
            text(file, "name"),
            text(file, "data_base64"),
        )
        .await
        {
            Ok(v) => {
                if let Some(url) = v["embedUrl"].as_str().or_else(|| v["url"].as_str()) {
                    embeds.insert(text(file, "id"), json!(url));
                } else {
                    pending.push(file.clone());
                    warnings.push("附件未返回可嵌入地址，请核对后重试".into());
                }
            }
            Err(e) => {
                pending.push(file.clone());
                warnings.push(e);
            }
        }
    }
    let desc = text(a, "description");
    if !embeds.is_empty() {
        if let Err(e) = y::update_yunxiao_workitem(
            c.setting("access_token"),
            Some(c.setting("base_url")),
            c.setting("organization_id"),
            text(r, "external_id"),
            html(&desc, &json!(embeds)),
        )
        .await
        {
            warnings.push(format!("正文回填失败：{e}"));
        }
    }
    Ok(
        json!({"status":if warnings.is_empty(){"created"}else{"attachments_partial"},"reference":r,"pending_attachments":pending,"warnings":warnings,"description":desc,"embeds":embeds}),
    )
}
impl IntegrationPort for Yunxiao {
    fn instance(&self, c: &Connection) -> Value {
        json!([
            c.provider_id,
            c.setting("base_url"),
            c.setting("organization_id")
        ])
    }
    fn supports_case_move(&self) -> bool {
        false
    }
    fn capabilities(&self) -> &'static [&'static str] {
        &[
            "identity",
            "requirements",
            "defects",
            "cases",
            "plans",
            "attachments",
            "tasks",
        ]
    }
    fn call<'a>(&'a self, c: &'a Connection, op: &'a str, a: &'a Value) -> PortFuture<'a> {
        Box::pin(async move {
            let token = c.setting("access_token");
            let base = Some(c.setting("base_url"));
            let org = c.setting("organization_id");
            let auth = y::YunxiaoAuth {
                token: token.clone(),
                base_url: c.setting("base_url"),
                org_id: org.clone(),
            };
            let project = text(a, "project_ref");
            Ok(match op {
                "validate" => serde_json::to_value(y::verify_yunxiao_token(token, base).await?)
                    .map_err(|e| e.to_string())?,
                "projects" => entities(
                    c,
                    "project",
                    y::list_yunxiao_projects(token, base, org, opt(a, "keyword")).await?,
                ),
                "iterations" => entities(
                    c,
                    "iteration",
                    y::list_yunxiao_sprints(token, base, org, project).await?,
                ),
                "members" => {
                    let keyword = opt(a, "keyword").unwrap_or_default().trim().to_lowercase();
                    let members = list(y::list_yunxiao_org_members(token, base, org).await?);
                    let matches = members
                        .into_iter()
                        .filter(|member| {
                            keyword.is_empty()
                                || [
                                    "userId",
                                    "id",
                                    "identifier",
                                    "displayName",
                                    "name",
                                    "userName",
                                    "email",
                                ]
                                .iter()
                                .filter_map(|key| member[*key].as_str())
                                .any(|value| value.to_lowercase().contains(&keyword))
                        })
                        .collect::<Vec<_>>();
                    entities(c, "member", json!(matches))
                }
                "requirements" => {
                    let keyword = opt(a, "keyword");
                    let serial = keyword
                        .as_ref()
                        .filter(|s| {
                            s.rsplit_once('-').is_some_and(|(prefix, number)| {
                                !prefix.is_empty()
                                    && prefix
                                        .chars()
                                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
                                    && !number.is_empty()
                                    && number.chars().all(|ch| ch.is_ascii_digit())
                            })
                        })
                        .cloned();
                    entities(
                        c,
                        "requirement",
                        y::search_yunxiao_workitems(
                            token,
                            base,
                            org,
                            project,
                            "Req".into(),
                            if serial.is_some() { None } else { keyword },
                            opt(a, "sprint_ref"),
                            opt(a, "assignee"),
                            a["participants"].as_array().map(|v| {
                                v.iter()
                                    .filter_map(Value::as_str)
                                    .map(String::from)
                                    .collect()
                            }),
                            serial,
                        )
                        .await?,
                    )
                }
                "create_test_task" => {
                    let parent = text(a, "parent_ref");
                    let assigned = c.setting("user_id");
                    if parent.is_empty() || assigned.is_empty() {
                        return Err("测试子任务需要父需求和已校验的当前用户".into());
                    }
                    let title = format!("[测试] {}", text(a, "title"));
                    let children = y::list_yunxiao_sub_workitems(
                        token.clone(),
                        base.clone(),
                        org.clone(),
                        project.clone(),
                        parent.clone(),
                    )
                    .await?;
                    if let Some(old) = list(children).into_iter().find(|v| {
                        v["assignedTo"]["id"] == assigned
                            && v["subject"] == title
                            && v["categoryId"] == "Task"
                    }) {
                        entity(c, "task", &old)
                    } else {
                        entity(
                            c,
                            "task",
                            &y::create_yunxiao_test_task(
                                token,
                                base,
                                org,
                                project,
                                parent,
                                text(a, "sprint_ref"),
                                title,
                                assigned,
                                None,
                                None,
                            )
                            .await?,
                        )
                    }
                }
                "requirement" => entity(
                    c,
                    "requirement",
                    &y::get_yunxiao_workitem(token, base, org, text(a, "external_id")).await?,
                ),
                "defect_form" => {
                    let types = y::list_yunxiao_workitem_types(
                        token.clone(),
                        base.clone(),
                        org.clone(),
                        project.clone(),
                        Some("Bug".into()),
                    )
                    .await?;
                    let ty = list(types)
                        .into_iter()
                        .find(|t| t["categoryId"] == "Bug")
                        .ok_or("项目未提供缺陷类型")?;
                    let fields = y::list_yunxiao_workitem_type_fields(
                        token,
                        base,
                        org,
                        project,
                        text(&ty, "id"),
                    )
                    .await?;
                    json!({"parent_required":false,"assignee_required":true,"fields":defect_form_fields(fields)})
                }
                "resolve_defect" => {
                    let query = text(a, "query");
                    let id = query
                        .split(|ch: char| !ch.is_ascii_hexdigit())
                        .find(|part| part.len() == 24);
                    if let Some(id) = id {
                        let v = y::get_yunxiao_workitem(token, base, org, id.into()).await?;
                        if v["categoryId"].as_str().is_some_and(|s| s != "Bug") {
                            return Err("所选对象不是缺陷".into());
                        }
                        json!([entity(c, "defect", &v)])
                    } else {
                        let projects = if project.is_empty() {
                            list(
                                y::list_yunxiao_projects(
                                    token.clone(),
                                    base.clone(),
                                    org.clone(),
                                    None,
                                )
                                .await?,
                            )
                            .iter()
                            .map(|v| text(v, "id"))
                            .collect()
                        } else {
                            vec![project]
                        };
                        let mut found = Vec::new();
                        for p in projects {
                            for v in list(
                                y::search_yunxiao_workitems(
                                    token.clone(),
                                    base.clone(),
                                    org.clone(),
                                    p,
                                    "Bug".into(),
                                    None,
                                    None,
                                    None,
                                    None,
                                    Some(query.clone()),
                                )
                                .await?,
                            ) {
                                if text(&v, "serialNumber").eq_ignore_ascii_case(&query) {
                                    found.push(entity(c, "defect", &v));
                                }
                            }
                        }
                        json!(found)
                    }
                }
                "create_defect" => {
                    if text(a, "title").trim().is_empty()
                        || project.is_empty()
                        || text(a, "assignee").is_empty()
                    {
                        return Err("缺陷标题、项目和负责人必填；父需求可选".into());
                    }
                    let v = y::create_yunxiao_bug(
                        token,
                        base,
                        org,
                        project,
                        opt(a, "parent_ref"),
                        text(a, "title"),
                        Some(text(a, "description")),
                        text(a, "assignee"),
                        opt(a, "sprint_ref"),
                        None,
                        Some(a["fields"].clone()),
                        opt(a, "verifier"),
                    )
                    .await?;
                    let mut r = entity(c, "defect", &v);
                    if text(&r, "external_id").is_empty() {
                        return Err("创建响应缺少ID，请核对远端，勿重复创建".into());
                    }
                    if text(&r, "title").is_empty() {
                        r["title"] = a["title"].clone();
                    }
                    attachments(c,&json!({"reference":r,"description":a["description"],"pending_attachments":a["attachments"],"embeds":{}})).await?
                }
                "retry_attachments" => attachments(c, a).await?,
                "repositories" => entities(
                    c,
                    "repository",
                    y::testhub_list_repos(&auth, opt(a, "keyword").as_deref()).await?,
                ),
                "directories" => entities(
                    c,
                    "directory",
                    y::testhub_list_directories(&auth, &text(a, "repository")).await?,
                ),
                "cases" => {
                    let value = y::testhub_search_testcases(
                        &auth,
                        &text(a, "repository"),
                        opt(a, "directory").as_deref(),
                        opt(a, "keyword").as_deref(),
                        a["page"].as_i64().unwrap_or(1),
                    )
                    .await?;
                    json!({"items":list(value).iter().map(remote_case).collect::<Vec<_>>(),"page":a["page"].as_i64().unwrap_or(1)})
                }
                "case" => remote_case(
                    &y::testhub_get_testcase(
                        &auth,
                        &text(a, "repository"),
                        &text(a, "external_id"),
                    )
                    .await?,
                ),
                "plans" => entities(
                    c,
                    "plan",
                    y::list_yunxiao_test_plans(
                        token,
                        base,
                        org,
                        opt(a, "keyword"),
                        opt(a, "project_ref"),
                    )
                    .await?,
                ),
                "create_plan" => {
                    let draft = y::TestPlanDraft {
                        name: text(a, "title"),
                        description: text(a, "description"),
                        start_date: text(a, "start_date"),
                        end_date: text(a, "end_date"),
                        manager_identifiers: vec![text(a, "manager")],
                        member_identifiers: a["members"]
                            .as_array()
                            .unwrap_or(&Vec::new())
                            .iter()
                            .filter_map(Value::as_str)
                            .map(String::from)
                            .collect(),
                        project_identifier: project,
                        sprint_identifier: text(a, "sprint_ref"),
                        scope: text(a, "scope"),
                    };
                    let mut r = entity(
                        c,
                        "plan",
                        &y::create_yunxiao_test_plan(token, base, org, draft).await?,
                    );
                    if text(&r, "title").is_empty() {
                        r["title"] = a["title"].clone();
                    }
                    r
                }
                "testcase_fields" => {
                    y::testhub_list_testcase_fields(&auth, &text(a, "repository")).await?
                }
                "publish_case" => {
                    let id = text(a, "external_id");
                    let payloads =
                        case_payload(a, c).map_err(|error| format!("NOT_COMMITTED:{error}"))?;
                    if !id.is_empty() {
                        let current =
                            y::testhub_get_testcase(&auth, &text(a, "repository"), &id).await?;
                        if text(&current["directory"], "id") != text(a, "directory") {
                            return Err("NOT_COMMITTED:云效公开更新接口不支持目录移动；请在云效人工移动并重新预览、核对映射".into());
                        }
                    }
                    let payload = if id.is_empty() {
                        payloads.create
                    } else {
                        payloads.update
                    };
                    let v = (if id.is_empty() {
                        y::testhub_create_testcase(&auth, &text(a, "repository"), payload).await
                    } else {
                        y::testhub_update_testcase(&auth, &text(a, "repository"), &id, payload)
                            .await
                    })
                    .map_err(|e| {
                        if [
                            "HTTP 400",
                            "HTTP 404",
                            "HTTP 409",
                            "HTTP 422",
                            "HTTP 429",
                            "令牌无效",
                            "未配置云效令牌",
                        ]
                        .iter()
                        .any(|s| e.contains(s))
                        {
                            format!("NOT_COMMITTED:{e}")
                        } else {
                            e
                        }
                    })?;
                    let remote = if id.is_empty() {
                        v.as_str()
                            .unwrap_or_else(|| {
                                v["id"]
                                    .as_str()
                                    .or_else(|| v["testcaseIdentifier"].as_str())
                                    .unwrap_or("")
                            })
                            .to_string()
                    } else {
                        id
                    };
                    if remote.is_empty() {
                        return Err("响应未包含远端ID，需人工核对回执".into());
                    }
                    Ok::<_, String>(
                        json!({"external_id":remote,"digest":a["digest"],"remote_receipt":v}),
                    )?
                }
                _ => return Err(format!("不支持的云效操作{op}")),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };
    /// Loopback HTTP contract fixture, never a real Yunxiao connection.
    fn server(
        replies: Vec<(u16, Value)>,
    ) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let copy = requests.clone();
        let task = thread::spawn(move || {
            for (status, body) in replies {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut data = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let n = socket.read(&mut buffer).unwrap();
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buffer[..n]);
                    if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&data[..end]);
                        let len = header
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if data.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                copy.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&data).to_string());
                let body = body.to_string();
                write!(socket,"HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        (base, requests, task)
    }
    fn connection(base: &str) -> Connection {
        let mut c = Connection {
            connection_id: "http-fixture".into(),
            provider_id: "yunxiao".into(),
            enabled: true,
            ..Default::default()
        };
        c.config.insert("base_url".into(), base.into());
        c.config.insert("organization_id".into(), "org-a".into());
        c.config
            .insert("access_token".into(), "fixture-only".into());
        c
    }
    #[test]
    fn testcase_payload_maps_the_resolved_owner_to_assigned_to() {
        let c = connection("http://fixture.invalid");
        let input = json!({
            "directory":"dir",
            "case":{
                "title":"tc-p1-功能测试: 负责人映射",
                "priority":1,
                "test_type":"功能测试",
                "preconditions":[],
                "steps":[{"action":"打开页面"}],
                "expected_results":["页面正常"],
                "owners":[{
                    "connection_id":"http-fixture",
                    "provider_id":"yunxiao",
                    "entity_type":"member",
                    "external_id":"member-lisi",
                    "title":"李四"
                }]
            },
            "custom_field_values":{"tc.priority":"priority-p1","tc.type":"type-functional"}
        });
        let payload = case_payload(&input, &c).unwrap();
        assert_eq!(payload.create["assignedTo"], "member-lisi");
        assert_eq!(payload.create["subject"], "负责人映射");
        assert_eq!(
            payload.create["customFieldValues"]["tc.priority"],
            "priority-p1"
        );
        assert_eq!(
            payload.create["customFieldValues"]["tc.type"],
            "type-functional"
        );
        assert!(payload.update.get("directoryId").is_none());
        assert_eq!(payload.update["tc.priority"], "priority-p1");
        assert_eq!(payload.update["tc.type"], "type-functional");

        let missing = json!({"directory":"dir","case":{"title":"no owner","owners":[]}});
        assert!(case_payload(&missing, &c)
            .unwrap_err()
            .contains("缺少负责人"));
    }

    #[test]
    fn case_fields_resolve_priority_and_type_by_field_config() {
        let fields = json!([
            {"id":"tc.priority","name":"优先级","format":"list","options":[
                {"id":"priority-p0","displayValue":"P0"},
                {"id":"priority-p1","displayValue":"P1"},
                {"id":"priority-p2","displayValue":"P2"}
            ]},
            {"id":"tc.type","name":"类型","format":"list","options":[
                {"id":"type-functional","displayValue":"功能测试"},
                {"id":"type-interface","displayValue":"接口测试"}
            ]}
        ]);
        let resolved = resolve_case_fields(
            fields.as_array().unwrap(),
            &json!({"priority":0,"test_type":"接口测试"}),
        )
        .unwrap();
        assert_eq!(resolved["tc.priority"], "priority-p0");
        assert_eq!(resolved["tc.type"], "type-interface");
        assert!(resolve_case_fields(
            fields.as_array().unwrap(),
            &json!({"priority":2,"test_type":"性能测试"})
        )
        .unwrap_err()
        .contains("性能测试"));
    }

    #[tokio::test]
    async fn defect_form_defaults_and_member_search_contract() {
        let (base, _, task) = server(vec![
            (200, json!([{"id":"bug-type","categoryId":"Bug"}])),
            (
                200,
                json!([
                    {"id":"priority","name":"优先级","required":true,"format":"list","defaultValue":"high-id","options":[{"identifier":"middle-id","displayValue":"中"},{"identifier":"high-id","displayValue":"高"}]},
                    {"id":"seriousLevel","name":"严重程度","required":true,"format":"list","options":[{"id":"serious-id","value":"2-严重"},{"id":"general-id","value":"3-一般"}]},
                    {"id":"custom","name":"客户字段","required":true,"format":"list","defaultValue":"[\"custom-id\"]","options":[{"identifier":null,"id":"custom-id","displayValue":null,"value":"客户默认"}]},
                    {"id":"invalid","name":"已停用默认值","required":true,"format":"list","defaultValue":"disabled-id","options":[{"id":"disabled-id","value":"已停用","disabled":true},{"id":"available-id","value":"可用"}]}
                ]),
            ),
            (
                200,
                json!([
                    {"id":"org-member","userId":"person-zhang","name":"sts-fixture","displayName":"张三","email":"zhangsan@fixture.invalid"},
                    {"id":"org-member-2","userId":"person-lisi","name":"lisi","displayName":"李四","email":"lisi@fixture.invalid"}
                ]),
            ),
            (
                200,
                json!([
                    {"id":"org-member","userId":"person-zhang","name":"sts-fixture","displayName":"张三","email":"zhangsan@fixture.invalid"},
                    {"id":"org-member-2","userId":"person-lisi","name":"lisi","displayName":"李四","email":"lisi@fixture.invalid"}
                ]),
            ),
        ]);
        let c = connection(&base);
        let form = Yunxiao
            .call(
                &c,
                "defect_form",
                &json!({"project_ref":"project-original"}),
            )
            .await
            .unwrap();
        assert_eq!(form["fields"][0]["default_value"], "high-id"); // Configured values outrank the legacy fallback.
        assert_eq!(form["fields"][1]["default_value"], "general-id");
        assert_eq!(form["fields"][2]["default_value"], "custom-id");
        assert_eq!(form["fields"][2]["options"][0]["label"], "客户默认");
        assert!(form["fields"][3].get("default_value").is_none());
        let members = Yunxiao.call(&c, "members", &json!({})).await.unwrap();
        assert_eq!(members[0]["external_id"], "person-zhang");
        assert_eq!(members[0]["title"], "张三");
        assert!(members[0]["search_terms"]
            .as_array()
            .unwrap()
            .contains(&json!("sts-fixture")));
        assert!(members[0]["search_terms"]
            .as_array()
            .unwrap()
            .contains(&json!("zhangsan@fixture.invalid")));
        let matched = Yunxiao
            .call(&c, "members", &json!({"keyword":"李四"}))
            .await
            .unwrap();
        assert_eq!(matched.as_array().unwrap().len(), 1);
        assert_eq!(matched[0]["external_id"], "person-lisi");
        task.join().unwrap();
        let fallback = defect_form_fields(json!([
            {"id":"priority","name":"优先级","required":true,"format":"list","options":[{"id":"high","value":"高"},{"id":"middle","value":"中"}]},
            {"id":"other","name":"其他字段","required":true,"format":"list","options":[{"id":"default-option","value":"默认选项","isDefault":true}]}
        ]));
        assert_eq!(fallback[0]["default_value"], "middle");
        assert_eq!(fallback[1]["default_value"], "default-option");
    }
    #[tokio::test]
    async fn requirement_binding_and_title_or_serial_search_contract() {
        let story = json!({"id":"story-original","serialNumber":"DEMO-1002","subject":"【示例项目】原绑定需求","space":{"id":"project-original"}});
        let (base, requests, task) = server(vec![
            (200, json!({"result":{"items":[story.clone()]}})),
            (200, json!([story.clone()])),
            (200, story),
        ]);
        let c = connection(&base);
        let by_title = Yunxiao
            .call(
                &c,
                "requirements",
                &json!({"project_ref":"project-original","keyword":"示例项目"}),
            )
            .await
            .unwrap();
        assert_eq!(by_title[0]["external_id"], "story-original");
        assert_eq!(by_title[0]["project_ref"], "project-original");
        let by_serial = Yunxiao
            .call(
                &c,
                "requirements",
                &json!({"project_ref":"project-original","keyword":"DEMO-1002"}),
            )
            .await
            .unwrap();
        assert_eq!(by_serial[0]["display_key"], "DEMO-1002");
        let bound = Yunxiao
            .call(&c, "requirement", &json!({"external_id":"story-original"}))
            .await
            .unwrap();
        assert_eq!(bound["connection_id"], "http-fixture");
        task.join().unwrap();
        let req = requests.lock().unwrap();
        for (index, field, value) in [(0, "subject", "示例项目"), (1, "serialNumber", "DEMO-1002")] {
            let body: Value =
                serde_json::from_str(req[index].split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["category"], "Req");
            assert_eq!(body["spaceId"], "project-original");
            let conditions: Value =
                serde_json::from_str(body["conditions"].as_str().unwrap()).unwrap();
            assert_eq!(
                conditions["conditionGroups"][0][0]["fieldIdentifier"],
                field
            );
            assert_eq!(conditions["conditionGroups"][0][0]["value"][0], value);
        }
        assert!(
            req[2].starts_with("GET /oapi/v1/projex/organizations/org-a/workitems/story-original ")
        );
    }
    #[tokio::test]
    async fn real_http_mapping_update_and_organization_isolation() {
        let (base, requests, task) = server(vec![
            (200, json!([{"id":"repo-a","name":"Repo"}])),
            (200, json!([{"id":"repo-b","name":"Other"}])),
            (200, json!({"id":"remote-case","directory":{"id":"dir"}})),
            (200, json!({"id":"remote-case"})),
        ]);
        let c = connection(&base);
        let r = Yunxiao.call(&c, "repositories", &json!({})).await.unwrap();
        assert_eq!(r[0]["connection_id"], "http-fixture");
        let mut other = c.clone();
        other.connection_id = "other".into();
        other
            .config
            .insert("organization_id".into(), "org-b".into());
        Yunxiao
            .call(&other, "repositories", &json!({}))
            .await
            .unwrap();
        Yunxiao.call(&c,"publish_case",&json!({"repository":"repo-a","external_id":"remote-case","directory":"dir","digest":"sha","case":{"title":"Changed","preconditions":["pre"],"steps":[{"action":"a"},{"action":"b"}],"expected_results":["Overall"],"owners":[{"connection_id":"http-fixture","provider_id":"yunxiao","entity_type":"member","external_id":"person-lisi","title":"李四"}]}})).await.unwrap();
        task.join().unwrap();
        let req = requests.lock().unwrap();
        assert!(req[0].contains("organizations/org-a/"));
        assert!(req[1].contains("organizations/org-b/"));
        assert!(req[3].starts_with("PUT "));
        let body: Value = serde_json::from_str(req[3].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["testSteps"]["content"].as_array().unwrap().len(), 1);
        assert_eq!(body["testSteps"]["content"][0]["expected"], "Overall");
        assert_eq!(body["assignedTo"], "person-lisi");
    }
    #[tokio::test]
    async fn created_bug_survives_detail_and_attachment_failures_then_retries_without_create() {
        let (base, requests, task) = server(vec![
            (200, json!([{"id":"bug-type","categoryId":"Bug"}])),
            (
                200,
                json!({"id":"bug-id","serialNumber":"BUG-9","subject":"Fixture"}),
            ),
            (500, json!({"message":"detail failed"})),
            (500, json!({"message":"upload failed"})),
            (
                200,
                json!({"id":"att","embedUrl":"https://fixture.invalid/img.png"}),
            ),
            (200, json!({"ok":true})),
        ]);
        let c = connection(&base);
        let r=Yunxiao.call(&c,"create_defect",&json!({"title":"Fixture","description":"Actual [[IMG:i]]","project_ref":"project-a","parent_ref":"story-a","assignee":"member-a","fields":{},"attachments":[{"id":"i","name":"fixture.png","data_base64":"AA=="}]})).await.unwrap();
        assert_eq!(r["status"], "attachments_partial");
        assert_eq!(r["reference"]["external_id"], "bug-id");
        let r = Yunxiao.call(&c, "retry_attachments", &r).await.unwrap();
        assert_eq!(r["status"], "created");
        task.join().unwrap();
        let req = requests.lock().unwrap();
        assert_eq!(req.iter().filter(|r|r.starts_with("POST /oapi/v1/projex/organizations/org-a/workitems HTTP")).count(),1);
        assert!(req
            .last()
            .unwrap()
            .contains("https://fixture.invalid/img.png"));
    }
    #[tokio::test]
    async fn create_defect_without_parent_omits_parent_id() {
        let (base, requests, task) = server(vec![
            (200, json!([{"id":"bug-type","categoryId":"Bug"}])),
            (200, json!({"id":"bug-1","serialNumber":"BUG-1","subject":"Top-level"})),
            (200, json!({"id":"bug-1","serialNumber":"BUG-1","subject":"Top-level"})),
        ]);
        let c = connection(&base);
        let r=Yunxiao.call(&c,"create_defect",&json!({"title":"Top-level","description":"线上现象","project_ref":"project-a","assignee":"member-a","fields":{},"attachments":[]})).await.unwrap();
        assert_eq!(r["status"], "created");
        assert_eq!(r["reference"]["external_id"], "bug-1");
        task.join().unwrap();
        let req = requests.lock().unwrap();
        let body: Value =
            serde_json::from_str(req[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert!(body.get("parentId").is_none());
        assert_eq!(body["assignedTo"], "member-a");
    }
}
