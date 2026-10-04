import { useEffect, useState } from 'react'
import { deleteAlert, getAlertLog, setAlertActive, type Alert, type AlertLogEntry } from '../api/client'
import { toast, useAlerts } from '../data'
import { Icon } from '../icons'
import { useTerminal, useUi } from '../store'

const COND: Record<string, string> = {
  crossing: 'crossing',
  crossing_up: 'crossing up',
  crossing_down: 'crossing down',
  greater: 'greater than',
  less: 'less than',
}

const FREQ: Record<string, string> = {
  once: 'once',
  once_per_bar: 'once per bar',
  once_per_bar_close: 'once per bar close',
  once_per_minute: 'once per minute',
  every_time: 'every time',
}

function seriesText(s: unknown): string {
  const o = (s ?? {}) as Record<string, unknown>
  if ('value' in o && !('ind' in o)) return String(o.value)
  if (o.ind === 'price') return String(o.source ?? 'close')
  const args = Object.entries(o)
    .filter(([k, v]) => !['ind', 'output', 'source'].includes(k) || (k === 'source' && v !== 'close'))
    .map(([, v]) => v)
  return `${String(o.ind).toUpperCase()}(${args.join(', ')})${o.output && o.output !== 'value' ? `.${o.output}` : ''}`
}

export function alertSummary(a: Alert): string {
  const c = COND[a.condition] ?? a.condition
  switch (a.kind) {
    case 'indicator':
      return `${seriesText(a.params.left)} ${c} ${seriesText(a.params.right)}`
    case 'line':
      return `price ${c} trend line`
    case 'script':
      return `${a.params.name}: ${a.params.condition === 'strategy' ? 'order fills' : a.params.condition}`
    default:
      return `price ${c} ${a.price}`
  }
}

function channels(a: Alert): string[] {
  const out: string[] = []
  if (a.notify.webhook) out.push('webhook')
  if (a.notify.telegram) out.push('telegram')
  if (a.notify.email) out.push('email')
  return out
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
          <button className={tab === 'alerts' ? 'on' : ''} onClick={() => setTab('alerts')}>Alerts ({alerts.filter((a) => a.active).length})</button>
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Log</button>
        </div>
        <span className="spacer" />
        <button className="icon-btn" title="Notification settings" onClick={() => open({ kind: 'notifySettings' })}>
          <Icon.gear />
        </button>
        <button className="icon-btn" title="New alert (Alt+A)" onClick={() => open({ kind: 'alert', symbol, price: NaN })}>
          <Icon.plus />
        </button>
      </div>
      {tab === 'alerts' ? (
        <div className="list">
          {alerts.length === 0 && <p className="muted pad">No alerts yet. Right-click the chart or a trend line, or press Alt+A.</p>}
          {alerts.map((a) => (
            <div key={a.id} className={`alert-row ${a.active ? '' : 'muted'}`}>
              <div className="alert-main" onClick={() => open({ kind: 'alert', symbol: a.symbol, price: a.price, alertId: a.id })}>
                <div>
                  <b>{a.symbol}</b> <span className="alert-kind">{a.kind}</span>
                  {a.kind !== 'price' && <span className="muted small"> · {a.tf}</span>}
                </div>
                <div className="small">{alertSummary(a)}</div>
                <div className="small muted">
                  {FREQ[a.frequency] ?? a.frequency}
                  {a.expires_ms ? ` · until ${new Date(a.expires_ms).toLocaleDateString()}` : ''}
                  {channels(a).length > 0 && ` · ${channels(a).join(', ')}`}
                  {a.triggered_at && ` · last ${a.triggered_at} UTC`}
                </div>
                {a.error && <div className="small down">⚠ {a.error}</div>}
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
                {l.delivery && <div className={`small ${l.delivery.includes('failed') ? 'down' : 'up'}`}>{l.delivery}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
