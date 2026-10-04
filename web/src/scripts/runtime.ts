import type { BarData } from '../api/client'
import type { IndicatorDef } from '../chart/indicators'
import type { ScriptResult } from './engine'

// ---------------------------------------------------------------------------
// Host side: runs scripts in a dedicated Worker, one job at a time per worker,
// and terminates (then replaces) the worker when a script runs too long.
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 4000

class ScriptRunner {
  private worker: Worker | null = null
  private seq = 0
  private queue: Promise<unknown> = Promise.resolve()

  private spawn(): Worker {
    this.worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    return this.worker
  }

  run(
    source: string,
    bars: BarData[],
    inputs: Record<string, unknown> = {},
    pointValue = 1,
    strategy?: Record<string, number | boolean>,
  ): Promise<ScriptResult> {
    // serialise jobs: the worker answers in order and a timeout kills it
    const job = this.queue.then(() => this.exec(source, bars, inputs, pointValue, strategy))
    this.queue = job.catch(() => {})
    return job
  }

  private exec(
    source: string,
    bars: BarData[],
    inputs: Record<string, unknown>,
    pointValue: number,
    strategy?: Record<string, number | boolean>,
  ): Promise<ScriptResult> {
    const worker = this.spawn()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate()
        this.worker = null
        reject(new Error(`script timed out after ${TIMEOUT_MS / 1000}s`))
      }, TIMEOUT_MS)
      worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: ScriptResult; error?: string }>) => {
        if (e.data.id !== id) return
        clearTimeout(timer)
        if (e.data.ok) resolve(e.data.result!)
        else reject(new Error(e.data.error))
      }
      worker.onerror = (e) => {
        clearTimeout(timer)
        worker.terminate()
        this.worker = null
        reject(new Error(e.message || 'script crashed'))
      }
      worker.postMessage({ id, source, bars, inputs, pointValue, strategy })
    })
  }
}

export const scriptRunner = new ScriptRunner()

/** Turn a saved script into an indicator definition the chart can render. */
export async function scriptIndicator(name: string, source: string, sample: BarData[]): Promise<IndicatorDef> {
  // a dry run discovers inputs/plots/overlay; plot specs are stable per inputs
  const probe = await scriptRunner.run(source, sample.slice(-300))
  return {
    key: `script:${name}`,
    name: probe.name || name,
    shortName: probe.name || name,
    category: 'My scripts',
    group: 'script',
    overlay: probe.overlay,
    inputs: probe.inputs.map((i) => ({ ...i })),
    plots: probe.plots.map((p) => ({ ...p })),
    hlines: probe.hlines,
    defaults: Object.fromEntries(probe.inputs.map((i) => [i.id, i.defval])),
    compute: async (bars, inputs) => {
      const r = await scriptRunner.run(source, bars, inputs)
      return { plots: r.plotData, markers: r.markers }
    },
  }
}
