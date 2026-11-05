export function hex(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}

export function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

/** Up and down walk a list of choices, like any game menu. */
export function walkChoices(e: { key: string; currentTarget: EventTarget | null; preventDefault(): void }): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const all = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.choice:not(:disabled)')];
  const at = all.indexOf(document.activeElement as HTMLButtonElement);
  const to = e.key === 'ArrowDown' ? at + 1 : at <= 0 ? all.length - 1 : at - 1;
  all[to % all.length]?.focus();
}
