const express = require('express');
const db = require('../db');
const { authenticateToken, requireRole } = require('./auth');

const router = express.Router();

// Strict instructor-only authorization
router.use(authenticateToken, requireRole('instructor'));

/**
 * Helper to escape CSV values safely
 */
function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * GET /api/admin/attempts
 * Returns all student exam attempts with scores, risk metrics, and review status.
 * Sorted by risk severity (HIGH -> MEDIUM -> LOW), then risk score descending.
 */
router.get('/attempts', (req, res) => {
  const attempts = db.prepare(`
    SELECT 
      a.id,
      a.user_id,
      u.name AS student_name,
      u.email AS student_email,
      a.exam_id,
      e.title AS exam_title,
      a.started_at,
      a.ended_at,
      a.status,
      a.score,
      a.risk_score,
      a.risk_level,
      a.reviewed,
      a.review_note,
      COUNT(l.id) AS event_count
    FROM attempts a
    JOIN users u ON a.user_id = u.id
    JOIN exams e ON a.exam_id = e.id
    LEFT JOIN activity_logs l ON a.id = l.attempt_id
    GROUP BY a.id
    ORDER BY 
      CASE a.risk_level WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
      a.risk_score DESC,
      a.started_at DESC
  `).all();

  res.json(attempts);
});

/**
 * GET /api/admin/attempts/:id
 * Returns complete details and chronological activity log timeline for a single attempt.
 */
router.get('/attempts/:id', (req, res) => {
  const attemptId = req.params.id;

  const attempt = db.prepare(`
    SELECT 
      a.id,
      a.user_id,
      u.name AS student_name,
      u.email AS student_email,
      a.exam_id,
      e.title AS exam_title,
      a.started_at,
      a.ended_at,
      a.status,
      a.score,
      a.risk_score,
      a.risk_level,
      a.reviewed,
      a.review_note
    FROM attempts a
    JOIN users u ON a.user_id = u.id
    JOIN exams e ON a.exam_id = e.id
    WHERE a.id = ?
  `).get(attemptId);

  if (!attempt) {
    return res.status(404).json({ error: 'Attempt not found' });
  }

  const logs = db.prepare(`
    SELECT id, attempt_id, event_type, details, created_at
    FROM activity_logs
    WHERE attempt_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(attemptId);

  // Parse JSON details for structured timeline rendering
  const parsedLogs = logs.map(log => {
    let parsedDetails = {};
    try {
      parsedDetails = typeof log.details === 'string' ? JSON.parse(log.details) : (log.details || {});
    } catch {
      parsedDetails = { raw: log.details };
    }
    return {
      ...log,
      details: parsedDetails
    };
  });

  res.json({
    attempt,
    logs: parsedLogs
  });
});

/**
 * POST /api/admin/attempts/:id/review
 * Marks attempt reviewed and records reviewer note.
 * "The system flags; humans decide" (Ethical review principle).
 */
router.post('/attempts/:id/review', (req, res) => {
  const attemptId = req.params.id;
  const note = req.body.note !== undefined ? req.body.note : (req.body.review_note || '');

  const result = db.prepare(`
    UPDATE attempts
    SET reviewed = 1, review_note = ?
    WHERE id = ?
  `).run(note, attemptId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Attempt not found' });
  }

  res.json({
    success: true,
    message: 'Attempt marked as reviewed',
    attempt_id: Number(attemptId),
    reviewed: 1,
    review_note: note
  });
});

/**
 * GET /api/admin/export.csv
 * Exports all attempt records, scores, and risk data in standard CSV format.
 */
router.get('/export.csv', (req, res) => {
  const attempts = db.prepare(`
    SELECT 
      a.id,
      u.name AS student_name,
      u.email AS student_email,
      e.title AS exam_title,
      a.status,
      a.score,
      a.risk_score,
      a.risk_level,
      a.reviewed,
      a.review_note,
      a.started_at,
      a.ended_at,
      COUNT(l.id) AS event_count
    FROM attempts a
    JOIN users u ON a.user_id = u.id
    JOIN exams e ON a.exam_id = e.id
    LEFT JOIN activity_logs l ON a.id = l.attempt_id
    GROUP BY a.id
    ORDER BY a.id ASC
  `).all();

  const headers = [
    'Attempt ID',
    'Student Name',
    'Student Email',
    'Exam Title',
    'Status',
    'Score (%)',
    'Risk Score',
    'Risk Level',
    'Events Count',
    'Reviewed',
    'Review Note',
    'Started At',
    'Ended At'
  ];

  const rows = attempts.map(att => [
    att.id,
    escapeCsv(att.student_name),
    escapeCsv(att.student_email),
    escapeCsv(att.exam_title),
    escapeCsv(att.status),
    att.score !== null ? att.score : '',
    att.risk_score,
    escapeCsv(att.risk_level),
    att.event_count,
    att.reviewed ? 'Yes' : 'No',
    escapeCsv(att.review_note || ''),
    escapeCsv(att.started_at),
    escapeCsv(att.ended_at || '')
  ].join(','));

  const csvContent = [headers.join(','), ...rows].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="checkpoint_attempts_export.csv"');
  res.send(csvContent);
});

module.exports = {
  router
};
