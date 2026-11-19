const assert = require('assert');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { router: authRouter, authenticateToken, requireRole } = require('./routes/auth');
const { router: examRouter } = require('./routes/exam');
const { router: eventsRouter } = require('./routes/events');
const { router: adminRouter } = require('./routes/admin');
const { WEIGHTS, HIGH_SEVERITY_EVENTS, computeRisk, checkSimilarity } = require('./riskEngine');

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
    },
    send(payload) {
      this.data = payload;
      return this;
    },
    setHeader(key, val) {
      this.headers[key] = val;
    }
  };
}

// Extract route handlers
const authLoginHandler = authRouter.stack.find(s => s.route?.path === '/login' && s.route.methods.post).route.stack[0].handle;

function getHandler(router, path, method = 'post') {
  const layer = router.stack.find(s => s.route?.path === path && s.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const examStartHandler = getHandler(examRouter, '/start');
const examAnswerHandler = getHandler(examRouter, '/answer');
const examSubmitHandler = getHandler(examRouter, '/submit');
const eventsHandler = getHandler(eventsRouter, '/');

async function run() {
  console.log('Testing CheckPoint Risk Engine, Events, and Anti-Cheating Controls...\n');

  // --- 1. Verify WEIGHTS & HIGH_SEVERITY_EVENTS ---
  console.log('--- 1. Testing Risk Weights Configuration & Public Assets ---');
  assert.strictEqual(WEIGHTS.TAB_HIDDEN, 10);
  assert.strictEqual(WEIGHTS.WINDOW_BLUR, 5);
  assert.strictEqual(WEIGHTS.FULLSCREEN_EXIT, 10);
  assert.strictEqual(WEIGHTS.COPY_PASTE, 5);
  assert.strictEqual(WEIGHTS.RIGHT_CLICK, 2);
  assert.strictEqual(WEIGHTS.DEVTOOLS_KEY, 5);
  assert.strictEqual(WEIGHTS.NO_FACE, 5);
  assert.strictEqual(WEIGHTS.MULTI_FACE, 15);
  assert.strictEqual(WEIGHTS.IDLE, 2);
  assert.strictEqual(WEIGHTS.FAST_ANSWER, 3);
  assert.strictEqual(WEIGHTS.SECOND_SESSION, 15);
  assert.strictEqual(WEIGHTS.SIMILAR_ANSWERS, 20);

  const fs = require('fs');
  for (const file of ['public/login.html', 'public/exam.html', 'public/admin.html', 'public/js/lockdown.js', 'public/js/monitor.js', 'public/js/face.js', 'public/js/exam.js', 'public/js/admin.js']) {
    assert(fs.existsSync(file), `Static file ${file} should exist`);
  }
  console.log('✓ All 12 event types match ARCHITECTURE.md and all frontend files (including admin dashboard) exist');

  // --- 2. Clean DB and prepare users & exam ---
  db.prepare('DELETE FROM activity_logs').run();
  db.prepare('DELETE FROM attempts').run();

  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@test.com'").get();
  const student2 = db.prepare("SELECT * FROM users WHERE email = 'student2@test.com'").get();
  const exam = db.prepare("SELECT * FROM exams WHERE title = 'Sample Exam'").get();
  const rawQuestions = db.prepare('SELECT * FROM questions WHERE exam_id = ?').all(exam.id);

  // Authenticate student 1
  const loginRes = createMockRes();
  authLoginHandler({ body: { email: 'student1@test.com', password: 'pass123' } }, loginRes);
  const student1Token = loginRes.data.token;
  const student1Req = { user: db.prepare('SELECT * FROM users WHERE id = ?').get(student1.id) };

  // --- 3. Start Exam & Test POST /api/events ---
  console.log('\n--- 2. Testing POST /api/events & Risk Levels ---');
  const startRes = createMockRes();
  examStartHandler({ user: student1Req.user, body: { exam_id: exam.id } }, startRes);
  const attemptId = startRes.data.attempt_id;

  // Test invalid event_type rejection
  const invalidEventRes = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'UNKNOWN_EVENT', attempt_id: attemptId } }, invalidEventRes);
  assert.strictEqual(invalidEventRes.statusCode, 400);
  console.log('✓ Invalid event types rejected with 400');

  // Log WINDOW_BLUR (weight: 5)
  const blurRes = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'WINDOW_BLUR', attempt_id: attemptId } }, blurRes);
  assert.strictEqual(blurRes.statusCode, 200);
  assert.strictEqual(blurRes.data.risk_level, 'LOW');
  assert.strictEqual(blurRes.data.violations, 0); // Not a high-severity event

  let att = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  assert.strictEqual(att.risk_score, 5);
  assert.strictEqual(att.risk_level, 'LOW');
  console.log('✓ WINDOW_BLUR logged (score: 5, level: LOW)');

  // Log MULTI_FACE (weight: 15, high severity violation)
  const faceRes1 = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'MULTI_FACE', attempt_id: attemptId } }, faceRes1);
  assert.strictEqual(faceRes1.data.violations, 1);
  att = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  assert.strictEqual(att.risk_score, 20); // 5 + 15 = 20
  assert.strictEqual(att.risk_level, 'LOW');
  console.log('✓ MULTI_FACE logged (score: 20, level: LOW, high-severity violations: 1)');

  // Log TAB_HIDDEN (weight: 10, high severity violation)
  // Score becomes 30 (still LOW)
  const tabRes1 = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'TAB_HIDDEN', attempt_id: attemptId } }, tabRes1);
  assert.strictEqual(tabRes1.data.violations, 2);
  att = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  assert.strictEqual(att.risk_score, 30);
  assert.strictEqual(att.risk_level, 'LOW');

  // Log RIGHT_CLICK (weight: 2) -> Score becomes 32 -> MEDIUM (31-60)
  const rcRes = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'RIGHT_CLICK', attempt_id: attemptId } }, rcRes);
  assert.strictEqual(rcRes.data.risk_level, 'MEDIUM');
  att = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  assert.strictEqual(att.risk_score, 32);
  assert.strictEqual(att.risk_level, 'MEDIUM');
  console.log('✓ Threshold reached: Score 32 -> risk_level updated to MEDIUM');

  // --- 4. Testing SECOND_SESSION Event on Concurrent Login ---
  console.log('\n--- 3. Testing SECOND_SESSION Detection During Active Exam ---');
  // Student 1 logs in from a 2nd session while exam is in_progress
  const secondLoginRes = createMockRes();
  authLoginHandler({ body: { email: 'student1@test.com', password: 'pass123' } }, secondLoginRes);
  assert.strictEqual(secondLoginRes.statusCode, 200);

  // Check activity_logs for SECOND_SESSION
  const secondSessionLog = db.prepare("SELECT * FROM activity_logs WHERE attempt_id = ? AND event_type = 'SECOND_SESSION'").get(attemptId);
  assert(secondSessionLog, 'SECOND_SESSION event should be inserted into activity_logs');
  att = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  // Score was 32, + 15 (SECOND_SESSION) = 47
  assert.strictEqual(att.risk_score, 47);
  console.log('✓ SECOND_SESSION detected on concurrent login, logged with weight 15 (score: 47)');

  // Log more events to cross into HIGH (61+)
  // FULLSCREEN_EXIT (weight: 10) -> score 57 (violations: 3)
  const fsRes = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'FULLSCREEN_EXIT', attempt_id: attemptId } }, fsRes);
  assert.strictEqual(fsRes.data.violations, 3);

  // COPY_PASTE (weight: 5) -> score 62 -> HIGH
  const cpRes = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'COPY_PASTE', attempt_id: attemptId } }, cpRes);
  assert.strictEqual(cpRes.data.risk_level, 'HIGH');
  att = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  assert.strictEqual(att.risk_score, 62);
  assert.strictEqual(att.risk_level, 'HIGH');
  console.log('✓ Threshold reached: Score 62 -> risk_level updated to HIGH');

  // --- 5. High-Severity Violations Auto-Submit Threshold ---
  console.log('\n--- 4. Testing High-Severity Violations Auto-Submit Threshold ---');
  // Currently violations: 3 (MULTI_FACE, TAB_HIDDEN, FULLSCREEN_EXIT)
  // Max allowed violations in Sample Exam is 5.
  // 4th high severity violation:
  const fsRes4 = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'FULLSCREEN_EXIT', attempt_id: attemptId } }, fsRes4);
  assert.strictEqual(fsRes4.data.violations, 4);
  assert.strictEqual(fsRes4.data.autoSubmitted, undefined);

  // 5th high severity violation (reaches max_violations = 5):
  const fsRes5 = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'TAB_HIDDEN', attempt_id: attemptId } }, fsRes5);
  assert.strictEqual(fsRes5.data.violations, 5);
  assert.strictEqual(fsRes5.data.autoSubmitted, true);
  console.log('✓ 5th violation triggered automatic submission (autoSubmitted: true)');

  att = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  assert.strictEqual(att.status, 'submitted');
  assert(att.ended_at);
  console.log('✓ Attempt closed and sealed as submitted');

  // Further events on closed attempt rejected
  const closedEventRes = createMockRes();
  eventsHandler({ user: student1Req.user, body: { event_type: 'WINDOW_BLUR', attempt_id: attemptId } }, closedEventRes);
  assert.strictEqual(closedEventRes.statusCode, 400);
  console.log('✓ Closed attempt rejects further event logging');

  // --- 6. Testing checkSimilarity(examId) for Shared Wrong Answers ---
  console.log('\n--- 5. Testing checkSimilarity Pairwise Collusion Detection ---');
  // Clean attempts for a clean 2-student collusion test
  db.prepare('DELETE FROM activity_logs').run();
  db.prepare('DELETE FROM attempts').run();

  // Student 1 starts exam
  const s1StartRes = createMockRes();
  examStartHandler({ user: student1, body: { exam_id: exam.id } }, s1StartRes);
  const s1AttemptId = s1StartRes.data.attempt_id;
  const s1Attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(s1AttemptId);
  const s1Order = JSON.parse(s1Attempt.question_order);

  // Student 2 starts exam
  const s2StartRes = createMockRes();
  examStartHandler({ user: student2, body: { exam_id: exam.id } }, s2StartRes);
  const s2AttemptId = s2StartRes.data.attempt_id;
  const s2Attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(s2AttemptId);
  const s2Order = JSON.parse(s2Attempt.question_order);

  // Pick 3 questions to share the exact same WRONG original option
  // Let questions 0, 1, 2 be answered with the SAME wrong option for both students
  const optionKeys = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 3; i++) {
    const qId = rawQuestions[i].id;
    const correctOpt = rawQuestions[i].correct;
    // Choose a wrong original option: if correct is 'a', choose 'b', otherwise 'a'
    const wrongOriginalOpt = (correctOpt === 'a') ? 'b' : 'a';

    // Student 1 answer (served 5s ago so not a FAST_ANSWER)
    const s1Item = s1Order.find(item => item.id === qId);
    const s1DisplayIdx = s1Item.options.indexOf(wrongOriginalOpt);
    const s1DisplayOpt = optionKeys[s1DisplayIdx];
    examAnswerHandler({
      user: student1,
      body: {
        attempt_id: s1AttemptId,
        question_id: qId,
        answer: s1DisplayOpt,
        served_at: new Date(Date.now() - 5000).toISOString()
      }
    }, createMockRes());

    // Student 2 answer (served 5s ago so not a FAST_ANSWER)
    const s2Item = s2Order.find(item => item.id === qId);
    const s2DisplayIdx = s2Item.options.indexOf(wrongOriginalOpt);
    const s2DisplayOpt = optionKeys[s2DisplayIdx];
    examAnswerHandler({
      user: student2,
      body: {
        attempt_id: s2AttemptId,
        question_id: qId,
        answer: s2DisplayOpt,
        served_at: new Date(Date.now() - 5000).toISOString()
      }
    }, createMockRes());
  }

  // Submit Student 1
  examSubmitHandler({ user: student1, body: { attempt_id: s1AttemptId } }, createMockRes());

  // At this point, only 1 attempt is submitted, so similarity check shouldn't trigger yet
  let s1SimilarLog = db.prepare("SELECT * FROM activity_logs WHERE attempt_id = ? AND event_type = 'SIMILAR_ANSWERS'").get(s1AttemptId);
  assert(!s1SimilarLog, 'No similarity event with only 1 submitted attempt');

  // Submit Student 2 -> Triggers checkSimilarity(exam.id)
  examSubmitHandler({ user: student2, body: { attempt_id: s2AttemptId } }, createMockRes());

  // Now both attempts should have SIMILAR_ANSWERS event!
  s1SimilarLog = db.prepare("SELECT * FROM activity_logs WHERE attempt_id = ? AND event_type = 'SIMILAR_ANSWERS'").get(s1AttemptId);
  const s2SimilarLog = db.prepare("SELECT * FROM activity_logs WHERE attempt_id = ? AND event_type = 'SIMILAR_ANSWERS'").get(s2AttemptId);

  assert(s1SimilarLog, 'Student 1 should have SIMILAR_ANSWERS logged');
  assert(s2SimilarLog, 'Student 2 should have SIMILAR_ANSWERS logged');

  const s1Details = JSON.parse(s1SimilarLog.details);
  assert.strictEqual(s1Details.shared_wrong_count, 3);
  assert.strictEqual(s1Details.paired_attempt_id, s2AttemptId);

  const s1FinalAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(s1AttemptId);
  const s2FinalAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(s2AttemptId);

  assert.strictEqual(s1FinalAttempt.risk_score, 20); // SIMILAR_ANSWERS weight = 20
  assert.strictEqual(s2FinalAttempt.risk_score, 20);
  console.log('✓ Pairwise collusion check detected 3 shared wrong answers; SIMILAR_ANSWERS (weight 20) added to both students');

  // --- 6. Testing Admin Endpoints (Instructor Only) ---
  console.log('\n--- 6. Testing Admin Endpoints (Instructor Only) ---');
  const instructor = db.prepare("SELECT * FROM users WHERE email = 'instructor@test.com'").get();
  const adminReq = { user: instructor };

  const adminAttemptsHandler = getHandler(adminRouter, '/attempts', 'get');
  const adminAttemptDetailHandler = getHandler(adminRouter, '/attempts/:id', 'get');
  const adminReviewHandler = getHandler(adminRouter, '/attempts/:id/review', 'post');
  const adminExportCsvHandler = getHandler(adminRouter, '/export.csv', 'get');

  // 1. GET /api/admin/attempts
  const attemptsRes = createMockRes();
  adminAttemptsHandler(adminReq, attemptsRes);
  assert.strictEqual(attemptsRes.statusCode, 200);
  assert(Array.isArray(attemptsRes.data), 'Expected array of attempts');
  assert(attemptsRes.data.length >= 2, 'Should list both student attempts');
  const att1Summary = attemptsRes.data.find(a => a.id === s1AttemptId);
  assert(att1Summary, 'Attempt 1 must be present in admin list');
  assert.strictEqual(att1Summary.student_name, 'Student 1');
  assert.strictEqual(att1Summary.risk_level, 'LOW');
  assert(att1Summary.event_count >= 1, 'Should include count of events');
  console.log(`✓ GET /api/admin/attempts returned ${attemptsRes.data.length} attempts with metrics`);

  // 2. GET /api/admin/attempts/:id
  const detailRes = createMockRes();
  adminAttemptDetailHandler({ user: instructor, params: { id: s1AttemptId } }, detailRes);
  assert.strictEqual(detailRes.statusCode, 200);
  assert(detailRes.data.attempt, 'Should include attempt details');
  assert(Array.isArray(detailRes.data.logs), 'Should include activity logs timeline');
  assert(detailRes.data.logs.some(l => l.event_type === 'SIMILAR_ANSWERS'), 'Timeline should include SIMILAR_ANSWERS');
  console.log(`✓ GET /api/admin/attempts/:id returned attempt with ${detailRes.data.logs.length} timeline events`);

  // 3. POST /api/admin/attempts/:id/review
  const reviewRes = createMockRes();
  adminReviewHandler({ user: instructor, params: { id: s1AttemptId }, body: { note: 'Confirmed collusion on Q1-Q3' } }, reviewRes);
  assert.strictEqual(reviewRes.statusCode, 200);
  assert.strictEqual(reviewRes.data.reviewed, 1);
  assert.strictEqual(reviewRes.data.review_note, 'Confirmed collusion on Q1-Q3');

  const reviewedAtt = db.prepare('SELECT reviewed, review_note FROM attempts WHERE id = ?').get(s1AttemptId);
  assert.strictEqual(reviewedAtt.reviewed, 1);
  assert.strictEqual(reviewedAtt.review_note, 'Confirmed collusion on Q1-Q3');
  console.log('✓ POST /api/admin/attempts/:id/review marked attempt as reviewed and saved note');

  // 4. GET /api/admin/export.csv
  const csvRes = createMockRes();
  adminExportCsvHandler(adminReq, csvRes);
  assert.strictEqual(csvRes.statusCode, 200);
  assert.strictEqual(csvRes.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert(typeof csvRes.data === 'string', 'Expected CSV string output');
  assert(csvRes.data.includes('Attempt ID,Student Name,Student Email'), 'CSV should contain correct headers');
  assert(csvRes.data.includes('Student 1'), 'CSV should contain Student 1 record');
  console.log('✓ GET /api/admin/export.csv successfully generated and formatted CSV export');

  console.log('\n============================================================');
  console.log('ALL RISK ENGINE, EVENTS, COLLUSION & ADMIN TESTS PASSED!');
  console.log('============================================================\n');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
