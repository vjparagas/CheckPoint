/**
 * CheckPoint - Face Monitor Module (face.js)
 * Privacy & Anti-cheating architecture:
 * - Uses @vladmandic/face-api TinyFaceDetector client-side in the browser.
 * - Explicitly configures TensorFlow backend ('webgl' with fallback to 'cpu').
 * - Zero video or image data is ever uploaded or stored on any server.
 * - Every 5 seconds:
 *   - 0 faces for 2 consecutive checks -> send NO_FACE (30s cooldown).
 *   - 2 or more faces -> send MULTI_FACE immediately (30s cooldown).
 * - Debug line under camera preview: "backend: X | faces: N | last event: Y".
 */

(function () {
  'use strict';

  // Pinned face-api model URL (matches pinned script version 1.7.12)
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';
  const CHECK_INTERVAL_MS = 5000; // 5 seconds between checks
  const COOLDOWN_MS = 30000;       // 30 seconds cooldown per event type

  let videoElement = null;
  let debugElement = null;
  let webcamStream = null;
  let checkInterval = null;
  let consecutiveZeroFaces = 0;
  let lastNoFaceSent = 0;
  let lastMultiFaceSent = 0;
  let modelLoaded = false;
  let isRunning = false;
  let activeBackend = 'unknown';
  let lastEventName = 'none';

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function updateDebugText(line1, line2) {
    if (debugElement) {
      if (line2 !== undefined) {
        debugElement.innerHTML = `<div>${escapeHtml(line1)}</div><div>${escapeHtml(line2)}</div>`;
      } else {
        debugElement.innerHTML = `<div>${escapeHtml(line1)}</div><div>last event: ${escapeHtml(lastEventName)}</div>`;
      }
    }
  }

  function logCycleStatus(faces) {
    const line1 = `backend: ${activeBackend} | faces: ${faces}`;
    const line2 = `last event: ${lastEventName}`;
    updateDebugText(line1, line2);
    console.log(`[Face Monitor] ${line1} | ${line2}`);
  }

  /**
   * Initializes TensorFlow backend ('webgl' -> fallback 'cpu') and loads TinyFaceDetector
   */
  async function initBackendAndLoadModel() {
    if (modelLoaded) return true;

    if (typeof faceapi === 'undefined' || !faceapi.tf) {
      const errMsg = 'model error: face-api library not loaded';
      updateDebugText(errMsg);
      console.error(`[Face Monitor] ${errMsg}`);
      return false;
    }

    // 1. Explicitly set TensorFlow backend before loading models
    try {
      try {
        await faceapi.tf.setBackend('webgl');
        activeBackend = 'webgl';
      } catch (webglErr) {
        console.warn('[Face Monitor] WebGL backend failed, falling back to CPU:', webglErr);
        await faceapi.tf.setBackend('cpu');
        activeBackend = 'cpu';
      }
      await faceapi.tf.ready();
      activeBackend = (faceapi.tf.getBackend && faceapi.tf.getBackend()) || activeBackend;
      console.log(`[Face Monitor] Backend successfully set to: ${activeBackend}`);
    } catch (backendErr) {
      activeBackend = 'err';
      const errMsg = `backend error: ${backendErr.message}`;
      updateDebugText(errMsg);
      console.error(`[Face Monitor] ${errMsg}`, backendErr);
      return false;
    }

    // 2. Load model weights from pinned CDN URL
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      modelLoaded = true;
      updateDebugText(`backend: ${activeBackend} | model loaded`);
      console.log(`[Face Monitor] TinyFaceDetector model loaded from ${MODEL_URL}`);
      return true;
    } catch (modelErr) {
      const errMsg = `model-load error: ${modelErr.message}`;
      updateDebugText(errMsg);
      console.error(`[Face Monitor] ${errMsg}`, modelErr);
      return false;
    }
  }

  /**
   * Creates or retrieves the floating webcam preview corner widget with debug line
   */
  function getOrCreateWebcamUI() {
    let container = document.getElementById('webcam-preview-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'webcam-preview-container';
      container.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 260px;
        background: #0f172a;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        border: 2px solid #2563eb;
        z-index: 99999;
        display: none;
      `;

      videoElement = document.createElement('video');
      videoElement.id = 'webcam-preview-video';
      videoElement.autoplay = true;
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.setAttribute('autoplay', '');
      videoElement.setAttribute('muted', '');
      videoElement.setAttribute('playsinline', '');
      videoElement.style.cssText = `
        width: 100%;
        height: 150px;
        object-fit: cover;
        display: block;
        transform: scaleX(-1);
      `;

      const badge = document.createElement('div');
      badge.style.cssText = `
        position: absolute;
        top: 6px;
        left: 6px;
        background: rgba(15, 23, 42, 0.75);
        color: #10b981;
        font-size: 10px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 4px;
        pointer-events: none;
      `;
      badge.innerHTML = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;"></span> CAM`;

      // Debug text lines below the video preview (multi-line, no ellipsis clipping)
      debugElement = document.createElement('div');
      debugElement.id = 'webcam-debug-bar';
      debugElement.style.cssText = `
        padding: 6px 10px;
        font-size: 11px;
        line-height: 1.45;
        font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        color: #38bdf8;
        background: #1e293b;
        border-top: 1px solid #334155;
        white-space: normal;
        word-break: break-word;
        text-align: left;
      `;
      debugElement.innerHTML = '<div>backend: init... | faces: -</div><div>last event: none</div>';

      container.appendChild(videoElement);
      container.appendChild(badge);
      container.appendChild(debugElement);
      document.body ? document.body.appendChild(container) : document.addEventListener('DOMContentLoaded', () => document.body.appendChild(container));
    } else {
      videoElement = container.querySelector('video');
      debugElement = container.querySelector('#webcam-debug-bar');
    }
    return container;
  }

  /**
   * Initializes webcam stream and starts detection loop
   */
  async function start() {
    if (isRunning) return;
    isRunning = true;
    consecutiveZeroFaces = 0;
    lastEventName = 'none';

    const container = getOrCreateWebcamUI();

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Webcam mediaDevices API is not supported on this browser');
      }

      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' },
        audio: false
      });

      // Ensure attributes are strictly set
      videoElement.autoplay = true;
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.setAttribute('autoplay', '');
      videoElement.setAttribute('muted', '');
      videoElement.setAttribute('playsinline', '');

      // Assign MediaStream
      videoElement.srcObject = webcamStream;
      container.style.display = 'block';

      // 3. Wait for loadedmetadata state
      await new Promise((resolve) => {
        if (videoElement.readyState >= 1) { // HAVE_METADATA or higher
          resolve();
        } else {
          videoElement.onloadedmetadata = () => resolve();
        }
      });

      // Await video.play() and handle play errors
      try {
        await videoElement.play();
      } catch (playErr) {
        console.error('[Face Monitor] Error starting video playback:', playErr);
      }

      // Ensure video is in playing state before starting detection loop
      if (videoElement.paused) {
        await new Promise((resolve) => {
          videoElement.onplaying = () => resolve();
          setTimeout(resolve, 1000); // safety fallback
        });
      }

      // Initialize backend and load models
      await initBackendAndLoadModel();

      // Start periodic 5-second detection loop
      clearInterval(checkInterval);
      checkInterval = setInterval(runFaceDetection, CHECK_INTERVAL_MS);

      // Run immediate first evaluation
      runFaceDetection();
    } catch (err) {
      console.warn('[Face Monitor] Webcam access failed or permission denied:', err);
      updateDebugText(`cam error: ${err.message}`);

      // Notify student via banner
      if (window.lockdown && typeof window.lockdown.showWarning === 'function') {
        window.lockdown.showWarning('Camera permission denied or camera not found. This incident has been logged.');
      }

      // Send NO_FACE event to log incident for instructor review
      lastEventName = 'NO_FACE';
      if (window.monitor && typeof window.monitor.sendEvent === 'function') {
        window.monitor.sendEvent('NO_FACE', {
          error: 'Camera permission denied or camera unavailable',
          message: err.message
        });
      }
    }
  }

  /**
   * Runs TinyFaceDetector evaluation on current video frame
   */
  async function runFaceDetection() {
    if (!isRunning || !videoElement || videoElement.paused || videoElement.ended || !modelLoaded || videoElement.readyState < 2) {
      return;
    }

    try {
      // 4. Use TinyFaceDetectorOptions with inputSize 320 and scoreThreshold 0.4
      const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 });
      const detections = await faceapi.detectAllFaces(videoElement, options);
      const faceCount = detections ? detections.length : 0;
      const now = Date.now();

      // Rule: 0 faces for 2 consecutive checks -> send NO_FACE
      if (faceCount === 0) {
        consecutiveZeroFaces++;
        if (consecutiveZeroFaces >= 2) {
          if (now - lastNoFaceSent >= COOLDOWN_MS) {
            lastNoFaceSent = now;
            lastEventName = 'NO_FACE';
            if (window.monitor && typeof window.monitor.sendEvent === 'function') {
              window.monitor.sendEvent('NO_FACE', {
                message: 'No face detected in video frame for 2 consecutive checks (10s)'
              });
            }
          }
        }
      } else {
        consecutiveZeroFaces = 0;

        // Rule: 2 or more faces -> send MULTI_FACE immediately
        if (faceCount >= 2) {
          if (now - lastMultiFaceSent >= COOLDOWN_MS) {
            lastMultiFaceSent = now;
            lastEventName = 'MULTI_FACE';
            if (window.monitor && typeof window.monitor.sendEvent === 'function') {
              window.monitor.sendEvent('MULTI_FACE', {
                face_count: faceCount,
                message: `${faceCount} faces detected in video frame`
              });
            }
          }
        }
      }

      // 5. Update debug text and console log
      logCycleStatus(faceCount);
    } catch (err) {
      console.warn('[Face Monitor] Detection error:', err);
      updateDebugText(`detection error: ${err.message}`);
    }
  }

  /**
   * Stops video stream and detection loop
   */
  function stop() {
    isRunning = false;
    clearInterval(checkInterval);

    if (webcamStream) {
      webcamStream.getTracks().forEach(track => track.stop());
      webcamStream = null;
    }

    const container = document.getElementById('webcam-preview-container');
    if (container) {
      container.style.display = 'none';
    }
  }

  window.faceMonitor = {
    start,
    stop,
    loadModel: initBackendAndLoadModel
  };
})();
