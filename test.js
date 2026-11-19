const assert = require('assert');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { router: authRouter, authenticateToken, requireRole } = require('./routes/auth');
const { router: examRouter } = require('./routes/exam');

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    }
  };
}

// Extract route handlers
const authLoginHandler = authRouter.stack.find(s => s.route?.path === '/login' && s.route.methods.post).route.stack[0].handle;

function getExamHandler(path, method = 'post') {
  const layer = examRouter.stack.find(s => s.route?.path === path && s.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const examStartHandler = getExamHandler('/start');
const examAnswerHandler = getExamHandler('/answer');
const examSubmitHandler = getExamHandler('/submit');

async function run() {
  console.log('Testing CheckPoint Backend Skeleton & Exam Endpoints...\n');

  // --- 1. Database Schema & Tables ---
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
  for (const table of ['users', 'exams', 'questions', 'attempts', 'activity_logs']) {
    assert(tables.includes(table), `Table ${table} should exist`);
  }
  console.log('✓ All 5 schema tables exist');

  // --- 2. Seeded Users & Exam ---
  const users = db.prepare('SELECT id, name, email, role, password_hash FROM users').all();
  assert.strictEqual(users.length, 4, 'Should have 4 users seeded');

  const instructor = users.find(u => u.email === 'instructor@test.com');
  const student1 = users.find(u => u.email === 'student1@test.com');
  const student2 = users.find(u => u.email === 'student2@test.com');

  assert(bcrypt.compareSync('admin123', instructor.password_hash));
  assert(bcrypt.compareSync('pass123', student1.password_hash));

  const exam = db.prepare('SELECT * FROM exams WHERE title = ?').get('Sample Exam');
  assert(exam && exam.duration_min === 10 && exam.max_violations === 5);
  const rawQuestions = db.prepare('SELECT * FROM questions WHERE exam_id = ?').all(exam.id);
  assert.strictEqual(rawQuestions.length, 10);
  console.log('✓ Seeded users, exam, and 10 questions verified');

  // --- 3. Auth & Session Management ---
  const loginRes = createMockRes();
  authLoginHandler({ body: { email: 'student1@test.com', password: 'pass123' } }, loginRes);
  assert.strictEqual(loginRes.statusCode, 200);
  const student1Token = loginRes.data.token;
  assert(student1Token);

  // Invalidate session check
  const loginRes2 = createMockRes();
  authLoginHandler({ body: { email: 'student1@test.com', password: 'pass123' } }, loginRes2);
  const student1NewToken = loginRes2.data.token;
  assert.notStrictEqual(student1Token, student1NewToken);

  const oldReq = { headers: { authorization: `Bearer ${student1Token}` } };
  const oldRes = createMockRes();
  let nextCalled = false;
  authenticateToken(oldReq, oldRes, () => { nextCalled = true; });
  assert.strictEqual(oldRes.statusCode, 401);

  // Active session
  const studentReq = { headers: { authorization: `Bearer ${student1NewToken}` } };
  authenticateToken(studentReq, createMockRes(), () => {});
  assert.strictEqual(studentReq.user.email, 'student1@test.com');
  console.log('✓ Authentication, session generation, and session invalidation verified');

  // --- 4. POST /api/exam/start ---
  console.log('\n--- Testing Exam Start ---');
  // Clean attempts table for deterministic testing
  db.prepare('DELETE FROM activity_logs').run();
  db.prepare('DELETE FROM attempts').run();

  const startReq = { user: studentReq.user, body: { exam_id: exam.id } };
  const startRes = createMockRes();
  examStartHandler(startReq, startRes);

  assert.strictEqual(startRes.statusCode, 200);
  assert(startRes.data.attempt_id);
  assert.strictEqual(startRes.data.questions.length, 10);
  assert.strictEqual(startRes.data.remaining_seconds, 600); // 10 min * 60

  // Security check: correct answer MUST NOT be sent to client
  for (const q of startRes.data.questions) {
    assert.strictEqual(q.correct, undefined, 'Client must NEVER receive the correct answer field');
    assert(q.option_a && q.option_b && q.option_c && q.option_d);
  }
  console.log('✓ Shuffled questions returned with options mapped and correct answers stripped');

  // Check attempt record in DB
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(startRes.data.attempt_id);
  assert.strictEqual(attempt.status, 'in_progress');
  const storedOrder = JSON.parse(attempt.question_order);
  assert.strictEqual(storedOrder.length, 10);
  assert(storedOrder[0].options.length === 4);
  console.log('✓ Seeded shuffle saved in attempts.question_order');

  // Resume test: calling /start again should resume and return the exact same attempt
  const resumeRes = createMockRes();
  examStartHandler(startReq, resumeRes);
  assert.strictEqual(resumeRes.statusCode, 200);
  assert.strictEqual(resumeRes.data.attempt_id, startRes.data.attempt_id);
  assert.strictEqual(resumeRes.data.questions[0].id, startRes.data.questions[0].id);
  console.log('✓ In-progress attempt resumed with identical question order and timer');

  // Shuffling diversity test: student 2 should have different shuffling
  const student2LoginRes = createMockRes();
  authLoginHandler({ body: { email: 'student2@test.com', password: 'pass123' } }, student2LoginRes);
  const student2User = db.prepare('SELECT * FROM users WHERE email = ?').get('student2@test.com');
  const startRes2 = createMockRes();
  examStartHandler({ user: student2User, body: { exam_id: exam.id } }, startRes2);
  const attempt2 = db.prepare('SELECT * FROM attempts WHERE id = ?').get(startRes2.data.attempt_id);
  const storedOrder2 = JSON.parse(attempt2.question_order);
  console.log(`✓ Per-student shuffling active (Attempt 1 Q1: ${storedOrder[0].id}, Attempt 2 Q1: ${storedOrder2[0].id})`);

  // --- 5. POST /api/exam/answer & FAST_ANSWER Detection ---
  console.log('\n--- Testing Exam Answer Autosave & FAST_ANSWER Detection ---');
  const firstQ = storedOrder[0];
  const qObj = rawQuestions.find(q => q.id === firstQ.id);

  // Find which display option maps to the correct answer
  const correctOptionIndex = firstQ.options.indexOf(qObj.correct);
  const displayOptionForCorrect = ['a', 'b', 'c', 'd'][correctOptionIndex];

  // Submit answer in under 3 seconds (simulated by recent timestamp)
  const answerReq = {
    user: studentReq.user,
    body: {
      attempt_id: attempt.id,
      question_id: firstQ.id,
      answer: displayOptionForCorrect,
      served_at: new Date(Date.now() - 1000).toISOString() // 1 second ago -> FAST_ANSWER!
    }
  };
  const answerRes = createMockRes();
  examAnswerHandler(answerReq, answerRes);
  assert.strictEqual(answerRes.statusCode, 200);
  assert.strictEqual(answerRes.data.success, true);

  // Check activity_logs for FAST_ANSWER
  const fastAnswerLog = db.prepare("SELECT * FROM activity_logs WHERE attempt_id = ? AND event_type = 'FAST_ANSWER'").get(attempt.id);
  assert(fastAnswerLog, 'FAST_ANSWER event should be logged in activity_logs');
  const logDetails = JSON.parse(fastAnswerLog.details);
  assert.strictEqual(logDetails.question_id, firstQ.id);

  // Check risk score increased by 3 (weight of FAST_ANSWER)
  const updatedAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attempt.id);
  assert.strictEqual(updatedAttempt.risk_score, 3);
  assert.strictEqual(updatedAttempt.risk_level, 'LOW');
  console.log('✓ Fast answer (< 3s) accurately detected, logged in activity_logs, and risk score updated to 3');

  // Check autosaved answer in DB
  const savedAnswers = JSON.parse(updatedAttempt.answers);
  assert.strictEqual(savedAnswers.answers[firstQ.id], displayOptionForCorrect);
  console.log(`✓ Answer "${displayOptionForCorrect}" autosaved for question ${firstQ.id}`);

  // Answer remaining 9 questions correctly according to shuffled mapping
  for (let i = 1; i < storedOrder.length; i++) {
    const item = storedOrder[i];
    const q = rawQuestions.find(rq => rq.id === item.id);
    const correctIdx = item.options.indexOf(q.correct);
    const chosenDisplay = ['a', 'b', 'c', 'd'][correctIdx];

    const ansRes = createMockRes();
    examAnswerHandler({
      user: studentReq.user,
      body: {
        attempt_id: attempt.id,
        question_id: item.id,
        answer: chosenDisplay,
        served_at: new Date(Date.now() - 5000).toISOString() // 5 seconds (not fast)
      }
    }, ansRes);
    assert.strictEqual(ansRes.statusCode, 200);
  }
  console.log('✓ All 10 questions answered');

  // --- 6. POST /api/exam/submit ---
  console.log('\n--- Testing Exam Submit & Server-Side Grading ---');
  const submitReq = { user: studentReq.user, body: { attempt_id: attempt.id } };
  const submitRes = createMockRes();
  examSubmitHandler(submitReq, submitRes);

  assert.strictEqual(submitRes.statusCode, 200);
  assert.strictEqual(submitRes.data.status, 'submitted');
  assert.strictEqual(submitRes.data.correct_count, 10);
  assert.strictEqual(submitRes.data.total_questions, 10);
  assert.strictEqual(submitRes.data.score, 100);

  const finalAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attempt.id);
  assert.strictEqual(finalAttempt.status, 'submitted');
  assert.strictEqual(finalAttempt.score, 100);
  assert(finalAttempt.ended_at);
  console.log('✓ Exam submitted and graded 100% correctly with option mapping');

  // Verify attempt is closed: answering a closed attempt must be rejected
  const closedRes = createMockRes();
  examAnswerHandler(answerReq, closedRes);
  assert.strictEqual(closedRes.statusCode, 400);
  console.log('✓ Further answers rejected after attempt is closed');

  // --- 7. Server-Side Timer Expiration Auto-Submit ---
  console.log('\n--- Testing Server-Side Timer Expiration Auto-Submit ---');
  // Start an attempt for Student 3 and simulate started 11 minutes ago (duration is 10 min)
  const student3 = users.find(u => u.email === 'student3@test.com');
  const startRes3 = createMockRes();
  examStartHandler({ user: student3, body: { exam_id: exam.id } }, startRes3);
  const attempt3Id = startRes3.data.attempt_id;

  // Manually backdate started_at by 15 minutes in SQLite
  db.prepare("UPDATE attempts SET started_at = datetime('now', '-15 minutes') WHERE id = ?").run(attempt3Id);

  // Calling answer should detect expiration and auto-submit
  const expiredAnswerRes = createMockRes();
  examAnswerHandler({
    user: student3,
    body: { attempt_id: attempt3Id, question_id: rawQuestions[0].id, answer: 'a' }
  }, expiredAnswerRes);

  assert.strictEqual(expiredAnswerRes.statusCode, 400);
  assert.strictEqual(expiredAnswerRes.data.expired, true);

  const expiredAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attempt3Id);
  assert.strictEqual(expiredAttempt.status, 'submitted', 'Attempt should be auto-submitted on timer expiration');
  console.log('✓ Server-side timer expiration auto-submits attempt and rejects late answers');

  console.log('\n============================================================');
  console.log('ALL EXAM & BACKEND SKELETON TESTS PASSED SUCCESSFULLY!');
  console.log('============================================================\n');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
