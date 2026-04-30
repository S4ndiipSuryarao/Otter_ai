// ws_client.rs — WebSocket client for the overlay Tauri app
//
// Responsibilities:
//  1. Connect to the relay server at /overlay?id={userId}
//  2. Send session_start to get assigned to an agent
//  3. Spin up audio capture and stream PCM16 chunks as binary WS frames
//  4. Forward JSON messages from the server as Tauri events to the frontend
//
// Cargo.toml additions required:
//   tokio-tungstenite = { version = "0.21", features = ["native-tls"] }
//   futures-util = "0.3"

use crate::audio::AudioCapture;
use crate::{AppState, SharedState};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::select;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const RECONNECT_BASE_MS: u64 = 100;
const RECONNECT_MAX_MS: u64 = 5_000;
const SAMPLE_RATE: u32 = 16_000;

/// Entry point called from `main.rs` — runs until the session is stopped
/// or an unrecoverable error occurs.
pub async fn run(
    server_url: String,
    state: SharedState,
    app: AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut retry = 0u32;

    loop {
        // Check if we should still be running
        {
            let s = state.lock().map_err(|e| e.to_string())?;
            if !s.audio_running && s.session_id.is_none() && retry > 0 {
                log::info!("ws_client: stop requested, exiting");
                return Ok(());
            }
        }

        let ws_url = format!("{}/overlay?id={}", server_url, user_id(&state));
        log::info!("ws_client: connecting to {}", ws_url);

        match connect_async(&ws_url).await {
            Ok((ws_stream, _)) => {
                retry = 0;
                if let Err(e) = handle_connection(ws_stream, &state, &app).await {
                    log::error!("ws_client: connection error: {}", e);
                }
            }
            Err(e) => {
                log::warn!("ws_client: connect failed: {}", e);
            }
        }

        // Check stop flag before reconnecting
        if !should_reconnect(&state) {
            log::info!("ws_client: stop flag set, not reconnecting");
            return Ok(());
        }

        let delay = exponential_backoff(retry);
        log::info!("ws_client: reconnecting in {}ms (attempt {})", delay, retry + 1);
        tokio::time::sleep(Duration::from_millis(delay)).await;
        retry = retry.saturating_add(1);
    }
}

// ─── Connection handler ───────────────────────────────────────────────────────

async fn handle_connection(
    ws_stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    state: &SharedState,
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (mut ws_sink, mut ws_source) = ws_stream.split();

    // ── Send session_start ────────────────────────────────────────────────────
    let start_msg = json!({ "type": "session_start" }).to_string();
    ws_sink.send(Message::Text(start_msg)).await?;
    log::info!("ws_client: session_start sent");

    // ── Start audio capture ───────────────────────────────────────────────────
    let capture = AudioCapture::new();
    let audio_device = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.audio_device.clone() // Option<String> — add this field to AppState
    };

    let mut audio_rx = capture.start(audio_device.as_deref(), SAMPLE_RATE)?;

    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.audio_running = true;
    }

    // ── Event loop ────────────────────────────────────────────────────────────
    loop {
        select! {
            // Inbound: server → frontend
            msg = ws_source.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_message(&text, state, app)?;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        ws_sink.send(Message::Pong(payload)).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        log::warn!("ws_client: server closed connection");
                        break;
                    }
                    Some(Err(e)) => {
                        log::error!("ws_client: receive error: {}", e);
                        break;
                    }
                    _ => {} // Binary frames from server (not expected on overlay path)
                }
            }

            // Outbound: audio capture → server
            chunk = audio_rx.recv() => {
                match chunk {
                    Some(pcm) => {
                        ws_sink.send(Message::Binary(pcm)).await?;
                    }
                    None => {
                        log::warn!("ws_client: audio channel closed");
                        break;
                    }
                }
            }

            // Stop signal
            _ = stop_signal(state) => {
                log::info!("ws_client: stop signal received");
                let _ = ws_sink.send(Message::Text(
                    json!({ "type": "session_end" }).to_string()
                )).await;
                let _ = ws_sink.send(Message::Close(None)).await;
                break;
            }
        }
    }

    capture.stop();
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.audio_running = false;
    }

    Ok(())
}

// ─── Message routing ──────────────────────────────────────────────────────────

fn handle_server_message(
    text: &str,
    state: &SharedState,
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let v: Value = serde_json::from_str(text)?;
    let msg_type = v["type"].as_str().unwrap_or("");

    match msg_type {
        "session_assigned" => {
            let session_id = v["sessionId"].as_str().unwrap_or("").to_string();
            log::info!("ws_client: session assigned: {}", session_id);
            {
                let mut s = state.lock().map_err(|e| e.to_string())?;
                s.session_id = Some(session_id.clone());
            }
            // Emit to the overlay WebView
            app.emit("session-assigned", session_id)?;
        }

        "transcript" => {
            // Forward full payload — overlay.html listens for this event
            app.emit("transcript", v)?;
        }

        "agent_status" => {
            app.emit("agent-status", v)?;
        }

        "stt_fallback" => {
            let provider = v["provider"].as_str().unwrap_or("unknown");
            app.emit("stt-fallback", provider)?;
        }

        "session_end" => {
            log::info!("ws_client: session ended by server");
            {
                let mut s = state.lock().map_err(|e| e.to_string())?;
                s.session_id = None;
            }
        }

        unknown => {
            log::debug!("ws_client: unhandled message type '{}'", unknown);
        }
    }

    Ok(())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn user_id(state: &SharedState) -> String {
    // Stable user ID derived from the machine; fall back to a fixed string for MVP
    state
        .lock()
        .ok()
        .and_then(|s| s.user_id.clone())
        .unwrap_or_else(|| "overlay-user-1".to_string())
}

fn should_reconnect(state: &SharedState) -> bool {
    state
        .lock()
        .map(|s| s.audio_running || s.session_id.is_some())
        .unwrap_or(false)
}

fn exponential_backoff(retry: u32) -> u64 {
    let base = RECONNECT_BASE_MS.saturating_mul(1u64.saturating_shl(retry));
    base.min(RECONNECT_MAX_MS)
}

/// Polls the stop flag every 100ms.  Resolves when audio_running → false.
async fn stop_signal(state: &SharedState) {
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Ok(s) = state.lock() {
            if !s.audio_running {
                return;
            }
        }
    }
}
