# TaskBot AI — PWA Frontend

A conversational, chat-style Progressive Web App (PWA) for managing tasks in **EspoCRM**. Built with React 19 and Vite, it lets you view tasks, create tasks via a form, and — most uniquely — **create tasks entirely by voice** using OpenAI Whisper for transcription and GPT-4o-mini for intelligent field extraction.

---

## Tables

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Project Structure](#project-structure)
- [Components](#components)
- [Voice Task Flow](#voice-task-flow)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [PWA Support](#pwa-support)

---

## Overview

TaskBot AI presents itself as a chat interface (think ChatGPT, but for your EspoCRM tasks). Users interact through a message thread — asking to view tasks, create tasks, or filter by team member. The sidebar and suggestion cards give quick access to each feature. The standout feature is the **Voice Task Creator**: record a voice note or upload an audio file, and the app transcribes it with Whisper, extracts all task fields with GPT-4o-mini, walks you through a step-by-step confirmation flow, and finally creates the task in EspoCRM with the audio file attached.

---

## Tech Stack

| Tool                   | Purpose                                       |
|------------------------|-----------------------------------------------|
| React 19               | UI framework                                  |
| Vite 8                 | Build tool and dev server                     |
| OpenAI Whisper API     | Audio transcription (speech-to-text)          |
| OpenAI GPT-4o-mini API | Task field extraction from transcripts        |
| MediaRecorder API      | In-browser audio recording                    |
| Fetch API              | All HTTP requests to the backend              |
| CSS Custom Properties  | Dark-theme design system                      |

No UI component libraries — the entire interface is built with custom CSS.

---

## Features

### 📋 View All Tasks
Fetches every task from EspoCRM that has at least one assigned user and displays them as cards showing name, status badge, assignees, due date, priority, description, and attachment count.

### ➕ Create Task (Form)
An inline form inside the chat renders with:
- Task name (required)
- Multi-user assignment via checkboxes (users loaded live from the API)
- Priority selector (Low / Normal / High / Urgent)
- Start and end date pickers
- Description textarea

### 🎙 Voice Task Creator
The flagship feature — see the [Voice Task Flow](#voice-task-flow) section for the full walkthrough.

### 👤 Tasks by User
Loads all tasks, extracts unique assignee names, displays them as clickable chips, then fetches and displays tasks for whichever team member you select.

### 💬 Natural Language Input
The chat input understands plain English. Phrases like "show me all tasks", "create a new task", "voice task", or "tasks for Alice" are matched with simple regex rules and trigger the appropriate action automatically.

### 🔄 New Chat
Clears the message thread and returns to the welcome screen, ready for a fresh session.

---

## Project Structure

```
PWA/
├── public/
│   ├── chat.png              # TaskBot avatar image
│   ├── profile.png           # User avatar image
│   ├── favicon.svg
│   └── icons.svg
├── src/
│   ├── App.jsx               # Main app, all chat logic and sub-components
│   ├── VoiceTaskFlow.jsx     # Self-contained voice recording + AI extraction flow
│   ├── App.css               # (reserved / global overrides)
│   ├── index.css             # Full design system (CSS custom properties + all styles)
│   └── main.jsx              # React entry point
├── index.html                # HTML shell with PWA meta tags
├── vite.config.js            # Vite config (host: true for LAN access)
├── .env.local                # Local environment variables (not committed)
└── package.json
```

---

## Components

All components live in `App.jsx` (intentionally co-located for this project size):

| Component          | Description                                                                 |
|--------------------|-----------------------------------------------------------------------------|
| `App`              | Root component — manages all state, message list, and action handlers       |
| `Sidebar`          | Collapsible left panel with nav items and New Chat button                   |
| `Message`          | Renders a single chat bubble (user or AI), including embedded components    |
| `TaskCard`         | Displays a single task with status badge, metadata, and description         |
| `UserList`         | Grid of clickable user chips for the "Tasks by User" flow                   |
| `CreateTaskForm`   | Inline task creation form with live user loading                            |
| `TypingIndicator`  | Three-dot animated bubble shown while waiting for API responses             |
| `VoiceTaskFlow`    | Full voice recording + AI extraction + confirmation flow (in its own file)  |

---

## Voice Task Flow

`VoiceTaskFlow.jsx` is a self-contained multi-phase component:

```
record → processing → confirm (×6 steps) → preview → saving → done
```

### Phase 1 — Record
- **Start Recording** button uses the browser's `MediaRecorder` API to capture microphone audio (`audio/webm;codecs=opus` preferred).
- **Upload Audio File** button lets the user pick an existing MP3, WAV, M4A, WebM, or OGG file instead.
- A playback preview is shown after recording stops.

### Phase 2 — Processing
- The audio blob is sent to **OpenAI Whisper** (`whisper-1`) for transcription.
- The transcript is sent to **GPT-4o-mini** along with the full list of EspoCRM users. The model extracts:
  - Task name
  - Assigned users (matched loosely by name, supports multiple)
  - Priority (inferred from context)
  - Start and end dates (relative terms like "next Friday" are resolved)
  - Description (formatted with emoji sections and bullet points)

### Phase 3 — Confirm (step-by-step)
The user is walked through 6 fields one at a time:
1. Task Name
2. Assigned To (checkbox list)
3. Priority (dropdown)
4. Start Date (date picker)
5. Due Date (date picker)
6. Description (textarea)

Each step shows the AI-extracted value and asks "Is this correct?" — the user can confirm or edit inline before moving to the next.

### Phase 4 — Preview
A read-only summary card of all confirmed fields. The user can save, go back to edit, or cancel.

### Phase 5 — Saving
The confirmed fields are posted to the backend as a new task. If an audio blob exists, it is uploaded as a file attachment linked to the newly created task record in EspoCRM.

---

## Environment Variables

Create a `.env.local` file in the `PWA/` directory:

```env
VITE_BACKEND=http://localhost:3000/api/tasks
VITE_USERS_API=http://localhost:3000/api/users
VITE_CHATGPT_KEY=sk-your-openai-api-key-here
```

| Variable           | Description                                                       |
|--------------------|-------------------------------------------------------------------|
| `VITE_BACKEND`     | Full URL to the backend tasks API endpoint                        |
| `VITE_USERS_API`   | Full URL to the backend users API endpoint                        |
| `VITE_CHATGPT_KEY` | OpenAI API key — used client-side for Whisper and GPT-4o-mini     |

> **Note:** The OpenAI key is used directly from the browser. For production, proxy Whisper and GPT calls through your backend to keep the key server-side.

---

## Getting Started

### Prerequisites

- Node.js 18+
- The Node.js backend running (see `../Nodejs/README.md`)
- An OpenAI API key with access to `whisper-1` and `gpt-4o-mini`

### Installation

```bash
# Navigate to the PWA directory
cd PWA

# Install dependencies
npm install

# Create your environment file
copy .env.example .env.local
# Edit .env.local with your backend URL and OpenAI key
```

### Development Server

```bash
npm run dev
```

Opens at `http://localhost:5173`. The `host: true` setting in `vite.config.js` also makes it accessible on your local network (useful for testing on mobile).

### Production Build

```bash
npm run build
```

Outputs to `dist/`. Serve with any static host or `npm run preview` for a local production preview.

---

## PWA Support

The `index.html` includes the following PWA-ready meta tags:

- `theme-color` — dark background (`#050508`) for browser chrome styling
- `mobile-web-app-capable` — enables Add to Home Screen on Android
- `apple-mobile-web-app-capable` — enables standalone mode on iOS
- `apple-mobile-web-app-status-bar-style` — black-translucent status bar on iOS
- `viewport-fit=cover` — handles iPhone notch / safe areas correctly

To make the app fully installable, add a `manifest.json` and a service worker (e.g. via `vite-plugin-pwa`).
