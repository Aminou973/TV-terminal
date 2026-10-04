// Futures point values ($ per 1.0 move per contract) — mirrors server/app/paper/engine.py.
const POINT_VALUE: Record<string, number> = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5, CL: 1000, MCL: 100, NG: 10000,
  GC: 100, MGC: 10, SI: 5000, SIL: 1000, ZB: 1000, ZN: 1000, ZF: 1000, ZT: 2000, ZC: 50, ZS: 50, ZW: 50,
  '6E': 125000, '6J': 12500000, '6B': 62500, HE: 400, LE: 400, PL: 50, PA: 100, MBT: 0.1,
}

export function symbolRoot(symbol: string): string {
  let s = symbol.toUpperCase().split(':').pop()!.split(' ')[0].split('.')[0]
  if (s.endsWith('=F')) s = s.slice(0, -2)
  return s
}

export const pointValue = (symbol: string) => POINT_VALUE[symbolRoot(symbol)] ?? 1

export const priceDigits = (v: number) => (Math.abs(v) < 1 ? 5 : Math.abs(v) < 10 ? 4 : 2)

// --------------------------------------------------------- time zones ------
export type Market = 'cme' | 'crypto' | 'india' | 'stock' | string

const EXCHANGE_TZ: Record<string, string> = {
  cme: 'America/Chicago',
  stock: 'America/New_York',
  india: 'Asia/Kolkata',
  crypto: 'UTC',
}

/** Resolve a chart timezone setting to an IANA zone (undefined = browser local). */
export function resolveTz(setting: string, market: Market | undefined): string | undefined {
  if (setting === 'local') return undefined
  if (setting === 'exchange') return EXCHANGE_TZ[market ?? 'stock'] ?? 'America/New_York'
  return setting
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz })
    fmtCache.set(key, f)
  }
  return f
}

export const formatTime = (sec: number, tz: string | undefined, opts: Intl.DateTimeFormatOptions) =>
  fmt(tz, opts).format(new Date(sec * 1000))

/** Calendar day (YYYY-MM-DD) of a time in a zone; CME rolls at 17:00 Chicago. */
export function sessionKey(sec: number, market: Market | undefined): string {
  const shifted = market === 'cme' ? sec + 7 * 3600 : sec
  return fmt(resolveTz('exchange', market), { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(shifted * 1000))
}
