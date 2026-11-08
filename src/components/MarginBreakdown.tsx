import type { DashboardModel } from '../lib/dashboardModel'
import { Badge } from './Badge'

interface MarginBreakdownProps {
  margin: DashboardModel['margin']
  currentLabel: string
  previousLabel: string
}

export function MarginBreakdown({ margin, currentLabel, previousLabel }: MarginBreakdownProps) {
  return (
    <div className="section">
      <h3 className="section__title">Contributiemarge: euro per klant versus percentage</h3>
      <p className="section__intro">
        Marge per klant is het bedrag dat een klant per jaar oplevert. Het percentage is dat bedrag
        gedeeld door de netto-omzet van die klant.
      </p>
      <div className="margin-grid">
        <div className="table-scroll">
          <table className="margin-table">
            <thead>
              <tr>
                <th scope="col">Per actieve klant per jaar</th>
                <th scope="col">{capitalize(previousLabel)}</th>
                <th scope="col">{capitalize(currentLabel)}</th>
                <th scope="col">
                  <abbr title="Verandering">Δ</abbr>
                </th>
              </tr>
            </thead>
            <tbody>
              {margin.rows.map((row) => (
                <tr key={row.label} className={row.emphasis ? 'is-emphasis' : undefined}>
                  <th scope="row">
                    {row.label}
                    <Badge kind={row.measurement} />
                  </th>
                  <td>{row.previous}</td>
                  <td>{row.current}</td>
                  <td className="muted">{row.change}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="formula">
          <p className="formula__title">Berekening</p>
          <code>netto-omzet = orderwaarde × orders × (1 − retour%)</code>
          <code>variabele kosten = netto-omzet − marge</code>
          <code>marge % = marge per klant ÷ netto-omzet</code>
          <p className="callout">{margin.explanation}</p>
        </div>
      </div>
    </div>
  )
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
