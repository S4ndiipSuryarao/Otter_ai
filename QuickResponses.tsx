import { useEffect, useCallback } from 'react';

// ─── Config ───────────────────────────────────────────────────────────────────

const QUICK_RESPONSES = [
  { key: 'F1', label: 'Acknowledged',                   text: 'Acknowledged' },
  { key: 'F2', label: 'One moment please',              text: 'One moment please' },
  { key: 'F3', label: 'Could you repeat that?',         text: 'Could you repeat that?' },
  { key: 'F4', label: "I'll follow up after",           text: "I'll follow up after the meeting" },
  { key: 'F5', label: 'Please go ahead',                text: 'Please go ahead' },
  { key: 'F6', label: 'That is correct',                text: 'That is correct' },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

interface QuickResponsesProps {
  onSend: (text: string) => void;
  /** Disables buttons and hotkeys when not connected. */
  enabled: boolean;
}

/**
 * QuickResponses
 *
 * Renders a grid of preset response buttons and registers F1–F6 hotkeys.
 * Hotkeys fire even when focus is outside the component.
 */
export function QuickResponses({ onSend, enabled }: QuickResponsesProps) {
  const handleSend = useCallback(
    (text: string) => {
      if (!enabled) return;
      onSend(text);
    },
    [enabled, onSend],
  );

  // ─── Global hotkeys ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      // Only fire on bare Fn keys (no modifier combos) to avoid clashing with
      // browser shortcuts like F5=reload, F12=devtools, etc.
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      const match = QUICK_RESPONSES.find(r => r.key === e.key);
      if (!match) return;

      e.preventDefault();
      handleSend(match.text);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, handleSend]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="quick-responses">
      <div className="qr-grid">
        {QUICK_RESPONSES.map(({ key, label, text }) => (
          <button
            key={key}
            className="qr-btn"
            disabled={!enabled}
            onClick={() => handleSend(text)}
            title={text}
          >
            <span className="qr-key">{key}</span>
            <span className="qr-label">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
