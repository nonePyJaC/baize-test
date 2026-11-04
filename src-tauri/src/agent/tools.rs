//! 工具执行：工作区工具直接调用受控命令（门禁、日志、审批都在 ai_tools 中）；
//! 文档解析与 XMind 生成通过客户端桥接执行，结果回填后端。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use super::model::{self, Part, Role, ToolCall, MAX_READ_CHUNK_CHARS, READ_CHUNK_CHARS};
use super::run::RunCtx;
use crate::ai_tools::{self, AiSideFile};
use crate::sessions::{self, AiApproval};
use crate::workspace::chrono_now;

const APPROVAL_PREFIX: &str = "APPROVAL_REQUIRED:";

#[derive(Debug, Clone)]
pub(crate) struct ApprovalRequest {
    pub reason: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ToolOutcome {
    pub ok: bool,
    pub output: Option<Value>,
    pub changed_paths: Vec<String>,
    pub error: Option<String>,
    pub approval: Option<ApprovalRequest>,
    pub attachments: Vec<Part>,
}

impl ToolOutcome {
    pub fn success(output: Value, changed_paths: Vec<String>) -> Self {
        Self {
            ok: true,
            output: Some(output),
            changed_paths,
            ..Default::default()
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            ..Default::default()
        }
    }
}

/// 回填给模型的工具结果（与界面侧记录的格式保持一致）。
pub(crate) fn outcome_payload(outcome: &ToolOutcome) -> Value {
    if outcome.ok {
        json!({
            "ok": true,
            "output": outcome.output.clone().unwrap_or(Value::Null),
            "changed_paths": outcome.changed_paths,
        })
    } else {
        json!({
            "ok": false,
            "error": outcome.error.clone().unwrap_or_else(|| "工具执行失败".to_string()),
        })
    }
}

fn str_arg(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn new_confirmation_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("ai-{nanos:x}")
}

fn case_archive_path(requirement_dir: &str, source_fingerprint: &str, args: &Value) -> String {
    let selection_key = args
        .get("case_ids")
        .and_then(Value::as_array)
        .map(|items| {
            let mut ids = items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            ids.sort();
            ids.join("\n")
        })
        .unwrap_or_else(|| "*".to_string());
    let archive_fingerprint =
        sha256_hex(format!("{source_fingerprint}\n{selection_key}").as_bytes());
    Path::new(requirement_dir)
        .join("04-测试用例")
        .join("exports")
        .join(format!("归档-{}.xmind", &archive_fingerprint[..16]))
        .to_string_lossy()
        .into_owned()
}

fn linked_requirement_root(
    workspace_root: &Path,
    requirement_dir: &str,
) -> Result<PathBuf, String> {
    if requirement_dir.trim().is_empty() {
        return Err("请先关联需求".into());
    }
    let canonical_workspace = workspace_root
        .canonicalize()
        .map_err(|error| format!("工作区路径不可用：{error}"))?;
    let canonical_requirement = workspace_root
        .join(requirement_dir)
        .canonicalize()
        .map_err(|error| format!("关联需求目录不可用：{error}"))?;
    if !canonical_requirement.starts_with(&canonical_workspace) {
        return Err("关联需求超出工作区".into());
    }
    Ok(canonical_requirement)
}

fn approval_paths(name: &str, args: &Value, requirement_dir: &str) -> Vec<String> {
    match name {
        "assign_case_owners" => vec![
            Path::new(requirement_dir)
                .join("04-测试用例")
                .join("cases.json")
                .to_string_lossy()
                .into_owned(),
            Path::new(requirement_dir)
                .join("04-测试用例")
                .join("case-events.json")
                .to_string_lossy()
                .into_owned(),
        ],
        "archive_test_cases" => vec![
            str_arg(args, "_archive_path"),
            Path::new(requirement_dir)
                .join("04-测试用例")
                .join("versions")
                .join("(自动创建)")
                .to_string_lossy()
                .into_owned(),
        ],
        "publish_external_version" => vec![format!(
            "外部连接 {} / 用例库 {} / 目录 {} / 正式版本 {} / {}",
            str_arg(args, "connection_id"),
            str_arg(args, "repository"),
            str_arg(args, "directory"),
            str_arg(args, "version_id"),
            str_arg(args, "fingerprint")
        )],
        "submit_external_defect" => vec![format!(
            "外部连接 {} / 项目 {} / 提交缺陷：{}",
            str_arg(args, "connection_id"),
            str_arg(args, "project_ref"),
            str_arg(args, "title")
        )],
        "move_path" => vec![str_arg(args, "from"), str_arg(args, "to")],
        "yunxiao_create_testcase" => vec![format!(
            "云效用例库 {} / {}",
            str_arg(args, "test_repo_id"),
            str_arg(args, "subject")
        )],
        "yunxiao_create_directory" => vec![format!(
            "云效用例库 {} / 目录 {}",
            str_arg(args, "test_repo_id"),
            str_arg(args, "name")
        )],
        "add_questions" => {
            let base = requirement_dir.trim_matches('/');
            let questions = "02-需求理解与答疑/questions.json";
            if base.is_empty() {
                vec![questions.to_string()]
            } else {
                vec![format!("{base}/{questions}")]
            }
        }
        "update_coverage" => {
            let base = requirement_dir.trim_matches('/');
            let coverage = "03-测试计划/coverage.json";
            if base.is_empty() {
                vec![coverage.to_string()]
            } else {
                vec![format!("{base}/{coverage}")]
            }
        }
        _ => vec![str_arg(args, "path")],
    }
}

fn xmind_title_from_path(path: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or_default();
    let title = file
        .strip_suffix(".xmind")
        .or_else(|| file.strip_suffix(".XMIND"))
        .unwrap_or(file);
    if title.is_empty() {
        "测试用例".to_string()
    } else {
        title.to_string()
    }
}

fn extension_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

/// 分段读取文本：返回本段内容、总长度、是否还有后续与下一段偏移。
pub(crate) fn page_text(path: &str, text: &str, args: &Value) -> Value {
    let chars: Vec<char> = text.chars().collect();
    let offset = int_arg(args, "offset").unwrap_or(0).max(0) as usize;
    let requested = int_arg(args, "length")
        .filter(|value| *value > 0)
        .map_or(READ_CHUNK_CHARS, |value| value as usize);
    let take = requested.clamp(1, MAX_READ_CHUNK_CHARS);
    let start = offset.min(chars.len());
    let end = (start + take).min(chars.len());
    let content: String = chars[start..end].iter().collect();
    let has_more = end < chars.len();
    json!({
        "path": path,
        "total_chars": chars.len(),
        "offset": start,
        "returned_chars": end - start,
        "has_more": has_more,
        "next_offset": if has_more { json!(end) } else { Value::Null },
        "content": content,
    })
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    match args.get(key)? {
        Value::Number(number) => number.as_f64().map(|value| value.floor() as i64),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .map(|value| value.floor() as i64),
        _ => None,
    }
}

/// 执行一次模型发起的工具调用。错误以 `ToolOutcome` 返回，不会中断运行。
pub(crate) async fn execute(ctx: &mut RunCtx, call: &ToolCall) -> ToolOutcome {
    let Some(args) = model::parse_arguments(&call.arguments) else {
        return ToolOutcome::failure(
            "工具参数不是有效的 JSON。如果参数内容很长，可能是回复触及输出上限被截断；请把内容拆分后分多次调用（例如按模块拆成多个文件、每次只写一部分）重试。",
        );
    };
    let result = match call.name.as_str() {
        "read_xmind" => read_xmind(ctx, &args).await,
        "read_document" => read_document(ctx, &args).await,
        "read_file" => read_file(ctx, &args),
        "write_xmind" => write_xmind(ctx, &args, None, false).await,
        "assign_case_owners" => assign_case_owners(ctx, &args, None),
        "archive_test_cases" => archive_test_cases(ctx, &args, None).await,
        "external_connections"
        | "external_query"
        | "list_confirmed_case_versions"
        | "preview_external_publication"
        | "publish_external_version"
        | "submit_external_defect" => external_tool(ctx, &call.name, &args, false).await,
        "yunxiao_list_test_repos"
        | "yunxiao_list_directories"
        | "yunxiao_search_testcases"
        | "yunxiao_get_testcase"
        | "yunxiao_create_testcase"
        | "yunxiao_create_directory" => yunxiao_tool(ctx, &call.name, &args, false).await,
        name => run_tool(ctx, name, args.clone()),
    };
    match result {
        Ok(outcome) => outcome,
        Err(message) => match message.strip_prefix(APPROVAL_PREFIX).map(str::to_string) {
            Some(reason) => ToolOutcome {
                ok: false,
                error: Some(reason.clone()),
                approval: Some(ApprovalRequest {
                    reason,
                    paths: approval_paths(&call.name, &args, &ctx.spec.requirement_dir),
                }),
                ..Default::default()
            },
            None => ToolOutcome::failure(message),
        },
    }
}

fn run_tool(ctx: &RunCtx, name: &str, args: Value) -> Result<ToolOutcome, String> {
    let result = ai_tools::run_ai_session_tool(
        ctx.root_path(),
        ctx.session_id().to_string(),
        name.to_string(),
        args,
        Some(ctx.run.run_id.clone()),
    )?;
    Ok(ToolOutcome::success(result.output, result.changed_paths))
}

fn read_file(ctx: &mut RunCtx, args: &Value) -> Result<ToolOutcome, String> {
    let path = str_arg(args, "path");
    let result = ai_tools::run_ai_session_tool(
        ctx.root_path(),
        ctx.session_id().to_string(),
        "read_file".to_string(),
        json!({ "path": path }),
        None,
    )?;
    let file_path = result
        .output
        .get("path")
        .and_then(Value::as_str)
        .map_or_else(|| path.clone(), str::to_string);
    let content = result
        .output
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let output = remember_page(ctx, &file_path, &content, args);
    Ok(ToolOutcome::success(output, Vec::new()))
}

fn remember_page(ctx: &mut RunCtx, path: &str, text: &str, args: &Value) -> Value {
    let output = page_text(path, text, args);
    let start = output["offset"].as_u64().unwrap_or(0);
    let end = start + output["returned_chars"].as_u64().unwrap_or(0);
    let total = text.chars().count();
    let digest = format!(
        "本次仅读取字符[{start},{end})/总{total}；其余范围需核对读取历史。{}",
        model::digest_of(output["content"].as_str().unwrap_or_default())
    );
    ctx.remember_read(path, total, &digest);
    output
}

async fn read_document(ctx: &mut RunCtx, args: &Value) -> Result<ToolOutcome, String> {
    let path = str_arg(args, "path");
    let base64 = ai_tools::read_ai_session_file(ctx.root_path(), path.clone())?
        .ok_or_else(|| format!("文件不存在：{path}"))?;
    let ext = extension_of(&path);
    if ext == "docx" {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64)
            .map_err(|error| error.to_string())?;
        if let Some((dir, markdown)) =
            crate::docx_assets::cached_markdown(&ctx.root_path(), &path, &bytes)?
        {
            let mut output = remember_page(ctx, &path, &markdown, args);
            output["kind"] = json!("text");
            output["asset_dir"] = json!(dir);
            output["note"] = json!("正文已预处理为 Markdown：![图 NNN](img-NNN.png) 标出内嵌截图的位置；需要理解界面细节时，用 read_document 读取 asset_dir 目录下的同名图片。");
            return Ok(ToolOutcome::success(output, Vec::new()));
        }
    }
    let reply = ctx
        .client(
            "extract_document",
            json!({ "path": path, "ext": ext, "base64": base64 }),
        )
        .await?;
    match reply.get("kind").and_then(Value::as_str) {
        Some("image") => {
            let url = reply
                .get("data_url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            ctx.remember_read(&path, 0, "图片资料");
            Ok(ToolOutcome {
                ok: true,
                output: Some(json!({
                    "path": path,
                    "kind": "image",
                    "note": "图片已作为图像附在后续消息中，请据此理解内容",
                })),
                attachments: vec![Part::Text(format!("图片文件：{path}")), Part::Image(url)],
                ..Default::default()
            })
        }
        Some("text") => {
            let text = reply
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut output = remember_page(ctx, &path, &text, args);
            output["kind"] = json!("text");
            if ext == "docx" {
                output["completeness_note"] = json!("正文分段提取；内嵌图片尚未确认已读。若未生成asset_dir，不得声称已看完原型/流程图。");
            }
            Ok(ToolOutcome::success(output, Vec::new()))
        }
        _ => Err(format!(
            "暂不支持读取 {} 类型的文件正文",
            if ext.is_empty() {
                "未知"
            } else {
                ext.as_str()
            }
        )),
    }
}

async fn read_xmind(ctx: &RunCtx, args: &Value) -> Result<ToolOutcome, String> {
    let path = str_arg(args, "path");
    let base64 = ai_tools::read_ai_session_xmind(ctx.root_path(), path.clone())?
        .ok_or_else(|| format!("XMind 文件不存在：{path}"))?;
    let parsed = ctx
        .client("parse_xmind", json!({ "path": path, "base64": base64 }))
        .await?;
    Ok(ToolOutcome::success(
        json!({
            "path": path,
            "title": parsed.get("title").cloned().unwrap_or(Value::Null),
            "outline": parsed.get("outline").cloned().unwrap_or(Value::Null),
        }),
        Vec::new(),
    ))
}

/// 生成并写入 XMind。`approval_id` 有值时为已批准的执行（允许覆盖人工修改过的文件）。
pub(crate) async fn write_xmind(
    ctx: &RunCtx,
    args: &Value,
    approval_id: Option<String>,
    allow_overwrite: bool,
) -> Result<ToolOutcome, String> {
    let path = str_arg(args, "path");
    let outline = str_arg(args, "outline");
    if !path.to_lowercase().ends_with(".xmind") {
        return Err("write_xmind 只能写入 .xmind 文件".to_string());
    }
    if outline.trim().is_empty() {
        return Err("outline 不能为空".to_string());
    }
    let session = sessions::load_session(&ctx.root, ctx.session_id())?;
    if session
        .requirement_id
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        return Err("未关联需求的会话只读，请先为会话关联需求".to_string());
    }
    if session.permission_mode == "plan" {
        return Err("当前权限模式「plan」为只读，不能写入文件".to_string());
    }
    let title = Some(str_arg(args, "title").trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| xmind_title_from_path(&path));
    let existing = ai_tools::read_ai_session_xmind(ctx.root_path(), path.clone())?;
    let regenerated = ctx
        .client(
            "write_xmind",
            json!({
                "root_path": ctx.root_path(),
                "path": path,
                "title": title,
                "outline": outline,
                "append": args.get("append").and_then(Value::as_bool).unwrap_or(false),
                "existing_base64": existing,
                "changed_at": chrono_now(),
                "allow_manual_overwrite": allow_overwrite,
            }),
        )
        .await?;
    let side_files = vec![
        AiSideFile {
            kind: "changes_json".to_string(),
            content: regenerated
                .get("sidecar_json")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        AiSideFile {
            kind: "changes_md".to_string(),
            content: regenerated
                .get("sidecar_markdown")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
    ];
    let content_base64 = regenerated
        .get("content_base64")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let result = match approval_id {
        Some(id) => ai_tools::write_ai_session_xmind_approved(
            ctx.root_path(),
            ctx.session_id().to_string(),
            id,
            path.clone(),
            content_base64,
            side_files,
        )?,
        None => ai_tools::write_ai_session_xmind_with_records(
            ctx.root_path(),
            ctx.session_id().to_string(),
            path.clone(),
            content_base64,
            side_files,
            Some(ctx.run.run_id.clone()),
        )?,
    };
    let mut output = result.output;
    if let Some(map) = output.as_object_mut() {
        map.insert(
            "changes".to_string(),
            regenerated.get("changes").cloned().unwrap_or(Value::Null),
        );
    }
    Ok(ToolOutcome::success(output, result.changed_paths))
}

fn required_arg(args: &Value, key: &str) -> Result<String, String> {
    let value = str_arg(args, key);
    if value.trim().is_empty() {
        return Err(format!("缺少参数：{key}"));
    }
    Ok(value.trim().to_string())
}

fn optional_arg(args: &Value, key: &str) -> Option<String> {
    let value = str_arg(args, key);
    if value.trim().is_empty() {
        None
    } else {
        Some(value.trim().to_string())
    }
}

/// 云效测试管理工具：用会话任务携带的令牌访问 TestHub。
/// approved = true 时表示审批已通过，跳过权限模式的写入门禁。
async fn yunxiao_tool(
    ctx: &RunCtx,
    name: &str,
    args: &Value,
    approved: bool,
) -> Result<ToolOutcome, String> {
    let auth = ctx.spec.yunxiao.clone().unwrap_or_default();
    if auth.token.trim().is_empty() {
        return Err("未配置云效令牌：请在「设置 → 云效集成」填写并校验令牌后重试".to_string());
    }
    if matches!(name, "yunxiao_create_testcase" | "yunxiao_create_directory") && !approved {
        let session = sessions::load_session(&ctx.root, ctx.session_id())?;
        match session.permission_mode.as_str() {
            "ask" => {
                return Err(format!(
                    "{APPROVAL_PREFIX}将向云效用例库写入：{}，需要用户审批",
                    optional_arg(args, "subject")
                        .or_else(|| optional_arg(args, "name"))
                        .unwrap_or_default()
                ))
            }
            "plan" => return Err("当前权限模式「plan」为只读，不能写入云效".to_string()),
            _ => {}
        }
    }
    let output = match name {
        "yunxiao_list_test_repos" => {
            crate::yunxiao::testhub_list_repos(&auth, optional_arg(args, "name").as_deref()).await?
        }
        "yunxiao_list_directories" => {
            crate::yunxiao::testhub_list_directories(&auth, &required_arg(args, "test_repo_id")?)
                .await?
        }
        "yunxiao_search_testcases" => {
            crate::yunxiao::testhub_search_testcases(
                &auth,
                &required_arg(args, "test_repo_id")?,
                optional_arg(args, "directory_id").as_deref(),
                optional_arg(args, "keyword").as_deref(),
                int_arg(args, "page").unwrap_or(1),
            )
            .await?
        }
        "yunxiao_get_testcase" => {
            crate::yunxiao::testhub_get_testcase(
                &auth,
                &required_arg(args, "test_repo_id")?,
                &required_arg(args, "testcase_id")?,
            )
            .await?
        }
        "yunxiao_create_testcase" => {
            let repo = required_arg(args, "test_repo_id")?;
            let mut payload = serde_json::Map::new();
            payload.insert("subject".to_string(), json!(required_arg(args, "subject")?));
            if let Some(dir) = optional_arg(args, "directory_id") {
                payload.insert("directoryId".to_string(), json!(dir));
            }
            if let Some(pre) = optional_arg(args, "pre_condition") {
                payload.insert("preCondition".to_string(), json!(pre));
                payload.insert("preConditionFormat".to_string(), json!("TEXT"));
            }
            if let Some(assigned) = optional_arg(args, "assigned_to") {
                payload.insert("assignedTo".to_string(), json!(assigned));
            }
            if let Some(steps) = args.get("steps").and_then(Value::as_array) {
                let content: Vec<Value> = steps
                    .iter()
                    .filter_map(|item| {
                        let step = item.get("step").and_then(Value::as_str).unwrap_or_default();
                        let expected = item
                            .get("expected")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if step.trim().is_empty() && expected.trim().is_empty() {
                            None
                        } else {
                            Some(json!({ "step": step, "expected": expected }))
                        }
                    })
                    .collect();
                if !content.is_empty() {
                    payload.insert(
                        "testSteps".to_string(),
                        json!({ "contentType": "TABLE", "content": content }),
                    );
                }
            }
            crate::yunxiao::testhub_create_testcase(&auth, &repo, Value::Object(payload)).await?
        }
        "yunxiao_create_directory" => {
            crate::yunxiao::testhub_create_directory(
                &auth,
                &required_arg(args, "test_repo_id")?,
                &required_arg(args, "name")?,
                optional_arg(args, "parent_id").as_deref(),
            )
            .await?
        }
        _ => return Err(format!("未知的云效工具：{name}")),
    };
    Ok(ToolOutcome::success(output, Vec::new()))
}

pub(crate) fn bind_approval(ctx: &RunCtx, name: &str, args: &mut Value) {
    if matches!(name, "publish_external_version" | "submit_external_defect") {
        if let Some(c) = ctx
            .spec
            .connections
            .iter()
            .find(|c| c.connection_id == str_arg(args, "connection_id"))
        {
            args["_original_instance"] = c.instance();
        }
    } else if name == "assign_case_owners" {
        if let Ok((owner, _)) = validated_case_owner(ctx, args) {
            if let Some(connection) = ctx
                .spec
                .connections
                .iter()
                .find(|connection| connection.connection_id == str_arg(&owner, "connection_id"))
            {
                args["_original_instance"] = connection.instance();
            }
        }
        let cases_path = ctx
            .root
            .join(&ctx.spec.requirement_dir)
            .join("04-测试用例")
            .join("cases.json");
        if let Ok(bytes) = fs::read(cases_path) {
            args["_source_fingerprint"] = json!(sha256_hex(&bytes));
            args["_transaction_id"] = json!(new_confirmation_id());
        }
    } else if name == "archive_test_cases" {
        let cases_path = ctx
            .root
            .join(&ctx.spec.requirement_dir)
            .join("04-测试用例")
            .join("cases.json");
        if let Ok(bytes) = fs::read(cases_path) {
            let fingerprint = sha256_hex(&bytes);
            args["_source_fingerprint"] = json!(fingerprint);
            args["_archive_path"] = json!(case_archive_path(
                &ctx.spec.requirement_dir,
                &fingerprint,
                args
            ));
            args["_confirmation_id"] = json!(new_confirmation_id());
        }
    } else if matches!(name, "yunxiao_create_testcase" | "yunxiao_create_directory") {
        if let Some(auth) = &ctx.spec.yunxiao {
            args["_original_instance"] = json!(["yunxiao", auth.base_url, auth.org_id]);
        }
    }
}

fn requested_case_ids(args: &Value, cases: &[Value]) -> Result<Vec<String>, String> {
    let all_ids = cases
        .iter()
        .map(|case| {
            case["id"]
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string)
                .ok_or_else(|| "用例缺少稳定ID，无法归档".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let all_unique = all_ids.iter().collect::<std::collections::BTreeSet<_>>();
    if all_unique.len() != all_ids.len() {
        return Err("当前用例集存在重复ID，无法安全归档".into());
    }
    let raw = match args.get("case_ids") {
        None | Some(Value::Null) => return Ok(all_ids),
        Some(Value::Array(items)) => items,
        Some(_) => return Err("归档用例范围必须是用例ID数组".into()),
    };
    let selected = raw
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string)
                .ok_or_else(|| "归档用例ID无效".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let unique = selected.iter().collect::<std::collections::BTreeSet<_>>();
    if selected.is_empty() || unique.len() != selected.len() {
        return Err("归档用例范围为空或包含重复ID".into());
    }
    if selected.iter().any(|id| !all_ids.contains(id)) {
        return Err("归档范围包含当前用例集不存在的ID，请重新读取用例".into());
    }
    Ok(selected)
}

fn source_run_ids(args: &Value, requirement_root: &Path) -> Result<Vec<String>, String> {
    let raw = match args.get("source_runs") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err("来源轮次必须是轮次ID数组".into()),
    };
    let runs = raw
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|run| run.starts_with("run-") && Path::new(run).components().count() == 1)
                .map(str::to_string)
                .ok_or_else(|| "来源轮次ID无效".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if runs.iter().collect::<std::collections::BTreeSet<_>>().len() != runs.len() {
        return Err("来源轮次ID重复".into());
    }
    for run in &runs {
        for file in ["run.json", "cases-snapshot.json", "results.json"] {
            fs::read(
                requirement_root
                    .join("06-测试执行与证据")
                    .join(run)
                    .join(file),
            )
            .map_err(|error| format!("来源轮次 {run} 缺少 {file}：{error}"))?;
        }
    }
    Ok(runs)
}

fn reusable_final_version(
    requirement_root: &Path,
    source_fingerprint: &str,
    source_runs: &[String],
) -> Result<Option<Value>, String> {
    let valid = crate::integrations::publication::list_confirmed_versions(
        &requirement_root.to_string_lossy(),
    )?;
    let Some(versions) = valid["versions"].as_array() else {
        return Ok(None);
    };
    for version in versions.iter().rev() {
        let Some(version_id) = version["version_id"].as_str() else {
            continue;
        };
        let manifest_path = requirement_root
            .join("04-测试用例")
            .join("versions")
            .join(version_id)
            .join("manifest.json");
        let Ok(bytes) = fs::read(manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let same_run_sources =
            source_runs.is_empty() || manifest["source_run_ids"] == json!(source_runs);
        if manifest["source_fingerprint"] == source_fingerprint && same_run_sources {
            return Ok(Some(manifest));
        }
    }
    Ok(None)
}

fn validated_case_owner(ctx: &RunCtx, args: &Value) -> Result<(Value, Value), String> {
    let owner = args.get("owner").ok_or("缺少云效成员引用")?;
    let connection_id = str_arg(owner, "connection_id");
    let connection = ctx
        .spec
        .connections
        .iter()
        .find(|connection| connection.connection_id == connection_id)
        .ok_or("负责人引用不属于当前会话的外部连接")?;
    if !connection.enabled || connection.provider_id != "yunxiao" {
        return Err("负责人必须来自当前已启用的云效连接".into());
    }
    if str_arg(owner, "provider_id") != connection.provider_id
        || str_arg(owner, "entity_type") != "member"
    {
        return Err("负责人必须是当前云效连接返回的成员引用".into());
    }
    let external_id = str_arg(owner, "external_id");
    let title = str_arg(owner, "title");
    if external_id.trim().is_empty() || title.trim().is_empty() {
        return Err("云效成员引用缺少成员ID或姓名".into());
    }
    let display_key = str_arg(owner, "display_key");
    let display_key = if display_key.trim().is_empty() {
        external_id.trim().to_string()
    } else {
        display_key.trim().to_string()
    };
    let owner_ref = json!({
        "connection_id": connection.connection_id,
        "provider_id": connection.provider_id,
        "entity_type": "member",
        "external_id": external_id.trim(),
        "display_key": display_key,
        "title": title.trim(),
    });
    Ok((owner_ref, connection.instance()))
}

fn assign_case_owners(
    ctx: &RunCtx,
    args: &Value,
    approval_id: Option<String>,
) -> Result<ToolOutcome, String> {
    let requirement_root = linked_requirement_root(&ctx.root, &ctx.spec.requirement_dir)?;
    let session = sessions::load_session(&ctx.root, ctx.session_id())?;
    if session.permission_mode == "plan" {
        return Err("计划模式为只读，不能更新用例负责人".into());
    }
    let (owner_ref, owner_instance) = validated_case_owner(ctx, args)?;
    let raw_ids = args
        .get("case_ids")
        .and_then(Value::as_array)
        .ok_or("必须提供要更新负责人的稳定用例ID数组")?;
    let case_ids = raw_ids
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string)
                .ok_or_else(|| "用例ID无效".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if case_ids.is_empty()
        || case_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != case_ids.len()
    {
        return Err("用例ID数组为空或包含重复ID".into());
    }

    let cases_path = requirement_root.join("04-测试用例").join("cases.json");
    let expected_cases = fs::read(&cases_path)
        .map_err(|error| format!("无法读取结构化用例集 {}：{error}", cases_path.display()))?;
    let source_fingerprint = sha256_hex(&expected_cases);
    if approval_id.is_some() && str_arg(args, "_source_fingerprint") != source_fingerprint {
        return Err("审批后 cases.json 已变化，请重新核对负责人分配范围".into());
    }
    let mut document: Value = serde_json::from_slice(&expected_cases)
        .map_err(|error| format!("cases.json 格式错误：{error}"))?;
    let cases = document["cases"]
        .as_array_mut()
        .ok_or("cases.json 缺少用例列表")?;
    let mut found = std::collections::HashSet::new();
    let mut events = Vec::new();
    let now = chrono_now();
    let reason = str_arg(args, "reason");
    let reason = if reason.trim().is_empty() {
        format!(
            "用户在 AI 对话中指定负责人为「{}」",
            owner_ref["title"].as_str().unwrap_or_default()
        )
    } else {
        reason.trim().to_string()
    };
    let replace_existing = args["replace_existing"].as_bool().unwrap_or(false);

    for case in cases.iter_mut() {
        let case_id = case["id"].as_str().unwrap_or_default().to_string();
        if !case_ids.contains(&case_id) {
            continue;
        }
        found.insert(case_id.clone());
        let existing = case["owners"].as_array().cloned().unwrap_or_default();
        if existing.len() == 1 && existing[0] == owner_ref {
            continue;
        }
        if !existing.is_empty() && !replace_existing {
            return Err(format!(
                "用例 {} 已有其他负责人；只有用户明确要求替换时才能覆盖",
                case["title"].as_str().unwrap_or(&case_id)
            ));
        }
        let before = case.clone();
        let base_revision = before["revision"]
            .as_u64()
            .or_else(|| before["version"].as_u64())
            .unwrap_or(1);
        let next_revision = base_revision + 1;
        let mut after = before.clone();
        after["owners"] = json!([owner_ref.clone()]);
        after["revision"] = json!(next_revision);
        *case = after.clone();

        let mut event = json!({
            "event_id": format!("event-{}", new_confirmation_id()),
            "case_id": case_id,
            "action": "modified",
            "source": "ai_session_assign_owner",
            "actor": "AI会话用户确认",
            "created_at": now.clone(),
            "reason": reason.clone(),
            "before": before.clone(),
            "after": after.clone(),
            "changed_fields": ["负责人"],
            "base_revision": base_revision,
            "next_revision": next_revision,
            "origin": "ai",
            "authority": "approved_proposal",
        });
        if let Some(value) = before["source"]["file"].as_str() {
            event["source_file"] = json!(value);
        }
        if let Some(value) = before["source"]["topic_id"].as_str() {
            event["source_topic"] = json!(value);
        }
        events.push(event);
    }
    if found.len() != case_ids.len() {
        let missing = case_ids
            .iter()
            .filter(|id| !found.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        return Err(format!("用例集不存在这些ID：{}", missing.join("、")));
    }
    if events.is_empty() {
        return Ok(ToolOutcome::success(
            json!({
                "updated": 0,
                "unchanged": case_ids.len(),
                "owner": owner_ref,
                "case_ids": case_ids,
            }),
            Vec::new(),
        ));
    }
    if session.permission_mode == "ask" && approval_id.is_none() {
        return Err(format!(
            "{APPROVAL_PREFIX}将负责人「{}」分配给 {} 条用例，并更新结构化用例及变更审计",
            owner_ref["title"].as_str().unwrap_or_default(),
            events.len()
        ));
    }
    if let Some(id) = approval_id.as_deref() {
        let approval = sessions::find_approval(&ctx.root, ctx.session_id(), id)?;
        if approval.status != "approved"
            || approval.tool != "assign_case_owners"
            || approval.paths
                != approval_paths("assign_case_owners", args, &ctx.spec.requirement_dir)
            || args["_original_instance"] != owner_instance
        {
            return Err("负责人修改审批已失效或外部成员连接已变化，未写入".into());
        }
    }

    let mut metadata = document["metadata"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    metadata.insert("last_modified".into(), json!(now));
    document["metadata"] = Value::Object(metadata);
    let case_content = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    let event_path = requirement_root
        .join("04-测试用例")
        .join("case-events.json");
    let expected_events = match fs::read(&event_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("无法读取用例变更审计：{error}")),
    };
    let mut event_log: Value = match expected_events.as_deref() {
        Some(bytes) => serde_json::from_slice(bytes)
            .map_err(|error| format!("case-events.json 格式错误：{error}"))?,
        None => json!({"version":"1.1","events":[]}),
    };
    let event_list = event_log["events"]
        .as_array_mut()
        .ok_or("case-events.json 缺少 events 数组")?;
    event_list.extend(events.iter().cloned());
    let event_content = serde_json::to_vec_pretty(&event_log).map_err(|error| error.to_string())?;

    let transaction_id = if approval_id.is_some() {
        str_arg(args, "_transaction_id")
    } else {
        new_confirmation_id()
    };
    if transaction_id.is_empty() {
        return Err("负责人更新事务ID缺失，请重新发起".into());
    }
    let outcome = crate::case_revision::commit_case_revision(
        requirement_root.to_string_lossy().into_owned(),
        transaction_id,
        vec![
            crate::case_revision::RevisionWrite {
                path: cases_path.to_string_lossy().into_owned(),
                expected: Some(expected_cases),
                content: case_content,
            },
            crate::case_revision::RevisionWrite {
                path: event_path.to_string_lossy().into_owned(),
                expected: expected_events,
                content: event_content,
            },
        ],
    )?;
    if !outcome.applied {
        return Err(format!(
            "负责人更新未提交；请重新读取用例并确认后重试。{}",
            outcome
                .conflicts
                .iter()
                .chain(outcome.failed.iter())
                .cloned()
                .collect::<Vec<_>>()
                .join("；")
        ));
    }
    Ok(ToolOutcome::success(
        json!({
            "updated": events.len(),
            "owner": owner_ref,
            "case_ids": case_ids,
            "changed_paths": outcome.changed_paths,
        }),
        outcome.changed_paths,
    ))
}

async fn archive_test_cases(
    ctx: &RunCtx,
    args: &Value,
    approval_id: Option<String>,
) -> Result<ToolOutcome, String> {
    let session = sessions::load_session(&ctx.root, ctx.session_id())?;
    if session.permission_mode == "plan" {
        return Err("计划模式为只读，不能创建用例归档".into());
    }
    let requirement_root = linked_requirement_root(&ctx.root, &ctx.spec.requirement_dir)?;
    let cases_path = requirement_root.join("04-测试用例").join("cases.json");
    let expected = fs::read(&cases_path)
        .map_err(|error| format!("无法读取当前用例集 {}：{error}", cases_path.display()))?;
    let source_fingerprint = sha256_hex(&expected);
    if approval_id.is_some() && str_arg(args, "_source_fingerprint") != source_fingerprint {
        return Err("审批后用例集已变化，请重新与 AI 确认归档范围".into());
    }
    let document: Value = serde_json::from_slice(&expected)
        .map_err(|error| format!("cases.json 格式错误：{error}"))?;
    let cases = document["cases"]
        .as_array()
        .ok_or("cases.json 缺少用例列表")?;
    if cases.is_empty() {
        return Err("空用例集不能归档".into());
    }
    let selected_ids = requested_case_ids(args, cases)?;
    let source_runs = source_run_ids(args, &requirement_root)?;
    let archive_path = case_archive_path(&ctx.spec.requirement_dir, &source_fingerprint, args);
    if args
        .get("_archive_path")
        .and_then(Value::as_str)
        .is_some_and(|approved_path| approved_path != archive_path)
    {
        return Err("归档路径与审批时不一致，请重新发起归档".into());
    }
    if session.permission_mode == "ask" && approval_id.is_none() {
        return Err(format!(
            "{APPROVAL_PREFIX}根据本次对话确认，归档 {} 条用例并创建正式版本（SHA-256 {}）",
            selected_ids.len(),
            &source_fingerprint[..12]
        ));
    }
    if let Some(id) = approval_id.as_deref() {
        let approval = sessions::find_approval(&ctx.root, ctx.session_id(), id)?;
        if approval.status != "approved"
            || approval.tool != "archive_test_cases"
            || approval.paths.first().map(String::as_str) != Some(archive_path.as_str())
        {
            return Err("归档审批与当前文件或范围不一致，未写入".into());
        }
    }

    let selected: std::collections::HashSet<String> = selected_ids.iter().cloned().collect();
    let mut archive_document = document.clone();
    archive_document["cases"] = Value::Array(
        cases
            .iter()
            .filter(|case| case["id"].as_str().is_some_and(|id| selected.contains(id)))
            .cloned()
            .collect(),
    );
    let root_title = document["tree"]["title"]
        .as_str()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&ctx.spec.requirement_label);
    let generated = ctx
        .client(
            "export_cases_xmind",
            json!({
                "root_path": ctx.root_path(),
                "document": archive_document,
                "title": root_title,
            }),
        )
        .await?;
    let content_base64 = generated["content_base64"]
        .as_str()
        .ok_or("XMind生成结果缺少文件内容")?
        .to_string();
    let normalized_titles = generated["normalized_titles"].as_u64().unwrap_or(0);

    let reusable = reusable_final_version(&requirement_root, &source_fingerprint, &source_runs)?;
    let version = match reusable {
        Some(manifest) => manifest,
        None => {
            let confirmation_id = if approval_id.is_some() {
                str_arg(args, "_confirmation_id")
            } else {
                new_confirmation_id()
            };
            if confirmation_id.is_empty() {
                return Err("归档确认ID缺失，请重新发起".into());
            }
            let note = str_arg(args, "note");
            crate::case_revision::confirm_case_finalization(
                requirement_root.to_string_lossy().into_owned(),
                expected,
                "AI会话用户确认".to_string(),
                if note.trim().is_empty() {
                    "用户在 AI 会话中确认归档".to_string()
                } else {
                    note
                },
                Vec::new(),
                source_runs.clone(),
                confirmation_id,
            )?
        }
    };
    let version_id = version["version_id"]
        .as_str()
        .ok_or("正式版本创建结果缺少版本号")?
        .to_string();
    let version_dir = Path::new(&ctx.spec.requirement_dir)
        .join("04-测试用例")
        .join("versions")
        .join(&version_id);
    let mut changed_paths = vec![
        version_dir
            .join("cases.json")
            .to_string_lossy()
            .into_owned(),
        version_dir
            .join("manifest.json")
            .to_string_lossy()
            .into_owned(),
    ];

    let archive_abs = ctx.root.join(&archive_path);
    let archive_reused = archive_abs.is_file();
    if !archive_reused {
        let result = if let Some(id) = approval_id {
            ai_tools::write_ai_session_xmind_approved_for_tool(
                ctx.root_path(),
                ctx.session_id().to_string(),
                id,
                "archive_test_cases",
                archive_path.clone(),
                content_base64,
                Vec::<AiSideFile>::new(),
            )
        } else {
            ai_tools::write_ai_session_xmind_with_records(
                ctx.root_path(),
                ctx.session_id().to_string(),
                archive_path.clone(),
                content_base64,
                Vec::<AiSideFile>::new(),
                Some(ctx.run.run_id.clone()),
            )
        };
        match result {
            Ok(result) => changed_paths.extend(result.changed_paths),
            Err(error) => {
                return Ok(ToolOutcome::success(
                    json!({
                        "status": "partial",
                        "version_id": version_id,
                        "archive_path": archive_path,
                        "archive_error": error,
                        "uploaded": false,
                    }),
                    changed_paths,
                ));
            }
        }
    }
    Ok(ToolOutcome::success(
        json!({
            "status": "ready",
            "version_id": version_id,
            "fingerprint": version["fingerprint"],
            "case_count": selected_ids.len(),
            "case_ids": selected_ids,
            "source_run_ids": source_runs,
            "archive_path": archive_path,
            "archive_reused": archive_reused,
            "normalized_titles": normalized_titles,
            "uploaded": false,
        }),
        changed_paths,
    ))
}

async fn external_tool(
    ctx: &RunCtx,
    name: &str,
    args: &Value,
    approved: bool,
) -> Result<ToolOutcome, String> {
    use crate::integrations::{
        self,
        publication::{self, PublicationInput},
    };
    if name == "external_connections" {
        return Ok(ToolOutcome::success(json!(ctx.spec.connections.iter().map(|c|json!({"connection_id":c.connection_id,"provider_id":c.provider_id,"display_name":c.display_name,"enabled":c.enabled,"capabilities":integrations::adapter(c).map(|p|p.capabilities()).unwrap_or(&[])})).collect::<Vec<_>>()),Vec::new()));
    }
    if name == "list_confirmed_case_versions" {
        let dir = linked_requirement_root(&ctx.root, &ctx.spec.requirement_dir)?;
        let mut versions = publication::list_confirmed_versions(&dir.to_string_lossy())?;
        if versions["versions"]
            .as_array()
            .is_some_and(|items| items.is_empty())
        {
            let has_cases = dir.join("04-测试用例").join("cases.json").is_file();
            versions["next_action"] = json!(if has_cases {
                "archive_test_cases"
            } else {
                "import_xmind_to_cases_json"
            });
            versions["next_action_instructions"] = json!(if has_cases {
                "当前没有正式版本。用户已在对话确认范围时，直接调用 archive_test_cases 生成正式版本与 XMind；不要要求用户进入面板手工创建。"
            } else {
                "当前需求没有 cases.json；需要先导入 XMind 并保存为结构化用例集。"
            });
        }
        return Ok(ToolOutcome::success(versions, Vec::new()));
    }
    let c = ctx
        .spec
        .connections
        .iter()
        .find(|c| c.connection_id == str_arg(args, "connection_id"))
        .ok_or("连接未配置，请选择明确的connection_id")?;
    if name == "external_query" {
        let op = str_arg(args, "operation");
        if !matches!(
            op.as_str(),
            "capabilities"
                | "projects"
                | "iterations"
                | "members"
                | "requirements"
                | "requirement"
                | "defect_form"
                | "resolve_defect"
                | "repositories"
                | "directories"
                | "cases"
                | "case"
                | "plans"
        ) {
            return Err("外部查询工具只允许只读操作".into());
        }
        return Ok(ToolOutcome::success(
            integrations::call(c, &op, &args["args"]).await?,
            Vec::new(),
        ));
    }
    if name == "submit_external_defect" {
        return submit_external_defect(ctx, c, args, approved).await;
    }
    let dir = linked_requirement_root(&ctx.root, &ctx.spec.requirement_dir)?;
    let input = PublicationInput {
        requirement_dir: dir.to_string_lossy().to_string(),
        version_id: required_arg(args, "version_id")?,
        fingerprint: required_arg(args, "fingerprint")?,
        repository: required_arg(args, "repository")?,
        directory: str_arg(args, "directory"),
        case_ids: args["case_ids"]
            .as_array()
            .ok_or("case_ids必填")?
            .iter()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
    };
    let value = if name == "preview_external_publication" {
        publication::preview(c, &input).await?
    } else {
        if approved && args["_original_instance"] != c.instance() {
            return Err("审批原连接无法识别或已切换，请重新选择连接并预览；未执行上传".into());
        }
        let preview = publication::preview(c, &input).await?;
        if preview["preview_token"] != str_arg(args, "preview_token") {
            return Err("发布预览已过期或未先预览，请重新核对差异".into());
        }
        if !approved {
            match sessions::load_session(&ctx.root, ctx.session_id())?
                .permission_mode
                .as_str()
            {
                "plan" => return Err("计划模式不能发布".into()),
                "ask" => {
                    return Err(format!(
                    "{APPROVAL_PREFIX}发布正式版本 {} / {} 到连接 {}（{}）用例库 {} / {}，{} 条",
                    input.version_id,
                    input.fingerprint,
                    c.display_name,
                    c.connection_id,
                    input.repository,
                    input.directory,
                    input.case_ids.len()
                ))
                }
                _ => {}
            }
        }
        publication::execute_cancellable(
            c,
            &input,
            &required_arg(args, "preview_token")?,
            &[],
            Some(&ctx.run.cancel),
        )
        .await?
    };
    Ok(ToolOutcome::success(value, Vec::new()))
}
/// 提取正文中的 [[IMG:文件名]] 插图占位符。
fn img_placeholders(description: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = description;
    while let Some(start) = rest.find("[[IMG:") {
        let after = &rest[start + 6..];
        match after.find("]]" ) {
            Some(end) => {
                names.push(after[..end].trim().to_string());
                rest = &after[end + 2..];
            }
            None => break,
        }
    }
    names
}

/// 提交云效缺陷：任何权限模式都先弹审批卡片；会话图片解析为附件；
/// 提交前后维护 pending-defect.json，防止超时/中断导致的重复建单。
async fn submit_external_defect(
    ctx: &RunCtx,
    c: &crate::integrations::ports::Connection,
    args: &Value,
    approved: bool,
) -> Result<ToolOutcome, String> {
    let session = sessions::load_session(&ctx.root, ctx.session_id())?;
    if session.permission_mode == "plan" {
        return Err("计划模式为只读，不能提交缺陷".into());
    }
    let title = required_arg(args, "title")?;
    let project_ref = required_arg(args, "project_ref")?;
    let assignee = required_arg(args, "assignee")?;
    // 图片集合 = session_images 显式引用 ∪ 正文 [[IMG:]] 占位，避免占位符裸文本漏到远端。
    let mut names: Vec<String> = args["session_images"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    for name in img_placeholders(&str_arg(args, "description")) {
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    let mut attachments = Vec::with_capacity(names.len());
    for name in names {
        let data = sessions::read_ai_session_attachment(
            ctx.root_path(),
            ctx.session_id().to_string(),
            name.clone(),
        )?
        .ok_or_else(|| format!("会话图片附件不存在：{name}"))?;
        attachments.push(json!({"id":name,"name":name,"data_base64":data}));
    }
    let mut payload = json!({
        "title": title,
        "description": str_arg(args, "description"),
        "project_ref": project_ref,
        "assignee": assignee,
        "fields": args.get("fields").cloned().unwrap_or_else(|| json!({})),
        "attachments": attachments,
    });
    for (key, target) in [
        ("parent_ref", "parent_ref"),
        ("sprint_ref", "sprint_ref"),
        ("verifier", "verifier"),
    ] {
        if let Some(value) = optional_arg(args, key) {
            payload[target] = json!(value);
        }
    }
    let draft_key = sha256_hex(payload.to_string().as_bytes());
    if let Some(pending) = sessions::load_pending_defect(&ctx.root, ctx.session_id())? {
        match pending["status"].as_str() {
            Some("submitted")
                if pending["draft_key"].as_str() == Some(draft_key.as_str()) =>
            {
                let mut output = pending.clone();
                output["deduplicated"] = json!(true);
                output["note"] = json!("相同草稿此前已成功提交，返回已有回执，未重复建单");
                return Ok(ToolOutcome::success(output, Vec::new()));
            }
            Some("pending") if args["retry_confirmed"].as_bool() != Some(true) => {
                return Err(format!(
                    "上一次缺陷「{}」提交未确认完成（可能超时或中断）。请先用 external_query 的 resolve_defect 按标题核对远端是否已创建：已创建则结束任务；核实未创建后以 retry_confirmed=true 重试。",
                    pending["title"].as_str().unwrap_or_default()
                ));
            }
            _ => {}
        }
    }
    if !approved {
        return Err(format!(
            "{APPROVAL_PREFIX}向连接 {}（{}）提交云效缺陷：项目 {}；父需求 {}；迭代 {}；负责人 {}；标题「{}」；附图 {} 张",
            c.display_name,
            c.connection_id,
            project_ref,
            optional_arg(args, "parent_ref").unwrap_or_else(|| "不关联".into()),
            optional_arg(args, "sprint_ref").unwrap_or_else(|| "不指定".into()),
            assignee,
            title,
            attachments.len()
        ));
    }
    if args["_original_instance"] != c.instance() {
        return Err("审批原连接无法识别或已切换，请重新选择连接并提交；未执行".into());
    }
    sessions::save_pending_defect(
        &ctx.root,
        ctx.session_id(),
        &json!({
            "status": "pending",
            "draft_key": draft_key,
            "title": title,
            "project_ref": project_ref,
            "instance": c.instance(),
            "requested_at": chrono_now(),
        }),
    )?;
    match crate::integrations::call(c, "create_defect", &payload).await {
        Ok(value) => {
            sessions::save_pending_defect(
                &ctx.root,
                ctx.session_id(),
                &json!({
                    "status": "submitted",
                    "draft_key": draft_key,
                    "title": title,
                    "project_ref": project_ref,
                    "reference": value["reference"],
                    "warnings": value["warnings"],
                    "pending_attachments": value["pending_attachments"],
                    "submitted_at": chrono_now(),
                }),
            )?;
            Ok(ToolOutcome::success(value, Vec::new()))
        }
        Err(error) => Err(format!(
            "{error}。注意：请求已发出，远端可能已创建；请先用 resolve_defect 按标题「{title}」核对后再决定是否重试，不要盲目重复提交"
        )),
    }
}

/// 执行用户已批准的操作。每个审批只执行一次，结果由调用方写入会话。
pub(crate) async fn execute_approved(ctx: &RunCtx, approval: &AiApproval) -> ToolOutcome {
    let result = if approval.tool == "write_xmind" {
        write_xmind(ctx, &approval.arguments, Some(approval.id.clone()), true).await
    } else if approval.tool == "assign_case_owners" {
        assign_case_owners(ctx, &approval.arguments, Some(approval.id.clone()))
    } else if approval.tool == "archive_test_cases" {
        archive_test_cases(ctx, &approval.arguments, Some(approval.id.clone())).await
    } else if matches!(
        approval.tool.as_str(),
        "publish_external_version" | "submit_external_defect"
    ) {
        external_tool(ctx, &approval.tool, &approval.arguments, true).await
    } else if matches!(
        approval.tool.as_str(),
        "yunxiao_create_testcase" | "yunxiao_create_directory"
    ) {
        let original = ctx
            .spec
            .yunxiao
            .as_ref()
            .map(|auth| json!(["yunxiao", auth.base_url, auth.org_id]));
        if original.is_none() || Some(approval.arguments["_original_instance"].clone()) != original
        {
            Err("旧审批无法识别原连接，请重新选择连接并提交新请求；不会按当前默认连接写入".into())
        } else {
            yunxiao_tool(ctx, &approval.tool, &approval.arguments, true).await
        }
    } else {
        ai_tools::run_approved_ai_session_tool(
            ctx.root_path(),
            ctx.session_id().to_string(),
            approval.id.clone(),
        )
        .map(|result| ToolOutcome::success(result.output, result.changed_paths))
    };
    result.unwrap_or_else(|error| ToolOutcome::failure(error))
}

/// 处理所有已批准但尚未执行的审批：执行、记录结果、标记为已执行。
pub(crate) async fn process_approved(ctx: &mut RunCtx) -> Result<(), String> {
    let session = sessions::load_session(&ctx.root, ctx.session_id())?;
    let approved: Vec<AiApproval> = session
        .approvals
        .into_iter()
        .filter(|item| item.status == "approved")
        .collect();
    for approval in approved {
        let outcome = execute_approved(ctx, &approval).await;
        sessions::consume_approval(&ctx.root, ctx.session_id(), &approval.id)?;
        let content = if outcome.ok {
            format!("{} 已按审批执行", approval.tool)
        } else {
            format!(
                "{} 执行失败：{}",
                approval.tool,
                outcome
                    .error
                    .clone()
                    .unwrap_or_else(|| "未知错误".to_string())
            )
        };
        let record = json!({
            "id": approval.tool_call_id,
            "name": approval.tool,
            "ok": outcome.ok,
            "changed_paths": outcome.changed_paths,
            "error": outcome.error,
        });
        ctx.persist(Role::Tool, content, vec![record])?;
        if let Ok(latest) = sessions::find_approval(&ctx.root, ctx.session_id(), &approval.id) {
            ctx.emit(super::Event::Approval { approval: latest });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_text_reports_the_next_offset() {
        let text = "a".repeat(25_000);
        let first = page_text("doc.md", &text, &json!({}));
        assert_eq!(first["returned_chars"], json!(20_000));
        assert_eq!(first["has_more"], json!(true));
        assert_eq!(first["next_offset"], json!(20_000));
        let second = page_text("doc.md", &text, &json!({ "offset": 20_000 }));
        assert_eq!(second["returned_chars"], json!(5_000));
        assert_eq!(second["has_more"], json!(false));
        assert_eq!(second["next_offset"], Value::Null);
    }

    #[test]
    fn xmind_title_falls_back_to_a_default() {
        assert_eq!(
            xmind_title_from_path("04-测试用例/登录用例.xmind"),
            "登录用例"
        );
        assert_eq!(xmind_title_from_path("04-测试用例/.xmind"), "测试用例");
    }

    #[test]
    fn move_approvals_list_both_paths() {
        let args = json!({ "from": "a.md", "to": "b/a.md" });
        assert_eq!(
            approval_paths("move_path", &args, "projects/示例平台/AI-1001"),
            vec!["a.md", "b/a.md"]
        );
        assert_eq!(
            approval_paths("delete_path", &json!({ "path": "x.xmind" }), ""),
            vec!["x.xmind"]
        );
        assert_eq!(
            approval_paths("add_questions", &json!({}), "projects/示例平台/AI-1001"),
            vec!["projects/示例平台/AI-1001/02-需求理解与答疑/questions.json"]
        );
    }

    #[test]
    fn archive_approval_path_is_stable_for_the_same_case_scope() {
        let requirement = "projects/示例平台/AI-1001";
        let first = case_archive_path(
            requirement,
            "source-fingerprint",
            &json!({"case_ids":["case-b","case-a"]}),
        );
        let reordered = case_archive_path(
            requirement,
            "source-fingerprint",
            &json!({"case_ids":["case-a","case-b"]}),
        );
        let all = case_archive_path(requirement, "source-fingerprint", &json!({}));
        assert_eq!(first, reordered);
        assert_ne!(first, all);
        assert_eq!(
            approval_paths(
                "archive_test_cases",
                &json!({"_archive_path":first}),
                requirement
            )[0],
            first
        );
    }

    #[test]
    fn linked_requirement_root_canonicalizes_workspace_and_target_before_scoping() {
        let test_root = std::env::temp_dir().join(format!(
            "baize-linked-requirement-path-{}",
            new_confirmation_id()
        ));
        std::fs::create_dir(&test_root).unwrap();
        let workspace = test_root.join("workspace");
        let outside = test_root.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let alias = workspace.join("alias");
        std::fs::create_dir_all(&alias).unwrap();
        let relative = Path::new("projects").join("saas").join("DEMO-1002");
        std::fs::create_dir_all(workspace.join(&relative)).unwrap();

        let resolved = linked_requirement_root(&alias.join(".."), &relative.to_string_lossy())
            .expect("normal path aliases must resolve inside the workspace");
        assert!(resolved.starts_with(workspace.canonicalize().unwrap()));
        let outside_requirement = outside.join("projects").join("saas").join("OTHER-1");
        std::fs::create_dir_all(&outside_requirement).unwrap();
        assert!(
            linked_requirement_root(&workspace, &outside_requirement.to_string_lossy())
                .unwrap_err()
                .contains("关联需求超出工作区")
        );
        std::fs::remove_dir_all(test_root).unwrap();
    }
}
