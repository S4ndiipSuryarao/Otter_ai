import { useEffect, useRef, useState, useCallback } from 'react';

interface UsePushToTalkOptions {
  enabled: boolean;
  onAudioChunk: (data: ArrayBuffer) => void;
  onSpeakStart: () => void;
  onSpeakStop: () => void;
  /** PCM sample rate sent to the STT pipeline (must match server expectation). */
  sampleRate?: number;
}

/**
 * usePushToTalk
 *
 * Captures microphone audio while SPACE is held down, encodes each Web Audio
 * buffer as raw PCM16 (Int16, mono, 16 kHz), and calls onAudioChunk for every
 * frame.  Uses ScriptProcessorNode (widely supported) rather than
 * AudioWorklet so it runs without HTTPS/localhost COOP headers.
 *
 * Permissions:
 *  - Requests getUserMedia on first keydown; subsequent presses reuse the
 *    same stream so the browser doesn't prompt again.
 *  - hasPermission is null until the first attempt, then true/false.
 */
export function usePushToTalk({
  enabled,
  onAudioChunk,
  onSpeakStart,
  onSpeakStop,
  sampleRate = 16_000,
}: UsePushToTalkOptions) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  // Refs so handlers inside useEffect don't close over stale state
  const isSpeakingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const onAudioChunkRef = useRef(onAudioChunk);
  const onSpeakStartRef = useRef(onSpeakStart);
  const onSpeakStopRef = useRef(onSpeakStop);
  useEffect(() => { onAudioChunkRef.current = onAudioChunk; }, [onAudioChunk]);
  useEffect(() => { onSpeakStartRef.current = onSpeakStart; }, [onSpeakStart]);
  useEffect(() => { onSpeakStopRef.current = onSpeakStop; }, [onSpeakStop]);

  const stopCapture = useCallback(() => {
    if (!isSpeakingRef.current) return;
    isSpeakingRef.current = false;
    setIsSpeaking(false);
    onSpeakStopRef.current();

    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;

    // Close AudioContext to release CPU
    audioCtxRef.current?.close();
    audioCtxRef.current = null;

    // Stop media tracks (releases mic indicator in OS)
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const startCapture = useCallback(async () => {
    if (isSpeakingRef.current || !enabled) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      setHasPermission(true);
      streamRef.current = stream;

      // AudioContext at target sample rate; browser will resample if needed
      const audioCtx = new AudioContext({ sampleRate });
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // 4096-sample buffer ≈ 256ms at 16 kHz — a good balance of latency vs overhead
      const bufferSize = 4096;
      // @ts-ignore — ScriptProcessorNode is deprecated but AudioWorklet needs HTTPS
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!isSpeakingRef.current) return;

        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        const SCALE = 32767;

        for (let i = 0; i < float32.length; i++) {
          // Clamp to [-1, 1] before scaling to avoid Int16 overflow
          int16[i] = Math.max(-1, Math.min(1, float32[i])) * SCALE;
        }

        // Slice to get a standalone ArrayBuffer (not the shared buffer)
        onAudioChunkRef.current(int16.buffer.slice(0));
      };

      // Source → processor → destination (required to keep the graph running)
      source.connect(processor);
      processor.connect(audioCtx.destination);

      isSpeakingRef.current = true;
      setIsSpeaking(true);
      onSpeakStartRef.current();

    } catch (err) {
      console.error('[PTT] Mic access denied:', err);
      setHasPermission(false);
    }
  }, [enabled, sampleRate]);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      // Prevent page scroll
      e.preventDefault();
      startCapture();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      stopCapture();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      // Make sure we clean up if component unmounts while recording
      stopCapture();
    };
  }, [enabled, startCapture, stopCapture]);

  return { isSpeaking, hasPermission };
}
