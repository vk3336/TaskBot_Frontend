import { useState, useRef, useEffect } from 'react'

const OPENAI_KEY = import.meta.env.VITE_CHATGPT_KEY
const USERS_API = import.meta.env.VITE_USERS_API

/* ── helpers ── */
async function fetchUsers() {
  if (!USERS_API) throw new Error('VITE_USERS_API is not set in .env.local')
  const res = await fetch(USERS_API)
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  const json = await res.json()
  return json.data || []
}

async function transcribeAudio(audioBlob) {
  if (!OPENAI_KEY) throw new Error('VITE_CHATGPT_KEY is not configured. Add it to your .env.local file.')
  const formData = new FormData()
  formData.append('file', audioBlob, 'recording.webm')
  formData.append('model', 'whisper-1')
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

/* ── Validate that extracted user IDs all exist in the known users list ── */
function validateAssignedUsers(extracted, users) {
  const ids = extracted.assignedUsersIds || []
  if (ids.length === 0) return // unassigned is fine

  const validIds = new Set(users.map(u => u.id))
  const invalid = ids.filter(id => !validIds.has(id))
  if (invalid.length > 0) {
    // Try to show names if GPT returned them so the error is readable
    const names = extracted.assignedUsersNames || {}
    const invalidLabels = invalid.map(id => names[id] || id).join(', ')
    throw new Error(`Assigned user(s) not found in your team: "${invalidLabels}". Please re-record and mention a valid team member name.`)
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
  "description": "See formatting rules below"
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

/* ── Step labels ── */
const CONFIRM_STEPS = ['name', 'assignee', 'priority', 'dateStartDate', 'dateEndDate', 'description']

function fieldLabel(step) {
  if (step === 'name') return 'Task Name'
  if (step === 'assignee') return 'Assigned To'
  if (step === 'description') return 'Task Description'
  if (step === 'priority') return 'Priority'
  if (step === 'dateStartDate') return 'Start Date'
  if (step === 'dateEndDate') return 'Due Date'
  return step
}

function getAssigneeDisplay(editValues) {
  const names = Object.values(editValues.assignedUsersNames || {})
  return names.length > 0 ? names.join(', ') : 'Unassigned'
}

/* ── Fix #7: recording hook with error handling ── */
function useRecorder(onError) {
  const [recording, setRecording] = useState(false)
  const [audioBlob, setAudioBlob] = useState(null)
  const [audioURL, setAudioURL] = useState(null)
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
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType })
        setAudioBlob(blob)
        setAudioURL(URL.createObjectURL(blob))
        stream.getTracks().forEach(t => t.stop())
      }
      mr.start()
      mediaRef.current = mr
      setRecording(true)
    } catch (err) {
      // Permission denied, insecure context, or unsupported browser
      const msg = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
        ? 'Microphone access was denied. Please allow microphone permission and try again.'
        : err.name === 'NotFoundError'
        ? 'No microphone found. Please connect a microphone and try again.'
        : `Could not start recording: ${err.message}`
      onError(msg)
    }
  }

  const stop = () => { mediaRef.current?.stop(); setRecording(false) }

  return { recording, audioBlob, audioURL, start, stop }
}

/* ── Main VoiceTaskFlow component ── */
export default function VoiceTaskFlow({ onDone, onCancel }) {
  const [phase, setPhase] = useState('record')
  const [error, setError] = useState('')
  const [users, setUsers] = useState([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [confirmStep, setConfirmStep] = useState(0)
  const [editValues, setEditValues] = useState({})
  const [transcript, setTranscript] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [editInput, setEditInput] = useState('')
  // Fix #2: track audio presence in state so JSX reads state, not ref directly
  const [hasAudio, setHasAudio] = useState(false)
  const audioBlobRef = useRef(null)
  const fileInputRef = useRef(null)
  const prevBlobRef = useRef(null)
  const { recording, audioBlob, audioURL, start, stop } = useRecorder(setError)

  useEffect(() => {
    fetchUsers()
      .then(d => { setUsers(d); setUsersLoading(false) })
      .catch(err => { setError(`Failed to load users: ${err.message}`); setUsersLoading(false) })
  }, [])

  // Fix #5: pass users as argument to processAudio so it never closes over stale state
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
      const extracted = await extractTaskFields(text, currentUsers)
      // Reject if GPT assigned users that don't exist in the team
      validateAssignedUsers(extracted, currentUsers)
      setEditValues({
        name: extracted.name || '',
        assignedUsersIds: extracted.assignedUsersIds || [],
        assignedUsersNames: extracted.assignedUsersNames || {},
        description: extracted.description || '',
        priority: extracted.priority || 'Normal',
        dateStartDate: extracted.dateStartDate || '',
        dateEndDate: extracted.dateEndDate || '',
      })
      setConfirmStep(0)
      setPhase('confirm')
    } catch (e) {
      setError(e.message)
      setPhase('record')
    }
  }

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0]
    if (file) processAudio(file, users)
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
    const displayValue = step === 'assignee'
      ? getAssigneeDisplay(editValues)
      : step === 'priority'
      ? (editValues.priority || 'Normal')
      : step === 'dateStartDate'
      ? (editValues.dateStartDate || '(not set)')
      : step === 'dateEndDate'
      ? (editValues.dateEndDate || '(not set)')
      : (editValues[step] || '(not set)')

    return (
      <div className="vf-container">
        <div className="vf-confirm-header">
          <span className="vf-step-badge">{confirmStep + 1}/{CONFIRM_STEPS.length}</span>
          <span className="vf-step-title">Confirm Task Details</span>
        </div>

        {transcript && (
          <div className="vf-transcript">
            <span className="vf-transcript-label">🎙 Transcript</span>
            <span className="vf-transcript-text">"{transcript}"</span>
          </div>
        )}

        {error && <div className="vf-error">⚠️ {error}</div>}

        <div className="vf-field-card">
          <div className="vf-field-label">{label}</div>
          {editMode ? (
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

        {!editMode && (
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
          disabled={usersLoading}
        >
          {recording ? (
            <><span className="vf-rec-dot" /><span>Stop Recording</span></>
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

        <button className="vf-upload-btn" onClick={() => fileInputRef.current?.click()} disabled={usersLoading}>
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
