import { useState, useRef, useEffect, useCallback } from 'react'
import VoiceTaskFlow from './VoiceTaskFlow.jsx'

const API = import.meta.env.VITE_BACKEND       // http://localhost:3000/api/tasks
const USERS_API = import.meta.env.VITE_USERS_API // http://localhost:3000/api/users

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
  const res = await fetch(USERS_API)
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  const json = await res.json()
  return json.data || []
}

async function fetchAllTasks() {
  const res = await fetch(API)
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  const json = await res.json()
  return json.data || []
}

async function fetchTasksByUser(username) {
  const res = await fetch(`${API}/${encodeURIComponent(username)}`)
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  const json = await res.json()
  return json.data || []
}

async function postTask(body) {
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

/* ─── Sub-components ───────────────────────────────── */
function TaskCard({ task }) {
  // assignedUsersNames is a map { id: name, ... }
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
      {task.description && (
        <div className="task-desc">📝 {task.description}</div>
      )}
      {(task.attachmentsIds?.length > 0) && (
        <div className="task-meta" style={{ marginTop: '4px' }}>
          <span>📎 {task.attachmentsIds.length} attachment{task.attachmentsIds.length > 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  )
}

// User list shown inside a chat bubble for "Tasks by User"
function UserList({ users, onSelect }) {
  return (
    <div className="user-list">
      <p className="user-list-title">Select a team member to view their tasks:</p>
      <div className="user-chips">
        {users.map(u => (
          <button key={u} className="user-chip" onClick={() => onSelect(u)}>
            <span className="chip-avatar">{initials(u)}</span>
            <span>{u}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// Create task form inside a chat bubble
function CreateTaskForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: '', description: '',
    priority: 'Normal',
    dateStartDate: '', dateEndDate: '',
    assignedUsersIds: [],
    assignedUsersNames: {},
  })
  const [users, setUsers] = useState([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchUsers()
      .then(data => setUsers(data))
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false))
  }, [])

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const toggleUser = (userId, userName) => {
    setForm(prev => {
      const ids = prev.assignedUsersIds || []
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

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Task name is required.'); return }
    setLoading(true); setError('')
    try {
      const payload = {
        name: form.name,
        priority: form.priority,
        description: form.description || undefined,
        dateStartDate: form.dateStartDate || undefined,
        dateEndDate: form.dateEndDate || undefined,
        assignedUsersIds: form.assignedUsersIds.length > 0 ? form.assignedUsersIds : undefined,
        assignedUsersNames: Object.keys(form.assignedUsersNames).length > 0 ? form.assignedUsersNames : undefined,
      }
      Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k])
      await onSubmit(payload)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

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
                <input type="checkbox"
                  checked={(form.assignedUsersIds || []).includes(u.id)}
                  onChange={() => toggleUser(u.id, u.name)} />
                <span>{u.name}</span>
              </label>
            ))}
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

// Renders a chat message
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
          {/* plain text */}
          {msg.content && <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>}

          {/* task list */}
          {msg.tasks && msg.tasks.length > 0 &&
            msg.tasks.map(t => <TaskCard key={t.id} task={t} />)}
          {msg.tasks && msg.tasks.length === 0 &&
            <div className="empty-state">😕 No tasks found.</div>}

          {/* user list */}
          {msg.users &&
            <UserList users={msg.users} onSelect={onUserSelect} />}

          {/* create form */}
          {msg.showForm &&
            <CreateTaskForm onSubmit={onCreateSubmit} onCancel={onCreateCancel} />}

          {/* voice task flow */}
          {msg.showVoice &&
            <VoiceTaskFlow onDone={(payload, blob) => onVoiceDone(payload, blob)} onCancel={onVoiceCancel} />}

          {/* loading spinner */}
          {msg.loading &&
            <div className="bubble-loader">
              <div className="typing-dot" /><div className="typing-dot" /><div className="typing-dot" />
            </div>}
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

/* ─── QUICK ACTIONS & SUGGESTIONS ─────────────────── */
const QUICK_ACTIONS = [
  { label: '📋 All Tasks', action: 'allTasks' },
  { label: '➕ Create Task', action: 'createTask' },
  { label: '🎙 Voice Task', action: 'voiceTask' },
  { label: '👤 Tasks by User', action: 'tasksByUser' },
]

const SUGGESTIONS = [
  { icon: '📋', title: 'View All Tasks', desc: 'See every task with its assignee and status', action: 'allTasks' },
  { icon: '➕', title: 'Create a Task', desc: 'Add a new task and assign it to a team member', action: 'createTask' },
  { icon: '🎙', title: 'Voice Task', desc: 'Record your voice or upload audio — AI extracts all task details', action: 'voiceTask' },
  { icon: '👤', title: 'Tasks by User', desc: 'Pick a team member and see all their tasks', action: 'tasksByUser' },
]

/* ─── MAIN APP ─────────────────────────────────────── */
export default function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  // Adds a message to the list; returns its id
  const addMsg = useCallback((msg) => {
    const id = Date.now() + Math.random()
    setMessages(prev => [...prev, { id, time: getTime(), ...msg }])
    return id
  }, [])

  // Updates an existing message by id
  const updateMsg = useCallback((id, patch) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m))
  }, [])

  /* ── action handlers ── */
  const handleAllTasks = useCallback(async () => {
    addMsg({ role: 'user', content: 'Show me all tasks' })
    setIsTyping(true)
    try {
      const tasks = await fetchAllTasks()
      setIsTyping(false)
      addMsg({
        role: 'ai',
        content: tasks.length > 0
          ? `Here are all ${tasks.length} assigned tasks:`
          : null,
        tasks,
      })
    } catch (e) {
      setIsTyping(false)
      addMsg({ role: 'ai', content: `❌ Failed to fetch tasks: ${e.message}` })
    }
  }, [addMsg])

  const handleCreateTask = useCallback(() => {
    addMsg({ role: 'user', content: 'I want to create a new task' })
    addMsg({
      role: 'ai',
      content: 'Sure! Fill in the details below:',
      showForm: true,
    })
  }, [addMsg])

  const handleVoiceTask = useCallback(() => {
    addMsg({ role: 'user', content: '🎙 Create task from voice' })
    addMsg({
      role: 'ai',
      content: 'Great! Record your voice note or upload an audio file. I\'ll extract all the task details and confirm each one with you before saving.',
      showVoice: true,
    })
  }, [addMsg])

  const handleVoiceDone = useCallback(async (formData, audioBlob) => {
    // hide the voice widget
    setMessages(prev => prev.map(m => m.showVoice ? { ...m, showVoice: false, content: 'Creating your task…' } : m))
    setIsTyping(true)
    try {
      const result = await postTask(formData)
      const taskId = result.data?.id

      // Upload the audio recording as an attachment if we have both the task ID and the blob
      if (taskId && audioBlob) {
        try {
          const fd = new FormData()
          const ext = audioBlob.type.includes('webm') ? 'webm' : 'audio'
          fd.append('file', audioBlob, `voice-note.${ext}`)
          await fetch(`${API}/${taskId}/attachment`, { method: 'POST', body: fd })
        } catch (attachErr) {
          console.warn('Audio attachment upload failed (non-fatal):', attachErr.message)
        }
      }

      setIsTyping(false)
      addMsg({
        role: 'ai',
        content: `✅ Task "${formData.name}" has been created successfully in EspoCRM!${audioBlob && taskId ? '\n📎 Your voice recording has been attached to the task.' : ''}\n\nAssigned team member(s) can now see this task in their dashboard.`,
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
      // Extract unique user names from assignedUsersNames maps
      const nameSet = new Set()
      tasks.forEach(t => {
        if (t.assignedUsersNames && typeof t.assignedUsersNames === 'object') {
          Object.values(t.assignedUsersNames).forEach(n => n && nameSet.add(n))
        }
        // fallback for legacy single-user field
        if (t.assignedUserName) nameSet.add(t.assignedUserName)
      })
      const users = [...nameSet].sort()
      setIsTyping(false)
      if (users.length === 0) {
        addMsg({ role: 'ai', content: 'No assigned users found in the task list.' })
      } else {
        addMsg({ role: 'ai', content: null, users })
      }
    } catch (e) {
      setIsTyping(false)
      addMsg({ role: 'ai', content: `❌ Failed to fetch users: ${e.message}` })
    }
  }, [addMsg])

  // Called when user clicks a name in UserList
  const handleUserSelect = useCallback(async (username) => {
    addMsg({ role: 'user', content: `Show tasks for ${username}` })
    setIsTyping(true)
    try {
      const tasks = await fetchTasksByUser(username)
      setIsTyping(false)
      addMsg({
        role: 'ai',
        content: tasks.length > 0
          ? `Here are ${tasks.length} task(s) assigned to ${username}:`
          : null,
        tasks,
      })
    } catch (e) {
      setIsTyping(false)
      addMsg({ role: 'ai', content: `❌ Could not fetch tasks: ${e.message}` })
    }
  }, [addMsg])

  // Called when create-task form is submitted
  const handleCreateSubmit = useCallback(async (formData) => {
    // find the form message and hide it
    setMessages(prev => prev.map(m => m.showForm ? { ...m, showForm: false, content: 'Creating your task…' } : m))
    setIsTyping(true)
    try {
      await postTask(formData)
      setIsTyping(false)
      addMsg({
        role: 'ai',
        content: `✅ Task "${formData.name}" created successfully in EspoCRM!`,
      })
    } catch (e) {
      setIsTyping(false)
      addMsg({ role: 'ai', content: `❌ Failed to create task: ${e.message}` })
    }
  }, [addMsg])

  const handleCreateCancel = useCallback(() => {
    setMessages(prev => prev.map(m => m.showForm ? { ...m, showForm: false, content: 'Task creation cancelled.' } : m))
  }, [])

  // Text input send — basic keyword routing
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

    // fallback
    addMsg({ role: 'user', content })
    setIsTyping(true)
    setTimeout(() => {
      setIsTyping(false)
      addMsg({
        role: 'ai',
        content: "I can help you with:\n• 📋 View all tasks\n• ➕ Create a task\n• 🎙 Voice task (record or upload audio)\n• 👤 Tasks by user\n\nUse the quick buttons above or just ask!",
      })
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
      {/* ── Chat area ── */}
      <main className="chat-area">
        <header className="chat-header">
          <div className="chat-header-left">
            <div className="ai-avatar"><img src="/chat.png" alt="TaskBot" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /></div>
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
              <div className="welcome-icon"><img src="/chat.png" alt="TaskBot" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /></div>
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
              {messages.map(msg => (
                <Message
                  key={msg.id}
                  msg={msg}
                  onUserSelect={handleUserSelect}
                  onCreateSubmit={handleCreateSubmit}
                  onCreateCancel={handleCreateCancel}
                  onVoiceDone={handleVoiceDone}
                  onVoiceCancel={handleVoiceCancel}
                />
              ))}
              {isTyping && <TypingIndicator />}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="input-area">
          <div className="quick-actions">
            {QUICK_ACTIONS.map(qa => (
              <button key={qa.label} className="quick-btn" onClick={() => handleAction(qa.action)}>
                {qa.label}
              </button>
            ))}
          </div>
          <div className="input-box">
            <textarea
              ref={textareaRef}
              className="chat-input"
              placeholder="Ask me about tasks, or use the quick buttons above…"
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <div className="input-actions">
              <button
                className="voice-btn"
                title="Create task from voice"
                onClick={() => handleVoiceTask()}
              >🎙</button>
              <button className="send-btn" onClick={() => handleSend()} disabled={!input.trim() || isTyping}>➤</button>
            </div>
          </div>
          <div className="input-hint">Press Enter to send · Shift+Enter for new line · 🎙 for voice task</div>
        </div>
      </main>
    </div>
  )
}
