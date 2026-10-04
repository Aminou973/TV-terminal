import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UTCTimestamp } from 'lightweight-charts'
import type { Drawing, DrawingManager } from 'lightweight-charts-drawing'
import { toolLabel } from '../DrawingToolbar'
import { toast } from '../data'
import { priceDigits } from '../markets'
import { useTerminal, useUi, type PaneState } from '../store'
import { parseSpread } from './datasource'
import { useRegistry } from './registry'

export interface MenuState {
  x: number
  y: number
  price: number | null
  time: number | null
  drawingId: string | null
}

interface Props {
  menu: MenuState
  pane: PaneState
  paneId: string
  drawings: DrawingManager
  onReset: () => void
  onSnapshot: () => void
  onClose: () => void
}

type Item = { label: string; hint?: string; danger?: boolean; disabled?: boolean; run: () => void } | 'sep'

export default function ChartMenu({ menu, pane, paneId, drawings: dm, onReset, onSnapshot, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const open = useUi((s) => s.open)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  // keep the menu inside the chart pane
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({
      left: Math.max(4, Math.min(menu.x, parent.clientWidth - w - 4)),
      top: Math.max(4, Math.min(menu.y, parent.clientHeight - h - 4)),
    })
  }, [menu.x, menu.y])

  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // defer so the opening right-click doesn't immediately close it
    const t = setTimeout(() => {
      document.addEventListener('mousedown', away)
      document.addEventListener('contextmenu', away)
    })
    document.addEventListener('keydown', esc)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', away)
      document.removeEventListener('contextmenu', away)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const d = menu.drawingId ? dm.get(menu.drawingId) : undefined
  const tradable = !parseSpread(pane.symbol)
  const px = menu.price
  const pxText = px == null ? '' : px.toFixed(priceDigits(px))
  const changed = () => useRegistry.getState().bump()

  const items: Item[] = d
    ? drawingItems(d)
    : [
        { label: 'Reset chart view', hint: 'Alt+R', run: onReset },
        'sep',
        ...(px != null && tradable
          ? ([
              { label: `Add alert on ${pane.symbol} at ${pxText}`, hint: 'Alt+A', run: () => open({ kind: 'alert', symbol: pane.symbol, price: Number(pxText) }) },
              { label: `Buy ${pane.symbol} @ ${pxText} limit`, run: () => open({ kind: 'order', symbol: pane.symbol, side: 'buy', price: Number(pxText) }) },
              { label: `Sell ${pane.symbol} @ ${pxText} limit`, run: () => open({ kind: 'order', symbol: pane.symbol, side: 'sell', price: Number(pxText) }) },
              'sep',
            ] as Item[])
          : []),
        ...(px != null && menu.time != null
          ? ([
              {
                label: `Draw horizontal line at ${pxText}`,
                hint: 'Alt+H',
                run: () => dm.add({ kind: 'horizontal-line', points: [{ time: menu.time as UTCTimestamp, price: px }] }),
              },
              { label: `Copy price ${pxText}`, run: () => void navigator.clipboard?.writeText(pxText).then(() => toast('Copied', pxText)) },
              'sep',
            ] as Item[])
          : []),
        { label: 'Compare or add symbol…', run: () => open({ kind: 'compare' }) },
        { label: 'Chart settings…', run: () => open({ kind: 'chartSettings' }) },
        { label: 'Take snapshot', hint: 'Alt+S', run: onSnapshot },
        'sep',
        { label: 'Remove all drawings', danger: true, disabled: dm.drawings().length === 0, run: () => dm.clear() },
        {
          label: 'Remove all indicators',
          danger: true,
          disabled: pane.indicators.length === 0,
          run: () => useTerminal.getState().updatePane(useTerminal.getState().active, { indicators: [] }),
        },
      ]

  function drawingItems(dr: Drawing): Item[] {
    const name = dr.name || toolLabel(dr.kind)
    const out: Item[] = [
      { label: `${name} — settings…`, run: () => open({ kind: 'drawingSettings', paneId, drawingId: dr.id }) },
      {
        label: 'Clone',
        run: () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { id, ...rest } = dr
          const nid = dm.add({ ...rest } as never)
          dm.select([nid])
        },
      },
      { label: dr.locked ? 'Unlock' : 'Lock', run: () => dm.update({ ...dr, locked: !dr.locked }) },
      { label: 'Hide', run: () => dm.update({ ...dr, hidden: true }) },
      'sep',
      { label: 'Bring to front', run: () => dm.bringToFront(dr.id) },
      { label: 'Send to back', run: () => dm.sendToBack(dr.id) },
    ]
    if (dr.kind === 'horizontal-line' && tradable) {
      const level = dr.points[0].price
      out.push('sep', {
        label: `Add alert at ${level.toFixed(priceDigits(level))}`,
        run: () => open({ kind: 'alert', symbol: pane.symbol, price: Number(level.toFixed(priceDigits(level))) }),
      })
    }
    out.push('sep', { label: 'Delete', hint: 'Del', danger: true, disabled: !!dr.locked, run: () => dm.remove(dr.id) })
    return out
  }

  return (
    <div ref={ref} className="ctx-menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={`s${i}`} className="ctx-sep" />
        ) : (
          <button
            key={it.label}
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            onClick={() => {
              it.run()
              changed()
              onClose()
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  )
}
