// Vergelijkingsregel uit het ontwerp: gekleurd pilletje, absoluut verschil, label.

type Props = {
  /** Richting van de pijl: ▲ bij stijging, ▼ bij daling. */
  up: boolean
  /** Groen (goed) of oranje (slecht). Bij churn is dalen goed. */
  good: boolean
  pill: string
  value?: string
  label: string
}

export function ChangeLine({ up, good, pill, value, label }: Props) {
  return (
    <div className="dl">
      <span className={`pill ${good ? 'up' : 'dn'}`}>
        {up ? '▲' : '▼'} {pill}
      </span>
      {value ? <span className="v">{value}</span> : <span className="v" />}
      <span className="k">{label}</span>
    </div>
  )
}
