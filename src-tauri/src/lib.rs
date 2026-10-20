use std::fs;
use tauri::Manager;

/// One-time default state, used when library.json does not exist yet.
const DEFAULT_STATE: &str = r#"{"settings":{"fontSize":20,"theme":"sepia"},"books":[]}"#;

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("no data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Older builds stored data under a personal identifier. On first run,
/// move that folder's contents into the new app.folio location so no
/// reader loses their library.
fn migrate_legacy (dir: &std::path::Path) {
    let has_state = dir.join("library.json").exists();
    if has_state {
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

fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
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

#[tauri::command]
fn load_library(app: tauri::AppHandle) -> Result<String, String> {
    let dir = data_dir(&app)?;
    migrate_legacy(&dir);
    let path = dir.join("library.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => {
            fs::write(&path, DEFAULT_STATE).map_err(|e| e.to_string())?;
            Ok(DEFAULT_STATE.to_string())
        }
    }
}

#[tauri::command]
fn save_library(app: tauri::AppHandle, state: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let tmp = dir.join("library.json.tmp");
    fs::write(&tmp, state).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("library.json")).map_err(|e| e.to_string())
}

/// Read a file for the frontend: only your .epub sources or files
/// inside the app data dir (covers / imported books) are permitted.
/// Uses the raw IPC byte channel — serializing bytes as a JSON array
/// stalls for multi-MB books.
#[tauri::command]
fn read_file(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    let lowered = path.to_lowercase();
    let in_app_data = data_dir(&app).map(|d| p.starts_with(&d)).unwrap_or(false);
    if !lowered.ends_with(".epub") && !in_app_data {
        return Err("not allowed".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Import a dropped book into the app data dir so it stays readable
/// even if the original location disappears. Path is returned.
#[tauri::command]
fn import_book(app: tauri::AppHandle, key: String, data: Vec<u8>) -> Result<String, String> {
    let dir = data_dir(&app)?.join("books");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !key.chars().all(|c| c.is_ascii_hexdigit()) || key.is_empty() || key.len() > 32 {
        return Err("bad key".into());
    }
    let file = dir.join(format!("{key}.epub"));
    fs::write(&file, &data).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

/// Persist a cover extracted by the frontend. Returns the absolute path.
#[tauri::command]
fn save_cover(app: tauri::AppHandle, key: String, ext: String, data: Vec<u8>) -> Result<String, String> {
    let dir = data_dir(&app)?.join("covers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !key.chars().all(|c| c.is_ascii_hexdigit()) || key.is_empty() || key.len() > 32 {
        return Err("bad key".into());
    }
    let ext = if !ext.is_empty() && ext.len() < 8 && !ext.contains("..") { ext } else { "img".into() };
    let file = dir.join(format!("{key}.{ext}"));
    fs::write(&file, &data).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_library, save_library, read_file, import_book, save_cover
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
