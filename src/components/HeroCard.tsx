import type { DashboardModel } from '../lib/dashboardModel'
import { millions, num } from '../lib/format'
import { Badge } from './Badge'
import { TrendChart } from './TrendChart'

interface HeroCardProps {
  hero: DashboardModel['hero']
  trend: DashboardModel['trend']
  currentLabel: string
  previousLabel: string
}

export function HeroCard({ hero, trend, currentLabel, previousLabel }: HeroCardProps) {
  return (
    <section className="card" aria-labelledby="hero-title">
      <div className="hero__top">
        <div>
          <h2 id="hero-title" className="eyebrow">
            Totale customer equity · rolling 12 mnd t/m {currentLabel}
            <Badge kind="calculated" />
          </h2>
          <p className="hero__value">{hero.value}</p>
          <p className="hero__change">
            <span className={hero.isIncrease ? 'up' : 'down'}>{hero.change}</span>{' '}
            <span className="muted">
              t.o.v. {previousLabel} ({hero.previous})
            </span>
          </p>
        </div>
        <p className="hero__explain">
          Customer equity = actieve klanten × CLV. Contante waarde van verwachte toekomstige
          contributiemarge van het huidige klantenbestand.
        </p>
      </div>
      <TrendChart
        points={trend.points}
        referenceValue={trend.referenceValue}
        referenceLabel={previousLabel}
        ariaLabel={trend.ariaLabel}
        formatValue={millions}
        formatTick={(v) => `€${num(v / 1e6, 1)}M`}
      />
    </section>
  )
}
