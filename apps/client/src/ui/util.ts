export function hex(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}

export function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}
