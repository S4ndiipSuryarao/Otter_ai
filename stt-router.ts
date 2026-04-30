import { createSTTProvider } from './stt/index';
import type { STTProvider, STTConfig, TranscriptResult, STTProviderName } from './types';
import { logger } from './index';

// ─── Per-Session STT Router ──────────────────────────────────────────────────

export class STTRouterSession {
  readonly sessionId: string;
  private primary: STTProvider;
  private fallback: STTProvider | null = null;
  private active: STTProvider;
  private usingFallback = false;
  private config: STTConfig;
  private transcriptCb: ((result: TranscriptResult) => void) | null = null;
  private notifyClientCb: ((event: object) => void) | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  // Audio buffer during provider swap (max 200ms worth)
  private swapBuffer: Buffer[] = [];
  private isSwapping = false;

  constructor(sessionId: string, primaryName: STTProviderName, config: STTConfig) {
    this.sessionId = sessionId;
    this.config = config;
    this.primary = createSTTProvider(primaryName);
    this.active = this.primary;
  }

  async connect(): Promise<void> {
    await this._connectProvider(this.primary);
    logger.info({ sessionId: this.sessionId, provider: this.primary.name }, 'STT router connected');
  }

  private async _connectProvider(provider: STTProvider): Promise<void> {
    await provider.connect(this.config);

    provider.onTranscript((result) => {
      this.transcriptCb?.(result);
    });

    provider.onError(async (err) => {
      logger.error({ err, provider: provider.name, sessionId: this.sessionId }, 'STT provider error');
      await this.handleProviderError(provider);
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  sendAudio(chunk: Buffer): void {
    if (this.isSwapping) {
      this.swapBuffer.push(chunk);
      return;
    }
    if (this.active.isConnected()) {
      this.active.sendAudio(chunk);
    }
  }

  onTranscript(cb: (result: TranscriptResult) => void): void {
    this.transcriptCb = cb;
  }

  onClientNotify(cb: (event: object) => void): void {
    this.notifyClientCb = cb;
  }

  async switchProvider(newProvider: STTProviderName): Promise<void> {
    if (this.active.name === newProvider) return;

    logger.info({ sessionId: this.sessionId, from: this.active.name, to: newProvider }, 'STT provider switch requested');

    this.isSwapping = true;
    const newProv = createSTTProvider(newProvider);

    try {
      // Connect new provider
      await this._connectProvider(newProv);

      // Atomic swap
      const old = this.active;
      this.active = newProv;
      this.primary = newProv;
      this.usingFallback = false;

      // Flush buffered audio
      for (const chunk of this.swapBuffer) {
        newProv.sendAudio(chunk);
      }
      this.swapBuffer = [];
      this.isSwapping = false;

      // Drain old provider
      await new Promise(r => setTimeout(r, 500));
      await old.close();

      this.notifyClientCb?.({ type: 'stt_fallback', provider: newProvider });
      logger.info({ sessionId: this.sessionId, provider: newProvider }, 'STT provider switched successfully');

    } catch (err) {
      logger.error({ err, sessionId: this.sessionId }, 'Failed to switch STT provider');
      this.swapBuffer = [];
      this.isSwapping = false;
      await newProv.close();
    }
  }

  async destroy(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    await this.active.close();
    if (this.fallback && this.fallback !== this.active) {
      await this.fallback.close();
    }
  }

  // ─── Fallback Logic ───────────────────────────────────────────────────────────

  private async handleProviderError(failedProvider: STTProvider): Promise<void> {
    if (this.usingFallback) return; // Already on fallback

    this.usingFallback = true;
    const fallbackName = this._getFallbackName(failedProvider.name);

    if (!fallbackName) {
      logger.error({ sessionId: this.sessionId }, 'No fallback provider available');
      return;
    }

    logger.warn({ sessionId: this.sessionId, fallback: fallbackName }, 'Switching to fallback STT provider');

    try {
      this.fallback = createSTTProvider(fallbackName);
      this.isSwapping = true;

      await this._connectProvider(this.fallback);

      this.active = this.fallback;

      // Flush buffer
      for (const chunk of this.swapBuffer) {
        this.fallback.sendAudio(chunk);
      }
      this.swapBuffer = [];
      this.isSwapping = false;

      this.notifyClientCb?.({ type: 'stt_fallback', provider: fallbackName });

      // Retry primary every 30s
      this.retryTimer = setInterval(() => this.retryPrimary(failedProvider.name), 30_000);

    } catch (err) {
      logger.error({ err, sessionId: this.sessionId, fallback: fallbackName }, 'Fallback connection failed');
      this.isSwapping = false;
      this.swapBuffer = [];
    }
  }

  private async retryPrimary(primaryName: STTProviderName): Promise<void> {
    logger.info({ sessionId: this.sessionId, provider: primaryName }, 'Retrying primary STT provider');
    try {
      const newPrimary = createSTTProvider(primaryName);
      await this._connectProvider(newPrimary);

      if (this.retryTimer) clearInterval(this.retryTimer);

      // Swap back to primary
      const old = this.active;
      this.active = newPrimary;
      this.primary = newPrimary;
      this.usingFallback = false;

      await old.close();
      this.notifyClientCb?.({ type: 'stt_fallback', provider: primaryName });
      logger.info({ sessionId: this.sessionId, provider: primaryName }, 'Primary STT provider restored');

    } catch {
      logger.debug({ sessionId: this.sessionId }, 'Primary STT provider still unavailable');
    }
  }

  private _getFallbackName(failing: STTProviderName): STTProviderName | null {
    // Fallback chain: deepgram → google → azure → null
    const chain: STTProviderName[] = ['deepgram', 'google', 'azure'];
    const idx = chain.indexOf(failing);
    return idx < chain.length - 1 ? chain[idx + 1] : null;
  }
}

// ─── Global STT Router Registry ──────────────────────────────────────────────

export class STTRouter {
  private sessions = new Map<string, STTRouterSession>();

  async createSession(
    sessionId: string,
    providerName: STTProviderName,
    onTranscript: (result: TranscriptResult) => void,
    onClientNotify: (event: object) => void
  ): Promise<STTRouterSession> {
    const config: STTConfig = {
      apiKey: this.getApiKey(providerName),
      language: 'en-US',
      sampleRate: 16000,
    };

    const session = new STTRouterSession(sessionId, providerName, config);
    session.onTranscript(onTranscript);
    session.onClientNotify(onClientNotify);

    await session.connect();
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): STTRouterSession | undefined {
    return this.sessions.get(sessionId);
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.destroy();
      this.sessions.delete(sessionId);
    }
  }

  private getApiKey(provider: STTProviderName): string {
    switch (provider) {
      case 'deepgram': return process.env.DEEPGRAM_API_KEY || '';
      case 'google':   return process.env.GOOGLE_STT_API_KEY || '';
      case 'azure':    return process.env.AZURE_SPEECH_KEY || '';
    }
  }
}
