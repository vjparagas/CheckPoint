/**
 * CheckPoint - Automated Test Script (node test.js)
 * Tests student authentication, exam initialization, behavior event logging,
 * and asserts that accumulated violation events transition the risk level to HIGH.
 */

const assert = require('assert');
const db = require('./db');
const { router: authRouter } = require('./routes/auth');
const { router: examRouter } = require('./routes/exam');
const { router: eventsRouter } = require('./routes/events');

// Helper to mock Express response objects
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

// Extract route handlers from routers
function getHandler(router, path, method = 'post') {
  const layer = router.stack.find(s => s.route?.path === path && s.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const loginHandler = getHandler(authRouter, '/login', 'post');
const startHandler = getHandler(examRouter, '/start', 'post');
const eventsHandler = getHandler(eventsRouter, '/', 'post');

async function run() {
  console.log('====================================================');
  console.log('   CheckPoint Integrity System: Verification Test   ');
  console.log('====================================================\n');

  // Clean attempts & logs to ensure a fresh test run
  db.prepare('DELETE FROM activity_logs').run();
  db.prepare('DELETE FROM attempts').run();

  // 1. Log in as a student
  console.log('Step 1: Logging in as student (student1@test.com)...');
  const loginRes = createMockRes();
  loginHandler({
    body: { email: 'student1@test.com', password: 'pass123' }
  }, loginRes);

  assert.strictEqual(loginRes.statusCode, 200, 'Login should succeed with status 200');
  assert(loginRes.data.token, 'A session token must be returned');
  const studentUser = db.prepare('SELECT * FROM users WHERE email = ?').get('student1@test.com');
  const studentReq = { user: studentUser };
  console.log(`✓ Student authenticated. Token: ${loginRes.data.token.slice(0, 8)}... (Role: ${studentUser.role})\n`);

  // 2. Start an exam
  console.log('Step 2: Starting "Sample Exam" for the student...');
  const exam = db.prepare("SELECT * FROM exams WHERE title = 'Sample Exam'").get();
  assert(exam, 'Sample Exam must exist in database');

  const startRes = createMockRes();
  startHandler({
    user: studentReq.user,
    body: { exam_id: exam.id }
  }, startRes);

  assert.strictEqual(startRes.statusCode, 200, 'Exam start should succeed with status 200');
  const attemptId = startRes.data.attempt_id;
  assert(attemptId, 'Attempt ID must be returned');
  assert.strictEqual(startRes.data.questions.length, 10, 'Exam should return 10 questions');

  // Verify initial attempt state
  let attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  assert.strictEqual(attempt.risk_score, 0, 'Initial risk score should be 0');
  assert.strictEqual(attempt.risk_level, 'LOW', 'Initial risk level should be LOW');
  console.log(`✓ Exam attempt #${attemptId} created. Initial Risk: ${attempt.risk_level} (${attempt.risk_score} pts)\n`);

  // 3. Post several behavior events
  console.log('Step 3: Posting behavior events to /api/events...');

  const eventsToPost = [
    { type: 'TAB_HIDDEN', weight: 10, details: { message: 'Switched to search engine' } },
    { type: 'FULLSCREEN_EXIT', weight: 10, details: { message: 'Exited fullscreen mode' } },
    { type: 'MULTI_FACE', weight: 15, details: { message: '2 faces detected in frame' } },
    { type: 'SECOND_SESSION', weight: 15, details: { message: 'Second device logged into session' } },
    { type: 'MULTI_FACE', weight: 15, details: { message: 'Multiple individuals in view' } }
  ];

  let cumulativeScore = 0;
  for (let i = 0; i < eventsToPost.length; i++) {
    const evt = eventsToPost[i];
    cumulativeScore += evt.weight;

    const res = createMockRes();
    eventsHandler({
      user: studentReq.user,
      body: {
        attempt_id: attemptId,
        event_type: evt.type,
        details: evt.details
      }
    }, res);

    assert.strictEqual(res.statusCode, 200, `Event ${evt.type} should be accepted`);
    console.log(`  [+${evt.weight} pts] Logged ${evt.type.padEnd(16)} -> Total Risk: ${cumulativeScore} pts (Level: ${res.data.risk_level})`);
  }

  // 4. Query database and assert that risk level changed to HIGH
  console.log('\nStep 4: Asserting that risk level has escalated to HIGH...');
  attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);

  console.log(`Final Attempt State: Risk Score = ${attempt.risk_score}, Risk Level = ${attempt.risk_level}`);
  assert.strictEqual(attempt.risk_score, 65, 'Risk score should equal sum of event weights (65)');
  assert.strictEqual(attempt.risk_level, 'HIGH', 'Risk level must transition to HIGH when score >= 61');

  // Verify activity_logs table holds all 5 events
  const logCount = db.prepare('SELECT COUNT(*) as count FROM activity_logs WHERE attempt_id = ?').get(attemptId).count;
  assert.strictEqual(logCount, 5, 'activity_logs should record all 5 posted events');
  console.log('✓ Verified: Risk level is HIGH (65 pts) with 5 evidence events recorded in activity_logs.');

  console.log('\n====================================================');
  console.log('            ALL ASSERTIONS PASSED! ✓                ');
  console.log('====================================================\n');
}

run().catch(err => {
  console.error('\n❌ Test assertion failed:', err);
  process.exit(1);
});
