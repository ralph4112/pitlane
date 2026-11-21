import { useState } from 'react'
import { CreditCard, Plus, Printer, ReceiptText, ShoppingCart } from 'lucide-react'
import { api, date, label, money, useResource } from './api.js'
import { SaleForm } from './shop.jsx'
import { ActionForm, Button, DataTable, ErrorNotice, Field, Listing, Lookup, Modal, PageHeading, Panel, Record, Resource, Status, options } from './ui.jsx'

const methods = ['cash', 'card', 'bank_transfer', 'mobile_money']
const jobLabel = row => `JOB-${row.id} · ${row.registration_number} · ${row.customer_name}`

function ServiceInvoiceForm({ initialJob, onClose, onCreated }) {
  const [job, setJob] = useState(initialJob || '')
  return <Modal title="New service invoice" description="Labor and fulfilled parts are copied from the completed job." onClose={onClose}>
    <ActionForm submit="Create draft" onCancel={onClose} onSubmit={async () => {
      const result = await api('/invoices/service', { method: 'POST', data: { job_id: job } })
      onCreated(result.id)
    }}>
      <Lookup title="Completed job" endpoint="/billable-jobs" format={jobLabel} value={job} onChange={setJob}
        required initialLabel={initialJob ? `JOB-${initialJob}` : undefined} />
    </ActionForm>
  </Modal>
}

export function Invoices({ user, settings, selling, initialAction, clearAction, openInvoice, revision }) {
  const [creating, setCreating] = useState(Boolean(initialAction?.startsWith('job-')))
  const canSell = user.role_code === 'admin' || user.role_code === 'shop_manager'
  const close = () => { setCreating(false); clearAction() }
  const onCreated = id => { close(); openInvoice(id, true) }
  return <>
    <PageHeading title={selling ? 'Counter sales' : 'Invoices & payments'} caption={selling
      ? 'Create walk-in sales and issue stock from the shop.'
      : 'Create service invoices, review payments, and issue receipts.'}>
      {(!selling || canSell) && <Button icon={selling ? ShoppingCart : Plus} onClick={() => setCreating(true)}>
        {selling ? 'New counter sale' : 'New service invoice'}</Button>}
    </PageHeading>
    <Listing endpoint={selling ? '/invoices?kind=shop_sale' : '/invoices'} refreshKey={revision}
      searchPlaceholder={selling ? 'Search counter sales…' : 'Search invoices…'}
      filter={selling ? undefined : { name: 'kind', label: 'Invoice type', options: options(['service', 'shop_sale'], 'All invoice types') }}
      empty={selling ? 'No counter sales yet' : 'No invoices yet'}
      columns={[
        { key: 'invoice_number', title: 'Invoice', render: row => <button className="text-button" onClick={() => openInvoice(row.id)}>
          {row.invoice_number ?? `Draft #${row.id}`}</button> },
        { key: 'bill_to_name', title: 'Customer' },
        ...(selling ? [] : [{ key: 'kind', title: 'Type', render: row => label(row.kind) }]),
        { key: 'issued_at', title: 'Date', render: row => date(row.issued_at ?? row.created_at, settings.reporting_timezone) },
        { key: 'total', title: 'Total', render: row => money(row.total, row.currency) },
        { key: 'balance_due', title: 'Balance', render: row => row.issued_at ? money(row.balance_due, row.currency) : '—' },
        { key: 'status', title: 'Status', render: row => <Status value={row.payment_status ?? 'draft'} /> },
        { key: 'actions', title: 'Actions', render: row => <Button variant="secondary" onClick={() => openInvoice(row.id)}>Open</Button> },
      ]} />
    {creating && (selling
      ? <SaleForm settings={settings} onClose={close} onCreated={onCreated} />
      : <ServiceInvoiceForm initialJob={initialAction?.startsWith('job-') ? initialAction.slice(4) : undefined} onClose={close} onCreated={onCreated} />)}
  </>
}

function Receipt({ id, timezone, onBack }) {
  const resource = useResource('/receipts/' + id)
  return <Resource state={resource}>{receipt => <>
    <div className="action-row no-print"><Button variant="secondary" onClick={onBack}>Back to invoice</Button>
      <Button icon={Printer} onClick={() => window.print()}>Print receipt</Button></div>
    <section className="print-sheet receipt">
      <div className="bill-brand">Pitlane Garage</div>
      <h3>Payment receipt</h3>
      <p>{receipt.receipt_number} · {date(receipt.confirmed_at, timezone, true)}</p>
      <dl className="detail-grid">
        <div><dt>Invoice</dt><dd>{receipt.invoice_number}</dd></div>
        <div><dt>Received from</dt><dd>{receipt.bill_to_name}</dd></div>
        <div><dt>Method</dt><dd>{label(receipt.method)}</dd></div>
        <div><dt>Reference</dt><dd>{receipt.external_reference ?? '—'}</dd></div>
      </dl>
      <div className="bill-total"><span>Amount received</span><strong>{money(receipt.amount, receipt.currency)}</strong></div>
    </section>
  </>}</Resource>
}

function PaymentForm({ invoice, onDone, onCancel }) {
  const [paymentKey] = useState(() => crypto.randomUUID())
  return <ActionForm submit="Record payment" onCancel={onCancel} onSubmit={async fields => {
    await api(`/invoices/${invoice.id}/payments`, { method: 'POST', data: {
      amount: fields.get('amount'), method: fields.get('method'), confirm: fields.has('confirm'),
      external_reference: fields.get('external_reference')?.trim() || undefined, idempotency_key: paymentKey,
    } })
    onDone()
  }}>
    <div className="form-grid"><Field label={`Amount (${invoice.currency})`} name="amount" type="number" min="0.01"
      step="0.01" max={invoice.balance_due} defaultValue={invoice.balance_due} required />
      <Field label="Payment method" name="method" options={options(methods)} /></div>
    <Field label="External reference" name="external_reference" maxLength={200} placeholder="Optional transaction reference" />
    <Field label="Confirm payment now" name="confirm" type="checkbox" defaultChecked hint="Leave unchecked to queue it for review." />
  </ActionForm>
}

export function InvoiceDetail({ id, user, settings, onClose, onChanged }) {
  const resource = useResource('/invoices/' + id)
  const [active, setActive] = useState('')
  const [line, setLine] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const canBill = user.role_code === 'admin' || user.role_code === 'accountant'
  const refresh = () => { resource.refresh(); onChanged(); setActive(''); setLine(null); setError(null) }
  const command = async (path, method, data) => {
    setBusy(true)
    setError(null)
    try {
      await api(path, { method, data })
      refresh()
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }
  return <Modal title={receipt ? 'Payment receipt' : resource.data?.invoice_number ?? `Invoice draft #${id}`} onClose={onClose} wide>
    {receipt ? <Receipt id={receipt} timezone={settings.reporting_timezone} onBack={() => setReceipt(null)} />
      : <Resource state={resource}>{invoice => {
        const canIssue = invoice.kind === 'shop_sale' ? user.role_code !== 'accountant' : canBill
        const printable = Boolean(invoice.issued_at)
        return <>
          <div className="action-row wrap no-print">
            {!invoice.issued_at && canIssue && <><Button disabled={busy} icon={ReceiptText} onClick={() => command(`/invoices/${id}/issue`, 'POST')}>Issue invoice</Button>
              <Button variant="secondary" disabled={busy} onClick={() => { setLine(null); setActive('delete') }}>Discard draft</Button></>}
            {invoice.issued_at && canBill && Number(invoice.balance_due) > 0 && <Button icon={CreditCard}
              onClick={() => setActive('payment')}>Record payment</Button>}
            {printable && <Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print invoice</Button>}
          </div>
          <ErrorNotice error={error} />
          {active === 'delete' && <Panel title="Discard this draft?" caption="The draft and its lines will be removed." className="nested-panel no-print">
            <ActionForm submit="Discard draft" variant="danger" onCancel={() => setActive('')} onSubmit={async () => {
              await api(`/invoices/${id}`, { method: 'DELETE' })
              onChanged()
              onClose()
            }} />
          </Panel>}
          {active === 'payment' && <Panel title="Record a payment" className="nested-panel no-print">
            <PaymentForm invoice={invoice} onCancel={() => setActive('')} onDone={refresh} />
          </Panel>}
          {line && <Panel title="Override line pricing" caption={line.description} className="nested-panel no-print">
            <ActionForm key={line.id} submit="Apply override" onCancel={() => setLine(null)} onSubmit={async fields => {
              await api(`/invoices/${id}/lines/${line.id}/price`, { method: 'PATCH',
                data: { unit_price: fields.get('unit_price'), reason: fields.get('reason') } })
              refresh()
            }}>
              <Field label={`New unit price (${invoice.currency})`} name="unit_price" type="number" min="0" step="0.01"
                defaultValue={line.override_unit_price ?? line.base_unit_price} required />
              <Field label="Reason" name="reason" required maxLength={500} defaultValue={line.override_reason} />
              {line.override_unit_price !== null && <Button variant="secondary" disabled={busy}
                onClick={() => command(`/invoices/${id}/lines/${line.id}/price`, 'PATCH', { unit_price: null })}>Remove override</Button>}
            </ActionForm>
          </Panel>}
          <section className={printable ? 'print-sheet' : ''}>
            {printable && <div className="bill-brand print-only">Pitlane Garage · {invoice.invoice_number}</div>}
            <div className="detail-banner">
              <div className="detail-icon"><ReceiptText size={22} /></div>
              <Record title={invoice.bill_to_name} subtitle={invoice.issued_at ? date(invoice.issued_at, settings.reporting_timezone, true) : label(invoice.kind)} />
              <Status value={invoice.payment_status ?? 'draft'} />
            </div>
            {invoice.bill_to_contact && <p className="bill-contact">{invoice.bill_to_contact}</p>}
            <DataTable rows={invoice.lines} columns={[
              { key: 'description', title: 'Item', render: row => <Record title={row.description} subtitle={row.override_reason} /> },
              { key: 'quantity', title: 'Qty' },
              { key: 'price', title: 'Unit price', render: row => money(row.override_unit_price ?? row.base_unit_price, invoice.currency) },
              { key: 'line_total', title: 'Line total', render: row => money(row.line_total, invoice.currency) },
              ...(!invoice.issued_at && user.role_code === 'admin' ? [{ key: 'override', title: 'Pricing', render: row => <Button variant="secondary"
                onClick={() => { setLine(row); setActive('') }}>Override</Button> }] : []),
            ]} />
            <div className="bill-total"><span>Invoice total</span><strong>{money(invoice.total, invoice.currency)}</strong></div>
            {invoice.issued_at && <div className="bill-total secondary-total"><span>Balance due</span><strong>{money(invoice.balance_due, invoice.currency)}</strong></div>}
          </section>
          {canBill && invoice.issued_at && <Panel title="Payment history" className="nested-panel no-print">
            <DataTable rows={invoice.payments} empty="No payments recorded yet" columns={[
              { key: 'method', title: 'Method', render: row => <Record title={label(row.method)} subtitle={row.external_reference} /> },
              { key: 'amount', title: 'Amount', render: row => money(row.amount, invoice.currency) },
              { key: 'status', title: 'Status', render: row => <Status value={row.status} /> },
              { key: 'actions', title: 'Actions', render: row => row.status === 'pending' ? <div className="action-row wrap">
                <Button variant="secondary" disabled={busy} onClick={() => command('/payments/' + row.id, 'PATCH', { status: 'confirmed' })}>Confirm</Button>
                <Button variant="secondary" disabled={busy} onClick={() => command('/payments/' + row.id, 'PATCH', { status: 'failed' })}>Mark failed</Button>
              </div> : row.receipt_number ? <button className="text-button" onClick={() => setReceipt(row.id)}>{row.receipt_number}</button> : '—' },
            ]} />
          </Panel>}
        </>
      }}</Resource>}
  </Modal>
}
