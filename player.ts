/**
 * AudioPlayer — buffers and plays PCM16 mono audio from the relay server.
 *
 * Design:
 *  - Uses the Web Audio API scheduler for glitch-free playback.
 *  - Each enqueued ArrayBuffer is a raw PCM16 chunk (little-endian, mono,
 *    16 000 Hz — matching the STT pipeline sample rate).
 *  - Chunks are decoded to Float32 and scheduled back-to-back via
 *    AudioBufferSourceNode, maintaining a `scheduledUntil` cursor so new
 *    chunks can be appended at any time without gaps or overlap.
 */
export class AudioPlayer {
  private audioCtx: AudioContext | null = null;
  private scheduledUntil = 0;
  private readonly sampleRate: number;

  constructor(sampleRate = 16_000) {
    this.sampleRate = sampleRate;
  }

  /** Call once after session is assigned to warm up the AudioContext. */
  start(): void {
    if (this.audioCtx) return;
    this.audioCtx = new AudioContext({ sampleRate: this.sampleRate });
    this.scheduledUntil = this.audioCtx.currentTime;
  }

  /** Append a raw PCM16 ArrayBuffer to the playback queue. */
  enqueue(data: ArrayBuffer): void {
    if (!this.audioCtx) return;

    const float32 = this._decodePCM16(data);
    if (float32.length === 0) return;

    const buffer = this.audioCtx.createBuffer(1, float32.length, this.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);

    // Schedule contiguously — never overlap, never gap
    const now = this.audioCtx.currentTime;
    const startAt = Math.max(this.scheduledUntil, now);
    source.start(startAt);
    this.scheduledUntil = startAt + buffer.duration;
  }

  /** Tear down on session end or component unmount. */
  stop(): void {
    this.audioCtx?.close();
    this.audioCtx = null;
    this.scheduledUntil = 0;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _decodePCM16(raw: ArrayBuffer): Float32Array {
    // Guard: must be even number of bytes
    const byteLen = raw.byteLength & ~1; // floor to nearest even
    const int16 = new Int16Array(raw, 0, byteLen / 2);
    const float32 = new Float32Array(int16.length);
    const INV = 1 / 32768;
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] * INV;
    }
    return float32;
  }
}
