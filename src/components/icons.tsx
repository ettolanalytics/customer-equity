import type { ReactNode } from 'react'

function Icon({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function TrendIcon() {
  return (
    <Icon size={20}>
      <path d="M4 19h16" />
      <path d="M4 15l4 -6l4 2l4 -5l4 4" />
    </Icon>
  )
}

export function ScaleIcon() {
  return (
    <Icon size={18}>
      <path d="M12 4v16" />
      <path d="M7 20h10" />
      <path d="M5 8h14" />
      <path d="M5 8l-3 7a3 3 0 0 0 6 0z" />
      <path d="M19 8l-3 7a3 3 0 0 0 6 0z" />
    </Icon>
  )
}

export function SparkleIcon() {
  return (
    <Icon size={18}>
      <path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2z" />
      <path d="M16 6a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2z" />
      <path d="M9 18a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z" />
    </Icon>
  )
}

export function UsersIcon() {
  return (
    <Icon size={18}>
      <path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
      <path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      <path d="M21 21v-2a4 4 0 0 0 -3 -3.85" />
    </Icon>
  )
}
