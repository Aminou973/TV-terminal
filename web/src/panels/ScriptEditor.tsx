import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { deleteScript, getHistory, saveScript } from '../api/client'
import { toast, useScripts } from '../data'
import { scriptRunner } from '../scripts/runtime'
import { API_HELP, TEMPLATES } from '../scripts/templates'
import { useTerminal } from '../store'
import { useTester } from './StrategyTester'

const NEW_SCRIPT = TEMPLATES[0]

export default function ScriptEditor() {
  const scripts = useScripts((s) => s.list)
  const refresh = useScripts((s) => s.refresh)
  const theme = useTerminal((s) => s.theme)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [name, setName] = useState('My script')
  const [kind, setKind] = useState<'indicator' | 'strategy'>('indicator')
  const [output, setOutput] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const initial = useRef(NEW_SCRIPT.source)
  // the editor keymap is built once per theme: read the latest values via refs
  const nameRef = useRef(name)
  const kindRef = useRef(kind)
  nameRef.current = name
  kindRef.current = kind

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  // (re)create the editor when the theme changes, keeping the text
  useEffect(() => {
    const doc = view.current?.state.doc.toString() ?? initial.current
    view.current?.destroy()
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          keymap.of([
            indentWithTab,
            { key: 'Mod-s', preventDefault: true, run: () => (void save(), true) },
            { key: 'Mod-Enter', preventDefault: true, run: () => (void run(), true) },
          ]),
          javascript(),
          ...(theme === 'dark' ? [oneDark] : []),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontSize: '13px' } }),
        ],
      }),
    })
    return () => {
      view.current?.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  const source = () => view.current?.state.doc.toString() ?? ''
  const setSource = (text: string) => {
    const v = view.current
    if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
    else initial.current = text
  }

  const load = (n: string, k: 'indicator' | 'strategy', src: string) => {
    setName(n)
    setKind(k)
    setSource(src)
    setOutput('')
  }

  const save = async (): Promise<boolean> => {
    const n = nameRef.current
    try {
      await saveScript(n, kindRef.current, source())
      await refresh()
      toast('Script saved', n, 'success')
      return true
    } catch (e) {
      toast('Save failed', String((e as Error).message), 'error')
      return false
    }
  }

  const run = async () => {
    setBusy(true)
    try {
      const pane = useTerminal.getState().panes[useTerminal.getState().active]
      const { bars } = await getHistory(pane.symbol, pane.tf, { limit: 1500 })
      const t0 = performance.now()
      const r = await scriptRunner.run(source(), bars)
      const ms = (performance.now() - t0).toFixed(0)
      const lines = [
        `✓ ${r.name} (${r.kind}, ${r.overlay ? 'overlay' : 'own pane'}) on ${pane.symbol} ${pane.tf}: ${bars.length} bars in ${ms} ms`,
        `  inputs: ${r.inputs.map((i) => `${i.title}=${String(i.defval)}`).join(', ') || 'none'}`,
        `  plots: ${r.plots.map((p) => p.title).join(', ') || 'none'} · markers: ${r.markers.length}`,
      ]
      if (r.strategy) {
        const m = r.strategy.metrics
        lines.push(`  strategy: ${m.totalTrades} trades · net ${m.netProfit.toFixed(2)} · win ${m.winRate.toFixed(1)}% · max DD ${m.maxDrawdown.toFixed(2)}`)
      }
      lines.push(...r.logs.map((l) => `  log: ${l}`))
      setOutput(lines.join('\n'))
      if (r.kind !== kindRef.current) setKind(r.kind)
    } catch (e) {
      setOutput(`✗ ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const addToChart = async () => {
    if (!(await save())) return
    useTerminal.getState().addIndicator(`script:${nameRef.current}`)
  }

  const backtest = async () => {
    if (!(await save())) return
    useTester.getState().select(nameRef.current)
    useTerminal.getState().setBottomTab('tester')
  }

  return (
    <div className="editor">
      <div className="editor-side">
        <div className="panel-title">My scripts</div>
        {scripts.length === 0 && <p className="muted pad small">None saved yet.</p>}
        {scripts.map((s) => (
          <div key={s.id} className={`script-item ${s.name === name ? 'on' : ''}`} onClick={() => load(s.name, s.kind, s.source)}>
            <span>{s.name}</span>
            <small>{s.kind}</small>
            <button
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`Delete "${s.name}"?`)) deleteScript(s.id).then(refresh).catch(() => {})
              }}
            >
              ×
            </button>
          </div>
        ))}
        <div className="panel-title">Templates</div>
        {TEMPLATES.map((t) => (
          <div key={t.name} className="script-item" onClick={() => load(t.name, t.kind, t.source)}>
            <span>{t.name}</span>
            <small>{t.kind}</small>
          </div>
        ))}
      </div>
      <div className="editor-main">
        <div className="editor-bar">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Script name" />
          <select value={kind} onChange={(e) => setKind(e.target.value as 'indicator' | 'strategy')}>
            <option value="indicator">Indicator</option>
            <option value="strategy">Strategy</option>
          </select>
          <button onClick={run} disabled={busy} title="Ctrl/Cmd+Enter">{busy ? 'Running…' : 'Run'}</button>
          <button onClick={() => void save()} title="Ctrl/Cmd+S">Save</button>
          <button className="primary" onClick={addToChart}>Add to chart</button>
          {kind === 'strategy' && <button onClick={backtest}>Backtest</button>}
        </div>
        <div className="editor-code" ref={host} />
        <pre className="editor-out">{output || API_HELP}</pre>
      </div>
    </div>
  )
}
