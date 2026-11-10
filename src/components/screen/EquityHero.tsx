// Hero-kaart (customer equity met vergelijkingen) en lijngrafiek
// "Customer Equity over time": de laatste drie jaar, één lijn per jaar.
import { gb } from '../../lib/format'
import { yearRead, type Change, type HoverProps, type View } from '../../lib/quarters'
import { ChangeLine } from './ChangeLine'
import { YearChart, YearLegend } from './YearChart'

function EquityChange({ change, label }: { change: Change | null; label: string }) {
  if (!change) return null
  const up = change.abs >= 0
  return <ChangeLine up={up} good={up} pill={gb.pct(change.pct)} value={gb.signedEur(change.abs)} label={label} />
}

export function EquityHero({ view, hover, setHover }: { view: View } & HoverProps) {
  const { current, vsQuarterLabel, vsYearLabel, years } = view
  const first = years[0]

  return (
    <section aria-label="Customer equity" className="hero">
      <div className="card" style={{ flex: '1 1 300px', minWidth: 0, padding: '22px 24px' }}>
        <div className="card-head">
          <span className="lbl">Customer Equity</span>
          <span className="tip" style={{ marginLeft: 0 }}>
            <button type="button" className="ib" aria-label="Definition of customer equity">i</button>
            <span className="tt" role="tooltip">
              Customer equity: the sum of the CLV of all active customers. The expected future contribution margin of your current customers, in today's euros.
            </span>
          </span>
          <span className="period">{current.label}</span>
        </div>
        <p className="hero-val">{gb.millions(current.customerEquity)}</p>
        <p className="hero-note">Present value of future margin, not revenue.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
          <EquityChange change={current.equityVsPrevQuarter} label={vsQuarterLabel} />
          <EquityChange change={current.equityVsYearAgo} label={vsYearLabel} />
        </div>
      </div>

      <div className="card" style={{ flex: '2 1 480px', minWidth: 0, padding: '22px 24px' }}>
        <div className="chart-head">
          <span className="lbl">Customer Equity over time</span>
          <span className="chart-read">{yearRead(view, hover, (q) => q.customerEquity, gb.millions)}</span>
        </div>
        <YearLegend view={view} />
        <div style={{ marginTop: 6 }}>
          <YearChart
            box={{ W: 700, H: 230, L: 64, R: 48, T: 10, B: 26 }}
            view={view}
            value={(q) => q.customerEquity}
            axis={gb.axisMillions}
            count={4}
            strokeWidth={2}
            directLabels
            aria={`Line chart of customer equity per quarter, one line per year from ${first.year} to ${current.label}`}
            hover={hover}
            setHover={setHover}
          />
        </div>
        <p className="decomp">
          {gb.num(current.activeEnd)} active customers × {gb.clv(current.avgClv)} average CLV
        </p>
      </div>
    </section>
  )
}
