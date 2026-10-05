import { useEffect, useState } from 'react'
import type { Drawing } from 'lightweight-charts-drawing'
import { deleteTemplate, getTemplates, saveTemplate, type Template } from '../api/client'
import { parseSpread } from '../chart/datasource'
import { getPane, useRegistry } from '../chart/registry'
import { toolLabel } from '../DrawingToolbar'
import { toast, useSymbols } from '../data'
import { DEFAULT_SETTINGS, GRID_PANES, newUid, paneSettings, useTerminal, type ChartSettings, type IndicatorInst } from '../store'
import { Modal } from './Modal'

const TIMEZONES = [
  ['exchange', 'Exchange'],
  ['local', 'Local (browser)'],
  ['UTC', 'UTC'],
  ['America/New_York', 'New York'],
  ['America/Chicago', 'Chicago'],
  ['America/Los_Angeles', 'Los Angeles'],
  ['Europe/London', 'London'],
  ['Europe/Paris', 'Paris'],
  ['Europe/Berlin', 'Frankfurt'],
  ['Asia/Dubai', 'Dubai'],
  ['Asia/Kolkata', 'Kolkata'],
  ['Asia/Singapore', 'Singapore'],
  ['Asia/Hong_Kong', 'Hong Kong'],
  ['Asia/Tokyo', 'Tokyo'],
  ['Australia/Sydney', 'Sydney'],
]

/** Colour input that tolerates rgba()/8-digit hex values it can't show. */
function ColorField({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-f]{6}/i.test(value ?? '') ? value!.slice(0, 7) : '#2962ff'
  return (
    <span className="color-field">
      <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} />
      <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="#rrggbb" />
    </span>
  )
}

// ---------------------------------------------------------- chart settings --
export function ChartSettingsDialog({ onClose }: { onClose: () => void }) {
  const pane = useTerminal((s) => s.panes[s.active])
  const setSettings = useTerminal((s) => s.setSettings)
  const s = paneSettings(pane)
  const [tab, setTab] = useState<'symbol' | 'scales' | 'appearance' | 'trading' | 'types'>('symbol')
  const set = (patch: Partial<ChartSettings>) => setSettings(patch) // live preview

  const applyAll = () => {
    const st = useTerminal.getState()
    const n = GRID_PANES[st.grid]
    st.panes.slice(0, n).forEach((p, i) => st.updatePane(i, { settings: { ...p.settings, ...pane.settings } }))
    toast('Settings applied to all charts')
  }

  return (
    <Modal title="Chart settings" onClose={onClose}>
      <div className="seg">
        {(['symbol', 'scales', 'appearance', 'trading', 'types'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'types' ? 'Chart types' : t}
          </button>
        ))}
      </div>
      <div className="form">
        {tab === 'symbol' && (
          <>
            <label><span>Up colour</span><ColorField value={s.upColor} onChange={(v) => set({ upColor: v })} /></label>
            <label><span>Down colour</span><ColorField value={s.downColor} onChange={(v) => set({ downColor: v })} /></label>
            <label><span>Countdown to bar close</span><input type="checkbox" checked={s.countdown} onChange={(e) => set({ countdown: e.target.checked })} /></label>
            <label><span>Previous close line</span><input type="checkbox" checked={s.prevClose} onChange={(e) => set({ prevClose: e.target.checked })} /></label>
            <label><span>Earnings, dividends &amp; splits</span><input type="checkbox" checked={s.events} onChange={(e) => set({ events: e.target.checked })} /></label>
          </>
        )}
        {tab === 'scales' && (
          <>
            <label>
              <span>Price scale</span>
              <select value={s.scale} onChange={(e) => set({ scale: e.target.value as ChartSettings['scale'] })}>
                <option value="normal">Regular</option>
                <option value="log">Logarithmic</option>
                <option value="percent">Percent</option>
                <option value="indexed">Indexed to 100</option>
              </select>
            </label>
            <label><span>Invert scale</span><input type="checkbox" checked={s.invert} onChange={(e) => set({ invert: e.target.checked })} /></label>
            <label>
              <span>Time zone</span>
              <select value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {(pane.compares?.length ?? 0) > 0 && <p className="muted small">Compared symbols force the percent scale.</p>}
          </>
        )}
        {tab === 'appearance' && (
          <>
            <label><span>Grid lines</span><input type="checkbox" checked={s.grid} onChange={(e) => set({ grid: e.target.checked })} /></label>
            <label><span>Volume</span><input type="checkbox" checked={s.volume} onChange={(e) => set({ volume: e.target.checked })} /></label>
            <label><span>Session breaks</span><input type="checkbox" checked={s.sessionBreaks} onChange={(e) => set({ sessionBreaks: e.target.checked })} /></label>
          </>
        )}
        {tab === 'trading' && (
          <>
            <label><span>Orders &amp; positions on chart</span><input type="checkbox" checked={s.trading} onChange={(e) => set({ trading: e.target.checked })} /></label>
            <label><span>Buy / Sell buttons</span><input type="checkbox" checked={s.tradeButtons} onChange={(e) => set({ tradeButtons: e.target.checked })} /></label>
            <label><span>Executions</span><input type="checkbox" checked={s.executions} onChange={(e) => set({ executions: e.target.checked })} /></label>
            <p className="muted small">Drag an order or a TP / SL line to move it. Paper trading only.</p>
          </>
        )}
        {tab === 'types' && (
          <>
            <p className="muted small">Used by Renko, Range, Kagi and Point &amp; Figure. 0 = automatic (ATR-based).</p>
            <label><span>Box / range size</span><input type="number" min={0} step="any" value={s.box} onChange={(e) => set({ box: Math.max(0, Number(e.target.value)) })} /></label>
            <label><span>P&amp;F reversal (boxes)</span><input type="number" min={1} max={10} value={s.reversal} onChange={(e) => set({ reversal: Math.max(1, Number(e.target.value)) })} /></label>
            <label><span>Line break lines</span><input type="number" min={1} max={10} value={s.lineBreak} onChange={(e) => set({ lineBreak: Math.max(1, Number(e.target.value)) })} /></label>
          </>
        )}
      </div>
      <div className="modal-foot">
        <button onClick={() => setSettings({ ...DEFAULT_SETTINGS })}>Defaults</button>
        <button onClick={applyAll}>Apply to all charts</button>
        <span className="spacer" />
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------- compare / spread --
export function CompareDialog({ onClose }: { onClose: () => void }) {
  const pane = useTerminal((s) => s.panes[s.active])
  const symbols = useSymbols((s) => s.list)
  const { addCompare, removeCompare, setSymbol } = useTerminal.getState()
  const [sym, setSym] = useState('')
  const [op, setOp] = useState<'-' | '/' | '+' | '*'>('-')
  const base = parseSpread(pane.symbol)?.a.symbol ?? pane.symbol

  return (
    <Modal title="Compare symbol" onClose={onClose}>
      <input
        autoFocus
        className="search-input"
        list="ot-symbols-cmp"
        placeholder="Symbol to compare, e.g. NQ, SPY, BINANCE-ETHUSDT"
        value={sym}
        onChange={(e) => setSym(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && sym.trim() && (addCompare(sym.trim()), setSym(''))}
      />
      <datalist id="ot-symbols-cmp">
        {symbols.map((s) => <option key={s.symbol} value={s.symbol} />)}
      </datalist>
      <div className="modal-foot">
        <button className="primary" disabled={!sym.trim()} onClick={() => { addCompare(sym.trim()); setSym('') }}>
          Overlay (% change)
        </button>
        <span className="muted">or open spread</span>
        <select value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
          <option value="-">{base} − X</option>
          <option value="/">{base} ÷ X</option>
          <option value="+">{base} + X</option>
          <option value="*">{base} × X</option>
        </select>
        <button disabled={!sym.trim()} onClick={() => { setSymbol(`${base} ${op} ${sym.trim()}`); onClose() }}>
          Open spread
        </button>
      </div>
      <div className="pick-list">
        {(pane.compares ?? []).map((c) => (
          <div key={c} className="layout-row">
            <button onClick={() => {}}><b>{c}</b><small>overlay</small></button>
            <button className="danger" onClick={() => removeCompare(c)}>×</button>
          </div>
        ))}
        {(pane.compares ?? []).length === 0 && (
          <p className="muted pad small">
            Overlays plot other symbols as % change against this chart. Spreads like <code>ES - NQ</code> or <code>2 * GC / SI</code> can
            also be typed straight into symbol search (spaces around the operator).
          </p>
        )}
      </div>
    </Modal>
  )
}

// --------------------------------------------------------- drawing style ---
type Style = Drawing['style']

export function DrawingSettingsDialog({ paneId, drawingId, onClose }: { paneId: string; drawingId: string; onClose: () => void }) {
  useRegistry((s) => s.version)
  const handle = getPane(paneId)
  const original = handle?.drawings.get(drawingId)
  const [style, setStyle] = useState<Style | null>(original ? { ...original.style } : null)
  const [name, setName] = useState(original?.name ?? '')
  const [text, setText] = useState((original as (Drawing & { text?: string }) | undefined)?.text ?? '')
  const [locked, setLocked] = useState(!!original?.locked)
  const [templates, setTemplates] = useState<Template<Style>[]>([])

  useEffect(() => {
    getTemplates<Style>('drawing').then(setTemplates).catch(() => {})
  }, [])

  if (!handle || !original || !style) return null
  const kind = original.kind
  const set = (patch: Partial<Style>) => setStyle({ ...style, ...patch })
  const isText = ['text', 'note', 'price-note', 'pin', 'callout', 'comment', 'signpost', 'price-label', 'flag-mark'].includes(kind)
  const isShape = ['rectangle', 'rotated-rectangle', 'circle', 'ellipse', 'triangle', 'parallel-channel', 'polyline', 'path', 'arc', 'sector', 'price-range', 'date-range', 'date-and-price-range'].includes(kind)
  const isLine = !isText

  const apply = () => {
    const cur = handle.drawings.get(drawingId)
    if (!cur) return onClose()
    const next = { ...cur, style, name: name || undefined, locked } as Drawing & { text?: string }
    if (isText || text) next.text = text
    handle.drawings.update(next as Drawing)
    onClose()
  }

  return (
    <Modal title={`${toolLabel(kind)} settings`} onClose={onClose}>
      <div className="form">
        <label><span>Name</span><input value={name} placeholder={toolLabel(kind)} onChange={(e) => setName(e.target.value)} /></label>
        <label><span>{isText ? 'Text colour' : 'Line colour'}</span><ColorField value={style.color} onChange={(v) => set({ color: v })} /></label>
        {isLine && (
          <>
            <label>
              <span>Width</span>
              <select value={style.width} onChange={(e) => set({ width: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
              </select>
            </label>
            <label>
              <span>Line style</span>
              <select value={style.lineStyle} onChange={(e) => set({ lineStyle: e.target.value as Style['lineStyle'] })}>
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
            </label>
            <label><span>Extend left</span><input type="checkbox" checked={!!style.extendLeft} onChange={(e) => set({ extendLeft: e.target.checked })} /></label>
            <label><span>Extend right</span><input type="checkbox" checked={!!style.extendRight} onChange={(e) => set({ extendRight: e.target.checked })} /></label>
            <label><span>Price labels</span><input type="checkbox" checked={!!style.showPriceLabels} onChange={(e) => set({ showPriceLabels: e.target.checked })} /></label>
            <label><span>Stats</span><input type="checkbox" checked={!!style.showStats} onChange={(e) => set({ showStats: e.target.checked })} /></label>
          </>
        )}
        {(isShape || isText) && (
          <>
            <label><span>Background</span><input type="checkbox" checked={style.fillBackground ?? isShape} onChange={(e) => set({ fillBackground: e.target.checked })} /></label>
            <label><span>Fill colour</span><ColorField value={style.backgroundColor ?? style.color} onChange={(v) => set({ backgroundColor: v })} /></label>
            <label><span>Transparency</span><input type="range" min={0} max={100} value={style.transparency ?? 80} onChange={(e) => set({ transparency: Number(e.target.value) })} /></label>
          </>
        )}
        <label><span>Text</span><input value={text} placeholder={isText ? '' : 'optional label on the line'} onChange={(e) => setText(e.target.value)} /></label>
        <label><span>Text colour</span><ColorField value={style.textColor ?? style.color} onChange={(v) => set({ textColor: v })} /></label>
        <label>
          <span>Font size</span>
          <select value={style.fontSize ?? 14} onChange={(e) => set({ fontSize: Number(e.target.value) })}>
            {[10, 11, 12, 14, 16, 20, 24, 28, 32, 40].map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label><span>Bold / italic</span>
          <span>
            <input type="checkbox" checked={!!style.bold} onChange={(e) => set({ bold: e.target.checked })} /> B{' '}
            <input type="checkbox" checked={!!style.italic} onChange={(e) => set({ italic: e.target.checked })} /> <i>I</i>
          </span>
        </label>
        <label><span>Locked</span><input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} /></label>
      </div>
      <div className="modal-foot">
        <select
          value=""
          onChange={(e) => {
            const t = templates.find((x) => String(x.id) === e.target.value)
            if (t) setStyle({ ...style, ...t.spec })
          }}
        >
          <option value="">Templates…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button
          onClick={async () => {
            const n = window.prompt('Save style as template')
            if (!n) return
            const t = await saveTemplate('drawing', n, style)
            setTemplates((ts) => [...ts.filter((x) => x.name !== n), t])
            toast('Style template saved', n, 'success')
          }}
        >
          Save style
        </button>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={apply}>OK</button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------- indicator templates --
export function IndicatorTemplates({ onApplied }: { onApplied: () => void }) {
  const pane = useTerminal((s) => s.panes[s.active])
  const [list, setList] = useState<Template<IndicatorInst[]>[]>([])
  const [name, setName] = useState('')
  const reload = () => getTemplates<IndicatorInst[]>('indicators').then(setList).catch(() => {})
  useEffect(() => void reload(), [])

  const apply = (t: Template<IndicatorInst[]>, mode: 'replace' | 'add') => {
    const st = useTerminal.getState()
    const fresh = t.spec.map((i) => ({ ...i, uid: newUid() }))
    st.updatePane(st.active, { indicators: mode === 'replace' ? fresh : [...pane.indicators, ...fresh] })
    toast('Template applied', t.name, 'success')
    onApplied()
  }

  return (
    <div className="pick-list">
      <div className="modal-foot">
        <input placeholder={`Save current ${pane.indicators.length} indicator(s) as…`} value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="primary"
          disabled={!name.trim() || pane.indicators.length === 0}
          onClick={async () => {
            await saveTemplate('indicators', name.trim(), pane.indicators)
            setName('')
            void reload()
          }}
        >
          Save template
        </button>
      </div>
      {list.map((t) => (
        <div key={t.id} className="layout-row">
          <button onClick={() => apply(t, 'replace')} title="Replace this chart's indicators">
            <b>{t.name}</b>
            <small>{t.spec.map((i) => i.id.replace(/^script:/, '')).join(', ')}</small>
          </button>
          <button onClick={() => apply(t, 'add')} title="Add to this chart's indicators">+</button>
          <button className="danger" onClick={() => deleteTemplate(t.id).then(reload)}>×</button>
        </div>
      ))}
      {list.length === 0 && <p className="muted pad">No templates yet — set up indicators on a chart, then save them here.</p>}
    </div>
  )
}
