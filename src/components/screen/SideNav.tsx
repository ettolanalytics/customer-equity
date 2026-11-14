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
          Overview
        </a>
        <a href="#drivers">
          <svg {...iconProps}><path d="M4 12h4l3-7 4 14 3-7h2" /></svg>
          Value drivers
        </a>
        <a href="#contribution">
          <svg {...iconProps}><path d="M5 20V10M10 20V6M15 20v-8M20 20V4" /></svg>
          Contribution
        </a>
        <a href="#method">
          <svg {...iconProps}>
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
          Explanation of CLV model
        </a>
      </nav>
    </aside>
  )
}
