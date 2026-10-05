import { describe, expect, it } from 'vitest'
import { changeColor, compact, signedPct, timeAgo } from './format'
import { squarify } from './treemap'

describe('treemap', () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ id: i, v }))
  const tiles = squarify(items, (t) => t.v, { x: 0, y: 0, w: 600, h: 400 })
  it('covers the rectangle exactly with areas proportional to weight', () => {
    expect(tiles).toHaveLength(7)
    const area = tiles.reduce((s, t) => s + t.w * t.h, 0)
    expect(area).toBeCloseTo(600 * 400)
    for (const t of tiles) expect(t.w * t.h).toBeCloseTo((t.item.v / 24) * 600 * 400)
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-9)
      expect(t.y).toBeGreaterThanOrEqual(-1e-9)
      expect(t.x + t.w).toBeLessThanOrEqual(600 + 1e-6)
      expect(t.y + t.h).toBeLessThanOrEqual(400 + 1e-6)
    }
  })
  it('keeps tiles reasonably square', () => {
    const worst = Math.max(...tiles.map((t) => Math.max(t.w / t.h, t.h / t.w)))
    expect(worst).toBeLessThan(3)
  })
  it('does not overlap', () => {
    for (let i = 0; i < tiles.length; i++)
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i]
        const b = tiles[j]
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        expect(ox <= 1e-6 || oy <= 1e-6).toBe(true)
      }
  })
  it('handles empty and zero weights', () => {
    expect(squarify([], () => 1, { x: 0, y: 0, w: 10, h: 10 })).toEqual([])
    expect(squarify([{ v: 0 }, { v: 2 }], (t) => t.v, { x: 0, y: 0, w: 10, h: 10 })).toHaveLength(1)
  })
})

describe('format', () => {
  it('compacts big numbers', () => {
    expect(compact(3.4e12)).toBe('3.4T')
    expect(compact(512.34e9)).toBe('512.3B')
    expect(compact(-12.1e6)).toBe('-12.1M')
    expect(compact(950)).toBe('950')
    expect(compact(null)).toBe('—')
  })
  it('formats change and age', () => {
    expect(signedPct(1.234)).toBe('+1.23%')
    expect(signedPct(-0.5)).toBe('-0.50%')
    expect(timeAgo(1000 - 90, 1000)).toBe('1m ago')
    expect(timeAgo(1000 - 7200, 1000)).toBe('2h ago')
  })
  it('colours by change', () => {
    expect(changeColor(10)).toBe('rgb(8, 153, 129)')
    expect(changeColor(-10)).toBe('rgb(242, 54, 69)')
    expect(changeColor(0)).toBe('rgb(66, 70, 82)')
  })
})
