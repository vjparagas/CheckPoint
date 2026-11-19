# Antigravity Prompts: CheckPoint (Online Exam Integrity System)

**How to use**
1. Create an empty folder `checkpoint/` and put `ARCHITECTURE.md` in it.
2. Open the folder in Antigravity.
3. Paste **Prompt 0** first (project rules), then run Prompts 1 to 6 **one at a time**. Test after each one before moving on.

---

## Prompt 0: Project Context (paste first)

```
This project is called CheckPoint. Read ARCHITECTURE.md in this folder. It is the single source of truth for this project.

Rules for all work:
- Stack: Node.js + Express + SQLite (better-sqlite3) + plain HTML/CSS/vanilla JS. No frameworks, no bundlers, no TypeScript.
- Keep it simple and minimal. Fewer files and fewer dependencies are better.
- Follow the folder structure, DB schema, API endpoints, event types and risk weights exactly as written.
- Never trust client data for time, score, or role. Validate on the server.
- Add short comments explaining each security or anti-cheating feature.
- After each task, tell me how to run and test it.
Confirm you understand, then wait for my next prompt.
```

---

## Prompt 1: Backend Skeleton and Database

```
Create the backend skeleton:
- package.json (express, better-sqlite3, bcryptjs, uuid), with "npm start" running server.js
- db.js: create all tables from the schema in ARCHITECTURE.md on startup, and seed:
  - 1 instructor (instructor@test.com / admin123)
  - 3 students (student1@test.com, student2@test.com, student3@test.com, password: pass123)
  - 1 exam "Sample Exam" (duration 10 min, max_violations 5) with 10 multiple-choice general-knowledge questions
- server.js: Express app serving /public as static files, JSON body parsing, and mounting routes from /routes
- routes/auth.js: POST /api/auth/login (bcrypt check; generate a new session_token and store it on the user, which invalidates any older session). Add an auth middleware that checks the Bearer token and a requireRole(role) helper.
Do not build other routes yet.
```

---

## Prompt 2: Exam Engine

```
Build routes/exam.js with these student-only endpoints:
- POST /api/exam/start: create an attempt (or resume the in-progress one). Shuffle question order AND answer options per student with a seeded shuffle saved in attempts.question_order. Return questions WITHOUT the correct answer, plus the remaining seconds computed on the server.
- POST /api/exam/answer: autosave one answer into attempts.answers. Reject if the attempt is closed or time has expired. Log the time since the question was served; if under 3 seconds, insert a FAST_ANSWER event into activity_logs.
- POST /api/exam/submit: grade on the server, set status=submitted, store score. Auto-submit if the server-side timer expired.
Option mapping must be handled server-side so shuffled options still grade correctly.
```

---

## Prompt 3: Risk Engine and Events API

```
Build riskEngine.js and routes/events.js:
- riskEngine.js exports WEIGHTS (use the exact event types and weights from ARCHITECTURE.md section 5) and computeRisk(attemptId), which sums count x weight from activity_logs, then updates attempts.risk_score and risk_level (LOW 0-30, MEDIUM 31-60, HIGH 61+).
- POST /api/events (student only): validate event_type against WEIGHTS, insert into activity_logs with details JSON, recompute risk, and return { risk_level, violations }.
- If the count of high-severity events (TAB_HIDDEN, FULLSCREEN_EXIT, MULTI_FACE) reaches exams.max_violations, auto-submit the attempt and return { autoSubmitted: true }.
- In routes/auth.js, when a login replaces an existing session_token for a student with an in-progress attempt, insert a SECOND_SESSION event for that attempt.
- Add a function checkSimilarity(examId) that compares all submitted attempts pairwise; if two students share 3 or more identical WRONG answers, add a SIMILAR_ANSWERS event to both. Run it after each submit.
```

---

## Prompt 4: Student Pages with Lockdown and Monitoring

```
Build the student front end in /public:
- login.html: simple login form; store the token in sessionStorage; redirect students to exam.html and instructors to admin.html.
- exam.html + js/exam.js: consent screen first ("camera and activity will be monitored; no video is stored"), then a Start button that requests fullscreen and calls /api/exam/start. Show a countdown timer from the server's remaining seconds, one question at a time (no going back), autosave each answer, and a Submit button.
- js/lockdown.js: block copy, paste, cut, contextmenu, selectstart, and print; block F12, Ctrl+Shift+I, Ctrl+U, Ctrl+P, and Ctrl+C/V keys. Show a red warning banner on each violation.
- js/monitor.js: send events to POST /api/events for: visibilitychange (hidden) -> TAB_HIDDEN, window blur -> WINDOW_BLUR, fullscreenchange exit -> FULLSCREEN_EXIT (also show a "return to fullscreen" overlay that blocks the exam), copy/paste/cut -> COPY_PASTE, contextmenu -> RIGHT_CLICK, devtools keys -> DEVTOOLS_KEY, and 60s with no mouse/keyboard -> IDLE.
- If the server responds autoSubmitted: true, show an "Exam ended due to violations" screen.
Keep each JS file small and well commented.
```

---

## Prompt 5: Webcam Face Monitoring

```
Add js/face.js and wire it into exam.html:
- Load @vladmandic/face-api from the jsDelivr CDN and use the TinyFaceDetector model (load model weights from the same CDN).
- After the student accepts the consent screen, request the webcam and show a small preview in a corner.
- Every 5 seconds, run detection on the video element IN THE BROWSER (do not upload or save any images or video).
- 0 faces for 2 consecutive checks -> send NO_FACE. 2 or more faces -> send MULTI_FACE immediately. Add a 30 second cooldown per event type so the log is not spammed.
- If camera permission is denied, show a message and send a NO_FACE event, and let the instructor see it in the dashboard.
```

---

## Prompt 6: Instructor Dashboard

```
Build routes/admin.js (instructor only) and the dashboard:
- GET /api/admin/attempts: list all attempts with student name, status, score, risk_score, risk_level, event count, reviewed flag.
- GET /api/admin/attempts/:id: full activity_logs timeline for one attempt.
- POST /api/admin/attempts/:id/review: mark reviewed and save a reviewer note.
- GET /api/admin/export.csv: export attempts with scores and risk levels.
- public/admin.html + js/admin.js: table of attempts sorted by risk (HIGH in red, MEDIUM in orange, LOW in green), auto-refresh every 5 seconds, a "CheckPoint" header with logo text, summary cards (total attempts, # HIGH, # MEDIUM, # in progress), a click-to-open timeline panel showing each event with its time, a "Mark reviewed" button with a note box, and an Export CSV button.
- Add a small footer note with the CheckPoint name and this text: "Risk scores are indicators only. Final decisions must be made by a human reviewer."
```

---

## Prompt 7: Test and Document

```
1. Review the whole project against ARCHITECTURE.md and list anything missing or inconsistent, then fix it.
2. Write README.md: install, run (npm install && npm start), demo accounts, a 5-step demo script (log in as student, switch tabs, copy text, exit fullscreen, see the HIGH risk in the dashboard), privacy notes, and limitations.
3. Add a simple test script (node test.js) that logs in as a student, starts an exam, posts several events, and asserts that the risk level changes to HIGH.
```

---

## Quick Demo Script (for your presentation)

1. Log in as `student1@test.com`, accept the consent screen, start the exam.
2. Switch tabs twice, press Ctrl+C, exit fullscreen, and cover the camera.
3. Open `admin.html` as the instructor and show the attempt turning **HIGH**, with the event timeline as evidence.
4. Show that two students with the same wrong answers get a `SIMILAR_ANSWERS` flag.
5. End by clicking **Mark reviewed** to show that a human makes the final decision.

## Tips for Antigravity

- Run prompts one at a time; ask it to run `npm start` and test before the next prompt.
- If it adds extra libraries or files, reply: *"Simplify. Follow ARCHITECTURE.md and remove unneeded dependencies."*
- Camera features need `localhost` or HTTPS, so use `http://localhost:3000`.
