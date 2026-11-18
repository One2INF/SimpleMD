#[cfg(windows)]
#[tauri::command]
pub async fn print_pdf(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::files::Documents>,
    path: String,
) -> Result<(), String> {
    use crate::files::{check_pdf, finish_pdf, pdf_target, pdf_temp_path};
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7},
        PrintToPdfCompletedHandler,
    };
    use windows_core::{Interface, PCWSTR};

    let (path, temp) = pdf_target(&path)?;
    check_pdf(&state, &path)?;
    let target: Vec<u16> = pdf_temp_path(&temp).encode_utf16().chain([0]).collect();
    let (tx, mut rx) = tauri::async_runtime::channel(1);

    // WebView2's COM objects belong to the UI thread. Only send the result back.
    window
        .with_webview(move |view| {
            let completed = tx.clone();
            let result = unsafe {
                (|| -> windows_core::Result<()> {
                    let browser: ICoreWebView2_7 = view.controller().CoreWebView2()?.cast()?;
                    let environment: ICoreWebView2Environment6 = view.environment().cast()?;
                    let settings = environment.CreatePrintSettings()?;
                    settings.SetPageWidth(210.0 / 25.4)?;
                    settings.SetPageHeight(297.0 / 25.4)?;
                    settings.SetMarginTop(16.0 / 25.4)?;
                    settings.SetMarginBottom(16.0 / 25.4)?;
                    settings.SetMarginLeft(16.0 / 25.4)?;
                    settings.SetMarginRight(16.0 / 25.4)?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    let callback =
                        PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                            let result = status.map_err(|e| e.to_string()).and_then(|_| {
                                if success {
                                    Ok(())
                                } else {
                                    Err("WebView2 未能生成 PDF".into())
                                }
                            });
                            let _ = completed.try_send(result);
                            Ok(())
                        }));
                    browser.PrintToPdf(PCWSTR(target.as_ptr()), &settings, &callback)
                })()
            };
            if let Err(error) = result {
                let _ = tx.try_send(Err(error.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;

    rx.recv().await.ok_or("PDF 打印已中断")??;
    finish_pdf(&state, &path, temp)
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn print_pdf(path: String) -> Result<(), String> {
    let _ = path;
    Err("PDF 导出需要 Windows WebView2".to_string())
}
