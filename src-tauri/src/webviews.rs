//! Multi-account child webviews layered over the main window. Each account gets
//! its own isolated WebView2 profile, so many accounts stay logged in at once.
//! All provider webviews of one account share that profile, so a Google login
//! made in Flow is reused by Dola and Migoo (their Google sign-in is one click).
use std::sync::Mutex;

use tauri::webview::WebviewBuilder;
use tauri::{
    path::BaseDirectory, AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl,
};

#[derive(Default)]
pub struct WebviewManager {
    /// Label of the webview shown in the content area.
    active: Mutex<Option<String>>,
    /// True while the UI shows a modal: the active webview is hidden so the
    /// modal underneath is visible and clickable.
    covered: Mutex<bool>,
    bounds: Mutex<(f64, f64, f64, f64)>,
    /// (account id, webview label) of every webview created so far.
    open: Mutex<Vec<(String, String)>>,
}

fn provider_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "google-flow" => Ok("https://flow.google"),
        "dola" => Ok("https://www.dola.com/chat/"),
        "migoo" => Ok("https://migoo.ai/"),
        _ => Err("unknown provider".into()),
    }
}

fn label_for(account_id: &str, provider: &str) -> String {
    format!("acc-{account_id}--{provider}")
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

fn active_webview(app: &AppHandle) -> Result<Option<Webview>, String> {
    let mgr = app.state::<WebviewManager>();
    let active = mgr.active.lock().map_err(|_| "state")?.clone();
    Ok(active.and_then(|label| app.get_webview(&label)))
}

fn place(wv: &Webview, (x, y, w, h): (f64, f64, f64, f64)) -> Result<(), String> {
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())
}

fn place_and_show(wv: &Webview, bounds: (f64, f64, f64, f64)) -> Result<(), String> {
    place(wv, bounds)?;
    wv.show().map_err(|e| e.to_string())?;
    // Give keyboard focus to the page so its text fields respond right away.
    let _ = wv.set_focus();
    Ok(())
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
        if let Some(wv) = active_webview(&a)? {
            place(&wv, (x, y, width, height))?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn open_view(app: AppHandle, account_id: String, provider: String) -> Result<(), String> {
    validate_id(&account_id)?;
    let url: tauri::Url = provider_url(&provider)?
        .parse()
        .map_err(|_| "invalid provider url")?;
    let a = app.clone();
    on_main(&app, move || {
        let mgr = a.state::<WebviewManager>();
        let bounds = *mgr.bounds.lock().map_err(|_| "state")?;
        let covered = *mgr.covered.lock().map_err(|_| "state")?;
        let label = label_for(&account_id, &provider);

        // Hide the previously active webview if it's a different one.
        let previous = mgr.active.lock().map_err(|_| "state")?.clone();
        if let Some(prev) = previous.filter(|p| p != &label) {
            if let Some(wv) = a.get_webview(&prev) {
                wv.hide().map_err(|e| e.to_string())?;
            }
        }

        let wv = match a.get_webview(&label) {
            Some(wv) => wv,
            None => {
                let window = a.get_window("main").ok_or("main window not found")?;
                // The profile is per account, not per provider: that is what
                // shares the login between Flow, Dola and Migoo.
                let profile = profile_dir(&a, &account_id)?;
                let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
                    .data_directory(profile)
                    .on_navigation(|u| u.scheme() == "https" || u.scheme() == "http");
                let (x, y, w, h) = bounds;
                let wv = window
                    .add_child(
                        builder,
                        LogicalPosition::new(x, y),
                        LogicalSize::new(w.max(1.0), h.max(1.0)),
                    )
                    .map_err(|e| e.to_string())?;
                mgr.open
                    .lock()
                    .map_err(|_| "state")?
                    .push((account_id.clone(), label.clone()));
                wv
            }
        };
        if covered {
            wv.hide().map_err(|e| e.to_string())?;
        } else {
            place_and_show(&wv, bounds)?;
        }
        *mgr.active.lock().map_err(|_| "state")? = Some(label);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn hide_view(app: AppHandle) -> Result<(), String> {
    let a = app.clone();
    on_main(&app, move || {
        if let Some(wv) = active_webview(&a)? {
            wv.hide().map_err(|e| e.to_string())?;
        }
        *a.state::<WebviewManager>()
            .active
            .lock()
            .map_err(|_| "state")? = None;
        Ok(())
    })
    .await
}

/// Temporarily hide (covered = true) or restore the active webview, so HTML
/// modals of the main UI are not painted underneath the native webview.
#[tauri::command]
pub async fn set_view_covered(app: AppHandle, covered: bool) -> Result<(), String> {
    let a = app.clone();
    on_main(&app, move || {
        let mgr = a.state::<WebviewManager>();
        *mgr.covered.lock().map_err(|_| "state")? = covered;
        let bounds = *mgr.bounds.lock().map_err(|_| "state")?;
        if let Some(wv) = active_webview(&a)? {
            if covered {
                wv.hide().map_err(|e| e.to_string())?;
            } else {
                place_and_show(&wv, bounds)?;
            }
        }
        Ok(())
    })
    .await
}

async fn eval_active(app: AppHandle, script: &'static str) -> Result<(), String> {
    let a = app.clone();
    on_main(&app, move || {
        if let Some(wv) = active_webview(&a)? {
            wv.eval(script).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn reload_view(app: AppHandle) -> Result<(), String> {
    eval_active(app, "location.reload()").await
}

#[tauri::command]
pub async fn back_view(app: AppHandle) -> Result<(), String> {
    eval_active(app, "history.back()").await
}

#[tauri::command]
pub async fn forward_view(app: AppHandle) -> Result<(), String> {
    eval_active(app, "history.forward()").await
}

#[tauri::command]
pub async fn set_view_zoom(app: AppHandle, factor: f64) -> Result<(), String> {
    if !(0.25..=3.0).contains(&factor) {
        return Err("invalid zoom".into());
    }
    let a = app.clone();
    on_main(&app, move || {
        if let Some(wv) = active_webview(&a)? {
            wv.set_zoom(factor).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

fn close_labels(app: &AppHandle, labels: &[String]) -> Result<(), String> {
    let mgr = app.state::<WebviewManager>();
    for label in labels {
        if let Some(wv) = app.get_webview(label) {
            wv.close().map_err(|e| e.to_string())?;
        }
    }
    mgr.open
        .lock()
        .map_err(|_| "state")?
        .retain(|(_, label)| !labels.contains(label));
    let mut active = mgr.active.lock().map_err(|_| "state")?;
    if active.as_ref().is_some_and(|label| labels.contains(label)) {
        *active = None;
    }
    Ok(())
}

/// Close one provider webview of an account. Its login profile is kept.
#[tauri::command]
pub async fn unload_view(app: AppHandle, account_id: String, provider: String) -> Result<(), String> {
    validate_id(&account_id)?;
    provider_url(&provider)?;
    let a = app.clone();
    on_main(&app, move || close_labels(&a, &[label_for(&account_id, &provider)])).await
}

/// Close every webview of an account and delete its login profile.
#[tauri::command]
pub async fn remove_view(app: AppHandle, account_id: String) -> Result<(), String> {
    validate_id(&account_id)?;
    let a = app.clone();
    on_main(&app, move || {
        let labels: Vec<String> = a
            .state::<WebviewManager>()
            .open
            .lock()
            .map_err(|_| "state")?
            .iter()
            .filter(|(id, _)| id == &account_id)
            .map(|(_, label)| label.clone())
            .collect();
        close_labels(&a, &labels)?;
        if let Ok(dir) = profile_dir(&a, &account_id) {
            // WebView2 releases the profile's files a moment after its
            // webviews close, so retry the delete for a few seconds.
            std::thread::spawn(move || {
                for _ in 0..20 {
                    if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            });
        }
        Ok(())
    })
    .await
}
