import type { BarData } from '../api/client'
import { useScripts } from '../data'
import { scriptIndicator } from '../scripts/runtime'
import { loadRegistry, type IndicatorDef } from './indicators'

const scriptCache = new Map<string, Promise<IndicatorDef>>() // name|source -> def

/** Resolve a pane's indicator id: registry key, or "script:<name>" for a saved script. */
export async function resolveIndicator(id: string, sample: BarData[]): Promise<IndicatorDef | null> {
  if (id.startsWith('script:')) {
    const name = id.slice(7)
    const scripts = useScripts.getState()
    if (!scripts.loaded) await scripts.refresh().catch(() => {})
    const s = useScripts.getState().list.find((x) => x.name === name)
    if (!s) return null
    const key = `${name}|${s.source}`
    let def = scriptCache.get(key)
    if (!def) {
      def = scriptIndicator(name, s.source, sample)
      scriptCache.set(key, def)
      def.catch(() => scriptCache.delete(key))
    }
    return def
  }
  const reg = await loadRegistry()
  return reg.find((d) => d.key === id) ?? null
}
