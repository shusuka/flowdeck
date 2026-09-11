mod stores;
mod webviews;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(webviews::WebviewManager::default())
        .invoke_handler(tauri::generate_handler![
            webviews::set_view_bounds,
            webviews::open_view,
            webviews::hide_view,
            webviews::set_view_covered,
            webviews::reload_view,
            webviews::back_view,
            webviews::forward_view,
            webviews::set_view_zoom,
            webviews::unload_view,
            webviews::remove_view,
            stores::load_accounts,
            stores::save_accounts,
            stores::list_prompts,
            stores::create_prompt,
            stores::update_prompt,
            stores::delete_prompt,
            stores::toggle_prompt_pinned,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlowDeck");
}
