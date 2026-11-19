# CheckPoint: Online Exam Integrity System (Architecture)

**Goal:** CheckPoint improves online exams by (1) preventing cheating and (2) monitoring student behavior, with a risk score and evidence log for human review.

## 1. Tech Stack (minimal, no build step)

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + Express | One server, one `npm start` |
| Database | SQLite (`better-sqlite3`) | Zero setup, a single file |
| Frontend | Plain HTML + CSS + vanilla JS | No framework or bundler |
| Auth | Session token (random UUID stored in DB) + bcrypt | Simple |
| Face check | `@vladmandic/face-api` via CDN (webcam, in-browser) | No server-side AI |
| Live updates | Dashboard polling every 5s | Simpler than WebSockets |

## 2. System Diagram

```
 STUDENT BROWSER                              SERVER (Express)                 DB (SQLite)
┌───────────────────────────┐            ┌─────────────────────────┐      ┌──────────────┐
│ login.html                │──login────▶│ /api/auth               │─────▶│ users        │
│ exam.html                 │            │ /api/exam (start/submit)│─────▶│ exams        │
│  ├─ Exam UI + timer       │◀─questions─│  (shuffled per student) │      │ questions    │
│  ├─ Lockdown (fullscreen, │            │                         │      │ attempts     │
│  │   no copy/paste/menu)  │            │ /api/events             │─────▶│ activity_logs│
│  ├─ Behavior Monitor ─────┼──events───▶│  └─ Risk Engine         │─────▶│ (risk on     │
│  └─ Webcam face check ────┘            │                         │      │  attempts)   │
└───────────────────────────┘            │ /api/admin/*            │      └──────────────┘
 INSTRUCTOR BROWSER                      │  (instructor role only) │
┌───────────────────────────┐            │                         │
│ admin.html (dashboard) ───┼──polling──▶│                         │
└───────────────────────────┘            └─────────────────────────┘
```

## 3. Modules

| # | Module | Responsibility |
|---|---|---|
| 1 | **Auth** | Login, roles (`student`, `instructor`), session token, one active session per student |
| 2 | **Exam Engine** | Start attempt, serve randomized questions, autosave answers, enforce server-side timer, grade |
| 3 | **Lockdown (client)** | Fullscreen, block copy/paste/cut/right-click/print/select/devtools shortcuts, warn on violations |
| 4 | **Behavior Monitor (client)** | Capture events and POST them to `/api/events` |
| 5 | **Face Monitor (client)** | Webcam snapshot check every ~5s: no face / multiple faces |
| 6 | **Risk Engine (server)** | Weighted score per attempt, plus answer-similarity check |
| 7 | **Admin Dashboard** | Attempts list with risk level, event timeline, CSV export, mark reviewed |

## 4. Anti-Cheating Controls

| Control | Where |
|---|---|
| Shuffled question order and answer choices per student | Server, at attempt start |
| Random subset from a question pool (optional) | Server |
| Server-side timer (client time is never trusted) | Server |
| Auto-submit when time expires | Server and client |
| Single active session; a second login is flagged | Server |
| Fullscreen required; exit is logged and warned | Client |
| Copy, paste, cut, right-click, select, and print blocked | Client |
| Webcam: no face or multiple faces detected | Client |
| Auto-submit after N high-severity violations (configurable) | Server |

## 5. Behavior Monitoring and Risk Scoring

| Event type | Trigger | Weight |
|---|---|---|
| `TAB_HIDDEN` | `visibilitychange` (hidden) | 10 |
| `WINDOW_BLUR` | `window.blur` | 5 |
| `FULLSCREEN_EXIT` | `fullscreenchange` | 10 |
| `COPY_PASTE` | `copy` / `paste` / `cut` | 5 |
| `RIGHT_CLICK` | `contextmenu` | 2 |
| `DEVTOOLS_KEY` | F12, Ctrl+Shift+I, Ctrl+U | 5 |
| `NO_FACE` | Face check finds 0 faces | 5 |
| `MULTI_FACE` | Face check finds 2 or more faces | 15 |
| `IDLE` | No input for 60s | 2 |
| `FAST_ANSWER` | Answer in under 3s (computed server-side) | 3 |
| `SECOND_SESSION` | Login from a second device | 15 |
| `SIMILAR_ANSWERS` | Same wrong answers as another student (post-exam) | 20 |

```
risk_score = Σ (event_count × weight)
 0–30  → LOW     (normal)
31–60  → MEDIUM  (review recommended)
61+    → HIGH    (flag for instructor review)
```

## 6. Database Schema

```
users          (id, name, email, password_hash, role, session_token, created_at)
exams          (id, title, duration_min, max_violations, created_at)
questions      (id, exam_id, text, option_a, option_b, option_c, option_d, correct)
attempts       (id, user_id, exam_id, started_at, ended_at, status, score,
                question_order JSON, answers JSON, risk_score, risk_level, reviewed)
activity_logs  (id, attempt_id, event_type, details JSON, created_at)
```

## 7. API Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | any | Returns token and role |
| POST | `/api/exam/start` | student | Creates attempt, returns shuffled questions |
| POST | `/api/exam/answer` | student | Autosave one answer |
| POST | `/api/exam/submit` | student | Grade and close attempt |
| POST | `/api/events` | student | Log a behavior event, update risk |
| GET | `/api/admin/attempts` | instructor | List attempts with risk |
| GET | `/api/admin/attempts/:id` | instructor | Event timeline |
| POST | `/api/admin/attempts/:id/review` | instructor | Mark reviewed, add note |
| GET | `/api/admin/export.csv` | instructor | Export results |

## 8. Folder Structure

```
checkpoint/
├─ server.js
├─ db.js              # schema + seed
├─ riskEngine.js
├─ routes/            # auth.js, exam.js, events.js, admin.js
├─ public/
│  ├─ login.html
│  ├─ exam.html
│  ├─ admin.html
│  └─ js/             # lockdown.js, monitor.js, face.js, exam.js, admin.js
├─ package.json
└─ README.md
```

## 9. Privacy and Ethics

- Show a **consent screen** before enabling the camera
- Store **event logs only**, with no video; snapshots are processed in-browser and not saved
- The system **flags; humans decide**. Include a reviewer note and an appeal field
- State the data retention period in the README

## 10. Known Limitations

Second devices and off-camera helpers cannot be fully prevented. The system reduces cheating through deterrence and evidence, and works best with application-based questions.
