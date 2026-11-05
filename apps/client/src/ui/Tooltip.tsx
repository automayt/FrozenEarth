import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DELAY_MS = 320;
/** Moving from one tip to the next within this long shows it at once, like a game's command bar. */
const WARM_MS = 400;

/** "Orders (O)" becomes the words and an engraved key. */
export function splitHotkey(tip: string): { text: string; key?: string } {
  const m = /^(.*\S)\s+\((Esc|Space|[A-Z0-9?])\)\.?$/.exec(tip);
  return m ? { text: m[1], key: m[2] } : { text: tip };
}

/** Takes the title off an element, so the browser's own tooltip never shows, and keeps it as data-tip. */
function adopt(el: HTMLElement): void {
  const t = el.getAttribute('title');
  if (t === null) return;
  el.removeAttribute('title');
  if (t) {
    el.dataset.tip = t;
    el.setAttribute('aria-description', t);
  } else delete el.dataset.tip;
}

interface Shown {
  text: string;
  key?: string;
  box: DOMRect;
}

/**
 * The one tooltip. It serves every element with a title (or a data-tip) on the page, so components
 * keep using plain title attributes and none of them show the browser's version.
 */
export function TipLayer() {
  const [tip, setTip] = useState<Shown | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer = 0;
    let check = 0;
    let lastHide = -1e9;
    let open = false;

    const show = () => {
      if (!target?.isConnected) return hide();
      adopt(target);
      const text = target.dataset.tip;
      if (!text) return hide();
      open = true;
      setTip({ ...splitHotkey(text), box: target.getBoundingClientRect() });
    };
    const hide = () => {
      clearTimeout(timer);
      if (open) lastHide = performance.now();
      open = false;
      target = null;
      setTip(null);
    };
    const aim = (el: HTMLElement) => {
      adopt(el);
      target = el;
      clearTimeout(timer);
      if (performance.now() - lastHide < WARM_MS) show();
      else timer = window.setTimeout(show, DELAY_MS);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title], [data-tip]') ?? null;
      if (el === target) return;
      hide();
      if (el) aim(el);
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.matches?.(':focus-visible') && (el.title || el.dataset.tip)) aim(el);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('blur', hide);
    // React writes a changed title straight back, and buttons can vanish while hovered.
    check = window.setInterval(() => {
      if (!target) return;
      if (!target.isConnected) return hide();
      if (target.hasAttribute('title')) {
        adopt(target);
        if (open) show();
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      clearInterval(check);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('wheel', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Above the thing when it's low on the screen, below when it's high, always on screen.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const above = tip.box.top > window.innerHeight * 0.5;
    const x = Math.max(6, Math.min(window.innerWidth - r.width - 6, tip.box.left + tip.box.width / 2 - r.width / 2));
    const y = above ? tip.box.top - r.height - gap : tip.box.bottom + gap;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(Math.max(6, Math.min(window.innerHeight - r.height - 6, y)))}px`;
    el.dataset.from = above ? 'below' : 'above';
    el.classList.add('placed');
  }, [tip]);

  if (!tip) return null;
  return (
    <div className="tip" ref={card} role="tooltip">
      {tip.text}
      {tip.key && <kbd>{tip.key}</kbd>}
    </div>
  );
}
