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
