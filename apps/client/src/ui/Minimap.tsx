import { useEffect, useRef } from 'react';
import { ROCKS, TERRAINS } from '@fe/defs';
import { atWar, dispositionOf, frostLevel, frostRadius } from '@fe/sim';
import { DISPOSITION_COLOR } from '../render/renderer';
import { store, useStore } from '../store';

const SIZE = 180;

/** A small overview: terrain, the frost line, settlements, player colonies, colonists, fires and the camera. Click to jump there. */
/** Player colonies by colour, for the tooltip (a canvas can't label its markers on hover). */
function colonyList(): string {
  const m = store.mirror;
  const names = store.players.filter((p) => p.faction && m.factions.has(p.faction)).map((p) => `${p.name}${p.faction === store.me?.faction ? ' (you)' : ''}`);
  return names.length ? ` Colonies: ${names.join(', ')}.` : '';
}

export function Minimap() {
  // Re-render for the tooltip's colony list; the canvas redraws on its own timer.
  useStore();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const base = document.createElement('canvas');
    let baseSig = '';
    const draw = () => {
      const m = store.mirror;
      if (!m.w) return;
      // Terrain is redrawn only when the map changes shape or rock/terrain edits pile up.
      const sig = `${m.w}x${m.h}:${m.rock.reduce((a, v, i) => (v ? a + i : a), 0) % 1e9}`;
      if (sig !== baseSig) {
        baseSig = sig;
        base.width = m.w;
        base.height = m.h;
        const bctx = base.getContext('2d')!;
        const img = bctx.createImageData(m.w, m.h);
        for (let i = 0; i < m.w * m.h; i++) {
          const c = m.rock[i] ? ROCKS[m.rock[i]].color : TERRAINS[m.terrain[i]].color;
          img.data[i * 4] = (c >> 16) & 255;
          img.data[i * 4 + 1] = (c >> 8) & 255;
          img.data[i * 4 + 2] = c & 255;
          img.data[i * 4 + 3] = 255;
        }
        bctx.putImageData(img, 0, 0);
      }
      const sx = SIZE / m.w;
      const sy = SIZE / m.h;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(base, 0, 0, SIZE, SIZE);
      // Frost: whiten everything past the line.
      const r = frostRadius(store.estTick(), m.frost);
      if (r < 1.44) {
        ctx.fillStyle = 'rgba(232,242,255,0.6)';
        const step = 2;
        for (let y = 0; y < m.h; y += step) {
          for (let x = 0; x < m.w; x += step) {
            if (frostLevel(x, y, m.w, m.h, r) > 0.5) ctx.fillRect(x * sx, y * sy, step * sx + 0.5, step * sy + 0.5);
          }
        }
        const half = Math.min(m.w, m.h) / 2;
        ctx.strokeStyle = 'rgba(200,230,255,0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse((m.w / 2) * sx, (m.h / 2) * sy, r * half * sx, r * half * sy, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Fires.
      ctx.fillStyle = '#ff6a20';
      for (const c of m.fireCells) ctx.fillRect((c % m.w) * sx - 1, Math.floor(c / m.w) * sy - 1, 3, 3);
      // Settlements: a diamond coloured by how they feel about you; hollow once abandoned.
      for (const f of m.factions.values()) {
        const st = f.settlement;
        if (!st) continue;
        // Before settling, a town's temper is how it will greet you.
        const d = dispositionOf(st, store.me?.faction ?? 0);
        const x = (f.home.x + 0.5) * sx;
        const y = (f.home.y + 0.5) * sy;
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.closePath();
        const col = st.state === 'fallen' ? '#8796a6' : `#${DISPOSITION_COLOR[d].toString(16).padStart(6, '0')}`;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = st.state === 'home' ? '#000' : col;
        if (st.state === 'home') {
          ctx.fillStyle = col;
          ctx.fill();
        }
        ctx.stroke();
      }
      // Player colonies: a house in the colony's colour, outlined white for yours and red for enemies at war.
      const mineF = store.me?.faction ?? 0;
      for (const f of m.factions.values()) {
        if (!f.isPlayer) continue;
        const x = (f.home.x + 0.5) * sx;
        const y = (f.home.y + 0.5) * sy;
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 5, y - 1);
        ctx.lineTo(x + 5, y + 4);
        ctx.lineTo(x - 5, y + 4);
        ctx.lineTo(x - 5, y - 1);
        ctx.closePath();
        ctx.fillStyle = `#${f.color.toString(16).padStart(6, '0')}`;
        ctx.fill();
        ctx.lineWidth = f.id === mineF ? 2 : 1.5;
        ctx.strokeStyle = f.id === mineF ? '#fff' : mineF && atWar(m, mineF, f.id) ? '#ff4a4a' : '#000';
        ctx.stroke();
      }
      // Colonists, in their faction colour; yours drawn last and bigger.
      const mine = store.me?.faction;
      for (const pass of [0, 1]) {
        for (const e of m.entities.values()) {
          if (e.kind !== 'pawn') continue;
          const own = e.faction === mine;
          if ((pass === 1) !== own) continue;
          const f = m.factions.get(e.faction);
          ctx.fillStyle = f ? `#${f.color.toString(16).padStart(6, '0')}` : '#c04040';
          const s = own ? 4 : 3;
          ctx.fillRect(e.x * sx - s / 2, e.y * sy - s / 2, s, s);
        }
      }
      // The camera's view.
      const v = store.view;
      if (v) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.strokeRect(v.x0 * sx, v.y0 * sy, (v.x1 - v.x0) * sx, (v.y1 - v.y0) * sy);
      }
    };
    draw();
    const timer = window.setInterval(draw, 400);
    return () => clearInterval(timer);
  }, []);

  const jump = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const m = store.mirror;
    if (!m.w) return;
    const b = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - b.left) / b.width) * m.w);
    const y = Math.floor(((e.clientY - b.top) / b.height) * m.h);
    store.set({ focus: { x, y } });
  };

  return (
    <div className="panel minimap" title={`Click to jump there. Houses are player colonies (yours outlined white), diamonds are towns.${colonyList()}`}>
      <canvas ref={ref} width={SIZE} height={SIZE} onMouseDown={jump} />
    </div>
  );
}
