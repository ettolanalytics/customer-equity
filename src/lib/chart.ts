// Opbouw van SVG-grafieken zoals in het ontwerp (assen, paden, hover-zones).
// Alleen plaatsing op het scherm; de waarden zelf komen uit de JSON.

export function niceTicks(min: number, max: number, count: number) {
  const raw = (max - min) / count
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / p
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
  const a = Math.floor(min / step) * step
  const b = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = a; v <= b + step / 2; v += step) ticks.push(v)
  return { ticks, step }
}

/** Positie als percentage van de grafiek, voor HTML-labels over de SVG. */
export const pctOf = (v: number) => Math.round(v * 100) / 100 + '%'

export type ChartBox = { W: number; H: number; L: number; R: number; T: number; B: number }

type Series = (number | null)[]

/** Pad door de punten met een waarde; ontbrekende punten onderbreken de lijn. */
function seriesPath(values: Series, xs: (i: number) => number, ys: (v: number) => number) {
  let d = ''
  let open = false
  values.forEach((v, i) => {
    if (v === null) {
      open = false
      return
    }
    d += (open ? ' L' : ' M') + xs(i).toFixed(1) + ' ' + ys(v).toFixed(1)
    open = true
  })
  return d.trim()
}

export function lineChart(
  box: ChartBox,
  labels: string[],
  series: Series[],
  format: (step: number) => (v: number) => string,
  { count = 4, ends = false }: { count?: number; ends?: boolean } = {},
) {
  const { W, H, L, R, T, B } = box
  const all = series.flat().filter((v): v is number => v !== null)
  let mn = Math.min(...all)
  let mx = Math.max(...all)
  const pad = (mx - mn) * 0.08
  mn -= pad
  mx += pad
  if (Math.min(...all) >= 0) mn = Math.max(0, mn)
  const nt = niceTicks(mn, mx, count)
  const y0 = nt.ticks[0]
  const y1 = nt.ticks[nt.ticks.length - 1]
  const fmt = format(nt.step)
  const step = (W - L - R) / (labels.length - 1)
  const xs = (i: number) => L + i * step
  const ys = (v: number) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B)

  return {
    xs,
    ys,
    step,
    paths: series.map((s) => seriesPath(s, xs, ys)),
    ticks: nt.ticks.map((v) => ({
      y: ys(v),
      left: pctOf(((L - 8) / W) * 100),
      top: pctOf((ys(v) / H) * 100),
      label: fmt(v),
    })),
    xLabels: labels
      .map((label, i) => ({ left: pctOf((xs(i) / W) * 100), top: pctOf(((H - B + 8) / H) * 100), label }))
      .filter((_, i) => !ends || i === 0 || i === labels.length - 1),
  }
}
