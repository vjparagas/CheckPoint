/**
 * CheckPoint - Client Lockdown Module (lockdown.js)
 * Anti-cheating controls:
 * - Disables clipboard operations (copy, paste, cut)
 * - Disables right-click context menu and text selection
 * - Intercepts print attempts
 * - Blocks devtools, source inspection, and shortcut keys
 * - Displays an immediate warning banner on any disallowed interaction
 */

(function () {
  'use strict';

  // Inject top warning banner into DOM
  let banner = document.getElementById('lockdown-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'lockdown-banner';
    banner.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0;
      background: #d93025;
      color: #ffffff;
      text-align: center;
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 600;
      z-index: 1000000;
      box-shadow: 0 2px 10px rgba(0,0,0,0.25);
      display: none;
      transition: opacity 0.2s ease-in-out;
    `;
    document.body ? document.body.appendChild(banner) : document.addEventListener('DOMContentLoaded', () => document.body.appendChild(banner));
  }

  let bannerTimer = null;
  function showWarning(message) {
    if (!banner) return;
    banner.textContent = `⚠️ Action Blocked: ${message}`;
    banner.style.display = 'block';
    banner.style.opacity = '1';

    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; }, 200);
    }, 2500);
  }

  // 1. Block Clipboard: Copy, Cut, Paste
  ['copy', 'cut', 'paste'].forEach(eventType => {
    document.addEventListener(eventType, (e) => {
      e.preventDefault();
      showWarning(`Clipboard action (${eventType.toUpperCase()}) is disabled during exams.`);
    }, true);
  });

  // 2. Block Right-Click Context Menu
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showWarning('Right-click context menu is disabled.');
  }, true);

  // 3. Block Text Selection
  document.addEventListener('selectstart', (e) => {
    // Allow text selection inside input fields if needed, otherwise block
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
    }
  }, true);

  // 4. Block Print Operations
  window.addEventListener('beforeprint', (e) => {
    e.preventDefault();
    showWarning('Printing is strictly prohibited.');
  });

  // 5. Block Restricted Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    const key = e.key.toUpperCase();

    // DevTools: F12
    if (e.key === 'F12') {
      e.preventDefault();
      showWarning('Developer tools shortcut (F12) is blocked.');
      return;
    }

    // DevTools: Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
    if (isCtrlOrCmd && e.shiftKey && ['I', 'J', 'C'].includes(key)) {
      e.preventDefault();
      showWarning('Developer tools inspection shortcut is blocked.');
      return;
    }

    // View Source: Ctrl+U
    if (isCtrlOrCmd && key === 'U') {
      e.preventDefault();
      showWarning('Viewing source code (Ctrl+U) is blocked.');
      return;
    }

    // Print: Ctrl+P
    if (isCtrlOrCmd && key === 'P') {
      e.preventDefault();
      showWarning('Print shortcut (Ctrl+P) is blocked.');
      return;
    }

    // Save Page: Ctrl+S
    if (isCtrlOrCmd && key === 'S') {
      e.preventDefault();
      showWarning('Saving page (Ctrl+S) is blocked.');
      return;
    }

    // Clipboard keys: Ctrl+C, Ctrl+V, Ctrl+X
    if (isCtrlOrCmd && ['C', 'V', 'X'].includes(key)) {
      e.preventDefault();
      showWarning(`Copy/Paste keyboard shortcut (${e.ctrlKey ? 'Ctrl+' : 'Cmd+'}${key}) is blocked.`);
      return;
    }
  }, true);

  window.lockdown = {
    showWarning
  };
})();
