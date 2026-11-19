const assert = require('assert');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { router, authenticateToken, requireRole } = require('./routes/auth');

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

const loginRoute = router.stack.find(s => s.route && s.route.path === '/login' && s.route.methods.post);
const loginHandler = loginRoute.route.stack[0].handle;

async function run() {
  console.log('Testing CheckPoint Backend Skeleton...\n');

  // 1. Database Schema & Tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
  for (const table of ['users', 'exams', 'questions', 'attempts', 'activity_logs']) {
    assert(tables.includes(table), `Table ${table} should exist`);
  }
  console.log('✓ All 5 schema tables exist');

  // 2. Seeded Users
  const users = db.prepare('SELECT id, name, email, role, password_hash FROM users').all();
  assert.strictEqual(users.length, 4, 'Should have 4 users seeded');

  const instructor = users.find(u => u.email === 'instructor@test.com');
  assert(instructor && instructor.role === 'instructor');
  assert(bcrypt.compareSync('admin123', instructor.password_hash), 'Instructor password should match admin123');

  for (let i = 1; i <= 3; i++) {
    const student = users.find(u => u.email === `student${i}@test.com`);
    assert(student && student.role === 'student');
    assert(bcrypt.compareSync('pass123', student.password_hash), `Student ${i} password should match pass123`);
  }
  console.log('✓ Seeded instructor and 3 students verified with bcrypt hashes');

  // 3. Seeded Exam & Questions
  const exam = db.prepare('SELECT * FROM exams WHERE title = ?').get('Sample Exam');
  assert(exam, 'Sample Exam should exist');
  assert.strictEqual(exam.duration_min, 10);
  assert.strictEqual(exam.max_violations, 5);

  const questions = db.prepare('SELECT * FROM questions WHERE exam_id = ?').all(exam.id);
  assert.strictEqual(questions.length, 10, 'Sample Exam should have 10 questions');
  console.log('✓ Seeded "Sample Exam" (10 min, max 5 violations) with 10 questions verified');

  // 4. POST /api/auth/login
  const loginRes = createMockRes();
  loginHandler({ body: { email: 'student1@test.com', password: 'pass123' } }, loginRes);
  assert.strictEqual(loginRes.statusCode, 200);
  const token1 = loginRes.data.token;
  assert(token1, 'Session token should be returned');

  // Test session invalidation: logging in again replaces token
  const loginRes2 = createMockRes();
  loginHandler({ body: { email: 'student1@test.com', password: 'pass123' } }, loginRes2);
  const token2 = loginRes2.data.token;
  assert.notStrictEqual(token1, token2, 'New login should generate a fresh token');

  // 5. Auth Middleware
  // Old token should be rejected (invalidated session)
  const oldReq = { headers: { authorization: `Bearer ${token1}` } };
  const oldRes = createMockRes();
  let nextCalled = false;
  authenticateToken(oldReq, oldRes, () => { nextCalled = true; });
  assert.strictEqual(oldRes.statusCode, 401, 'Old session should be rejected');
  assert(!nextCalled);

  // New token should be accepted
  const newReq = { headers: { authorization: `Bearer ${token2}` } };
  const newRes = createMockRes();
  authenticateToken(newReq, newRes, () => { nextCalled = true; });
  assert(nextCalled);
  assert.strictEqual(newReq.user.email, 'student1@test.com');
  console.log('✓ Login generates session token and invalidates previous session');

  // 6. requireRole Helper
  const requireInstructor = requireRole('instructor');
  const forbiddenRes = createMockRes();
  nextCalled = false;
  requireInstructor(newReq, forbiddenRes, () => { nextCalled = true; });
  assert.strictEqual(forbiddenRes.statusCode, 403, 'Student should be forbidden from instructor role');
  assert(!nextCalled);
  console.log('✓ requireRole helper strictly blocks role mismatches');

  console.log('\nAll verification checks passed successfully.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
