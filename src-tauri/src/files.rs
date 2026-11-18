use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;
use tempfile::NamedTempFile;

#[derive(Default)]
pub struct Documents(Mutex<HashMap<String, PathBuf>>);

type Result<T> = std::result::Result<T, String>;

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["md", "markdown", "mdown", "mkd", "mkdn", "txt", "mdx"]
                .iter()
                .any(|item| ext.eq_ignore_ascii_case(item))
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    id: String,
    path: String,
    text: String,
}

fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn target_path(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("请选择绝对路径".into());
    }
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Canonicalize the parent so aliases and junctions compare consistently.
            let name = path.file_name().ok_or("无效的文件名")?;
            let parent = path.parent().ok_or("无效的文件目录")?;
            Ok(parent.canonicalize().map_err(fail)?.join(name))
        }
        Err(error) => Err(fail(error)),
    }
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn same_source(left: &Path, right: &Path) -> bool {
    let identical = if cfg!(windows) {
        display_path(left).to_lowercase() == display_path(right).to_lowercase()
    } else {
        left == right
    };
    let current_right = right.canonicalize().ok();
    identical
        || current_right.as_deref() == Some(left)
        || same_file::is_same_file(left, right).unwrap_or(false)
}

#[tauri::command]
pub fn open_document(state: State<'_, Documents>, id: String, path: String) -> Result<Opened> {
    let mut files = state.0.lock().map_err(fail)?;
    let path = target_path(&path)?;
    if let Some((existing, source)) = files.iter().find(|(_, source)| same_source(&path, source)) {
        return Ok(Opened {
            id: existing.clone(),
            path: display_path(source),
            text: String::new(),
        });
    }
    let text = fs::read_to_string(&path).map_err(fail)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
    let display = display_path(&path);
    files.insert(id.clone(), path);
    Ok(Opened {
        id,
        path: display,
        text,
    })
}

#[tauri::command]
pub fn close_document(state: State<'_, Documents>, id: String) -> Result<()> {
    state.0.lock().map_err(fail)?.remove(&id);
    Ok(())
}

fn sibling_path(doc: &Path, relative: &Path) -> Result<PathBuf> {
    if relative.has_root()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::Prefix(_)))
    {
        return Err("请使用相对文档的路径".into());
    }
    Ok(doc.parent().ok_or("文档目录不存在")?.join(relative))
}

#[tauri::command]
pub fn resolve_document_link(
    state: State<'_, Documents>,
    id: String,
    relative: String,
) -> Result<String> {
    let files = state.0.lock().map_err(fail)?;
    let doc = files.get(&id).ok_or("请先保存文档")?;
    let path = Path::new(&relative);
    if !is_markdown(path) {
        return Err("此链接指向其他文件类型".into());
    }
    Ok(display_path(&sibling_path(doc, path)?))
}

fn persist(temp: NamedTempFile, path: &Path) -> Result<()> {
    temp.as_file().sync_all().map_err(fail)?;
    temp.persist(path).map_err(fail)?;
    Ok(())
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp = NamedTempFile::new_in(path.parent().ok_or("无效的文件目录")?).map_err(fail)?;
    temp.write_all(bytes).map_err(fail)?;
    persist(temp, path)
}

fn check_open_sources(
    files: &HashMap<String, PathBuf>,
    path: &Path,
    owner: Option<&str>,
) -> Result<()> {
    if files
        .iter()
        .any(|(id, source)| Some(id.as_str()) != owner && same_source(path, source))
    {
        return Err("目标文件是已打开文档的来源文件，请选择其他路径。".into());
    }
    Ok(())
}

#[tauri::command]
pub fn save_document(
    state: State<'_, Documents>,
    id: String,
    path: String,
    text: String,
) -> Result<String> {
    // Hold the same lock used to register files through the final rename.
    let mut files = state.0.lock().map_err(fail)?;
    let path = target_path(&path)?;
    check_open_sources(&files, &path, Some(&id))?;
    write_file(&path, text.as_bytes())?;
    let display = display_path(&path);
    files.insert(id, path);
    Ok(display)
}

#[tauri::command]
pub fn write_export(request: tauri::ipc::Request<'_>, state: State<'_, Documents>) -> Result<()> {
    let path = request
        .headers()
        .get("x-simplemd-path")
        .ok_or("缺少导出路径")?;
    let path = decode_text(path.to_str().map_err(fail)?)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("缺少导出数据".into());
    };
    let files = state.0.lock().map_err(fail)?;
    let path = target_path(&path)?;
    check_open_sources(&files, &path, None)?;
    write_file(&path, bytes)
}

fn decode_text(encoded: &str) -> Result<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    String::from_utf8(STANDARD.decode(encoded).map_err(fail)?).map_err(fail)
}

#[cfg(windows)]
pub fn pdf_target(path: &str) -> Result<(PathBuf, tempfile::TempPath)> {
    let path = target_path(path)?;
    let temp =
        NamedTempFile::with_suffix_in(".pdf", path.parent().ok_or("无效的目录")?).map_err(fail)?;
    Ok((path, temp.into_temp_path()))
}

#[cfg(windows)]
pub fn check_pdf(state: &Documents, path: &Path) -> Result<()> {
    let files = state.0.lock().map_err(fail)?;
    check_open_sources(&files, path, None)
}

#[cfg(windows)]
pub fn finish_pdf(state: &Documents, path: &Path, temp: tempfile::TempPath) -> Result<()> {
    let files = state.0.lock().map_err(fail)?;
    let path = target_path(&display_path(path))?;
    check_open_sources(&files, &path, None)?;
    let mut signature = [0; 5];
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temp)
        .map_err(fail)?;
    file.read_exact(&mut signature).map_err(fail)?;
    file.sync_all().map_err(fail)?;
    drop(file);
    if &signature != b"%PDF-" {
        return Err("生成的文件不是有效的 PDF".into());
    }
    temp.persist(&path).map_err(fail)?;
    Ok(())
}

pub fn pdf_temp_path(path: &Path) -> String {
    display_path(path)
}

fn image_mime(data: &[u8]) -> Result<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("image/png");
    }
    if data.starts_with(b"\xff\xd8\xff") {
        return Ok("image/jpeg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Ok("image/gif");
    }
    if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        return Ok("image/webp");
    }
    if data.starts_with(b"BM") {
        return Ok("image/bmp");
    }
    if data.get(4..12) == Some(b"ftypavif") || data.get(4..12) == Some(b"ftypavis") {
        return Ok("image/avif");
    }
    if let Ok(xml) = std::str::from_utf8(data) {
        let xml = xml.trim_start_matches('\u{feff}').trim_start();
        if xml.starts_with("<svg") || (xml.starts_with("<?xml") && xml.contains("<svg")) {
            return Ok("image/svg+xml");
        }
    }
    Err("不支持此图片格式".into())
}

#[tauri::command]
pub async fn image_data(state: State<'_, Documents>, id: String, source: String) -> Result<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    const LIMIT: u64 = 24 * 1024 * 1024;
    let base = state.0.lock().map_err(fail)?.get(&id).cloned();
    tauri::async_runtime::spawn_blocking(move || {
        let reader: Box<dyn Read> =
            if source.starts_with("https://") || source.starts_with("http://") {
                let response = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(15))
                    .redirect(reqwest::redirect::Policy::limited(4))
                    .build()
                    .map_err(fail)?
                    .get(&source)
                    .send()
                    .map_err(fail)?
                    .error_for_status()
                    .map_err(fail)?;
                Box::new(response)
            } else {
                let doc = base.ok_or("文档保存后才能解析相对图片路径")?;
                let path = sibling_path(&doc, Path::new(&source))?;
                Box::new(fs::File::open(path).map_err(fail)?)
            };
        let mut bytes = Vec::new();
        reader
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(fail)?;
        if bytes.len() as u64 > LIMIT {
            return Err("单张图片超过 24 MB".into());
        }
        let mime = image_mime(&bytes)?;
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
    })
    .await
    .map_err(fail)?
}
