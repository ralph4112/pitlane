import { useState } from 'react'
import { MessageSquarePlus, UserRoundPlus } from 'lucide-react'
import { api, date, roleNames } from './api.js'
import { ActionForm, Button, Field, Listing, Lookup, Modal, PageHeading, Record, Status, options } from './ui.jsx'

const roleOptions = Object.entries(roleNames).map(([value, label]) => ({ value, label }))
const jobLabel = row => `JOB-${row.id} · ${row.registration_number} · ${row.customer_name}`

export function Users({ user, onProfileChanged }) {
  const [editing, setEditing] = useState(undefined)
  const [revision, setRevision] = useState(0)
  const self = editing?.id === user.id
  const close = () => setEditing(undefined)
  return <>
    <PageHeading title="Team & permissions" caption="Manage staff accounts, access roles, and account status.">
      <Button icon={UserRoundPlus} onClick={() => setEditing(null)}>Add team member</Button>
    </PageHeading>
    <Listing endpoint="/users" refreshKey={revision} searchPlaceholder="Search team members…" columns={[
      { key: 'full_name', title: 'Team member', render: row => <Record title={row.full_name} subtitle={row.email} /> },
      { key: 'role_code', title: 'Role', render: row => roleNames[row.role_code] },
      { key: 'is_active', title: 'Status', render: row => <Status value={row.is_active ? 'available' : 'neutral'}>{row.is_active ? 'Active' : 'Inactive'}</Status> },
      { key: 'action', title: 'Actions', render: row => <Button variant="secondary" onClick={() => setEditing(row)}>Edit account</Button> },
    ]} />
    {editing !== undefined && <Modal title={editing ? 'Edit team member' : 'Add team member'} onClose={close}>
      <ActionForm submit={editing ? 'Save account' : 'Create account'} onCancel={close} onSubmit={async fields => {
        const saved = await api('/users' + (editing ? '/' + editing.id : ''), { method: editing ? 'PATCH' : 'POST', data: {
          full_name: fields.get('full_name'), email: fields.get('email'), role_code: self ? 'admin' : fields.get('role_code'),
          password: fields.get('password') || undefined, ...(editing ? { is_active: self || fields.has('is_active') } : {}),
        } })
        if (self) onProfileChanged(previous => ({ ...previous, ...saved }))
        close()
        setRevision(value => value + 1)
      }}>
        <Field label="Full name" name="full_name" defaultValue={editing?.full_name} required maxLength={200} />
        <Field label="Email address" name="email" type="email" defaultValue={editing?.email} autoComplete="off" required maxLength={254} />
        <Field label="Role" name="role_code" defaultValue={editing?.role_code ?? 'mechanic'} options={roleOptions} disabled={self} />
        <Field label={editing ? 'New password' : 'Password'} name="password" type="password" minLength={12} maxLength={72}
          autoComplete="new-password" required={!editing} hint={editing ? 'Leave blank to keep the current password.' : 'Use at least 12 characters.'} />
        {editing && <Field label="Active account" name="is_active" type="checkbox" defaultChecked={editing.is_active} disabled={self} />}
      </ActionForm>
    </Modal>}
  </>
}

function FeedbackForm({ row, onClose, onDone }) {
  const [job, setJob] = useState('')
  const [status, setStatus] = useState(row?.status ?? 'open')
  return <Modal title={row ? 'Review feedback' : 'Log customer feedback'} onClose={onClose}>
    <ActionForm onCancel={onClose} submit={row ? 'Save review' : 'Log feedback'} onSubmit={async fields => {
      const rating = fields.get('rating')
      const data = row
        ? { status, ...(status === 'resolved' ? { resolution_notes: fields.get('resolution_notes') } : {}) }
        : { job_id: job, rating: rating ? Number(rating) : undefined, comments: fields.get('comments')?.trim() || undefined,
          is_complaint: fields.has('is_complaint') }
      await api('/feedback' + (row ? '/' + row.id : ''), { method: row ? 'PATCH' : 'POST', data })
      onDone()
    }}>
      {row ? <>
        <Record title={row.customer_name} subtitle={`JOB-${row.job_id} · ${row.registration_number}`} />
        {row.comments && <p className="work-description">{row.comments}</p>}
        <Field label="Review status" value={status} onChange={event => setStatus(event.target.value)}
          options={options(['open', 'in_review', 'resolved'])} />
        {status === 'resolved' && <Field label="Resolution notes" name="resolution_notes" type="textarea" defaultValue={row.resolution_notes}
          required maxLength={5000} />}
      </> : <>
        <Lookup title="Completed job" endpoint="/jobs?status=completed" format={jobLabel} value={job} onChange={setJob} required />
        <Field label="Rating" name="rating" options={[{ value: '', label: 'No rating' }, ...[5, 4, 3, 2, 1].map(value => ({ value, label: `${value} / 5` }))]} />
        <Field label="Comments" name="comments" type="textarea" maxLength={5000} />
        <Field label="Flag as a complaint" name="is_complaint" type="checkbox" />
      </>}
    </ActionForm>
  </Modal>
}

export function Feedback({ settings }) {
  const [editing, setEditing] = useState(undefined)
  const [revision, setRevision] = useState(0)
  const close = () => setEditing(undefined)
  return <>
    <PageHeading title="Customer feedback" caption="Log after-service ratings and follow complaints through resolution.">
      <Button icon={MessageSquarePlus} onClick={() => setEditing(null)}>Log feedback</Button>
    </PageHeading>
    <Listing endpoint="/feedback" refreshKey={revision} searchPlaceholder="Search customer feedback…"
      filter={{ name: 'status', label: 'Feedback status', options: options(['open', 'in_review', 'resolved'], 'All statuses') }}
      columns={[
        { key: 'customer_name', title: 'Customer', render: row => <Record title={row.customer_name} subtitle={`JOB-${row.job_id} · ${row.registration_number}`} /> },
        { key: 'rating', title: 'Rating', render: row => row.rating ? `${row.rating} / 5` : '—' },
        { key: 'is_complaint', title: 'Type', render: row => row.is_complaint ? <Status value="out">Complaint</Status> : 'Review' },
        { key: 'logged_at', title: 'Logged', render: row => date(row.logged_at, settings.reporting_timezone) },
        { key: 'status', title: 'Status', render: row => <Status value={row.status} /> },
        { key: 'actions', title: 'Actions', render: row => <Button variant="secondary" onClick={() => setEditing(row)}>Review</Button> },
      ]} />
    {editing !== undefined && <FeedbackForm row={editing} onClose={close} onDone={() => { close(); setRevision(value => value + 1) }} />}
  </>
}
