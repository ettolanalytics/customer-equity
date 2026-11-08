import { useEffect, useMemo } from 'react'
import { Definitions } from './components/Definitions'
import { DriverCard } from './components/DriverCard'
import { FinancialFoundation } from './components/FinancialFoundation'
import { Header } from './components/Header'
import { HeroCard } from './components/HeroCard'
import { ScaleIcon, SparkleIcon, UsersIcon } from './components/icons'
import { SupabaseStatus } from './components/SupabaseStatus'
import { sampleData } from './data/sampleData'
import { buildDashboardModel } from './lib/dashboardModel'

function App() {
  // Databron: voorlopig de voorbeelddata. Een Supabase-bron levert later dezelfde
  // CustomerEquityDataset aan; berekeningen en componenten blijven dan gelijk.
  const model = useMemo(() => buildDashboardModel(sampleData), [])

  useEffect(() => {
    if (import.meta.env.DEV) {
      model.warnings.forEach((warning) => console.warn(`[customer equity] ${warning}`))
    }
  }, [model])

  return (
    <div className="page">
      <main className="container">
        <h1 className="sr-only">Customer Equity-dashboard</h1>
        <p className="sr-only">
          Totale klantwaarde, financiële onderbouwing inclusief margeuitleg en Shapley-decompositie,
          en drie strategische drivers
          {model.isSampleData ? ', gebaseerd op fictieve voorbeelddata' : ''}.
        </p>

        <Header company={model.company} />
        <HeroCard
          hero={model.hero}
          trend={model.trend}
          currentLabel={model.currentLabel}
          previousLabel={model.previousLabel}
        />
        <FinancialFoundation model={model} />

        <div className="drivers">
          <DriverCard
            icon={<ScaleIcon />}
            title="Value equity"
            subtitle="Ervaren klantwaarde"
            driver={model.drivers.value}
          />
          <DriverCard
            icon={<SparkleIcon />}
            title="Brand equity"
            subtitle="Merkvoorkeur"
            driver={model.drivers.brand}
          />
          <DriverCard
            icon={<UsersIcon />}
            title="Relationship equity"
            subtitle="Klantrelatie"
            driver={model.drivers.relationship}
          />
        </div>

        <Definitions
          discountRate={model.discountRate}
          refreshedAt={model.refreshedAt}
          isSampleData={model.isSampleData}
        />
      </main>
      <footer className="container">
        <SupabaseStatus />
      </footer>
    </div>
  )
}

export default App
