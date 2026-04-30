import 'dotenv/config';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import pino from 'pino';
import { SessionManager } from './session';
import { STTRouter } from './stt-router';
import type { ConnectionContext, WSMessage } from './types';

// ─── Logger ──────────────────────────────────────────────────────────────────

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty' }
    : undefined,
});

// ─── Global State ────────────────────────────────────────────────────────────

const sessionManager = new SessionManager();
const sttRouter = new STTRouter();

// Maps: userId/agentId → WebSocket
const overlayClients = new Map<string, WebSocket>();
const agentClients = new Map<string, WebSocket>();

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...sessionManager.getStats() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/stt-provider') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sessionId, provider } = JSON.parse(body);
        const ok = sessionManager.updateSessionSTTProvider(sessionId, provider);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  perMessageDeflate: false, // Disable for binary audio — compression costs latency
  maxPayload: 64 * 1024,    // 64KB max message
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost`);
  const role = url.pathname === '/agent' ? 'agent' : 'overlay';
  const clientId = url.searchParams.get('id') || randomUUID();

  const ctx: ConnectionContext = {
    role,
    id: clientId,
    sessionId: null,
    isAlive: true,
  };

  logger.info({ role, clientId }, 'Client connected');

  // TCP_NODELAY equivalent — send immediately
  // (ws library handles this, no buffering on text messages)

  // ─── Heartbeat ───────────────────────────────────────────────────────────────

  const pingInterval = setInterval(() => {
    if (!ctx.isAlive) {
      logger.warn({ role, clientId }, 'Client pong timeout — terminating');
      ws.terminate();
      return;
    }
    ctx.isAlive = false;
    ws.ping();
  }, 15_000);

  ws.on('pong', () => { ctx.isAlive = true; });

  // ─── Register by role ────────────────────────────────────────────────────────

  if (role === 'overlay') {
    overlayClients.set(clientId, ws);
  } else {
    agentClients.set(clientId, ws);
    sessionManager.registerAgent(clientId);
  }

  // ─── Message Handling ─────────────────────────────────────────────────────────

  ws.on('message', async (raw, isBinary) => {
    // Binary = audio frame
    if (isBinary) {
      await handleAudioFrame(ctx, raw as Buffer, ws);
      return;
    }

    try {
      const msg: WSMessage = JSON.parse(raw.toString());
      await handleTextMessage(ctx, msg, ws);
    } catch (e) {
      logger.warn({ err: e, clientId }, 'Failed to parse message');
    }
  });

  // ─── Disconnect ───────────────────────────────────────────────────────────────

  ws.on('close', async (code) => {
    clearInterval(pingInterval);
    logger.info({ role, clientId, code }, 'Client disconnected');

    if (role === 'overlay') {
      overlayClients.delete(clientId);
      if (ctx.sessionId) {
        await sttRouter.removeSession(ctx.sessionId);
        sessionManager.endSession(ctx.sessionId);
      }
    } else {
      agentClients.delete(clientId);
      sessionManager.removeAgent(clientId);
    }
  });

  ws.on('error', (err) => {
    logger.error({ err, clientId }, 'WebSocket error');
  });
});

// ─── Audio Frame Handler ─────────────────────────────────────────────────────

async function handleAudioFrame(ctx: ConnectionContext, data: Buffer, _ws: WebSocket): Promise<void> {
  if (ctx.role === 'overlay') {
    // Meeting audio from user: forward to matched agent
    if (!ctx.sessionId) return;
    const session = sessionManager.getSession(ctx.sessionId);
    if (!session?.agentId) return;

    const agentWs = agentClients.get(session.agentId);
    if (agentWs?.readyState === WebSocket.OPEN) {
      agentWs.send(data, { binary: true });
    }

  } else if (ctx.role === 'agent') {
    // Agent mic audio: route to STT
    if (!ctx.sessionId) return;

    const sttSession = sttRouter.getSession(ctx.sessionId);
    sttSession?.sendAudio(data);
  }
}

// ─── Text Message Handler ─────────────────────────────────────────────────────

async function handleTextMessage(ctx: ConnectionContext, msg: WSMessage, ws: WebSocket): Promise<void> {
  switch (msg.type) {

    case 'session_start': {
      if (ctx.role !== 'overlay') return;

      const session = sessionManager.createSession(ctx.id);
      ctx.sessionId = session.id;

      sendTo(ws, {
        type: 'session_assigned',
        sessionId: session.id,
        agentId: session.agentId || 'pending',
      });

      logger.info({ userId: ctx.id, sessionId: session.id }, 'Session started');
      break;
    }

    case 'session_end': {
      if (ctx.sessionId) {
        await sttRouter.removeSession(ctx.sessionId);
        sessionManager.endSession(ctx.sessionId);
        ctx.sessionId = null;
      }
      break;
    }

    case 'hotkey_text': {
      // Agent sent a quick-response text — forward directly to user's overlay
      if (ctx.role !== 'agent' || !ctx.sessionId) return;
      const session = sessionManager.getSession(ctx.sessionId);
      if (!session) return;

      const overlayWs = overlayClients.get(session.userId);
      if (overlayWs?.readyState === WebSocket.OPEN) {
        sendTo(overlayWs, msg);
      }
      break;
    }

    case 'agent_status': {
      if (ctx.role !== 'agent' || !ctx.sessionId) return;
      const session = sessionManager.getSession(ctx.sessionId);
      if (!session) return;

      const overlayWs = overlayClients.get(session.userId);
      if (overlayWs?.readyState === WebSocket.OPEN) {
        sendTo(overlayWs, msg);
      }
      break;
    }

    case 'ping':
      sendTo(ws, { type: 'pong' });
      break;

    default:
      logger.debug({ type: (msg as any).type }, 'Unhandled message type');
  }
}

// ─── Session Manager Events ───────────────────────────────────────────────────

sessionManager.on('session_assigned', async (sessionId: string, agentId: string) => {
  const session = sessionManager.getSession(sessionId)!;

  // Notify overlay client that agent is connected
  const overlayWs = overlayClients.get(session.userId);
  if (overlayWs?.readyState === WebSocket.OPEN) {
    sendTo(overlayWs, { type: 'session_assigned', sessionId, agentId });
  }

  // Notify agent of their new session
  const agentWs = agentClients.get(agentId);
  if (agentWs) {
    // Find agent's ConnectionContext and set sessionId
    // We use a Map that tracks ctx — for simplicity, attach to ws directly
    (agentWs as any)._sessionId = sessionId;
    sendTo(agentWs, { type: 'session_assigned', sessionId, agentId });
  }

  // Start STT session for this user
  try {
    const sttSession = await sttRouter.createSession(
      sessionId,
      session.sttProvider,
      // Transcript callback
      (result) => {
        const overlayWs = overlayClients.get(session.userId);
        if (overlayWs?.readyState === WebSocket.OPEN) {
          sendTo(overlayWs, {
            type: 'transcript',
            text: result.text,
            isFinal: result.isFinal,
            confidence: result.confidence,
          });
        }
        // Also send to agent dashboard for preview
        const agentWs = agentClients.get(agentId);
        if (agentWs?.readyState === WebSocket.OPEN) {
          sendTo(agentWs, {
            type: 'transcript',
            text: result.text,
            isFinal: result.isFinal,
            confidence: result.confidence,
          });
        }
      },
      // Provider switch notification
      (event) => {
        const overlayWs = overlayClients.get(session.userId);
        if (overlayWs?.readyState === WebSocket.OPEN) {
          sendTo(overlayWs, event as WSMessage);
        }
      }
    );

    // Update agent ctx sessionId
    // Attach session to the connection context via closure
    const agentWs = agentClients.get(agentId);
    if (agentWs) {
      (agentWs as any)._ctx = { ...((agentWs as any)._ctx || {}), sessionId };
    }

    logger.info({ sessionId, provider: session.sttProvider }, 'STT session started');
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to start STT session');
  }
});

sessionManager.on('agent_disconnected', (sessionId: string) => {
  const session = sessionManager.getSession(sessionId);
  if (!session) return;

  const overlayWs = overlayClients.get(session.userId);
  if (overlayWs?.readyState === WebSocket.OPEN) {
    sendTo(overlayWs, { type: 'agent_status', status: 'disconnected' });
  }
});

// ─── Utility ─────────────────────────────────────────────────────────────────

function sendTo(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '8080', 10);

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, '🎙 Voice Overlay relay server started');
  logger.info('  Overlay clients → ws://localhost:' + PORT + '/overlay?id={userId}');
  logger.info('  Agent dashboard → ws://localhost:' + PORT + '/agent?id={agentId}');
  logger.info('  Health check    → http://localhost:' + PORT + '/health');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  httpServer.close();
  wss.close();
  process.exit(0);
});
