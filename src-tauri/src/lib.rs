mod commands;
mod logging;
mod models;
mod services;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();
    app_state.ensure_dirs().expect("Failed to create app directories");
    logging::init(&app_state.data_dir);
    logging::info("Application starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_mic_recorder::init())
        .manage(app_state)
        .setup(|app| {
            // Grant microphone permission on Linux (WebKitGTK)
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{WebViewExt, SettingsExt, PermissionRequestExt, PermissionRequest};
                if let Some(window) = app.get_webview_window("main") {
                    match window.with_webview(|webview| {
                        let wv = webview.inner();
                        if let Some(settings) = wv.settings() {
                            settings.set_enable_media(true);
                            settings.set_enable_media_stream(true);
                            settings.set_enable_media_capabilities(true);
                            logging::info("WebKitGTK: media stream settings enabled");
                        } else {
                            logging::error("WebKitGTK: failed to get settings");
                        }
                        wv.connect_permission_request(|_, request: &PermissionRequest| {
                            logging::info("WebKitGTK: auto-granting permission request");
                            request.allow();
                            true
                        });
                    }) {
                        Ok(_) => logging::info("WebKitGTK: webview media setup complete"),
                        Err(e) => logging::error(&format!("WebKitGTK: with_webview failed: {}", e)),
                    }
                } else {
                    logging::error("WebKitGTK: could not find main window for media setup");
                }
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::agent::auto_start_agent(handle.clone()).await;
                commands::calendar::auto_sync_calendar(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Storage
            commands::storage::load_day,
            commands::storage::get_days_range,
            commands::storage::get_month_range,
            commands::storage::get_days_range_offset,
            commands::storage::save_todo,
            commands::storage::update_todo,
            commands::storage::delete_todo,
            commands::storage::load_spec,
            commands::storage::save_spec,
            commands::storage::load_backlog,
            commands::storage::add_backlog_item,
            commands::storage::update_backlog_item,
            commands::storage::delete_backlog_item,
            commands::storage::load_backlog_spec,
            commands::storage::save_backlog_spec,
            commands::storage::move_backlog_to_day,
            // Theme
            commands::theme::get_theme,
            commands::theme::set_theme,
            // heyvm
            commands::heyvm::create_vm,
            commands::heyvm::start_vm,
            commands::heyvm::stop_vm,
            commands::heyvm::vm_status,
            commands::heyvm::snapshot_vm,
            commands::heyvm::list_sandboxes,
            // Agent
            commands::agent::setup_agent,
            commands::agent::start_agent,
            commands::agent::stop_agent,
            commands::agent::update_agent,
            commands::agent::send_message,
            commands::agent::agent_status,
            commands::agent::get_chat_history,
            // Artifacts
            commands::artifacts::list_artifacts,
            commands::artifacts::list_all_artifacts,
            commands::artifacts::read_artifact,
            commands::artifacts::save_artifact,
            commands::artifacts::delete_artifact,
            commands::artifacts::create_artifact_folder,
            commands::artifacts::rename_artifact,
            commands::artifacts::move_artifact,
            commands::artifacts::list_artifact_folders,
            // Config
            commands::config::get_agent_config,
            commands::config::set_agent_config,
            commands::config::get_status_info,
            commands::config::get_recent_logs,
            // Calendar
            commands::calendar::get_calendar_config,
            commands::calendar::set_calendar_config,
            commands::calendar::get_calendar_status,
            commands::calendar::connect_google_calendar,
            commands::calendar::disconnect_google_calendar,
            commands::calendar::fetch_calendar_events,
            commands::calendar::sync_calendar_to_todos,
            // Speech
            commands::speech::transcribe_audio,
            commands::speech::transcribe_file,
            commands::speech::speak_text,
            commands::speech::describe_image,
            // Deploy
            commands::deploy::deploy_agent,
            commands::deploy::connect_remote,
            commands::deploy::disconnect_remote,
            commands::deploy::teardown_deploy,
            commands::deploy::get_deployment_info,
            // Lists
            commands::lists::list_lists,
            commands::lists::load_list,
            commands::lists::create_list,
            commands::lists::update_list_meta,
            commands::lists::delete_list,
            commands::lists::add_list_item,
            commands::lists::update_list_item,
            commands::lists::delete_list_item,
            // Books
            commands::books::list_books,
            commands::books::load_book,
            commands::books::create_book,
            commands::books::delete_book,
            commands::books::add_page,
            commands::books::load_page,
            commands::books::save_page,
            commands::books::update_page_meta,
            commands::books::reorder_pages,
            commands::books::delete_page,
            // Links (bidirectional todo <-> list item / book page)
            commands::links::link_todo_to_list_item,
            commands::links::unlink_todo_from_list_item,
            commands::links::link_todo_to_book_page,
            commands::links::unlink_todo_from_book_page,
            commands::links::create_page_from_todo,
            commands::links::create_list_item_from_todo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
