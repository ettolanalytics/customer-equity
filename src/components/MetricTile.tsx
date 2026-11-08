import type { MetricView } from '../lib/dashboardModel'
import { Badge, Change } from './Badge'

export function MetricTile({ metric }: { metric: MetricView }) {
  return (
    <div className="tile">
      <p className="tile__label">{metric.label}</p>
      <p className="tile__value">{metric.value}</p>
      <div>
        <Change text={metric.change} isPositive={metric.isImprovement} />{' '}
        <span className="change muted">vj {metric.previous}</span>
      </div>
      <Badge kind={metric.measurement} flush />
    </div>
  )
}
