import { useState, useRef, useEffect } from 'react'
import lamejs from 'lamejs'

const OPENAI_KEY          = import.meta.env.VITE_CHATGPT_KEY
const USERS_API           = import.meta.env.VITE_USERS_API
const ACCOUNT_API         = import.meta.env.VITE_ACCOUNT_API
const CONTACT_API         = import.meta.env.VITE_CONTACT_API
const ACCOUNT_SEARCH_API  = import.meta.env.VITE_ACCOUNT_SEARCH_API
const CONTACT_SEARCH_API  = import.meta.env.VITE_CONTACT_SEARCH_API

/* ── helpers ── */
async function fetchUsers() {
  if (!USERS_API) throw new Error('VITE_USERS_API is not set in .env.local')
  const res = await fetch(USERS_API)
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  const json = await res.json()
  return json.data || []
}

async function fetchAccounts() {
  if (!ACCOUNT_API) return []
  const res = await fetch(ACCOUNT_API)
  if (!res.ok) return []
  const json = await res.json()
  return json.data || []
}

async function fetchContacts() {
  if (!CONTACT_API) return []
  const res = await fetch(CONTACT_API)
  if (!res.ok) return []
  const json = await res.json()
  // Each contact has { id, name, accountId, accountName }
  return json.data || []
}

// ── Search API helpers (Fuse.js server-side) ─────────────────────────────────
// Used after speech extraction for accurate name resolution, and in dropdowns.
async function searchAccountsAPI(query, limit = 5) {
  if (!ACCOUNT_SEARCH_API || !query?.trim()) return []
  try {
    const res = await fetch(`${ACCOUNT_SEARCH_API}?q=${encodeURIComponent(query.trim())}&limit=${limit}`)
    if (!res.ok) return []
    const json = await res.json()
    return json.data || []
  } catch { return [] }
}

async function searchContactsAPI(query, limit = 5) {
  if (!CONTACT_SEARCH_API || !query?.trim()) return []
  try {
    const res = await fetch(`${CONTACT_SEARCH_API}?q=${encodeURIComponent(query.trim())}&limit=${limit}`)
    if (!res.ok) return []
    const json = await res.json()
    return json.data || []
  } catch { return [] }
}

// POST a new account to the backend
async function apiCreateAccount(name) {
  const res = await fetch(ACCOUNT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.message || `Server error ${res.status}`)
  return json.data // { id, name }
}

// POST a new contact to the backend (optionally linked to an account)
async function apiCreateContact(name, accountId) {
  const res = await fetch(CONTACT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, accountId: accountId || undefined }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.message || `Server error ${res.status}`)
  return json.data // { id, name, accountId, accountName }
}

async function transcribeAudio(audioBlob) {
  if (!OPENAI_KEY) throw new Error('VITE_CHATGPT_KEY is not configured. Add it to your .env.local file.')
  const formData = new FormData()
  formData.append('file', audioBlob, 'recording.webm')
  formData.append('model', 'whisper-1')
  // Auto-detect language — Whisper handles Gujarati, Hindi, and English natively
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: formData,
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e?.error?.message || `Whisper error ${res.status}`)
  }
  const data = await res.json()
  return data.text || ''
}

/* ── Translate transcript into Gujarati, Hindi, and English ── */
async function translateTranscript(text) {
  if (!OPENAI_KEY) return { gujarati: text, hindi: text, english: text }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are a multilingual translator. Given a transcript (in any language), return ONLY a valid JSON object with three keys:
{
  "gujarati": "transcript in Gujarati script",
  "hindi": "transcript in Hindi (Devanagari script)",
  "english": "transcript in English"
}
Translate accurately. If the source is already one of these languages, keep it as-is for that language and translate for the others. Return ONLY the JSON, no markdown fences.`,
        },
        { role: 'user', content: `Transcript: "${text}"` },
      ],
    }),
  })
  if (!res.ok) return { gujarati: text, hindi: text, english: text }
  const data = await res.json()
  const raw = data.choices?.[0]?.message?.content || '{}'
  const parsed = safeParseJSON(raw)
  if (!parsed) return { gujarati: text, hindi: text, english: text }
  return {
    gujarati: parsed.gujarati || text,
    hindi: parsed.hindi || text,
    english: parsed.english || text,
  }
}

/* ── Fix #8: strip markdown code fences before parsing, with a safe fallback ── */
function safeParseJSON(raw) {
  // Strip ```json ... ``` or ``` ... ``` fences if present
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(stripped)
  } catch {
    // Try to extract the first {...} block from the response
    const match = stripped.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch { /* fall through */ }
    }
    return null
  }
}

/* ── Validate that the transcript has enough content to be a real task ── */
function validateTranscript(text) {
  if (!text || !text.trim()) {
    throw new Error('No speech detected in the recording. Please record again with a clear voice note describing the task.')
  }
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length < 3) {
    throw new Error(`The recording was too short or unclear ("${text.trim()}"). Please record a proper task description.`)
  }
  return text.trim()
}

/* ── Validate that extracted user IDs are present and all exist in the known users list ── */
function validateAssignedUsers(extracted, users) {
  const ids = extracted.assignedUsersIds || []

  // Reject if no user was mentioned in the audio at all
  if (ids.length === 0) {
    const teamNames = users.map(u => u.name).join(', ')
    throw new Error(`No team member was mentioned in the recording. Please re-record and include a valid assignee name.\n\nAvailable team members: ${teamNames}`)
  }

  // Reject if any of the returned IDs don't exist in the real users list
  const validIds = new Set(users.map(u => u.id))
  const invalid = ids.filter(id => !validIds.has(id))
  if (invalid.length > 0) {
    const names = extracted.assignedUsersNames || {}
    const invalidLabels = invalid.map(id => names[id] || id).join(', ')
    const teamNames = users.map(u => u.name).join(', ')
    throw new Error(`Assigned user(s) not found in your team: "${invalidLabels}". Please re-record and mention a valid team member name.\n\nAvailable team members: ${teamNames}`)
  }
}

async function extractTaskFields(transcript, users) {
  if (!OPENAI_KEY) throw new Error('VITE_CHATGPT_KEY is not configured. Add it to your .env.local file.')
  const userList = users.map(u => `• ${u.name} (id: ${u.id})`).join('\n')
  const systemPrompt = `You are an intelligent task extraction assistant for a project management tool.
Your job is to extract task details from a voice note transcript and rewrite the description in a rich, well-formatted, professional style using emojis, bullet points, and clear sections.

Available team members:
${userList}

Extract and return ONLY a valid JSON object with these fields:
{
  "name": "concise task title (required)",
  "assignedUsersIds": ["array of user IDs from the list — can be multiple, or empty array"],
  "assignedUsersNames": { "userId": "userName" },
  "priority": "Low | Normal | High | Urgent — infer from context, default Normal",
  "dateStartDate": "YYYY-MM-DD or null",
  "dateEndDate": "YYYY-MM-DD or null",
  "description": "See formatting rules below",
  "mentionedAccountName": "the company/account name mentioned in the transcript, or null if none",
  "mentionedContactName": "the person/contact name mentioned (other than assignees) in the transcript, or null if none"
}

Description formatting rules — make it easy to read and act on:
- Start with a one-line summary of the task goal using a relevant emoji (e.g. 🎯 or 🚀)
- Add a blank line, then use sections with emoji headers like:
  📋 **Objective:** ...
  ✅ **Key Requirements:**
  • requirement 1
  • requirement 2
  🔑 **Key Points / Notes:** (if applicable)
  • note 1
  ⚠️ **Important:** (only if there are deadlines, blockers, or critical info)
- Keep bullet points short and actionable
- End with a motivating one-liner if appropriate (e.g. "Let's make it happen! 💪")
- Use plain line breaks (\\n) for structure — no markdown headers like ## or **

Rules:
- Match assignee names loosely (e.g. "ali" → match closest user). Multiple names may be mentioned.
- Today is ${new Date().toISOString().split('T')[0]}; interpret relative date terms
- For mentionedAccountName: extract any company, firm, or organisation name from the transcript (e.g. "Vimko Textiles", "Reliance Industries")
- For mentionedContactName: extract the name of a person the task is about or directed to (not the assignee)
- Return ONLY the JSON object, no markdown code fences, no explanation`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Transcript: "${transcript}"` },
      ],
    }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e?.error?.message || `GPT error ${res.status}`)
  }
  const data = await res.json()
  const raw = data.choices?.[0]?.message?.content || '{}'
  const parsed = safeParseJSON(raw)
  if (!parsed) throw new Error('AI returned an unreadable response. Please try again.')
  return parsed
}

/* ── Smart fuzzy search — scored matching for best results ──────────────────
   Scoring (higher = better match):
     100  exact match (case-insensitive)
      80  starts with query
      60  every query word appears in name
      40  any query word appears in name  
      20  name word starts with any query word
   Returns results sorted by score descending, ties kept in original order.
─────────────────────────────────────────────────────────────────────────── */
function fuzzyMatch(query, list) {
  if (!query || !list?.length) return []
  const q = query.toLowerCase().trim()
  if (!q) return []

  const qWords = q.split(/\s+/).filter(Boolean)

  const scored = list.map(r => {
    const n = r.name.toLowerCase()
    const nWords = n.split(/\s+/).filter(Boolean)

    let score = 0
    if (n === q)                                            score = 100 // exact
    else if (n.startsWith(q))                               score = 80  // starts with full query
    else if (qWords.every(w => n.includes(w)))              score = 60  // all words present
    else if (qWords.some(w => n.includes(w)))               score = 40  // any word present
    else if (nWords.some(nw => qWords.some(qw => nw.startsWith(qw)))) score = 20 // word prefix
    else if (qWords.some(w => n.replace(/\s+/g, '').includes(w.replace(/\s+/g, '')))) score = 10 // collapsed

    return { r, score }
  }).filter(x => x.score > 0)

  scored.sort((a, b) => b.score - a.score)
  return scored.map(x => x.r)
}

/* ── Step labels ── */
// Base steps WITHOUT account/contact — those are inserted dynamically
// based on which was mentioned in speech (mentioned one comes first)
const STEPS_FIXED_START  = ['name', 'assignee']
const STEPS_FIXED_END    = ['priority', 'dateStartDate', 'dateEndDate', 'description']
const CONFIRM_STEPS_BASE = [...STEPS_FIXED_START, 'account', 'contact', ...STEPS_FIXED_END]

function fieldLabel(step) {
  if (step === 'name') return 'Task Name'
  if (step === 'assignee') return 'Assigned To'
  if (step === 'description') return 'Task Description'
  if (step === 'priority') return 'Priority'
  if (step === 'dateStartDate') return 'Start Date'
  if (step === 'dateEndDate') return 'Due Date'
  if (step === 'account') return 'Link Account (Company)'
  if (step === 'contact') return 'Link Contact (Person)'
  return step
}

function getAssigneeDisplay(editValues) {
  const names = Object.values(editValues.assignedUsersNames || {})
  return names.length > 0 ? names.join(', ') : 'Unassigned'
}

/* ── Convert any audio blob → MP3 blob using AudioContext + lamejs ── */
async function convertToMp3(blob) {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  const decoded = await audioCtx.decodeAudioData(arrayBuffer)
  await audioCtx.close()

  const numChannels = decoded.numberOfChannels
  const sampleRate = decoded.sampleRate
  const kbps = 128

  const mp3enc = new lamejs.Mp3Encoder(numChannels, sampleRate, kbps)
  const mp3Data = []

  const BLOCK = 1152 // samples per lamejs frame
  const left = decoded.getChannelData(0)
  const right = numChannels > 1 ? decoded.getChannelData(1) : left

  // lamejs expects Int16 PCM — convert Float32 → Int16
  const toInt16 = (f32) => {
    const i16 = new Int16Array(f32.length)
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]))
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return i16
  }

  const leftInt = toInt16(left)
  const rightInt = toInt16(right)

  for (let i = 0; i < leftInt.length; i += BLOCK) {
    const lChunk = leftInt.subarray(i, i + BLOCK)
    const rChunk = rightInt.subarray(i, i + BLOCK)
    const encoded = numChannels > 1
      ? mp3enc.encodeBuffer(lChunk, rChunk)
      : mp3enc.encodeBuffer(lChunk)
    if (encoded.length > 0) mp3Data.push(new Int8Array(encoded))
  }

  const flushed = mp3enc.flush()
  if (flushed.length > 0) mp3Data.push(new Int8Array(flushed))

  return new Blob(mp3Data, { type: 'audio/mp3' })
}

// Force any blob to have a clean audio/mp3 type — prevents browser from
// normalising 'audio/mp3' → 'audio/mpeg' which EspoCRM misclassifies as video/mpeg
function forceAudioMp3Blob(blob) {
  return new Blob([blob], { type: 'audio/mp3' })
}

/* ── Recording hook — records webm, converts to MP3 on stop ── */
function useRecorder(onError) {
  const [recording, setRecording] = useState(false)
  const [audioBlob, setAudioBlob] = useState(null)
  const [audioURL, setAudioURL] = useState(null)
  const [converting, setConverting] = useState(false)
  const mediaRef = useRef(null)
  const chunksRef = useRef([])

  const start = async () => {
    chunksRef.current = []
    setAudioBlob(null)
    setAudioURL(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm'
      const mr = new MediaRecorder(stream, { mimeType })
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const rawBlob = new Blob(chunksRef.current, { type: mimeType })
        setConverting(true)
        try {
          const mp3Blob = await convertToMp3(rawBlob)
          setAudioBlob(forceAudioMp3Blob(mp3Blob))
          setAudioURL(URL.createObjectURL(mp3Blob))
        } catch (convErr) {
          // Conversion failed — fall back to the original webm blob so recording still works
          console.warn('MP3 conversion failed, using original format:', convErr.message)
          setAudioBlob(rawBlob)
          setAudioURL(URL.createObjectURL(rawBlob))
        } finally {
          setConverting(false)
        }
      }
      mr.start()
      mediaRef.current = mr
      setRecording(true)
    } catch (err) {
      const msg = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
        ? 'Microphone access was denied. Please allow microphone permission and try again.'
        : err.name === 'NotFoundError'
        ? 'No microphone found. Please connect a microphone and try again.'
        : `Could not start recording: ${err.message}`
      onError(msg)
    }
  }

  const stop = () => { mediaRef.current?.stop(); setRecording(false) }

  return { recording, audioBlob, audioURL, converting, start, stop }
}

/* ── AccountStep — search existing or create new; auto-fills contact's account ── */
function AccountStep({ editValues, setEditValues, accounts, setAccounts, contacts, accountSearch, setAccountSearch, setContactSearch, onConfirm, onSkip }) {
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [open, setOpen] = useState(true) // open by default when step is shown
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const wrapRef = useRef(null)
  const debounceRef = useRef(null)

  const lockedByContact = !!(editValues.contactId && editValues.accountId)
  const candidates = editValues.accountCandidates || []
  const inCandidateMode = candidates.length > 1 && !editValues.accountId

  // Debounced API search — falls back to local list when query is empty
  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (!accountSearch.trim()) {
      setSearchResults(accounts.slice(0, 5))
      setSearching(false)
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      const results = await searchAccountsAPI(accountSearch, 6)
      setSearchResults(results.length > 0 ? results : fuzzyMatch(accountSearch, accounts).slice(0, 6))
      setSearching(false)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [accountSearch, accounts])

  // Initialise results when step mounts
  useEffect(() => {
    setSearchResults(accounts.slice(0, 5))
  }, [])

  const results = searchResults
  const exactExists = accounts.some(a => a.name.toLowerCase() === accountSearch.trim().toLowerCase())
  const showCreate  = accountSearch.trim().length > 1 && !exactExists && !editValues.accountId && !inCandidateMode

  const selectAccount = (a) => {
    setEditValues(v => ({ ...v, accountId: a.id, accountName: a.name, accountCandidates: [] }))
    setAccountSearch(a.name)
    setOpen(false)
  }

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleCreate = async () => {
    setCreating(true); setCreateError('')
    try {
      const newAcc = await apiCreateAccount(accountSearch.trim())
      setAccounts(prev => [...prev, newAcc])
      selectAccount(newAcc)
    } catch (e) { setCreateError(e.message) }
    finally { setCreating(false) }
  }

  return (
    <div className="vf-edit-area">
      {lockedByContact && (
        <div className="vf-info-note">🔗 Auto-filled from contact — <strong>{editValues.contactName}</strong></div>
      )}

      {editValues.accountId ? (
        <div className="vf-selected-badge">
          <span>🏢</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>{editValues.accountName}</div>
          </div>
          {!lockedByContact && (
            <button className="vf-clear-btn" onClick={() => {
              setEditValues(v => ({ ...v, accountId: '', accountName: '' }))
              setAccountSearch(''); setOpen(true)
            }}>✕</button>
          )}
        </div>
      ) : inCandidateMode ? (
        <>
          <div className="vf-candidates-label">
            🤔 Multiple accounts match <strong>"{editValues.mentionedAccountName}"</strong> — pick one:
          </div>
          <div className="vf-candidates-list">
            {candidates.map(a => (
              <button key={a.id} className="vf-candidate-btn" onClick={() => selectAccount(a)}>
                🏢 {a.name}
              </button>
            ))}
          </div>
          <button className="vf-search-instead-btn" onClick={() =>
            setEditValues(v => ({ ...v, accountCandidates: [] }))
          }>🔍 Search instead</button>
        </>
      ) : (
        <div className="vf-cf-wrap" ref={wrapRef}>
          <div className="vf-cf-input-row">
            <input
              className="vf-input"
              placeholder="Search company name…"
              value={accountSearch}
              onFocus={() => setOpen(true)}
              onChange={e => { setAccountSearch(e.target.value); setCreateError(''); setOpen(true) }}
            />
            {searching && <span className="vf-cf-searching">🔍</span>}
            {accountSearch && !searching && (
              <button className="vf-cf-input-clear" type="button"
                onClick={() => { setAccountSearch(''); setCreateError('') }}>✕</button>
            )}
          </div>
          {open && (
            <div className="vf-cf-dropdown">
              {results.length > 0 ? (
                <>
                  <div className="vf-cf-dropdown-hint">
                    {accountSearch.trim() ? 'Matching accounts' : 'Accounts — tap to select'}
                  </div>
                  {results.map(a => (
                    <div key={a.id} className="vf-cf-dropdown-item"
                      onMouseDown={() => selectAccount(a)}>
                      <span className="vf-cf-item-icon">🏢</span>
                      <span className="vf-cf-item-name">{a.name}</span>
                    </div>
                  ))}
                </>
              ) : (
                <div className="vf-cf-dropdown-empty">
                  {searching ? 'Searching…' : 'No accounts found'}
                </div>
              )}
              {showCreate && (
                <div className="vf-cf-dropdown-create" onMouseDown={handleCreate}>
                  {creating ? '⏳ Creating…' : <><span>➕</span> Create <strong>"{accountSearch.trim()}"</strong></>}
                </div>
              )}
            </div>
          )}
          {createError && <div className="vf-error" style={{ marginTop: 6 }}>⚠️ {createError}</div>}
        </div>
      )}

      <div className="vf-action-row">
        <button className="vf-btn-yes" onClick={onConfirm} disabled={!editValues.accountId}>✅ Confirm</button>
        <button className="vf-btn-skip" onClick={onSkip}>⏭ Skip</button>
      </div>
    </div>
  )
}

/* ── ContactStep — search existing or create new; auto-fills account ── */
function ContactStep({ editValues, setEditValues, contacts, setContacts, accounts, contactSearch, setContactSearch, setAccountSearch, onConfirm, onSkip }) {
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [open, setOpen] = useState(true)
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const wrapRef = useRef(null)
  const debounceRef = useRef(null)

  const candidates = editValues.contactCandidates || []
  const inCandidateMode = candidates.length > 1 && !editValues.contactId

  const filteredContacts = editValues.accountId
    ? contacts.filter(c => c.accountId === editValues.accountId)
    : contacts

  // Debounced API search — respects accountId filter when set
  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (!contactSearch.trim()) {
      setSearchResults(filteredContacts.slice(0, 5))
      setSearching(false)
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      const results = await searchContactsAPI(contactSearch, 6)
      // If an account is selected, keep only contacts belonging to it
      const filtered = editValues.accountId
        ? results.filter(c => c.accountId === editValues.accountId)
        : results
      setSearchResults(
        filtered.length > 0 ? filtered : fuzzyMatch(contactSearch, filteredContacts).slice(0, 6)
      )
      setSearching(false)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [contactSearch, contacts, editValues.accountId])

  // Initialise results when step mounts
  useEffect(() => {
    setSearchResults(filteredContacts.slice(0, 5))
  }, [editValues.accountId])

  const results = searchResults
  const exactExists = contacts.some(c => c.name.toLowerCase() === contactSearch.trim().toLowerCase())
  const showCreate  = contactSearch.trim().length > 1 && !exactExists && !editValues.contactId && !inCandidateMode

  const selectContact = (c) => {
    setEditValues(v => {
      const updated = { ...v, contactId: c.id, contactName: c.name, contactCandidates: [] }
      if (c.accountId && !v.accountId) {
        updated.accountId   = c.accountId
        updated.accountName = c.accountName || ''
        setAccountSearch(c.accountName || '')
      }
      return updated
    })
    setContactSearch(c.name)
    setOpen(false)
  }

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleCreate = async () => {
    setCreating(true); setCreateError('')
    try {
      const newContact = await apiCreateContact(contactSearch.trim(), editValues.accountId || undefined)
      setContacts(prev => [...prev, newContact])
      selectContact(newContact)
    } catch (e) { setCreateError(e.message) }
    finally { setCreating(false) }
  }

  return (
    <div className="vf-edit-area">
      {editValues.accountId && !inCandidateMode && (
        <div className="vf-info-note">
          🔍 Contacts in <strong>{editValues.accountName}</strong>
          {filteredContacts.length === 0 && ' — none yet'}
        </div>
      )}

      {editValues.contactId ? (
        <>
          <div className="vf-selected-badge">
            <span>👤</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{editValues.contactName}</div>
              {editValues.accountName && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>🏢 {editValues.accountName}</div>
              )}
            </div>
            <button className="vf-clear-btn" onClick={() => {
              setEditValues(v => ({ ...v, contactId: '', contactName: '' }))
              setContactSearch(''); setOpen(true)
            }}>✕</button>
          </div>
          {editValues.accountId && (
            <div className="vf-auto-filled">🏢 Account linked: <strong>{editValues.accountName}</strong></div>
          )}
        </>
      ) : inCandidateMode ? (
        <>
          <div className="vf-candidates-label">
            🤔 Multiple contacts match <strong>"{editValues.mentionedContactName}"</strong> — pick one:
          </div>
          <div className="vf-candidates-list">
            {candidates.map(c => (
              <button key={c.id} className="vf-candidate-btn" onClick={() => selectContact(c)}>
                <span>👤 {c.name}</span>
                {c.accountName && <span className="vf-candidate-sub">🏢 {c.accountName}</span>}
              </button>
            ))}
          </div>
          <button className="vf-search-instead-btn" onClick={() =>
            setEditValues(v => ({ ...v, contactCandidates: [] }))
          }>🔍 Search instead</button>
        </>
      ) : (
        <div className="vf-cf-wrap" ref={wrapRef}>
          <div className="vf-cf-input-row">
            <input
              className="vf-input"
              placeholder={editValues.accountId ? `Search in ${editValues.accountName}…` : 'Search contact name…'}
              value={contactSearch}
              onFocus={() => setOpen(true)}
              onChange={e => { setContactSearch(e.target.value); setCreateError(''); setOpen(true) }}
            />
            {searching && <span className="vf-cf-searching">🔍</span>}
            {contactSearch && !searching && (
              <button className="vf-cf-input-clear" type="button"
                onClick={() => { setContactSearch(''); setCreateError('') }}>✕</button>
            )}
          </div>
          {open && (
            <div className="vf-cf-dropdown">
              {results.length > 0 ? (
                <>
                  <div className="vf-cf-dropdown-hint">
                    {contactSearch.trim()
                      ? 'Matching contacts'
                      : editValues.accountId ? `Contacts in ${editValues.accountName}` : 'Contacts — tap to select'}
                  </div>
                  {results.map(c => (
                    <div key={c.id} className="vf-cf-dropdown-item"
                      onMouseDown={() => selectContact(c)}>
                      <span className="vf-cf-item-icon">👤</span>
                      <div className="vf-cf-item-info">
                        <span className="vf-cf-item-name">{c.name}</span>
                        {c.accountName && <span className="vf-cf-item-sub">🏢 {c.accountName}</span>}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="vf-cf-dropdown-empty">
                  {searching ? 'Searching…' : (editValues.accountId ? `No contacts in ${editValues.accountName}` : 'No contacts found')}
                </div>
              )}
              {showCreate && (
                <div className="vf-cf-dropdown-create" onMouseDown={handleCreate}>
                  {creating ? '⏳ Creating…' : (
                    <>
                      <span>➕</span> Create <strong>"{contactSearch.trim()}"</strong>
                      {editValues.accountId && <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}> under {editValues.accountName}</span>}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {createError && <div className="vf-error" style={{ marginTop: 6 }}>⚠️ {createError}</div>}
        </div>
      )}

      <div className="vf-action-row">
        <button className="vf-btn-yes" onClick={onConfirm} disabled={!editValues.contactId}>✅ Confirm</button>
        <button className="vf-btn-skip" onClick={onSkip}>⏭ Skip</button>
      </div>
    </div>
  )
}

/* ── Main VoiceTaskFlow component ── */
export default function VoiceTaskFlow({ onDone, onCancel }) {
  const [phase, setPhase] = useState('record')
  const [error, setError] = useState('')
  const [users, setUsers] = useState([])
  const [accounts, setAccounts] = useState([])
  const [contacts, setContacts] = useState([])
  const accountsRef = useRef([])
  const contactsRef = useRef([])
  const [usersLoading, setUsersLoading] = useState(true)
  // confirmSteps is dynamic — account/contact steps are removed when auto-resolved
  const [confirmSteps, setConfirmSteps] = useState(CONFIRM_STEPS_BASE)
  const [confirmStep, setConfirmStep] = useState(0)
  const [editValues, setEditValues] = useState({})
  const [transcript, setTranscript] = useState('')
  // Multilingual transcript: { gujarati, hindi, english }
  const [transcriptLangs, setTranscriptLangs] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [editInput, setEditInput] = useState('')
  // account/contact dropdown search
  const [accountSearch, setAccountSearch] = useState('')
  const [contactSearch, setContactSearch] = useState('')
  // Fix #2: track audio presence in state so JSX reads state, not ref directly
  const [hasAudio, setHasAudio] = useState(false)
  const audioBlobRef = useRef(null)
  const fileInputRef = useRef(null)
  const prevBlobRef = useRef(null)
  const { recording, audioBlob, audioURL, converting, start, stop } = useRecorder(setError)

  useEffect(() => {
    fetchUsers()
      .then(d => { setUsers(d); setUsersLoading(false) })
      .catch(err => { setError(`Failed to load users: ${err.message}`); setUsersLoading(false) })
    // Load accounts and contacts in background — non-blocking
    fetchAccounts().then(d => { setAccounts(d); accountsRef.current = d }).catch(() => {})
    fetchContacts().then(d => { setContacts(d); contactsRef.current = d }).catch(() => {})
  }, [])

  const processAudio = async (blob, currentUsers) => {
    audioBlobRef.current = blob
    setHasAudio(true)
    setPhase('processing')
    setError('')
    try {
      const rawText = await transcribeAudio(blob)
      // Reject blank / too-short / gibberish audio before calling GPT
      const text = validateTranscript(rawText)
      setTranscript(text)

      // Translate into Gujarati, Hindi, English in parallel with task extraction
      const [langs, extracted] = await Promise.all([
        translateTranscript(text),
        extractTaskFields(text, currentUsers),
      ])
      setTranscriptLangs(langs)

      // Reject if GPT assigned users that don't exist in the team
      validateAssignedUsers(extracted, currentUsers)

      // Pre-match account and contact from extracted names
      const mentionedAccount = extracted.mentionedAccountName || ''
      const mentionedContact = extracted.mentionedContactName || ''

      // Use refs to get fresh accounts/contacts (avoids stale closure)
      const currentAccounts = accountsRef.current
      const currentContacts = contactsRef.current

      // ── Resolve via server-side Fuse.js search (more accurate than client fuzzy) ──
      // 0 matches  → null + empty candidates → step shown (search/create)
      // 1 match    → auto-selected           → step skipped
      // 2+ matches → candidates stored       → step shown as choice list
      let preAccount = null, preAccountCandidates = []
      if (mentionedAccount) {
        const results = await searchAccountsAPI(mentionedAccount, 5)
        if (results.length === 1)     preAccount = results[0]
        else if (results.length > 1)  preAccountCandidates = results
      }

      let preContact = null, preContactCandidates = []
      if (mentionedContact) {
        const results = await searchContactsAPI(mentionedContact, 5)
        if (results.length === 1)     preContact = results[0]
        else if (results.length > 1)  preContactCandidates = results
      }

      // ── Cross-link: auto-fill the other side ──────────────────────────
      // Contact resolved → pull its account
      if (preContact && !preAccount) {
        if (preContact.accountId) {
          const acc = currentAccounts.find(a => a.id === preContact.accountId)
          if (acc) preAccount = acc
        }
      }
      // Account resolved, no contact mentioned → check if only one contact belongs to it
      if (preAccount && !preContact && !mentionedContact) {
        const acctContacts = currentContacts.filter(c => c.accountId === preAccount.id)
        if (acctContacts.length === 1)       preContact = acctContacts[0]
        else if (acctContacts.length > 1)    preContactCandidates = acctContacts
      }

      // ── Build dynamic step list ───────────────────────────────────────
      // • Skip a step if already auto-resolved
      // • Keep candidate steps (need user to pick) 
      // • Order: whichever was spoken comes FIRST; if neither spoken, account before contact
      const needsAccountStep  = !preAccount  // must show step (0 matches or 2+ candidates)
      const needsContactStep  = !preContact

      // Determine order based on what was spoken
      let acctContactOrder
      if (mentionedAccount && !mentionedContact)       acctContactOrder = ['account', 'contact']
      else if (mentionedContact && !mentionedAccount)  acctContactOrder = ['contact', 'account']
      else                                              acctContactOrder = ['account', 'contact'] // both or neither

      const dynamicMiddle = acctContactOrder.filter(s =>
        s === 'account' ? needsAccountStep : needsContactStep
      )

      const steps = [...STEPS_FIXED_START, ...dynamicMiddle, ...STEPS_FIXED_END]

      setEditValues({
        name: extracted.name || '',
        assignedUsersIds:  extracted.assignedUsersIds  || [],
        assignedUsersNames: extracted.assignedUsersNames || {},
        description:  extracted.description  || '',
        priority:     extracted.priority     || 'Normal',
        dateStartDate: extracted.dateStartDate || '',
        dateEndDate:   extracted.dateEndDate   || '',
        cMessage: langs.english || text,
        // Account
        accountId:            preAccount?.id   || '',
        accountName:          preAccount?.name || '',
        mentionedAccountName: mentionedAccount,
        accountCandidates:    preAccountCandidates,
        // Contact
        contactId:            preContact?.id   || '',
        contactName:          preContact?.name || '',
        mentionedContactName: mentionedContact,
        contactCandidates:    preContactCandidates,
      })
      setAccountSearch(preAccount?.name || mentionedAccount || '')
      setContactSearch(preContact?.name || mentionedContact || '')
      setConfirmSteps(steps)
      setConfirmStep(0)
      setPhase('confirm')
    } catch (e) {
      setError(e.message)
      setPhase('record')
    }
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    // If user uploads a non-mp3, convert it first
    if (file.type !== 'audio/mp3' && file.type !== 'audio/mpeg') {
      try {
        const mp3Blob = await convertToMp3(file)
        processAudio(forceAudioMp3Blob(mp3Blob), users)
      } catch {
        // Conversion failed — send original, backend will still store it
        processAudio(file, users)
      }
    } else {
      processAudio(file, users)
    }
  }

  // Fix #5: include users in dependency array so this never runs with a stale users list
  useEffect(() => {
    if (audioBlob && audioBlob !== prevBlobRef.current && !usersLoading) {
      prevBlobRef.current = audioBlob
      processAudio(audioBlob, users)
    }
  }, [audioBlob, users, usersLoading])

  /* Toggle a user in/out of assigned lists */
  const toggleAssignee = (userId, userName) => {
    setEditValues(v => {
      const ids = v.assignedUsersIds || []
      const names = { ...(v.assignedUsersNames || {}) }
      if (ids.includes(userId)) {
        delete names[userId]
        return { ...v, assignedUsersIds: ids.filter(i => i !== userId), assignedUsersNames: names }
      } else {
        names[userId] = userName
        return { ...v, assignedUsersIds: [...ids, userId], assignedUsersNames: names }
      }
    })
  }

  const handleConfirmYes = () => {
    setEditMode(false)
    if (confirmStep < confirmSteps.length - 1) setConfirmStep(s => s + 1)
    else setPhase('preview')
  }

  // Skip optional steps (account / contact)
  const handleSkipStep = () => {
    setEditMode(false)
    const step = confirmSteps[confirmStep]
    if (step === 'account') {
      setEditValues(v => ({ ...v, accountId: '', accountName: '' }))
      setAccountSearch('')
    } else if (step === 'contact') {
      setEditValues(v => ({ ...v, contactId: '', contactName: '' }))
      setContactSearch('')
    }
    if (confirmStep < confirmSteps.length - 1) setConfirmStep(s => s + 1)
    else setPhase('preview')
  }

  const handleConfirmEdit = () => {
    const step = confirmSteps[confirmStep]
    if (step !== 'assignee') setEditInput(editValues[step] || '')
    setEditMode(true)
  }

  const handleEditSave = () => {
    const step = confirmSteps[confirmStep]
    if (step !== 'assignee') setEditValues(v => ({ ...v, [step]: editInput }))
    setEditMode(false)
    if (confirmStep < confirmSteps.length - 1) setConfirmStep(s => s + 1)
    else setPhase('preview')
  }

  // Fix #6: validate task name before submitting
  const handlePreviewYes = () => {
    if (!editValues.name?.trim()) {
      setError('Task name is required. Please go back and set a name.')
      setConfirmStep(0)
      setPhase('confirm')
      return
    }
    setPhase('saving')
    const payload = {
      name: editValues.name.trim(),
      assignedUsersIds: editValues.assignedUsersIds?.length > 0 ? editValues.assignedUsersIds : undefined,
      assignedUsersNames: Object.keys(editValues.assignedUsersNames || {}).length > 0
        ? editValues.assignedUsersNames : undefined,
      description: editValues.description || undefined,
      priority: editValues.priority || 'Normal',
      dateStartDate: editValues.dateStartDate || undefined,
      dateEndDate: editValues.dateEndDate || undefined,
      cMessage: editValues.cMessage || undefined,
      // Contact takes priority — backend resolves parentType=Contact (gives both account+contact)
      // If only account selected — backend resolves parentType=Account
      contactId: editValues.contactId || undefined,
      accountId: editValues.accountId || undefined,
    }
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k])
    onDone(payload, audioBlobRef.current)
  }

  /* ── Render: processing / saving ── */
  if (phase === 'processing') {
    return (
      <div className="vf-container">
        <div className="vf-processing">
          <div className="vf-spinner" />
          <div className="vf-processing-text">
            <strong>Analysing your voice note…</strong>
            <span>Transcribing audio and extracting task details with AI</span>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'saving') {
    return (
      <div className="vf-container">
        <div className="vf-processing">
          <div className="vf-spinner" />
          <div className="vf-processing-text">
            <strong>Saving task to EspoCRM…</strong>
            <span>Also uploading your voice recording as an attachment</span>
          </div>
        </div>
      </div>
    )
  }

  /* ── Render: confirm step-by-step ── */
  if (phase === 'confirm') {
    const step = confirmSteps[confirmStep]
    const label = fieldLabel(step)
    const isOptional = step === 'account' || step === 'contact'

    // Compute display value for non-edit mode
    let displayValue
    if (step === 'assignee') displayValue = getAssigneeDisplay(editValues)
    else if (step === 'priority') displayValue = editValues.priority || 'Normal'
    else if (step === 'dateStartDate') displayValue = editValues.dateStartDate || '(not set)'
    else if (step === 'dateEndDate') displayValue = editValues.dateEndDate || '(not set)'
    else if (step === 'account') displayValue = editValues.accountName || '(none)'
    else if (step === 'contact') displayValue = editValues.contactName || '(none)'
    else displayValue = editValues[step] || '(not set)'

    return (
      <div className="vf-container">
        <div className="vf-confirm-header">
          <span className="vf-step-badge">{confirmStep + 1}/{confirmSteps.length}</span>
          <span className="vf-step-title">Confirm Task Details</span>
          {isOptional && <span className="vf-optional-badge">Optional</span>}
        </div>

        {(transcript || transcriptLangs) && (
          <div className="vf-transcript">
            <span className="vf-transcript-label">🎤 Transcript</span>
            {transcriptLangs ? (
              <div className="vf-transcript-langs">
                <div className="vf-transcript-lang-row">
                  <span className="vf-lang-badge">🇮🇳 ગુજરાતી</span>
                  <span className="vf-transcript-text">"{transcriptLangs.gujarati}"</span>
                </div>
                <div className="vf-transcript-lang-row">
                  <span className="vf-lang-badge">🇮🇳 हिन्दी</span>
                  <span className="vf-transcript-text">"{transcriptLangs.hindi}"</span>
                </div>
                <div className="vf-transcript-lang-row">
                  <span className="vf-lang-badge">🇬🇧 English</span>
                  <span className="vf-transcript-text">"{transcriptLangs.english}"</span>
                </div>
              </div>
            ) : (
              <span className="vf-transcript-text">"{transcript}"</span>
            )}
          </div>
        )}

        {error && <div className="vf-error">⚠️ {error}</div>}

        <div className="vf-field-card">
          <div className="vf-field-label">{label}</div>

          {/* ── Account step ── */}
          {step === 'account' ? (
            <AccountStep
              editValues={editValues}
              setEditValues={setEditValues}
              accounts={accounts}
              setAccounts={setAccounts}
              contacts={contacts}
              accountSearch={accountSearch}
              setAccountSearch={setAccountSearch}
              setContactSearch={setContactSearch}
              onConfirm={handleConfirmYes}
              onSkip={handleSkipStep}
            />
          ) : step === 'contact' ? (
            /* ── Contact step ── */
            <ContactStep
              editValues={editValues}
              setEditValues={setEditValues}
              contacts={contacts}
              setContacts={setContacts}
              accounts={accounts}
              contactSearch={contactSearch}
              setContactSearch={setContactSearch}
              setAccountSearch={setAccountSearch}
              onConfirm={handleConfirmYes}
              onSkip={handleSkipStep}
            />
          ) : editMode ? (
            /* ── Regular edit modes ── */
            step === 'assignee' ? (
              <div className="vf-edit-area">
                <div className="vf-user-checklist">
                  {users.map(u => (
                    <label key={u.id} className="vf-user-check-row">
                      <input
                        type="checkbox"
                        checked={(editValues.assignedUsersIds || []).includes(u.id)}
                        onChange={() => toggleAssignee(u.id, u.name)}
                      />
                      <span>{u.name}</span>
                    </label>
                  ))}
                </div>
                <button className="vf-btn-save" onClick={handleEditSave}>✓ Save &amp; Continue</button>
              </div>
            ) : step === 'priority' ? (
              <div className="vf-edit-area">
                <select className="vf-input" value={editInput} onChange={e => setEditInput(e.target.value)}>
                  {['Low', 'Normal', 'High', 'Urgent'].map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <button className="vf-btn-save" onClick={handleEditSave}>✓ Save &amp; Continue</button>
              </div>
            ) : step === 'dateStartDate' || step === 'dateEndDate' ? (
              <div className="vf-edit-area">
                <input className="vf-input" type="date" value={editInput}
                  onChange={e => setEditInput(e.target.value)} />
                <button className="vf-btn-save" onClick={handleEditSave}>✓ Save &amp; Continue</button>
              </div>
            ) : step === 'description' ? (
              <div className="vf-edit-area">
                <textarea className="vf-input vf-textarea" rows={5}
                  value={editInput} onChange={e => setEditInput(e.target.value)} />
                <button className="vf-btn-save" onClick={handleEditSave}>✓ Save &amp; Continue</button>
              </div>
            ) : (
              <div className="vf-edit-area">
                <input className="vf-input" value={editInput}
                  onChange={e => setEditInput(e.target.value)} />
                <button className="vf-btn-save" onClick={handleEditSave}>✓ Save &amp; Continue</button>
              </div>
            )
          ) : (
            <div className="vf-field-value" style={{ whiteSpace: 'pre-wrap' }}>{displayValue || <em className="vf-empty">Not set</em>}</div>
          )}
        </div>

        {/* Regular confirm buttons — not shown for account/contact (they have inline buttons) */}
        {!editMode && step !== 'account' && step !== 'contact' && (
          <div className="vf-confirm-actions">
            <div className="vf-confirm-question">Is this correct?</div>
            <div className="vf-confirm-btns">
              <button className="vf-btn-yes" onClick={handleConfirmYes}>✅ Yes, looks good</button>
              <button className="vf-btn-edit" onClick={handleConfirmEdit}>✏️ No, change it</button>
            </div>
          </div>
        )}
      </div>
    )
  }

  /* ── Render: preview ── */
  if (phase === 'preview') {
    return (
      <div className="vf-container">
        <div className="vf-preview-header">
          <span className="vf-preview-icon">📋</span>
          <div>
            <div className="vf-preview-title">Task Preview</div>
            <div className="vf-preview-sub">Please review before saving</div>
          </div>
        </div>

        <div className="vf-preview-card">
          <div className="vf-preview-row">
            <span className="vf-preview-key">📌 Task Name</span>
            <span className="vf-preview-val">{editValues.name}</span>
          </div>
          <div className="vf-preview-row">
            <span className="vf-preview-key">👤 Assigned To</span>
            <span className="vf-preview-val">{getAssigneeDisplay(editValues)}</span>
          </div>
          <div className="vf-preview-row">
            <span className="vf-preview-key">🔥 Priority</span>
            <span className={`vf-priority vf-priority-${(editValues.priority||'normal').toLowerCase()}`}>
              {editValues.priority || 'Normal'}
            </span>
          </div>
          {editValues.dateStartDate && (
            <div className="vf-preview-row">
              <span className="vf-preview-key">📅 Start Date</span>
              <span className="vf-preview-val">{editValues.dateStartDate}</span>
            </div>
          )}
          {editValues.dateEndDate && (
            <div className="vf-preview-row">
              <span className="vf-preview-key">🗓 Due Date</span>
              <span className="vf-preview-val">{editValues.dateEndDate}</span>
            </div>
          )}
          {editValues.accountName && (
            <div className="vf-preview-row">
              <span className="vf-preview-key">🏢 Account</span>
              <span className="vf-preview-val">{editValues.accountName}</span>
            </div>
          )}
          {editValues.contactName && (
            <div className="vf-preview-row">
              <span className="vf-preview-key">👤 Contact</span>
              <span className="vf-preview-val">{editValues.contactName}</span>
            </div>
          )}
          {editValues.description && (
            <div className="vf-preview-desc">
              <div className="vf-preview-key">📝 Description</div>
              <div className="vf-preview-desc-text" style={{ whiteSpace: 'pre-wrap' }}>{editValues.description}</div>
            </div>
          )}
          {/* Fix #2: use hasAudio state instead of audioBlobRef.current in render */}
          {hasAudio && (
            <div className="vf-preview-row">
              <span className="vf-preview-key">📎 Voice Recording</span>
              <span className="vf-preview-val" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                Will be attached to the task
              </span>
            </div>
          )}
        </div>

        <div className="vf-preview-question">Ready to save this task?</div>
        <div className="vf-confirm-btns">
          <button className="vf-btn-yes" onClick={handlePreviewYes}>✅ Yes, Save Task</button>
          <button className="vf-btn-edit" onClick={() => { setConfirmStep(0); setPhase('confirm') }}>✏️ Update</button>
          <button className="vf-btn-no" onClick={() => onCancel()}>🗑 No, Cancel</button>
        </div>
      </div>
    )
  }

  /* ── Render: record phase ── */
  return (
    <div className="vf-container">
      <div className="vf-record-header">
        <span className="vf-record-icon">🎤</span>
        <div>
          <div className="vf-record-title">Voice Task Creator</div>
          <div className="vf-record-sub">
            Record your voice or upload an audio file — AI extracts the task details and attaches the audio
          </div>
        </div>
      </div>

      {error && <div className="vf-error">⚠️ {error}</div>}

      {usersLoading && (
        <div className="vf-error" style={{ background: 'rgba(255,255,255,0.05)', borderColor: 'var(--border)' }}>
          ⏳ Loading team members… Voice recording will start processing once they are ready.
        </div>
      )}

      <div className="vf-record-area">
        <button
          className={`vf-record-btn ${recording ? 'recording' : ''}`}
          onClick={recording ? stop : start}
          disabled={usersLoading || converting}
        >
          {recording ? (
            <><span className="vf-rec-dot" /><span>Stop Recording</span></>
          ) : converting ? (
            <><span className="vf-rec-dot" style={{ animationDuration: '0.6s' }} /><span>Converting to MP3…</span></>
          ) : (
            <><span>🎤</span><span>{usersLoading ? 'Loading…' : 'Start Recording'}</span></>
          )}
        </button>

        {audioURL && !recording && (
          <div className="vf-audio-preview">
            <span className="vf-audio-label">Preview recording:</span>
            <audio controls src={audioURL} className="vf-audio-player" />
          </div>
        )}

        <div className="vf-divider"><span>or</span></div>

        <button className="vf-upload-btn" onClick={() => fileInputRef.current?.click()} disabled={usersLoading || converting}>
          📁 {usersLoading ? 'Loading…' : 'Upload Audio File'}
        </button>
        <input ref={fileInputRef} type="file" accept="audio/*"
          style={{ display: 'none' }} onChange={handleFileUpload} />
        <div className="vf-upload-hint">Supports MP3, WAV, M4A, WebM, OGG — audio saved as task attachment</div>
      </div>

      <button className="vf-cancel-btn" onClick={onCancel}>Cancel</button>
    </div>
  )
}
