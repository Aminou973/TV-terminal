// Starter scripts for the editor. Kept short — they double as API docs.

export const TEMPLATES: { name: string; kind: 'indicator' | 'strategy'; source: string }[] = [
  {
    name: 'EMA Ribbon',
    kind: 'indicator',
    source: `// @name EMA Ribbon
// Vectorised series: close, open, high, low, volume, hl2, hlc3, ohlc4 are arrays.
const len = input('Base length', 8)
const colors = ['#2962FF', '#26A69A', '#FDD835', '#FF6D00', '#F23645']
colors.forEach((c, k) => plot(ta.ema(close, len * (k + 1)), 'EMA ' + len * (k + 1), c))
`,
  },
  {
    name: 'RSI + Bands',
    kind: 'indicator',
    source: `// @name RSI + Bands
// @overlay false
const src = input('Source', 'close')
const len = input('Length', 14)
const r = ta.rsi(src, len)
plot(r, 'RSI', '#7E57C2')
plot(ta.sma(r, 14), 'RSI MA', '#FDD835', { width: 1 })
hline(70, 'Overbought', '#F23645')
hline(30, 'Oversold', '#089981')
plotshape(ta.crossover(r, 30), { location: 'below', color: '#089981', text: 'OS' })
alertcondition(ta.crossover(r, 30), 'RSI leaves oversold', '{{ticker}} RSI crossed above 30 at {{close}}')
alertcondition(ta.crossunder(r, 70), 'RSI leaves overbought', '{{ticker}} RSI crossed below 70 at {{close}}')
`,
  },
  {
    name: 'MACD Histogram',
    kind: 'indicator',
    source: `// @name MACD Histogram
// @overlay false
const m = ta.macd(close, input('Fast', 12), input('Slow', 26), input('Signal', 9))
const colors = m.hist.map((h, i) => h >= 0 ? (h > m.hist[i - 1] ? '#26A69A' : '#B2DFDB') : (h < m.hist[i - 1] ? '#FF5252' : '#FFCDD2'))
plot(m.hist, 'Hist', '#26A69A', { style: 'histogram', colors })
plot(m.macd, 'MACD', '#2962FF')
plot(m.signal, 'Signal', '#FF6D00')
hline(0)
`,
  },
  {
    name: 'EMA Cross Strategy',
    kind: 'strategy',
    source: `// @name EMA Cross Strategy
// Orders placed in onBar fill at the NEXT bar's open (TradingView default).
strategy({ initialCapital: 100000, qty: 1, commissionPct: 0.01 })
const fast = ta.ema(close, input('Fast', 9))
const slow = ta.ema(close, input('Slow', 21))
plot(fast, 'Fast', '#2962FF')
plot(slow, 'Slow', '#FF6D00')
strategy.onBar(i => {
  if (ta.crossedUp(fast, slow, i)) strategy.entry('Long', 'long')
  if (ta.crossedDown(fast, slow, i)) strategy.entry('Short', 'short')
})
`,
  },
  {
    name: 'RSI Mean Reversion',
    kind: 'strategy',
    source: `// @name RSI Mean Reversion
// Long when RSI dips below the lower band, with ATR stop and target.
strategy({ initialCapital: 100000, qty: 1 })
const r = ta.rsi(close, input('RSI length', 14))
const atr = ta.atr(high, low, close, 14)
const lower = input('Lower', 30), upper = input('Upper', 70)
const stopAtr = input('Stop (ATR)', 2.0), targetAtr = input('Target (ATR)', 3.0)
strategy.onBar(i => {
  const pos = strategy.position()
  if (!pos && ta.crossedUp(r, lower, i))
    strategy.entry('MR', 'long', { sl: close[i] - stopAtr * atr[i], tp: close[i] + targetAtr * atr[i] })
  if (pos && r[i] > upper) strategy.close('MR', 'RSI overbought')
})
`,
  },
  {
    name: 'Donchian Breakout',
    kind: 'strategy',
    source: `// @name Donchian Breakout
strategy({ initialCapital: 100000, qty: 1 })
const n = input('Channel', 20)
const hi = ta.highest(high, n), lo = ta.lowest(low, n)
plot(hi, 'Upper', '#26A69A', { width: 1 })
plot(lo, 'Lower', '#F23645', { width: 1 })
strategy.onBar(i => {
  if (i < 1) return
  if (close[i] > hi[i - 1]) strategy.entry('Breakout L', 'long')
  if (close[i] < lo[i - 1]) strategy.entry('Breakout S', 'short')
})
`,
  },
]

export const API_HELP = `Series: open high low close volume hl2 hlc3 ohlc4 time · bar_count
input(title, default, {options,min,max}) · indicator({name, overlay}) · // @name, // @overlay false
plot(series, title?, color?, {style:'line'|'histogram'|'area'|'circles'|'stepline', width, colors})
hline(price, title?, color?) · plotshape(boolArray, {location:'above'|'below', color, text})
ta.sma ema rma wma stdev highest lowest change mom roc sum rsi macd bb tr atr stoch cci vwap obv
ta.crossover/crossunder(a,b) → bool[] · ta.crossedUp/crossedDown(a,b,i) → bool
strategy({initialCapital, qty, commissionPct, pointValue, fillOnClose}) · strategy.onBar(i => …)
strategy.entry(id, 'long'|'short', {qty, sl, tp}) · strategy.close(id?) · strategy.closeAll() · strategy.position()
alertcondition(boolArray, title, message) — server-side alerts can watch it
log(...) · nz(v, d) · na · math`
