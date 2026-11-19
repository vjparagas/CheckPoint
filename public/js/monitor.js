/**
 * CheckPoint - Behavior Monitor Module (monitor.js)
 * Captures student interactions and posts behavior events to /api/events:
 * - TAB_HIDDEN (visibilitychange: hidden)
 * - WINDOW_BLUR (window blur)
 * - FULLSCREEN_EXIT (fullscreenchange exit, enforces modal overlay)
 * - COPY_PASTE (copy, cut, paste attempts)
 * - RIGHT_CLICK (contextmenu)
 * - DEVTOOLS_KEY (F12, inspection shortcuts)
 * - IDLE (60s with no mouse or keyboard activity)
 *
 * Automatically triggers the termination screen when server responds with autoSubmitted: true.
 */

(function () {
  'use strict';

  let activeAttemptId = null;
  let onAutoSubmittedCallback = null;
  let isMonitoringActive = false;
  let idleTimer = null;
  const IDLE_TIMEOUT_MS = 60000; // 60 seconds

  // Create Fullscreen Enforcement Overlay
  let fsOverlay = document.getElementById('fullscreen-overlay');
  if (!fsOverlay) {
    fsOverlay = document.createElement('div');
    fsOverlay.id = 'fullscreen-overlay';
    fsOverlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(15, 23, 42, 0.95);
      color: #fff;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 9999999;
      text-align: center;
      padding: 24px;
    `;
    fsOverlay.innerHTML = `
      <div style="background: #1e293b; padding: 36px 48px; border-radius: 8px; max-width: 500px; border: 1px solid #dc2626;">
        <h2 style="color: #ef4444; margin-bottom: 16px; font-size: 22px;">⚠️ Fullscreen Required</h2>
        <p style="color: #cbd5e1; margin-bottom: 24px; font-size: 15px; line-height: 1.5;">
          Exiting fullscreen is a security violation and has been logged.<br>
          You must return to fullscreen immediately to continue your exam.
        </p>
        <button id="resumeFsBtn" style="
          background: #ef4444; color: #fff; border: none; padding: 12px 28px;
          font-size: 16px; font-weight: 600; border-radius: 6px; cursor: pointer;">
          Return to Fullscreen
        </button>
      </div>
    `;
    document.body ? document.body.appendChild(fsOverlay) : document.addEventListener('DOMContentLoaded', () => document.body.appendChild(fsOverlay));

    // Button event listener
    document.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'resumeFsBtn') {
        document.documentElement.requestFullscreen().then(() => {
          fsOverlay.style.display = 'none';
        }).catch(err => {
          console.error('Failed to re-enter fullscreen:', err);
        });
      }
    });
  }

  /**
   * Helper to dispatch behavior events to /api/events
   */
  async function sendEvent(eventType, details = {}) {
    if (!isMonitoringActive) return;

    const token = sessionStorage.getItem('token');
    if (!token) return;

    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          attempt_id: activeAttemptId,
          event_type: eventType,
          details: { ...details, client_timestamp: new Date().toISOString() }
        })
      });

      const data = await res.json();

      // If violation threshold is reached, server auto-submits attempt
      if (data.autoSubmitted && typeof onAutoSubmittedCallback === 'function') {
        onAutoSubmittedCallback(data);
      }
    } catch (err) {
      console.warn(`[Behavior Monitor] Failed to log event ${eventType}:`, err);
    }
  }

  /**
   * 60s Idle Detector
   */
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!isMonitoringActive) return;

    idleTimer = setTimeout(() => {
      sendEvent('IDLE', { duration_seconds: 60 });
      resetIdleTimer();
    }, IDLE_TIMEOUT_MS);
  }

  // Activity listeners to reset idle timer
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, resetIdleTimer, { passive: true });
  });

  /**
   * Event Listeners for Anti-Cheating Behaviors
   */

  // 1. Tab visibility changes (switching tabs or minimizing window)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      sendEvent('TAB_HIDDEN', { message: 'Browser tab hidden or minimized' });
    }
  });

  // 2. Window blur (clicking outside the window or switching application)
  window.addEventListener('blur', () => {
    sendEvent('WINDOW_BLUR', { message: 'Browser window lost focus' });
  });

  // 3. Fullscreen exit detection
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      if (isMonitoringActive) {
        fsOverlay.style.display = 'flex';
        sendEvent('FULLSCREEN_EXIT', { message: 'Student exited fullscreen mode' });
      }
    } else {
      fsOverlay.style.display = 'none';
    }
  });

  // 4. Clipboard operations
  ['copy', 'cut', 'paste'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      sendEvent('COPY_PASTE', { operation: evt });
    });
  });

  // 5. Right-click contextmenu
  document.addEventListener('contextmenu', (e) => {
    sendEvent('RIGHT_CLICK', { x: e.clientX, y: e.clientY });
  });

  // 6. DevTools & restricted shortcuts
  document.addEventListener('keydown', (e) => {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    const key = e.key.toUpperCase();

    if (e.key === 'F12' || (isCtrlOrCmd && e.shiftKey && ['I', 'J', 'C'].includes(key)) || (isCtrlOrCmd && key === 'U')) {
      sendEvent('DEVTOOLS_KEY', { key: e.key, ctrl: isCtrlOrCmd, shift: e.shiftKey });
    }
  });

  /**
   * Public interface to initialize monitoring for the active exam
   */
  window.monitor = {
    start(attemptId, onAutoSubmitted) {
      activeAttemptId = attemptId;
      onAutoSubmittedCallback = onAutoSubmitted;
      isMonitoringActive = true;
      resetIdleTimer();
    },
    stop() {
      isMonitoringActive = false;
      clearTimeout(idleTimer);
      if (fsOverlay) fsOverlay.style.display = 'none';
    },
    sendEvent
  };
})();
