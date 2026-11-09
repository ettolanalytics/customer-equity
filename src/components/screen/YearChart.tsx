// Lijngrafiek met één lijn per jaar (laatste drie jaar) op de as Q1–Q4.
// Gedeeld door de grote grafiek en de tegels; gedeelde hover per kwartaalpositie.
import { lineChart, type ChartBox } from '../../lib/chart'
import { QUARTER_AXIS, YEAR_COLORS, type HoverProps, type Quarter, type View } from '../../lib/quarters'

type Value = (q: Quarter) => number | null

type Props = {
  box: ChartBox
  view: View
  value: Value
  axis: (step: number) => (v: number) => string
  aria: string
  count?: number
  strokeWidth?: number
  /** Gestippelde lijn voor het huidige jaar (bijv. verwachte churn). */
  dashed?: Value
  /** Jaartal aan het eind van elke lijn (direct label). */
  directLabels?: boolean
} & HoverProps

const valuesOf = (view: View, f: Value) => view.years.map((l) => l.quarters.map((q) => (q ? f(q) : null)))

export function YearChart({ box, view, value, axis, aria, count = 2, strokeWidth = 2, dashed, directLabels, hover, setHover }: Props) {
  const lines = valuesOf(view, value)
  const current = view.years.find((l) => l.role === 0)
  const dashedValues = dashed && current ? current.quarters.map((q) => (q ? dashed(q) : null)) : null
  const ch = lineChart(box, QUARTER_AXIS, dashedValues ? [...lines, dashedValues] : lines, axis, { count })
  const pos = hover ?? view.currentPos
  const bottom = box.H - box.B
  // Zonder hover: alleen een stip op het gekozen kwartaal; met hover: op elk jaar met een waarde.
  const dots = view.years
    .map((l, i) => ({ l, v: lines[i][pos] }))
    .filter(({ l, v }) => v !== null && (hover !== null || l.role === 0))
    .map(({ l, v }) => ({ color: YEAR_COLORS[l.role], y: ch.ys(v as number), key: l.year }))
  // Direct label: laatste punt met een waarde van elke lijn.
  const ends = view.years.map((l, i) => {
    const last = lines[i].reduce<number>((acc, v, k) => (v !== null ? k : acc), -1)
    return { year: l.year, x: ch.xs(last), y: ch.ys(lines[i][last] as number) }
  })

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${box.W} ${box.H}`}
        width="100%"
        role="img"
        aria-label={aria}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {ch.ticks.map((t) => (
          <line key={t.label + t.y} x1={box.L} x2={box.W - box.R} y1={t.y} y2={t.y} stroke="#eeede8" strokeWidth="1" />
        ))}
        {dashedValues && (
          <path d={ch.paths[lines.length]} fill="none" stroke="#8a8984" strokeWidth={strokeWidth} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
        )}
        {/* Oudste jaar eerst, zodat het gekozen jaar bovenop ligt. */}
        {view.years.map((l, i) => (
          <path
            key={l.year}
            d={ch.paths[i]}
            fill="none"
            stroke={YEAR_COLORS[l.role]}
            strokeWidth={l.role === 0 ? strokeWidth + 0.5 : strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover !== null && <line x1={ch.xs(pos)} x2={ch.xs(pos)} y1={box.T} y2={bottom} stroke="#c9c8c1" strokeWidth="1" />}
        {dots.map((d) => (
          <circle key={d.key} cx={ch.xs(pos)} cy={d.y} r="4.5" fill={d.color} stroke="#ffffff" strokeWidth="2" />
        ))}
        {QUARTER_AXIS.map((qq, i) => (
          <rect
            key={qq}
            x={ch.xs(i) - ch.step / 2}
            y={box.T}
            width={ch.step}
            height={bottom - box.T}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {ch.ticks.map((t) => (
        <span key={t.label + t.y} className="ax" style={{ left: t.left, top: t.top, transform: 'translate(-100%, -50%)' }}>
          {t.label}
        </span>
      ))}
      {ch.xLabels.map((x) => (
        <span key={x.label} className="ax" style={{ left: x.left, top: x.top, transform: 'translateX(-50%)' }}>
          {x.label}
        </span>
      ))}
      {directLabels &&
        ends.map((e) => (
          <span
            key={e.year}
            className="ax year-label"
            style={{ left: `${((e.x + 8) / box.W) * 100}%`, top: `${(e.y / box.H) * 100}%`, transform: 'translateY(-50%)' }}
          >
            {e.year}
          </span>
        ))}
    </div>
  )
}

/** Legenda: één item per jaar, plus eventueel de gestippelde lijn. */
export function YearLegend({ view, dashedLabel }: { view: View; dashedLabel?: string }) {
  return (
    <div className="legend">
      {[...view.years].reverse().map((l) => (
        <span key={l.year} className="legend-item">
          <span style={{ width: 14, height: 2, background: YEAR_COLORS[l.role] }} />
          {l.year}
        </span>
      ))}
      {dashedLabel && (
        <span className="legend-item">
          <span style={{ width: 14, borderTop: '2px dashed #8a8984' }} />
          {dashedLabel}
        </span>
      )}
    </div>
  )
}

/** Hovertekst, kort: "Q2 · '26 20,746 · '25 21,073 · '24 21,490" (nieuwste jaar eerst). */
export function yearRead(view: View, pos: number | null, value: Value, fmt: (v: number) => string): string {
  if (pos === null) return ''
  const parts = [...view.years]
    .reverse()
    .map((l) => ({ year: l.year, v: l.quarters[pos] ? value(l.quarters[pos] as Quarter) : null }))
    .filter((x) => x.v !== null)
    .map((x) => `'${String(x.year).slice(2)} ${fmt(x.v as number)}`)
  return [QUARTER_AXIS[pos], ...parts].join(' · ')
}
