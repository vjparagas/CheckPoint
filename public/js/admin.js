/**
 * CheckPoint - Instructor Admin Dashboard (admin.js)
 * Manages attempts listing, real-time 5s polling, risk summaries,
 * event timeline inspection, reviewer notes, and CSV data export.
 */

(function () {
  'use strict';

  // 1. Session & Role Verification
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

  if (user.role !== 'instructor') {
    window.location.href = 'login.html';
    return;
  }

  // Display instructor email in header
  const instructorIdentityEl = document.getElementById('instructorIdentity');
  if (instructorIdentityEl) {
    instructorIdentityEl.textContent = `Instructor: ${user.email}`;
  }

  // State
  let attempts = [];
  let currentViewingAttemptId = null;
  let refreshTimerInterval = null;
  let countdownSecs = 5;

  // DOM Elements
  const statTotalEl = document.getElementById('statTotal');
  const statHighEl = document.getElementById('statHigh');
  const statMediumEl = document.getElementById('statMedium');
  const statInProgressEl = document.getElementById('statInProgress');
  const attemptsTableBody = document.getElementById('attemptsTableBody');
  const refreshTimerEl = document.getElementById('refreshTimer');
  const refreshBtn = document.getElementById('refreshBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  // Timeline Slideover Elements
  const panelBackdrop = document.getElementById('panelBackdrop');
  const slidePanel = document.getElementById('slidePanel');
  const closePanelBtn = document.getElementById('closePanelBtn');
  const panelStudentName = document.getElementById('panelStudentName');
  const panelAttemptMeta = document.getElementById('panelAttemptMeta');
  const panelRiskBadge = document.getElementById('panelRiskBadge');
  const panelScoreText = document.getElementById('panelScoreText');
  const timelineContainer = document.getElementById('timelineContainer');
  const reviewerNoteInput = document.getElementById('reviewerNoteInput');
  const markReviewedBtn = document.getElementById('markReviewedBtn');
  const reviewSaveFeedback = document.getElementById('reviewSaveFeedback');

  /**
   * Fetch all attempts from GET /api/admin/attempts
   */
  async function fetchAttempts() {
    try {
      const res = await fetch('/api/admin/attempts', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (res.status === 401 || res.status === 403) {
        sessionStorage.clear();
        window.location.href = 'login.html';
        return;
      }

      if (!res.ok) throw new Error('Failed to load attempts');

      attempts = await res.json();
      renderDashboard();
    } catch (err) {
      console.warn('[Admin Dashboard] Error fetching attempts:', err);
    }
  }

  /**
   * Render metrics summary cards & attempts table
   */
  function renderDashboard() {
    // 1. Calculate Summary Stats
    const total = attempts.length;
    const highCount = attempts.filter(a => a.risk_level === 'HIGH').length;
    const mediumCount = attempts.filter(a => a.risk_level === 'MEDIUM').length;
    const inProgressCount = attempts.filter(a => a.status === 'in_progress').length;

    statTotalEl.textContent = total;
    statHighEl.textContent = highCount;
    statMediumEl.textContent = mediumCount;
    statInProgressEl.textContent = inProgressCount;

    // 2. Render Attempts Table
    if (attempts.length === 0) {
      attemptsTableBody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; color: #64748b; padding: 36px;">
            No student attempts recorded yet.
          </td>
        </tr>
      `;
      return;
    }

    attemptsTableBody.innerHTML = '';
    attempts.forEach(att => {
      const tr = document.createElement('tr');

      const riskBadgeClass = att.risk_level === 'HIGH'
        ? 'badge-high'
        : att.risk_level === 'MEDIUM'
        ? 'badge-medium'
        : 'badge-low';

      const statusBadgeClass = att.status === 'in_progress' ? 'status-progress' : 'status-submitted';
      const statusLabel = att.status === 'in_progress' ? 'In Progress' : 'Submitted';

      const scoreDisplay = att.score !== null && att.score !== undefined ? `${att.score}%` : '--';

      const reviewedDisplay = att.reviewed
        ? `<span style="color: #16a34a; font-weight: 600;">✓ Reviewed</span>`
        : `<span style="color: #94a3b8;">Pending</span>`;

      tr.innerHTML = `
        <td style="font-weight: 600; color: #475569;">#${att.id}</td>
        <td>
          <div style="font-weight: 600; color: #0f172a;">${escapeHtml(att.student_name)}</div>
          <div style="font-size: 12px; color: #64748b;">${escapeHtml(att.student_email)}</div>
        </td>
        <td>
          <span class="status-badge ${statusBadgeClass}">${statusLabel}</span>
        </td>
        <td style="font-weight: 700;">${scoreDisplay}</td>
        <td>
          <span class="badge ${riskBadgeClass}">${att.risk_level}</span>
        </td>
        <td style="font-weight: 700;">${att.risk_score}</td>
        <td>${att.event_count || 0}</td>
        <td>${reviewedDisplay}</td>
        <td>
          <button class="btn btn-secondary view-btn" data-id="${att.id}" style="padding: 4px 10px; font-size: 12px;">
            Timeline
          </button>
        </td>
      `;

      tr.addEventListener('click', () => openTimelinePanel(att.id));
      attemptsTableBody.appendChild(tr);
    });
  }

  /**
   * Open Timeline Panel & Fetch Full Event History
   */
  async function openTimelinePanel(attemptId) {
    currentViewingAttemptId = attemptId;
    document.body.classList.add('panel-open');
    reviewSaveFeedback.style.display = 'none';

    panelStudentName.textContent = 'Loading student...';
    panelAttemptMeta.textContent = `Attempt #${attemptId}`;
    timelineContainer.innerHTML = '<div style="color: #64748b; font-size: 13px;">Loading event history...</div>';

    try {
      const res = await fetch(`/api/admin/attempts/${attemptId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load attempt details');

      const data = await res.json();
      const att = data.attempt;
      const logs = data.logs || [];

      panelStudentName.textContent = att.student_name;
      panelAttemptMeta.textContent = `Attempt #${att.id} • ${att.student_email} • ${att.exam_title}`;
      panelScoreText.textContent = att.score !== null ? `Score: ${att.score}%` : 'Score: In Progress';

      panelRiskBadge.className = `badge ${att.risk_level === 'HIGH' ? 'badge-high' : att.risk_level === 'MEDIUM' ? 'badge-medium' : 'badge-low'}`;
      panelRiskBadge.textContent = `${att.risk_level} (${att.risk_score} pts)`;

      reviewerNoteInput.value = att.review_note || '';

      const appealBox = document.getElementById('panelAppealBox');
      if (appealBox) {
        if (att.appeal) {
          appealBox.style.display = 'block';
          appealBox.innerHTML = `<strong>Student Appeal / Note:</strong> ${escapeHtml(att.appeal)}`;
        } else {
          appealBox.style.display = 'none';
        }
      }

      // Render timeline events
      if (logs.length === 0) {
        timelineContainer.innerHTML = '<div style="color: #64748b; font-size: 13px;">No behavior events logged for this attempt.</div>';
        return;
      }

      timelineContainer.innerHTML = '';
      logs.forEach(log => {
        const item = document.createElement('div');
        item.className = 'timeline-item';

        const isHigh = ['TAB_HIDDEN', 'FULLSCREEN_EXIT', 'MULTI_FACE', 'SECOND_SESSION', 'SIMILAR_ANSWERS'].includes(log.event_type);
        const isMed = ['WINDOW_BLUR', 'COPY_PASTE', 'DEVTOOLS_KEY', 'NO_FACE'].includes(log.event_type);
        const dotClass = isHigh ? 'dot-high' : isMed ? 'dot-med' : '';

        const timeStr = log.created_at ? formatTime(log.created_at) : '--:--';
        const formattedDetails = formatEventDetails(log.details);

        item.innerHTML = `
          <div class="timeline-dot ${dotClass}"></div>
          <div class="timeline-meta">
            <strong style="color: #0f172a;">${escapeHtml(log.event_type)}</strong>
            <span style="margin-left: 8px;">${timeStr}</span>
          </div>
          <div class="timeline-content">${formattedDetails}</div>
        `;
        timelineContainer.appendChild(item);
      });
    } catch (err) {
      timelineContainer.innerHTML = `<div style="color: #dc2626; font-size: 13px;">Error loading timeline: ${err.message}</div>`;
    }
  }

  function closeTimelinePanel() {
    document.body.classList.remove('panel-open');
    currentViewingAttemptId = null;
  }

  closePanelBtn.addEventListener('click', closeTimelinePanel);
  panelBackdrop.addEventListener('click', closeTimelinePanel);

  /**
   * Save Reviewer Note and Mark Reviewed
   */
  markReviewedBtn.addEventListener('click', async () => {
    if (!currentViewingAttemptId) return;

    markReviewedBtn.disabled = true;
    markReviewedBtn.textContent = 'Saving...';
    const note = reviewerNoteInput.value.trim();

    try {
      const res = await fetch(`/api/admin/attempts/${currentViewingAttemptId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ note })
      });

      if (!res.ok) throw new Error('Failed to save review');

      reviewSaveFeedback.style.display = 'inline';
      await fetchAttempts(); // refresh table
    } catch (err) {
      alert(`Error saving review: ${err.message}`);
    } finally {
      markReviewedBtn.disabled = false;
      markReviewedBtn.textContent = 'Mark Reviewed';
    }
  });

  /**
   * Export CSV Button
   */
  exportCsvBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/admin/export.csv', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to download CSV export');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'checkpoint_attempts_export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Export error: ${err.message}`);
    }
  });

  /**
   * Auto-Refresh Polling Timer (5 seconds)
   */
  function startPolling() {
    countdownSecs = 5;
    clearInterval(refreshTimerInterval);
    refreshTimerInterval = setInterval(() => {
      countdownSecs--;
      if (countdownSecs <= 0) {
        countdownSecs = 5;
        fetchAttempts();
      }
      refreshTimerEl.textContent = `Auto-refreshing in ${countdownSecs}s`;
    }, 1000);
  }

  refreshBtn.addEventListener('click', () => {
    countdownSecs = 5;
    fetchAttempts();
  });

  // Helpers
  function formatTime(dateStr) {
    try {
      const d = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z');
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return dateStr;
    }
  }

  function formatEventDetails(details) {
    if (!details || Object.keys(details).length === 0) return '<em>No extra metadata</em>';
    const parts = [];
    for (const [k, v] of Object.entries(details)) {
      if (k === 'client_timestamp') continue;
      parts.push(`<strong>${escapeHtml(k)}:</strong> ${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}`);
    }
    return parts.join(' &bull; ');
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text || '';
    return d.innerHTML;
  }

  // Logout
  logoutBtn.addEventListener('click', () => {
    sessionStorage.clear();
    window.location.href = 'login.html';
  });

  // Initialize
  fetchAttempts();
  startPolling();
})();
