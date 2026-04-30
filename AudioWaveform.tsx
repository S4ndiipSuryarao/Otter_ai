import { useEffect, useRef } from 'react';

interface AudioWaveformProps {
  isActive: boolean;
  color?: string;
  height?: number;
}

/**
 * AudioWaveform
 *
 * A lightweight canvas-based waveform display.
 * - isActive=false → static flat line at half-height (idle state).
 * - isActive=true  → animates bar-style waveform using a sine approximation
 *   so it looks lively even without access to real AudioAnalyserNode data
 *   (agent dashboard doesn't have a live AnalyserNode reference here).
 *
 * For a production upgrade, replace the sine animation with real AnalyserNode
 * data by accepting an optional `analyser: AnalyserNode` prop.
 */
export function AudioWaveform({
  isActive,
  color = '#00ff9d',
  height = 56,
}: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;

    // ── Idle: single flat line ───────────────────────────────────────────
    if (!isActive) {
      cancelAnimationFrame(rafRef.current);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = `${color}44`;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
      return;
    }

    // ── Active: animated bar waveform ────────────────────────────────────
    const BAR_COUNT = 48;
    let frame = 0;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barW = canvas.width / BAR_COUNT;
      const centerY = canvas.height / 2;
      const maxAmp = centerY * 0.88;

      for (let i = 0; i < BAR_COUNT; i++) {
        // Two sine waves with different frequencies for an organic look
        const t = frame * 0.06 + i * 0.38;
        const amp = (Math.sin(t) * 0.6 + Math.sin(t * 1.7 + 1.2) * 0.4) * 0.5 + 0.5;
        const barH = Math.max(2, amp * maxAmp);
        const x = i * barW + barW / 2;

        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, barW - 2);
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.55 + amp * 0.45;
        ctx.beginPath();
        ctx.moveTo(x, centerY - barH);
        ctx.lineTo(x, centerY + barH);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      frame++;
      rafRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [isActive, color, height]);

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={height}
      style={{
        width: '100%',
        height,
        display: 'block',
        borderRadius: 4,
      }}
    />
  );
}
