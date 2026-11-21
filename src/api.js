import { useCallback, useEffect, useState } from 'react'

export class ApiError extends Error {
  constructor(response, payload) {
    const details = payload?.issues?.map(issue => issue.field ? `${issue.field.replaceAll('_', ' ')} — ${issue.message}` : issue.message)
    super(details?.length ? details.join(' ') : payload?.error || 'The request could not be completed.')
    this.status = response.status
  }
}

export async function api(path, { method = 'GET', data, signal } = {}) {
  const response = await fetch('/api' + path, {
    method, signal, credentials: 'same-origin',
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  })
  if (response.status === 204) return null
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    if (error.name === 'AbortError' || response.ok) throw error
  }
  signal?.throwIfAborted()
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/me' && path !== '/auth/login') window.dispatchEvent(new Event('session-ended'))
    throw new ApiError(response, payload)
  }
  return payload
}

export function withQuery(path, options) {
  const values = Object.entries(options).filter(([, value]) => value !== undefined && value !== '')
  const query = new URLSearchParams(values)
  return query.size ? path + (path.includes('?') ? '&' : '?') + query : path
}

export function useResource(path) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true })
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    setState(previous => ({ ...previous, loading: true, error: null }))
    api(path, { signal: controller.signal }).then(
      data => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false })
      },
      error => {
        if (!controller.signal.aborted && error.name !== 'AbortError') setState(previous => ({ ...previous, error, loading: false }))
      },
    )
    return () => controller.abort()
  }, [path, revision])
  return { ...state, refresh }
}

export const money = (amount, currency = 'KES', digits = 2) => new Intl.NumberFormat('en-KE', {
  style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: digits, minimumFractionDigits: digits,
}).format(Number(amount ?? 0))
export const number = value => new Intl.NumberFormat('en-KE').format(Number(value ?? 0))
export const label = value => String(value ?? '').replaceAll('_', ' ').replace(/^./, first => first.toUpperCase())
export const date = (value, timezone, withTime = false) => value ? new Intl.DateTimeFormat('en-KE', {
  timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric',
  ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
}).format(new Date(value)) : '—'
export const roleNames = { admin: 'Administrator', mechanic: 'Mechanic', shop_manager: 'Shop manager', accountant: 'Accountant' }
