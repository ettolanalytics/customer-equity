// Hero-kaart (customer equity met vergelijkingen) en lijngrafiek
// "Customer Equity over time", volgens het ontwerp.
import { lineChart } from '../../lib/chart'
import { gb, quarterShort } from '../../lib/format'
import { type Change, type HoverProps, type View } from '../../lib/quarters'
import { ChangeLine } from './ChangeLine'

function EquityChange({ change, label }: { change: Change | null; label: string }) {
  if (!change) return null
  const up = change.abs >= 0
  return <ChangeLine up={up} good={up} pill={gb.pct(change.pct)} value={gb.signedEur(change.abs)} label={label} />
}

export function EquityHero({ view, hover, setHover }: { view: View } & HoverProps) {
  const { series: quarters, current, currentIndex, vsQuarterLabel, vsYearLabel } = view
  const chart = lineChart(
    { W: 700, H: 230, L: 64, R: 12, T: 10, B: 26 },
    quarters.map((q) => quarterShort(q.label)),
    [quarters.map((q) => q.customerEquity)],
    gb.axisMillions,
  )
  const idx = hover ?? currentIndex
  const dot = { x: chart.xs(idx), y: chart.ys(quarters[idx].customerEquity) }
  const first = quarters[0]

  return (
    <section aria-label="Customer equity" className="hero">
      <div className="card" style={{ flex: '1 1 300px', minWidth: 0, padding: '22px 24px' }}>
        <div className="card-head">
          <span className="lbl">Customer Equity</span>
          <span className="tip" style={{ marginLeft: 0 }}>
            <button type="button" className="ib" aria-label="Definition of customer equity">i</button>
            <span className="tt" role="tooltip">
              Customer equity: the expected future contribution margin of your current customers, discounted to today.
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
          <span className="chart-read">
            {hover !== null ? `${quarters[hover].label} · ${gb.millions(quarters[hover].customerEquity)}` : ''}
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ position: 'relative' }}>
            <svg
              viewBox="0 0 700 230"
              width="100%"
              role="img"
              aria-label={`Line chart of customer equity per quarter from ${gb.millions(first.customerEquity)} in ${first.label} to ${gb.millions(current.customerEquity)} in ${current.label}`}
              onMouseLeave={() => setHover(null)}
              style={{ display: 'block', overflow: 'visible' }}
            >
              {chart.ticks.map((t) => (
                <line key={t.label} x1="64" x2="688" y1={t.y} y2={t.y} stroke="#eeede8" strokeWidth="1" />
              ))}
              <path d={chart.paths[0]} fill="none" stroke="#2a78d6" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
              {hover !== null && <line x1={dot.x} x2={dot.x} y1="10" y2="204" stroke="#c9c8c1" strokeWidth="1" />}
              <circle cx={dot.x} cy={dot.y} r="5" fill="#2a78d6" stroke="#ffffff" strokeWidth="2" />
              {quarters.map((q, i) => (
                <rect
                  key={q.label}
                  x={chart.xs(i) - chart.step / 2}
                  y="10"
                  width={chart.step}
                  height="194"
                  fill="transparent"
                  style={{ cursor: 'crosshair' }}
                  onMouseEnter={() => setHover(i)}
                />
              ))}
            </svg>
            {chart.ticks.map((t) => (
              <span key={t.label} className="ax" style={{ left: t.left, top: t.top, transform: 'translate(-100%, -50%)' }}>
                {t.label}
              </span>
            ))}
            {chart.xLabels.map((x) => (
              <span key={x.label} className="ax" style={{ left: x.left, top: x.top, transform: 'translateX(-50%)' }}>
                {x.label}
              </span>
            ))}
          </div>
        </div>
        <p className="decomp">
          {gb.num(current.activeEnd)} active customers × {gb.clv(current.avgClv)} average CLV
        </p>
      </div>
    </section>
  )
}
