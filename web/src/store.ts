import { create } from 'zustand'

// localStorage can throw (private mode, blocked storage) — never let it break the app
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function persist(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ auth -----
interface AuthState {
  token: string | null
  username: string | null
  role: string | null
  login: (token: string, username: string, role: string) => void
  logout: () => void
}

export const useAuth = create<AuthState>((set) => ({
  token: load<string | null>('ot_token', null),
  username: load<string | null>('ot_username', null),
  role: load<string | null>('ot_role', null),
  login: (token, username, role) => {
    persist('ot_token', token)
    persist('ot_username', username)
    persist('ot_role', role)
    set({ token, username, role })
  },
  logout: () => {
    persist('ot_token', null)
    persist('ot_username', null)
    persist('ot_role', null)
    set({ token: null, username: null, role: null })
  },
}))

// ---------------------------------------------------------------- terminal ---
/** Interval id: Nm (1–1440), Nh (1–24), 1D, 1W, 1M — the server accepts any of these. */
export type Tf = string

export const TFS: Tf[] = ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '1D', '1W', '1M']
const DEFAULT_FAV_TFS: Tf[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W']

export function tfSeconds(tf: Tf): number | null {
  const m = /^(\d{1,4})(m|h)$|^1(D|W|M)$/.exec(tf)
  if (!m) return null
  if (m[3]) return { D: 86400, W: 604800, M: 2592000 }[m[3]]!
  const n = Number(m[1])
  if (n < 1 || (m[2] === 'm' && n > 1440) || (m[2] === 'h' && n > 24)) return null
  return n * (m[2] === 'm' ? 60 : 3600)
}

/** Parse what a user types ("5", "90", "4h", "d", "1W") into an interval id. */
export function parseTf(input: string): Tf | null {
  const s = input.trim()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n >= 60 && n % 60 === 0 && n / 60 <= 24) return `${n / 60}h`
    return tfSeconds(`${n}m`) ? `${n}m` : null
  }
  const m = /^(\d*)\s*([mhdwMHDW])$/.exec(s)
  if (!m) return null
  const n = m[1] ? Number(m[1]) : 1
  const u = m[2]
  if (u === 'm') return tfSeconds(`${n}m`) ? `${n}m` : null
  if (u === 'h' || u === 'H') return tfSeconds(`${n}h`) ? `${n}h` : null
  if (n !== 1) return null
  return u.toUpperCase() === 'D' ? '1D' : u.toUpperCase() === 'W' ? '1W' : u === 'M' ? '1M' : null
}

export type ChartType =
  | 'candles' | 'hollow' | 'bars' | 'heikin' | 'line' | 'area' | 'baseline' | 'columns'
  | 'renko' | 'range' | 'linebreak' | 'kagi' | 'pnf'

export interface ChartSettings {
  scale: 'normal' | 'log' | 'percent' | 'indexed'
  invert: boolean
  upColor: string
  downColor: string
  grid: boolean
  volume: boolean
  /** 'exchange' (the symbol's market), 'local', 'UTC' or an IANA zone */
  timezone: string
  countdown: boolean
  prevClose: boolean
  sessionBreaks: boolean
  /** box size for Renko / Range / Kagi / P&F; 0 = auto (ATR) */
  box: number
  reversal: number
  lineBreak: number
  /** paper orders / positions drawn (and draggable) on the chart */
  trading: boolean
  tradeButtons: boolean
  executions: boolean
  /** earnings / dividend / split markers */
  events: boolean
}

export const DEFAULT_SETTINGS: ChartSettings = {
  scale: 'normal', invert: false, upColor: '#089981', downColor: '#f23645', grid: true, volume: true,
  timezone: 'exchange', countdown: true, prevClose: false, sessionBreaks: false, box: 0, reversal: 3, lineBreak: 3,
  trading: true, tradeButtons: true, executions: true, events: true,
}

export const paneSettings = (p: PaneState): ChartSettings => ({ ...DEFAULT_SETTINGS, ...p.settings })

export interface IndicatorInst {
  uid: string
  /** registry id, or "script:<name>" for a user script */
  id: string
  inputs: Record<string, unknown>
  hidden?: boolean
}

export interface PaneState {
  id: string
  symbol: string
  tf: Tf
  chartType: ChartType
  indicators: IndicatorInst[]
  settings?: Partial<ChartSettings>
  /** symbols overlaid in % change on this chart */
  compares?: string[]
}

export type Grid = '1' | '2h' | '2v' | '3' | '4'
export const GRID_PANES: Record<Grid, number> = { '1': 1, '2h': 2, '2v': 2, '3': 3, '4': 4 }

export interface LayoutSpec {
  grid: Grid
  panes: PaneState[]
  syncSymbol: boolean
  syncCrosshair: boolean
}

export type RightTab = 'watchlist' | 'depth' | 'dom' | 'news' | 'alerts' | 'details' | 'objects' | 'data'
export type BottomTab = 'editor' | 'tester' | 'screener' | 'markets' | 'trading' | 'journal'

export interface ReplayState {
  paneId: string
  /** bar time where the replay starts; null while the user is picking it */
  start: number | null
  playing: boolean
  speedMs: number
}

const uid = () => Math.random().toString(36).slice(2, 10)

function defaultPane(symbol = 'SIM:ES', tf: Tf = '5m'): PaneState {
  return { id: uid(), symbol, tf, chartType: 'candles', indicators: [{ uid: uid(), id: 'ema', inputs: {} }] }
}

export const DEFAULT_LAYOUT: LayoutSpec = {
  grid: '1',
  panes: [defaultPane('SIM:ES', '5m'), defaultPane('BINANCE-BTCUSDT', '15m'), defaultPane('AAPL', '1D'), defaultPane('ES=F', '1h')],
  syncSymbol: false,
  syncCrosshair: true,
}

interface TerminalState extends LayoutSpec {
  layoutName: string
  active: number
  theme: 'dark' | 'light'
  rightTab: RightTab | null
  bottomTab: BottomTab | null
  drawingTool: string | null
  magnet: 'off' | 'weak' | 'strong'
  stayInDrawing: boolean
  drawingsHidden: boolean
  replay: ReplayState | null
  favTools: string[]
  favTfs: Tf[]

  setActive: (i: number) => void
  setGrid: (g: Grid) => void
  updatePane: (i: number, patch: Partial<PaneState>) => void
  setSymbol: (symbol: string) => void
  setTf: (tf: Tf) => void
  setChartType: (t: ChartType) => void
  addIndicator: (id: string, inputs?: Record<string, unknown>) => void
  updateIndicator: (uid: string, patch: Partial<IndicatorInst>) => void
  removeIndicator: (uid: string) => void
  applyLayout: (name: string, spec: LayoutSpec) => void
  setTheme: (t: 'dark' | 'light') => void
  setRightTab: (t: RightTab | null) => void
  setBottomTab: (t: BottomTab | null) => void
  setDrawingTool: (t: string | null) => void
  setMagnet: (m: 'off' | 'weak' | 'strong') => void
  setStayInDrawing: (v: boolean) => void
  setDrawingsHidden: (v: boolean) => void
  setSync: (patch: Partial<Pick<LayoutSpec, 'syncSymbol' | 'syncCrosshair'>>) => void
  setReplay: (r: ReplayState | null) => void
  setSettings: (patch: Partial<ChartSettings>) => void
  addCompare: (symbol: string) => void
  removeCompare: (symbol: string) => void
  toggleFavTool: (kind: string) => void
  toggleFavTf: (tf: Tf) => void
}

const saved = load<Partial<TerminalState>>('ot_terminal', {})

export const useTerminal = create<TerminalState>((set, get) => ({
  ...DEFAULT_LAYOUT,
  layoutName: 'Default',
  active: 0,
  theme: 'dark',
  rightTab: 'watchlist',
  bottomTab: null,
  drawingTool: null,
  magnet: 'off',
  stayInDrawing: false,
  drawingsHidden: false,
  favTools: ['trend-line', 'horizontal-line', 'fib-retracement', 'rectangle', 'long-position', 'text'],
  favTfs: DEFAULT_FAV_TFS,
  ...saved,
  replay: null,

  setActive: (active) => set({ active }),
  setGrid: (grid) => set({ grid, active: Math.min(get().active, GRID_PANES[grid] - 1) }),
  updatePane: (i, patch) => set({ panes: get().panes.map((p, j) => (j === i ? { ...p, ...patch } : p)) }),
  setSymbol: (symbol) => {
    const { syncSymbol, panes, active, grid } = get()
    const n = GRID_PANES[grid]
    set({
      panes: panes.map((p, j) => (j === active || (syncSymbol && j < n) ? { ...p, symbol } : p)),
      replay: null,
    })
  },
  setTf: (tf) => get().updatePane(get().active, { tf }),
  setChartType: (chartType) => get().updatePane(get().active, { chartType }),
  addIndicator: (id, inputs = {}) => {
    const p = get().panes[get().active]
    get().updatePane(get().active, { indicators: [...p.indicators, { uid: uid(), id, inputs }] })
  },
  updateIndicator: (u, patch) => {
    const p = get().panes[get().active]
    get().updatePane(get().active, { indicators: p.indicators.map((x) => (x.uid === u ? { ...x, ...patch } : x)) })
  },
  removeIndicator: (u) => {
    const p = get().panes[get().active]
    get().updatePane(get().active, { indicators: p.indicators.filter((x) => x.uid !== u) })
  },
  applyLayout: (layoutName, spec) => {
    const panes = [...spec.panes]
    while (panes.length < 4) panes.push(defaultPane())
    set({ layoutName, grid: spec.grid, panes, syncSymbol: spec.syncSymbol, syncCrosshair: spec.syncCrosshair, active: 0, replay: null })
  },
  setTheme: (theme) => set({ theme }),
  setRightTab: (rightTab) => set({ rightTab }),
  setBottomTab: (bottomTab) => set({ bottomTab }),
  setDrawingTool: (drawingTool) => set({ drawingTool }),
  setMagnet: (magnet) => set({ magnet }),
  setStayInDrawing: (stayInDrawing) => set({ stayInDrawing }),
  setDrawingsHidden: (drawingsHidden) => set({ drawingsHidden }),
  setSync: (patch) => set(patch),
  setReplay: (replay) => set({ replay }),
  setSettings: (patch) => {
    const p = get().panes[get().active]
    get().updatePane(get().active, { settings: { ...p.settings, ...patch } })
  },
  addCompare: (symbol) => {
    const p = get().panes[get().active]
    const cur = p.compares ?? []
    if (!cur.includes(symbol) && symbol !== p.symbol) get().updatePane(get().active, { compares: [...cur, symbol] })
  },
  removeCompare: (symbol) => {
    const p = get().panes[get().active]
    get().updatePane(get().active, { compares: (p.compares ?? []).filter((s) => s !== symbol) })
  },
  toggleFavTool: (kind) => {
    const f = get().favTools
    set({ favTools: f.includes(kind) ? f.filter((k) => k !== kind) : [...f, kind] })
  },
  toggleFavTf: (tf) => {
    const f = get().favTfs
    const next = f.includes(tf) ? f.filter((t) => t !== tf) : [...f, tf]
    set({ favTfs: next.sort((a, b) => (tfSeconds(a) ?? 0) - (tfSeconds(b) ?? 0)) })
  },
}))

export function layoutSpec(s: TerminalState = useTerminal.getState()): LayoutSpec {
  return { grid: s.grid, panes: s.panes, syncSymbol: s.syncSymbol, syncCrosshair: s.syncCrosshair }
}

// remember UI state per viewer
useTerminal.subscribe((s) => {
  const { grid, panes, syncSymbol, syncCrosshair, layoutName, active, theme, rightTab, bottomTab, magnet, stayInDrawing, favTools, favTfs } = s
  persist('ot_terminal', { grid, panes, syncSymbol, syncCrosshair, layoutName, active, theme, rightTab, bottomTab, magnet, stayInDrawing, favTools, favTfs })
})

export const newUid = uid

// -------------------------------------------------------------------- ui -----
export type Dialog =
  | { kind: 'symbol' }
  | { kind: 'indicators' }
  | { kind: 'indicatorSettings'; uid: string }
  | { kind: 'alert'; symbol: string; price: number; line?: { t1: number; p1: number; t2: number; p2: number; extend: string }; alertId?: number }
  | { kind: 'notifySettings' }
  | { kind: 'layouts' }
  | { kind: 'order'; symbol: string; side: 'buy' | 'sell'; price?: number }
  | { kind: 'chartSettings' }
  | { kind: 'compare' }
  | { kind: 'drawingSettings'; paneId: string; drawingId: string }

interface UiState {
  dialog: Dialog | null
  open: (d: Dialog) => void
  close: () => void
}

export const useUi = create<UiState>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}))

// ------------------------------------------------------------- crosshair ----
// What the active chart's crosshair points at, for the data window.
export interface CrosshairInfo {
  symbol: string
  tf: Tf
  bar: { time: number; open: number; high: number; low: number; close: number; volume: number } | null
  change: number | null
  changePct: number | null
  rows: { label: string; color: string; value: number | null }[]
}

export const useCrosshair = create<{ info: CrosshairInfo | null; set: (i: CrosshairInfo) => void }>((set) => ({
  info: null,
  set: (info) => set({ info }),
}))
