import { useEffect, useRef, useCallback, useState } from 'react';
import type { WSMessage } from '../types';

interface UseWebSocketOptions {
  agentId: string;
  serverUrl: string;
  onMessage: (msg: WSMessage) => void;
  onAudioFrame: (data: ArrayBuffer) => void;
  onSessionAssigned: (sessionId: string) => void;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

const BACKOFF_BASE_MS = 100;
const BACKOFF_MAX_MS = 5_000;
const BACKOFF_MULTIPLIER = 2;

export function useWebSocket({
  agentId,
  serverUrl,
  onMessage,
  onAudioFrame,
  onSessionAssigned,
}: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Stable refs for callbacks so reconnect closure doesn't go stale
  const onMessageRef = useRef(onMessage);
  const onAudioFrameRef = useRef(onAudioFrame);
  const onSessionAssignedRef = useRef(onSessionAssigned);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onAudioFrameRef.current = onAudioFrame; }, [onAudioFrame]);
  useEffect(() => { onSessionAssignedRef.current = onSessionAssigned; }, [onSessionAssigned]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const url = `${serverUrl}/agent?id=${encodeURIComponent(agentId)}`;
    setStatus('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[WS] Invalid URL or WebSocket constructor error:', err);
      setStatus('error');
      return;
    }

    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      retryRef.current = 0;
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        onAudioFrameRef.current(event.data);
        return;
      }

      try {
        const msg: WSMessage = JSON.parse(event.data as string);

        // Handle session_assigned before forwarding so player can start
        if (msg.type === 'session_assigned' && typeof msg.sessionId === 'string') {
          onSessionAssignedRef.current(msg.sessionId);
        }

        onMessageRef.current(msg);
      } catch {
        // Non-JSON frame — ignore
      }
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;

      const wasConnected = status === 'connected';
      setStatus('disconnected');

      // Abnormal closure — schedule reconnect with exponential backoff
      if (event.code !== 1000) {
        const delay = Math.min(
          BACKOFF_BASE_MS * BACKOFF_MULTIPLIER ** retryRef.current,
          BACKOFF_MAX_MS,
        );
        retryRef.current++;
        console.warn(`[WS] Closed (code ${event.code}), retry #${retryRef.current} in ${delay}ms`);
        timerRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      // onerror is always followed by onclose — let onclose drive reconnect
      setStatus('error');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, serverUrl]); // Only re-create connect fn if connection params change

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close(1000, 'Component unmounted');
    };
  }, [connect]);

  /** Send a JSON message. Silently drops if not connected. */
  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  /** Send raw binary (audio chunk). Silently drops if not connected. */
  const sendBinary = useCallback((data: ArrayBuffer | Uint8Array) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }, []);

  return { status, send, sendBinary };
}
