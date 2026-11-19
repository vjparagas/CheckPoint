const express = require('express');
const db = require('../db');
const { authenticateToken, requireRole } = require('./auth');

const router = express.Router();

// Strict student-only protection for all exam endpoints
router.use(authenticateToken, requireRole('student'));

/**
 * Parses SQLite timestamp strings (UTC) into epoch milliseconds reliably.
 */
function parseSqliteDate(dateStr) {
  if (!dateStr) return Date.now();
  if (dateStr.includes('T') && dateStr.endsWith('Z')) return new Date(dateStr).getTime();
  return new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Fisher-Yates array shuffle helper.
 * Shuffles questions and answer choices uniquely per student attempt.
 */
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Calculates risk level string from numeric risk score based on ARCHITECTURE.md:
 * 0–30  -> LOW
 * 31–60 -> MEDIUM
 * 61+   -> HIGH
 */
function getRiskLevel(score) {
  if (score >= 61) return 'HIGH';
  if (score >= 31) return 'MEDIUM';
  return 'LOW';
}

/**
 * Server-side grading & attempt finalization helper.
 * Never trusts client score or time:
 * Reads question_order from database, maps student answers back to original option keys,
 * compares against actual correct answer in questions table, and records score.
 */
function gradeAndSubmitAttempt(attemptId) {
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt) return null;

  if (attempt.status === 'submitted') {
    return {
      status: 'submitted',
      score: attempt.score,
      already_submitted: true
    };
  }

  const questionOrder = JSON.parse(attempt.question_order || '[]');
  const answersData = JSON.parse(attempt.answers || '{}');
  const studentAnswers = answersData.answers || answersData; // handles flat map or wrapped format

  const questions = db.prepare('SELECT * FROM questions WHERE exam_id = ?').all(attempt.exam_id);
  const questionMap = new Map(questions.map(q => [q.id, q]));

  let correctCount = 0;
  const optionKeys = ['a', 'b', 'c', 'd'];

  for (const item of questionOrder) {
    const q = questionMap.get(item.id);
    if (!q) continue;

    const studentChoice = studentAnswers[item.id];
    if (studentChoice) {
      const selectedIndex = optionKeys.indexOf(studentChoice.toLowerCase());
      if (selectedIndex !== -1 && item.options && item.options[selectedIndex]) {
        // Map student's displayed option back to original question option
        const originalSelected = item.options[selectedIndex];
        if (originalSelected === q.correct) {
          correctCount++;
        }
      }
    }
  }

  const totalQuestions = questions.length;
  const score = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100 * 10) / 10 : 0;

  db.prepare(`
    UPDATE attempts
    SET status = 'submitted', score = ?, ended_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(score, attemptId);

  return {
    status: 'submitted',
    score,
    correct_count: correctCount,
    total_questions: totalQuestions,
    already_submitted: false
  };
}

/**
 * POST /api/exam/start
 * Security & Anti-cheating features:
 * 1. Shuffles question order AND answer options per student.
 * 2. Saves seeded shuffle in attempts.question_order for reproducible server-side grading.
 * 3. Correct answers are stripped so students cannot inspect client memory/DOM to cheat.
 * 4. Timer is strictly computed and enforced on the server.
 */
router.post('/start', (req, res) => {
  const userId = req.user.id;
  let examId = req.body.exam_id;

  // Default to first exam if not specified
  const exam = examId
    ? db.prepare('SELECT * FROM exams WHERE id = ?').get(examId)
    : db.prepare('SELECT * FROM exams ORDER BY id ASC LIMIT 1').get();

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  const totalSeconds = exam.duration_min * 60;

  // Check for existing in-progress attempt for this student and exam
  let attempt = db.prepare(`
    SELECT * FROM attempts
    WHERE user_id = ? AND exam_id = ? AND status = 'in_progress'
    ORDER BY id DESC LIMIT 1
  `).get(userId, exam.id);

  if (attempt) {
    // Server-side elapsed time check
    const startedAt = parseSqliteDate(attempt.started_at);
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);

    if (remainingSeconds <= 0) {
      // Time expired: auto-submit server-side
      const result = gradeAndSubmitAttempt(attempt.id);
      return res.json({
        message: 'Exam time expired; attempt auto-submitted',
        attempt_id: attempt.id,
        status: 'submitted',
        score: result.score,
        remaining_seconds: 0
      });
    }

    // Resume in-progress attempt with stored question order
    const questionOrder = JSON.parse(attempt.question_order);
    const rawQuestions = db.prepare('SELECT * FROM questions WHERE exam_id = ?').all(exam.id);
    const questionMap = new Map(rawQuestions.map(q => [q.id, q]));

    const questions = questionOrder.map(item => {
      const q = questionMap.get(item.id);
      return {
        id: q.id,
        text: q.text,
        option_a: q[`option_${item.options[0]}`],
        option_b: q[`option_${item.options[1]}`],
        option_c: q[`option_${item.options[2]}`],
        option_d: q[`option_${item.options[3]}`]
        // Note: correct answer is strictly omitted
      };
    });

    const answersData = JSON.parse(attempt.answers || '{}');
    const answers = answersData.answers || answersData;

    return res.json({
      attempt_id: attempt.id,
      exam_id: exam.id,
      title: exam.title,
      duration_min: exam.duration_min,
      remaining_seconds: remainingSeconds,
      questions,
      answers
    });
  }

  // Check if student already submitted an attempt for this exam
  const submittedAttempt = db.prepare(`
    SELECT * FROM attempts
    WHERE user_id = ? AND exam_id = ? AND status = 'submitted'
    ORDER BY id DESC LIMIT 1
  `).get(userId, exam.id);

  if (submittedAttempt) {
    return res.status(400).json({
      error: 'Exam already submitted',
      attempt_id: submittedAttempt.id,
      score: submittedAttempt.score
    });
  }

  // Create new attempt with randomized questions and options
  const rawQuestions = db.prepare('SELECT * FROM questions WHERE exam_id = ?').all(exam.id);
  if (rawQuestions.length === 0) {
    return res.status(400).json({ error: 'No questions configured for this exam' });
  }

  const shuffledQuestions = shuffleArray(rawQuestions);
  const questionOrder = shuffledQuestions.map(q => ({
    id: q.id,
    options: shuffleArray(['a', 'b', 'c', 'd'])
  }));

  const initialAnswers = JSON.stringify({
    answers: {},
    last_action_at: new Date().toISOString()
  });

  const insert = db.prepare(`
    INSERT INTO attempts (user_id, exam_id, question_order, answers, status, risk_score, risk_level)
    VALUES (?, ?, ?, ?, 'in_progress', 0, 'LOW')
  `).run(userId, exam.id, JSON.stringify(questionOrder), initialAnswers);

  const attemptId = insert.lastInsertRowid;

  // Prepare safe questions for client (omits correct answers)
  const questionMap = new Map(rawQuestions.map(q => [q.id, q]));
  const clientQuestions = questionOrder.map(item => {
    const q = questionMap.get(item.id);
    return {
      id: q.id,
      text: q.text,
      option_a: q[`option_${item.options[0]}`],
      option_b: q[`option_${item.options[1]}`],
      option_c: q[`option_${item.options[2]}`],
      option_d: q[`option_${item.options[3]}`]
    };
  });

  return res.json({
    attempt_id: attemptId,
    exam_id: exam.id,
    title: exam.title,
    duration_min: exam.duration_min,
    remaining_seconds: totalSeconds,
    questions: clientQuestions,
    answers: {}
  });
});

/**
 * POST /api/exam/answer
 * Security & Anti-cheating features:
 * 1. Rejects answers if the attempt is already closed or server timer has expired.
 * 2. Auto-submits exam upon expiration.
 * 3. Server-side tracking detects FAST_ANSWER (< 3 seconds) and logs activity with risk penalty (weight: 3).
 */
router.post('/answer', (req, res) => {
  const userId = req.user.id;
  const { attempt_id, question_id, answer, served_at } = req.body;

  if (!question_id || !answer) {
    return res.status(400).json({ error: 'question_id and answer are required' });
  }

  const validOptions = ['a', 'b', 'c', 'd'];
  const normalizedAnswer = String(answer).toLowerCase();
  if (!validOptions.includes(normalizedAnswer)) {
    return res.status(400).json({ error: 'answer must be one of a, b, c, d' });
  }

  // Fetch attempt belonging to student
  const attempt = attempt_id
    ? db.prepare('SELECT * FROM attempts WHERE id = ? AND user_id = ?').get(attempt_id, userId)
    : db.prepare("SELECT * FROM attempts WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1").get(userId);

  if (!attempt) {
    return res.status(404).json({ error: 'Active exam attempt not found' });
  }

  if (attempt.status !== 'in_progress') {
    return res.status(400).json({ error: 'Attempt is closed and cannot accept answers' });
  }

  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(attempt.exam_id);
  const totalSeconds = exam.duration_min * 60;
  const startedAt = parseSqliteDate(attempt.started_at);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  // Strict server-side timer enforcement
  if (elapsedSeconds > totalSeconds) {
    gradeAndSubmitAttempt(attempt.id);
    return res.status(400).json({
      error: 'Exam time has expired. Attempt has been auto-submitted.',
      expired: true
    });
  }

  // Verify question belongs to this attempt
  const questionOrder = JSON.parse(attempt.question_order || '[]');
  const validQuestion = questionOrder.find(item => item.id === Number(question_id));
  if (!validQuestion) {
    return res.status(400).json({ error: 'Question does not belong to this exam attempt' });
  }

  // Parse existing answers data
  let answersData;
  try {
    answersData = JSON.parse(attempt.answers || '{}');
    if (!answersData.answers) {
      answersData = { answers: answersData, last_action_at: attempt.started_at };
    }
  } catch {
    answersData = { answers: {}, last_action_at: attempt.started_at };
  }

  const nowMs = Date.now();
  let timeSinceServedSeconds = null;

  // Compute time since served: check client served_at (if provided) and server sequential gap
  if (served_at) {
    const clientServedMs = new Date(served_at).getTime();
    if (!isNaN(clientServedMs)) {
      timeSinceServedSeconds = (nowMs - clientServedMs) / 1000;
    }
  }

  if (timeSinceServedSeconds === null || timeSinceServedSeconds < 0) {
    const lastActionMs = answersData.last_action_at
      ? new Date(answersData.last_action_at).getTime()
      : startedAt;
    timeSinceServedSeconds = (nowMs - lastActionMs) / 1000;
  }

  // Anti-cheating: Flag fast answering under 3 seconds
  if (timeSinceServedSeconds < 3) {
    const eventDetails = JSON.stringify({
      question_id: Number(question_id),
      response_time_seconds: Math.round(timeSinceServedSeconds * 100) / 100
    });

    db.prepare(`
      INSERT INTO activity_logs (attempt_id, event_type, details)
      VALUES (?, 'FAST_ANSWER', ?)
    `).run(attempt.id, eventDetails);

    // Apply risk weight (FAST_ANSWER = 3)
    const newRiskScore = attempt.risk_score + 3;
    const newRiskLevel = getRiskLevel(newRiskScore);

    db.prepare(`
      UPDATE attempts
      SET risk_score = ?, risk_level = ?
      WHERE id = ?
    `).run(newRiskScore, newRiskLevel, attempt.id);

    attempt.risk_score = newRiskScore;
    attempt.risk_level = newRiskLevel;
  }

  // Autosave answer
  answersData.answers[question_id] = normalizedAnswer;
  answersData.last_action_at = new Date().toISOString();

  db.prepare(`
    UPDATE attempts
    SET answers = ?
    WHERE id = ?
  `).run(JSON.stringify(answersData), attempt.id);

  const remainingSeconds = Math.max(0, Math.floor(totalSeconds - elapsedSeconds));

  return res.json({
    success: true,
    question_id: Number(question_id),
    answer: normalizedAnswer,
    remaining_seconds: remainingSeconds
  });
});

/**
 * POST /api/exam/submit
 * Security & Anti-cheating features:
 * 1. Grades the exam strictly server-side using stored option mappings.
 * 2. Idempotent: once submitted, score is sealed.
 * 3. Auto-submits if time expired.
 */
router.post('/submit', (req, res) => {
  const userId = req.user.id;
  const { attempt_id } = req.body;

  const attempt = attempt_id
    ? db.prepare('SELECT * FROM attempts WHERE id = ? AND user_id = ?').get(attempt_id, userId)
    : db.prepare("SELECT * FROM attempts WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1").get(userId);

  if (!attempt) {
    return res.status(404).json({ error: 'Exam attempt not found' });
  }

  const result = gradeAndSubmitAttempt(attempt.id);

  return res.json({
    message: result.already_submitted ? 'Attempt was already submitted' : 'Exam submitted and graded successfully',
    attempt_id: attempt.id,
    status: result.status,
    score: result.score,
    correct_count: result.correct_count,
    total_questions: result.total_questions
  });
});

module.exports = {
  router,
  gradeAndSubmitAttempt
};
