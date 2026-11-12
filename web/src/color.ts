import type { CSSProperties } from 'react';

/** Filled pill in a calendar's colour, with black or white text chosen for contrast. */
export function pill(color: string | null | undefined): CSSProperties | undefined {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return undefined;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { background: color, color: luminance > 0.4 ? '#111111' : '#ffffff' };
}
