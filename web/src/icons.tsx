// Minimal stroke icons (24px grid), currentColor.
import type { ReactNode } from 'react'

const I = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const Icon = {
  cursor: () => <I><path d="M5 3l14 8-6 2-2 6z" /></I>,
  trend: () => <I><path d="M4 19L20 5" /><circle cx="4" cy="19" r="1.5" /><circle cx="20" cy="5" r="1.5" /></I>,
  hline: () => <I><path d="M3 12h18" /><circle cx="12" cy="12" r="1.5" /></I>,
  channel: () => <I><path d="M3 15L15 4M9 20L21 9" /></I>,
  fib: () => <I><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /></I>,
  pitchfork: () => <I><path d="M4 20l8-8M12 12l8-8M12 12l8 2M12 12l2 8" /></I>,
  gann: () => <I><path d="M4 20L20 4M4 20l16-8M4 20l8-16" /></I>,
  pattern: () => <I><path d="M3 17l4-8 4 6 4-10 6 12" /></I>,
  elliott: () => <I><path d="M3 18l3-6 3 3 4-9 3 5 5-6" /></I>,
  rect: () => <I><rect x="4" y="6" width="16" height="12" rx="1" /></I>,
  brush: () => <I><path d="M4 20c4 0 4-4 8-4s5-8 8-12" /></I>,
  text: () => <I><path d="M5 6h14M12 6v13" /></I>,
  ruler: () => <I><path d="M4 16L16 4l4 4L8 20z" /><path d="M8 12l2 2M11 9l2 2M14 6l2 2" /></I>,
  position: () => <I><path d="M4 12h16" /><rect x="6" y="5" width="12" height="7" fill="currentColor" opacity=".25" /><rect x="6" y="12" width="12" height="7" /></I>,
  volume: () => <I><path d="M4 6h8M4 10h12M4 14h6M4 18h10" /></I>,
  magnet: () => <I><path d="M6 4v8a6 6 0 0012 0V4" /><path d="M6 8h4M14 8h4" /></I>,
  lock: () => <I><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></I>,
  eye: () => <I><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></I>,
  eyeOff: () => <I><path d="M3 3l18 18M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3 3.6M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a10 10 0 005.4-1.6" /></I>,
  trash: () => <I><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></I>,
  search: () => <I><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></I>,
  indicators: () => <I><path d="M3 17l5-6 4 3 6-8 3 3" /><path d="M3 21h18" /></I>,
  alert: () => <I><circle cx="12" cy="13" r="7" /><path d="M12 10v3l2 2M5 4L2 7M19 4l3 3" /></I>,
  replay: () => <I><path d="M4 4v6h6" /><path d="M5 15a8 8 0 102-8.5L4 10" /></I>,
  layout: () => <I><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16M3 12h18" /></I>,
  save: () => <I><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></I>,
  sun: () => <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>,
  moon: () => <I><path d="M20 15A8 8 0 019 4a8 8 0 1011 11z" /></I>,
  list: () => <I><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></I>,
  depth: () => <I><path d="M4 20V10M9 20V4M14 20v-8M19 20v-5" /></I>,
  info: () => <I><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></I>,
  code: () => <I><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /></I>,
  flask: () => <I><path d="M9 3h6M10 3v6L4 19a1 1 0 001 2h14a1 1 0 001-2l-6-10V3" /></I>,
  filter: () => <I><path d="M3 5h18l-7 8v6l-4-2v-4z" /></I>,
  wallet: () => <I><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18M16 15h2" /></I>,
  plus: () => <I><path d="M12 5v14M5 12h14" /></I>,
  x: () => <I><path d="M6 6l12 12M18 6L6 18" /></I>,
  chevron: () => <I><path d="M9 6l6 6-6 6" /></I>,
  logout: () => <I><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" /></I>,
  candles: () => <I><path d="M7 4v16M17 4v16" /><rect x="5" y="8" width="4" height="7" fill="currentColor" /><rect x="15" y="6" width="4" height="9" /></I>,
}
