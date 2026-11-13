// "Model and assumptions" (proefversie v2): alleen het blok "CLV model", met de drie onderdelen van de
// CLV en een rekenvoorbeeld. Het meetmoment (laatste dag of alle gebeurtenissen in het kwartaal) staat
// in de tooltips. Alle getallen komen uit de data (quarters_v2, publication_v2).
import { gb } from '../../lib/format'
import { assumptions as a, type View } from '../../lib/quarters'

/** Percentage zonder decimalen: 0.1 → "10%" */
const pct0 = (fraction: number) => gb.num(fraction * 100) + '%'

export function MethodSection({ view }: { view: View }) {
  const c = view.current
  const ex = c.clvExample
  const years = gb.num(a.horizonMonths / 12)
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  const yearsWord = WORDS[a.horizonMonths / 12] ?? years
  const perPlan = c.model.some((m) => m.segment > 0)
  const returning = c.model.some((m) => m.segment === 0)
  // Hoe het sBG-model is geschat, uit de parameters in de data (per startabonnement en/of terugkeerders apart).
  const fitted = perPlan
    ? `fitted per starting plan${returning ? ' and separately for returning customers' : ''}, on all subscriptions up to the quarter`
    : `fitted on all customers together${returning ? ' and separately for returning customers' : ''}, on all subscriptions up to the quarter`

  const intro = `A customer's CLV is the margin we expect them to bring in over the next ${years} years, counted in today's euros. It combines three things:`
  const model: [string, string][] = [
    [
      'How long the customer stays.',
      'Every customer has their own chance of cancelling each month, and these chances differ between customers. ' +
        'Customers who cancel easily tend to leave early, so the longer a customer has stayed, the more likely they are to stay. ' +
        `This is the shifted-beta-geometric model, ${fitted}. ` +
        `A customer whose subscription expired less than ${a.graceDays} days ago counts at ${gb.pct(c.lateRenewalFactor)} of their CLV, because that is the share that still renews.`,
    ],
    [
      'What each invoice earns.',
      'Price minus the cost of each delivery, excluding VAT, averaged over the last 12 months per plan, including expected up- and downgrades. ' +
        'The cost of acquiring the customer is not included.',
    ],
    [
      'When it comes in.',
      `Margin further in the future counts for less: ${pct0(a.discountRateYear)} per year, so €1 in ${yearsWord} years counts as ${gb.clv(a.horizonDiscountFactor)} today. ` +
        `Only the next ${gb.num(a.horizonMonths)} monthly invoices count; nothing after ${years} years.`,
    ],
  ]
  const example =
    `a new ${gb.plan(ex.sizeGrams)} customer renews next month with a ${gb.pct(ex.nextInvoiceChance)} chance. ` +
    `Over ${years} years they are expected to pay ${gb.num(ex.expectedInvoices, 1)} more invoices, counted in today's euros. ` +
    `At ${gb.clv(ex.marginPerInvoice)} margin per invoice, plus expected plan changes, their CLV is ${gb.clv(ex.value)}.`

  return (
    <section id="method" className="card section" aria-label="Model and assumptions">
      <h2 className="section-title" style={{ marginBottom: 6 }}>Model and assumptions</h2>
      <div className="ma ma-single">
        <div className="ma-block">
          <p className="method-title">CLV model</p>
          <p className="ma-intro">{intro}</p>
          <ol className="ma-list">
            {model.map(([head, text]) => (
              <li key={head}>
                <span style={{ fontWeight: 600, color: '#111110' }}>{head}</span> {text}
              </li>
            ))}
          </ol>
          <p className="method-ex">
            <span style={{ fontWeight: 600 }}>Example: </span>
            {example}
          </p>
        </div>
      </div>
    </section>
  )
}
