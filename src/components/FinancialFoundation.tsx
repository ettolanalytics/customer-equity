import type { DashboardModel } from '../lib/dashboardModel'
import { MarginBreakdown } from './MarginBreakdown'
import { MetricTile } from './MetricTile'
import { ShapleyBridge } from './ShapleyBridge'

interface FinancialFoundationProps {
  model: Pick<DashboardModel, 'financials' | 'margin' | 'bridge' | 'currentLabel' | 'previousLabel'>
}

export function FinancialFoundation({ model }: FinancialFoundationProps) {
  return (
    <section className="card" aria-labelledby="financials-title">
      <h2 id="financials-title" className="eyebrow">
        Financiële onderbouwing
      </h2>
      <div className="tiles">
        {model.financials.map((metric) => (
          <MetricTile key={metric.label} metric={metric} />
        ))}
      </div>
      <MarginBreakdown
        margin={model.margin}
        currentLabel={model.currentLabel}
        previousLabel={model.previousLabel}
      />
      <ShapleyBridge rows={model.bridge} />
    </section>
  )
}
