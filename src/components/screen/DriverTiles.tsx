// "What drives the value": de twee factoren van customer equity (Active customers,
// Average CLV) met hun drivers eronder (CLAUDE.md, Opbouw van het scherm).
// Elke tegel in de stijl van het ontwerp: waarde, vergelijkingen, minigrafiek, hover.
// Minigrafiek: de laatste drie jaar, één lijn per jaar (YearChart).
import type { ReactNode } from 'react'
import type { ChartBox } from '../../lib/chart'
import { gb } from '../../lib/format'
import { assumptions as a, QUARTER_AXIS, type Change, type HoverProps, type Quarter, type View } from '../../lib/quarters'
import { ChangeLine } from './ChangeLine'
import { YearChart, YearLegend, yearRead } from './YearChart'

const BOX_FACTOR: ChartBox = { W: 600, H: 120, L: 56, R: 8, T: 6, B: 22 }
const BOX_DRIVER: ChartBox = { W: 300, H: 110, L: 48, R: 8, T: 6, B: 22 }

type Tile = {
  id?: string
  label: string
  tip: string
  value: string
  vsQuarter: ReactNode
  vsYear: ReactNode
  /** Waarde per kwartaal in de minigrafiek (één lijn per jaar). */
  metric: (q: Quarter) => number | null
  /** Gestippelde lijn voor het gekozen jaar (verwachte churn), met legenda. */
  dashed?: (q: Quarter) => number | null
  dashedLabel?: string
  aria: string
  axis: (step: number) => (v: number) => string
  /** Tekst boven de grafiek bij hover (of altijd, bij churn). */
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

/**
 * Churn: zonder hover het gekozen kwartaal (werkelijk en verwacht); met hover elk jaar,
 * plus verwacht voor het gekozen jaar ("Exp. —" zonder waarde).
 */
function churnRead(view: View, hover: number | null): string {
  const pos = hover ?? view.currentPos
  const cur = view.years.find((l) => l.role === 0)?.quarters[pos] ?? null
  const exp = cur ? ` · Exp. ${cur.expectedChurn === null ? '—' : gb.num(cur.expectedChurn)}` : ''
  if (hover === null) return `${view.current.label} · ${gb.num(view.current.churn)}${exp}`
  return yearRead(view, pos, (q) => q.churn, gb.num) + exp
}

function tiles(view: View) {
  const { current: c, vsQuarterLabel: vq, vsYearLabel: vy } = view
  const hoverText = (h: number | null, f: (q: Quarter) => number, fmt: (v: number) => string) => yearRead(view, h, f, fmt)

  const active: Tile = {
    id: 'active',
    label: 'Active customers',
    tip: `Active customers: customers with a running subscription, or within ${a.graceDays} days after it expired. Previous quarter + new + reacquired − churn.`,
    value: gb.num(c.activeEnd),
    vsQuarter: countChange(c.activeVsPrevQuarter, vq, gb.signedCount),
    vsYear: countChange(c.activeVsYearAgo, vy, gb.signedCount),
    metric: (q) => q.activeEnd,
    aria: 'Line chart of active customers per quarter',
    axis: gb.axisCount,
    read: (h) => hoverText(h, (q) => q.activeEnd, gb.num),
  }
  const clv: Tile = {
    id: 'clv',
    label: 'Average CLV',
    tip: 'Average CLV (customer lifetime value): remaining value per current customer. The expected future contribution margin of a current customer, discounted to today. Customer equity ÷ number of active customers.',
    value: gb.clv(c.avgClv),
    vsQuarter: countChange(c.avgClvVsPrevQuarter, vq, gb.signedClv),
    vsYear: countChange(c.avgClvVsYearAgo, vy, gb.signedClv),
    metric: (q) => q.avgClv,
    aria: 'Line chart of average CLV per customer per quarter',
    axis: gb.axisClv,
    read: (h) => hoverText(h, (q) => q.avgClv, gb.clv),
  }
  const activeDrivers: Tile[] = [
    {
      label: 'New',
      tip: 'New: customers whose first paid subscription started in the quarter and who are still active at the end of it.',
      value: gb.num(c.newCustomers),
      vsQuarter: countChange(c.newVsPrevQuarter, vq, gb.signedCount),
      vsYear: countChange(c.newVsYearAgo, vy, gb.signedCount),
      metric: (q) => q.newCustomers,
      aria: 'Line chart of new customers per quarter',
      axis: gb.axisCount,
      read: (h) => hoverText(h, (q) => q.newCustomers, gb.num),
    },
    {
      label: 'Reacquired',
      tip: `Customers who churned earlier (more than ${a.graceDays} days without a subscription) and came back.`,
      value: gb.num(c.reacquiredCustomers),
      vsQuarter: countChange(c.reacquiredVsPrevQuarter, vq, gb.signedCount),
      vsYear: countChange(c.reacquiredVsYearAgo, vy, gb.signedCount),
      metric: (q) => q.reacquiredCustomers,
      aria: 'Line chart of reacquired customers per quarter',
      axis: gb.axisCount,
      read: (h) => hoverText(h, (q) => q.reacquiredCustomers, gb.num),
    },
    {
      label: 'Churn',
      tip: `Churn: customers active at the start of the quarter who left during it (no new subscription within ${a.graceDays} days). Expected churn: based on last year’s churn rate.`,
      value: gb.num(c.churn),
      vsQuarter: countChange(c.churnVsPrevQuarter, vq, gb.signedCount, false),
      vsYear: countChange(c.churnVsYearAgo, vy, gb.signedCount, false),
      metric: (q) => q.churn,
      dashed: (q) => q.expectedChurn,
      dashedLabel: 'Expected',
      aria: 'Line chart of actual and expected churn per quarter',
      axis: gb.axisCount,
      read: (h) => churnRead(view, h),
    },
  ]
  const clvDrivers: Tile[] = [
    {
      label: 'Margin per customer',
      tip: `Margin per customer: contribution margin (${gb.clv(a.priceEur)} price minus ${gb.clv(a.costPerInvoiceEur)} cost = ${gb.clv(a.marginPerInvoiceEur)} per monthly invoice) per active customer per quarter.`,
      value: gb.clv(c.marginPerCustomer),
      vsQuarter: countChange(c.marginVsPrevQuarter, vq, gb.signedClv),
      vsYear: countChange(c.marginVsYearAgo, vy, gb.signedClv),
      metric: (q) => q.marginPerCustomer,
      aria: 'Line chart of margin per customer per quarter',
      axis: gb.axisClv,
      read: (h) => hoverText(h, (q) => q.marginPerCustomer, gb.clv),
    },
    {
      label: 'Retention (4-quarter average)',
      tip: 'Average churn of the previous four quarters, used to calculate CLV. Differs from this quarter’s churn.',
      value: gb.pct(c.retention),
      vsQuarter: pointChange(c.retentionVsPrevQuarter, vq, true),
      vsYear: pointChange(c.retentionVsYearAgo, vy, true),
      metric: (q) => q.retention,
      aria: 'Line chart of retention per quarter',
      axis: gb.axisPct,
      read: (h) => hoverText(h, (q) => q.retention, gb.pct),
    },
  ]
  return { active, clv, activeDrivers, clvDrivers }
}

function TileCard({ tile, box, view, hover, setHover }: { tile: Tile; box: ChartBox; view: View } & HoverProps) {
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
      {tile.dashedLabel && (
        <div className="legend">
          <span className="legend-item">
            <span style={{ width: 14, borderTop: '2px dashed #8a8984' }} />
            {tile.dashedLabel}
          </span>
        </div>
      )}
      <p className="tile-read">{tile.read(hover)}</p>
      <div style={{ marginTop: 4 }}>
        <YearChart
          box={box}
          view={view}
          value={tile.metric}
          dashed={tile.dashed}
          axis={tile.axis}
          aria={`${tile.aria}, ${QUARTER_AXIS.join('–')}, one line per year`}
          hover={hover}
          setHover={setHover}
        />
      </div>
    </div>
  )
}

export function DriverTiles({ view, ...hover }: { view: View } & HoverProps) {
  const t = tiles(view)
  const card = (tile: Tile, box: ChartBox) => <TileCard key={tile.label} tile={tile} box={box} view={view} {...hover} />
  return (
    <>
      <div className="sh-row">
        <h2 id="drivers" className="sh">What drives the value</h2>
        <YearLegend view={view} />
      </div>
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
