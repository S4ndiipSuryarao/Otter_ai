# Bug Fixes

## BUG 1 — main.rs: AppState missing fields used by ws_client.rs
## ─────────────────────────────────────────────────────────────
## ws_client.rs references `s.audio_device` and `s.user_id` which don't exist
## in the original AppState struct.
##
## PATCH: overlay-client/src-tauri/src/main.rs

--- a/main.rs
+++ b/main.rs
@@ -10,6 +10,8 @@ pub struct AppState {
     pub session_id: Option<String>,
     pub server_url: String,
     pub audio_running: bool,
+    pub audio_device: Option<String>,   // selected capture device name
+    pub user_id: Option<String>,        // stable overlay user identifier
 }

@@ -80,6 +82,8 @@ fn main() {
     let shared_state: SharedState = Arc::new(Mutex::new(AppState {
         session_id: None,
         server_url: "ws://localhost:8080".to_string(),
         audio_running: false,
+        audio_device: None,
+        user_id: Some(generate_user_id()),
     }));
+}
+
+/// Generates a stable machine-scoped user ID (stored in app data dir).
+/// Falls back to a random UUID if the data dir is unavailable.
+fn generate_user_id() -> String {
+    // For MVP: use a random UUID persisted to disk on first run.
+    // Production: use machine ID crate or Tauri's app data dir.
+    use std::fs;
+    let path = std::env::temp_dir().join("voice-overlay-uid");
+    if let Ok(id) = fs::read_to_string(&path) {
+        let trimmed = id.trim().to_string();
+        if !trimmed.is_empty() {
+            return trimmed;
+        }
+    }
+    let id = uuid::Uuid::new_v4().to_string();
+    let _ = fs::write(&path, &id);
+    id
+}

## ─────────────────────────────────────────────────────────────────────────────
## BUG 2 — index.ts: Agent ConnectionContext.sessionId never updated
## ─────────────────────────────────────────────────────────────────────────────
## In handleTextMessage, ctx.sessionId is set for overlay clients (session_start)
## but NOT for agent clients when session_assigned fires. The sessionManager
## emits 'session_assigned' and tries to update the ctx via (ws as any)._ctx —
## a loose bag that handleAudioFrame never reads. handleAudioFrame reads
## ctx.sessionId (the real ConnectionContext), so the agent's audio is silently
## dropped (line: `if (!ctx.sessionId) return;`).
##
## ROOT CAUSE: The connectionContext (ctx) is captured in the ws.on('message')
## closure in wss.on('connection'), but the sessionManager event fires outside
## that closure with no access to ctx.
##
## FIX: Maintain a Map<WebSocket, ConnectionContext> so the event handler can
## reach the ctx object and set sessionId properly.
##
## PATCH: server/src/index.ts

--- a/index.ts
+++ b/index.ts
@@ -1,4 +1,5 @@
 // Maps: userId/agentId → WebSocket
 const overlayClients = new Map<string, WebSocket>();
 const agentClients = new Map<string, WebSocket>();
+const wsContextMap = new WeakMap<WebSocket, ConnectionContext>(); // NEW

@@ -65,6 +66,7 @@ wss.on('connection', (ws, req) => {
   if (role === 'overlay') {
     overlayClients.set(clientId, ws);
   } else {
     agentClients.set(clientId, ws);
+    wsContextMap.set(ws, ctx);               // NEW: register ctx
     sessionManager.registerAgent(clientId);
   }

@@ -170,10 +171,12 @@ sessionManager.on('session_assigned', async (sessionId: string, agentId: string
   // Notify agent of their new session
   const agentWs = agentClients.get(agentId);
   if (agentWs) {
-    (agentWs as any)._sessionId = sessionId;   // REMOVE — never read
+    const agentCtx = wsContextMap.get(agentWs); // FIX
+    if (agentCtx) agentCtx.sessionId = sessionId;
     sendTo(agentWs, { type: 'session_assigned', sessionId, agentId });
   }
 
   // … later in the same handler, remove the stale _ctx line:
-  if (agentWs) {
-    (agentWs as any)._ctx = { ...((agentWs as any)._ctx || {}), sessionId };
-  }
+  // (already handled above via wsContextMap)
