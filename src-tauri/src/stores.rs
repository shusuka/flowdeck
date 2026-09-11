//! Local JSON storage for accounts and the prompt library.
use std::{fs, path::PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};
use uuid::Uuid;

fn data_file<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(name, BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())
}

fn write_json<R: Runtime>(app: &AppHandle<R>, name: &str, value: &[u8]) -> Result<(), String> {
    let file = data_file(app, name)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, value).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

// ---- Accounts --------------------------------------------------------------
#[tauri::command]
pub fn load_accounts<R: Runtime>(app: AppHandle<R>) -> Result<Option<serde_json::Value>, String> {
    let file = data_file(&app, "accounts.json")?;
    if !file.exists() {
        return Ok(None);
    }
    serde_json::from_str(&fs::read_to_string(file).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_accounts<R: Runtime>(
    app: AppHandle<R>,
    accounts: serde_json::Value,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&accounts).map_err(|e| e.to_string())?;
    write_json(&app, "accounts.json", &bytes)
}

// ---- Prompts ---------------------------------------------------------------
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

fn read_prompts<R: Runtime>(app: &AppHandle<R>) -> Vec<Prompt> {
    let Ok(file) = data_file(app, "prompts.json") else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(file) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<Prompt>>(&raw).unwrap_or_default()
}

fn write_prompts<R: Runtime>(app: &AppHandle<R>, items: &[Prompt]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
    write_json(app, "prompts.json", &bytes)
}

fn clean(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

#[tauri::command]
pub fn list_prompts<R: Runtime>(app: AppHandle<R>) -> Vec<Prompt> {
    read_prompts(&app)
}

#[tauri::command]
pub fn create_prompt<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    prompt: String,
    category: String,
) -> Result<Prompt, String> {
    let title = clean(&title, 200);
    let prompt = clean(&prompt, 100_000);
    if title.is_empty() || prompt.is_empty() {
        return Err("title and prompt are required".into());
    }
    let now = Utc::now().to_rfc3339();
    let item = Prompt {
        id: Uuid::new_v4().to_string(),
        title,
        prompt,
        category: clean(&category, 100),
        pinned: false,
        created_at: now.clone(),
        updated_at: now,
    };
    let mut items = read_prompts(&app);
    items.push(item.clone());
    write_prompts(&app, &items)?;
    Ok(item)
}

#[tauri::command]
pub fn update_prompt<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    title: String,
    prompt: String,
    category: String,
) -> Result<Prompt, String> {
    let mut items = read_prompts(&app);
    let item = items
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or("prompt not found")?;
    let title = clean(&title, 200);
    let prompt = clean(&prompt, 100_000);
    if !title.is_empty() {
        item.title = title;
    }
    if !prompt.is_empty() {
        item.prompt = prompt;
    }
    item.category = clean(&category, 100);
    item.updated_at = Utc::now().to_rfc3339();
    let result = item.clone();
    write_prompts(&app, &items)?;
    Ok(result)
}

#[tauri::command]
pub fn delete_prompt<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let items: Vec<Prompt> = read_prompts(&app).into_iter().filter(|p| p.id != id).collect();
    write_prompts(&app, &items)
}

#[tauri::command]
pub fn toggle_prompt_pinned<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Vec<Prompt>, String> {
    let mut items = read_prompts(&app);
    if let Some(item) = items.iter_mut().find(|p| p.id == id) {
        item.pinned = !item.pinned;
        item.updated_at = Utc::now().to_rfc3339();
    }
    write_prompts(&app, &items)?;
    Ok(items)
}
