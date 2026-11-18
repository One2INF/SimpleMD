use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

pub struct Configuration {
    directory: PathBuf,
    legacy_file: Option<PathBuf>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct SessionSnapshot {
    files: Vec<String>,
    active_path: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct ConfigurationSnapshot {
    preferences: Option<Value>,
    #[serde(default)]
    session: SessionSnapshot,
}

impl Configuration {
    pub fn new(app: &AppHandle) -> tauri::Result<Self> {
        Ok(Self {
            directory: app.path().home_dir()?.join(".SimpleMD"),
            legacy_file: app
                .path()
                .app_config_dir()
                .ok()
                .map(|dir| dir.join("preferences.sqlite3")),
        })
    }

    fn connection(&self) -> Result<Connection, String> {
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let connection =
            Connection::open(self.directory.join("config.sqlite3")).map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS configuration (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    snapshot TEXT NOT NULL
                )",
            )
            .map_err(|e| e.to_string())?;
        Ok(connection)
    }

    fn legacy_preferences(&self) -> Result<Option<Value>, String> {
        let Some(path) = &self.legacy_file else {
            return Ok(None);
        };
        if !path.try_exists().map_err(|e| e.to_string())? {
            return Ok(None);
        }

        // Import only the former workspace record so the legacy database stays intact.
        let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let value: Option<String> = source
            .query_row(
                "SELECT value FROM preferences WHERE key = 'workspace'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        value
            .map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
            .transpose()
    }
}

fn read_snapshot(connection: &Connection) -> Result<Option<ConfigurationSnapshot>, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT snapshot FROM configuration WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    value
        .map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
        .transpose()
}

#[tauri::command]
pub fn load_configuration(
    state: tauri::State<'_, Configuration>,
) -> Result<ConfigurationSnapshot, String> {
    let connection = state.connection()?;
    if let Some(snapshot) = read_snapshot(&connection)? {
        return Ok(snapshot);
    }

    let snapshot = ConfigurationSnapshot {
        preferences: state.legacy_preferences()?,
        session: SessionSnapshot::default(),
    };
    let serialized = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    let inserted = connection
        .execute(
            "INSERT OR IGNORE INTO configuration(id, snapshot) VALUES (1, ?1)",
            params![serialized],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 1 {
        Ok(snapshot)
    } else {
        read_snapshot(&connection)?.ok_or_else(|| "无法读取配置".into())
    }
}

#[tauri::command]
pub fn save_configuration(
    state: tauri::State<'_, Configuration>,
    configuration: ConfigurationSnapshot,
) -> Result<(), String> {
    let serialized = serde_json::to_string(&configuration).map_err(|e| e.to_string())?;
    // Preferences and the open-file list are committed as one snapshot.
    state
        .connection()?
        .execute(
            "INSERT INTO configuration(id, snapshot) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot",
            params![serialized],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn system_fonts() -> Vec<String> {
    use std::collections::BTreeSet;
    use windows::Win32::{
        Foundation::LPARAM,
        Graphics::Gdi::{
            EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
        },
    };

    unsafe extern "system" fn collect(
        font: *const LOGFONTW,
        _: *const TEXTMETRICW,
        _: u32,
        context: LPARAM,
    ) -> i32 {
        // GDI enumerates synchronously, so this pointer is valid during every callback.
        let fonts = unsafe { &mut *(context.0 as *mut BTreeSet<String>) };
        let name = unsafe { &(*font).lfFaceName };
        let end = name
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(name.len());
        let name = String::from_utf16_lossy(&name[..end]);
        if !name.is_empty() && !name.starts_with('@') {
            fonts.insert(name);
        }
        1
    }

    let mut fonts = BTreeSet::<String>::new();
    let filter = LOGFONTW {
        lfCharSet: DEFAULT_CHARSET,
        ..Default::default()
    };
    unsafe {
        let dc = GetDC(None);
        if !dc.is_invalid() {
            let context = LPARAM((&mut fonts as *mut BTreeSet<String>) as isize);
            EnumFontFamiliesExW(dc, &filter, Some(collect), context, 0);
            ReleaseDC(None, dc);
        }
    }
    fonts.into_iter().collect()
}

#[cfg(not(windows))]
#[tauri::command]
pub fn system_fonts() -> Vec<String> {
    Vec::new()
}
