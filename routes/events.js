const express = require('express');
const db = require('../db');
const { authenticateToken, requireRole } = require('./auth');
const { WEIGHTS, HIGH_SEVERITY_EVENTS, computeRisk, checkSimilarity } = require('../riskEngine');
const { gradeAndSubmitAttempt } = require('./exam');

const router = express.Router();

// Strict student-only protection
router.use(authenticateToken, requireRole('student'));

/**
 * POST /api/events
 * Security & Anti-cheating features:
 * 1. Validates event_type against defined behavior weights.
 * 2. Logs timestamped event into activity_logs with metadata.
 * 3. Dynamically recomputes attempt risk score & risk level.
 * 4. High-Severity Threshold: If high-severity violations (TAB_HIDDEN, FULLSCREEN_EXIT, MULTI_FACE)
 *    reach exams.max_violations, the attempt is immediately auto-submitted and closed.
 */
router.post('/', (req, res) => {
  const userId = req.user.id;
  const { event_type, details, attempt_id } = req.body;

  if (!event_type || !WEIGHTS.hasOwnProperty(event_type)) {
    return res.status(400).json({ error: `Invalid event_type. Must be one of: ${Object.keys(WEIGHTS).join(', ')}` });
  }

  // Find active attempt for student
  const attempt = attempt_id
    ? db.prepare('SELECT * FROM attempts WHERE id = ? AND user_id = ?').get(attempt_id, userId)
    : db.prepare("SELECT * FROM attempts WHERE user_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1").get(userId);

  if (!attempt) {
    return res.status(404).json({ error: 'Active exam attempt not found' });
  }

  if (attempt.status !== 'in_progress') {
    return res.status(400).json({ error: 'Attempt is closed; cannot log events' });
  }

  // Insert event log
  const eventDetails = typeof details === 'object' ? JSON.stringify(details) : (details || '{}');
  db.prepare(`
    INSERT INTO activity_logs (attempt_id, event_type, details)
    VALUES (?, ?, ?)
  `).run(attempt.id, event_type, eventDetails);

  // Recompute risk score and risk level
  const { risk_level } = computeRisk(attempt.id);

  // Count high-severity events (TAB_HIDDEN, FULLSCREEN_EXIT, MULTI_FACE)
  const highSeverityCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM activity_logs
    WHERE attempt_id = ? AND event_type IN (${HIGH_SEVERITY_EVENTS.map(() => '?').join(',')})
  `).get(attempt.id, ...HIGH_SEVERITY_EVENTS).count;

  const exam = db.prepare('SELECT max_violations FROM exams WHERE id = ?').get(attempt.exam_id);
  const maxViolations = exam ? exam.max_violations : 5;

  // Auto-submit if high-severity violations threshold is reached
  if (highSeverityCount >= maxViolations) {
    gradeAndSubmitAttempt(attempt.id);
    checkSimilarity(attempt.exam_id);

    return res.json({
      risk_level,
      violations: highSeverityCount,
      autoSubmitted: true,
      message: `Maximum allowed violations (${maxViolations}) reached. Exam auto-submitted.`
    });
  }

  return res.json({
    risk_level,
    violations: highSeverityCount
  });
});

module.exports = {
  router
};
