import { useEffect, useRef, useSyncExternalStore } from 'react';
import { RING_INNER, RING_OUTER, RING_REACH, ring, wedgeAngle, wedgePath } from '../render/ring';
import { cameraSettings } from '../render/cameraSettings';
import { GLYPHS } from '../render/worldAtlas';

/** Where the labels sit in the band. */
const LABEL_R = (RING_INNER + RING_OUTER) / 2 + 2;
const SIZE = RING_OUTER * 2 + 4;

/**
 * The ring of orders at the cursor (see render/ring.ts for how it's used). It lives over the HUD
 * while open: the backdrop takes the clicks, and the wedge the mouse points at is worked out from
 * its direction, so the aim doesn't have to be exact.
 */
export function RingMenu() {
  const s = useSyncExternalStore(ring.subscribe, () => ring.state);
  const root = useRef<HTMLDivElement>(null);
  const open = s !== null;
  useEffect(() => {
    if (!open) return;
    root.current?.focus({ preventScroll: true });
    const off = (e: PointerEvent) => [e.clientX - (ring.state?.x ?? 0), e.clientY - (ring.state?.y ?? 0)] as const;
    const move = (e: PointerEvent) => {
      const [dx, dy] = off(e);
      ring.aim(dx, dy);
    };
    // Letting go of a hold over a wedge takes it; in the hub, the ring stays open to click.
    const up = (e: PointerEvent) => {
      const st = ring.state;
      if (st?.held && e.button === 2) {
        const [dx, dy] = off(e);
        if (st.aimed && Math.hypot(dx, dy) < RING_REACH) ring.pick();
        else ring.letGo();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [open]);
  if (!s) return null;
  const lit = s.options[s.active];
  const n = s.options.length;
  const press = (e: React.PointerEvent) => {
    e.preventDefault();
    if (ring.state?.held) return;
    const dist = Math.hypot(e.clientX - s.x, e.clientY - s.y);
    if (dist > RING_REACH) ring.close();
    else ring.pick();
  };
  return (
    <div className="ring-backdrop" onPointerDown={press} onContextMenu={(e) => e.preventDefault()} onWheel={() => ring.close()}>
      <div
        className={`ring-menu${cameraSettings.REDUCED_MOTION ? ' calm' : ''}`}
        style={{ left: s.x, top: s.y }}
        role="menu"
        aria-label={`Orders: ${s.title}`}
        aria-activedescendant={`ring-${lit?.key}`}
        tabIndex={-1}
        ref={root}
      >
        <svg className="ring-band" width={SIZE} height={SIZE} viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle className="ring-rim" r={RING_OUTER + 1} />
          {s.options.map((o, i) => (
            <path key={o.key} className={`ring-wedge${i === s.active ? ' lit' : ''}${o.danger ? ' danger' : ''}${o.refused ? ' refused' : ''}`} d={wedgePath(i, n, 0, 0)} />
          ))}
          <circle className="ring-hub" r={RING_INNER - 5} />
        </svg>
        {s.options.map((o, i) => {
          const a = wedgeAngle(i, n);
          const r = n === 1 ? 0 : LABEL_R;
          return (
            <div
              key={o.key}
              id={`ring-${o.key}`}
              role="menuitem"
              aria-disabled={!!o.refused}
              className={`ring-item${i === s.active ? ' lit' : ''}${o.danger ? ' danger' : ''}${o.refused ? ' refused' : ''}`}
              style={{ transform: `translate(calc(${Math.cos(a) * r}px - 50%), calc(${Math.sin(a) * (n === 1 ? -LABEL_R : r)}px - 50%))` }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                <path d={GLYPHS[o.icon]} />
              </svg>
              <span>{o.label}</span>
            </div>
          );
        })}
        <div className="ring-title">{s.title}</div>
        {lit?.detail || lit?.refused ? <div className={`ring-caption${lit.danger ? ' danger' : ''}${lit.refused ? ' refused' : ''}`}>{lit.refused ?? lit.detail}</div> : null}
      </div>
    </div>
  );
}
