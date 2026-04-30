// ─── STT ─────────────────────────────────────────────────────────────────────

export type STTProviderName = 'deepgram' | 'google' | 'azure';

export interface STTConfig {
  apiKey: string;
  language?: string;
  sampleRate?: number;
}

export interface TranscriptResult {
  text: string;
  isFinal: boolean;
  confidence: number;
  timestamp: number;
}

export interface STTProvider {
  readonly name: STTProviderName;
  connect(config: STTConfig): Promise<void>;
  sendAudio(chunk: Buffer): void;
  onTranscript(cb: (result: TranscriptResult) => void): void;
  onError(cb: (err: Error) => void): void;
  close(): Promise<void>;
  isConnected(): boolean;
}

// ─── Session ──────────────────────────────────────────────────────────────────

export type SessionStatus = 'waiting' | 'active' | 'ended';

export interface Session {
  id: string;
  userId: string;
  agentId: string | null;
  status: SessionStatus;
  sttProvider: STTProviderName;
  sttFallback: STTProviderName;
  language: string;
  createdAt: number;
  startedAt: number | null;
}

export interface AgentInfo {
  id: string;
  activeSessions: string[];
  maxSessions: number;
  connectedAt: number;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

export interface ConnectionContext {
  role: 'overlay' | 'agent';
  id: string;
  sessionId: string | null;
  isAlive: boolean;
}

export interface WSMessage {
  type: string;
  [key: string]: unknown;
}
