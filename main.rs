// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod overlay;
mod ws_client;

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use log::{info, error};

// ─── App State ───────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct AppState {
    pub session_id: Option<String>,
    pub server_url: String,
    pub audio_running: bool,
}

pub type SharedState = Arc<Mutex<AppState>>;

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Called by the settings WebView to start a session
#[tauri::command]
async fn start_session(
    server_url: String,
    state: State<'_, SharedState>,
    app: AppHandle,
) -> Result<String, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.server_url = server_url.clone();
    drop(s);

    info!("Starting session, server: {}", server_url);

    // Start audio capture + WebSocket in background
    let state_clone = state.inner().clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(e) = ws_client::run(server_url, state_clone, app_clone).await {
            error!("WebSocket client error: {}", e);
        }
    });

    // Show the overlay window
    if let Some(overlay_win) = app.get_webview_window("overlay") {
        overlay::setup_overlay_window(&overlay_win);
        overlay_win.show().ok();
    }

    Ok("Session starting".to_string())
}

#[tauri::command]
fn stop_session(state: State<'_, SharedState>) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.session_id = None;
    s.audio_running = false;
    Ok(())
}

#[tauri::command]
fn toggle_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        let visible = win.is_visible().unwrap_or(false);
        if visible { win.hide().ok(); } else { win.show().ok(); }
    }
    Ok(())
}

#[tauri::command]
fn set_overlay_position(x: i32, y: i32, app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        win.set_position(tauri::PhysicalPosition::new(x, y))
           .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    env_logger::init();

    let shared_state: SharedState = Arc::new(Mutex::new(AppState {
        session_id: None,
        server_url: "ws://localhost:8080".to_string(),
        audio_running: false,
    }));

    tauri::Builder::default()
        .manage(shared_state)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Global hotkeys
            let app_handle = app.handle().clone();
            let app_handle2 = app.handle().clone();

            // Ctrl+Shift+H / Cmd+Shift+H — toggle overlay
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::UI::Input::KeyboardAndMouse::*;
                // Register global hotkey via win32 API
                // Full implementation in overlay.rs
            }

            // Platform-specific overlay window setup happens when session starts
            info!("Voice Overlay started");

            // Register global hotkeys
            setup_hotkeys(app_handle);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            stop_session,
            toggle_overlay,
            set_overlay_position,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_hotkeys(app: AppHandle) {
    // Spawn a thread that listens for global keyboard events
    std::thread::spawn(move || {
        // Platform-specific hotkey listening
        // On Windows: use RegisterHotKey win32 API
        // On macOS: use CGEventTap
        // For MVP: rely on overlay window's own keydown listener
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
}
