// Customer Equity — scherm volgens het ontwerp (Claude Design, project/Main.dc.html).
// Alle getallen komen uit src/data/quarters.json; de app rekent niets zelf.
import { useState } from 'react'
import { DriverTiles } from './components/screen/DriverTiles'
import { EquityHero } from './components/screen/EquityHero'
import { MethodSection } from './components/screen/MethodSection'
import { SideNav } from './components/screen/SideNav'
import { TopBar } from './components/screen/TopBar'
import { WaterfallSection } from './components/screen/WaterfallSection'
import { gb } from './lib/format'
import { defaultIndex, viewFor, type View } from './lib/quarters'

const QUARTER_WORDS = ['', 'quarter', 'two quarters', 'three quarters', 'four quarters']

/**
 * Antwoordzin (CLAUDE.md Schermteksten 1 en 7), met het waarom: customer equity =
 * actieve klanten × gemiddelde CLV. Eerst wat er gebeurde, dan welke factor de
 * doorslag gaf, dan elke factor apart, dan churn tegenover verwacht. Alle getallen
 * komen uit de data; hier worden alleen woorden gekozen op teken en grootte.
 */
function answer({ current: c, vsYearLabel }: View): string {
  const y = c.equityVsYearAgo
  const s = c.yearSummary
  const w = c.yearWaterfall
  const n = c.activeVsYearAgo
  if (!y || !s || !w || !n) return ''
  const equityUp = y.abs >= 0
  const customersUp = n.abs >= 0
  const clvUp = s.avgClvChange >= 0
  const base = customersUp ? 'larger customer base' : 'smaller customer base'
  const clv = clvUp ? 'higher average CLV' : 'lower average CLV'
  const why =
    customersUp === clvUp
      ? `both the customer base and average CLV ${customersUp ? 'grew' : 'fell'}`
      : customersUp === equityUp
        ? `the ${base} outweighed the ${clv}`
        : `the ${clv} outweighed the ${base}`
  const retentionMain = Math.abs(w.parts.retentionEffect) >= Math.abs(w.parts.marginEffect)
  const clvReason = retentionMain
    ? `retention ${w.parts.retentionEffect >= 0 ? 'improved' : 'declined'}`
    : `margin per customer ${w.parts.marginEffect >= 0 ? 'rose' : 'fell'}`

  const parts = [
    `Customer equity ${equityUp ? 'grew' : 'fell'} ${gb.eurShort(y.abs)} (${gb.signedPct(y.pct)}) ${vsYearLabel}, because ${why}.`,
    `Over the last four quarters, the customer base ${customersUp ? 'grew' : 'shrank'} by ${gb.num(Math.abs(n.abs))} ` +
      `to ${gb.num(c.activeEnd)}: ${gb.num(s.acquiredCustomers)} customers were acquired ` +
      `(${gb.num(s.newCustomers)} new, ${gb.num(s.reacquiredCustomers)} reacquired) and ${gb.num(w.counts.churn)} churned.`,
    `Average CLV ${clvUp ? 'rose' : 'fell'} by ${gb.clv(Math.abs(s.avgClvChange))} to ${gb.clv(c.avgClv)}, mainly because ${clvReason}.`,
  ]
  if (s.churnVsExpected !== null && s.churnQuarters > 0) {
    parts.push(
      `Over the last ${QUARTER_WORDS[s.churnQuarters]}, ${gb.num(Math.abs(s.churnVsExpected))}` +
        ` ${s.churnVsExpected >= 0 ? 'fewer' : 'more'} customers churned than expected.`,
    )
  }
  return parts.join(' ')
}

function App() {
  // Gedeelde hover over alle grafieken, zoals in het ontwerp.
  const [hover, setHover] = useState<number | null>(null)
  // Gekozen kwartaal (CLAUDE.md, Schermteksten 6); standaard het laatste kwartaal.
  const [selected, setSelected] = useState(defaultIndex)
  const view = viewFor(selected)
  const { current } = view
  const select = (i: number) => {
    setHover(null)
    setSelected(i)
  }

  return (
    <div className="app">
      <TopBar selected={selected} onSelect={select} />
      <div className="body">
        <SideNav />
        <main className="main">
          <div className="wrap">
            <div id="overview" style={{ marginBottom: 18 }}>
              <div className="title-row">
                <div style={{ minWidth: 0 }}>
                  <h1 className="title">Customer Equity</h1>
                  <p className="subtitle">The value of your current customers · {current.label}</p>
                </div>
                <a href="#method" className="tbtn" style={{ textDecoration: 'none' }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5c5b56" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 11v5M12 8h.01" />
                  </svg>
                  How to read this page
                </a>
              </div>
              <div className="qa">
                <p className="qa-q">Is your customer base worth more than a year ago?</p>
                <p className="qa-a">{answer(view)}</p>
              </div>
            </div>
            <EquityHero view={view} hover={hover} setHover={setHover} />
            <DriverTiles view={view} hover={hover} setHover={setHover} />
            <WaterfallSection view={view} />
            <MethodSection view={view} />
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
