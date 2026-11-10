// Waterfall "Why did customer equity change…?" met toggle Year / Quarter en toelichting
// per regel. Proefversie v2: vijf balken (ontwerp v3.4 §9, CLAUDE.md Verklaring van de verandering).
// Alle bedragen en aantallen komen uit de JSON; hier alleen indeling en plaatsing.
import { useState } from 'react'
import { niceTicks, pctOf } from '../../lib/chart'
import { gb, quarterShort } from '../../lib/format'
import type { View, Waterfall } from '../../lib/quarters'

const C_TOT = '#2a78d6'
const C_UP = '#1baf7a'
const C_DN = '#eb6834'
const WL = 64, WR = 12, WT = 52, WB = 50, WH = 300, WW = 640

type Mode = 'year' | 'quarter'
type Item = { label: string; value: number; note: string }

function zig(x: number, w: number, y: number) {
  const n = Math.max(4, Math.round(w / 6))
  let d = 'M' + (x - 1).toFixed(1) + ' ' + y.toFixed(1)
  for (let k = 1; k <= n; k++) d += ' L' + (x - 1 + ((w + 2) * k) / n).toFixed(1) + ' ' + (y + (k % 2 ? -3 : 3)).toFixed(1)
  return d
}

/** De vijf balken met label en toelichting, in vaste volgorde (ontwerp v3.4 §9). */
function items(w: Waterfall, mode: Mode): Item[] {
  const p = w.parts
  const c = w.counts
  const year = mode === 'year'
  // Kwartaal: × de gemiddelde CLV aan het begin. Jaar: som van vier kwartalen, elk met zijn eigen begin.
  const atStart = year ? ' over four quarters × the average CLV at the start of each quarter' : ` × ${gb.clv(w.avgClvBegin)} average CLV at the start`
  const perCustomer = year ? ' over four quarters, × the customers at the end of each quarter' : ` × ${gb.num(w.customersEnd)} customers`
  return [
    { label: 'New customers', value: p.newCustomers, note: `${gb.num(c.newCustomers)} new customers${atStart}.` },
    { label: 'Reacquired customers', value: p.reacquiredCustomers, note: `${gb.num(c.reacquiredCustomers)} reacquired customers${atStart}.` },
    { label: 'Churn', value: p.churn, note: `${gb.num(c.churn)} customers churned${atStart}.` },
    {
      label: 'Customer mix',
      value: p.customerMix,
      note: `Average CLV ${gb.signedClv(w.customerMixPerCustomer)} from the customer mix${perCustomer}.`,
    },
    {
      label: 'Existing customer value',
      value: p.existingCustomerValue,
      note: `Average CLV ${gb.signedClv(w.existingCustomerValuePerCustomer)} from existing customers${perCustomer}.`,
    },
  ]
}

export function WaterfallSection({ view }: { view: View }) {
  const [mode, setMode] = useState<Mode>('year')
  const w = mode === 'year' ? view.current.yearWaterfall : view.current.waterfall
  if (!w) return null

  // Positief onder Added, negatief onder Lost.
  const all = items(w, mode)
  const added = all.filter((i) => i.value >= 0)
  const lost = all.filter((i) => i.value < 0)
  const vsLabel = mode === 'year' ? view.vsYearLabel : view.vsQuarterLabel

  type Step = { label: string; total: boolean; value: number; group: 0 | 1 | null }
  const steps: Step[] = [
    { label: 'Start ' + quarterShort(w.fromLabel), total: true, value: w.equityBegin, group: null },
    ...added.map((i) => ({ label: i.label, total: false, value: i.value, group: 0 as const })),
    ...lost.map((i) => ({ label: i.label, total: false, value: i.value, group: 1 as const })),
    { label: 'End ' + quarterShort(w.toLabel), total: true, value: w.equityEnd, group: null },
  ]

  // Plaatsing: elke balk begint waar de vorige eindigde.
  let level = w.equityBegin
  const placed = steps.map((s) => {
    if (s.total) {
      level = s.value
      return { s, from: null as number | null, to: s.value }
    }
    const from = level
    level = from + s.value
    return { s, from, to: level }
  })
  const levels = placed.flatMap((p) => (p.from === null ? [p.to] : [p.from, p.to]))
  const lmin = Math.min(...levels)
  const lmax = Math.max(...levels)
  const nt = niceTicks(Math.max(0, lmin - (lmax - lmin) * 1.1), lmax + (lmax - lmin) * 0.12, 4)
  const y0 = nt.ticks[0]
  const y1 = nt.ticks[nt.ticks.length - 1]
  const ys = (v: number) => WH - WB - ((v - y0) / (y1 - y0)) * (WH - WT - WB)
  const bw = (WW - WL - WR) / steps.length
  const barW = Math.min(64, bw * 0.55)
  const fmtAxis = gb.axisMillions(nt.step)

  const bars = placed.map((p, i) => {
    const cx = WL + bw * i + bw / 2
    const top = p.from === null ? p.to : Math.max(p.from, p.to)
    const bot = p.from === null ? y0 : Math.min(p.from, p.to)
    const isEnd = p.s.total && i > 0
    return {
      key: p.s.label,
      x: cx - barW / 2,
      y: ys(top),
      h: Math.max(1.5, ys(bot) - ys(top)),
      fill: p.s.total ? C_TOT : p.s.group === 0 ? C_UP : C_DN,
      zz: p.s.total ? zig(cx - barW / 2, barW, ys(y0) - 10) : '',
      vl: pctOf((cx / WW) * 100),
      vt: pctOf(((ys(top) - 6) / WH) * 100),
      ct: pctOf(((WH - WB + 8) / WH) * 100),
      val: p.s.total ? gb.millions(p.to) : gb.signedThousands(p.s.value),
      sub: isEnd ? `${gb.signedPct(w.equityChangePct)} ${vsLabel}` : '',
      label: p.s.label,
      group: p.s.group,
    }
  })
  const links = placed.slice(0, -1).map((p, i) => ({
    x1: WL + bw * i + bw / 2 + barW / 2,
    x2: WL + bw * (i + 1) + bw / 2 - barW / 2,
    y: ys(p.to),
  }))
  const groups = (['Added', 'Lost'] as const)
    .map((label, g) => ({ label, bs: bars.filter((b) => b.group === g) }))
    .filter(({ bs }) => bs.length > 0)
    .map(({ label, bs }) => {
      const x1 = bs[0].x
      const x2 = bs[bs.length - 1].x + barW
      return { label, d: `M${x1.toFixed(1)} 24 L${x2.toFixed(1)} 24`, left: pctOf(((x1 + x2) / 2 / WW) * 100), top: pctOf((12 / WH) * 100) }
    })

  const row = (i: Item, fill: string) => (
    <div key={i.label} className="wf-row">
      <div className="wf-row-main">
        <span className="wf-row-label">
          <span className="wf-swatch" style={{ background: fill }} />
          <span style={{ minWidth: 0 }}>{i.label}</span>
        </span>
        <span className="wf-row-val">{gb.signedEur(i.value)}</span>
      </div>
      <p className="wf-note">{i.note}</p>
    </div>
  )
  const totalRow = (label: string, value: number, note: string) => (
    <div key={label} className="wf-row">
      <div className="wf-row-main">
        <span className="wf-row-label" style={{ fontWeight: 500 }}>
          <span className="wf-swatch" style={{ background: C_TOT }} />
          <span style={{ minWidth: 0 }}>{label}</span>
        </span>
        <span className="wf-row-val" style={{ fontWeight: 500 }}>{gb.millions(value)}</span>
      </div>
      <p className="wf-note">{note}</p>
    </div>
  )

  return (
    <section id="change" className="card section" aria-label="Change">
      <div className="wf-head">
        <h2 className="section-title">
          Why did customer equity change by {gb.signedThousands(w.equityChange).replace(/^\+/, '')}?
        </h2>
        <div className="wf-head-r">
          <span className="wf-sub">
            {w.fromLabel} → {w.toLabel}
          </span>
          <div className="seg" role="group" aria-label="Period">
            {(['year', 'quarter'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {m === 'year' ? 'Year' : 'Quarter'}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="wf-body">
        <div className="wf-chart">
          <svg
            viewBox="0 0 640 300"
            width="100%"
            role="img"
            aria-label={`Waterfall chart from ${gb.millions(w.equityBegin)} to ${gb.millions(w.equityEnd)}`}
            style={{ display: 'block', overflow: 'visible' }}
          >
            {groups.map((g) => (
              <path key={g.label} d={g.d} fill="none" stroke="#c9c8c1" strokeWidth="1.5" />
            ))}
            {nt.ticks.map((t) => (
              <line key={t} x1="64" x2="628" y1={ys(t)} y2={ys(t)} stroke="#eeede8" strokeWidth="1" />
            ))}
            {links.map((l, i) => (
              <line key={i} x1={l.x1} x2={l.x2} y1={l.y} y2={l.y} stroke="#a8a7a1" strokeWidth="1" strokeDasharray="3 3" />
            ))}
            {bars.map((b) => (
              <g key={b.key}>
                <rect x={b.x} y={b.y} width={barW} height={b.h} rx="4" fill={b.fill} />
                {b.zz && <path d={b.zz} fill="none" stroke="#ffffff" strokeWidth="3" strokeLinejoin="miter" />}
              </g>
            ))}
          </svg>
          {nt.ticks.map((t) => (
            <span key={t} className="ax" style={{ left: pctOf(((WL - 8) / WW) * 100), top: pctOf((ys(t) / WH) * 100), transform: 'translate(-100%, -50%)' }}>
              {fmtAxis(t)}
            </span>
          ))}
          {bars.map((b) => (
            <span key={'v' + b.key} className="ax wf-val" style={{ left: b.vl, top: b.vt }}>
              {b.val}
              {b.sub && <span className="wf-valsub">{b.sub}</span>}
            </span>
          ))}
          {bars.map((b) => (
            <span key={'l' + b.key} className="ax wf-label" style={{ left: b.vl, top: b.ct }}>
              {b.label}
            </span>
          ))}
          {groups.map((g) => (
            <span key={'g' + g.label} className="ax wf-group" style={{ left: g.left, top: g.top }}>
              {g.label}
            </span>
          ))}
        </div>
        <div className="wf-rows">
          {totalRow('Start ' + w.fromLabel, w.equityBegin, `${gb.num(w.customersBegin)} active customers × ${gb.clv(w.avgClvBegin)} average CLV.`)}
          {added.length > 0 && <p className="wf-glabel">Added</p>}
          {added.map((i) => row(i, C_UP))}
          {lost.length > 0 && <p className="wf-glabel">Lost</p>}
          {lost.map((i) => row(i, C_DN))}
          {totalRow('End ' + w.toLabel, w.equityEnd, `${gb.num(w.customersEnd)} active customers × ${gb.clv(w.avgClvEnd)} average CLV.`)}
        </div>
      </div>
    </section>
  )
}
