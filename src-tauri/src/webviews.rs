//! Multi-account child webviews layered over the main window. Each account gets
//! its own isolated WebView2 profile, so many accounts stay logged in at once.
use std::sync::Mutex;

use tauri::webview::WebviewBuilder;
use tauri::{
    path::BaseDirectory, AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

#[derive(Default)]
pub struct WebviewManager {
    active: Mutex<Option<String>>,
    bounds: Mutex<(f64, f64, f64, f64)>,
    open_ids: Mutex<Vec<String>>,
}

fn provider_url(provider: &str) -> &'static str {
    match provider {
        "dola" => "https://www.dola.com/chat/",
        "migoo" => "https://migoo.ai/",
        _ => "https://flow.google",
    }
}

fn label_for(account_id: &str) -> String {
    format!("acc-{account_id}")
}

fn validate_id(account_id: &str) -> Result<(), String> {
    if account_id.is_empty()
        || account_id.len() > 128
        || !account_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid account id".into());
    }
    Ok(())
}

fn profile_dir(app: &AppHandle, account_id: &str) -> Result<std::path::PathBuf, String> {
    let root = app
        .path()
        .resolve("webview-profiles", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())?;
    Ok(root.join(account_id))
}

/// Run a closure on the main (UI) thread and await its result, so webview
/// operations never touch a worker thread.
async fn on_main<F, T>(app: &AppHandle, op: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(op());
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_view_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let a = app.clone();
    on_main(&app, move || {
        let mgr = a.state::<WebviewManager>();
        *mgr.bounds.lock().map_err(|_| "state")? = (x, y, width, height);
        let active = mgr.active.lock().map_err(|_| "state")?.clone();
        if let Some(id) = active {
            if let Some(wv) = a.get_webview(&label_for(&id)) {
                wv.set_position(LogicalPosition::new(x, y))
                    .map_err(|e| e.to_string())?;
                wv.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn open_view(app: AppHandle, account_id: String, provider: String) -> Result<(), String> {
    validate_id(&account_id)?;
    let a = app.clone();
    on_main(&app, move || {
        let mgr = a.state::<WebviewManager>();
        let (x, y, w, h) = *mgr.bounds.lock().map_err(|_| "state")?;
        let (w, h) = (w.max(1.0), h.max(1.0));

        // Hide the previously active webview if it's a different account.
        let previous = mgr.active.lock().map_err(|_| "state")?.clone();
        if let Some(prev) = previous {
            if prev != account_id {
                if let Some(wv) = a.get_webview(&label_for(&prev)) {
                    wv.hide().map_err(|e| e.to_string())?;
                }
            }
        }

        let label = label_for(&account_id);
        if let Some(wv) = a.get_webview(&label) {
            wv.set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            wv.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
            wv.show().map_err(|e| e.to_string())?;
        } else {
            let window = a.get_window("main").ok_or("main window not found")?;
            let profile = profile_dir(&a, &account_id)?;
            let url: tauri::Url = provider_url(&provider)
                .parse()
                .map_err(|_| "invalid provider url")?;
            let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
                .data_directory(profile)
                .on_navigation(|u| u.scheme() == "https" || u.scheme() == "http");
            window
                .add_child(
                    builder,
                    LogicalPosition::new(x, y),
                    LogicalSize::new(w, h),
                )
                .map_err(|e| e.to_string())?;
            mgr.open_ids
                .lock()
                .map_err(|_| "state")?
                .push(account_id.clone());
        }
        *mgr.active.lock().map_err(|_| "state")? = Some(account_id.clone());
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn hide_view(app: AppHandle) -> Result<(), String> {
    let a = app.clone();
    on_main(&app, move || {
        let mgr = a.state::<WebviewManager>();
        let active = mgr.active.lock().map_err(|_| "state")?.clone();
        if let Some(id) = active {
            if let Some(wv) = a.get_webview(&label_for(&id)) {
                wv.hide().map_err(|e| e.to_string())?;
            }
        }
        *mgr.active.lock().map_err(|_| "state")? = None;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn reload_view(app: AppHandle) -> Result<(), String> {
    let a = app.clone();
    on_main(&app, move || {
        let mgr = a.state::<WebviewManager>();
        let active = mgr.active.lock().map_err(|_| "state")?.clone();
        if let Some(id) = active {
            if let Some(wv) = a.get_webview(&label_for(&id)) {
                wv.eval("location.reload()").map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn remove_view(app: AppHandle, account_id: String) -> Result<(), String> {
    validate_id(&account_id)?;
    let a = app.clone();
    on_main(&app, move || {
        let mgr = a.state::<WebviewManager>();
        if let Some(wv) = a.get_webview(&label_for(&account_id)) {
            wv.close().map_err(|e| e.to_string())?;
        }
        mgr.open_ids
            .lock()
            .map_err(|_| "state")?
            .retain(|id| id != &account_id);
        {
            let mut active = mgr.active.lock().map_err(|_| "state")?;
            if active.as_deref() == Some(account_id.as_str()) {
                *active = None;
            }
        }
        if let Ok(dir) = profile_dir(&a, &account_id) {
            let _ = std::fs::remove_dir_all(dir);
        }
        Ok(())
    })
    .await
}
