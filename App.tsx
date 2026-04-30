import { useState, useCallback, useRef, useEffect } from 'react';
import { AudioPlayer } from './audio/player';
import { useWebSocket } from './hooks/useWebSocket';
import { usePushToTalk } from './hooks/usePTT';
import { AudioWaveform } from './components/AudioWaveform';
import { QuickResponses } from './components/QuickResponses';
import type { SessionInfo, TranscriptEntry, WSMessage } from './types';
import { randomUUID } from './utils';

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT_ID = `agent-${Math.random().toString(36).slice(2, 8)}`;
const SERVER_WS = import.meta.env.VITE_SERVER_WS || 'ws://localhost:8080';

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [sttProvider, setSttProvider] = useState('deepgram');
  const [userSpeaking, setUserSpeaking] = useState(false);

  const playerRef = useRef<AudioPlayer>(new AudioPlayer());
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // ─── WebSocket ────────────────────────────────────────────────────────────────

  const handleMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case 'session_assigned': {
        const sessionId = msg.sessionId as string;
        setSessions(prev => {
          const exists = prev.find(s => s.id === sessionId);
          if (exists) return prev;
          return [...prev, {
            id: sessionId,
            userId: msg.agentId as string,
            status: 'active',
            startedAt: Date.now(),
            transcriptHistory: [],
            isSpeaking: false,
          }];
        });
        if (!activeSessionId) setActiveSessionId(sessionId);
        break;
      }

      case 'transcript': {
        const text = msg.text as string;
        const isFinal = msg.isFinal as boolean;
        const confidence = msg.confidence as number;

        setLiveTranscript(isFinal ? '' : text);

        if (isFinal && text.trim()) {
          const entry: TranscriptEntry = {
            id: randomUUID(),
            text,
            isFinal: true,
            confidence,
            timestamp: Date.now(),
            source: 'agent',
          };

          setSessions(prev => prev.map(s =>
            s.id === activeSessionId
              ? { ...s, transcriptHistory: [...s.transcriptHistory, entry].slice(-50) }
              : s
          ));
        }
        break;
      }

      case 'agent_status': {
        const status = msg.status as string;
        setUserSpeaking(status === 'speaking');
        break;
      }

      case 'stt_fallback': {
        setSttProvider(msg.provider as string);
        break;
      }

      case 'session_end': {
        const sessionId = msg.sessionId as string;
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, status: 'ended' } : s
        ));
        if (activeSessionId === sessionId) {
          const next = sessions.find(s => s.id !== sessionId && s.status === 'active');
          setActiveSessionId(next?.id || null);
        }
        break;
      }
    }
  }, [activeSessionId, sessions]);

  const handleAudioFrame = useCallback((data: ArrayBuffer) => {
    playerRef.current.enqueue(data);
  }, []);

  const handleSessionAssigned = useCallback((sessionId: string) => {
    console.log('[App] Session assigned:', sessionId);
    playerRef.current.start();
  }, []);

  const { status, send, sendBinary } = useWebSocket({
    agentId: AGENT_ID,
    serverUrl: SERVER_WS,
    onMessage: handleMessage,
    onAudioFrame: handleAudioFrame,
    onSessionAssigned: handleSessionAssigned,
  });

  // ─── PTT ──────────────────────────────────────────────────────────────────────

  const { isSpeaking, hasPermission } = usePushToTalk({
    enabled: status === 'connected' && !!activeSessionId,
    onAudioChunk: sendBinary,
    onSpeakStart: () => send({ type: 'agent_status', status: 'speaking' }),
    onSpeakStop: () => send({ type: 'agent_status', status: 'idle' }),
  });

  // ─── Quick Responses ──────────────────────────────────────────────────────────

  const handleQuickResponse = useCallback((text: string) => {
    if (!activeSessionId) return;
    send({ type: 'hotkey_text', text, sessionId: activeSessionId });
    // Add to local transcript history
    const entry: TranscriptEntry = {
      id: randomUUID(),
      text,
      isFinal: true,
      confidence: 1,
      timestamp: Date.now(),
      source: 'agent',
    };
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, transcriptHistory: [...s.transcriptHistory, entry].slice(-50) }
        : s
    ));
  }, [activeSessionId, send]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sessions, liveTranscript]);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeSessions = sessions.filter(s => s.status === 'active');
  const waitingSessions = sessions.filter(s => s.status === 'waiting');

  return (
    <div className="app">
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <span className="logo">◉ Voice Overlay</span>
          <span className="agent-id">Agent: {AGENT_ID}</span>
        </div>
        <div className="header-right">
          <div className={`status-dot ${status}`} />
          <span className="status-label">{status}</span>
          <span className="stt-badge">STT: {sttProvider}</span>
        </div>
      </header>

      <div className="layout">
        {/* ─── Sidebar: Session Queue ──────────────────────────────────── */}
        <aside className="sidebar">
          <div className="sidebar-title">Sessions</div>

          {activeSessions.length === 0 && waitingSessions.length === 0 ? (
            <div className="empty-state">Waiting for users…</div>
          ) : (
            <>
              {activeSessions.map(s => (
                <div
                  key={s.id}
                  className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
                  onClick={() => setActiveSessionId(s.id)}
                >
                  <div className="session-id">{s.id.slice(0, 8)}</div>
                  <div className="session-meta">
                    <span className={`session-status active`}>● Active</span>
                    {s.isSpeaking && <span className="speaking-badge">🎤</span>}
                  </div>
                </div>
              ))}
              {waitingSessions.map(s => (
                <div key={s.id} className="session-item waiting">
                  <div className="session-id">{s.id.slice(0, 8)}</div>
                  <div className="session-meta">
                    <span className="session-status waiting">⏳ Waiting</span>
                  </div>
                </div>
              ))}
            </>
          )}

          <div className="stats">
            <div className="stat">
              <span className="stat-val">{activeSessions.length}</span>
              <span className="stat-label">Active</span>
            </div>
            <div className="stat">
              <span className="stat-val">{waitingSessions.length}</span>
              <span className="stat-label">Queue</span>
            </div>
          </div>
        </aside>

        {/* ─── Main: Active Session ───────────────────────────────────── */}
        <main className="main-panel">
          {!activeSession ? (
            <div className="no-session">
              <div className="no-session-icon">◎</div>
              <div className="no-session-text">No active session</div>
              <div className="no-session-sub">Waiting for user connections…</div>
            </div>
          ) : (
            <>
              {/* Waveform */}
              <div className="section waveform-section">
                <div className="section-label">Meeting Audio</div>
                <AudioWaveform isActive={userSpeaking} color="#00ff9d" height={56} />
              </div>

              {/* Transcript feed */}
              <div className="section transcript-section">
                <div className="section-label">Live Transcript (what user sees)</div>
                <div className="transcript-feed">
                  {activeSession.transcriptHistory.map(entry => (
                    <div key={entry.id} className="transcript-entry">
                      <span className="transcript-time">
                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className="transcript-text">{entry.text}</span>
                      {entry.confidence < 0.7 && (
                        <span className="low-conf">(low confidence)</span>
                      )}
                    </div>
                  ))}
                  {liveTranscript && (
                    <div className="transcript-entry interim">
                      <span className="transcript-time">…</span>
                      <span className="transcript-text">{liveTranscript}</span>
                    </div>
                  )}
                  <div ref={transcriptEndRef} />
                </div>
              </div>

              {/* PTT */}
              <div className="section ptt-section">
                <div className="section-label">Your Response</div>
                <div className={`ptt-area ${isSpeaking ? 'speaking' : ''}`}>
                  <div className="ptt-hint">
                    {hasPermission === false
                      ? '⚠ Microphone permission denied'
                      : isSpeaking
                        ? '🔴 Recording… (release SPACE to stop)'
                        : '⎵ Hold SPACE to speak'}
                  </div>
                  {isSpeaking && <AudioWaveform isActive color="#ff4444" height={36} />}
                </div>
              </div>

              {/* Quick Responses */}
              <div className="section">
                <QuickResponses
                  onSend={handleQuickResponse}
                  enabled={status === 'connected'}
                />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
