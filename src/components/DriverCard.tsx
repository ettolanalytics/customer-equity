import type { ReactNode } from 'react'
import type { DriverView } from '../lib/dashboardModel'
import { Badge, Change } from './Badge'

interface DriverCardProps {
  icon: ReactNode
  title: string
  subtitle: string
  driver: DriverView
}

export function DriverCard({ icon, title, subtitle, driver }: DriverCardProps) {
  return (
    <section className="card card--compact driver">
      <div className="driver__head">
        {icon}
        <h3 className="driver__title">{title}</h3>
      </div>
      <p className="driver__subtitle">{subtitle}</p>
      {driver.metrics.map((metric) => (
        <div key={metric.label} className="driver__metric">
          <span className="driver__label">
            {metric.label}
            <Badge kind={metric.measurement} />
          </span>
          <div className="driver__row">
            <span className="driver__value">{metric.value}</span>
            <span>
              <Change text={metric.change} isPositive={metric.isImprovement} />{' '}
              <span className="change muted">vj {metric.previous}</span>
            </span>
          </div>
        </div>
      ))}
      <p className="driver__note">{driver.note}</p>
    </section>
  )
}
