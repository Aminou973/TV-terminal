import { useEffect, useState } from 'react'
import { deleteAlert, getAlertLog, setAlertActive, type AlertLogEntry } from '../api/client'
import { toast, useAlerts } from '../data'
import { Icon } from '../icons'
import { useTerminal, useUi } from '../store'

const COND: Record<string, string> = {
  crossing: 'Crossing',
  crossing_up: 'Crossing up',
  crossing_down: 'Crossing down',
  greater: 'Greater than',
  less: 'Less than',
}

export default function AlertsPanel() {
  const alerts = useAlerts((s) => s.list)
  const refresh = useAlerts((s) => s.refresh)
  const symbol = useTerminal((s) => s.panes[s.active].symbol)
  const open = useUi((s) => s.open)
  const [tab, setTab] = useState<'alerts' | 'log'>('alerts')
  const [log, setLog] = useState<AlertLogEntry[]>([])

  useEffect(() => {
    if (tab === 'log') getAlertLog().then(setLog).catch(() => {})
  }, [tab, alerts])

  const act = (p: Promise<unknown>) => p.then(refresh).catch((e) => toast('Alert update failed', String(e.message), 'error'))

  return (
    <div className="panel alerts">
      <div className="panel-head">
        <div className="seg">
          <button className={tab === 'alerts' ? 'on' : ''} onClick={() => setTab('alerts')}>Alerts</button>
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Log</button>
        </div>
        <button className="icon-btn" title="New alert" onClick={() => open({ kind: 'alert', symbol, price: NaN })}>
          <Icon.plus />
        </button>
      </div>
      {tab === 'alerts' ? (
        <div className="list">
          {alerts.length === 0 && <p className="muted pad">No alerts yet.</p>}
          {alerts.map((a) => (
            <div key={a.id} className={`alert-row ${a.active ? '' : 'muted'}`}>
              <div>
                <b>{a.symbol}</b> {COND[a.condition]} <b>{a.price}</b>
                {a.message && <div className="small">{a.message}</div>}
                <div className="small muted">{a.triggered_at ? `triggered ${a.triggered_at} UTC` : a.once ? 'once' : 'every time'}</div>
              </div>
              <span className="row-actions">
                <button title={a.active ? 'Pause' : 'Resume'} onClick={() => act(setAlertActive(a.id, !a.active))}>
                  {a.active ? '❚❚' : '▶'}
                </button>
                <button title="Delete" onClick={() => act(deleteAlert(a.id))}>×</button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="list">
          {log.length === 0 && <p className="muted pad">Nothing has fired yet.</p>}
          {log.map((l) => (
            <div key={l.id} className="alert-row">
              <div>
                <b>{l.symbol}</b> @ {l.price}
                <div className="small">{l.message}</div>
                <div className="small muted">{new Date(l.ts_ms).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
