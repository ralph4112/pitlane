import { useState } from 'react'
import { CarFront, CircleUserRound, Plus } from 'lucide-react'
import { api, date, money, useResource } from './api.js'
import { ActionForm, Button, DataTable, Empty, Field, Listing, Lookup, Modal, PageHeading, Panel, Record, Resource, Status, options } from './ui.jsx'

const statuses = ['pending', 'in_progress', 'completed']
const customerLabel = row => row.full_name
const vehicleLabel = row => `${row.registration_number} · ${row.make} ${row.model}`
const partLabel = row => `${row.name} · ${row.sku}`
const nullable = (fields, key) => fields.get(key) || null
const getNumber = (fields, key) => fields.get(key) === '' ? null : Number(fields.get(key))

function MechanicSelect({ name = 'mechanic_id', current, required }) {
  const resource = useResource('/mechanics')
  return <Resource state={resource}>{rows => <Field name={name} label="Assigned mechanic" required={required}
    defaultValue={current ?? ''} options={[{ value: '', label: 'Unassigned' },
      ...(current && !rows.some(row => row.id === current) ? [{ value: current, label: `Mechanic #${current}` }] : []),
      ...rows.map(person => ({ value: person.id, label: person.full_name }))]} />}</Resource>
}

function JobForm({ onClose, onCreated }) {
  const [vehicle, setVehicle] = useState('')
  return <Modal title="New job card" description="Assign a vehicle and describe the work required." onClose={onClose}>
    <ActionForm submit="Create job card" onCancel={onClose} onSubmit={async fields => {
      const job = await api('/jobs', { method: 'POST', data: {
        vehicle_id: vehicle, mechanic_id: nullable(fields, 'mechanic_id'),
        description: fields.get('description'), odometer_km: getNumber(fields, 'odometer_km'),
      } })
      onCreated(job.id)
    }}>
      <Lookup title="Vehicle" endpoint="/vehicles" format={vehicleLabel} value={vehicle} onChange={setVehicle} required />
      <MechanicSelect />
      <Field type="number" name="odometer_km" label="Odometer (km)" min="0" max="1000000" />
      <Field type="textarea" name="description" label="Work requested" required maxLength={3000} />
    </ActionForm>
  </Modal>
}

export function Jobs({ user, initialAction, clearAction, settings, openJob, revision }) {
  const admin = user.role_code === 'admin'
  const [showNew, setShowNew] = useState(initialAction === 'new')
  const close = () => { setShowNew(false); clearAction() }
  return <>
    <PageHeading title={admin ? 'Job cards' : 'My job cards'}
      caption={admin ? 'Manage vehicle intake, assignments, and service progress.' : 'Update assigned services and request parts for your work.'}>
      {admin && <Button icon={Plus} onClick={() => setShowNew(true)}>New job card</Button>}
    </PageHeading>
    <Listing endpoint="/jobs" refreshKey={revision} searchPlaceholder="Search job cards…" filter={{ name: 'status', label: 'Job status', options: options(statuses, 'All statuses') }} columns={[
      { key: 'id', title: 'Job card', render: row => <button className="text-button" onClick={() => openJob(row.id)}>JOB-{row.id}</button> },
      { key: 'vehicle', title: 'Vehicle', render: row => <Record title={`${row.make} ${row.model}`} subtitle={row.registration_number} /> },
      { key: 'customer_name', title: 'Customer' },
      { key: 'mechanic_name', title: 'Mechanic' },
      { key: 'opened_at', title: 'Opened', render: row => date(row.opened_at, settings.reporting_timezone) },
      { key: 'status', title: 'Status', render: row => <Status value={row.status} /> },
      { key: 'action', title: 'Actions', render: row => <Button variant="secondary" onClick={() => openJob(row.id)}>Open job</Button> },
    ]} />
    {showNew && <JobForm onClose={close} onCreated={id => { close(); openJob(id, true) }} />}
  </>
}

export function JobDetail({ id, user, settings, onClose, onChanged, onInvoice }) {
  const resource = useResource('/jobs/' + id)
  const [action, setAction] = useState('')
  const [part, setPart] = useState('')
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const admin = user.role_code === 'admin'
  const refresh = () => { resource.refresh(); onChanged(); setAction(''); setError(null) }
  const command = async (path, method, data) => {
    setPending(true)
    setError(null)
    try {
      await api('/jobs/' + id + path, { method, data })
      refresh()
    } catch (error) {
      setError(error)
    } finally {
      setPending(false)
    }
  }
  const forms = {
    assignment: { title: 'Assign mechanic', method: 'PATCH', fields: <MechanicSelect current={resource.data?.mechanic_id} />, data: fields => ({ mechanic_id: nullable(fields, 'mechanic_id') }) },
    notes: { title: 'Add service note', fields: <Field label="Service note" name="body" type="textarea" required maxLength={5000} />, data: fields => ({ body: fields.get('body') }) },
    labor: { title: 'Log labor', fields: <><Field label="Labor description" name="description" required maxLength={1000} />
      <Field label={`Amount (${settings.currency})`} name="amount" type="number" min="0" step="0.01" required /></>,
    data: fields => ({ description: fields.get('description'), amount: fields.get('amount') }) },
    parts: { title: 'Request part', fields: <><Lookup title="Part" endpoint="/part-options" format={partLabel} value={part} onChange={setPart} required />
      <Field label="Quantity" name="quantity" type="number" min="1" max="1000000" defaultValue="1" required /></>,
    data: fields => ({ part_id: part, quantity: Number(fields.get('quantity')) }) },
  }
  const form = forms[action]
  return <Modal title={`Job card JOB-${id}`} onClose={onClose} wide>
    <Resource state={resource}>{job => <>
      <div className="detail-banner">
        <div className="detail-icon"><CarFront size={23} /></div>
        <Record title={`${job.make} ${job.model} · ${job.registration_number}`} subtitle={job.customer_name} />
        <Status value={job.status} />
      </div>
      <dl className="detail-grid">
        <div><dt>Mechanic</dt><dd>{job.mechanic_name ?? 'Unassigned'}</dd></div>
        <div><dt>Odometer</dt><dd>{job.odometer_km === null ? '—' : `${job.odometer_km} km`}</dd></div>
        <div><dt>Opened</dt><dd>{date(job.opened_at, settings.reporting_timezone, true)}</dd></div>
        <div><dt>Customer phone</dt><dd>{job.customer_phone ?? '—'}</dd></div>
      </dl>
      <p className="work-description">{job.description}</p>
      <div className="action-row wrap">
        {job.status === 'pending' && job.mechanic_id && <Button onClick={() => command('/status', 'PATCH', { status: 'in_progress' })} disabled={pending}>Start work</Button>}
        {job.status === 'in_progress' && <Button onClick={() => command('/status', 'PATCH', { status: 'completed' })} disabled={pending}>Complete job</Button>}
        {job.status === 'completed' && admin && <Button onClick={() => onInvoice(job.id, job.invoice_id)}>Open billing</Button>}
        {Object.entries(forms).filter(([key]) => (key !== 'assignment' || admin) && (job.status !== 'completed' || key === 'notes')).map(([key, item]) =>
          <Button key={key} variant="secondary" onClick={() => { setAction(key); setPart(''); setError(null) }}>{item.title}</Button>)}
      </div>
      {error && <p className="error-notice" role="alert">{error.message}</p>}
      {form && <Panel title={form.title} className="nested-panel">
        <ActionForm key={action} submit={form.title} onCancel={() => setAction('')} onSubmit={async fields => {
          await api(`/jobs/${id}/${action}`, { method: form.method || 'POST', data: form.data(fields) })
          refresh()
        }}>{form.fields}</ActionForm>
      </Panel>}
      <div className="detail-sections">
        <Panel title="Service notes" className="nested-panel">
          {job.notes.length ? <ul className="note-list">{job.notes.map(note => <li key={note.id}><p>{note.body}</p>
            <small>{note.author} · {date(note.created_at, settings.reporting_timezone, true)}</small></li>)}</ul> : <Empty title="No service notes yet" />}
        </Panel>
        <Panel title="Labor charges" className="nested-panel">
          <DataTable rows={job.labor} empty="No labor charges yet" columns={[
            { key: 'description', title: 'Work' }, { key: 'amount', title: 'Amount', render: row => money(row.amount, settings.currency) },
          ]} />
        </Panel>
        <Panel title="Parts requests" className="nested-panel">
          <DataTable rows={job.requests} empty="No parts requested" columns={[
            { key: 'part', title: 'Part', render: row => <Record title={row.name} subtitle={row.sku} /> },
            { key: 'quantity', title: 'Requested' }, { key: 'status', title: 'Status', render: row => <Status value={row.status} /> },
            { key: 'action', title: 'Actions', render: row => row.status === 'pending'
              ? <Button variant="secondary" disabled={pending} onClick={() => command(`/parts/${row.id}`, 'PATCH', { status: 'cancelled' })}>Cancel request</Button> : '—' },
          ]} />
        </Panel>
        <Panel title="Status history" className="nested-panel">
          <ul className="history-list">{job.history.map(item => <li key={item.status}><Status value={item.status} />
            <span>{item.changed_by} · {date(item.changed_at, settings.reporting_timezone, true)}</span></li>)}</ul>
        </Panel>
      </div>
    </>}</Resource>
  </Modal>
}

function ContactForm({ vehicle, row, onClose, onDone }) {
  const [owner, setOwner] = useState(row?.customer_id ?? '')
  const entity = vehicle ? 'vehicle' : 'customer'
  return <Modal title={`${row ? 'Edit' : 'Register'} ${entity}`} onClose={onClose}>
    <ActionForm submit={row ? 'Save changes' : `Register ${entity}`} onCancel={onClose} onSubmit={async fields => {
      const data = vehicle ? {
        customer_id: owner, registration_number: fields.get('registration_number'), make: fields.get('make'),
        model: fields.get('model'), model_year: getNumber(fields, 'model_year'), vin: nullable(fields, 'vin'),
      } : { full_name: fields.get('full_name'), phone: nullable(fields, 'phone'), email: nullable(fields, 'email') }
      await api((vehicle ? '/vehicles' : '/customers') + (row ? '/' + row.id : ''), { method: row ? 'PATCH' : 'POST', data })
      onDone()
    }}>
      {vehicle ? <>
        <Lookup title="Vehicle owner" endpoint="/customers" format={customerLabel} value={owner} onChange={setOwner} initialLabel={row?.customer_name} required />
        <Field label="Registration number" name="registration_number" defaultValue={row?.registration_number} required maxLength={32} />
        <div className="form-grid">
          <Field label="Make" name="make" defaultValue={row?.make} required maxLength={100} />
          <Field label="Model" name="model" defaultValue={row?.model} required maxLength={100} />
          <Field label="Model year" name="model_year" type="number" min="1886" max={new Date().getFullYear() + 1} defaultValue={row?.model_year} />
          <Field label="VIN" name="vin" defaultValue={row?.vin} minLength={17} maxLength={17} />
        </div>
      </> : <>
        <Field label="Full name" name="full_name" defaultValue={row?.full_name} required maxLength={200} />
        <Field label="Phone" name="phone" type="tel" defaultValue={row?.phone} maxLength={40} />
        <Field label="Email" name="email" type="email" defaultValue={row?.email} maxLength={254} />
      </>}
    </ActionForm>
  </Modal>
}

export function Customers() {
  const [tab, setTab] = useState('customers')
  const [editing, setEditing] = useState(undefined)
  const [revision, setRevision] = useState(0)
  const vehicle = tab === 'vehicles'
  const columns = vehicle ? [
    { key: 'registration_number', title: 'Registration' }, { key: 'vehicle', title: 'Vehicle', render: row => `${row.make} ${row.model}` },
    { key: 'model_year', title: 'Year' }, { key: 'customer_name', title: 'Owner' }, { key: 'vin', title: 'VIN' },
  ] : [{ key: 'full_name', title: 'Customer' }, { key: 'phone', title: 'Phone' }, { key: 'email', title: 'Email' }]
  return <>
    <PageHeading title="Customers & vehicles" caption="Register customer contacts and their vehicles before opening a job card.">
      <Button icon={Plus} onClick={() => setEditing(null)}>Register {vehicle ? 'vehicle' : 'customer'}</Button>
    </PageHeading>
    <div className="tabs" aria-label="Records">
      <button aria-pressed={!vehicle} onClick={() => setTab('customers')}><CircleUserRound size={17} /> Customers</button>
      <button aria-pressed={vehicle} onClick={() => setTab('vehicles')}><CarFront size={17} /> Vehicles</button>
    </div>
    <Listing key={tab} endpoint={'/' + tab} refreshKey={revision} searchPlaceholder={`Search ${tab}…`}
      columns={[...columns, { key: 'actions', title: 'Actions', render: row => <Button variant="secondary" onClick={() => setEditing(row)}>Edit</Button> }]} />
    {editing !== undefined && <ContactForm vehicle={vehicle} row={editing} onClose={() => setEditing(undefined)}
      onDone={() => { setEditing(undefined); setRevision(value => value + 1) }} />}
  </>
}
