//! 需求资料中 docx 的预处理：正文转 Markdown，内嵌图拆成文件并在正文中给出相对路径。
//! 产物放在 `02-需求理解与答疑/attachments/内嵌图/<文件名>-<哈希前8位>/`，由客户端生成（需求锁定时也允许，
//! 不改动业务资料），AI 只读。AI 读取 docx 时若已有产物，直接返回 Markdown 正文。

use crate::workspace::{load_initialized_workspace, write_atomic_bytes};
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

pub const ASSET_ROOT: &str = "02-需求理解与答疑/attachments/内嵌图";
pub const MARKDOWN_FILE: &str = "正文.md";
pub const MANIFEST_FILE: &str = "manifest.json";
const SOURCE_DIRS: &[&str] = &["01-需求资料", "05-开发资源"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "gif", "bmp", "webp"];
// 与 AI 读取文件的上限一致：超过的文档 AI 读不到，也就不生成产物
const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct DocxAssetStatus {
    pub source: String,
    pub dir_name: String,
    pub asset_dir: String,
    pub ready: bool,
}

/// 文件内容的哈希前 8 位（十六进制）：内容一变，产物目录随之换名，旧产物不会与新正文错配。
pub fn content_hash8(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

type HashCache = HashMap<PathBuf, (u64, SystemTime, String)>;
static HASH_CACHE: OnceLock<Mutex<HashCache>> = OnceLock::new();

/// 源文件内容哈希（前 8 位）。大小与修改时间未变时复用缓存，避免每条消息都重读整个需求目录。
fn source_hash8(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let size = meta.len();
    let cache = HASH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cached_size, cached_modified, hash)) = cache.lock().ok()?.get(path) {
        if *cached_size == size && *cached_modified == modified {
            return Some(hash.clone());
        }
    }
    let hash = content_hash8(&fs::read(path).ok()?);
    cache
        .lock()
        .ok()?
        .insert(path.to_path_buf(), (size, modified, hash.clone()));
    Some(hash)
}

/// 产物目录名：`<文件名去扩展名>-<哈希前8位>`，去掉 Windows 不允许的字符。
pub fn asset_dir_name(docx_file_name: &str, hash8: &str) -> String {
    let stem = Path::new(docx_file_name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default();
    let cleaned: String = stem
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(60)
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(&['.', ' '][..]);
    let base = if cleaned.is_empty() {
        "文档"
    } else {
        cleaned
    };
    format!("{base}-{hash8}")
}

/// 需求资料 docx 对应的产物目录（工作区相对路径）；非需求 01/05 下的 docx 返回 None。
pub fn asset_dir_for_docx(source: &str, bytes: &[u8]) -> Option<String> {
    let path = Path::new(source);
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("docx"))
    {
        return None;
    }
    asset_dir_for_hash(source, &content_hash8(bytes))
}

fn asset_dir_for_hash(source: &str, hash8: &str) -> Option<String> {
    let requirement = requirement_dir_of(source)?;
    let file_name = Path::new(source).file_name()?.to_string_lossy().to_string();
    let dir_name = asset_dir_name(&file_name, hash8);
    Some(to_rel(
        &Path::new(&requirement).join(ASSET_ROOT).join(dir_name),
    ))
}

/// 资料路径中 01-需求资料 / 05-开发资源 之前的部分即需求目录。
fn requirement_dir_of(source: &str) -> Option<String> {
    let parts: Vec<Component> = Path::new(source).components().collect();
    let index = parts.iter().position(|part| {
        matches!(part, Component::Normal(name) if SOURCE_DIRS.iter().any(|dir| name.to_string_lossy() == *dir))
    })?;
    if index == 0 {
        return None;
    }
    let mut requirement = PathBuf::new();
    for part in &parts[..index] {
        requirement.push(part.as_os_str());
    }
    Some(to_rel(&requirement))
}

pub fn is_asset_file_name(name: &str) -> bool {
    if name == MARKDOWN_FILE || name == MANIFEST_FILE {
        return true;
    }
    let Some(rest) = name.strip_prefix("img-") else {
        return false;
    };
    let Some((digits, ext)) = rest.rsplit_once('.') else {
        return false;
    };
    digits.len() >= 3
        && digits.chars().all(|c| c.is_ascii_digit())
        && IMAGE_EXTENSIONS.contains(&ext)
}

fn is_asset_dir_name(name: &str) -> bool {
    let Some((stem, hash)) = name.rsplit_once('-') else {
        return false;
    };
    !stem.is_empty()
        && hash.len() == 8
        && hash
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        && !name.chars().any(|c| c == '/' || c == '\\')
        && !name.contains("..")
}

fn requirement_path(root: &Path, requirement_dir: &str) -> Result<PathBuf, String> {
    let rel = Path::new(requirement_dir);
    let under_projects = rel.components().next().is_some_and(
        |part| matches!(part, Component::Normal(name) if name.to_string_lossy() == "projects"),
    );
    let all_normal = rel
        .components()
        .all(|part| matches!(part, Component::Normal(_)));
    if !under_projects || !all_normal {
        return Err(format!("需求目录路径无效：{requirement_dir}"));
    }
    let path = root.join(rel);
    if !path.join("requirement.yaml").is_file() {
        return Err(format!("需求目录不存在：{requirement_dir}"));
    }
    Ok(path)
}

fn to_rel(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_source_docx(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("docx"))
        && !path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("~$"))
}

/// 已有产物时返回（产物目录, 正文 Markdown）；没有产物返回 None，调用方按原方式提取。
pub fn cached_markdown(
    root_path: &str,
    source: &str,
    bytes: &[u8],
) -> Result<Option<(String, String)>, String> {
    let Some(dir) = asset_dir_for_docx(source, bytes) else {
        return Ok(None);
    };
    let (root, _config) = load_initialized_workspace(root_path)?;
    let markdown = root.join(&dir).join(MARKDOWN_FILE);
    if !markdown.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&markdown).map_err(|error| error.to_string())?;
    Ok(Some((dir, text)))
}

#[tauri::command]
pub fn prepare_docx_assets(
    root_path: String,
    requirement_dir: String,
) -> Result<Vec<DocxAssetStatus>, String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let requirement = requirement_path(&root, &requirement_dir)?;
    let mut statuses = Vec::new();
    for dir in SOURCE_DIRS {
        let source_root = requirement.join(dir);
        if !source_root.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&source_root)
            .sort_by_file_name()
            .into_iter()
            .filter_map(|entry| entry.ok())
        {
            let path = entry.path();
            if !entry.file_type().is_file() || !is_source_docx(path) {
                continue;
            }
            if entry.metadata().map(|meta| meta.len()).unwrap_or(0) > MAX_SOURCE_BYTES {
                continue;
            }
            let source = to_rel(path.strip_prefix(&root).unwrap_or(path));
            let Some(hash8) = source_hash8(path) else {
                continue;
            };
            let Some(asset_dir) = asset_dir_for_hash(&source, &hash8) else {
                continue;
            };
            let dir_name = asset_dir.rsplit('/').next().unwrap_or_default().to_string();
            let ready = root.join(&asset_dir).join(MARKDOWN_FILE).is_file();
            statuses.push(DocxAssetStatus {
                source,
                dir_name,
                asset_dir,
                ready,
            });
        }
    }
    Ok(statuses)
}

#[tauri::command]
pub fn write_docx_asset_file(
    root_path: String,
    requirement_dir: String,
    dir_name: String,
    file_name: String,
    content_base64: String,
) -> Result<(), String> {
    let (root, _config) = load_initialized_workspace(&root_path)?;
    let requirement = requirement_path(&root, &requirement_dir)?;
    if !is_asset_dir_name(&dir_name) {
        return Err(format!("内嵌图目录名无效：{dir_name}"));
    }
    if !is_asset_file_name(&file_name) {
        return Err(format!("内嵌图文件名无效：{file_name}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64.trim())
        .map_err(|error| format!("解析内嵌图内容失败：{error}"))?;
    let target = requirement
        .join(ASSET_ROOT)
        .join(&dir_name)
        .join(&file_name);
    write_atomic_bytes(&target, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{
        create_requirement, ensure_client_write_allowed, ensure_not_managed_path,
        init_fixture_workspace, lock_requirement, RequirementDraft,
    };
    use base64::Engine;
    use std::fs;
    use std::path::Path;

    const REQUIREMENT: &str = "projects/示例平台/AI-1001";

    fn workspace(name: &str) -> (String, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("docx-assets-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        init_fixture_workspace(root_path.clone(), "资料测试工作区".to_string()).unwrap();
        create_requirement(
            root_path.clone(),
            "foton".to_string(),
            RequirementDraft {
                id: "AI-1001".to_string(),
                name: "资料测试".to_string(),
                owner: String::new(),
                planned_test_date: None,
                planned_release_date: None,
                applications: Vec::new(),
                initial_stage: "draft".to_string(),
                yunxiao: None,
                extensions: Default::default(),
            },
        )
        .unwrap();
        (root_path, root)
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn asset_dir_is_named_by_document_and_content_hash() {
        assert_eq!(content_hash8(b"abc"), "ba7816bf");
        assert_eq!(
            asset_dir_for_docx(
                &format!("{REQUIREMENT}/01-需求资料/需求文档/示例项目工单内修.docx"),
                b"abc"
            )
            .as_deref(),
            Some(
                "projects/示例平台/AI-1001/02-需求理解与答疑/attachments/内嵌图/示例项目工单内修-ba7816bf"
            ),
        );
    }

    #[test]
    fn only_source_documents_of_a_requirement_get_assets() {
        assert_eq!(
            asset_dir_for_docx("codex-skills/business/DEMO-1001/接口.docx", b"abc"),
            None
        );
        assert_eq!(
            asset_dir_for_docx(
                &format!("{REQUIREMENT}/02-需求理解与答疑/说明.docx"),
                b"abc"
            ),
            None
        );
        assert_eq!(
            asset_dir_for_docx(
                &format!("{REQUIREMENT}/01-需求资料/需求文档/旧.doc"),
                b"abc"
            ),
            None
        );
    }

    #[test]
    fn asset_file_names_are_limited_to_images_markdown_and_manifest() {
        for ok in [
            "img-001.png",
            "img-1234.jpg",
            "img-002.gif",
            MARKDOWN_FILE,
            MANIFEST_FILE,
        ] {
            assert!(is_asset_file_name(ok), "{ok}");
        }
        for bad in [
            "../正文.md",
            "evil.exe",
            "img-001.png/../x",
            "img-01.png",
            "正文.md.exe",
        ] {
            assert!(!is_asset_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn prepare_lists_source_documents_and_reports_readiness() {
        let (root_path, root) = workspace("prepare");
        let req = root.join(REQUIREMENT);
        fs::create_dir_all(req.join("01-需求资料/需求文档")).unwrap();
        fs::write(req.join("01-需求资料/需求文档/a.docx"), b"abc").unwrap();
        fs::write(req.join("01-需求资料/需求文档/~$a.docx"), b"lock").unwrap();
        fs::create_dir_all(req.join("05-开发资源/后端")).unwrap();
        fs::write(req.join("05-开发资源/后端/b.docx"), b"xyz").unwrap();

        let first = prepare_docx_assets(root_path.clone(), REQUIREMENT.to_string()).unwrap();
        assert_eq!(first.len(), 2, "{first:?}");
        assert!(first.iter().all(|item| !item.ready));
        let target = first
            .iter()
            .find(|item| item.source.ends_with("a.docx"))
            .unwrap()
            .asset_dir
            .clone();
        fs::create_dir_all(root.join(&target)).unwrap();
        fs::write(root.join(&target).join(MARKDOWN_FILE), "# a").unwrap();

        let second = prepare_docx_assets(root_path, REQUIREMENT.to_string()).unwrap();
        assert!(
            second
                .iter()
                .find(|item| item.source.ends_with("a.docx"))
                .unwrap()
                .ready
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changed_source_gets_a_new_asset_folder() {
        let (root_path, root) = workspace("changed");
        let docx = root
            .join(REQUIREMENT)
            .join("01-需求资料/需求文档/变更.docx");
        fs::create_dir_all(docx.parent().unwrap()).unwrap();
        fs::write(&docx, b"first").unwrap();
        let before = prepare_docx_assets(root_path.clone(), REQUIREMENT.to_string()).unwrap();
        fs::write(&docx, b"second version").unwrap();
        let after = prepare_docx_assets(root_path, REQUIREMENT.to_string()).unwrap();
        let before = before
            .iter()
            .find(|item| item.source.ends_with("变更.docx"))
            .unwrap();
        let after = after
            .iter()
            .find(|item| item.source.ends_with("变更.docx"))
            .unwrap();
        assert_ne!(before.asset_dir, after.asset_dir);
        assert_eq!(
            after.asset_dir,
            asset_dir_for_docx(&after.source, b"second version").unwrap()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cached_markdown_is_looked_up_by_the_document_hash() {
        let (root_path, root) = workspace("cached");
        let source = format!("{REQUIREMENT}/01-需求资料/需求文档/需求.docx");
        let docx = root.join(&source);
        fs::create_dir_all(docx.parent().unwrap()).unwrap();
        fs::write(&docx, b"abc").unwrap();
        let dir = asset_dir_for_docx(&source, b"abc").unwrap();
        fs::create_dir_all(root.join(&dir)).unwrap();
        fs::write(root.join(&dir).join(MARKDOWN_FILE), "# 需求").unwrap();

        let found = cached_markdown(&root_path, &source, b"abc")
            .unwrap()
            .unwrap();
        assert_eq!(found, (dir.clone(), "# 需求".to_string()));
        assert!(cached_markdown(&root_path, &source, b"changed")
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn asset_writes_stay_inside_the_requirement_asset_folder() {
        let (root_path, root) = workspace("write");
        let dir = "需求-ba7816bf";
        let png = b64(b"png-bytes");
        write_docx_asset_file(
            root_path.clone(),
            REQUIREMENT.to_string(),
            dir.to_string(),
            "img-001.png".to_string(),
            png.clone(),
        )
        .unwrap();
        let written = root
            .join(REQUIREMENT)
            .join("02-需求理解与答疑/attachments/内嵌图")
            .join(dir)
            .join("img-001.png");
        assert_eq!(fs::read(&written).unwrap(), b"png-bytes");

        let attempts = [
            ("../../x", "img-001.png", REQUIREMENT),
            (dir, "../../正文.md", REQUIREMENT),
            (dir, "evil.exe", REQUIREMENT),
            (dir, "img-001.png", "projects/示例平台/NOPE-9"),
        ];
        for (folder, file, requirement) in attempts {
            assert!(
                write_docx_asset_file(
                    root_path.clone(),
                    requirement.to_string(),
                    folder.to_string(),
                    file.to_string(),
                    png.clone(),
                )
                .is_err(),
                "{folder} {file} {requirement}"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn asset_writes_are_allowed_while_the_requirement_is_locked() {
        let (root_path, root) = workspace("locked");
        lock_requirement(
            root_path.clone(),
            "projects/示例平台".to_string(),
            "AI-1001".to_string(),
            "task-asset-001".to_string(),
            "测试锁定".to_string(),
            "用户".to_string(),
        )
        .unwrap();
        let ordinary = root
            .join(REQUIREMENT)
            .join("01-需求资料/需求文档/锁定后新增.md");
        assert!(ensure_client_write_allowed(Path::new(&ordinary), None).is_err());
        write_docx_asset_file(
            root_path,
            REQUIREMENT.to_string(),
            "需求-ba7816bf".to_string(),
            "img-001.png".to_string(),
            b64(b"png"),
        )
        .unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn generated_asset_folder_is_protected_from_material_operations() {
        let (_root_path, root) = workspace("managed");
        let asset = root
            .join(REQUIREMENT)
            .join("02-需求理解与答疑/attachments/内嵌图/需求-ba7816bf/正文.md");
        assert!(ensure_not_managed_path(&asset).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
