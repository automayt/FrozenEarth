import { useEffect, useState, type ReactNode } from 'react';
import { sound } from '../audio';
import { toggleFullscreen } from '../chrome';
import { QUALITY, qualityOf, UI_SCALE_MAX, UI_SCALE_MIN, updateSettings, useSettings, type Quality, type Settings, type WeatherDensity } from '../settings';
import { Icon } from './Icon';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </div>
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`lever ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <i />
      <span>{on ? 'On' : 'Off'}</span>
    </button>
  );
}

function Choose<T extends string>({ value, options, label, onChange }: { value: T | null; options: [T, string][]; label: string; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Slider({ value, min, max, step, label, shown, onChange }: { value: number; min: number; max: number; step: number; label: string; shown: string; onChange: (v: number) => void }) {
  return (
    <span className="slide">
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} style={{ ['--at' as string]: `${((value - min) / (max - min)) * 100}%` }} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{shown}</output>
    </span>
  );
}

/**
 * One row per channel. Add a row to CHANNELS for each new channel audio.ts offers; `sound` already
 * re-renders this section when it changes.
 */
function AudioSection() {
  const [, bump] = useState(0);
  useEffect(() => sound.onChange(() => bump((n) => n + 1)), []);
  const CHANNELS: { label: string; get: () => number; set: (v: number) => void }[] = [
    { label: 'Master volume', get: () => sound.volume, set: (v) => sound.setVolume(v) },
    { label: 'Music', get: () => sound.getVolume('music'), set: (v) => sound.setVolume('music', v) },
    { label: 'Ambience', get: () => sound.getVolume('ambience'), set: (v) => sound.setVolume('ambience', v) },
    { label: 'Effects', get: () => sound.getVolume('effects'), set: (v) => sound.setVolume('effects', v) },
    { label: 'Interface', get: () => sound.getVolume('interface'), set: (v) => sound.setVolume('interface', v) },
  ];
  return (
    <section>
      <h3>Audio</h3>
      {CHANNELS.map((c) => (
        <Row key={c.label} label={c.label}>
          <Slider
            value={c.get()}
            min={0}
            max={1}
            step={0.05}
            label={c.label}
            shown={`${Math.round(c.get() * 100)}%`}
            onChange={(v) => {
              sound.unlock();
              c.set(v);
            }}
          />
        </Row>
      ))}
    </section>
  );
}

/** The settings screen, from the title and the Escape menu alike. Everything applies and saves at once. */
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const set = (patch: Partial<Settings>) => updateSettings(patch);
  return (
    <div className="panel sheet" role="dialog" aria-label="Settings">
      <button className="close" onClick={onClose} aria-label="Close settings">
        <Icon name="close" size={18} />
      </button>
      <h2>Settings</h2>
      <section>
        <h3>Interface</h3>
        <Row label="Interface size" hint="Small windows cap this so everything still fits">
          <Slider value={s.uiScale} min={UI_SCALE_MIN} max={UI_SCALE_MAX} step={0.05} label="Interface size" shown={`${Math.round(s.uiScale * 100)}%`} onChange={(uiScale) => set({ uiScale })} />
        </Row>
        <Row label="Fullscreen" hint="F11">
          <Toggle on={s.fullscreen} label="Fullscreen" onChange={toggleFullscreen} />
        </Row>
        <Row label="Reduced motion" hint="Panels, numbers, frost and plants hold still">
          <Toggle on={s.reducedMotion} label="Reduced motion" onChange={(reducedMotion) => set({ reducedMotion })} />
        </Row>
        <Row label="Screen shake">
          <Toggle on={s.screenShake} label="Screen shake" onChange={(screenShake) => set({ screenShake })} />
        </Row>
        <Row label="Edge scrolling" hint="Pan when the mouse rests at the edge of the screen">
          <Toggle on={s.edgeScroll} label="Edge scrolling" onChange={(edgeScroll) => set({ edgeScroll })} />
        </Row>
        <Row label="Big moments" hint="The camera goes to look when something big happens">
          <Toggle on={s.bigMoments} label="Big moments" onChange={(bigMoments) => set({ bigMoments })} />
        </Row>
      </section>
      <section>
        <h3>Graphics</h3>
        <Row label="Quality" hint={qualityOf(s) ? undefined : 'Custom'}>
          <Choose<Quality>
            label="Quality"
            value={qualityOf(s)}
            options={[
              ['low', 'Low'],
              ['medium', 'Medium'],
              ['high', 'High'],
            ]}
            onChange={(q) => set(QUALITY[q])}
          />
        </Row>
        <Row label="Weather">
          <Choose<WeatherDensity>
            label="Weather density"
            value={s.weather}
            options={[
              ['off', 'Off'],
              ['light', 'Light'],
              ['full', 'Full'],
            ]}
            onChange={(weather) => set({ weather })}
          />
        </Row>
        <Row label="Plants sway">
          <Toggle on={s.plantSway} label="Plants sway" onChange={(plantSway) => set({ plantSway })} />
        </Row>
        <Row label="Sun shadows">
          <Toggle on={s.shadows} label="Sun shadows" onChange={(shadows) => set({ shadows })} />
        </Row>
        <Row label="Birds and fireflies">
          <Toggle on={s.wildlife} label="Birds and fireflies" onChange={(wildlife) => set({ wildlife })} />
        </Row>
        <Row label="Footprints, breath and smoke">
          <Toggle on={s.details} label="Footprints, breath and smoke" onChange={(details) => set({ details })} />
        </Row>
      </section>
      <AudioSection />
    </div>
  );
}
