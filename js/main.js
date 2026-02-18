/**
 * main.js
 * CMYK Simulator — UI Logic & Orchestration
 *
 * Responsibilities:
 * - DOM event listeners
 * - Tool state management
 * - Worker communication
 * - Canvas rendering (split view, gamut overlay)
 * - Results panel updates
 * - Color picker hover logic
 */

'use strict';

(function () {

  // ─── STATE ────────────────────────────────────────────────────────────────
  const state = {
    isProcessing: false,
    imageData: null,         // original ImageData from fileHandler
    processedPixels: null,   // output from worker
    gamutPixels: null,       // gamut overlay from worker
    stats: null,             // result stats from worker
    splitPosition: 50,       // percentage 0-100
    isDraggingSplit: false,
    settings: {
      paperType: 'coated',
      dotGain: 0.15,
      showC: true,
      showM: true,
      showY: true,
      showK: true,
      gamutOverlay: false
    }
  };

  // ─── DOM REFERENCES ───────────────────────────────────────────────────────
  const els = {
    uploadZone: document.getElementById('upload-zone'),
    fileInput: document.getElementById('file-input'),
    workspace: document.getElementById('workspace'),
    uploadSection: document.getElementById('upload-section'),
    canvas: document.getElementById('main-canvas'),
    splitHandle: document.getElementById('split-handle'),
    paperSelect: document.querySelectorAll('.paper-btn'),
    dotGainSlider: document.getElementById('dot-gain-slider'),
    dotGainValue: document.getElementById('dot-gain-value'),
    channelToggles: document.querySelectorAll('.channel-toggle'),
    gamutToggle: document.getElementById('gamut-toggle'),
    progressOverlay: document.getElementById('progress-overlay'),
    progressBar: document.getElementById('progress-bar'),
    progressText: document.getElementById('progress-text'),
    errorBanner: document.getElementById('error-banner'),
    errorMessage: document.getElementById('error-message'),
    errorClose: document.getElementById('error-close'),
    colorPicker: document.getElementById('color-picker-tooltip'),
    // Results
    avgTacVal: document.getElementById('avg-tac-val'),
    maxTacVal: document.getElementById('max-tac-val'),
    tacBar: document.getElementById('tac-bar'),
    outGamutVal: document.getElementById('out-gamut-val'),
    riskBadge: document.getElementById('risk-badge'),
    riskMessage: document.getElementById('risk-message'),
    dominantColors: document.getElementById('dominant-colors'),
    downloadBtn: document.getElementById('download-btn'),
    resetBtn: document.getElementById('reset-btn'),
    liveRegion: document.getElementById('live-region'),
    resizedNotice: document.getElementById('resized-notice'),
    imageInfo: document.getElementById('image-info')
  };

  // ─── WEB WORKER SETUP ─────────────────────────────────────────────────────
  // Create worker from file — must be same origin (fine for GitHub Pages)
  let worker = null;

  function createWorker() {
    try {
      worker = new Worker('js/worker.js');
      worker.onmessage = handleWorkerMessage;
      worker.onerror = (e) => {
        showError('Worker error: ' + e.message);
        hideProgress();
        state.isProcessing = false;
      };
    } catch (e) {
      console.warn('Web Worker unavailable, processing on main thread is not supported in this tool.');
    }
  }

  // ─── WORKER MESSAGE HANDLER ───────────────────────────────────────────────
  function handleWorkerMessage(e) {
    const { type, percent, outputPixels, gamutPixels, stats, message } = e.data;

    if (type === 'progress') {
      updateProgress(percent);
      return;
    }

    if (type === 'error') {
      showError(message);
      hideProgress();
      state.isProcessing = false;
      return;
    }

    if (type === 'result') {
      state.processedPixels = outputPixels;
      state.gamutPixels = gamutPixels;
      state.stats = stats;
      hideProgress();
      state.isProcessing = false;
      renderCanvas();
      updateResults();
      announce(`Processing complete. ${stats.risk.label}. Average ink coverage: ${stats.avgTAC}%.`);
    }
  }

  // ─── FILE UPLOAD ──────────────────────────────────────────────────────────
  function handleFile(file) {
    if (!file || state.isProcessing) return;

    hideError();
    showProgress('Loading image…', 0);

    FileHandler.prepare(file, (msg) => updateProgressText(msg))
      .then(({ imageData, width, height, wasResized }) => {
        state.imageData = imageData;

        // Set canvas internal dimensions to match image
        els.canvas.width = width;
        els.canvas.height = height;

        // Show image info
        if (els.imageInfo) {
          els.imageInfo.textContent = `${width} × ${height}px`;
        }
        if (els.resizedNotice) {
          els.resizedNotice.hidden = !wasResized;
        }

        // Draw original to canvas immediately
        const ctx = els.canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);

        // Show workspace
        els.uploadSection.hidden = true;
        els.workspace.hidden = false;
        els.workspace.setAttribute('aria-hidden', 'false');

        // Start processing
        processWithCurrentSettings();
      })
      .catch((err) => {
        hideProgress();
        showError(err.message);
      });
  }

  // ─── TRIGGER PROCESSING ───────────────────────────────────────────────────
  let processDebounceTimer = null;

  function processWithCurrentSettings() {
    if (!state.imageData || !worker) return;
    if (state.isProcessing) return;

    clearTimeout(processDebounceTimer);
    processDebounceTimer = setTimeout(() => {
      state.isProcessing = true;
      showProgress('Converting to CMYK…', 0);

      // Transfer pixels to worker (copy — not transfer — so we keep original)
      const pixelsCopy = new Uint8ClampedArray(state.imageData.data);

      worker.postMessage({
        type: 'process',
        pixels: pixelsCopy,
        settings: { ...state.settings }
      }, [pixelsCopy.buffer]);
    }, 80);
  }

  // ─── CANVAS RENDERING ─────────────────────────────────────────────────────
  function renderCanvas() {
    if (!state.imageData || !state.processedPixels) return;

    const canvas = els.canvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    const splitX = Math.round((state.splitPosition / 100) * w);

    // Draw original (left side)
    const origImageData = new ImageData(new Uint8ClampedArray(state.imageData.data), w, h);
    ctx.putImageData(origImageData, 0, 0, 0, 0, splitX, h);

    // Draw processed (right side)
    const procImageData = new ImageData(new Uint8ClampedArray(state.processedPixels), w, h);
    ctx.putImageData(procImageData, 0, 0, splitX, 0, w - splitX, h);

    // Draw gamut overlay on top of processed side (right)
    if (state.settings.gamutOverlay && state.gamutPixels) {
      const gamutImageData = new ImageData(new Uint8ClampedArray(state.gamutPixels), w, h);
      const offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      const offCtx = offscreen.getContext('2d');
      offCtx.putImageData(gamutImageData, 0, 0);
      ctx.drawImage(offscreen, splitX, 0, w - splitX, h, splitX, 0, w - splitX, h);
    }

    // Draw split divider line
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Update handle position
    updateSplitHandlePosition();

    // Labels
    drawSplitLabels(ctx, splitX, h);
  }

  function drawSplitLabels(ctx, splitX, h) {
    ctx.save();
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'top';

    // Left label: RGB Original
    if (splitX > 60) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(8, 8, 76, 22);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('RGB ORIGINAL', 14, 14);
    }

    // Right label: CMYK Simulated
    if (splitX < els.canvas.width - 80) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(splitX + 8, 8, 104, 22);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('CMYK SIMULATED', splitX + 14, 14);
    }

    ctx.restore();
  }

  // ─── SPLIT VIEW SLIDER ────────────────────────────────────────────────────
  function updateSplitHandlePosition() {
    const canvasRect = els.canvas.getBoundingClientRect();
    const container = els.canvas.parentElement;
    const containerRect = container.getBoundingClientRect();

    // Account for letterboxing
    const scaleX = canvasRect.width / els.canvas.width;
    const scaleY = canvasRect.height / els.canvas.height;
    const scale = Math.min(scaleX, scaleY);
    const renderedW = els.canvas.width * scale;
    const offsetX = (canvasRect.width - renderedW) / 2;

    const handleX = offsetX + (state.splitPosition / 100) * renderedW;
    els.splitHandle.style.left = `${handleX + canvasRect.left - containerRect.left}px`;
  }

  function initSplitSlider() {
    const container = els.canvas.parentElement;

    function onMove(clientX) {
      if (!state.isDraggingSplit) return;
      const canvasRect = els.canvas.getBoundingClientRect();
      const scaleX = canvasRect.width / els.canvas.width;
      const scaleY = canvasRect.height / els.canvas.height;
      const scale = Math.min(scaleX, scaleY);
      const renderedW = els.canvas.width * scale;
      const offsetX = (canvasRect.width - renderedW) / 2;

      const relX = clientX - canvasRect.left - offsetX;
      state.splitPosition = Math.min(100, Math.max(0, (relX / renderedW) * 100));
      renderCanvas();
    }

    els.splitHandle.addEventListener('mousedown', (e) => {
      state.isDraggingSplit = true;
      e.preventDefault();
    });
    els.splitHandle.addEventListener('touchstart', (e) => {
      state.isDraggingSplit = true;
    }, { passive: true });

    document.addEventListener('mousemove', (e) => onMove(e.clientX));
    document.addEventListener('mouseup', () => { state.isDraggingSplit = false; });
    document.addEventListener('touchmove', (e) => {
      if (state.isDraggingSplit) onMove(e.touches[0].clientX);
    }, { passive: true });
    document.addEventListener('touchend', () => { state.isDraggingSplit = false; });

    // Keyboard accessibility
    els.splitHandle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        state.splitPosition = Math.max(0, state.splitPosition - (e.shiftKey ? 10 : 1));
        renderCanvas();
      }
      if (e.key === 'ArrowRight') {
        state.splitPosition = Math.min(100, state.splitPosition + (e.shiftKey ? 10 : 1));
        renderCanvas();
      }
    });

    window.addEventListener('resize', () => {
      if (!state.imageData) return;
      updateSplitHandlePosition();
    });
  }

  // ─── COLOR PICKER HOVER ───────────────────────────────────────────────────
  let hoverThrottle = false;

  function initColorPicker() {
    const container = els.canvas.parentElement;

    container.addEventListener('mousemove', (e) => {
      if (!state.imageData || !state.processedPixels || hoverThrottle) return;
      hoverThrottle = true;
      requestAnimationFrame(() => { hoverThrottle = false; });

      const rect = els.canvas.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      const coords = FileHandler.clientToImageCoords(
        els.canvas,
        els.canvas.width,
        els.canvas.height,
        clientX,
        clientY
      );

      if (!coords.valid) {
        els.colorPicker.hidden = true;
        return;
      }

      const x = Math.min(coords.x, els.canvas.width - 1);
      const y = Math.min(coords.y, els.canvas.height - 1);

      const pixel = FileHandler.getPixelAt(state.imageData, x, y);
      if (pixel.a < 10) { els.colorPicker.hidden = true; return; }

      const cmyk = ColorEngine.getPixelCmyk(
        pixel.r, pixel.g, pixel.b,
        state.settings.paperType,
        state.settings.dotGain
      );

      // Position tooltip
      const containerRect = container.getBoundingClientRect();
      let tipX = e.clientX - containerRect.left + 16;
      let tipY = e.clientY - containerRect.top + 16;
      // Keep in bounds
      if (tipX + 180 > containerRect.width) tipX = e.clientX - containerRect.left - 200;
      if (tipY + 120 > containerRect.height) tipY = e.clientY - containerRect.top - 130;

      els.colorPicker.style.left = `${tipX}px`;
      els.colorPicker.style.top = `${tipY}px`;
      els.colorPicker.hidden = false;

      document.getElementById('cp-swatch').style.background = `rgb(${pixel.r},${pixel.g},${pixel.b})`;
      document.getElementById('cp-c').textContent = cmyk.c + '%';
      document.getElementById('cp-m').textContent = cmyk.m + '%';
      document.getElementById('cp-y').textContent = cmyk.y + '%';
      document.getElementById('cp-k').textContent = cmyk.k + '%';
      document.getElementById('cp-tac').textContent = cmyk.tac + '%';

      const tacEl = document.getElementById('cp-tac-row');
      if (cmyk.tac > state.settings.paperType === 'coated' ? 300 : state.settings.paperType === 'uncoated' ? 280 : 240) {
        tacEl.classList.add('over-limit');
      } else {
        tacEl.classList.remove('over-limit');
      }
    });

    container.addEventListener('mouseleave', () => {
      els.colorPicker.hidden = true;
    });
  }

  // ─── RESULTS PANEL ────────────────────────────────────────────────────────
  function updateResults() {
    if (!state.stats) return;
    const { avgTAC, maxTAC, outOfGamutPercent, dominantColors, risk, inkLimit } = state.stats;

    // TAC values
    els.avgTacVal.textContent = avgTAC + '%';
    els.maxTacVal.textContent = maxTAC + '%';

    // TAC progress bar
    const pct = Math.min(100, (maxTAC / 400) * 100);
    els.tacBar.style.width = pct + '%';
    els.tacBar.className = 'tac-bar-fill ' + (maxTAC > inkLimit + 30 ? 'danger' : maxTAC > inkLimit ? 'caution' : 'safe');

    // Ink limit line
    const limitPct = (inkLimit / 400) * 100;
    const limitLine = document.getElementById('tac-limit-line');
    if (limitLine) limitLine.style.left = limitPct + '%';
    const limitLabel = document.getElementById('tac-limit-label');
    if (limitLabel) limitLabel.textContent = inkLimit + '%';

    // Gamut
    els.outGamutVal.textContent = outOfGamutPercent + '%';

    // Risk
    els.riskBadge.textContent = risk.label;
    els.riskBadge.className = 'risk-badge ' + risk.level;
    els.riskMessage.textContent = risk.message;

    // Dominant colors
    els.dominantColors.innerHTML = '';
    dominantColors.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.setAttribute('title', `C:${color.c}% M:${color.m}% Y:${color.y}% K:${color.k}%`);
      swatch.setAttribute('aria-label', `Color RGB ${color.r},${color.g},${color.b}. CMYK: C${color.c}% M${color.m}% Y${color.y}% K${color.k}%`);

      const bg = document.createElement('div');
      bg.className = 'swatch-bg';
      bg.style.background = `rgb(${color.r},${color.g},${color.b})`;

      const info = document.createElement('div');
      info.className = 'swatch-info';
      info.innerHTML = `<span class="swatch-c">C${color.c}</span><span class="swatch-m">M${color.m}</span><span class="swatch-y">Y${color.y}</span><span class="swatch-k">K${color.k}</span>`;

      swatch.appendChild(bg);
      swatch.appendChild(info);
      els.dominantColors.appendChild(swatch);
    });

    // Show results panel
    document.getElementById('results-panel').hidden = false;
  }

  // ─── CONTROLS ─────────────────────────────────────────────────────────────
  function initControls() {
    // Paper type buttons
    els.paperSelect.forEach(btn => {
      btn.addEventListener('click', () => {
        els.paperSelect.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        state.settings.paperType = btn.dataset.paper;

        // Update dot gain default for paper type
        const defaults = { coated: 15, uncoated: 22, newsprint: 30 };
        const defaultGain = defaults[state.settings.paperType];
        els.dotGainSlider.value = defaultGain;
        els.dotGainValue.textContent = defaultGain + '%';
        state.settings.dotGain = defaultGain / 100;

        // Update paper description
        const desc = document.getElementById('paper-desc');
        const descriptions = {
          coated: 'Coated / Glossy — ISO Coated v2 (FOGRA39 approx.) — Ink limit: 300%',
          uncoated: 'Uncoated / Matte — ISO Uncoated — Ink limit: 280%',
          newsprint: 'Newsprint — SNAP standard — Ink limit: 240% — Heavy dot gain'
        };
        if (desc) desc.textContent = descriptions[state.settings.paperType];

        if (state.imageData) processWithCurrentSettings();
      });
    });

    // Dot gain slider
    els.dotGainSlider.addEventListener('input', () => {
      const val = parseInt(els.dotGainSlider.value, 10);
      els.dotGainValue.textContent = val + '%';
      state.settings.dotGain = val / 100;
      if (state.imageData) processWithCurrentSettings();
    });

    // Channel toggles
    els.channelToggles.forEach(toggle => {
      toggle.addEventListener('click', () => {
        const ch = toggle.dataset.channel;
        const isActive = toggle.classList.contains('active');
        toggle.classList.toggle('active', !isActive);
        toggle.setAttribute('aria-pressed', String(!isActive));
        state.settings['show' + ch.toUpperCase()] = !isActive;
        if (state.imageData && state.processedPixels) processWithCurrentSettings();
      });
    });

    // Gamut warning toggle
    els.gamutToggle.addEventListener('click', () => {
      const isActive = els.gamutToggle.classList.contains('active');
      els.gamutToggle.classList.toggle('active', !isActive);
      els.gamutToggle.setAttribute('aria-pressed', String(!isActive));
      state.settings.gamutOverlay = !isActive;
      if (state.processedPixels) renderCanvas();
    });
  }

  // ─── DOWNLOAD ─────────────────────────────────────────────────────────────
  function initDownload() {
    if (!els.downloadBtn) return;
    els.downloadBtn.addEventListener('click', () => {
      if (!state.processedPixels) return;
      const link = document.createElement('a');
      link.download = 'cmyk-simulation.png';
      link.href = els.canvas.toDataURL('image/png');
      link.click();
    });
  }

  // ─── RESET ────────────────────────────────────────────────────────────────
  function initReset() {
    if (!els.resetBtn) return;
    els.resetBtn.addEventListener('click', () => {
      state.imageData = null;
      state.processedPixels = null;
      state.gamutPixels = null;
      state.stats = null;
      state.splitPosition = 50;
      els.workspace.hidden = true;
      els.workspace.setAttribute('aria-hidden', 'true');
      els.uploadSection.hidden = false;
      document.getElementById('results-panel').hidden = true;
      els.colorPicker.hidden = true;
      els.fileInput.value = '';
      announce('Tool reset. Upload a new image to begin.');
    });
  }

  // ─── UPLOAD ZONE ──────────────────────────────────────────────────────────
  function initUploadZone() {
    // Click to open file picker
    els.uploadZone.addEventListener('click', () => els.fileInput.click());
    els.uploadZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        els.fileInput.click();
      }
    });

    // File input change
    els.fileInput.addEventListener('change', () => {
      if (els.fileInput.files[0]) handleFile(els.fileInput.files[0]);
    });

    // Drag and drop
    ['dragenter', 'dragover'].forEach(evt => {
      els.uploadZone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.uploadZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'dragend'].forEach(evt => {
      els.uploadZone.addEventListener(evt, () => {
        els.uploadZone.classList.remove('drag-over');
      });
    });

    els.uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.uploadZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    // Also accept drops on document level
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && !els.workspace.offsetParent) handleFile(file);
    });
  }

  // ─── PROGRESS UI ──────────────────────────────────────────────────────────
  function showProgress(text, percent) {
    els.progressOverlay.hidden = false;
    els.progressOverlay.setAttribute('aria-hidden', 'false');
    updateProgressText(text);
    updateProgress(percent);
  }

  function updateProgress(percent) {
    els.progressBar.style.width = percent + '%';
    els.progressBar.setAttribute('aria-valuenow', percent);
  }

  function updateProgressText(text) {
    els.progressText.textContent = text;
  }

  function hideProgress() {
    els.progressOverlay.hidden = true;
    els.progressOverlay.setAttribute('aria-hidden', 'true');
  }

  // ─── ERROR UI ─────────────────────────────────────────────────────────────
  function showError(message) {
    els.errorMessage.textContent = message;
    els.errorBanner.hidden = false;
    els.errorBanner.focus();
    announce('Error: ' + message);
  }

  function hideError() {
    els.errorBanner.hidden = true;
  }

  // ─── ACCESSIBILITY ANNOUNCE ───────────────────────────────────────────────
  function announce(message) {
    if (!els.liveRegion) return;
    els.liveRegion.textContent = '';
    requestAnimationFrame(() => { els.liveRegion.textContent = message; });
  }

  // ─── REDUCED MOTION ───────────────────────────────────────────────────────
  function applyReducedMotion() {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      document.documentElement.classList.add('reduced-motion');
    }
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    applyReducedMotion();
    createWorker();
    initUploadZone();
    initControls();
    initSplitSlider();
    initColorPicker();
    initDownload();
    initReset();

    // Error close button
    if (els.errorClose) {
      els.errorClose.addEventListener('click', hideError);
    }

    // Initial paper desc
    const desc = document.getElementById('paper-desc');
    if (desc) desc.textContent = 'Coated / Glossy — ISO Coated v2 (FOGRA39 approx.) — Ink limit: 300%';

    // Workspace starts hidden
    els.workspace.hidden = true;
    els.workspace.setAttribute('aria-hidden', 'true');
    document.getElementById('results-panel').hidden = true;
    els.progressOverlay.hidden = true;
    els.errorBanner.hidden = true;
    els.colorPicker.hidden = true;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
