// Kop volgens het ontwerp (CLAUDE.md, Schermteksten 6): fictief bedrijf Beanrise Coffee,
// met zichtbaar label dat het om synthetische demodata gaat (ook in de PDF-export).
// Kwartaalknop: kiest uit de kwartalen waarvoor het hele scherm gevuld is.
// Export opent het afdrukvenster voor "Opslaan als PDF".
import { quarters, selectable } from '../../lib/quarters'

type Props = { selected: number; onSelect: (index: number) => void }

export function TopBar({ selected, onSelect }: Props) {
  return (
    <div className="topbar">
      <div className="topbar-l">
        <span className="logo" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 18l5-6 4 3 7-9" />
          </svg>
        </span>
        <div className="brand">
          <span className="brand-name">Beanrise Coffee</span>
          <span className="brand-tag hide-s">fresh beans, monthly</span>
          <span className="demo-badge" title="Beanrise Coffee is a fictional company. All figures are synthetic demo data.">
            Synthetic demo data
          </span>
        </div>
      </div>
      <div className="topbar-r">
        {/* Uiterlijk van de knop uit het ontwerp, met een onzichtbare keuzelijst erover. */}
        <span className="tbtn qpick">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5c5b56" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <rect x="4" y="5" width="16" height="15" rx="2" />
            <path d="M4 10h16M9 3v4M15 3v4" />
          </svg>
          <span style={{ color: '#8a8984' }}>Quarter</span>
          {quarters[selected].label}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a8984" strokeWidth="2" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
          <select aria-label="Quarter" value={selected} onChange={(e) => onSelect(Number(e.target.value))}>
            {selectable.map((i) => (
              <option key={i} value={i}>
                {quarters[i].label}
              </option>
            ))}
          </select>
        </span>
        <button type="button" className="tbtn hide-s" onClick={() => window.print()} title="Export as PDF">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5c5b56" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
          </svg>
          Export
        </button>
        <span className="avatar" aria-label="Account">LJ</span>
      </div>
    </div>
  )
}
