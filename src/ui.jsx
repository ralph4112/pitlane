import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronLeft, ChevronRight, Inbox, LoaderCircle, Search, X } from 'lucide-react'
import { label, useResource, withQuery } from './api.js'

export function Button({ icon: Icon, variant = 'primary', children, type = 'button', ...props }) {
  return <button type={type} className={`button button-${variant}`} {...props}>{Icon && <Icon size={16} aria-hidden="true" />}{children}</button>
}

export function PageHeading({ title, caption, children }) {
  return <div className="page-heading"><div><h1>{title}</h1>{caption && <p>{caption}</p>}</div>{children && <div className="action-row">{children}</div>}</div>
}

export function Panel({ title, caption, action, children, className = '' }) {
  return <section className={`panel ${className}`}>{(title || action) && <header className="panel-heading">
    <div>{title && <h2>{title}</h2>}{caption && <p>{caption}</p>}</div>{action}
  </header>}{children}</section>
}

export function Status({ value, children }) {
  return <span className={`status status-${value || 'neutral'}`}>{children ?? label(value)}</span>
}

export function Empty({ title = 'No records yet', detail }) {
  return <div className="empty"><div className="empty-icon"><Inbox size={22} /></div><strong>{title}</strong>{detail && <p>{detail}</p>}</div>
}

export function ErrorNotice({ error }) {
  if (!error) return null
  return <div role="alert" className="error-notice"><AlertCircle size={17} /><span>{error.message || error}</span></div>
}

export function Loading() {
  return <div className="loading" role="status"><LoaderCircle className="animate-spin" size={19} /> Loading…</div>
}

export function Resource({ state, children }) {
  if (state.error) return <ErrorNotice error={state.error} />
  if (state.data === undefined) return <Loading />
  return children(state.data)
}

export function DataTable({ columns, rows, empty = 'No records match your search.' }) {
  if (!rows?.length) return <Empty title={empty} />
  return <div className="table-scroll"><table><thead><tr>{columns.map(column => <th key={column.key} scope="col" className={column.compactHide ? "hide-compact" : undefined}>{column.title}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.id ?? row.part_id ?? row.mechanic_id}>
      {columns.map(column => <td key={column.key} className={column.compactHide ? "hide-compact" : undefined}>{column.render ? column.render(row) : row[column.key] ?? '—'}</td>)}
    </tr>)}</tbody>
  </table></div>
}

export function Record({ title, subtitle }) {
  return <div className="record"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</div>
}

export function Modal({ title, description, onClose, children, wide = false }) {
  const dialog = useRef(null)
  const titleId = useId()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return <dialog className={`modal ${wide ? 'modal-wide' : ''}`} ref={dialog} aria-labelledby={titleId}
    onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="modal-interior">
      <header className="modal-heading"><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={21} /></button></header>
      <div className="modal-body">{children}</div>
    </div>
  </dialog>
}

export function Field({ label: title, name, type = 'text', value, defaultValue, children, options, hint, ...props }) {
  const fieldId = useId()
  const attributes = { id: fieldId, name, value, defaultValue, 'aria-describedby': hint ? fieldId + '-hint' : undefined, ...props }
  if (type === 'checkbox') return <label className="field-check"><input type="checkbox" {...attributes} /> {title}</label>
  return <div className="field"><label htmlFor={fieldId}>{title}</label>
    {options ? <div className="select-wrap"><select {...attributes}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={15} /></div>
      : type === 'textarea' ? <textarea rows={3} {...attributes} /> : <input type={type} {...attributes} />}
    {hint && <small id={fieldId + '-hint'}>{hint}</small>}{children}
  </div>
}

export function Lookup({ title, endpoint, format, value, onChange, initialLabel, required, placeholder = 'Select a record' }) {
  const [query, setQuery] = useState('')
  const resource = useResource(withQuery(endpoint, { q: query }))
  const options = resource.data?.items?.map(row => ({ value: row.id, label: format(row), row })) ?? []
  if (value && !options.some(option => option.value === value)) options.unshift({ value, label: initialLabel || `Record #${value}` })
  return <div className="lookup">
    <Field label={`Search ${title.toLowerCase()}`} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Type to narrow options" />
    <Field label={title} value={value} required={required} onChange={event => {
      const item = options.find(option => option.value === event.target.value)
      onChange(event.target.value, item?.label, item?.row)
    }} options={[{ value: '', label: resource.loading && !options.length ? 'Loading…' : placeholder }, ...options]} />
    {resource.error && <ErrorNotice error={resource.error} />}
  </div>
}

export function ActionForm({ children, onSubmit, submit = 'Save changes', onCancel, variant, className = '' }) {
  const [state, setState] = useState({ busy: false, error: null })
  const pending = useRef(false)
  return <form className={`action-form ${className}`} onSubmit={async event => {
    event.preventDefault()
    if (pending.current) return
    pending.current = true
    const fields = new FormData(event.currentTarget)
    setState({ busy: true, error: null })
    try {
      await onSubmit(fields)
      setState({ busy: false, error: null })
    } catch (error) {
      setState({ busy: false, error })
    } finally {
      pending.current = false
    }
  }}>
    {children}
    <ErrorNotice error={state.error} />
    <div className="form-actions">
      {onCancel && <Button variant="secondary" onClick={onCancel} disabled={state.busy}>Cancel</Button>}
      <Button type="submit" variant={variant} disabled={state.busy}>{state.busy ? 'Saving…' : submit}</Button>
    </div>
  </form>
}

export function Listing({ endpoint, columns, empty, searchPlaceholder = 'Search records…', filter, children, refreshKey = 0 }) {
  const [q, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [choice, setChoice] = useState(filter?.initial ?? '')
  const resource = useResource(withQuery(endpoint, { q, page, ...(filter ? { [filter.name]: choice } : {}) }))
  useEffect(() => { if (refreshKey) resource.refresh() }, [refreshKey, resource.refresh])
  return <Panel>
    <div className="table-toolbar">
      <label className="search-box"><Search size={17} /><input type="search" aria-label={searchPlaceholder} placeholder={searchPlaceholder}
        value={q} onChange={event => { setQuery(event.target.value); setPage(1) }} /></label>
      {filter && <div className="select-wrap compact-select"><select aria-label={filter.label || 'Filter'} value={choice} onChange={event => { setChoice(event.target.value); setPage(1) }}>
        {filter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={14} /></div>}
      {children}
    </div>
    <Resource state={resource}>{data => <>
      <DataTable columns={columns} rows={data.items} empty={empty} />
      <div className="pagination"><span>Page {data.page}</span><div>
        <Button variant="secondary" icon={ChevronLeft} aria-label="Previous page" disabled={page === 1 || resource.loading} onClick={() => setPage(page - 1)} />
        <Button variant="secondary" icon={ChevronRight} aria-label="Next page" disabled={!data.has_more || resource.loading} onClick={() => setPage(page + 1)} />
      </div></div>
    </>}</Resource>
  </Panel>
}

export const options = (values, first) => [
  ...(first ? [{ value: '', label: first }] : []),
  ...values.map(value => ({ value, label: label(value) })),
]
