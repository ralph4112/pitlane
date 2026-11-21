import { useState } from 'react'
import { Boxes, PackagePlus, Plus, Truck } from 'lucide-react'
import { api, date, money, useResource, withQuery } from './api.js'
import { ActionForm, Button, DataTable, ErrorNotice, Field, Listing, Lookup, Modal, PageHeading, Panel, Record, Resource, Status, options } from './ui.jsx'

const supplierLabel = row => row.name
const partLabel = row => `${row.name} · ${row.sku}`

function PartForm({ row, settings, onClose, onDone }) {
  const [supplier, setSupplier] = useState(row?.supplier_id ?? '')
  return <Modal title={row ? 'Edit part' : 'Add a spare part'} onClose={onClose}>
    <ActionForm onCancel={onClose} onSubmit={async fields => {
      await api('/parts' + (row ? '/' + row.id : ''), { method: row ? 'PATCH' : 'POST', data: {
        sku: fields.get('sku'), name: fields.get('name'), description: fields.get('description') || null,
        supplier_id: supplier || null, unit_cost: fields.get('unit_cost'), unit_price: fields.get('unit_price'),
        reorder_threshold: Number(fields.get('reorder_threshold')), is_active: fields.has('is_active'),
      } })
      onDone()
    }}>
      <div className="form-grid"><Field label="Part name" name="name" defaultValue={row?.name} required maxLength={200} />
        <Field label="SKU" name="sku" defaultValue={row?.sku} required maxLength={60} /></div>
      <Field label="Description" name="description" type="textarea" defaultValue={row?.description} maxLength={1000} />
      <Lookup title="Supplier" endpoint="/suppliers" format={supplierLabel} value={supplier} onChange={setSupplier}
        initialLabel={row?.supplier_name} placeholder="No supplier selected" />
      <div className="form-grid">
        <Field label={`Unit cost (${settings.currency})`} name="unit_cost" type="number" defaultValue={row?.unit_cost} min="0" step="0.01" required />
        <Field label={`Selling price (${settings.currency})`} name="unit_price" type="number" defaultValue={row?.unit_price} min="0" step="0.01" required />
      </div>
      <Field label="Reorder threshold" name="reorder_threshold" type="number" defaultValue={row?.reorder_threshold ?? 0} min="0" max="1000000" required />
      <Field label="Active in catalog" name="is_active" type="checkbox" defaultChecked={row?.is_active ?? true} />
    </ActionForm>
  </Modal>
}

function SupplierForm({ row, onClose, onDone }) {
  const fields = [['name', 'Company name'], ['contact_name', 'Contact person'], ['phone', 'Phone', 'tel'],
    ['email', 'Email', 'email'], ['address', 'Address', 'textarea']]
  return <Modal title={row ? 'Edit supplier' : 'Add supplier'} onClose={onClose}>
    <ActionForm onCancel={onClose} onSubmit={async values => {
      const data = Object.fromEntries(fields.map(([key]) => [key, values.get(key) || null]))
      await api('/suppliers' + (row ? '/' + row.id : ''), { method: row ? 'PATCH' : 'POST', data })
      onDone()
    }}>
      {fields.map(([key, title, type]) => <Field key={key} label={title} name={key} type={type} required={key === 'name'} defaultValue={row?.[key]} />)}
    </ActionForm>
  </Modal>
}

function StockForm({ row, settings, onClose, onChanged }) {
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [quantity, setQuantity] = useState(row.stock_quantity)
  const movements = useResource(withQuery(`/parts/${row.id}/movements`, { page }))
  return <Modal title="Stock movements" description={`${row.name} · ${row.sku}`} onClose={onClose} wide>
    <Panel title={`${quantity} units on hand`} caption="Use a positive quantity to receive stock or a negative quantity to remove it." className="nested-panel">
      <ActionForm key={revision} submit="Record movement" onSubmit={async fields => {
        const quantity_delta = Number(fields.get('quantity_delta'))
        const stock = await api(`/parts/${row.id}/movements`, { method: 'POST', data: { quantity_delta, reason: fields.get('reason') } })
        setQuantity(stock.stock_quantity)
        setRevision(value => value + 1)
        setPage(1)
        movements.refresh()
        onChanged()
      }}>
        <div className="form-grid">
          <Field label="Quantity change" name="quantity_delta" type="number" min="-1000000" max="1000000" required placeholder="+10 or -2" />
          <Field label="Reason" name="reason" maxLength={500} required placeholder="Supplier delivery" />
        </div>
      </ActionForm>
    </Panel>
    <Resource state={movements}>{result => <>
      <DataTable rows={result.items} empty="No stock movements yet" columns={[
        { key: 'quantity_delta', title: 'Change', render: row => row.quantity_delta > 0 ? '+' + row.quantity_delta : row.quantity_delta },
        { key: 'reason', title: 'Reason' }, { key: 'recorded_by', title: 'Recorded by' },
        { key: 'recorded_at', title: 'Date', render: row => date(row.recorded_at, settings.reporting_timezone, true) },
      ]} />
      <div className="pagination"><span>Page {result.page}</span><div>
        <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
        <Button variant="secondary" disabled={!result.has_more} onClick={() => setPage(page + 1)}>Next</Button>
      </div></div>
    </>}</Resource>
  </Modal>
}

export function Inventory({ settings, initialAction }) {
  const [tab, setTab] = useState('parts')
  const [editing, setEditing] = useState(undefined)
  const [stock, setStock] = useState(null)
  const [revision, setRevision] = useState(0)
  const changed = () => setRevision(value => value + 1)
  const parts = tab === 'parts'
  const columns = parts ? [
    { key: 'sku', title: 'Part', render: row => <Record title={row.name} subtitle={row.sku} /> },
    { key: 'supplier_name', title: 'Supplier' },
    { key: 'unit_price', title: 'Unit price', render: row => money(row.unit_price, settings.currency) },
    { key: 'stock_quantity', title: 'On hand' }, { key: 'reorder_threshold', title: 'Reorder at' },
    { key: 'status', title: 'Status', render: row => !row.is_active ? <Status value="neutral">Inactive</Status>
      : row.stock_quantity === 0 ? <Status value="out">Out of stock</Status>
        : row.stock_quantity <= row.reorder_threshold ? <Status value="low">Low stock</Status> : <Status value="available">In stock</Status> },
    { key: 'actions', title: 'Actions', render: row => <div className="action-row">
      <Button variant="secondary" onClick={() => setEditing(row)}>Edit</Button><Button variant="secondary" icon={PackagePlus} onClick={() => setStock(row)}>Stock</Button>
    </div> },
  ] : [
    { key: 'name', title: 'Supplier' }, { key: 'contact_name', title: 'Contact' },
    { key: 'phone', title: 'Phone' }, { key: 'email', title: 'Email' }, { key: 'address', title: 'Address' },
    { key: 'actions', title: 'Actions', render: row => <Button variant="secondary" onClick={() => setEditing(row)}>Edit</Button> },
  ]
  const EditForm = parts ? PartForm : SupplierForm
  return <>
    <PageHeading title="Inventory" caption="Manage the spare-parts catalog, suppliers, and stock levels.">
      <Button icon={Plus} onClick={() => setEditing(null)}>{parts ? 'Add part' : 'Add supplier'}</Button>
    </PageHeading>
    <div className="tabs" aria-label="Inventory records">
      <button aria-pressed={parts} onClick={() => setTab('parts')}><Boxes size={17} /> Parts catalog</button>
      <button aria-pressed={!parts} onClick={() => setTab('suppliers')}><Truck size={17} /> Suppliers</button>
    </div>
    <Listing key={tab} endpoint={'/' + tab} refreshKey={revision} searchPlaceholder={`Search ${tab}…`} columns={columns}
      filter={parts ? { name: 'stock', label: 'Stock level', initial: initialAction === 'low' ? 'low' : '', options: [
        { value: '', label: 'All stock levels' }, { value: 'low', label: 'Low stock' }, { value: 'active', label: 'Active parts' },
      ] } : undefined} />
    {editing !== undefined && <EditForm row={editing} settings={settings} onClose={() => setEditing(undefined)}
      onDone={() => { setEditing(undefined); changed() }} />}
    {stock && <StockForm row={stock} settings={settings} onClose={() => setStock(null)} onChanged={changed} />}
  </>
}

export function Requests({ settings }) {
  const [review, setReview] = useState(null)
  const [revision, setRevision] = useState(0)
  return <>
    <PageHeading title="Parts requests" caption="Review and fulfill parts requests from the workshop." />
    <Listing endpoint="/parts-requests" refreshKey={revision} searchPlaceholder="Search parts requests…"
      filter={{ name: 'status', label: 'Request status', options: options(['pending', 'fulfilled', 'rejected', 'cancelled'], 'All statuses') }}
      columns={[
        { key: 'name', title: 'Part', render: row => <Record title={row.name} subtitle={row.sku} /> },
        { key: 'job_id', title: 'Job card', render: row => <Record title={`JOB-${row.job_id}`} subtitle={row.registration_number} /> },
        { key: 'requested_by', title: 'Requested by' }, { key: 'quantity', title: 'Requested' }, { key: 'stock_quantity', title: 'Available' },
        { key: 'requested_at', title: 'Date', render: row => date(row.requested_at, settings.reporting_timezone) },
        { key: 'status', title: 'Status', render: row => <Status value={row.status} /> },
        { key: 'actions', title: 'Actions', render: row => row.status === 'pending'
          ? <Button variant="secondary" onClick={() => setReview(row)}>Review</Button> : '—' },
      ]} />
    {review && <Modal title="Review parts request" description={`${review.name} · JOB-${review.job_id}`} onClose={() => setReview(null)}>
      <ActionForm submit="Resolve request" onCancel={() => setReview(null)} onSubmit={async fields => {
        await api('/parts-requests/' + review.id, { method: 'PATCH', data: { status: fields.get('status') } })
        setReview(null)
        setRevision(value => value + 1)
      }}>
        <p>{review.quantity} requested · {review.stock_quantity} on hand</p>
        <Field label="Decision" name="status" required options={options(['fulfilled', 'rejected'], 'Select a decision')} />
      </ActionForm>
    </Modal>}
  </>
}

export function SaleForm({ settings, onClose, onCreated }) {
  const [selected, setSelected] = useState('')
  const [selectedRow, setSelectedRow] = useState(null)
  const [cart, setCart] = useState([])
  const [error, setError] = useState(null)
  const updateQuantity = (id, quantity) => setCart(previous => previous.map(item => item.id === id ? { ...item, quantity } : item))
  return <Modal title="New counter sale" description="Build the basket and review the invoice before issuing it." onClose={onClose} wide>
    <ActionForm submit="Review sale" onCancel={onClose} onSubmit={async fields => {
      const lines = cart.map(item => ({ part_id: item.id, quantity: Number(item.quantity) }))
      const result = await api('/invoices/shop', { method: 'POST', data: {
        lines, bill_to_name: fields.get('bill_to_name')?.trim() || undefined, bill_to_contact: fields.get('bill_to_contact')?.trim() || undefined,
      } })
      onCreated(result.id)
    }}>
      <div className="form-grid">
        <Field label="Customer name" name="bill_to_name" placeholder="Walk-in customer" maxLength={200} />
        <Field label="Customer contact" name="bill_to_contact" placeholder="Optional" maxLength={254} />
      </div>
      <div className="cart-lookup">
        <Lookup title="Part" endpoint="/part-options" format={partLabel} value={selected} onChange={(id, _label, row) => { setSelected(id); setSelectedRow(row) }} />
        <Button icon={Plus} variant="secondary" disabled={!selectedRow} onClick={() => {
          if (selectedRow.stock_quantity < 1) {
            setError('This part is out of stock.')
            return
          }
          setError(null)
          setCart(previous => previous.some(item => item.id === selectedRow.id) ? previous : [...previous, { ...selectedRow, quantity: 1 }])
          setSelected('')
          setSelectedRow(null)
        }}>Add to basket</Button>
      </div>
      <ErrorNotice error={error} />
      <DataTable rows={cart} empty="Add a part to the basket." columns={[
        { key: 'name', title: 'Part', render: row => <Record title={row.name} subtitle={row.sku} /> },
        { key: 'stock_quantity', title: 'Available' },
        { key: 'quantity', title: 'Quantity', render: row => <input className="quantity-input" type="number" min="1" max={row.stock_quantity}
          aria-label={`Quantity for ${row.name}`} value={row.quantity} required onChange={event => updateQuantity(row.id, event.target.value)} /> },
        { key: 'action', title: 'Actions', render: row => <Button variant="secondary" onClick={() => setCart(previous => previous.filter(item => item.id !== row.id))}>Remove</Button> },
      ]} />
    </ActionForm>
  </Modal>
}
