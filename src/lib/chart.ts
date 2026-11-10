// Opbouw van SVG-grafieken zoals in het ontwerp (assen, paden, hover-zones).
// Alleen plaatsing op het scherm; de waarden zelf komen uit de JSON.

/** Ronde asticks; nooit meer dan count + 1 ticks (kleine grafieken blijven leesbaar). */
export function niceTicks(min: number, max: number, count: number) {
  const raw = (max - min) / count
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const NICE = [1, 2, 2.5, 5, 10, 20, 25, 50, 100]
  let k = NICE.findIndex((n) => n >= raw / p)
  for (;;) {
    const step = NICE[k] * p
    const a = Math.floor(min / step) * step
    const b = Math.ceil(max / step) * step
    const ticks: number[] = []
    for (let v = a; v <= b + step / 2; v += step) ticks.push(v)
    if (ticks.length <= count + 1 || k === NICE.length - 1) return { ticks, step }
    k += 1
  }
}

/** Ronde ticks binnen [min, max] (min ≤ 0 ≤ max): de kleinste ronde stap met hoogstens max ticks. */
export function ticksWithin(min: number, max: number, maxTicks: number) {
  const NICE = [1, 2, 2.5, 5]
  const span = Math.max(max - min, 1e-9)
  for (let e = Math.floor(Math.log10(span / maxTicks)) - 1; ; e++) {
    for (const n of NICE) {
      const step = n * Math.pow(10, e)
      const ticks: number[] = []
      for (let k = Math.ceil(min / step); k * step <= max + 1e-12; k++) ticks.push(k * step === 0 ? 0 : k * step)
      if (ticks.length <= maxTicks) return { ticks, step }
    }
  }
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
  { count = 4, ends = false, zero = false }: { count?: number; ends?: boolean; zero?: boolean } = {},
) {
  const { W, H, L, R, T, B } = box
  // zero: de nul altijd binnen het bereik (bijdragen met teken, met zichtbare nullijn).
  const all = [...series.flat().filter((v): v is number => v !== null), ...(zero ? [0] : [])]
  let mn = Math.min(...all)
  let mx = Math.max(...all)
  const pad = (mx - mn) * 0.08
  mn -= pad
  mx += pad
  if (Math.min(...all) >= 0) mn = Math.max(0, mn)
  // zero: de as volgt de zichtbare waarden (niet afgerond op ronde ticks), met hoogstens
  // count + 1 ronde ticks binnen dat bereik, altijd inclusief 0.
  const nt = zero ? ticksWithin(mn, mx, count + 1) : niceTicks(mn, mx, count)
  const y0 = zero ? mn : nt.ticks[0]
  const y1 = zero ? mx : nt.ticks[nt.ticks.length - 1]
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
