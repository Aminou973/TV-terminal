import type { Drawing } from 'lightweight-charts-drawing'
import { getPane, useRegistry } from '../chart/registry'
import { toolLabel } from '../DrawingToolbar'
import { Icon } from '../icons'
import { useTerminal, useUi } from '../store'

/** Everything on the active chart: indicators and drawings, with visibility/lock/delete. */
export default function ObjectTree() {
  useRegistry((s) => s.version)
  const pane = useTerminal((s) => s.panes[s.active])
  const { updateIndicator, removeIndicator, removeCompare } = useTerminal.getState()
  const open = useUi((s) => s.open)
  const handle = getPane(pane.id)
  const dm = handle?.drawings
  const drawings: readonly Drawing[] = dm?.drawings() ?? []
  const selected = new Set(dm?.selection() ?? [])
  const bump = () => useRegistry.getState().bump()

  return (
    <div className="panel objects">
      <div className="panel-title plain">{pane.symbol} · {pane.tf}</div>
      <div className="list">
        <div className="obj-group">Indicators ({pane.indicators.length})</div>
        {pane.indicators.map((i) => (
          <div key={i.uid} className={`obj-row ${i.hidden ? 'muted' : ''}`}>
            <span className="obj-name">{i.id.replace(/^script:/, '✎ ')}</span>
            <button title={i.hidden ? 'Show' : 'Hide'} onClick={() => updateIndicator(i.uid, { hidden: !i.hidden })}>
              {i.hidden ? <Icon.eyeOff /> : <Icon.eye />}
            </button>
            <button title="Settings" onClick={() => open({ kind: 'indicatorSettings', uid: i.uid })}><Icon.gear /></button>
            <button title="Remove" onClick={() => removeIndicator(i.uid)}><Icon.trash /></button>
          </div>
        ))}
        {(pane.compares ?? []).length > 0 && <div className="obj-group">Compared symbols</div>}
        {(pane.compares ?? []).map((c) => (
          <div key={c} className="obj-row">
            <span className="obj-name">{c}</span>
            <button title="Remove" onClick={() => removeCompare(c)}><Icon.trash /></button>
          </div>
        ))}
        <div className="obj-group">Drawings ({drawings.length})</div>
        {drawings.length === 0 && <p className="muted pad small">Nothing drawn on {pane.symbol} yet.</p>}
        {[...drawings].reverse().map((d) => (
          <div
            key={d.id}
            className={`obj-row ${d.hidden ? 'muted' : ''} ${selected.has(d.id) ? 'on' : ''}`}
            onClick={() => {
              dm?.select([d.id])
              bump()
            }}
            onDoubleClick={() => open({ kind: 'drawingSettings', paneId: pane.id, drawingId: d.id })}
          >
            <span className="obj-swatch" style={{ background: d.style.color }} />
            <span className="obj-name">{d.name || toolLabel(d.kind)}</span>
            <button
              title={d.hidden ? 'Show' : 'Hide'}
              onClick={(e) => {
                e.stopPropagation()
                dm?.update({ ...d, hidden: !d.hidden })
                bump()
              }}
            >
              {d.hidden ? <Icon.eyeOff /> : <Icon.eye />}
            </button>
            <button
              title={d.locked ? 'Unlock' : 'Lock'}
              className={d.locked ? 'on' : ''}
              onClick={(e) => {
                e.stopPropagation()
                dm?.update({ ...d, locked: !d.locked })
                bump()
              }}
            >
              <Icon.lock />
            </button>
            <button
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                dm?.remove(d.id)
                bump()
              }}
            >
              <Icon.trash />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
