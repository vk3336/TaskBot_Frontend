import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import VoiceTaskFlow from './VoiceTaskFlow.jsx'

const API          = import.meta.env.VITE_BACKEND
const USERS_API    = import.meta.env.VITE_USERS_API
const ACCOUNT_API  = import.meta.env.VITE_ACCOUNT_API
const CONTACT_API  = import.meta.env.VITE_CONTACT_API

/* ── env guard — fail loudly at startup instead of silently at runtime ── */
if (!API)       console.error('[TaskBot] VITE_BACKEND is not set. Task API calls will fail. Check your .env.local file.')
if (!USERS_API) console.error('[TaskBot] VITE_USERS_API is not set. User loading will fail. Check your .env.local file.')

/* ─── helpers ─────────────────────────────────────── */
function getTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function getStatusClass(s) {
  if (!s) return 'not-started'
  return s.toLowerCase().replace(/\s+/g, '-')
}
function initials(name) {
  if (!name) return '?'
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

/* ─── API calls ────────────────────────────────────── */
async function fetchUsers() {
  if (!USERS_API) throw new Error('VITE_USERS_API is not configured. Add it to your .env.local file.')
  const res = await fetch(USERS_API)
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  const json = await res.json()
  return json.data || []
}
async function fetchAllTasks() {
  if (!API) throw new Error('VITE_BACKEND is not configured. Add it to your .env.local file.')
  const res = await fetch(API)
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  const json = await res.json()
  return json.data || []
}
async function fetchTasksByUser(userId) {
  if (!API) throw new Error('VITE_BACKEND is not configured. Add it to your .env.local file.')
  const res = await fetch(`${API}/user/${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  const json = await res.json()
  return json.data || []
}
async function postTask(body) {
  if (!API) throw new Error('VITE_BACKEND is not configured. Add it to your .env.local file.')
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Server error ${res.status}`)
  }
  return res.json()
}
async function fetchAccounts() {
  if (!ACCOUNT_API) return []
  const res = await fetch(ACCOUNT_API)
  if (!res.ok) return []
  return (await res.json()).data || []
}
async function fetchContacts() {
  if (!CONTACT_API) return []
  const res = await fetch(CONTACT_API)
  if (!res.ok) return []
  return (await res.json()).data || []
}
async function apiCreateAccount(name) {
  const res = await fetch(ACCOUNT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.message || `Server error ${res.status}`)
  return json.data
}
async function apiCreateContact(name, accountId) {
  const res = await fetch(CONTACT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, accountId: accountId || undefined }) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.message || `Server error ${res.status}`)
  return json.data
}

/* ── Scored fuzzy match (same as VoiceTaskFlow) ── */
function fuzzyMatch(query, list) {
  if (!query || !list?.length) return []
  const q = query.toLowerCase().trim()
  if (!q) return []
  const qWords = q.split(/\s+/).filter(Boolean)
  const scored = list.map(r => {
    const n = r.name.toLowerCase()
    const nWords = n.split(/\s+/).filter(Boolean)
    let score = 0
    if (n === q)                                                          score = 100
    else if (n.startsWith(q))                                             score = 80
    else if (qWords.every(w => n.includes(w)))                            score = 60
    else if (qWords.some(w => n.includes(w)))                             score = 40
    else if (nWords.some(nw => qWords.some(qw => nw.startsWith(qw))))    score = 20
    else if (qWords.some(w => n.replace(/\s+/g,'').includes(w.replace(/\s+/g,'')))) score = 10
    return { r, score }
  }).filter(x => x.score > 0)
  scored.sort((a, b) => b.score - a.score)
  return scored.map(x => x.r)
}

/* ─── Filter helpers ───────────────────────────────── */
function getUniqueValues(tasks, field) {
  const set = new Set()
  tasks.forEach(t => { if (t[field]) set.add(t[field]) })
  return [...set].sort()
}

const PRIORITY_ORDER = { Urgent: 0, High: 1, Normal: 2, Low: 3 }
function sortPriorities(arr) {
  return arr.sort((a, b) => (PRIORITY_ORDER[a] ?? 99) - (PRIORITY_ORDER[b] ?? 99))
}

function getUniqueUsers(tasks) {
  const userMap = new Map()
  tasks.forEach(t => {
    if (t.assignedUsersNames && typeof t.assignedUsersNames === 'object') {
      Object.entries(t.assignedUsersNames).forEach(([id, name]) => {
        if (id && name) userMap.set(id, name)
      })
    }
  })
  return [...userMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function taskHasUser(task, userId) {
  if (!userId) return true
  if ((task.assignedUsersIds || []).includes(userId)) return true
  return Object.prototype.hasOwnProperty.call(task.assignedUsersNames || {}, userId)
}

function applyFilters(tasks, filters) {
  return tasks.filter(t => {
    if (filters.userId && !taskHasUser(t, filters.userId)) return false
    if (filters.status && t.status !== filters.status) return false
    if (filters.priority && t.priority !== filters.priority) return false
    if (filters.dateStartDate && (!t.dateStartDate || t.dateStartDate < filters.dateStartDate)) return false
    if (filters.dateEndDate && (!t.dateEndDate || t.dateEndDate > filters.dateEndDate)) return false
    return true
  })
}

const EMPTY_FILTERS = { status: '', priority: '', dateStartDate: '', dateEndDate: '', userId: '' }

function hasActiveFilters(filters) {
  return !!(filters.status || filters.priority || filters.dateStartDate || filters.dateEndDate || filters.userId)
}

function TaskFilterBar({ tasks, filters, onChange, showUserFilter = false }) {
  const statuses  = getUniqueValues(tasks, 'status')
  const priorities = sortPriorities(getUniqueValues(tasks, 'priority'))
  const startDates = getUniqueValues(tasks, 'dateStartDate')
  const endDates   = getUniqueValues(tasks, 'dateEndDate')
  const users      = showUserFilter ? getUniqueUsers(tasks) : []

  const activeCount = Object.values(filters).filter(Boolean).length
  const hasFilters  = activeCount > 0

  const priorityColors = {
    Urgent: { bg: 'rgba(244,63,94,0.15)', border: 'rgba(244,63,94,0.4)', color: '#f87171' },
    High:   { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)', color: '#fbbf24' },
    Normal: { bg: 'rgba(99,102,241,0.15)', border: 'rgba(99,102,241,0.4)', color: '#818cf8' },
    Low:    { bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.4)', color: '#34d399' },
  }

  return (
    <div className="task-filter-bar">
      <div className="task-filter-header">
        <span className="task-filter-title">
          🔍 Filters
          {hasFilters && <span className="filter-active-badge">{activeCount}</span>}
        </span>
        {hasFilters && (
          <button className="filter-clear-btn" onClick={() => onChange(EMPTY_FILTERS)}>
            ✕ Clear all
          </button>
        )}
      </div>

      <div className="task-filter-row">
        {/* Status */}
        {statuses.length > 0 && (
          <div className="filter-group">
            <label className="filter-label">Status</label>
            <div className="filter-chips">
              {statuses.map(s => (
                <button
                  key={s}
                  className={`filter-chip status-chip ${getStatusClass(s)} ${filters.status === s ? 'active' : ''}`}
                  onClick={() => onChange({ ...filters, status: filters.status === s ? '' : s })}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Priority */}
        {priorities.length > 0 && (
          <div className="filter-group">
            <label className="filter-label">Priority</label>
            <div className="filter-chips">
              {priorities.map(p => {
                const col = priorityColors[p] || priorityColors.Normal
                return (
                  <button
                    key={p}
                    data-priority={p}
                    className={`filter-chip priority-chip ${filters.priority === p ? 'active' : ''}`}
                    style={filters.priority === p
                      ? { background: col.bg, borderColor: col.border, color: col.color, boxShadow: `0 0 0 2px ${col.border}, 0 4px 14px rgba(0,0,0,0.25)` }
                      : {}}
                    onClick={() => onChange({ ...filters, priority: filters.priority === p ? '' : p })}
                  >
                    {p}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* User — only shown on All Tasks view */}
        {showUserFilter && users.length > 0 && (
          <div className="filter-group filter-group-date">
            <label className="filter-label">Task by User</label>
            <select
              className="filter-select"
              value={filters.userId}
              onChange={e => onChange({ ...filters, userId: e.target.value })}
            >
              <option value="">Any</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        )}

        {/* Start Date */}
        {startDates.length > 0 && (
          <div className="filter-group filter-group-date">
            <label className="filter-label">Start Date</label>
            <select
              className="filter-select"
              value={filters.dateStartDate}
              onChange={e => onChange({ ...filters, dateStartDate: e.target.value })}
            >
              <option value="">Any</option>
              {startDates.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}

        {/* End Date */}
        {endDates.length > 0 && (
          <div className="filter-group filter-group-date">
            <label className="filter-label">Due Date</label>
            <select
              className="filter-select"
              value={filters.dateEndDate}
              onChange={e => onChange({ ...filters, dateEndDate: e.target.value })}
            >
              <option value="">Any</option>
              {endDates.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Sub-components ───────────────────────────────── */
function TaskCard({ task }) {
  const assigneeList = Object.values(task.assignedUsersNames || {})
  const assigneeDisplay = assigneeList.length > 0
    ? assigneeList.join(', ')
    : (task.assignedUserName || 'Unassigned')
  return (
    <div className="task-card">
      <div className="task-card-header">
        <span className="task-name">{task.name}</span>
        <span className={`status-badge ${getStatusClass(task.status)}`}>{task.status}</span>
      </div>
      <div className="task-meta">
        <span>👤 {assigneeDisplay}</span>
        {task.dateEndDate && <span>📅 {task.dateEndDate}</span>}
        {task.dateEnd && !task.dateEndDate && <span>📅 {task.dateEnd}</span>}
        {task.priority && <span>🔥 {task.priority}</span>}
      </div>
      {task.description && <div className="task-desc">📝 {task.description}</div>}
      {(task.attachmentsIds?.length > 0) && (
        <div className="task-meta" style={{ marginTop: '4px' }}>
          <span>📎 {task.attachmentsIds.length} attachment{task.attachmentsIds.length > 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  )
}

function UserList({ users, onSelect }) {
  return (
    <div className="user-list">
      <p className="user-list-title">Select a team member to view their tasks:</p>
      <div className="user-chips">
        {users.map(u => (
          <button key={u.id} className="user-chip" onClick={() => onSelect(u)}>
            <span className="chip-avatar">{initials(u.name)}</span>
            <span>{u.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── SearchDropdown — portal-based floating dropdown, never clipped ─────────
   Renders the dropdown via React Portal into document.body so it sits on top
   of any overflow:hidden parent. Position is calculated from the input's
   getBoundingClientRect so it always aligns under the trigger element.
──────────────────────────────────────────────────────────────────────────── */
function SearchDropdown({ triggerRef, open, items, hint, emptyText, onSelect, createText, onCreate }) {
  const [rect, setRect] = useState(null)

  useEffect(() => {
    if (!open || !triggerRef.current) return
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (r) setRect(r)
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, triggerRef])

  if (!open || !rect) return null

  // Flip upward if not enough space below
  const spaceBelow = window.innerHeight - rect.bottom
  const dropHeight = Math.min(items.length * 44 + 60, 280)
  const showAbove  = spaceBelow < dropHeight + 8 && rect.top > dropHeight

  const style = {
    position: 'fixed',
    left:  rect.left,
    width: rect.width,
    zIndex: 9999,
    ...(showAbove
      ? { bottom: window.innerHeight - rect.top + 4 }
      : { top: rect.bottom + 4 }),
  }

  return createPortal(
    <div className="sdd-dropdown" style={style}>
      {hint && <div className="sdd-hint">{hint}</div>}
      {items.length > 0 ? items.map(item => (
        <div key={item.id} className="sdd-item" onMouseDown={e => { e.preventDefault(); onSelect(item) }}>
          <span className="sdd-icon">{item.icon || '•'}</span>
          <div className="sdd-info">
            <span className="sdd-name">{item.name}</span>
            {item.sub && <span className="sdd-sub">{item.sub}</span>}
          </div>
        </div>
      )) : (
        <div className="sdd-empty">{emptyText || 'No results'}</div>
      )}
      {createText && (
        <div className="sdd-create" onMouseDown={e => { e.preventDefault(); onCreate() }}>
          ➕ {createText}
        </div>
      )}
    </div>,
    document.body
  )
}

function CreateTaskForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: '', description: '', priority: 'Normal',
    dateStartDate: '', dateEndDate: '',
    assignedUsersIds: [], assignedUsersNames: {},
    accountId: '', accountName: '', contactId: '', contactName: '',
  })
  const [users,    setUsers]    = useState([])
  const [accounts, setAccounts] = useState([])
  const [contacts, setContacts] = useState([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  // search state
  const [accountSearch, setAccountSearch] = useState('')
  const [contactSearch, setContactSearch] = useState('')
  const [creatingAcc,   setCreatingAcc]   = useState(false)
  const [creatingCon,   setCreatingCon]   = useState(false)
  const [accError,      setAccError]      = useState('')
  const [conError,      setConError]      = useState('')

  useEffect(() => {
    fetchUsers()
      .then(d => setUsers(d))
      .catch(err => { setError(`Failed to load users: ${err.message}`); setUsers([]) })
      .finally(() => setUsersLoading(false))
    fetchAccounts().then(setAccounts).catch(() => {})
    fetchContacts().then(setContacts).catch(() => {})
  }, [])

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const toggleUser = (userId, userName) => {
    setForm(prev => {
      const ids   = prev.assignedUsersIds || []
      const names = { ...(prev.assignedUsersNames || {}) }
      if (ids.includes(userId)) {
        delete names[userId]
        return { ...prev, assignedUsersIds: ids.filter(i => i !== userId), assignedUsersNames: names }
      } else {
        names[userId] = userName
        return { ...prev, assignedUsersIds: [...ids, userId], assignedUsersNames: names }
      }
    })
  }

  // Select account → filter contacts to this account; if only 1 contact auto-fill it
  const selectAccount = (a) => {
    setForm(prev => {
      const updated = { ...prev, accountId: a.id, accountName: a.name, contactId: '', contactName: '' }
      return updated
    })
    setAccountSearch(a.name)
    setContactSearch('')
    // Auto-fill contact if only one belongs to this account
    const acctContacts = contacts.filter(c => c.accountId === a.id)
    if (acctContacts.length === 1) {
      setForm(prev => ({ ...prev, accountId: a.id, accountName: a.name, contactId: acctContacts[0].id, contactName: acctContacts[0].name }))
      setContactSearch(acctContacts[0].name)
    }
  }

  // Select contact → auto-fill its account if not already set
  const selectContact = (c) => {
    setForm(prev => {
      const updated = { ...prev, contactId: c.id, contactName: c.name }
      if (c.accountId && !prev.accountId) {
        updated.accountId   = c.accountId
        updated.accountName = c.accountName || ''
        setAccountSearch(c.accountName || '')
      }
      return updated
    })
    setContactSearch(c.name)
  }

  const handleCreateAccount = async () => {
    if (!accountSearch.trim()) return
    setCreatingAcc(true); setAccError('')
    try {
      const newAcc = await apiCreateAccount(accountSearch.trim())
      setAccounts(prev => [...prev, newAcc])
      selectAccount(newAcc)
    } catch (e) { setAccError(e.message) }
    finally { setCreatingAcc(false) }
  }

  const handleCreateContact = async () => {
    if (!contactSearch.trim()) return
    setCreatingCon(true); setConError('')
    try {
      const newCon = await apiCreateContact(contactSearch.trim(), form.accountId || undefined)
      setContacts(prev => [...prev, newCon])
      selectContact(newCon)
    } catch (e) { setConError(e.message) }
    finally { setCreatingCon(false) }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Task name is required.'); return }
    setLoading(true); setError('')
    try {
      const payload = {
        name:             form.name,
        priority:         form.priority,
        description:      form.description      || undefined,
        dateStartDate:    form.dateStartDate     || undefined,
        dateEndDate:      form.dateEndDate       || undefined,
        assignedUsersIds: form.assignedUsersIds.length  > 0 ? form.assignedUsersIds  : undefined,
        assignedUsersNames: Object.keys(form.assignedUsersNames).length > 0 ? form.assignedUsersNames : undefined,
        contactId:        form.contactId         || undefined,
        accountId:        form.accountId         || undefined,
      }
      Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k])
      await onSubmit(payload)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  // Compute dropdown results — always show 5 defaults, filter when typing
  const filteredContacts = form.accountId
    ? contacts.filter(c => c.accountId === form.accountId)
    : contacts
  const accResults = (accountSearch.trim()
    ? fuzzyMatch(accountSearch, accounts)
    : accounts).slice(0, 5)
  const conResults = (contactSearch.trim()
    ? fuzzyMatch(contactSearch, filteredContacts)
    : filteredContacts).slice(0, 5)
  const accExact = accounts.some(a => a.name.toLowerCase() === accountSearch.trim().toLowerCase())
  const conExact = contacts.some(c => c.name.toLowerCase() === contactSearch.trim().toLowerCase())

  // Dropdown open state — controlled by focus/blur
  const [accOpen, setAccOpen] = useState(false)
  const [conOpen, setConOpen] = useState(false)
  // Refs point to the input elements (used by SearchDropdown for positioning)
  const accInputRef = useRef(null)
  const conInputRef = useRef(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (accInputRef.current && !accInputRef.current.contains(e.target)) setAccOpen(false)
      if (conInputRef.current && !conInputRef.current.contains(e.target)) setConOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const assignedNames = Object.values(form.assignedUsersNames)
  return (
    <form className="create-form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>Task Name *</label>
        <input className="form-input" placeholder="e.g. Fix login bug" value={form.name}
          onChange={e => set('name', e.target.value)} />
      </div>

      <div className="form-row">
        <label>Assign To {assignedNames.length > 0 && <span style={{ color: 'var(--accent-light)', fontSize: '11px' }}>({assignedNames.join(', ')})</span>}</label>
        {usersLoading ? (
          <div className="form-input" style={{ color: 'var(--text-muted)', pointerEvents: 'none' }}>Loading users…</div>
        ) : (
          <div className="vf-user-checklist" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: '8px', padding: '6px' }}>
            {users.map(u => (
              <label key={u.id} className="vf-user-check-row">
                <input type="checkbox" checked={(form.assignedUsersIds || []).includes(u.id)}
                  onChange={() => toggleUser(u.id, u.name)} />
                <span>{u.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── Account field ── */}
      <div className="form-row">
        <label>🏢 Account (Company)</label>
        {form.accountId ? (
          <div className="cf-selected-row">
            <span className="cf-selected-icon">🏢</span>
            <span className="cf-selected-name">{form.accountName}</span>
            <button type="button" className="cf-clear-btn" onClick={() => {
              setForm(prev => ({ ...prev, accountId: '', accountName: '', contactId: '', contactName: '' }))
              setAccountSearch(''); setContactSearch('')
            }}>✕</button>
          </div>
        ) : (
          <div className="cf-search-wrap">
            <input
              ref={accInputRef}
              className="cf-input form-input"
              placeholder="Search company name…"
              value={accountSearch}
              onFocus={() => setAccOpen(true)}
              onChange={e => { setAccountSearch(e.target.value); setAccError(''); setAccOpen(true) }}
              autoComplete="off"
            />
            <SearchDropdown
              triggerRef={accInputRef}
              open={accOpen}
              hint={accountSearch.trim() ? 'Matching accounts' : 'Recent accounts'}
              items={accResults.map(a => ({ id: a.id, name: a.name, icon: '🏢' }))}
              emptyText="No accounts found"
              onSelect={a => { selectAccount({ id: a.id, name: a.name }); setAccOpen(false) }}
              createText={accountSearch.trim().length > 1 && !accExact ? (creatingAcc ? 'Creating…' : `"${accountSearch.trim()}"`) : null}
              onCreate={() => { handleCreateAccount(); setAccOpen(false) }}
            />
            {accError && <div className="cf-field-error">⚠️ {accError}</div>}
          </div>
        )}
      </div>

      {/* ── Contact field ── */}
      <div className="form-row">
        <label>
          👤 Contact (Person)
          {form.accountId && !form.contactId && (
            <span className="cf-label-hint">in {form.accountName}</span>
          )}
        </label>
        {form.contactId ? (
          <div className="cf-selected-row">
            <span className="cf-selected-icon">👤</span>
            <div className="cf-selected-info">
              <span className="cf-selected-name">{form.contactName}</span>
              {form.accountName && <span className="cf-selected-sub">🏢 {form.accountName}</span>}
            </div>
            <button type="button" className="cf-clear-btn" onClick={() => {
              setForm(prev => ({ ...prev, contactId: '', contactName: '' }))
              setContactSearch('')
            }}>✕</button>
          </div>
        ) : (
          <div className="cf-search-wrap">
            <input
              ref={conInputRef}
              className="cf-input form-input"
              placeholder={form.accountId ? `Search in ${form.accountName}…` : 'Search contact name…'}
              value={contactSearch}
              onFocus={() => setConOpen(true)}
              onChange={e => { setContactSearch(e.target.value); setConError(''); setConOpen(true) }}
              autoComplete="off"
            />
            <SearchDropdown
              triggerRef={conInputRef}
              open={conOpen}
              hint={contactSearch.trim() ? 'Matching contacts' : (form.accountId ? `Contacts in ${form.accountName}` : 'Recent contacts')}
              items={conResults.map(c => ({ id: c.id, name: c.name, icon: '👤', sub: c.accountName ? `🏢 ${c.accountName}` : null }))}
              emptyText={form.accountId ? `No contacts in ${form.accountName}` : 'No contacts found'}
              onSelect={c => {
                const full = contacts.find(x => x.id === c.id) || c
                selectContact(full); setConOpen(false)
              }}
              createText={contactSearch.trim().length > 1 && !conExact
                ? (creatingCon ? 'Creating…' : `"${contactSearch.trim()}"${form.accountId ? ` under ${form.accountName}` : ''}`)
                : null}
              onCreate={() => { handleCreateContact(); setConOpen(false) }}
            />
            {conError && <div className="cf-field-error">⚠️ {conError}</div>}
          </div>
        )}
      </div>

      <div className="form-row">
        <label>Priority</label>
        <select className="form-input" value={form.priority} onChange={e => set('priority', e.target.value)}>
          {['Low', 'Normal', 'High', 'Urgent'].map(p => <option key={p}>{p}</option>)}
        </select>
      </div>
      <div className="form-grid">
        <div className="form-row">
          <label>Start Date</label>
          <input className="form-input" type="date" value={form.dateStartDate}
            onChange={e => set('dateStartDate', e.target.value)} />
        </div>
        <div className="form-row">
          <label>End Date</label>
          <input className="form-input" type="date" value={form.dateEndDate}
            onChange={e => set('dateEndDate', e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <label>Description</label>
        <textarea className="form-input form-textarea" rows={2} placeholder="Optional description…"
          value={form.description} onChange={e => set('description', e.target.value)} />
      </div>
      {error && <div className="form-error">⚠️ {error}</div>}
      <div className="form-actions">
        <button type="button" className="form-btn cancel" onClick={onCancel}>Cancel</button>
        <button type="submit" className="form-btn submit" disabled={loading || usersLoading}>
          {loading ? 'Creating…' : '✅ Create Task'}
        </button>
      </div>
    </form>
  )
}

const PAGE_SIZE = 3

function TaskListWithFilter({ tasks, label, showUserFilter = false }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [visible, setVisible] = useState(PAGE_SIZE)

  // Reset pagination when filters change
  const handleFilterChange = (newFilters) => {
    setFilters(newFilters)
    setVisible(PAGE_SIZE)
  }

  const filtered  = applyFilters(tasks, filters)
  const shown     = filtered.slice(0, visible)
  const remaining = filtered.length - visible

  return (
    <>
      {label && <span style={{ whiteSpace: 'pre-wrap' }}>{label}</span>}
      <TaskFilterBar tasks={tasks} filters={filters} onChange={handleFilterChange} showUserFilter={showUserFilter} />

      {filtered.length > 0
        ? <>
            {shown.map(t => <TaskCard key={t.id} task={t} />)}

            <div className="pagination-row">
              <span className="pagination-info">
                Showing {shown.length} of {filtered.length}{hasActiveFilters(filters) ? ' filtered' : ''} tasks
                {filtered.length !== tasks.length && ` (${tasks.length} total)`}
              </span>
              {remaining > 0 && (
                <button className="show-more-btn" onClick={() => setVisible(v => v + PAGE_SIZE)}>
                  Show {Math.min(remaining, PAGE_SIZE)} more ↓
                </button>
              )}
              {visible > PAGE_SIZE && remaining === 0 && (
                <button className="show-less-btn" onClick={() => setVisible(PAGE_SIZE)}>
                  Show less ↑
                </button>
              )}
            </div>
          </>
        : <div className="empty-state">😕 No tasks match the selected filters.</div>
      }
    </>
  )
}

function Message({ msg, onUserSelect, onCreateSubmit, onCreateCancel, onVoiceDone, onVoiceCancel }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`message-row ${isUser ? 'user' : ''}`}>
      <div className={`msg-avatar ${isUser ? 'user-msg' : 'ai'}`}>
        {isUser
          ? <img src="/profile.png" alt="User" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
          : <img src="/chat.png" alt="TaskBot" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />}
      </div>
      <div className="message-content">
        <div className={`bubble ${isUser ? 'user' : 'ai'}`}>
          {/* Task list with filter bar */}
          {msg.tasks != null
            ? <TaskListWithFilter tasks={msg.tasks} label={msg.content} showUserFilter={msg.allTasks} />
            : msg.content && <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>}
          {msg.users && <UserList users={msg.users} onSelect={onUserSelect} />}
          {msg.showForm && <CreateTaskForm onSubmit={onCreateSubmit} onCancel={onCreateCancel} />}
          {msg.showVoice && <VoiceTaskFlow onDone={(payload, blob) => onVoiceDone(payload, blob)} onCancel={onVoiceCancel} />}
          {msg.loading && <div className="bubble-loader"><div className="typing-dot" /><div className="typing-dot" /><div className="typing-dot" /></div>}
        </div>
        <span className="msg-time">{msg.time}</span>
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="message-row">
      <div className="msg-avatar ai"><img src="/chat.png" alt="TaskBot" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /></div>
      <div className="message-content">
        <div className="typing-bubble">
          <div className="typing-dot" /><div className="typing-dot" /><div className="typing-dot" />
        </div>
      </div>
    </div>
  )
}

/* ─── SIDEBAR NAV ITEMS ─────────────────────────────── */
const NAV_ITEMS = [
  { icon: '📋', label: 'All Tasks',     desc: 'View every assigned task',         action: 'allTasks' },
  { icon: '➕', label: 'Create Task',   desc: 'Add a new task to EspoCRM',         action: 'createTask' },
  { icon: '🎙', label: 'Voice Task',    desc: 'Record voice & AI extracts details', action: 'voiceTask' },
  { icon: '👤', label: 'Tasks by User', desc: 'Filter tasks by team member',        action: 'tasksByUser' },
]

const SUGGESTIONS = [
  { icon: '📋', title: 'View All Tasks',  desc: 'See every task with its assignee and status',                    action: 'allTasks' },
  { icon: '➕', title: 'Create a Task',   desc: 'Add a new task and assign it to a team member',                  action: 'createTask' },
  { icon: '🎙', title: 'Voice Task',      desc: 'Record your voice or upload audio — AI extracts all task details', action: 'voiceTask' },
  { icon: '👤', title: 'Tasks by User',   desc: 'Pick a team member and see all their tasks',                     action: 'tasksByUser' },
]

/* ─── SIDEBAR ───────────────────────────────────────── */
function Sidebar({ open, onClose, onAction, onNewChat }) {
  // Close sidebar on overlay click (mobile)
  return (
    <>
      {/* Overlay — mobile only */}
      {open && <div className="sidebar-overlay" onClick={onClose} />}

      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        {/* Logo / brand */}
        <div className="sidebar-logo">
          <div className="logo-icon">
            <img src="/chat.png" alt="TaskBot" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '10px' }} />
          </div>
          <div>
            <div className="logo-text">TaskBot AI</div>
            <div className="logo-sub">EspoCRM Assistant</div>
          </div>
          {/* Close button — visible on mobile */}
          <button className="sidebar-close-btn" onClick={onClose} aria-label="Close sidebar">✕</button>
        </div>

        {/* Nav actions */}
        <nav className="sidebar-nav">
          <div className="sidebar-nav-label">Quick Actions</div>
          {NAV_ITEMS.map(item => (
            <button
              key={item.action}
              className="sidebar-nav-item"
              onClick={() => { onAction(item.action); onClose() }}
            >
              <span className="sidebar-nav-icon">{item.icon}</span>
              <div className="sidebar-nav-text">
                <span className="sidebar-nav-title">{item.label}</span>
                <span className="sidebar-nav-desc">{item.desc}</span>
              </div>
            </button>
          ))}
        </nav>

        {/* Bottom — new chat */}
        <div className="sidebar-bottom">
          <button className="new-chat-btn" onClick={() => { onNewChat(); onClose() }}>
            <span>✨</span> New Chat
          </button>
        </div>
      </aside>
    </>
  )
}

/* ─── MAIN APP ─────────────────────────────────────── */
export default function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const messagesEndRef = useRef(null)
  const lastMsgRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    if (messages.length === 0) return
    // Scroll the newest message into view from its top, so filter bar is visible
    // For typing indicator keep scrolling to bottom so the dots stay in view
    if (isTyping) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    } else {
      lastMsgRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [messages, isTyping])

  const addMsg = useCallback((msg) => {
    const id = Date.now() + Math.random()
    setMessages(prev => [...prev, { id, time: getTime(), ...msg }])
    return id
  }, [])

  /* ── action handlers ── */
  const handleAllTasks = useCallback(async () => {
    addMsg({ role: 'user', content: 'Show me all tasks' })
    setIsTyping(true)
    try {
      const tasks = await fetchAllTasks()
      setIsTyping(false)
      addMsg({ role: 'ai', content: tasks.length > 0 ? `Here are all ${tasks.length} assigned tasks:` : null, tasks, allTasks: true })
    } catch (e) {
      setIsTyping(false)
      addMsg({ role: 'ai', content: `❌ Failed to fetch tasks: ${e.message}` })
    }
  }, [addMsg])

  const handleCreateTask = useCallback(() => {
    addMsg({ role: 'user', content: 'I want to create a new task' })
    addMsg({ role: 'ai', content: 'Sure! Fill in the details below:', showForm: true })
  }, [addMsg])

  const handleVoiceTask = useCallback(() => {
    addMsg({ role: 'user', content: '🎙 Create task from voice' })
    addMsg({ role: 'ai', content: "Great! Record your voice note or upload an audio file. I'll extract all the task details and confirm each one with you before saving.", showVoice: true })
  }, [addMsg])

  const handleVoiceDone = useCallback(async (formData, audioBlob) => {
    setMessages(prev => prev.map(m => m.showVoice ? { ...m, showVoice: false, content: 'Creating your task…' } : m))
    setIsTyping(true)
    try {
      const result = await postTask(formData)
      const taskId = result.data?.id

      let audioAttached = false
      if (taskId && audioBlob) {
        try {
          const fd = new FormData()
          // Always send as audio/mp3 — EspoCRM misclassifies audio/mpeg as video/mpeg
          const cleanBlob = new Blob([audioBlob], { type: 'audio/mp3' })
          fd.append('file', cleanBlob, 'voice-note.mp3')
          const attachRes = await fetch(`${API}/${taskId}/attachment`, { method: 'POST', body: fd })
          if (attachRes.ok) {
            audioAttached = true
          } else {
            const errBody = await attachRes.json().catch(() => ({}))
            console.warn('Attachment upload failed:', attachRes.status, errBody)
          }
        } catch (attachErr) {
          console.warn('Audio attachment upload failed (non-fatal):', attachErr.message)
        }
      }

      setIsTyping(false)
      addMsg({
        role: 'ai',
        content: `✅ Task "${formData.name}" has been created successfully in EspoCRM!${audioAttached ? '\n📎 Your voice recording (MP3) has been attached to the task.' : ''}\n\nAssigned team member(s) can now see this task in their dashboard.`,
      })
    } catch (e) {
      setIsTyping(false)
      addMsg({ role: 'ai', content: `❌ Failed to create task: ${e.message}` })
    }
  }, [addMsg])

  const handleVoiceCancel = useCallback(() => {
    setMessages(prev => prev.map(m => m.showVoice ? { ...m, showVoice: false, content: '🗑 Task cancelled — no task was saved.' } : m))
  }, [])

  const handleTasksByUser = useCallback(async () => {
    addMsg({ role: 'user', content: 'Show tasks by user' })
    setIsTyping(true)
    try {
      const tasks = await fetchAllTasks()
      // Build a deduplicated list of { id, name } objects from assignedUsersNames
      // Using a Map keyed by user ID guarantees uniqueness even if a name appears twice
      const userMap = new Map()
      tasks.forEach(t => {
        if (t.assignedUsersNames && typeof t.assignedUsersNames === 'object') {
          Object.entries(t.assignedUsersNames).forEach(([id, name]) => {
            if (id && name) userMap.set(id, name)
          })
        }
      })
      const users = [...userMap.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name))
      setIsTyping(false)
      if (users.length === 0) addMsg({ role: 'ai', content: 'No assigned users found in the task list.' })
      else addMsg({ role: 'ai', content: null, users })
    } catch (e) {
      setIsTyping(false)
      addMsg({ role: 'ai', content: `❌ Failed to fetch users: ${e.message}` })
    }
  }, [addMsg])

  const handleUserSelect = useCallback(async (user) => {
    addMsg({ role: 'user', content: `Show tasks for ${user.name}` })
    setIsTyping(true)
    try {
      const tasks = await fetchTasksByUser(user.id)
      setIsTyping(false)
      addMsg({
        role: 'ai',
        content: tasks.length > 0 ? `Here are ${tasks.length} task(s) assigned to ${user.name}:` : null,
        tasks,
      })
    } catch (e) {
      setIsTyping(false)
      addMsg({ role: 'ai', content: `❌ Could not fetch tasks: ${e.message}` })
    }
  }, [addMsg])

  const handleCreateSubmit = useCallback(async (formData) => {
    // Keep the form visible while the request is in flight so the user
    // doesn't lose their data if the POST fails. Only hide it on success.
    setIsTyping(true)
    try {
      await postTask(formData)
      // Success — now replace the form with the confirmation message
      setMessages(prev => prev.map(m => m.showForm ? { ...m, showForm: false, content: `✅ Task "${formData.name}" created successfully in EspoCRM!` } : m))
      setIsTyping(false)
    } catch (e) {
      setIsTyping(false)
      // Leave the form intact — only show the error inside the form via a new ai message
      addMsg({ role: 'ai', content: `❌ Failed to create task: ${e.message}` })
    }
  }, [addMsg])

  const handleCreateCancel = useCallback(() => {
    setMessages(prev => prev.map(m => m.showForm ? { ...m, showForm: false, content: 'Task creation cancelled.' } : m))
  }, [])

  const handleSend = useCallback((text) => {
    const content = (text || input).trim()
    if (!content) return
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    const lower = content.toLowerCase()
    if (lower.match(/\b(all|show|list|view)\b.*task/)) { handleAllTasks(); return }
    if (lower.match(/\b(voice|audio|record|speak)\b.*task/) || lower.match(/task.*\b(voice|audio|record)\b/)) { handleVoiceTask(); return }
    if (lower.match(/\b(create|add|new|make)\b.*task/)) { handleCreateTask(); return }
    if (lower.match(/task.*\b(by|per|for)\b.*user/) || lower.match(/\buser\b.*task/)) { handleTasksByUser(); return }
    addMsg({ role: 'user', content })
    setIsTyping(true)
    setTimeout(() => {
      setIsTyping(false)
      addMsg({ role: 'ai', content: "I can help you with:\n• 📋 View all tasks\n• ➕ Create a task\n• 🎙 Voice task (record or upload audio)\n• 👤 Tasks by user\n\nTap the menu icon or just ask!" })
    }, 600)
  }, [input, addMsg, handleAllTasks, handleCreateTask, handleVoiceTask, handleTasksByUser])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleTextareaChange = (e) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
  }

  const handleAction = (action) => {
    if (action === 'allTasks') handleAllTasks()
    else if (action === 'createTask') handleCreateTask()
    else if (action === 'voiceTask') handleVoiceTask()
    else if (action === 'tasksByUser') handleTasksByUser()
  }

  return (
    <div className="app">
      {/* ── Sidebar ── */}
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onAction={handleAction}
        onNewChat={() => setMessages([])}
      />

      {/* ── Chat area ── */}
      <main className="chat-area">
        {/* Header — always visible */}
        <header className="chat-header">
          <div className="chat-header-left">
            {/* Hamburger / toggle button */}
            <button
              className="hamburger-btn"
              onClick={() => setSidebarOpen(o => !o)}
              aria-label="Toggle sidebar"
            >
              <span className={`hamburger-icon ${sidebarOpen ? 'open' : ''}`}>
                <span /><span /><span />
              </span>
            </button>
            <div className="ai-avatar">
              <img src="/chat.png" alt="TaskBot" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
            </div>
            <div>
              <div className="chat-title">TaskBot AI</div>
              <div className="chat-subtitle">Online · Ready to assist</div>
            </div>
          </div>
          <div className="header-actions">
            <button className="refresh-btn" title="New Chat" onClick={() => setMessages([])}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                <path d="M21 3v5h-5"/>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                <path d="M8 16H3v5"/>
              </svg>
            </button>
          </div>
        </header>

        {/* Messages */}
        <div className="messages-container">
          {messages.length === 0 ? (
            <div className="welcome-screen">
              <div>
                <h1 className="welcome-title">Hi, I'm TaskBot AI</h1>
                <p className="welcome-subtitle">
                  Your AI-powered task management assistant connected to EspoCRM.
                  Create tasks, assign teams, and track progress — all with your voice.
                </p>
              </div>
              <div className="suggestions-grid">
                {SUGGESTIONS.map(s => (
                  <div key={s.title} className="suggestion-card" onClick={() => handleAction(s.action)}>
                    <span className="suggestion-icon">{s.icon}</span>
                    <div className="suggestion-title">{s.title}</div>
                    <div className="suggestion-desc">{s.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, idx) => (
                <div key={msg.id} ref={idx === messages.length - 1 ? lastMsgRef : null}>
                  <Message
                    msg={msg}
                    onUserSelect={handleUserSelect}
                    onCreateSubmit={handleCreateSubmit}
                    onCreateCancel={handleCreateCancel}
                    onVoiceDone={handleVoiceDone}
                    onVoiceCancel={handleVoiceCancel}
                  />
                </div>
              ))}
              {isTyping && <TypingIndicator />}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area — no quick-actions row */}
        <div className="input-area">
          <div className="input-box">
            <textarea
              ref={textareaRef}
              className="chat-input"
              placeholder="Ask me about tasks, or open the menu…"
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <div className="input-actions">
              <button className="voice-btn" title="Create task from voice" onClick={() => handleVoiceTask()}>🎙</button>
              <button className="send-btn" onClick={() => handleSend()} disabled={!input.trim() || isTyping}>➤</button>
            </div>
          </div>
          <div className="input-hint">Press Enter to send · Shift+Enter for new line · 🎙 for voice task</div>
        </div>
      </main>
    </div>
  )
}
