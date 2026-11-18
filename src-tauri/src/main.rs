#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod pdf;
mod settings;

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
struct StartupFiles(Mutex<Vec<String>>);

fn collect_paths(args: impl IntoIterator<Item = std::ffi::OsString>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| files::is_markdown(path))
        .map(|path| cwd.join(path).to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
fn take_startup_files(state: State<'_, StartupFiles>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut files| std::mem::take(&mut *files))
        .unwrap_or_default()
}

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let args = collect_paths(std::env::args_os(), &cwd);
    let builder = tauri::Builder::default().manage(StartupFiles(Mutex::new(args)));

    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let added = collect_paths(args.into_iter().map(Into::into), Path::new(&cwd));
        if !added.is_empty() {
            if let Ok(mut files) = app.state::<StartupFiles>().0.lock() {
                files.extend(added);
            }
            let _ = app.emit("simplemd-open-files", ());
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(files::Documents::default())
        .setup(|app| {
            app.manage(settings::Configuration::new(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_startup_files,
            files::open_document,
            files::resolve_document_link,
            files::close_document,
            files::save_document,
            files::write_export,
            files::image_data,
            settings::load_configuration,
            settings::save_configuration,
            settings::system_fonts,
            pdf::print_pdf
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SimpleMD");
}
