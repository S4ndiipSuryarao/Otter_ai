# Voice Overlay System

Real-time human-agent assisted meeting subtitle overlay.

**Target:** ~10 concurrent user-agent pairs  
**Latency:** <1.5s end-to-end (excluding irreducible human cognition ~500-800ms)  
**Platforms:** Windows 10 2004+ · macOS 12+

---

## Architecture

```
User's Machine                     Cloud Infrastructure
┌──────────────────┐               ┌──────────────────────┐
│  Tauri App       │               │  Relay Server        │
│  (overlay.html)  │◄── Text ──────│  (Node.js + WS)      │
│                  │               │                      │
│  [Subtitle UI]   │               │  Session Manager     │
│                  │──── Audio ───►│  (in-memory/Redis)   │
└──────────────────┘               │                      │
      ▲                            │  STT Router          │
      │ system audio               │  (Deepgram primary)  │
      │ (WASAPI / BlackHole)       └──────────┬───────────┘
┌─────┴────────────┐                          │
│  Meeting App     │               ┌──────────▼───────────┐
│  (Zoom/Teams)    │               │  Agent Dashboard     │
└──────────────────┘               │  (React SPA :3000)   │
                                   │                      │
                                   │  Listens via WebRTC  │
                                   │  Speaks via PTT      │
                                   └──────────────────────┘
```

---

## Project Structure

```
voice-overlay/
├── server/                  # Node.js relay + STT router
│   ├── src/
│   │   ├── index.ts         # Main WebSocket server
│   │   ├── session.ts       # Session/agent pairing
│   │   ├── stt-router.ts    # Per-session STT with fallback
│   │   └── stt/
│   │       ├── deepgram.ts  # Primary STT adapter
│   │       ├── google.ts    # Fallback #1
│   │       └── azure.ts     # Fallback #2
│   └── Dockerfile
│
├── dashboard/               # Agent dashboard (React SPA)
│   ├── src/
│   │   ├── App.tsx          # Main dashboard component
│   │   ├── audio/player.ts  # PCM16 audio player + mic capture
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts  # WS with exponential backoff
│   │   │   └── usePTT.ts        # Push-to-talk (SPACE key)
│   │   └── components/
│   │       ├── AudioWaveform.tsx
│   │       └── QuickResponses.tsx
│   └── Dockerfile
│
├── overlay-client/          # Tauri desktop app
│   ├── src/
│   │   ├── overlay.html     # Subtitle WebView (transparent, always-on-top)
│   │   └── settings.html    # Settings window
│   └── src-tauri/
│       └── src/
│           ├── main.rs      # Tauri setup + commands
│           ├── audio.rs     # CPAL loopback audio capture
│           ├── overlay.rs   # Screen-capture hiding (Win32 / Cocoa)
│           └── ws_client.rs # WebSocket client + audio streaming
│
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Quick Start

### 1. Prerequisites

| Platform  | Requirement                                                         |
|-----------|---------------------------------------------------------------------|
| Windows   | Windows 10 build 19041+ (for WDA_EXCLUDEFROMCAPTURE screen hiding)  |
| macOS     | macOS 12+ · [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) for audio loopback |
| Both      | Docker + Docker Compose · Node.js 20 LTS · Rust 1.77+               |

### 2. Environment Setup

```bash
cp .env.example .env
# Edit .env — add at minimum DEEPGRAM_API_KEY
```

### 3. Start the Server Stack

```bash
docker compose up -d
# Relay server: http://localhost:8080
# Agent dashboard: http://localhost:3000
# Redis: localhost:6379
```

### 4. Build & Run the Client (Development)

```bash
cd overlay-client
npm install
npm run tauri:dev
```

### 5. Build for Distribution

```bash
# Windows (run on Windows)
cd overlay-client
npm run tauri:build -- --target x86_64-pc-windows-msvc

# macOS Apple Silicon
npm run tauri:build -- --target aarch64-apple-darwin

# macOS Intel
npm run tauri:build -- --target x86_64-apple-darwin
```

---

## Latency Budget

| Hop | Component               | Target     | Technique                              |
|-----|-------------------------|------------|----------------------------------------|
| 1   | Audio capture           | 5–10ms     | WASAPI exclusive / CoreAudio tap       |
| 2   | Opus encode             | 2–3ms      | 20ms frame, OPUS_APPLICATION_VOIP      |
| 3   | Client → Server (WS)    | 15–40ms    | TCP_NODELAY, binary frames             |
| 4   | Server → Agent (WebRTC) | 20–50ms    | UDP, jitter buffer 40ms max            |
| **5** | **Human cognition**   | **500–800ms** | **Irreducible — dominant latency** |
| 6   | Agent mic capture       | 5–10ms     | 10ms buffer, headset required          |
| 7   | Agent audio → STT Router | 10–20ms  | Binary PCM frames                      |
| 8   | STT streaming           | 200–400ms  | Deepgram interim_results=true          |
| 9   | Transcript → Client     | 15–40ms    | Same WebSocket connection              |
| 10  | Overlay render          | 5–10ms     | Direct DOM mutation, no vdom           |
| **Total** |                   | **~800–1400ms** | **Within 1.5s target**         |

**Primary bottleneck:** Human cognition (hop 5) — 50-60% of budget. Irreducible by design.

---

## STT Provider Comparison

| Provider       | Streaming Latency | Accuracy | Cost/min | Recommendation      |
|---------------|-------------------|----------|----------|---------------------|
| Deepgram Nova-2 | ~200ms          | 95%+     | $0.0059  | ✅ Primary           |
| Google Cloud v2 | ~300ms          | 94%+     | $0.0096  | ✅ Fallback #1       |
| Azure Speech   | ~250ms            | 93%+     | $0.0100  | ✅ Fallback #2       |
| Whisper (self) | ~800ms+           | 96%+     | ~$0.002* | ❌ No true streaming |

---

## macOS Audio Setup

macOS has no native loopback capture API. Install **BlackHole**:

1. Download from [existentialAudio.com/BlackHole](https://existentialudio.com/BlackHole/)
2. System Settings → Sound → Output → select **BlackHole 2ch**
3. Create a **Multi-Output Device** in Audio MIDI Setup (BlackHole + your speakers) so you can still hear
4. In Voice Overlay Settings, select **BlackHole 2ch** as capture device

---

## Screen Capture Hiding

| Platform | Method                    | Requirement                     | Fallback                     |
|----------|---------------------------|---------------------------------|------------------------------|
| Windows  | `WDA_EXCLUDEFROMCAPTURE`  | Build 19041+ (Win10 20H1)       | `WDA_MONITOR` (black rect)   |
| macOS    | `setSharingType: 0`       | macOS 12+                       | Manual `Cmd+Shift+H` to hide |

**Known limitation:** OBS virtual camera / NDI intercept at the driver level and may bypass these APIs. Document this to users.

---

## Agent Dashboard

Open [http://localhost:3000](http://localhost:3000) in a Chromium-based browser.

| Control           | Description                                            |
|-------------------|--------------------------------------------------------|
| **SPACE (hold)**  | Push-to-Talk — speak to user                          |
| **F1**            | Quick response: "Acknowledged"                        |
| **F2**            | Quick response: "One moment please"                   |
| **F3**            | Quick response: "Could you repeat that?"              |
| **F4**            | Quick response: "I'll follow up after the meeting"    |
| **F5**            | Quick response: "Please go ahead"                     |
| **F6**            | Quick response: "That is correct"                     |

**Headphones are mandatory** — prevents echo from feeding back into the STT pipeline.

---

## Switching STT Provider Mid-Session

```bash
# Via HTTP API
curl -X POST http://localhost:8080/api/stt-provider \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "SESSION_ID", "provider": "google"}'
```

The system performs a zero-gap swap: buffers up to 200ms of audio during the switch, drains final results from the old provider, and atomically routes new audio to the new provider.

---

## Failure Handling

| Failure               | Detection                      | Response                                    |
|-----------------------|--------------------------------|---------------------------------------------|
| STT provider error    | WebSocket close / parse error  | Auto-fallback: Deepgram → Google → Azure    |
| Client disconnects    | WS close event                 | Exponential backoff reconnect (100ms→5s)    |
| Agent disconnects     | WS close event                 | Session re-queued; user sees status message |
| Low audio quality     | Packet loss > 5%               | Reduce Opus bitrate 32→16kbps               |
| Low STT confidence    | confidence < 0.6               | Show ⚠ badge next to transcript             |

---

## Resource Usage (10 Sessions)

| Resource            | Per Session | 10 Sessions |
|---------------------|-------------|-------------|
| Bandwidth (audio)   | ~32 kbps    | 320 kbps    |
| Bandwidth (STT PCM) | ~256 kbps   | 2.56 Mbps   |
| Server CPU          | ~2%         | ~20%        |
| Server RAM          | ~15MB       | ~150MB      |
| STT cost            | $0.006/min  | $0.06/min   |

**Server requirement:** A single `c6i.large` (2 vCPU, 4GB RAM) handles 10 sessions with 70% headroom.

---

## MVP Checklist

- [ ] Tauri client runs on Windows/Mac
- [ ] Meeting audio captured and streamed to server
- [ ] Agent dashboard receives meeting audio  
- [ ] Agent PTT (SPACE) triggers STT
- [ ] Transcript appears as subtitle overlay
- [ ] Overlay hidden from screen capture (Win Game Bar / macOS screenshot)
- [ ] End-to-end latency (excl. human) < 700ms
- [ ] STT fallback to Google if Deepgram fails
- [ ] WebSocket reconnection with exponential backoff
- [ ] Quick response hotkeys (F1–F6)

---

## Post-MVP Backlog

- [ ] WebRTC for agent audio (lower latency than WebSocket PCM)
- [ ] Multi-region deployment (add regions per agent geography)  
- [ ] AI-suggested responses in agent dashboard  
- [ ] Session recording + playback  
- [ ] Analytics: latency histogram, STT confidence tracking  
- [ ] macOS notarization (currently: `--no-quarantine` for testing)  
- [ ] JWT authentication  
- [ ] Multi-monitor: auto-move overlay to non-shared monitor  
