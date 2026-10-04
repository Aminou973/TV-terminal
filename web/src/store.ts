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
export const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1D', '1W', '1M'] as const
export type Tf = (typeof TFS)[number]

export const TF_SECONDS: Record<Tf, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400,
  '1D': 86400, '1W': 604800, '1M': 2592000,
}

export type ChartType = 'candles' | 'hollow' | 'bars' | 'heikin' | 'line' | 'area' | 'baseline'

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
}

export type Grid = '1' | '2h' | '2v' | '3' | '4'
export const GRID_PANES: Record<Grid, number> = { '1': 1, '2h': 2, '2v': 2, '3': 3, '4': 4 }

export interface LayoutSpec {
  grid: Grid
  panes: PaneState[]
  syncSymbol: boolean
  syncCrosshair: boolean
}

export type RightTab = 'watchlist' | 'depth' | 'alerts' | 'details'
export type BottomTab = 'editor' | 'tester' | 'screener' | 'trading'

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
}))

export function layoutSpec(s: TerminalState = useTerminal.getState()): LayoutSpec {
  return { grid: s.grid, panes: s.panes, syncSymbol: s.syncSymbol, syncCrosshair: s.syncCrosshair }
}

// remember UI state per viewer
useTerminal.subscribe((s) => {
  const { grid, panes, syncSymbol, syncCrosshair, layoutName, active, theme, rightTab, bottomTab, magnet, stayInDrawing } = s
  persist('ot_terminal', { grid, panes, syncSymbol, syncCrosshair, layoutName, active, theme, rightTab, bottomTab, magnet, stayInDrawing })
})

export const newUid = uid

// -------------------------------------------------------------------- ui -----
export type Dialog =
  | { kind: 'symbol' }
  | { kind: 'indicators' }
  | { kind: 'indicatorSettings'; uid: string }
  | { kind: 'alert'; symbol: string; price: number }
  | { kind: 'layouts' }
  | { kind: 'order'; symbol: string; side: 'buy' | 'sell'; price?: number }

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
