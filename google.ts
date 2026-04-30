import speech from '@google-cloud/speech';
import type { STTProvider, STTConfig, TranscriptResult } from '../types';
import { logger } from '../index';

/**
 * Google Cloud Speech-to-Text v2 streaming adapter.
 *
 * Auth: uses `apiKey` from STTConfig (passed via GOOGLE_STT_API_KEY env var).
 * The @google-cloud/speech client accepts { apiKey } directly in its
 * constructor options — no service account required for basic streaming.
 *
 * Install: npm i @google-cloud/speech
 */
export class GoogleSTTAdapter implements STTProvider {
  readonly name = 'google' as const;

  private client: speech.SpeechClient | null = null;
  private recognizeStream: ReturnType<speech.SpeechClient['streamingRecognize']> | null = null;
  private transcriptCb: ((r: TranscriptResult) => void) | null = null;
  private errorCb: ((e: Error) => void) | null = null;
  private _connected = false;

  async connect(config: STTConfig): Promise<void> {
    this.client = new speech.SpeechClient({ apiKey: config.apiKey });

    this.recognizeStream = this.client
      .streamingRecognize({
        config: {
          encoding: 'LINEAR16' as const,
          sampleRateHertz: config.sampleRate ?? 16_000,
          languageCode: config.language ?? 'en-US',
          enableAutomaticPunctuation: true,
          model: 'latest_long',
          useEnhanced: true,
        },
        interimResults: true,
      })
      .on('error', (err: Error) => {
        this._connected = false;
        logger.error({ err }, 'Google STT: stream error');
        this.errorCb?.(err);
      })
      .on('data', (data: speech.protos.google.cloud.speech.v1.IStreamingRecognizeResponse) => {
        const result = data.results?.[0];
        if (!result?.alternatives?.[0]) return;

        const alt = result.alternatives[0];
        this.transcriptCb?.({
          text: alt.transcript ?? '',
          isFinal: result.isFinal ?? false,
          // Google returns confidence only on final results; default 0.9 for interim
          confidence: (result.isFinal ? alt.confidence : 0.9) ?? 0.9,
          timestamp: Date.now(),
        });
      })
      .on('end', () => {
        this._connected = false;
        logger.info('Google STT: stream ended');
      });

    this._connected = true;
    logger.info({ language: config.language ?? 'en-US' }, 'Google STT: streaming started');
  }

  sendAudio(chunk: Buffer): void {
    if (!this._connected || !this.recognizeStream || this.recognizeStream.destroyed) return;
    this.recognizeStream.write(chunk);
  }

  onTranscript(cb: (result: TranscriptResult) => void): void {
    this.transcriptCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  async close(): Promise<void> {
    this._connected = false;

    if (this.recognizeStream && !this.recognizeStream.destroyed) {
      // Signal end-of-stream so Google flushes the final result
      this.recognizeStream.end();
      await new Promise<void>(r => {
        this.recognizeStream!.once('end', r);
        // Safety timeout — don't wait forever
        setTimeout(r, 1_000);
      });
    }

    if (this.client) {
      await this.client.close();
      this.client = null;
    }

    logger.info('Google STT: closed');
  }

  isConnected(): boolean {
    return this._connected &&
      !!this.recognizeStream &&
      !this.recognizeStream.destroyed;
  }
}
