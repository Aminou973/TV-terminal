// Squarified treemap (Bruls, Huizing & van Wijk) — lays out weighted items in
// a rectangle with tiles as close to square as possible.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Placed<T> = Rect & { item: T }

function worst(row: number[], side: number): number {
  const s = row.reduce((a, b) => a + b, 0)
  const max = Math.max(...row)
  const min = Math.min(...row)
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min))
}

/** Lay out `items` (weight from `value`) inside `rect`. Zero / negative weights are dropped. */
export function squarify<T>(items: T[], value: (t: T) => number, rect: Rect): Placed<T>[] {
  const total = items.reduce((s, t) => s + Math.max(0, value(t)), 0)
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return []
  const scale = (rect.w * rect.h) / total
  const queue = items
    .filter((t) => value(t) > 0)
    .map((t) => ({ item: t, area: value(t) * scale }))
    .sort((a, b) => b.area - a.area)
  const out: Placed<T>[] = []
  let { x, y, w, h } = rect
  let row: typeof queue = []
  const layoutRow = () => {
    const s = row.reduce((a, r) => a + r.area, 0)
    if (w >= h) {
      // column on the left
      const cw = s / h
      let cy = y
      for (const r of row) {
        const rh = r.area / cw
        out.push({ item: r.item, x, y: cy, w: cw, h: rh })
        cy += rh
      }
      x += cw
      w -= cw
    } else {
      const rh = s / w
      let cx = x
      for (const r of row) {
        const rw = r.area / rh
        out.push({ item: r.item, x: cx, y, w: rw, h: rh })
        cx += rw
      }
      y += rh
      h -= rh
    }
    row = []
  }
  for (const next of queue) {
    const side = Math.min(w, h)
    if (row.length === 0 || worst([...row.map((r) => r.area), next.area], side) <= worst(row.map((r) => r.area), side)) {
      row.push(next)
    } else {
      layoutRow()
      row.push(next)
    }
  }
  if (row.length) layoutRow()
  return out
}
