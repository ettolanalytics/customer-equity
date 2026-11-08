import { Badge } from './Badge'
import { TrendIcon } from './icons'

export function Header({ company }: { company: string }) {
  return (
    <header className="topbar">
      <div className="brand">
        <TrendIcon />
        <span className="brand__name">Customer Equity</span>
        <span className="brand__company">· {company}</span>
      </div>
      <ul className="legend" aria-label="Soorten cijfers">
        <li>
          <Badge kind="measured" flush /> direct uit bron
        </li>
        <li>
          <Badge kind="calculated" flush /> formule op gemeten data
        </li>
        <li>
          <Badge kind="proxy" flush /> benadering van construct
        </li>
      </ul>
    </header>
  )
}
