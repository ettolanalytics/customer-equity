// "What drives the value": de twee factoren van customer equity (Active customers,
// Average CLV) met hun drivers eronder (CLAUDE.md, Opbouw van het scherm).
// Elke tegel in de stijl van het ontwerp: waarde, vergelijkingen, minigrafiek, hover.
// Proefversie v2: drivers van de CLV zijn Mix effect en Value effect (data: customerMix, existingCustomerValue).
// Stock tegenover flow (migratie 17): stock-tegels (actieve klanten, CLV) tonen QoQ en YoY; de flows
// (New, Reacquired, Churn, gebeurtenissen) QoQ en YoY (migratie 19: dit kwartaal t.o.v. hetzelfde
// kwartaal een jaar eerder). Onder de CLV-tegel de kaart "What changed average CLV" (ClvChangeCard):
// bars voor bestaande klanten, wie kwam en ging en het totaal, QoQ en YoY; geen minigrafiek.
// Alle sommen en verschillen komen uit de data.
// Minigrafiek: de laatste drie jaar, één lijn per jaar (YearChart).
import type { ReactNode } from 'react'
import type { ChartBox } from '../../lib/chart'
import { gb } from '../../lib/format'
import { assumptions as a, QUARTER_AXIS, yearRead, type Change, type Hover, type HoverProps, type Quarter, type View } from '../../lib/quarters'
import { ChangeLine } from './ChangeLine'
import { ClvChangeCard } from './ClvChangeCard'
import { YearChart, YearLegend } from './YearChart'

const BOX_FACTOR: ChartBox = { W: 600, H: 120, L: 56, R: 8, T: 6, B: 22 }
const BOX_DRIVER: ChartBox = { W: 300, H: 110, L: 48, R: 8, T: 6, B: 22 }

type Tile = {
  id?: string
  label: string
  tip: string
  value: string
  /** Vergelijkingsregels onder de waarde. */
  lines: ReactNode[]
  /** Waarde per kwartaal in de minigrafiek (één lijn per jaar). */
  metric: (q: Quarter) => number | null
  aria: string
  axis: (step: number) => (v: number) => string
  /** Nul in beeld met nullijn (bijdragen met teken). */
  zero?: boolean
  /** Tekst boven de grafiek bij hover. */
  read: (hover: Hover | null) => string
}

/** Vergelijking van een aantal of bedrag. goodWhenUp: groen bij stijging. */
function countChange(change: Change | null, label: string, fmt: (v: number) => string, goodWhenUp = true) {
  if (!change) return null
  const up = change.abs >= 0
  return <ChangeLine up={up} good={up === goodWhenUp} pill={gb.pct(change.pct)} value={fmt(change.abs)} label={label} />
}

function tiles(view: View) {
  const { current: c, vsQuarterLabel: vq, vsYearLabel: vy } = view
  const hoverText = (h: Hover | null, f: (q: Quarter) => number, fmt: (v: number) => string) => yearRead(view, h, f, fmt)

  const active: Tile = {
    id: 'active',
    label: 'Active customers',
    tip: `Active customers: customers with a running subscription, or within ${a.graceDays} days after it expired. Previous quarter + new + reacquired − churn. Measured on the last day of the quarter.`,
    value: gb.num(c.activeEnd),
    lines: [countChange(c.activeVsPrevQuarter, vq, gb.signedCount), countChange(c.activeVsYearAgo, vy, gb.signedCount)],
    metric: (q) => q.activeEnd,
    aria: 'Line chart of active customers per quarter',
    axis: gb.axisCount,
    read: (h) => hoverText(h, (q) => q.activeEnd, gb.num),
  }
  const clv: Tile = {
    id: 'clv',
    label: 'CLV',
    tip: `Average value of an active customer: the contribution margin we expect from them over the next ${gb.num(a.horizonMonths / 12)} years, in today's euros at ${gb.num(a.discountRateYear * 100)}% per year. Measured on the last day of the quarter.`,
    value: gb.clv(c.avgClv),
    lines: [countChange(c.avgClvVsPrevQuarter, vq, gb.signedClv), countChange(c.avgClvVsYearAgo, vy, gb.signedClv)],
    metric: (q) => q.avgClv,
    aria: 'Line chart of average CLV per customer per quarter',
    axis: gb.axisClv,
    read: (h) => hoverText(h, (q) => q.avgClv, gb.clv),
  }
  const activeDrivers: Tile[] = [
    {
      label: 'New',
      tip: 'New: first-ever paid subscriptions, also when the customer left again within the quarter. Counts all events during the quarter.',
      value: gb.num(c.newCustomers),
      lines: [countChange(c.newVsPrevQuarter, vq, gb.signedCount), countChange(c.newVsYearAgo, vy, gb.signedCount)],
      metric: (q) => q.newCustomers,
      aria: 'Line chart of new customers per quarter',
      axis: gb.axisCount,
      read: (h) => hoverText(h, (q) => q.newCustomers, gb.num),
    },
    {
      label: 'Reacquired',
      tip: `Customers who churned earlier (more than ${a.graceDays} days without a subscription) and came back; a customer can come back more than once. Counts all events during the quarter.`,
      value: gb.num(c.reacquiredCustomers),
      lines: [
        countChange(c.reacquiredVsPrevQuarter, vq, gb.signedCount),
        countChange(c.reacquiredVsYearAgo, vy, gb.signedCount),
      ],
      metric: (q) => q.reacquiredCustomers,
      aria: 'Line chart of reacquired customers per quarter',
      axis: gb.axisCount,
      read: (h) => hoverText(h, (q) => q.reacquiredCustomers, gb.num),
    },
    {
      label: 'Churn',
      tip: `Churn: each time ${a.graceDays} days passed after a subscription ended without a new payment; a customer can churn more than once. Counts all events during the quarter.`,
      value: gb.num(c.churn),
      lines: [
        countChange(c.churnVsPrevQuarter, vq, gb.signedCount, false),
        countChange(c.churnVsYearAgo, vy, gb.signedCount, false),
      ],
      metric: (q) => q.churn,
      aria: 'Line chart of churn per quarter',
      axis: gb.axisCount,
      read: (h) => hoverText(h, (q) => q.churn, gb.num),
    },
  ]
  return { active, clv, activeDrivers }
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
        {tile.lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
      <p className="tile-read">{tile.read(hover)}</p>
      <div style={{ marginTop: 4 }}>
        <YearChart
          box={box}
          view={view}
          value={tile.metric}
          axis={tile.axis}
          zero={tile.zero}
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
        <h2 id="drivers" className="sh">Value drivers</h2>
        <YearLegend view={view} />
      </div>
      {/* Raster: rij 1 de factoren, rij 2 hun drivers, elk groepje onder zijn factor. */}
      <section aria-label="Value drivers" className="factors">
        <div className="f-active">{card(t.active, BOX_FACTOR)}</div>
        <div className="f-clv">{card(t.clv, BOX_FACTOR)}</div>
        <div className="drivers drivers-3 d-active" aria-label="Drivers of active customers">
          {t.activeDrivers.map((d) => card(d, BOX_DRIVER))}
        </div>
        <div className="drivers d-clv" aria-label="What changed average CLV">
          <ClvChangeCard view={view} />
        </div>
      </section>
    </>
  )
}
