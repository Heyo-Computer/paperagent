use tauri::{AppHandle, State, Manager, Emitter};
use crate::services::calendar as cal;
use crate::services::storage;
use crate::state::AppState;
use crate::logging;

/// How many days of past events to pull into the searchable cache. The window
/// slides forward each sync, and `storage::save_calendar_events` merges rather than
/// overwrites, so the cache keeps accumulating history beyond this bound over time.
const PAST_LOOKBACK_DAYS: i64 = 90;
/// How many days ahead to fetch (and sync onto the todo list).
const FUTURE_DAYS: i64 = 30;

#[tauri::command]
pub fn get_calendar_config(state: State<AppState>) -> cal::CalendarConfig {
    cal::CalendarConfig::load(&state.config_dir)
}

#[tauri::command]
pub fn set_calendar_config(config: cal::CalendarConfig, state: State<AppState>) -> Result<(), String> {
    config.save(&state.config_dir)
}

#[tauri::command]
pub fn get_calendar_status(state: State<AppState>) -> serde_json::Value {
    let config = cal::CalendarConfig::load(&state.config_dir);
    let tokens = cal::CalendarTokens::load(&state.config_dir);

    serde_json::json!({
        "configured": !config.client_id.is_empty(),
        "connected": tokens.has_refresh(),
        "token_valid": tokens.is_valid(),
        "enabled": config.enabled,
    })
}

/// Start the OAuth flow: opens the browser and waits for the callback.
#[tauri::command]
pub async fn connect_google_calendar(
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let config = cal::CalendarConfig::load(&state.config_dir);
    if config.client_id.is_empty() || config.client_secret.is_empty() {
        return Err("Set Google OAuth Client ID and Client Secret in settings first.".to_string());
    }

    let url = cal::auth_url(&config.client_id);
    logging::info(&format!("calendar: opening auth URL"));

    // Open browser
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _ = open::that(&url);
    }).await;

    // Wait for callback
    let code = cal::wait_for_auth_code().await?;

    // Exchange for tokens
    let tokens = cal::exchange_code(&config.client_id, &config.client_secret, &code).await?;
    tokens.save(&state.config_dir)?;

    logging::info("calendar: OAuth complete, tokens saved");
    Ok("Google Calendar connected.".to_string())
}

#[tauri::command]
pub async fn disconnect_google_calendar(state: State<'_, AppState>) -> Result<(), String> {
    let empty = cal::CalendarTokens::default();
    empty.save(&state.config_dir)?;
    logging::info("calendar: disconnected");
    Ok(())
}

/// Fetch upcoming events for the next 30 days (without syncing to todos).
#[tauri::command]
pub async fn fetch_calendar_events(
    state: State<'_, AppState>,
) -> Result<Vec<cal::CalendarEvent>, String> {
    let tokens = ensure_valid_token(&state).await?;
    let config = cal::CalendarConfig::load(&state.config_dir);
    cal::fetch_events_range(&tokens.access_token, &config.calendar_id, 0, 30).await
}

/// Sync the next 30 days of calendar events into the todo list.
/// For events with a meeting URL, also generate a markdown spec on the new todo.
#[tauri::command]
pub async fn sync_calendar_to_todos(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let config = cal::CalendarConfig::load(&state.config_dir);
    if !config.enabled || config.client_id.is_empty() {
        return Ok("Calendar sync not enabled.".to_string());
    }

    let tokens = match ensure_valid_token(&state).await {
        Ok(t) => t,
        Err(e) => {
            logging::warn(&format!("calendar sync: token error: {}", e));
            return Err(e);
        }
    };

    let events = cal::fetch_events_range(
        &tokens.access_token,
        &config.calendar_id,
        -PAST_LOOKBACK_DAYS,
        FUTURE_DAYS,
    )
    .await?;

    // Cache the full window (past + upcoming) so the agent's search can index past meetings.
    if let Err(e) = storage::save_calendar_events(&state.data_dir, &events) {
        logging::warn(&format!("calendar sync: failed to cache events: {}", e));
    }

    // Only add upcoming events to the todo list — don't backfill past meetings as todos.
    let upcoming = upcoming_events(&events);
    let added = sync_events_to_storage(&state.storage_root, &upcoming);

    let msg = format!("Synced {} events, added {} new todos.", events.len(), added);
    logging::info(&format!("calendar: {}", msg));
    Ok(msg)
}

/// Group events by date and add them as todos. Generates a spec for each event with a meeting URL.
/// Returns the number of todos added.
fn sync_events_to_storage(storage_root: &std::path::Path, events: &[cal::CalendarEvent]) -> usize {
    use std::collections::HashMap;

    // Group events by date (YYYY-MM-DD)
    let mut by_date: HashMap<String, Vec<&cal::CalendarEvent>> = HashMap::new();
    for event in events {
        if let Some(date) = event_date(event) {
            by_date.entry(date).or_default().push(event);
        }
    }

    let mut added_total = 0;
    for (date, day_events) in by_date {
        let day = storage::load_day(storage_root, &date);
        let existing_titles: Vec<String> = day.todos.iter().map(|t| t.title.clone()).collect();

        for event in day_events {
            let title = format_event_title(event);
            if existing_titles.contains(&title) {
                continue;
            }
            match storage::add_todo(storage_root, &date, &title) {
                Ok(entry) => {
                    added_total += 1;
                    // If this event has a meeting URL, generate a spec for the new todo (last one in entry)
                    if !event.meeting_url.is_empty() {
                        if let Some(new_todo) = entry.todos.last() {
                            let spec = render_event_spec(event);
                            if let Err(e) = storage::save_spec(storage_root, &date, &new_todo.id, &spec) {
                                logging::warn(&format!("calendar sync: failed to save spec for {}: {}", new_todo.id, e));
                                continue;
                            }
                            // Mark has_spec=true on the todo
                            let mut updated = new_todo.clone();
                            updated.has_spec = true;
                            let _ = storage::update_todo(storage_root, &date, updated);
                        }
                    }
                }
                Err(e) => {
                    logging::warn(&format!("calendar sync: failed to add todo for {}: {}", date, e));
                }
            }
        }
    }

    added_total
}

/// Filter a fetched window down to today-or-later events. Used to keep the past
/// portion of the cache out of the todo list (we cache the past for search, but
/// don't want to materialize old meetings as todos).
fn upcoming_events(events: &[cal::CalendarEvent]) -> Vec<cal::CalendarEvent> {
    let today = chrono::Local::now().date_naive().to_string();
    events
        .iter()
        .filter(|e| event_date(e).map_or(false, |d| d >= today))
        .cloned()
        .collect()
}

/// Extract YYYY-MM-DD from a calendar event's start_time. Returns None if start_time is empty
/// or unparseable. All-day events use a "date" field which is already YYYY-MM-DD.
fn event_date(event: &cal::CalendarEvent) -> Option<String> {
    if event.start_time.is_empty() {
        return None;
    }
    // Format is either "2026-04-09" (all-day) or "2026-04-09T10:00:00-06:00" (timed)
    let date_part = event.start_time.split('T').next()?;
    if date_part.len() == 10 {
        Some(date_part.to_string())
    } else {
        None
    }
}

/// Render a markdown spec for a calendar event.
fn render_event_spec(event: &cal::CalendarEvent) -> String {
    let mut s = String::new();
    s.push_str(&format!("# {}\n\n", event.summary));
    if !event.start_time.is_empty() || !event.end_time.is_empty() {
        s.push_str(&format!("**When**: {} - {}\n", event.start_time, event.end_time));
    }
    if !event.location.is_empty() {
        s.push_str(&format!("**Where**: {}\n", event.location));
    }
    if !event.meeting_url.is_empty() {
        s.push_str(&format!("**Meeting link**: {}\n", event.meeting_url));
    }
    if !event.attendees.is_empty() {
        s.push_str("\n**Attendees**:\n");
        for a in &event.attendees {
            s.push_str(&format!("- {}\n", a));
        }
    }
    if !event.description.is_empty() {
        s.push_str("\n---\n\n");
        s.push_str(&event.description);
        s.push('\n');
    }
    s
}

/// Called from startup hook — sync silently if configured.
pub async fn auto_sync_calendar(app: AppHandle) {
    let state = app.state::<AppState>();
    let config = cal::CalendarConfig::load(&state.config_dir);
    if !config.enabled || config.client_id.is_empty() {
        return;
    }

    let tokens = cal::CalendarTokens::load(&state.config_dir);
    if !tokens.has_refresh() {
        logging::info("calendar auto-sync: no refresh token, skipping");
        return;
    }

    logging::info("calendar auto-sync: starting");

    // Ensure valid token
    let access_token = if tokens.is_valid() {
        tokens.access_token.clone()
    } else {
        match cal::refresh_access_token(&config.client_id, &config.client_secret, &tokens.refresh_token).await {
            Ok(new_tokens) => {
                let token = new_tokens.access_token.clone();
                let _ = new_tokens.save(&state.config_dir);
                token
            }
            Err(e) => {
                logging::warn(&format!("calendar auto-sync: refresh failed: {}", e));
                return;
            }
        }
    };

    match cal::fetch_events_range(
        &access_token,
        &config.calendar_id,
        -PAST_LOOKBACK_DAYS,
        FUTURE_DAYS,
    )
    .await
    {
        Ok(events) => {
            // Cache the full window (past + upcoming) so search can index past meetings.
            if let Err(e) = storage::save_calendar_events(&state.data_dir, &events) {
                logging::warn(&format!("calendar auto-sync: failed to cache events: {}", e));
            }

            // Only add upcoming events as todos — don't backfill past meetings.
            let upcoming = upcoming_events(&events);
            let added = sync_events_to_storage(&state.storage_root, &upcoming);
            if added > 0 {
                logging::info(&format!("calendar auto-sync: added {} events as todos", added));
                let _ = app.emit("calendar-synced", added);
            } else {
                logging::info("calendar auto-sync: no new events");
            }
        }
        Err(e) => {
            logging::warn(&format!("calendar auto-sync: fetch failed: {}", e));
        }
    }
}

// ── Helpers ──

async fn ensure_valid_token(state: &AppState) -> Result<cal::CalendarTokens, String> {
    let config = cal::CalendarConfig::load(&state.config_dir);
    let tokens = cal::CalendarTokens::load(&state.config_dir);

    if tokens.is_valid() {
        return Ok(tokens);
    }

    if !tokens.has_refresh() {
        return Err("Not connected to Google Calendar. Connect in Settings.".to_string());
    }

    let new_tokens = cal::refresh_access_token(
        &config.client_id,
        &config.client_secret,
        &tokens.refresh_token,
    ).await?;

    new_tokens.save(&state.config_dir)?;
    Ok(new_tokens)
}

fn format_event_title(event: &cal::CalendarEvent) -> String {
    if event.start_time.is_empty() {
        // All-day event
        event.summary.clone()
    } else if let Some(time) = event.start_time.split('T').nth(1) {
        // Timed event — show HH:MM
        let short = &time[..5.min(time.len())];
        format!("{} - {}", short, event.summary)
    } else {
        event.summary.clone()
    }
}
