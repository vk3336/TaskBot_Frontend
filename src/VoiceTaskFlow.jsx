import { useState, useRef, useEffect } from 'react'
import lamejs from 'lamejs'

const OPENAI_KEY = import.meta.env.VITE_CHATGPT_KEY
const USERS_API = import.meta.env.VITE_USERS_API
const ACCOUNT_API = import.meta.env.VITE_ACCOUNT_API
const CONTACT_API = import.meta.env.VITE_CONTACT_API

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
  return json.data || []
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

/* ── Fuzzy-match a name string against a list of {id, name} records ── */
function fuzzyMatch(query, list) {
  if (!query || !list?.length) return []
  const q = query.toLowerCase().trim()
  // Exact match first
  const exact = list.filter(r => r.name.toLowerCase() === q)
  if (exact.length) return exact
  // Partial word match — any word in query appears in name or vice versa
  const words = q.split(/\s+/).filter(Boolean)
  return list.filter(r => {
    const n = r.name.toLowerCase()
    return words.some(w => n.includes(w)) || n.split(/\s+/).some(w => q.includes(w))
  })
}

/* ── Step labels ── */
const CONFIRM_STEPS = ['name', 'assignee', 'account', 'contact', 'priority', 'dateStartDate', 'dateEndDate', 'description']

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

      let preAccount = null
      let preContact = null
      if (mentionedAccount) {
        const matches = fuzzyMatch(mentionedAccount, currentAccounts)
        if (matches.length === 1) preAccount = matches[0]
      }
      if (mentionedContact) {
        const matches = fuzzyMatch(mentionedContact, currentContacts)
        if (matches.length === 1) preContact = matches[0]
      }

      setEditValues({
        name: extracted.name || '',
        assignedUsersIds: extracted.assignedUsersIds || [],
        assignedUsersNames: extracted.assignedUsersNames || {},
        description: extracted.description || '',
        priority: extracted.priority || 'Normal',
        dateStartDate: extracted.dateStartDate || '',
        dateEndDate: extracted.dateEndDate || '',
        // Store English transcript in cMessage field
        cMessage: langs.english || text,
        // Account fields
        accountId: preAccount?.id || '',
        accountName: preAccount?.name || '',
        mentionedAccountName: mentionedAccount,
        // Contact fields
        contactId: preContact?.id || '',
        contactName: preContact?.name || '',
        mentionedContactName: mentionedContact,
      })
      // Pre-fill search boxes with extracted names so user sees relevant suggestions
      setAccountSearch(mentionedAccount || '')
      setContactSearch(mentionedContact || '')
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
    if (confirmStep < CONFIRM_STEPS.length - 1) setConfirmStep(s => s + 1)
    else setPhase('preview')
  }

  // Skip optional steps (account / contact)
  const handleSkipStep = () => {
    setEditMode(false)
    const step = CONFIRM_STEPS[confirmStep]
    if (step === 'account') {
      setEditValues(v => ({ ...v, accountId: '', accountName: '' }))
      setAccountSearch('')
    } else if (step === 'contact') {
      setEditValues(v => ({ ...v, contactId: '', contactName: '' }))
      setContactSearch('')
    }
    if (confirmStep < CONFIRM_STEPS.length - 1) setConfirmStep(s => s + 1)
    else setPhase('preview')
  }

  const handleConfirmEdit = () => {
    const step = CONFIRM_STEPS[confirmStep]
    if (step !== 'assignee') setEditInput(editValues[step] || '')
    setEditMode(true)
  }

  const handleEditSave = () => {
    const step = CONFIRM_STEPS[confirmStep]
    if (step !== 'assignee') setEditValues(v => ({ ...v, [step]: editInput }))
    setEditMode(false)
    if (confirmStep < CONFIRM_STEPS.length - 1) setConfirmStep(s => s + 1)
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
      // Store English transcript in EspoCRM cMessage field
      cMessage: editValues.cMessage || undefined,
      // Optional account/contact links
      accountId: editValues.accountId || undefined,
      contactId: editValues.contactId || undefined,
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
    const step = CONFIRM_STEPS[confirmStep]
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

    // Filtered lists for dropdowns based on search text
    const accountResults = accountSearch.trim()
      ? fuzzyMatch(accountSearch, accounts).slice(0, 10)
      : accounts.slice(0, 10)
    const contactResults = contactSearch.trim()
      ? fuzzyMatch(contactSearch, contacts).slice(0, 10)
      : contacts.slice(0, 10)

    return (
      <div className="vf-container">
        <div className="vf-confirm-header">
          <span className="vf-step-badge">{confirmStep + 1}/{CONFIRM_STEPS.length}</span>
          <span className="vf-step-title">Confirm Task Details</span>
          {isOptional && <span className="vf-optional-badge">Optional</span>}
        </div>

        {(transcript || transcriptLangs) && (
          <div className="vf-transcript">
            <span className="vf-transcript-label">🎙 Transcript</span>
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
            <div className="vf-edit-area">
              {editValues.accountId ? (
                <div className="vf-selected-badge">
                  🏢 <strong>{editValues.accountName}</strong>
                  <button className="vf-clear-btn" onClick={() => {
                    setEditValues(v => ({ ...v, accountId: '', accountName: '' }))
                    setAccountSearch('')
                  }}>✕</button>
                </div>
              ) : (
                <>
                  <input
                    className="vf-input"
                    placeholder="Search account / company name…"
                    value={accountSearch}
                    onChange={e => setAccountSearch(e.target.value)}
                    autoFocus
                  />
                  {accountResults.length > 0 && (
                    <div className="vf-dropdown">
                      {accountResults.map(a => (
                        <div key={a.id} className="vf-dropdown-item" onClick={() => {
                          setEditValues(v => ({ ...v, accountId: a.id, accountName: a.name }))
                          setAccountSearch(a.name)
                        }}>
                          🏢 {a.name}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="vf-action-row">
                <button className="vf-btn-yes" onClick={handleConfirmYes} disabled={!editValues.accountId}>
                  ✅ Confirm
                </button>
                <button className="vf-btn-skip" onClick={handleSkipStep}>⏭ Skip</button>
              </div>
            </div>
          ) : step === 'contact' ? (
            /* ── Contact step ── */
            <div className="vf-edit-area">
              {editValues.contactId ? (
                <div className="vf-selected-badge">
                  👤 <strong>{editValues.contactName}</strong>
                  <button className="vf-clear-btn" onClick={() => {
                    setEditValues(v => ({ ...v, contactId: '', contactName: '' }))
                    setContactSearch('')
                  }}>✕</button>
                </div>
              ) : (
                <>
                  <input
                    className="vf-input"
                    placeholder="Search contact / person name…"
                    value={contactSearch}
                    onChange={e => setContactSearch(e.target.value)}
                    autoFocus
                  />
                  {contactResults.length > 0 && (
                    <div className="vf-dropdown">
                      {contactResults.map(c => (
                        <div key={c.id} className="vf-dropdown-item" onClick={() => {
                          setEditValues(v => ({ ...v, contactId: c.id, contactName: c.name }))
                          setContactSearch(c.name)
                        }}>
                          👤 {c.name}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="vf-action-row">
                <button className="vf-btn-yes" onClick={handleConfirmYes} disabled={!editValues.contactId}>
                  ✅ Confirm
                </button>
                <button className="vf-btn-skip" onClick={handleSkipStep}>⏭ Skip</button>
              </div>
            </div>
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
        <span className="vf-record-icon">🎙</span>
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
