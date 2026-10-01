// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { UsageBadge } from './usage-badge'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mount(usage: { remaining: number; allowance: number; unit: string; updatedAt: number }, fetchFailed: boolean) {
  act(() => root.render(<UsageBadge usage={usage} fetchFailed={fetchFailed} />))
}

it('renders remaining over allowance with the unit', () => {
  mount({ remaining: 972.06, allowance: 1000, unit: 'credits', updatedAt: Date.now() }, false)
  // One decimal of precision: 972.06 credits reads as 972.1, not a rounded 972.
  expect(document.querySelector('[data-testid="usage-badge"]')?.textContent).toMatch(/972\.1.*1000.*credits/s)
})

it('turns red under 20 percent and green above 50 percent', () => {
  mount({ remaining: 100, allowance: 1000, unit: 'credits', updatedAt: Date.now() }, false)
  expect(document.querySelector('[data-testid="usage-badge"]')?.className).toMatch(/red-|destructive|text-red/)

  act(() => root.render(
    <UsageBadge usage={{ remaining: 900, allowance: 1000, unit: 'credits', updatedAt: Date.now() }} fetchFailed={false} />,
  ))
  expect(document.querySelector('[data-testid="usage-badge"]')?.className).toMatch(/green-|emerald-/)
})

it('shows the warning icon when the last fetch failed', () => {
  mount({ remaining: 900, allowance: 1000, unit: 'credits', updatedAt: Date.now() }, true)
  expect(document.querySelector('[data-testid="usage-fetch-warning"]')).toBeTruthy()
})
