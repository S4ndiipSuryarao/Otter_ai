import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type { STTProvider, STTConfig, TranscriptResult } from '../types';
import { logger } from '../index';

/**
 * Azure Cognitive Services Speech-to-Text adapter.
 *
 * Uses the Azure Speech WebSocket protocol directly (same wire format as the
 * official Speech SDK) so we can stay on raw binary frames without a heavy SDK.
 *
 * Protocol reference:
 *  https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-use-codec-compressed-audio-input-streams
 *
 * Auth: Ocp-Apim-Subscription-Key header (AZURE_SPEECH_KEY env var).
 * Region: AZURE_REGION env var (default: eastus).
 *
 * Wire format for audio messages:
 *   [2-byte big-endian header length][header text][binary PCM payload]
 *
 * No external npm dependency — only the `ws` package already in the project.
 */
export class AzureSTTAdapter implements STTProvider {
  readonly name = 'azure' as const;

  private ws: WebSocket | null = null;
  private connectionId = randomUUID().replace(/-/g, '').toUpperCase();
  private requestId = randomUUID().replace(/-/g, '').toUpperCase();

  private transcriptCb: ((r: TranscriptResult) => void) | null = null;
  private errorCb: ((e: Error) => void) | null = null;
  private _connected = false;

  async connect(config: STTConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const region = process.env.AZURE_REGION ?? 'eastus';
      const lang = config.language ?? 'en-US';

      const url =
        `wss://${region}.stt.speech.microsoft.com/speech/recognition/conversation` +
        `/cognitiveservices/v1?language=${lang}&format=detailed&profanity=raw`;

      this.ws = new WebSocket(url, {
        headers: {
          'Ocp-Apim-Subscription-Key': config.apiKey,
          'X-ConnectionId': this.connectionId,
        },
      });

      const timeout = setTimeout(() => {
        if (!this._connected) reject(new Error('Azure STT: connection timeout'));
      }, 10_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this._sendSpeechConfig(config);
        this._sendTelemetry();
        this._connected = true;
        logger.info({ region, lang }, 'Azure STT: WebSocket connected');
        resolve();
      });

      this.ws.on('message', (raw: WebSocket.Data) => {
        this._handleMessage(raw);
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        logger.error({ err }, 'Azure STT: WebSocket error');
        if (!this._connected) reject(err);
        this.errorCb?.(err);
      });

      this.ws.on('close', (code, reason) => {
        this._connected = false;
        logger.warn({ code, reason: reason.toString() }, 'Azure STT: connection closed');
      });
    });
  }

  // ─── Audio ingestion ────────────────────────────────────────────────────────

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    // Azure binary message layout:
    //   [uint16 header-length][header-string][audio-bytes]
    const header =
      `Path: audio\r\n` +
      `X-RequestId: ${this.requestId}\r\n` +
      `X-Timestamp: ${new Date().toISOString()}\r\n` +
      `Content-Type: audio/x-raw;container=riff;format=PCM;bit=16;channels=1;` +
      `rate=${16000}\r\n\r\n`;

    const headerBuf = Buffer.from(header, 'utf8');
    const lenBuf = Buffer.allocUnsafe(2);
    lenBuf.writeUInt16BE(headerBuf.length, 0);

    this.ws.send(Buffer.concat([lenBuf, headerBuf, chunk]));
  }

  onTranscript(cb: (result: TranscriptResult) => void): void {
    this.transcriptCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  async close(): Promise<void> {
    this._connected = false;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'Session ended');
    }
    this.ws = null;
    logger.info('Azure STT: closed');
  }

  isConnected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _sendSpeechConfig(config: STTConfig): void {
    const payload = {
      context: {
        system: { version: '1.0.0', name: 'VoiceOverlayRelay', build: 'production' },
        os: { platform: 'Node', name: 'Node.js', version: process.version },
        device: { manufacturer: 'Custom', model: 'RelayServer', version: '1.0' },
      },
    };

    const header =
      `Path: speech.config\r\n` +
      `X-RequestId: ${this.requestId}\r\n` +
      `X-Timestamp: ${new Date().toISOString()}\r\n` +
      `Content-Type: application/json\r\n\r\n`;

    this.ws!.send(header + JSON.stringify(payload));
  }

  private _sendTelemetry(): void {
    // Minimal telemetry required by Azure to start a recognition turn
    const payload = {
      ReceivedMessages: [],
      Metrics: [{
        Name: 'Connection',
        Id: this.connectionId,
        Start: new Date().toISOString(),
        End: new Date().toISOString(),
      }],
    };

    const header =
      `Path: telemetry\r\n` +
      `X-RequestId: ${this.requestId}\r\n` +
      `X-Timestamp: ${new Date().toISOString()}\r\n` +
      `Content-Type: application/json\r\n\r\n`;

    this.ws!.send(header + JSON.stringify(payload));
  }

  private _handleMessage(raw: WebSocket.Data): void {
    const msg = raw.toString();

    // Azure wraps JSON in a header section separated by \r\n\r\n
    const sepIdx = msg.indexOf('\r\n\r\n');
    if (sepIdx === -1) return;

    const headerSection = msg.slice(0, sepIdx);
    const body = msg.slice(sepIdx + 4);

    // Extract Path header
    const pathMatch = headerSection.match(/^Path:\s*(.+)$/im);
    if (!pathMatch) return;
    const path = pathMatch[1].trim();

    if (path === 'speech.hypothesis') {
      // Interim result
      try {
        const json = JSON.parse(body);
        if (json.Text) {
          this.transcriptCb?.({
            text: json.Text,
            isFinal: false,
            confidence: 0.8,
            timestamp: Date.now(),
          });
        }
      } catch (e) {
        logger.debug({ err: e }, 'Azure STT: parse error in hypothesis');
      }

    } else if (path === 'speech.phrase') {
      // Final result — use NBest[0] for the best confidence+text pair
      try {
        const json = JSON.parse(body);
        if (json.RecognitionStatus !== 'Success') return;

        const best = json.NBest?.[0];
        const text = best?.Lexical ?? best?.Display ?? json.DisplayText ?? '';
        const confidence = best?.Confidence ?? 0.9;

        if (text.trim()) {
          this.transcriptCb?.({
            text: text.trim(),
            isFinal: true,
            confidence,
            timestamp: Date.now(),
          });
        }
      } catch (e) {
        logger.debug({ err: e }, 'Azure STT: parse error in phrase');
      }

    } else if (path === 'turn.end') {
      // Recognition turn completed — refresh request ID for next turn
      this.requestId = randomUUID().replace(/-/g, '').toUpperCase();
      logger.debug('Azure STT: turn ended, new requestId assigned');
    }
  }
}
