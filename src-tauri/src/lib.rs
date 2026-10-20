use std::fs;
use std::path::Path;
use std::path::PathBuf;
use tauri::Manager;

/// One-time default state, used when library.json does not exist yet.
const DEFAULT_STATE: &str = r#"{"settings":{"fontSize":20,"theme":"sepia"},"books":[]}"#;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("no data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Older builds stored data under a personal identifier. On first run,
/// move that folder's contents into the new app.folio location so no
/// reader loses their library.
fn migrate_legacy (dir: &Path) {
    if dir.join("library.json").exists() {
        return;
    }
    let Some(parent) = dir.parent() else { return };
    let legacy_names = ["dev.sarthi.ereader", "dev.sarthi.folio"];
    for name in legacy_names {
        let old = parent.join(name);
        if old.join("library.json").exists() {
            copy_tree(&old, dir);
            return;
        }
    }
}

fn copy_tree(from: &Path, to: &Path) {
    let Ok(entries) = fs::read_dir(from) else { return };
    for entry in entries.flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            if fs::create_dir_all(&dst).is_ok() {
                copy_tree(&src, &dst);
            }
        } else if let Err(e) = fs::copy(&src, &dst) {
            eprintln!("migrate {src:?}: {e}");
        }
    }
}

/// True when the frontend may read this path: absolute and inside the
/// app data dir. Books the user picks with the file dialog are copied
/// into the data dir at add time, so reads never have to leave it.
fn path_allowed (p: &Path, data_dir: &Path) -> bool {
    let has_parent_ref = p.components().any(|c| matches!(c, std::path::Component::ParentDir));
    p.is_absolute() && !has_parent_ref && p.starts_with(data_dir)
}

/// Book keys are 16 hex chars from the frontend hash (see fileKey in app.js).
fn check_key (key: &str) -> Result<(), String> {
    let ok = key.len() == 16 && key.chars().all(|c| c.is_ascii_hexdigit());
    if ok { Ok(()) } else { Err("bad key".into()) }
}

/// The previous copy is kept on every save, so a corrupted or rewritten
/// library.json never strands the user without their history.
fn backup_library (dir: &Path) {
    let _ = fs::copy(dir.join("library.json"), dir.join("library.json.bak"));
}

/// Returns the data dir and the raw library state. Old library entries
/// whose path points at the original file on disk (dialog picks from
/// releases before v0.1.3) are copied into the data dir once here.
#[tauri::command]
fn load_library (app: tauri::AppHandle) -> Result<String, String> {
    let dir = data_dir(&app)?;
    migrate_legacy(&dir);
    let path = dir.join("library.json");
    let mut s = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::write(&path, DEFAULT_STATE).map_err(|e| e.to_string())?;
            DEFAULT_STATE.to_string()
        }
        Err(_) => String::new(), // unreadable: the frontend falls back to .bak
    };
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&s) {
        let mut changed = false;
        if let Some(books) = v.get_mut("books").and_then(|b| b.as_array_mut()) {
            for book in books {
                let (Some(path), Some(key)) = (
                    book.get("path").and_then(|p| p.as_str()),
                    book.get("key").and_then(|k| k.as_str()),
                ) else { continue };
                if path_allowed(Path::new(path), &dir) || !path.to_lowercase().ends_with(".epub") {
                    continue;
                }
                let dst = dir.join("books").join(format!("{key}.epub"));
                if fs::copy(path, &dst).is_ok() {
                    book["path"] = serde_json::Value::String(dst.to_string_lossy().into_owned());
                    changed = true;
                }
            }
        }
        if changed
            && let Ok(out) = serde_json::to_string(&v)
        {
            let _ = fs::write(&path, &out);
            s = out;
        }
    }
    Ok(serde_json::json!({ "dir": dir.to_string_lossy(), "state": s }).to_string())
}

#[tauri::command]
fn save_library (app: tauri::AppHandle, state: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    backup_library(&dir);
    let tmp = dir.join("library.json.tmp");
    fs::write(&tmp, state).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("library.json")).map_err(|e| e.to_string())
}

/// Read a file for the frontend. Everything the frontend legitimately
/// needs (imported books, covers, the backup copy) lives in the app
/// data dir, so reads are scoped to that one directory.
/// Uses the raw IPC byte channel — serializing bytes as a JSON array
/// stalls for multi-MB books.
#[tauri::command]
fn read_file (app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    let dir = data_dir(&app)?;
    if !path_allowed(&p, &dir) {
        return Err("not allowed".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Copy a dialog-picked book into the app data dir so it stays readable
/// even if the original location disappears. Returns the new path; the
/// bytes never round-trip through the frontend.
#[tauri::command]
fn import_from_path (app: tauri::AppHandle, key: String, path: String) -> Result<String, String> {
    check_key(&key)?;
    let src = PathBuf::from(&path);
    if !src.is_absolute() || !path.to_lowercase().ends_with(".epub") {
        return Err("not an epub path".into());
    }
    let dir = data_dir(&app)?.join("books");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{key}.epub"));
    fs::copy(&src, &file).map_err(|e| format!("copy {path}: {e}"))?;
    Ok(file.to_string_lossy().into_owned())
}

/// Payload for a dropped book via the raw IPC channel: 16 ascii hex key
/// bytes followed by the epub bytes.
fn split_payload (raw: &[u8]) -> Result<(String, Vec<u8>), String> {
    if raw.len() < 16 {
        return Err("bad payload".into());
    }
    let key = String::from_utf8(raw[..16].to_vec()).map_err(|_| "bad key".to_string())?;
    check_key(&key)?;
    Ok((key, raw[16..].to_vec()))
}

/// Import a dropped book. Receives a single raw byte payload.
#[tauri::command]
fn import_book (app: tauri::AppHandle, request: tauri::ipc::Request) -> Result<String, String> {
    let raw = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("expected raw bytes".into()),
    };
    let (key, data) = split_payload(raw)?;
    let dir = data_dir(&app)?.join("books");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{key}.epub"));
    fs::write(&file, data).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

/// Persist a cover extracted by the frontend. Returns the absolute path.
#[tauri::command]
fn save_cover (app: tauri::AppHandle, key: String, ext: String, data: Vec<u8>) -> Result<String, String> {
    check_key(&key)?;
    let dir = data_dir(&app)?.join("covers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = if !ext.is_empty() && ext.len() < 8 && !ext.contains("..") { ext } else { "img".into() };
    let file = dir.join(format!("{key}.{ext}"));
    fs::write(&file, &data).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_library, save_library, read_file, import_book, import_from_path, save_cover
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_rules () {
        let dir = Path::new("/home/u/.local/share/app.folio");
        assert!(path_allowed(Path::new("/home/u/.local/share/app.folio/books/k.epub"), dir));
        assert!(!path_allowed(Path::new("/etc/passwd"), dir));
        assert!(!path_allowed(Path::new("books/k.epub"), dir), "relative paths denied");
        assert!(!path_allowed(Path::new("/home/u/.local/share/app.folio2/x"), dir),
            "prefix collision must not pass");
        assert!(!path_allowed(Path::new("/home/u/.local/share/app.folio/../secret"), dir),
            ".. traversal denied");
    }

    #[test]
    fn key_rules () {
        assert!(check_key("0123456789abcdef").is_ok());
        assert!(check_key("").is_err());
        assert!(check_key("0123456789abcdeff").is_err(), "too long");
        assert!(check_key("0123456789abcdeg").is_err(), "non-hex rejected");
        assert!(check_key("/etc/passwd____").is_err(), "traversal rejected");
    }

    #[test]
    fn payload_rules () {
        let mut raw = b"0123456789abcdef".to_vec();
        raw.extend_from_slice(&[1, 2, 3]);
        assert!(split_payload(&raw).is_ok());
        assert!(!raw.is_empty());
        let short = b"0123456789abcde".to_vec();
        assert!(split_payload(&short).is_err());
        assert!(split_payload(&[]).is_err());
        let bad = b"/etc/passwd______".to_vec();
        assert!(split_payload(&bad).is_err());
    }
}
