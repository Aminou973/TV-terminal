import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './icons'
import { useTerminal } from './store'

// TradingView's left-toolbar grouping of the drawing package's tools.
export const TOOL_GROUPS: { id: string; title: string; icon: () => ReactNode; tools: string[] }[] = [
  {
    id: 'lines', title: 'Trend line tools', icon: Icon.trend,
    tools: ['trend-line', 'ray', 'info-line', 'extended-line', 'trend-angle', 'horizontal-line', 'horizontal-ray', 'vertical-line', 'cross-line'],
  },
  {
    id: 'channels', title: 'Channels', icon: Icon.channel,
    tools: ['parallel-channel', 'regression-trend', 'flat-top-bottom', 'disjoint-channel'],
  },
  {
    id: 'pitchforks', title: 'Pitchforks', icon: Icon.pitchfork,
    tools: ['pitchfork', 'schiff-pitchfork', 'modified-schiff-pitchfork', 'inside-pitchfork'],
  },
  {
    id: 'fib', title: 'Fibonacci tools', icon: Icon.fib,
    tools: [
      'fib-retracement', 'trend-based-fib-extension', 'fib-channel', 'fib-time-zone', 'fib-speed-resistance-fan',
      'trend-based-fib-time', 'fib-circles', 'fib-spiral', 'fib-speed-resistance-arcs', 'fib-wedge', 'pitchfan',
    ],
  },
  { id: 'gann', title: 'Gann tools', icon: Icon.gann, tools: ['gann-box', 'gann-square-fixed', 'gann-square', 'gann-fan'] },
  {
    id: 'patterns', title: 'Patterns', icon: Icon.pattern,
    tools: ['xabcd-pattern', 'cypher-pattern', 'head-and-shoulders', 'abcd-pattern', 'triangle-pattern', 'three-drives-pattern'],
  },
  {
    id: 'elliott', title: 'Elliott waves & cycles', icon: Icon.elliott,
    tools: ['elliott-impulse', 'elliott-correction', 'elliott-triangle', 'elliott-double-combo', 'elliott-triple-combo', 'cyclic-lines', 'time-cycles', 'sine-line'],
  },
  {
    id: 'forecast', title: 'Forecasting & measuring', icon: Icon.position,
    tools: ['long-position', 'short-position', 'position-forecast', 'bar-pattern', 'ghost-feed', 'price-range', 'date-range', 'date-and-price-range'],
  },
  { id: 'volume', title: 'Volume-based tools', icon: Icon.volume, tools: ['anchored-vwap', 'fixed-range-volume-profile', 'anchored-volume-profile'] },
  {
    id: 'shapes', title: 'Brushes, arrows & shapes', icon: Icon.brush,
    tools: [
      'brush', 'highlighter', 'arrow-marker', 'arrow', 'arrow-mark-up', 'arrow-mark-down', 'rectangle', 'rotated-rectangle',
      'path', 'circle', 'ellipse', 'polyline', 'triangle', 'arc', 'curve', 'double-curve', 'sector',
    ],
  },
  {
    id: 'text', title: 'Text & notes', icon: Icon.text,
    tools: ['text', 'note', 'price-note', 'pin', 'table', 'callout', 'comment', 'price-label', 'signpost', 'flag-mark'],
  },
]

export const toolLabel = (kind: string) =>
  kind
    .split('-')
    .map((w) => (w === 'xabcd' || w === 'abcd' ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace('Fib ', 'Fib ')

export default function DrawingToolbar() {
  const tool = useTerminal((s) => s.drawingTool)
  const setTool = useTerminal((s) => s.setDrawingTool)
  const magnet = useTerminal((s) => s.magnet)
  const setMagnet = useTerminal((s) => s.setMagnet)
  const stay = useTerminal((s) => s.stayInDrawing)
  const setStay = useTerminal((s) => s.setStayInDrawing)
  const hidden = useTerminal((s) => s.drawingsHidden)
  const setHidden = useTerminal((s) => s.setDrawingsHidden)
  const favTools = useTerminal((s) => s.favTools)
  const toggleFav = useTerminal((s) => s.toggleFavTool)
  const [showFavs, setShowFavs] = useState(true)
  const [lastUsed, setLastUsed] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(null)
        setTool(null)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [setTool])

  const pick = (groupId: string, kind: string) => {
    setLastUsed((m) => ({ ...m, [groupId]: kind }))
    setTool(tool === kind ? null : kind)
    setOpen(null)
  }

  return (
    <div className="draw-toolbar" ref={ref}>
      <button className={`tb ${tool === null ? 'on' : ''}`} title="Cursor (Esc)" onClick={() => setTool(null)}>
        <Icon.cursor />
      </button>
      <div className="tb-sep" />
      {TOOL_GROUPS.map((g) => {
        const current = lastUsed[g.id] ?? g.tools[0]
        const activeInGroup = tool != null && g.tools.includes(tool)
        return (
          <div key={g.id} className="tb-group">
            <button
              className={`tb ${activeInGroup ? 'on' : ''}`}
              title={`${toolLabel(activeInGroup ? tool! : current)}`}
              onClick={() => pick(g.id, activeInGroup ? tool! : current)}
            >
              <g.icon />
            </button>
            <button className="tb-more" title={g.title} onClick={() => setOpen(open === g.id ? null : g.id)}>
              ›
            </button>
            {open === g.id && (
              <div className="tb-flyout">
                <div className="tb-flyout-title">{g.title}</div>
                {g.tools.map((k) => (
                  <div key={k} className="dd-row">
                    <button className={tool === k ? 'on' : ''} onClick={() => pick(g.id, k)}>
                      {toolLabel(k)}
                    </button>
                    <button className={`star ${favTools.includes(k) ? 'on' : ''}`} title="Favourite" onClick={() => toggleFav(k)}>
                      ★
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div className="tb-sep" />
      <button className={`tb ${showFavs ? 'on' : ''}`} title="Favourite tools bar" onClick={() => setShowFavs(!showFavs)}>
        <Icon.star />
      </button>
      {showFavs && favTools.length > 0 && (
        <div className="fav-bar" role="toolbar" aria-label="Favourite drawing tools">
          {favTools.map((k) => (
            <button key={k} className={tool === k ? 'on' : ''} onClick={() => setTool(tool === k ? null : k)} title={toolLabel(k)}>
              {toolLabel(k)}
            </button>
          ))}
        </div>
      )}
      <button
        className={`tb ${magnet !== 'off' ? 'on' : ''}`}
        title={`Magnet: ${magnet}`}
        onClick={() => setMagnet(magnet === 'off' ? 'weak' : magnet === 'weak' ? 'strong' : 'off')}
      >
        <Icon.magnet />
        {magnet === 'strong' && <span className="tb-badge">S</span>}
      </button>
      <button className={`tb ${stay ? 'on' : ''}`} title="Stay in drawing mode" onClick={() => setStay(!stay)}>
        <Icon.lock />
      </button>
      <button className={`tb ${hidden ? 'on' : ''}`} title={hidden ? 'Show drawings' : 'Hide drawings'} onClick={() => setHidden(!hidden)}>
        {hidden ? <Icon.eyeOff /> : <Icon.eye />}
      </button>
      <button
        className="tb"
        title="Remove all drawings (active chart)"
        onClick={() => {
          if (window.confirm('Remove all drawings on this symbol?')) window.dispatchEvent(new Event('ot:clear-drawings'))
        }}
      >
        <Icon.trash />
      </button>
    </div>
  )
}
