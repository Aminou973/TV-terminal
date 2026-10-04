import { useEffect, useMemo, useState } from 'react'
import {
  createAlert,
  getAlertCatalog,
  getHistory,
  getNotifySettings,
  getQuote,
  updateAlert,
  type AlertCatalog,
  type AlertCondition,
  type AlertFrequency,
  type AlertIn,
  type AlertKind,
  type SeriesSpec,
} from '../api/client'
import { toast, useAlerts, useScripts } from '../data'
import { scriptRunner } from '../scripts/runtime'
import { TFS, useTerminal } from '../store'
import { Modal } from './Modal'
import NotifySettingsDialog from './NotifySettingsDialog'

const CONDITIONS: { id: AlertCondition; label: string }[] = [
  { id: 'crossing', label: 'Crossing' },
  { id: 'crossing_up', label: 'Crossing up' },
  { id: 'crossing_down', label: 'Crossing down' },
  { id: 'greater', label: 'Greater than' },
  { id: 'less', label: 'Less than' },
]

const FREQUENCIES: { id: AlertFrequency; label: string }[] = [
  { id: 'once', label: 'Only once' },
  { id: 'once_per_bar', label: 'Once per bar' },
  { id: 'once_per_bar_close', label: 'Once per bar close' },
  { id: 'once_per_minute', label: 'Once per minute' },
  { id: 'every_time', label: 'Every time' },
]

const PLACEHOLDERS = ['{{ticker}}', '{{close}}', '{{price}}', '{{interval}}', '{{time}}', '{{timenow}}', '{{alert}}', '{{strategy.order.action}}', '{{strategy.order.contracts}}']

const toLocalInput = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Picks a series: an indicator (+ params + output) or, when allowed, a plain value. */
function SeriesBuilder({ value, onChange, catalog, allowValue }: { value: SeriesSpec; onChange: (v: SeriesSpec) => void; catalog: AlertCatalog; allowValue: boolean }) {
  const isValue = 'value' in value && !('ind' in value)
  const ind = catalog.indicators.find((i) => i.id === value.ind)
  return (
    <div className="series-builder">
      <select
        value={isValue ? '__value' : String(value.ind)}
        onChange={(e) => {
          if (e.target.value === '__value') return onChange({ value: 0 })
          const def = catalog.indicators.find((i) => i.id === e.target.value)!
          onChange({ ind: def.id, ...def.params, output: def.outputs[0] })
        }}
      >
        {allowValue && <option value="__value">Value</option>}
        {catalog.indicators.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
      </select>
      {isValue ? (
        <input type="number" step="any" value={String(value.value)} onChange={(e) => onChange({ value: Number(e.target.value) })} />
      ) : (
        <>
          {ind && Object.entries(ind.params).map(([k, d]) => (
            <label key={k} className="inline">
              {k}
              {k === 'source' ? (
                <select value={String(value[k] ?? d)} onChange={(e) => onChange({ ...value, [k]: e.target.value })}>
                  {['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume'].map((s) => <option key={s}>{s}</option>)}
                </select>
              ) : (
                <input type="number" step="any" value={String(value[k] ?? d)} onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })} />
              )}
            </label>
          ))}
          {ind && ind.outputs.length > 1 && (
            <select value={String(value.output ?? ind.outputs[0])} onChange={(e) => onChange({ ...value, output: e.target.value })}>
              {ind.outputs.map((o) => <option key={o}>{o}</option>)}
            </select>
          )}
        </>
      )}
    </div>
  )
}

interface Props {
  symbol: string
  price: number
  line?: { t1: number; p1: number; t2: number; p2: number; extend: string }
  alertId?: number
  onClose: () => void
}

export default function AlertDialog({ symbol, price, line, alertId, onClose }: Props) {
  const existing = useAlerts((s) => s.list.find((a) => a.id === alertId))
  const paneTf = useTerminal((s) => s.panes[s.active].tf)
  const scripts = useScripts((s) => s.list)
  const [showSettings, setShowSettings] = useState(false)
  const [catalog, setCatalog] = useState<AlertCatalog | null>(null)
  const [kind, setKind] = useState<AlertKind>(existing?.kind ?? (line ? 'line' : 'price'))
  const [sym, setSym] = useState(existing?.symbol ?? symbol)
  const [cond, setCond] = useState<AlertCondition>(existing?.condition ?? 'crossing')
  const [level, setLevel] = useState(existing ? String(existing.price) : Number.isFinite(price) ? String(price) : '')
  const [lineParams, setLineParams] = useState(existing?.kind === 'line' ? (existing.params as Props['line'])! : line)
  const [tf, setTf] = useState(existing?.tf && existing.tf !== '1m' ? existing.tf : paneTf)
  const [left, setLeft] = useState<SeriesSpec>((existing?.params.left as SeriesSpec) ?? { ind: 'rsi', length: 14, source: 'close', output: 'value' })
  const [right, setRight] = useState<SeriesSpec>((existing?.params.right as SeriesSpec) ?? { value: 70 })
  const [scriptName, setScriptName] = useState<string>((existing?.params.name as string) ?? '')
  const [scriptCond, setScriptCond] = useState<string>((existing?.params.condition as string) ?? '')
  const [scriptConds, setScriptConds] = useState<string[]>([])
  const [frequency, setFrequency] = useState<AlertFrequency>(existing?.frequency ?? 'once')
  const [expires, setExpires] = useState<string>(toLocalInput(existing?.expires_ms ?? Date.now() + 30 * 86400_000))
  const [openEnded, setOpenEnded] = useState(existing ? existing.expires_ms == null : false)
  const [message, setMessage] = useState(existing?.message ?? '')
  const [webhookOn, setWebhookOn] = useState(!!existing?.notify.webhook)
  const [webhook, setWebhook] = useState(typeof existing?.notify.webhook === 'string' ? existing.notify.webhook : '')
  const [telegram, setTelegram] = useState(!!existing?.notify.telegram)
  const [email, setEmail] = useState(!!existing?.notify.email)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getAlertCatalog().then(setCatalog).catch(() => {})
    void useScripts.getState().refresh().catch(() => {})
    getNotifySettings().then((s) => setWebhook((w) => w || s.webhook_url)).catch(() => {})
    if (!existing && !Number.isFinite(price)) {
      getQuote([symbol]).then(({ quotes }) => quotes[0] && setLevel((l) => l || String(quotes[0].last))).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // indicator/script alerts default to bar-close evaluation (TradingView's safer choice)
  useEffect(() => {
    if (!existing && (kind === 'indicator' || kind === 'script') && frequency === 'once') setFrequency('once_per_bar_close')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  // discover a script's alertcondition() titles with a dry run
  const script = scripts.find((s) => s.name === scriptName)
  useEffect(() => {
    if (!script) return setScriptConds([])
    let stale = false
    getHistory(sym, tf, { limit: 300 })
      .then(({ bars }) => scriptRunner.run(script.source, bars))
      .then((r) => {
        if (stale) return
        const titles = r.alerts.map((a) => a.title)
        setScriptConds([...titles, ...(r.kind === 'strategy' ? ['strategy'] : [])])
        setScriptCond((c) => c || titles[0] || (r.kind === 'strategy' ? 'strategy' : ''))
      })
      .catch(() => !stale && setScriptConds([]))
    return () => {
      stale = true
    }
  }, [script?.source, sym, tf])

  const summary = useMemo(() => {
    const c = CONDITIONS.find((x) => x.id === cond)?.label.toLowerCase()
    if (kind === 'price') return `${sym} ${c} ${level}`
    if (kind === 'line') return `${sym} ${c} trend line`
    if (kind === 'indicator') return `${left.ind ?? 'value'} ${c} ${'value' in right && !('ind' in right) ? right.value : right.ind} on ${tf}`
    return `${scriptName || 'script'} → ${scriptCond === 'strategy' ? 'order fills' : scriptCond} on ${tf}`
  }, [kind, sym, cond, level, left, right, tf, scriptName, scriptCond])

  const submit = async () => {
    const body: AlertIn = {
      symbol: sym.trim(),
      kind,
      condition: cond,
      price: kind === 'price' ? Number(level) : 0,
      tf: kind === 'indicator' || kind === 'script' || frequency.startsWith('once_per_bar') ? tf : '1m',
      frequency,
      expires_ms: openEnded ? null : new Date(expires).getTime(),
      message,
      notify: { webhook: webhookOn ? webhook.trim() || true : undefined, telegram, email },
      params:
        kind === 'line' ? lineParams : kind === 'indicator' ? { left, right } : kind === 'script' ? { name: scriptName, condition: scriptCond } : {},
    }
    setBusy(true)
    try {
      if (existing) await updateAlert(existing.id, body)
      else await createAlert(body)
      await useAlerts.getState().refresh()
      toast(existing ? 'Alert updated' : 'Alert created', summary, 'success')
      onClose()
    } catch (e) {
      toast('Alert failed', String((e as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  const tfOptions = TFS.includes(tf) ? TFS : [tf, ...TFS]
  const ready =
    !!sym.trim() &&
    (kind !== 'price' || level !== '') &&
    (kind !== 'line' || !!lineParams) &&
    (kind !== 'script' || (!!scriptName && !!scriptCond))

  return (
    <Modal title={existing ? 'Edit alert' : `Create alert on ${sym}`} onClose={onClose} wide>
      <div className="seg">
        {(['price', 'indicator', 'line', 'script'] as AlertKind[]).map((k) => (
          <button key={k} className={kind === k ? 'on' : ''} disabled={k === 'line' && !lineParams} onClick={() => setKind(k)}>
            {k === 'line' ? 'Trend line' : k}
          </button>
        ))}
      </div>
      <div className="form">
        <label><span>Symbol</span><input value={sym} onChange={(e) => setSym(e.target.value)} /></label>
        {kind === 'indicator' && catalog && (
          <label><span>Condition</span><SeriesBuilder value={left} onChange={setLeft} catalog={catalog} allowValue={false} /></label>
        )}
        <label>
          <span>{kind === 'indicator' ? '' : 'Condition'}</span>
          <select value={cond} onChange={(e) => setCond(e.target.value as AlertCondition)} disabled={kind === 'script'}>
            {CONDITIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        {kind === 'price' && (
          <label><span>Value</span><input type="number" step="any" value={level} onChange={(e) => setLevel(e.target.value)} /></label>
        )}
        {kind === 'line' && lineParams && (
          <>
            <label>
              <span>Trend line</span>
              <span className="muted small">
                {lineParams.p1.toFixed(2)} @ {new Date(lineParams.t1 * 1000).toLocaleString()} → {lineParams.p2.toFixed(2)} @ {new Date(lineParams.t2 * 1000).toLocaleString()}
              </span>
            </label>
            <label>
              <span>Extend</span>
              <select value={lineParams.extend} onChange={(e) => setLineParams({ ...lineParams, extend: e.target.value })}>
                <option value="right">Right</option>
                <option value="both">Both ways</option>
                <option value="left">Left</option>
                <option value="none">Segment only</option>
              </select>
            </label>
          </>
        )}
        {kind === 'indicator' && catalog && (
          <label><span>Against</span><SeriesBuilder value={right} onChange={setRight} catalog={catalog} allowValue /></label>
        )}
        {kind === 'script' && (
          <>
            <label>
              <span>Script</span>
              <select value={scriptName} onChange={(e) => { setScriptName(e.target.value); setScriptCond('') }}>
                <option value="">Choose a saved script…</option>
                {scripts.map((s) => <option key={s.id} value={s.name}>{s.name} ({s.kind})</option>)}
              </select>
            </label>
            <label>
              <span>Trigger on</span>
              <select value={scriptCond} onChange={(e) => setScriptCond(e.target.value)} disabled={!scriptConds.length}>
                {!scriptConds.length && <option value="">{script ? 'no alertcondition() / strategy in this script' : '—'}</option>}
                {scriptConds.map((c) => <option key={c} value={c}>{c === 'strategy' ? 'Strategy order fills' : c}</option>)}
              </select>
            </label>
          </>
        )}
        {(kind === 'indicator' || kind === 'script' || frequency.startsWith('once_per_bar')) && (
          <label>
            <span>Timeframe</span>
            <select value={tf} onChange={(e) => setTf(e.target.value)}>
              {tfOptions.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
        )}
        <label>
          <span>Trigger</span>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as AlertFrequency)}>
            {FREQUENCIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label>
          <span>Expiration</span>
          <span className="inline-row">
            <input type="datetime-local" value={expires} disabled={openEnded} onChange={(e) => setExpires(e.target.value)} />
            <label className="inline"><input type="checkbox" checked={openEnded} onChange={(e) => setOpenEnded(e.target.checked)} /> open-ended</label>
          </span>
        </label>
        <label>
          <span>Message</span>
          <span className="msg-field">
            <textarea rows={3} placeholder={summary} value={message} onChange={(e) => setMessage(e.target.value)} />
            <span className="chips">
              {PLACEHOLDERS.map((p) => <button key={p} type="button" onClick={() => setMessage((m) => `${m}${p}`)}>{p}</button>)}
            </span>
          </span>
        </label>
        <label>
          <span>Notifications</span>
          <span className="notify-opts">
            <label className="inline"><input type="checkbox" checked readOnly disabled /> In app + browser</label>
            <label className="inline"><input type="checkbox" checked={webhookOn} onChange={(e) => setWebhookOn(e.target.checked)} /> Webhook</label>
            {webhookOn && <input placeholder="https://… (blank = your default)" value={webhook} onChange={(e) => setWebhook(e.target.value)} />}
            <label className="inline"><input type="checkbox" checked={telegram} onChange={(e) => setTelegram(e.target.checked)} /> Telegram</label>
            <label className="inline" title={catalog?.email_available ? '' : 'Ask the admin to set OPENTERM_SMTP_HOST'}>
              <input type="checkbox" checked={email} disabled={catalog ? !catalog.email_available : false} onChange={(e) => setEmail(e.target.checked)} /> Email
            </label>
            <button type="button" className="link-btn" onClick={() => setShowSettings(true)}>Notification settings…</button>
          </span>
        </label>
      </div>
      <div className="modal-foot">
        <span className="muted small">{summary}</span>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ready || busy} onClick={submit}>{existing ? 'Save' : 'Create'}</button>
      </div>
      {showSettings && <NotifySettingsDialog onClose={() => setShowSettings(false)} />}
    </Modal>
  )
}
