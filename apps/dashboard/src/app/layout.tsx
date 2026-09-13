import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import './globals.css'

export const metadata: Metadata = {
  title: 'Coordinación — panel',
  description: 'Quién está haciendo qué y cómo va, sin abrir una terminal.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen antialiased">
        <header className="border-b border-[var(--color-borde)]">
          <div className="mx-auto flex max-w-5xl items-baseline gap-6 px-6 py-5">
            <span className="text-lg font-semibold tracking-tight">Coordinación</span>
            <nav className="flex gap-5 text-sm text-[var(--color-apagado)]">
              <a className="hover:text-[var(--color-tinta)]" href="/">
                Equipo
              </a>
              <a className="hover:text-[var(--color-tinta)]" href="/claims">
                Reservas
              </a>
              <a className="hover:text-[var(--color-tinta)]" href="/verificaciones">
                Verificaciones
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  )
}
