const db = require('./db');

/**
 * Event weights defined in ARCHITECTURE.md Section 5
 */
const WEIGHTS = {
  TAB_HIDDEN: 10,
  WINDOW_BLUR: 5,
  FULLSCREEN_EXIT: 10,
  COPY_PASTE: 5,
  RIGHT_CLICK: 2,
  DEVTOOLS_KEY: 5,
  NO_FACE: 5,
  MULTI_FACE: 15,
  IDLE: 2,
  FAST_ANSWER: 3,
  SECOND_SESSION: 15,
  SIMILAR_ANSWERS: 20
};

/**
 * High-severity violations that count toward exams.max_violations threshold
 */
const HIGH_SEVERITY_EVENTS = ['TAB_HIDDEN', 'FULLSCREEN_EXIT', 'MULTI_FACE'];

/**
 * Recomputes risk score and level for an attempt:
 * risk_score = Σ (event_count × weight)
 * 0–30  -> LOW
 * 31–60 -> MEDIUM
 * 61+   -> HIGH
 */
function computeRisk(attemptId) {
  const logs = db.prepare('SELECT event_type FROM activity_logs WHERE attempt_id = ?').all(attemptId);
  let totalScore = 0;
  for (const log of logs) {
    totalScore += (WEIGHTS[log.event_type] || 0);
  }

  let riskLevel = 'LOW';
  if (totalScore >= 61) {
    riskLevel = 'HIGH';
  } else if (totalScore >= 31) {
    riskLevel = 'MEDIUM';
  }

  db.prepare(`
    UPDATE attempts
    SET risk_score = ?, risk_level = ?
    WHERE id = ?
  `).run(totalScore, riskLevel, attemptId);

  return {
    risk_score: totalScore,
    risk_level: riskLevel
  };
}

/**
 * checkSimilarity(examId):
 * Compares all submitted attempts pairwise for an exam.
 * If two students share 3 or more identical WRONG answers (mapped to original options),
 * logs a SIMILAR_ANSWERS event for both attempts and recomputes risk.
 */
function checkSimilarity(examId) {
  const questions = db.prepare('SELECT id, correct FROM questions WHERE exam_id = ?').all(examId);
  const correctMap = new Map(questions.map(q => [q.id, q.correct]));

  const attempts = db.prepare(`
    SELECT id, user_id, question_order, answers
    FROM attempts
    WHERE exam_id = ? AND status = 'submitted'
  `).all(examId);

  if (attempts.length < 2) return;

  const optionKeys = ['a', 'b', 'c', 'd'];

  // Map each attempt to a dictionary of wrong answers: { [questionId]: originalSelectedOption }
  const attemptWrongAnswers = attempts.map(att => {
    const questionOrder = JSON.parse(att.question_order || '[]');
    const answersData = JSON.parse(att.answers || '{}');
    const studentAnswers = answersData.answers || answersData;

    const wrongMap = {}; // questionId -> originalOption

    for (const item of questionOrder) {
      const qId = item.id;
      const correctAns = correctMap.get(qId);
      const studentDisplay = studentAnswers[qId];

      if (studentDisplay) {
        const idx = optionKeys.indexOf(studentDisplay.toLowerCase());
        if (idx !== -1 && item.options && item.options[idx]) {
          const originalSelected = item.options[idx];
          // Check if answer is wrong
          if (correctAns && originalSelected !== correctAns) {
            wrongMap[qId] = originalSelected;
          }
        }
      }
    }

    return {
      attemptId: att.id,
      userId: att.user_id,
      wrongAnswers: wrongMap
    };
  });

  // Pairwise comparison
  for (let i = 0; i < attemptWrongAnswers.length; i++) {
    for (let j = i + 1; j < attemptWrongAnswers.length; j++) {
      const attA = attemptWrongAnswers[i];
      const attB = attemptWrongAnswers[j];

      // Count identical wrong answers
      const sharedWrongQuestions = [];
      for (const qId of Object.keys(attA.wrongAnswers)) {
        if (attB.wrongAnswers[qId] && attB.wrongAnswers[qId] === attA.wrongAnswers[qId]) {
          sharedWrongQuestions.push({
            question_id: Number(qId),
            shared_wrong_option: attA.wrongAnswers[qId]
          });
        }
      }

      if (sharedWrongQuestions.length >= 3) {
        // Prevent duplicate SIMILAR_ANSWERS between the same pair
        const existingA = db.prepare(`
          SELECT id FROM activity_logs
          WHERE attempt_id = ? AND event_type = 'SIMILAR_ANSWERS' AND details LIKE ?
        `).get(attA.attemptId, `%"paired_attempt_id":${attB.attemptId}%`);

        if (!existingA) {
          const detailsForA = JSON.stringify({
            paired_attempt_id: attB.attemptId,
            paired_user_id: attB.userId,
            shared_wrong_count: sharedWrongQuestions.length,
            shared_questions: sharedWrongQuestions
          });
          db.prepare(`
            INSERT INTO activity_logs (attempt_id, event_type, details)
            VALUES (?, 'SIMILAR_ANSWERS', ?)
          `).run(attA.attemptId, detailsForA);

          computeRisk(attA.attemptId);
        }

        const existingB = db.prepare(`
          SELECT id FROM activity_logs
          WHERE attempt_id = ? AND event_type = 'SIMILAR_ANSWERS' AND details LIKE ?
        `).get(attB.attemptId, `%"paired_attempt_id":${attA.attemptId}%`);

        if (!existingB) {
          const detailsForB = JSON.stringify({
            paired_attempt_id: attA.attemptId,
            paired_user_id: attA.userId,
            shared_wrong_count: sharedWrongQuestions.length,
            shared_questions: sharedWrongQuestions
          });
          db.prepare(`
            INSERT INTO activity_logs (attempt_id, event_type, details)
            VALUES (?, 'SIMILAR_ANSWERS', ?)
          `).run(attB.attemptId, detailsForB);

          computeRisk(attB.attemptId);
        }
      }
    }
  }
}

module.exports = {
  WEIGHTS,
  HIGH_SEVERITY_EVENTS,
  computeRisk,
  checkSimilarity
};
