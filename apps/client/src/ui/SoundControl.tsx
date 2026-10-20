import { useEffect, useState } from 'react';
import { sound } from '../audio';
import { Icon } from './Icon';

/** Mute button plus a volume slider. M toggles mute too. */
export function SoundControl() {
  const [, bump] = useState(0);
  useEffect(() => sound.onChange(() => bump((n) => n + 1)), []);
  return (
    <span className="sound">
      <button
        className={`icon-btn ${sound.muted ? '' : 'on'}`}
        aria-label={sound.muted ? 'Turn sound on' : 'Turn sound off'}
        title={sound.muted ? 'Sound off (M)' : 'Sound on (M)'}
        onClick={() => {
          sound.unlock();
          sound.toggleMute();
        }}
      >
        <Icon name={sound.muted ? 'mute' : 'sound'} size={18} />
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
