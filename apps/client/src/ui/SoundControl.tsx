import { useEffect, useState } from 'react';
import { sound } from '../audio';

/** Mute button plus a volume slider. M toggles mute too. */
export function SoundControl() {
  const [, bump] = useState(0);
  useEffect(() => sound.onChange(() => bump((n) => n + 1)), []);
  return (
    <span className="sound">
      <button
        className={sound.muted ? '' : 'on'}
        title={sound.muted ? 'Sound off (M)' : 'Sound on (M)'}
        onClick={() => {
          sound.unlock();
          sound.toggleMute();
        }}
      >
        {sound.muted ? '🔇' : '🔊'}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={sound.volume}
        aria-label="Volume"
        onChange={(e) => {
          sound.unlock();
          sound.setVolume(Number(e.target.value));
        }}
      />
    </span>
  );
}
