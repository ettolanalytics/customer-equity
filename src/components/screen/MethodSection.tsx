// "How we calculate": vier stappen en het rekenvoorbeeld (CLAUDE.md, Schermteksten 2 en 5).
import { gb } from '../../lib/format'
import type { Quarter, View } from '../../lib/quarters'

const steps = (current: Quarter) => [
  {
    title: 'Value per customer (CLV)',
    text: 'Contribution margin per quarter (revenue minus direct costs), times how long a customer is expected to stay. Up to 5 years ahead. Future margin is discounted to today at 10% per year.',
    example:
      `${gb.clv(current.marginPerCustomer)} contribution margin per quarter × an average of ` +
      `${gb.num(current.clvExample.expectedQuarters, 1)} quarters as a customer = ${gb.clv(current.clvExample.undiscountedValue)}. ` +
      `Discounted to today (10% per year) = ${gb.clv(current.avgClv)}, the average CLV in ${current.label}. ` +
      `Assuming ${gb.pct(current.clvExample.churnRate)} churn per quarter (average of the previous four quarters), up to 20 quarters.`,
  },
  {
    title: 'Customer equity',
    text: 'The expected future contribution margin of your current customers, discounted to today: number of active customers × average CLV. An active customer is a customer with a running subscription, or within 30 days after it expired.',
  },
  {
    title: 'Change per quarter',
    text: 'New customers, reacquired customers and churn are each multiplied by the average CLV at the start of the period. In the quarter view, churn is split into expected churn and the difference between expected and actual churn. The change in average CLV × the number of customers at the end of the period is split into a margin effect (the new margin per customer at the old retention) and a retention effect (the rest).',
  },
  {
    title: 'Acquisition costs',
    text: 'Acquisition costs are not included.',
  },
] as { title: string; text: string; example?: string }[]

export function MethodSection({ view }: { view: View }) {
  return (
    <section id="method" className="card section" aria-label="How we calculate">
      <h2 className="section-title" style={{ marginBottom: 6 }}>How we calculate</h2>
      <ol className="method">
        {steps(view.current).map((s, i) => (
          <li key={s.title}>
            <span className="method-n">{i + 1}</span>
            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
              <p className="method-title">{s.title}</p>
              <p className="method-text">{s.text}</p>
              {s.example && (
                <p className="method-ex">
                  <span style={{ fontWeight: 600 }}>Worked example: </span>
                  {s.example}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
