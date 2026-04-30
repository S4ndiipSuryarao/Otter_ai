import WebSocket from 'ws';
import type { STTProvider, STTConfig, TranscriptResult } from '../types';
import { logger } from '../index';

export class DeepgramAdapter implements STTProvider {
  name = 'deepgram' as const;
  private ws: WebSocket | null = null;
  private transcriptCb: ((r: TranscriptResult) => void) | null = null;
  private errorCb: ((e: Error) => void) | null = null;
  private _connected = false;

  async connect(config: STTConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: 'nova-2',
        language: config.language || 'en-US',
        interim_results: 'true',
        vad_events: 'true',
        encoding: 'linear16',
        sample_rate: String(config.sampleRate || 16000),
        channels: '1',
        endpointing: '300',
        utterance_end_ms: '1000',
      });

      const url = `wss://api.deepgram.com/v1/listen?${params}`;

      this.ws = new WebSocket(url, {
        headers: { Authorization: `Token ${config.apiKey}` },
      });

      this.ws.on('open', () => {
        this._connected = true;
        logger.info('Deepgram: WebSocket connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'Results') {
            const alt = msg.channel?.alternatives?.[0];
            if (!alt?.transcript) return;

            this.transcriptCb?.({
              text: alt.transcript,
              isFinal: msg.is_final ?? false,
              confidence: alt.confidence ?? 1,
              timestamp: Date.now(),
            });
          } else if (msg.type === 'UtteranceEnd') {
            // Force a final flush — useful when agent stops speaking
            logger.debug('Deepgram: utterance end');
          } else if (msg.type === 'SpeechStarted') {
            logger.debug('Deepgram: speech started');
          }
        } catch (e) {
          logger.warn({ err: e }, 'Deepgram: message parse error');
        }
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        logger.error({ err }, 'Deepgram: WebSocket error');
        if (!this._connected) reject(err);
        this.errorCb?.(err);
      });

      this.ws.on('close', (code, reason) => {
        this._connected = false;
        logger.warn({ code, reason: reason.toString() }, 'Deepgram: connection closed');
      });

      // Connection timeout
      setTimeout(() => {
        if (!this._connected) reject(new Error('Deepgram: connection timeout'));
      }, 10_000);
    });
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  onTranscript(cb: (result: TranscriptResult) => void): void {
    this.transcriptCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  async close(): Promise<void> {
    this._connected = false;
    if (this.ws) {
      // Send close frame per Deepgram spec
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        await new Promise(r => setTimeout(r, 100));
      }
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }
}
