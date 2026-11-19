/**
 * CheckPoint - Student Examination Engine (exam.js)
 * Manages consent, fullscreen initiation, server-side timer synchronization,
 * sequential question navigation, answer autosave, and exam submission.
 */

(function () {
  'use strict';

  // 1. Validate Session Authentication
  const token = sessionStorage.getItem('token');
  const userStr = sessionStorage.getItem('user');

  if (!token || !userStr) {
    window.location.href = 'login.html';
    return;
  }

  let user = null;
  try {
    user = JSON.parse(userStr);
  } catch {
    window.location.href = 'login.html';
    return;
  }

  if (user.role !== 'student') {
    window.location.href = 'admin.html';
    return;
  }

  // Display user identity
  const studentEmailEl = document.getElementById('studentEmail');
  if (studentEmailEl) studentEmailEl.textContent = `Student: ${user.email}`;

  // State
  let attemptId = null;
  let questions = [];
  let studentAnswers = {};
  let currentQIndex = 0;
  let questionServedAt = null;
  let timerInterval = null;
  let remainingSeconds = 0;

  // DOM Elements
  const consentView = document.getElementById('consentView');
  const examView = document.getElementById('examView');
  const resultView = document.getElementById('resultView');
  const terminatedView = document.getElementById('terminatedView');

  const consentCheck = document.getElementById('consentCheck');
  const startExamBtn = document.getElementById('startExamBtn');

  const timerContainer = document.getElementById('timerContainer');
  const timerText = document.getElementById('timerText');
  const examTitleEl = document.getElementById('examTitle');
  const questionProgressEl = document.getElementById('questionProgress');
  const questionTextEl = document.getElementById('questionText');
  const optionsListEl = document.getElementById('optionsList');
  const autosaveStatusEl = document.getElementById('autosaveStatus');
  const nextQuestionBtn = document.getElementById('nextQuestionBtn');

  const scoreDisplayEl = document.getElementById('scoreDisplay');
  const scoreSummaryEl = document.getElementById('scoreSummary');
  const logoutBtn = document.getElementById('logoutBtn');
  const terminatedLogoutBtn = document.getElementById('terminatedLogoutBtn');

  // Consent checkbox enables start button
  consentCheck.addEventListener('change', () => {
    startExamBtn.disabled = !consentCheck.checked;
  });

  // Start Exam Click Handler
  startExamBtn.addEventListener('click', async () => {
    startExamBtn.disabled = true;
    startExamBtn.textContent = 'Initializing exam...';

    try {
      // 1. Enter Fullscreen Mode
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen().catch(err => {
          console.warn('Fullscreen request bypassed or denied:', err);
        });
      }

      // 2. Request exam attempt from server
      const res = await fetch('/api/exam/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({})
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start exam');
      }

      // Handle resuming already submitted attempt
      if (data.status === 'submitted') {
        showResultView(data);
        return;
      }

      attemptId = data.attempt_id;
      questions = data.questions;
      studentAnswers = data.answers || {};
      remainingSeconds = data.remaining_seconds;

      if (examTitleEl && data.title) {
        examTitleEl.textContent = data.title;
      }

      // 3. Start client-side behavior monitoring with auto-submit hook
      if (window.monitor && typeof window.monitor.start === 'function') {
        window.monitor.start(attemptId, handleViolationTermination);
      }

      // 4. Start in-browser webcam face monitoring (zero video storage)
      if (window.faceMonitor && typeof window.faceMonitor.start === 'function') {
        window.faceMonitor.start();
      }

      // 5. Initialize and show Countdown Timer
      initTimer(remainingSeconds);

      // 6. Switch to active exam view and render first question
      consentView.style.display = 'none';
      examView.style.display = 'block';

      renderQuestion(0);
    } catch (err) {
      alert(`Error starting exam: ${err.message}`);
      startExamBtn.disabled = false;
      startExamBtn.textContent = 'Start Exam (Enter Fullscreen)';
    }
  });

  /**
   * Countdown Timer
   * Synced with server remaining seconds
   */
  function initTimer(totalSecs) {
    remainingSeconds = totalSecs;
    timerContainer.style.display = 'flex';
    updateTimerDisplay();

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      remainingSeconds--;
      updateTimerDisplay();

      if (remainingSeconds <= 60) {
        timerContainer.classList.add('timer-warning');
      }

      if (remainingSeconds <= 0) {
        clearInterval(timerInterval);
        submitExam(true); // Auto-submit when time expires
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const mins = Math.floor(Math.max(0, remainingSeconds) / 60);
    const secs = Math.max(0, remainingSeconds) % 60;
    timerText.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * Render single question (sequential flow, no going back)
   */
  function renderQuestion(index) {
    if (index >= questions.length) {
      submitExam(false);
      return;
    }

    currentQIndex = index;
    const q = questions[index];
    questionServedAt = new Date().toISOString(); // Recorded for FAST_ANSWER server detection

    questionProgressEl.textContent = `Question ${index + 1} of ${questions.length}`;
    questionTextEl.textContent = q.text;
    optionsListEl.innerHTML = '';
    autosaveStatusEl.innerHTML = '<span>●</span> Ready';
    autosaveStatusEl.style.color = '#64748b';

    const selectedOption = studentAnswers[q.id];
    const isLastQuestion = index === questions.length - 1;

    nextQuestionBtn.textContent = isLastQuestion ? 'Submit Exam' : 'Next Question →';
    nextQuestionBtn.disabled = !selectedOption; // Must select an answer before proceeding

    const optionKeys = ['a', 'b', 'c', 'd'];
    optionKeys.forEach(optKey => {
      const optionItem = document.createElement('div');
      optionItem.className = 'option-item';
      if (selectedOption === optKey) {
        optionItem.classList.add('selected');
      }

      optionItem.innerHTML = `
        <div class="option-key">${optKey}</div>
        <div class="option-text">${escapeHtml(q[`option_${optKey}`])}</div>
      `;

      optionItem.addEventListener('click', () => {
        selectAndAutosave(q.id, optKey);
      });

      optionsListEl.appendChild(optionItem);
    });
  }

  /**
   * Option Selection & Server Autosave
   */
  async function selectAndAutosave(questionId, optionKey) {
    studentAnswers[questionId] = optionKey;

    // Highlight selected in DOM
    const items = optionsListEl.querySelectorAll('.option-item');
    const optionKeys = ['a', 'b', 'c', 'd'];
    items.forEach((item, idx) => {
      if (optionKeys[idx] === optionKey) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });

    nextQuestionBtn.disabled = false;
    autosaveStatusEl.innerHTML = '<span>⏳</span> Autosaving...';
    autosaveStatusEl.style.color = '#2563eb';

    try {
      const res = await fetch('/api/exam/answer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          attempt_id: attemptId,
          question_id: questionId,
          answer: optionKey,
          served_at: questionServedAt
        })
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.expired) {
          handleViolationTermination({ message: 'Exam time expired' });
          return;
        }
        throw new Error(data.error || 'Failed to autosave');
      }

      autosaveStatusEl.innerHTML = '<span>✓</span> Answer autosaved';
      autosaveStatusEl.style.color = '#16a34a';
    } catch (err) {
      console.warn('[Autosave]', err);
      autosaveStatusEl.innerHTML = '<span>⚠️</span> Save error (retrying on next)';
      autosaveStatusEl.style.color = '#dc2626';
    }
  }

  // Next / Submit Button Listener
  nextQuestionBtn.addEventListener('click', () => {
    if (currentQIndex < questions.length - 1) {
      renderQuestion(currentQIndex + 1);
    } else {
      submitExam(false);
    }
  });

  /**
   * Final Exam Submission
   */
  async function submitExam(isAutoExpired = false) {
    clearInterval(timerInterval);
    if (window.monitor && typeof window.monitor.stop === 'function') {
      window.monitor.stop();
    }
    if (window.faceMonitor && typeof window.faceMonitor.stop === 'function') {
      window.faceMonitor.stop();
    }

    // Exit fullscreen if active
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }

    examView.style.display = 'none';

    try {
      const res = await fetch('/api/exam/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ attempt_id: attemptId })
      });

      const data = await res.json();
      showResultView(data);
    } catch (err) {
      console.error('Submit error:', err);
      showResultView({ score: '--', correct_count: '--', total_questions: questions.length });
    }
  }

  function showResultView(data) {
    consentView.style.display = 'none';
    examView.style.display = 'none';
    timerContainer.style.display = 'none';
    resultView.style.display = 'block';

    const score = data.score !== undefined ? data.score : 0;
    scoreDisplayEl.textContent = `${score}%`;
    if (data.correct_count !== undefined && data.total_questions !== undefined) {
      scoreSummaryEl.textContent = `You answered ${data.correct_count} out of ${data.total_questions} questions correctly.`;
    }
  }

  /**
   * Handler for violation termination (autoSubmitted: true)
   */
  function handleViolationTermination(data) {
    clearInterval(timerInterval);
    if (window.monitor && typeof window.monitor.stop === 'function') {
      window.monitor.stop();
    }
    if (window.faceMonitor && typeof window.faceMonitor.stop === 'function') {
      window.faceMonitor.stop();
    }

    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }

    consentView.style.display = 'none';
    examView.style.display = 'none';
    timerContainer.style.display = 'none';
    resultView.style.display = 'none';
    terminatedView.style.display = 'block';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // Logout handlers
  function logout() {
    sessionStorage.clear();
    window.location.href = 'login.html';
  }
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  if (terminatedLogoutBtn) terminatedLogoutBtn.addEventListener('click', logout);

})();
