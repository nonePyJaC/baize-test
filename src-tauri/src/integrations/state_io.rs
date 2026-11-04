use serde_json::Value;
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};
/// Recoverable replacement on Windows and macOS. Never remove the only durable copy.
pub fn read(path: &Path) -> Result<Option<Value>, String> {
    for p in [
        path.to_path_buf(),
        path.with_extension("pending"),
        path.with_extension("previous"),
    ] {
        if p.exists() {
            let b = fs::read(p).map_err(|e| e.to_string())?;
            return serde_json::from_slice(&b)
                .map(Some)
                .map_err(|e| e.to_string());
        }
    }
    Ok(None)
}
pub fn write(path: &Path, value: &Value) -> Result<(), String> {
    crate::workspace::ensure_client_write_allowed(path, None)?;
    let pending = path.with_extension("pending");
    let previous = path.with_extension("previous");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut file = File::create(&pending).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if path.exists() {
        if previous.exists() {
            fs::remove_file(&previous).map_err(|e| e.to_string())?;
        }
        fs::rename(path, &previous).map_err(|e| e.to_string())?;
    }
    fs::rename(&pending, path).map_err(|e| e.to_string())
}
