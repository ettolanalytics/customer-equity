// "What drives the value": de twee factoren van customer equity (Active customers,
// Average CLV) met hun drivers eronder (CLAUDE.md, Opbouw van het scherm).
// Elke tegel in de stijl van het ontwerp: waarde, vergelijkingen, minigrafiek, hover.
import type { ReactNode } from 'react'
import { lineChart, type ChartBox } from '../../lib/chart'
import { gb, quarterShort } from '../../lib/format'
import type { Change, HoverProps, Quarter, View } from '../../lib/quarters'
import { ChangeLine } from './ChangeLine'

const BOX_FACTOR: ChartBox = { W: 600, H: 120, L: 56, R: 8, T: 6, B: 22 }
const BOX_DRIVER: ChartBox = { W: 300, H: 110, L: 48, R: 8, T: 6, B: 22 }

const C_ACTIVE = '#2a78d6'
const C_NEW = '#1baf7a'
const C_REACQUIRED = '#136f53'
const C_CHURN = '#eb6834'
const C_CLV = '#6250d6'
const C_MARGIN = '#7c6be3'
const C_RETENTION = '#4a3bb8'
const C_EXPECTED = '#8a8984'

type Line = { legend: string; color: string; values: (number | null)[]; dashed?: boolean }

type Tile = {
  id?: string
  label: string
  tip: string
  value: string
  vsQuarter: ReactNode
  vsYear: ReactNode
  /** Lijnen in de minigrafiek, met legenda. Gestippeld = verwachte waarde. */
  lines: Line[]
  aria: string
  axis: (step: number) => (v: number) => string
  /** Tekst rechtsboven de grafiek bij hover (of altijd, bij churn). */
  read: (hover: number | null) => string
}

/** Vergelijking van een aantal of bedrag. goodWhenUp: groen bij stijging. */
function countChange(change: Change | null, label: string, fmt: (v: number) => string, goodWhenUp = true) {
  if (!change) return null
  const up = change.abs >= 0
  return <ChangeLine up={up} good={up === goodWhenUp} pill={gb.pct(change.pct)} value={fmt(change.abs)} label={label} />
}

/** Vergelijking van een fractie in procentpunten. */
function pointChange(diff: number | null, label: string, goodWhenUp: boolean) {
  if (diff === null) return null
  const up = diff >= 0
  return <ChangeLine up={up} good={up === goodWhenUp} pill={gb.points(diff)} label={label} />
}

function churnRead(q: Quarter): string {
  const head = `${q.label} · Actual ${gb.num(q.churn)} · Expected `
  if (q.expectedChurn === null || q.churnVsExpectedCount === null) return head + '—'
  return head + `${gb.num(q.expectedChurn)} · ${gb.signedCount(q.churnVsExpectedCount)}`
}

function tiles({ series: quarters, current: c, currentIndex, vsQuarterLabel: vq, vsYearLabel: vy }: View) {
  const pick = <T,>(f: (q: Quarter) => T) => quarters.map(f)
  const hoverText = (h: number | null, f: (q: Quarter) => string) => (h === null ? '' : `${quarters[h].label} · ${f(quarters[h])}`)

  const active: Tile = {
    id: 'active',
    label: 'Active customers',
    tip: 'Active customers: customers with a running subscription, or within 30 days after it expired. Previous quarter + new + reacquired − churn.',
    value: gb.num(c.activeEnd),
    vsQuarter: countChange(c.activeVsPrevQuarter, vq, gb.signedCount),
    vsYear: countChange(c.activeVsYearAgo, vy, gb.signedCount),
    lines: [{ legend: 'Active customers', color: C_ACTIVE, values: pick((q) => q.activeEnd) }],
    aria: 'Line chart of active customers per quarter',
    axis: gb.axisCount,
    read: (h) => hoverText(h, (q) => gb.num(q.activeEnd)),
  }
  const clv: Tile = {
    id: 'clv',
    label: 'Average CLV',
    tip: 'Average CLV (customer lifetime value): remaining value per current customer. The expected future contribution margin of a current customer, discounted to today. Customer equity ÷ number of active customers.',
    value: gb.clv(c.avgClv),
    vsQuarter: countChange(c.avgClvVsPrevQuarter, vq, gb.signedClv),
    vsYear: countChange(c.avgClvVsYearAgo, vy, gb.signedClv),
    lines: [{ legend: 'Average CLV', color: C_CLV, values: pick((q) => q.avgClv) }],
    aria: 'Line chart of average CLV per customer per quarter',
    axis: gb.axisClv,
    read: (h) => hoverText(h, (q) => gb.clv(q.avgClv)),
  }
  const activeDrivers: Tile[] = [
    {
      label: 'New',
      tip: 'New: customers whose first paid subscription started in the quarter and who are still active at the end of it.',
      value: gb.num(c.newCustomers),
      vsQuarter: countChange(c.newVsPrevQuarter, vq, gb.signedCount),
      vsYear: countChange(c.newVsYearAgo, vy, gb.signedCount),
      lines: [{ legend: 'New', color: C_NEW, values: pick((q) => q.newCustomers) }],
      aria: 'Line chart of new customers per quarter',
      axis: gb.axisCount,
      read: (h) => hoverText(h, (q) => gb.num(q.newCustomers)),
    },
    {
      label: 'Reacquired',
      tip: 'Customers who churned earlier (more than 30 days without a subscription) and came back.',
      value: gb.num(c.reacquiredCustomers),
      vsQuarter: countChange(c.reacquiredVsPrevQuarter, vq, gb.signedCount),
      vsYear: countChange(c.reacquiredVsYearAgo, vy, gb.signedCount),
      lines: [{ legend: 'Reacquired', color: C_REACQUIRED, values: pick((q) => q.reacquiredCustomers) }],
      aria: 'Line chart of reacquired customers per quarter',
      axis: gb.axisCount,
      read: (h) => hoverText(h, (q) => gb.num(q.reacquiredCustomers)),
    },
    {
      label: 'Churn',
      tip: 'Churn: customers active at the start of the quarter who left during it (no new subscription within 30 days). Expected churn: based on last year’s churn rate.',
      value: gb.num(c.churn),
      vsQuarter: countChange(c.churnVsPrevQuarter, vq, gb.signedCount, false),
      vsYear: countChange(c.churnVsYearAgo, vy, gb.signedCount, false),
      lines: [
        { legend: 'Churn', color: C_CHURN, values: pick((q) => q.churn) },
        { legend: 'Expected', color: C_EXPECTED, values: pick((q) => q.expectedChurn), dashed: true },
      ],
      aria: 'Line chart of actual and expected churn per quarter',
      axis: gb.axisCount,
      read: (h) => churnRead(quarters[h ?? currentIndex]),
    },
  ]
  const clvDrivers: Tile[] = [
    {
      label: 'Margin per customer',
      tip: 'Margin per customer: contribution margin (30% of revenue) per active customer per quarter.',
      value: gb.clv(c.marginPerCustomer),
      vsQuarter: countChange(c.marginVsPrevQuarter, vq, gb.signedClv),
      vsYear: countChange(c.marginVsYearAgo, vy, gb.signedClv),
      lines: [{ legend: 'Margin per customer', color: C_MARGIN, values: pick((q) => q.marginPerCustomer) }],
      aria: 'Line chart of margin per customer per quarter',
      axis: gb.axisClv,
      read: (h) => hoverText(h, (q) => gb.clv(q.marginPerCustomer)),
    },
    {
      label: 'Retention (4-quarter average)',
      tip: 'Average churn of the previous four quarters, used to calculate CLV. Differs from this quarter’s churn.',
      value: gb.pct(c.retention),
      vsQuarter: pointChange(c.retentionVsPrevQuarter, vq, true),
      vsYear: pointChange(c.retentionVsYearAgo, vy, true),
      lines: [{ legend: 'Retention', color: C_RETENTION, values: pick((q) => q.retention) }],
      aria: 'Line chart of retention per quarter',
      axis: gb.axisPct,
      read: (h) => hoverText(h, (q) => gb.pct(q.retention)),
    },
  ]
  return { active, clv, activeDrivers, clvDrivers }
}

function TileCard({ tile, box, view, hover, setHover }: { tile: Tile; box: ChartBox; view: View } & HoverProps) {
  const quarters = view.series
  const ch = lineChart(
    box,
    quarters.map((q) => quarterShort(q.label)),
    tile.lines.map((l) => l.values),
    tile.axis,
    { count: 2, ends: true },
  )
  const idx = hover ?? view.currentIndex
  const x = ch.xs(idx)
  const bottom = box.H - box.B
  // Stip op elke doorgetrokken lijn met een waarde in dit kwartaal.
  const dots = tile.lines
    .filter((l) => !l.dashed && l.values[idx] !== null)
    .map((l) => ({ color: l.color, y: ch.ys(l.values[idx] as number) }))

  return (
    <div id={tile.id} className="card tile">
      <div className="card-head">
        <span className="lbl">{tile.label}</span>
        <span className="tip" style={{ marginLeft: 0 }}>
          <button type="button" className="ib" aria-label="Explanation">i</button>
          <span className="tt" role="tooltip">{tile.tip}</span>
        </span>
        <span className="period">{view.current.label}</span>
      </div>
      <p className="tile-val">{tile.value}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {tile.vsQuarter}
        {tile.vsYear}
      </div>
      <div className="legend">
        {tile.lines.map((l) => (
          <span key={l.legend} className="legend-item">
            <span style={l.dashed ? { width: 14, borderTop: `2px dashed ${l.color}` } : { width: 14, height: 2, background: l.color }} />
            {l.legend}
          </span>
        ))}
      </div>
      <p className="tile-read">{tile.read(hover)}</p>
      <div style={{ position: 'relative', marginTop: 4 }}>
        <svg
          viewBox={`0 0 ${box.W} ${box.H}`}
          width="100%"
          role="img"
          aria-label={tile.aria}
          onMouseLeave={() => setHover(null)}
          style={{ display: 'block', overflow: 'visible' }}
        >
          {ch.ticks.map((t) => (
            <line key={t.label} x1={box.L} x2={box.W - box.R} y1={t.y} y2={t.y} stroke="#eeede8" strokeWidth="1" />
          ))}
          {/* Gestippelde lijnen eerst, zoals in het ontwerp. */}
          {tile.lines
            .map((l, i) => ({ l, d: ch.paths[i] }))
            .sort((a, b) => Number(b.l.dashed ?? false) - Number(a.l.dashed ?? false))
            .map(({ l, d }) => (
              <path
                key={l.legend}
                d={d}
                fill="none"
                stroke={l.color}
                strokeWidth="2"
                strokeDasharray={l.dashed ? '5 4' : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          {hover !== null && <line x1={x} x2={x} y1={box.T} y2={bottom} stroke="#c9c8c1" strokeWidth="1" />}
          {dots.map((d) => (
            <circle key={d.color} cx={x} cy={d.y} r="4" fill={d.color} stroke="#ffffff" strokeWidth="2" />
          ))}
          {quarters.map((q, i) => (
            <rect
              key={q.label}
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
          <span key={t.label} className="ax" style={{ left: t.left, top: t.top, transform: 'translate(-100%, -50%)' }}>
            {t.label}
          </span>
        ))}
        {ch.xLabels.map((xl) => (
          <span key={xl.label} className="ax" style={{ left: xl.left, top: xl.top, transform: 'translateX(-50%)' }}>
            {xl.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function DriverTiles({ view, ...hover }: { view: View } & HoverProps) {
  const t = tiles(view)
  const card = (tile: Tile, box: ChartBox) => <TileCard key={tile.label} tile={tile} box={box} view={view} {...hover} />
  return (
    <>
      <h2 id="drivers" className="sh">What drives the value</h2>
      {/* Raster: rij 1 de factoren, rij 2 hun drivers, elk groepje onder zijn factor. */}
      <section aria-label="What drives the value" className="factors">
        <div className="f-active">{card(t.active, BOX_FACTOR)}</div>
        <div className="f-clv">{card(t.clv, BOX_FACTOR)}</div>
        <div className="drivers drivers-3 d-active" aria-label="Drivers of active customers">
          {t.activeDrivers.map((d) => card(d, BOX_DRIVER))}
        </div>
        <div className="drivers drivers-2 d-clv" aria-label="Drivers of average CLV">
          {t.clvDrivers.map((d) => card(d, BOX_DRIVER))}
        </div>
      </section>
    </>
  )
}
