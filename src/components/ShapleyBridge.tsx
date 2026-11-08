import type { BridgeRowView } from '../lib/dashboardModel'
import { Badge } from './Badge'

export function ShapleyBridge({ rows }: { rows: BridgeRowView[] }) {
  return (
    <div className="section section--wide">
      <h3 className="section__title">
        Verklaring van de verandering
        <Badge kind="calculated" />
      </h3>
      <p className="section__intro">
        Shapley-decompositie: per driver de gemiddelde bijdrage over alle zes mogelijke volgordes.
        Interactie-effecten worden zo gelijk over de drivers verdeeld; de bijdragen tellen exact op
        tot de totale verandering.
      </p>
      <ul className="bridge">
        {rows.map((row) =>
          row.kind === 'total' ? (
            <li key={row.label} className="bridge__row bridge__row--total">
              <span className="bridge__label">{row.label}</span>
              <span className="bridge__bar" />
              <span className="bridge__value">{row.value}</span>
              <span className="bridge__share" />
            </li>
          ) : (
            <li key={row.label} className="bridge__row">
              <span className="bridge__label">{row.label}</span>
              <span className="bridge__bar" aria-hidden="true">
                <span
                  className={`bridge__fill${row.isNegative ? ' bridge__fill--negative' : ''}`}
                  style={{ width: `${row.barPercent}%` }}
                />
              </span>
              <span className="bridge__value">{row.value}</span>
              <span className="bridge__share">{row.share}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}
