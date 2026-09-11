fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "set_view_bounds",
                "open_view",
                "hide_view",
                "set_view_covered",
                "reload_view",
                "back_view",
                "forward_view",
                "set_view_zoom",
                "unload_view",
                "remove_view",
                "load_accounts",
                "save_accounts",
                "list_prompts",
                "create_prompt",
                "update_prompt",
                "delete_prompt",
                "toggle_prompt_pinned",
            ]),
        ),
    )
    .expect("failed to run Tauri build script")
}
