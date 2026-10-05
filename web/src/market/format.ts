// Number formatting for market panels.

/** 3.4T, 512.3B, 12.1M, 950K */
export function compact(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const s = v < 0 ? '-' : ''
  if (a >= 1e12) return `${s}${(a / 1e12).toFixed(digits)}T`
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(digits)}B`
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(digits)}M`
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(digits)}K`
  return `${s}${a.toFixed(a < 10 ? 2 : 0)}`
}

export const pct = (v: number | null | undefined, digits = 2, fraction = false) =>
  v == null || !Number.isFinite(v) ? '—' : `${(fraction ? v * 100 : v).toFixed(digits)}%`

export const signedPct = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`

export const num = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? '—' : v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const priceText = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : num(v, Math.abs(v) < 1 ? 5 : Math.abs(v) < 10 ? 4 : 2)

export function timeAgo(sec: number | null, now = Date.now() / 1000): string {
  if (!sec) return ''
  const d = Math.max(0, now - sec)
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

/** Heatmap colour: red ← 0 → green, saturating at ±`span` percent. */
export function changeColor(p: number | null, span = 3): string {
  if (p == null || !Number.isFinite(p)) return '#4a4e5a'
  const t = Math.max(-1, Math.min(1, p / span))
  const neutral = [66, 70, 82]
  const target = t >= 0 ? [8, 153, 129] : [242, 54, 69]
  const k = Math.abs(t) ** 0.8
  const c = neutral.map((n, i) => Math.round(n + (target[i] - n) * k))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}
