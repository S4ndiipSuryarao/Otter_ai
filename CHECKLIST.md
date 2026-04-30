# Voice Overlay — Missing Files & Bug Fix Checklist

## 1. New files to add to the repository

### Server  (`server/src/`)
- [ ] `types.ts`          — All shared interfaces (STTProvider, Session, WSMessage, …)
- [ ] `stt/index.ts`      — createSTTProvider() factory
- [ ] `stt/google.ts`     — Google Cloud STT v2 streaming adapter
- [ ] `stt/azure.ts`      — Azure Cognitive Services STT adapter

### Dashboard  (`dashboard/src/`)
- [ ] `types.ts`          — TranscriptEntry, SessionInfo, WSMessage
- [ ] `utils.ts`          — randomUUID() wrapper
- [ ] `audio/player.ts`   — AudioPlayer (PCM16 → Web Audio API scheduler)
- [ ] `hooks/useWebSocket.ts` — WS hook with exponential backoff
- [ ] `hooks/usePTT.ts`   — Push-to-talk (SPACE) mic capture → PCM16 stream
- [ ] `components/AudioWaveform.tsx` — Canvas waveform visualizer
- [ ] `components/QuickResponses.tsx` — F1–F6 hotkey response grid

### Overlay Client  (`overlay-client/src-tauri/src/`)
- [ ] `audio.rs`          — CPAL loopback capture (Win32 WASAPI / macOS)
- [ ] `overlay.rs`        — Screen-capture exclusion (WDA_EXCLUDEFROMCAPTURE / NSWindow)
- [ ] `ws_client.rs`      — WS client + audio streaming + Tauri event forwarding

---

## 2. Bugs to patch in existing files

### BUG-1  `main.rs` — AppState missing fields
**File:** `overlay-client/src-tauri/src/main.rs`
**Problem:** `ws_client.rs` reads `s.audio_device` and `s.user_id`, which don't
exist in the original AppState struct → compile error.
**Fix:** Add the two fields + a `generate_user_id()` helper.
See PATCHES.md for the exact diff.

### BUG-2  `index.ts` — Agent context.sessionId never set → audio silently dropped
**File:** `server/src/index.ts`
**Problem:** When `SessionManager` emits `session_assigned`, the handler sets
`(ws as any)._sessionId` and `(ws as any)._ctx` — loose bag properties that the
`handleAudioFrame` closure never reads. It reads `ctx.sessionId` from the
ConnectionContext captured in the `wss.on('connection')` closure, which stays
`null` forever. Result: every binary audio frame from the agent is silently
dropped (`if (!ctx.sessionId) return`), so STT never receives audio.
**Fix:** Add a `WeakMap<WebSocket, ConnectionContext>` so the event handler can
update the real ctx object.
See PATCHES.md for the exact diff.

---

## 3. npm packages to install

```bash
# Server
cd server
npm i @google-cloud/speech    # Google STT adapter

# No extra package for Azure — uses the 'ws' package already present.

# Dashboard  (all already available in a Vite/React scaffold)
# AudioPlayer, hooks, and components use only browser APIs.
```

### Rust dependencies (Cargo.toml additions)
```toml
[dependencies]
cpal = "0.15"
tokio-tungstenite = { version = "0.21", features = ["native-tls"] }
futures-util = "0.3"
uuid = { version = "1", features = ["v4"] }

[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.52", features = [
  "Win32_Foundation",
  "Win32_UI_WindowsAndMessaging",
] }

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.5"
```

---

## 4. Verification steps

### Server stack
```bash
cd server
npm run build           # must compile clean — no missing module errors
docker compose up -d
curl http://localhost:8080/health  # → {"status":"ok","activeSessions":0,...}
```

### Dashboard
```bash
cd dashboard
npm run build           # no TypeScript errors
# Open http://localhost:3000 — status dot should be "connecting"
# Connect a second browser tab as the overlay client; session should pair
```

### STT pipeline (integration)
```bash
# Set DEEPGRAM_API_KEY in .env, start stack, open dashboard
# Hold SPACE, speak — transcript should appear within ~1.5s
# Kill relay container mid-session → Google fallback should activate
```

### Tauri desktop app
```bash
cd overlay-client
npm run tauri:dev
# Settings window → enter ws://localhost:8080 → Start Session
# overlay.html should appear; speak into meeting → subtitles appear
# Alt-Tab to Teams/Zoom → overlay should NOT appear in the screen share preview
```

---

## 5. Architecture note — AgentConnectionContext fix

The `wsContextMap` fix (BUG-2) is the highest-severity issue: without it the
entire STT pipeline is dead even if all adapters are wired up correctly.  The
root cause is architectural — the server mixes imperative WS event handlers with
an EventEmitter pattern, and the two have no shared reference to the same object.

If you ever migrate to Redis pub/sub for multi-instance scaling, the same pattern
flaw will re-appear.  The correct fix at scale is to store sessionId in Redis
keyed by agentId, not in in-process memory.
