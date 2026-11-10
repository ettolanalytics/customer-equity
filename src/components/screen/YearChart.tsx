// Lijngrafiek met één lijn per jaar (laatste drie jaar) op de as Q1–Q4.
// Gedeeld door de grote grafiek en de tegels; gedeelde hover per kwartaalpositie.
import { lineChart, type ChartBox } from '../../lib/chart'
import type { MouseEvent } from 'react'
import { QUARTER_AXIS, YEAR_COLORS, type Hover, type HoverProps, type Quarter, type View } from '../../lib/quarters'

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
  /** Jaartal aan het eind van elke lijn (direct label). Lijndiktes in schermpixels (non-scaling-stroke), dus overal even dik. */
  directLabels?: boolean
  /** Nul binnen het bereik en een zichtbare nullijn (bijdragen met teken). */
  zero?: boolean
} & HoverProps

const valuesOf = (view: View, f: Value) => view.years.map((l) => l.quarters.map((q) => (q ? f(q) : null)))

export function YearChart({ box, view, value, axis, aria, count = 2, strokeWidth = 1.75, dashed, directLabels, zero, hover, setHover }: Props) {
  const lines = valuesOf(view, value)
  const current = view.years.find((l) => l.role === 0)
  const dashedValues = dashed && current ? current.quarters.map((q) => (q ? dashed(q) : null)) : null
  const ch = lineChart(box, QUARTER_AXIS, dashedValues ? [...lines, dashedValues] : lines, axis, { count, zero })
  const pos = hover?.pos ?? view.currentPos
  const role = hover?.role ?? 0
  const bottom = box.H - box.B
  // Eén stip: op de lijn onder de muis, of zonder hover op het gekozen kwartaal.
  const dots = view.years
    .map((l, i) => ({ l, v: lines[i][pos] }))
    .filter(({ l, v }) => v !== null && l.role === role)
    .map(({ l, v }) => ({ color: YEAR_COLORS[l.role], y: ch.ys(v as number), key: l.year }))
  // Muis → dichtstbijzijnde kwartaal op de x-as, en daar de dichtstbijzijnde lijn op de y-as.
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * box.W
    const y = ((e.clientY - r.top) / r.height) * box.H
    const p = Math.max(0, Math.min(QUARTER_AXIS.length - 1, Math.round((x - box.L) / ch.step)))
    const near = view.years
      .map((l, i) => ({ role: l.role, v: lines[i][p] }))
      .filter((c): c is { role: 0 | 1 | 2; v: number } => c.v !== null)
      .sort((a, b) => Math.abs(ch.ys(a.v) - y) - Math.abs(ch.ys(b.v) - y))[0]
    const next: Hover | null = near ? { pos: p, role: near.role } : null
    if (next?.pos !== hover?.pos || next?.role !== hover?.role) setHover(next)
  }
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
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block', overflow: 'visible', cursor: 'crosshair' }}
      >
        {ch.ticks.map((t) => (
          <line key={t.label + t.y} x1={box.L} x2={box.W - box.R} y1={t.y} y2={t.y} stroke="#eeede8" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {zero && <line x1={box.L} x2={box.W - box.R} y1={ch.ys(0)} y2={ch.ys(0)} stroke="#a8a7a1" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        {dashedValues && (
          <path d={ch.paths[lines.length]} fill="none" stroke="#8a8984" strokeWidth={strokeWidth} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}
        {/* Oudste jaar eerst, zodat het gekozen jaar bovenop ligt. */}
        {view.years.map((l, i) => (
          <path
            key={l.year}
            d={ch.paths[i]}
            fill="none"
            stroke={YEAR_COLORS[l.role]}
            strokeWidth={l.role === 0 ? strokeWidth + 0.5 : strokeWidth}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover !== null && <line x1={ch.xs(pos)} x2={ch.xs(pos)} y1={box.T} y2={bottom} stroke="#c9c8c1" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        {dots.map((d) => (
          // Stip als rond lijnstukje van lengte 0 met non-scaling-stroke: overal even groot op het scherm.
          <g key={d.key}>
            <path d={`M${ch.xs(pos)} ${d.y}h0`} stroke="#ffffff" strokeWidth="12" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <path d={`M${ch.xs(pos)} ${d.y}h0`} stroke={d.color} strokeWidth="8" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>
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
