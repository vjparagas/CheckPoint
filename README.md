# CheckPoint: Online Exam Integrity System

CheckPoint is an anti-cheating and behavior monitoring system for online examinations. It provides client-side lockdown, in-browser webcam face analysis, server-side timer enforcement, randomized shuffling, and automated risk scoring with an evidence timeline for instructor review.

---

## 1. Quick Start

### Prerequisites
- Node.js (v18+)

### Install & Run
```bash
# Install dependencies
npm install

# Start the server
npm start
```
Once started, access the application in your browser at:
`http://localhost:3000` (automatically redirects to `login.html`).

### Run Automated Tests
```bash
node test.js
# or
npm test
```

---

## 2. Demo Accounts

| Role | Email | Password | Landing Page |
|---|---|---|---|
| **Instructor** | `instructor@test.com` | `admin123` | `admin.html` |
| **Student 1** | `student1@test.com` | `pass123` | `exam.html` |
| **Student 2** | `student2@test.com` | `pass123` | `exam.html` |
| **Student 3** | `student3@test.com` | `pass123` | `exam.html` |

---

## 3. 5-Step Demo Script

Follow these steps to demonstrate the full end-to-end cheating detection and instructor review workflow:

1. **Log in as Student:**
   - Open `http://localhost:3000/login.html`.
   - Enter `student1@test.com` / `pass123`.
   - Read the consent notice regarding camera and activity monitoring, check the agreement box, and click **Start Exam (Enter Fullscreen)**.
2. **Switch Tabs (`TAB_HIDDEN`):**
   - Press `Alt+Tab` or switch to another browser tab or application.
   - Return to the exam tab. A `TAB_HIDDEN` violation (+10 risk points) has been captured.
3. **Attempt Copy/Paste (`COPY_PASTE`):**
   - Attempt to select question text and press `Ctrl+C` (or right-click).
   - The red lockdown banner appears, blocking the action and logging `COPY_PASTE` (+5 points) and `RIGHT_CLICK` (+2 points).
4. **Exit Fullscreen (`FULLSCREEN_EXIT`):**
   - Press `Esc` to exit fullscreen.
   - A modal overlay immediately blocks the exam, requiring you to click **Return to Fullscreen** before continuing. This logs `FULLSCREEN_EXIT` (+10 points).
   - *(Optional: Cover your webcam for 10 seconds to trigger `NO_FACE` +5 points).*
5. **Inspect the HIGH Risk Flag on the Dashboard:**
   - In a separate browser tab or incognito window, log in as `instructor@test.com` / `admin123`.
   - On `admin.html`, see Student 1's attempt ranked at the top flagged with a **HIGH** risk badge in red.
   - Click the attempt row to open the timeline drawer. Inspect each recorded event with its exact timestamp and metadata.
   - Enter a finding in the **Review Decision & Notes** box and click **Mark Reviewed** to complete the human-in-the-loop audit.

---

## 4. Privacy & Ethics

CheckPoint follows privacy-first and ethical assessment principles:

- **Explicit Consent:** A mandatory consent screen explains monitoring policies before the webcam or fullscreen is initiated.
- **In-Browser Face Verification (Zero Video Storage):** Facial detection uses `@vladmandic/face-api` (TinyFaceDetector) running 100% locally in the student's browser. **No webcam video, snapshots, or images are ever stored on or transmitted to the server.** Only numeric face counts and timestamped violation events are recorded.
- **Human-in-the-Loop ("The system flags; humans decide"):** Risk scores serve purely as prioritization indicators for educators. No automated grade penalties or academic sanctions occur without instructor review. Instructors record notes, and students have an appeal field to explain anomalies.
- **Data Retention Policy:** Activity logs and attempt metadata are retained for **30 days** following exam submission for review and appeals, after which event logs are purged upon course archiving.

---

## 5. Known Limitations

- **Secondary Devices:** Smartphones, tablets, or secondary monitors situated completely outside the webcam field-of-view cannot be physically detected by single-camera browser software.
- **Off-Camera Assistance:** Whispering or off-camera helpers outside the frame cannot be eliminated without invasive multi-angle hardware surveillance.
- **Design Philosophy:** CheckPoint functions as an effective deterrent and evidentiary triage tool. It achieves optimal integrity when paired with higher-order, application-based assessment questions rather than simple recall prompts.
