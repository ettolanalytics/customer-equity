// Zijbalk met navigatie volgens het ontwerp, met links naar de secties uit
// CLAUDE.md (Opbouw van het scherm).

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function SideNav() {
  return (
    <aside className="side" aria-label="Navigation">
      <p className="navh">CUSTOMER EQUITY</p>
      <nav className="nav">
        <a href="#overview" className="on">
          <svg {...iconProps}><path d="M4 13h6V4H4zM14 20h6v-9h-6zM14 4v3h6V4zM4 20h6v-3H4z" /></svg>
          Customer equity
        </a>
        <a href="#active">
          <svg {...iconProps}>
            <circle cx="9" cy="8" r="3" />
            <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5a3 3 0 0 1 0 6M21 20c0-2.6-1.6-4.8-4-5.6" />
          </svg>
          Active customers
        </a>
        <a href="#clv">
          <svg {...iconProps}><path d="M4 12h4l3-7 4 14 3-7h2" /></svg>
          Average CLV
        </a>
        <a href="#change">
          <svg {...iconProps}><path d="M5 20V10M10 20V6M15 20v-8M20 20V4" /></svg>
          Change
        </a>
        <a href="#method">
          <svg {...iconProps}>
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
          How we calculate
        </a>
      </nav>
    </aside>
  )
}
