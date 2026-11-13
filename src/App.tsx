// Customer Equity — scherm volgens het ontwerp (Claude Design, project/Main.dc.html).
// Alle getallen komen uit src/data/quarters.json; de app rekent niets zelf.
import { useState } from 'react'
import { DriverTiles } from './components/screen/DriverTiles'
import { EquityHero } from './components/screen/EquityHero'
import { MethodSection } from './components/screen/MethodSection'
import { SideNav } from './components/screen/SideNav'
import { TopBar } from './components/screen/TopBar'
import { WaterfallSection } from './components/screen/WaterfallSection'
import { defaultIndex, viewFor, type Hover } from './lib/quarters'

function App() {
  // Gedeelde hover over alle grafieken, zoals in het ontwerp.
  const [hover, setHover] = useState<Hover | null>(null)
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
