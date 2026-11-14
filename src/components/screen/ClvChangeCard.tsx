// Kaart "What changed average CLV" onder de CLV-tegel: twee blokken (QoQ, YoY) met elk vier
// horizontale bars (bestaande klanten, nieuwkomers, vertrekkers, totaal). Elk blok een eigen schaal met
// nul in beeld; negatieve bars naar links. Kleuren voor positief en negatief zoals in de waterfall;
// het totaal neutraal. Geen tijdlijn en geen gedeelde hover. Alle bedragen komen uit de data.
import { clvChangeBlocks, type ClvBlock } from '../../lib/clvChange'
import { gb } from '../../lib/format'
import type { View } from '../../lib/quarters'
import { C_DN, C_UP } from './WaterfallSection'

const C_TOTAL = '#5c5b56'

function Block({ block }: { block: ClvBlock }) {
  const values = block.bars.map((b) => b.value)
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const span = hi - lo || 1
  const zero = (-lo / span) * 100
  return (
    <div className="cc-block" aria-label={`Change in average CLV, ${block.title} ${block.vs}`}>
      <p className="cc-head">
        <span className="cc-title">{block.title}</span>
      </p>
      {block.bars.map((b) => {
        const w = (Math.abs(b.value) / span) * 100
        const left = b.value >= 0 ? zero : zero - w
        const color = b.total ? C_TOTAL : b.value >= 0 ? C_UP : C_DN
        return (
          <div key={b.label} className={`cc-row${b.total ? ' cc-total' : ''}`}>
            <span className="cc-label">{b.label}</span>
            <div className="cc-line">
              <div className="cc-track">
                <div className="cc-zero" style={{ left: `${zero}%` }} />
                <div className="cc-bar" style={{ left: `${left}%`, width: `${w}%`, background: color }} />
              </div>
              <span className="cc-val">{gb.signedClv(b.value)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function ClvChangeCard({ view }: { view: View }) {
  const blocks = clvChangeBlocks(view)
  return (
    <div className="card tile cc">
      <div className="card-head">
        <span className="lbl">What changed average CLV</span>
        <span className="tip" style={{ marginLeft: 0 }}>
          <button type="button" className="ib" aria-label="Explanation">i</button>
          <span className="tt" role="tooltip">
            How much each part contributed to the change in average CLV, compared with last quarter and with a year ago.
          </span>
        </span>
        <span className="period">{view.current.label}</span>
      </div>
      <div className="cc-blocks">
        {blocks.map((b) => (
          <Block key={b.key} block={b} />
        ))}
      </div>
    </div>
  )
}
