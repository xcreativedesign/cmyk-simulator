/**
 * main.js — CMYK Simulator UI + Inlined Worker
 * Worker code is embedded as a string blob to avoid all path/MIME/CSP issues on GitHub Pages.
 */

'use strict';

(function () {

  // ─── INLINED WORKER CODE ──────────────────────────────────────────────────
  // Embedding the worker as a string eliminates every possible path/fetch/CSP issue.
  const WORKER_CODE = `
'use strict';

var PAPER_PROFILES = {
  coated:   { name:'Coated',   dotGain:0.15, inkLimit:300, gamutReduction:0,    shadowGain:0.8, highlightGain:0.4 },
  uncoated: { name:'Uncoated', dotGain:0.22, inkLimit:280, gamutReduction:0.08, shadowGain:1.0, highlightGain:0.5 },
  newsprint:{ name:'Newsprint',dotGain:0.30, inkLimit:240, gamutReduction:0.18, shadowGain:1.3, highlightGain:0.6 }
};

function rgbToCmyk(r,g,b){
  var k=1-Math.max(r,g,b);
  if(k>=1) return {c:0,m:0,y:0,k:1};
  var d=1-k;
  return {c:(1-r-k)/d, m:(1-g-k)/d, y:(1-b-k)/d, k:k};
}

function cmykToRgb(c,m,y,k){
  return {
    r:Math.round(255*(1-c)*(1-k)),
    g:Math.round(255*(1-m)*(1-k)),
    b:Math.round(255*(1-y)*(1-k))
  };
}

function applyDotGain(v,gain,sg,hg){
  if(v<=0) return 0;
  if(v>=1) return 1;
  var mb=Math.sin(Math.PI*v);
  var pw=v<0.5 ? hg+(sg-hg)*(v*2) : sg-(sg-hg)*((v-0.5)*2);
  return Math.min(1,Math.max(0,v+gain*mb*pw));
}

function isOutOfGamut(r,g,b,pt){
  var p=PAPER_PROFILES[pt];
  var rn=r/255,gn=g/255,bn=b/255;
  var mx=Math.max(rn,gn,bn),mn=Math.min(rn,gn,bn);
  var li=(mx+mn)/2;
  var sat=mx===mn?0:(mx-mn)/(li>0.5?2-mx-mn:mx+mn);
  var hue=0;
  if(mx!==mn){
    var d=mx-mn;
    if(mx===rn) hue=((gn-bn)/d+(gn<bn?6:0))/6;
    else if(mx===gn) hue=((bn-rn)/d+2)/6;
    else hue=((rn-gn)/d+4)/6;
  }
  var thr=0.82-p.gamutReduction;
  if((hue>0.22&&hue<0.42&&sat>0.7)||(hue>0.55&&hue<0.72&&sat>0.75&&li>0.3)||(hue>0.05&&hue<0.12&&sat>0.85)) thr-=0.12;
  if(li<0.08||li>0.94) return false;
  return sat>thr;
}

function extractDominantColors(pixels){
  var b={},total=pixels.length/4;
  for(var i=0;i<total;i+=8){
    var idx=i*4;
    if(pixels[idx+3]<128) continue;
    var r=Math.round(pixels[idx]/32)*32,g=Math.round(pixels[idx+1]/32)*32,bv=Math.round(pixels[idx+2]/32)*32;
    var key=r+','+g+','+bv;
    b[key]=(b[key]||0)+1;
  }
  var entries=[];
  for(var k in b) entries.push([k,b[k]]);
  entries.sort(function(a,z){return z[1]-a[1];});
  return entries.slice(0,5).map(function(entry){
    var parts=entry[0].split(',').map(Number);
    var r=parts[0],g=parts[1],bv=parts[2];
    var c=rgbToCmyk(r/255,g/255,bv/255);
    return {r:r,g:g,b:bv,c:Math.round(c.c*100),m:Math.round(c.m*100),y:Math.round(c.y*100),k:Math.round(c.k*100)};
  });
}

function processImage(pixels,settings){
  var paperType=settings.paperType,dotGain=settings.dotGain;
  var showC=settings.showC,showM=settings.showM,showY=settings.showY,showK=settings.showK;
  var gamutOverlay=settings.gamutOverlay;
  var prof=PAPER_PROFILES[paperType];
  var count=Math.floor(pixels.length/4);
  var out=new Uint8ClampedArray(pixels.length);
  var gam=new Uint8ClampedArray(pixels.length);
  var totalTAC=0,maxTAC=0,oogCount=0,procCount=0;
  var interval=Math.max(1,Math.floor(count/20));

  for(var i=0;i<count;i++){
    if(i%interval===0) self.postMessage({type:'progress',percent:Math.round(i/count*100)});
    var idx=i*4;
    var r=pixels[idx],g=pixels[idx+1],bv=pixels[idx+2],a=pixels[idx+3];
    if(a===0){out[idx]=255;out[idx+1]=255;out[idx+2]=255;out[idx+3]=255;gam[idx+3]=0;continue;}

    var cmyk=rgbToCmyk(r/255,g/255,bv/255);
    var c=applyDotGain(cmyk.c,dotGain,prof.shadowGain,prof.highlightGain);
    var m=applyDotGain(cmyk.m,dotGain,prof.shadowGain,prof.highlightGain);
    var y=applyDotGain(cmyk.y,dotGain,prof.shadowGain,prof.highlightGain);
    var k=applyDotGain(cmyk.k,dotGain,prof.shadowGain,prof.highlightGain);

    if(prof.gamutReduction>0){
      c=Math.min(1,c+c*prof.gamutReduction*0.5);
      m=Math.min(1,m+m*prof.gamutReduction*0.3);
      y=Math.min(1,y+y*prof.gamutReduction*0.3);
    }

    var tac=(c+m+y+k)*100;
    totalTAC+=tac;
    if(tac>maxTAC) maxTAC=tac;
    var oog=isOutOfGamut(r,g,bv,paperType);
    if(oog) oogCount++;

    var rgb=cmykToRgb(showC?c:0,showM?m:0,showY?y:0,showK?k:0);
    out[idx]=rgb.r;out[idx+1]=rgb.g;out[idx+2]=rgb.b;out[idx+3]=a;

    if(gamutOverlay&&oog){gam[idx]=220;gam[idx+1]=38;gam[idx+2]=38;gam[idx+3]=150;}
    else{gam[idx+3]=0;}
    procCount++;
  }

  var avgTAC=procCount>0?totalTAC/procCount:0;
  var oogPct=procCount>0?(oogCount/procCount)*100:0;
  var lim=prof.inkLimit;
  var risk;
  if(maxTAC>lim+30||oogPct>25) risk={level:'danger',label:'High Risk',message:'Max ink coverage ('+Math.round(maxTAC)+'%) exceeds the '+lim+'% limit for '+prof.name+' paper.'};
  else if(maxTAC>lim||oogPct>10) risk={level:'caution',label:'Caution',message:'Some areas approach the '+lim+'% ink limit for '+prof.name+' paper. Review highlighted regions.'};
  else risk={level:'safe',label:'Looking Good',message:'Ink coverage is within acceptable range for '+prof.name+' paper. Always verify with ICC soft proof before final production.'};

  return {outputPixels:out,gamutPixels:gam,stats:{avgTAC:Math.round(avgTAC),maxTAC:Math.round(maxTAC),outOfGamutCount:oogCount,outOfGamutPercent:Math.round(oogPct*10)/10,dominantColors:extractDominantColors(pixels),risk:risk,inkLimit:lim}};
}

self.onmessage=function(e){
  if(e.data.type!=='process') return;
  try{
    var px=e.data.pixels;
    if(!px||px.length===0) throw new Error('No pixel data received.');
    var result=processImage(px,e.data.settings);
    self.postMessage({type:'result',outputPixels:result.outputPixels,gamutPixels:result.gamutPixels,stats:result.stats},[result.outputPixels.buffer,result.gamutPixels.buffer]);
  }catch(err){
    self.postMessage({type:'error',message:err.message||'Unknown processing error'});
  }
};
`;

  // ─── STATE ────────────────────────────────────────────────────────────────
  var state = {
    isProcessing: false,
    imageData: null,
    processedPixels: null,
    gamutPixels: null,
    stats: null,
    splitPosition: 50,
    isDraggingSplit: false,
    settings: {
      paperType: 'coated',
      dotGain: 0.15,
      showC: true, showM: true, showY: true, showK: true,
      gamutOverlay: false
    }
  };

  // ─── DOM ──────────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  var els = {
    uploadZone:     $('upload-zone'),
    fileInput:      $('file-input'),
    workspace:      $('workspace'),
    uploadSection:  $('upload-section'),
    canvas:         $('main-canvas'),
    splitHandle:    $('split-handle'),
    paperBtns:      document.querySelectorAll('.paper-btn'),
    dotGainSlider:  $('dot-gain-slider'),
    dotGainValue:   $('dot-gain-value'),
    channelToggles: document.querySelectorAll('.channel-toggle'),
    gamutToggle:    $('gamut-toggle'),
    progressOverlay:$('progress-overlay'),
    progressBar:    $('progress-bar'),
    progressText:   $('progress-text'),
    errorBanner:    $('error-banner'),
    errorMessage:   $('error-message'),
    errorClose:     $('error-close'),
    colorPicker:    $('color-picker-tooltip'),
    avgTacVal:      $('avg-tac-val'),
    maxTacVal:      $('max-tac-val'),
    tacBar:         $('tac-bar'),
    outGamutVal:    $('out-gamut-val'),
    riskBadge:      $('risk-badge'),
    riskMessage:    $('risk-message'),
    dominantColors: $('dominant-colors'),
    downloadBtn:    $('download-btn'),
    resetBtn:       $('reset-btn'),
    liveRegion:     $('live-region'),
    resizedNotice:  $('resized-notice'),
    imageInfo:      $('image-info'),
    resultsPanel:   $('results-panel'),
    paperDesc:      $('paper-desc'),
    tacLimitLine:   $('tac-limit-line'),
    tacLimitLabel:  $('tac-limit-label')
  };

  // ─── WORKER ───────────────────────────────────────────────────────────────
  var worker = null;

  function createWorker() {
    try {
      var blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
      var url  = URL.createObjectURL(blob);
      worker   = new Worker(url);

      // Revoke after 5s — by then the worker script is definitely loaded
      setTimeout(function() { URL.revokeObjectURL(url); }, 5000);

      worker.onmessage = handleWorkerMessage;
      worker.onerror   = function(e) {
        console.error('[CMYK] Worker error event:', e);
        showError('Processing error: ' + (e.message || 'Unknown. See browser console for details.'));
        hideProgress();
        state.isProcessing = false;
      };
      console.log('[CMYK] Worker created successfully');
    } catch(err) {
      console.error('[CMYK] Worker creation failed:', err);
      showError('Could not start processing engine: ' + err.message);
    }
  }

  function handleWorkerMessage(e) {
    var data = e.data;
    if (data.type === 'progress') {
      updateProgress(data.percent);
      updateProgressText('Converting to CMYK\u2026 ' + data.percent + '%');
      return;
    }
    if (data.type === 'error') {
      console.error('[CMYK] Worker error message:', data.message);
      showError(data.message);
      hideProgress();
      state.isProcessing = false;
      return;
    }
    if (data.type === 'result') {
      console.log('[CMYK] Result received. avgTAC:', data.stats.avgTAC);
      state.processedPixels = data.outputPixels;
      state.gamutPixels     = data.gamutPixels;
      state.stats           = data.stats;
      state.isProcessing    = false;
      hideProgress();
      renderCanvas();
      updateResults();
      announce('Done. ' + data.stats.risk.label + '. Average ink: ' + data.stats.avgTAC + '%.');
    }
  }

  // ─── FILE UPLOAD ──────────────────────────────────────────────────────────
  function handleFile(file) {
    if (!file || state.isProcessing) return;
    console.log('[CMYK] File selected:', file.name, file.size, file.type);
    hideError();
    showProgress('Loading image\u2026', 0);

    FileHandler.prepare(file, function(msg) { updateProgressText(msg); })
      .then(function(result) {
        var imageData = result.imageData, width = result.width, height = result.height, wasResized = result.wasResized;
        console.log('[CMYK] Image ready:', width + 'x' + height, wasResized ? '(resized)' : '');
        state.imageData = imageData;
        els.canvas.width  = width;
        els.canvas.height = height;

        if (els.imageInfo)     els.imageInfo.textContent = width + ' \xd7 ' + height + 'px';
        if (els.resizedNotice) els.resizedNotice.hidden = !wasResized;

        var ctx = els.canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);

        els.uploadSection.hidden = true;
        els.workspace.hidden     = false;
        els.workspace.setAttribute('aria-hidden', 'false');

        processWithCurrentSettings();
      })
      .catch(function(err) {
        console.error('[CMYK] Prepare error:', err);
        hideProgress();
        showError(err.message || 'Could not load image. Please try another file.');
      });
  }

  // ─── PROCESS ──────────────────────────────────────────────────────────────
  var debounceTimer = null;

  function processWithCurrentSettings() {
    if (!state.imageData) { console.warn('[CMYK] No imageData'); return; }
    if (!worker)          { hideProgress(); showError('Processing engine not ready. Please refresh.'); return; }
    if (state.isProcessing) { console.log('[CMYK] Already processing'); return; }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      if (!state.imageData || !worker) return;

      state.isProcessing = true;
      showProgress('Converting to CMYK\u2026 0%', 0);

      try {
        var src  = state.imageData.data;
        var copy = new Uint8ClampedArray(src.length);
        copy.set(src);
        console.log('[CMYK] Posting', copy.length, 'bytes to worker. Settings:', JSON.stringify(state.settings));

        worker.postMessage(
          { type: 'process', pixels: copy, settings: {
              paperType:   state.settings.paperType,
              dotGain:     state.settings.dotGain,
              showC:       state.settings.showC,
              showM:       state.settings.showM,
              showY:       state.settings.showY,
              showK:       state.settings.showK,
              gamutOverlay:state.settings.gamutOverlay
            }
          },
          [copy.buffer]
        );
      } catch(err) {
        console.error('[CMYK] postMessage failed:', err);
        hideProgress();
        showError('Send to processor failed: ' + err.message);
        state.isProcessing = false;
      }
    }, 60);
  }

  // ─── CANVAS ───────────────────────────────────────────────────────────────
  function renderCanvas() {
    if (!state.imageData || !state.processedPixels) return;
    var canvas = els.canvas;
    var ctx    = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var splitX = Math.round((state.splitPosition / 100) * w);

    ctx.putImageData(new ImageData(new Uint8ClampedArray(state.imageData.data), w, h), 0, 0, 0, 0, splitX, h);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(state.processedPixels), w, h), 0, 0, splitX, 0, w - splitX, h);

    if (state.settings.gamutOverlay && state.gamutPixels) {
      var off = document.createElement('canvas');
      off.width = w; off.height = h;
      off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(state.gamutPixels), w, h), 0, 0);
      ctx.drawImage(off, splitX, 0, w - splitX, h, splitX, 0, w - splitX, h);
    }

    ctx.save();
    ctx.beginPath(); ctx.moveTo(splitX, 0); ctx.lineTo(splitX, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = '700 11px system-ui,sans-serif'; ctx.textBaseline = 'top';
    if (splitX > 70)    { ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(8,8,80,22); ctx.fillStyle='#fff'; ctx.fillText('RGB ORIGINAL', 14, 14); }
    if (splitX < w-90)  { ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(splitX+8,8,108,22); ctx.fillStyle='#fff'; ctx.fillText('CMYK SIMULATED', splitX+14, 14); }
    ctx.restore();

    updateSplitHandlePosition();
  }

  // ─── SPLIT ────────────────────────────────────────────────────────────────
  function updateSplitHandlePosition() {
    if (!state.imageData) return;
    var rect = els.canvas.getBoundingClientRect();
    var cont = els.canvas.parentElement.getBoundingClientRect();
    var scale = Math.min(rect.width / els.canvas.width, rect.height / els.canvas.height);
    var rw = els.canvas.width * scale;
    var ox = (rect.width - rw) / 2;
    els.splitHandle.style.left = (ox + (state.splitPosition / 100) * rw + rect.left - cont.left) + 'px';
  }

  function initSplitSlider() {
    function moveTo(clientX) {
      if (!state.isDraggingSplit) return;
      var rect  = els.canvas.getBoundingClientRect();
      var scale = Math.min(rect.width / els.canvas.width, rect.height / els.canvas.height);
      var rw    = els.canvas.width * scale;
      var ox    = (rect.width - rw) / 2;
      state.splitPosition = Math.min(100, Math.max(0, ((clientX - rect.left - ox) / rw) * 100));
      renderCanvas();
    }
    els.splitHandle.addEventListener('mousedown', function(e) { state.isDraggingSplit = true; e.preventDefault(); });
    els.splitHandle.addEventListener('touchstart', function() { state.isDraggingSplit = true; }, { passive: true });
    document.addEventListener('mousemove', function(e) { moveTo(e.clientX); });
    document.addEventListener('mouseup',   function()  { state.isDraggingSplit = false; });
    document.addEventListener('touchmove', function(e) { if(state.isDraggingSplit) moveTo(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('touchend',  function()  { state.isDraggingSplit = false; });
    els.splitHandle.addEventListener('keydown', function(e) {
      if (e.key==='ArrowLeft')  { state.splitPosition = Math.max(0,   state.splitPosition-(e.shiftKey?10:1)); renderCanvas(); }
      if (e.key==='ArrowRight') { state.splitPosition = Math.min(100, state.splitPosition+(e.shiftKey?10:1)); renderCanvas(); }
    });
    window.addEventListener('resize', function() { if(state.imageData) updateSplitHandlePosition(); });
  }

  // ─── COLOR PICKER ─────────────────────────────────────────────────────────
  function initColorPicker() {
    var container = els.canvas.parentElement;
    var throttle  = false;
    container.addEventListener('mousemove', function(e) {
      if (!state.imageData || !state.processedPixels || throttle) return;
      throttle = true;
      requestAnimationFrame(function() { throttle = false; });
      var rect   = els.canvas.getBoundingClientRect();
      var coords = FileHandler.clientToImageCoords(els.canvas, els.canvas.width, els.canvas.height, e.clientX - rect.left, e.clientY - rect.top);
      if (!coords.valid) { els.colorPicker.hidden = true; return; }
      var px = FileHandler.getPixelAt(state.imageData, Math.min(coords.x, els.canvas.width-1), Math.min(coords.y, els.canvas.height-1));
      if (px.a < 10) { els.colorPicker.hidden = true; return; }
      var cmyk = ColorEngine.getPixelCmyk(px.r, px.g, px.b, state.settings.paperType, state.settings.dotGain);
      var cRect = container.getBoundingClientRect();
      var tipX = e.clientX - cRect.left + 16, tipY = e.clientY - cRect.top + 16;
      if (tipX + 190 > cRect.width)  tipX = e.clientX - cRect.left - 196;
      if (tipY + 130 > cRect.height) tipY = e.clientY - cRect.top - 136;
      els.colorPicker.style.left = tipX + 'px';
      els.colorPicker.style.top  = tipY + 'px';
      els.colorPicker.hidden     = false;
      $('cp-swatch').style.background = 'rgb('+px.r+','+px.g+','+px.b+')';
      $('cp-c').textContent = cmyk.c + '%'; $('cp-m').textContent = cmyk.m + '%';
      $('cp-y').textContent = cmyk.y + '%'; $('cp-k').textContent = cmyk.k + '%';
      $('cp-tac').textContent = cmyk.tac + '%';
    });
    container.addEventListener('mouseleave', function() { els.colorPicker.hidden = true; });
  }

  // ─── RESULTS ──────────────────────────────────────────────────────────────
  function updateResults() {
    if (!state.stats) return;
    var s = state.stats;
    els.avgTacVal.textContent   = s.avgTAC + '%';
    els.maxTacVal.textContent   = s.maxTAC + '%';
    els.outGamutVal.textContent = s.outOfGamutPercent + '%';
    els.tacBar.style.width = Math.min(100, (s.maxTAC / 400) * 100) + '%';
    els.tacBar.className   = 'tac-bar-fill ' + (s.maxTAC > s.inkLimit + 30 ? 'danger' : s.maxTAC > s.inkLimit ? 'caution' : 'safe');
    if (els.tacLimitLine)  els.tacLimitLine.style.left = ((s.inkLimit / 400) * 100) + '%';
    if (els.tacLimitLabel) els.tacLimitLabel.textContent = s.inkLimit + '%';
    els.riskBadge.textContent   = s.risk.label;
    els.riskBadge.className     = 'risk-badge ' + s.risk.level;
    els.riskMessage.textContent = s.risk.message;
    els.dominantColors.innerHTML = '';
    s.dominantColors.forEach(function(color) {
      var sw = document.createElement('div');
      sw.className = 'color-swatch';
      var bg = document.createElement('div');
      bg.className = 'swatch-bg';
      bg.style.background = 'rgb('+color.r+','+color.g+','+color.b+')';
      var info = document.createElement('div');
      info.className = 'swatch-info';
      info.innerHTML = '<span class="swatch-c">C'+color.c+'</span><span class="swatch-m">M'+color.m+'</span><span class="swatch-y">Y'+color.y+'</span><span class="swatch-k">K'+color.k+'</span>';
      sw.appendChild(bg); sw.appendChild(info);
      els.dominantColors.appendChild(sw);
    });
    els.resultsPanel.hidden = false;
  }

  // ─── CONTROLS ─────────────────────────────────────────────────────────────
  var PAPER_DEFAULTS = {
    coated:   { gain: 15, desc: 'Coated / Glossy \u2014 ISO Coated v2 (FOGRA39 approx.) \u2014 Ink limit: 300%' },
    uncoated: { gain: 22, desc: 'Uncoated / Matte \u2014 ISO Uncoated (FOGRA29 approx.) \u2014 Ink limit: 280%' },
    newsprint:{ gain: 30, desc: 'Newsprint \u2014 SNAP standard \u2014 Ink limit: 240% \u2014 Heavy dot gain' }
  };

  function initControls() {
    els.paperBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        els.paperBtns.forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed','false'); });
        btn.classList.add('active'); btn.setAttribute('aria-pressed','true');
        state.settings.paperType = btn.dataset.paper;
        var def = PAPER_DEFAULTS[state.settings.paperType];
        els.dotGainSlider.value = def.gain;
        els.dotGainValue.textContent = def.gain + '%';
        state.settings.dotGain = def.gain / 100;
        if (els.paperDesc) els.paperDesc.textContent = def.desc;
        if (state.imageData) processWithCurrentSettings();
      });
    });

    els.dotGainSlider.addEventListener('input', function() {
      var v = parseInt(els.dotGainSlider.value, 10);
      els.dotGainValue.textContent = v + '%';
      state.settings.dotGain = v / 100;
      if (state.imageData) processWithCurrentSettings();
    });

    els.channelToggles.forEach(function(toggle) {
      toggle.addEventListener('click', function() {
        var ch = toggle.dataset.channel;
        var active = toggle.classList.contains('active');
        toggle.classList.toggle('active', !active);
        toggle.setAttribute('aria-pressed', String(!active));
        state.settings['show' + ch.toUpperCase()] = !active;
        if (state.imageData && state.processedPixels) processWithCurrentSettings();
      });
    });

    els.gamutToggle.addEventListener('click', function() {
      var active = els.gamutToggle.classList.contains('active');
      els.gamutToggle.classList.toggle('active', !active);
      els.gamutToggle.setAttribute('aria-pressed', String(!active));
      state.settings.gamutOverlay = !active;
      if (state.processedPixels) renderCanvas();
    });
  }

  // ─── UPLOAD ZONE ──────────────────────────────────────────────────────────
  function initUploadZone() {
    els.uploadZone.addEventListener('click', function() { els.fileInput.click(); });
    els.uploadZone.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
    });
    els.fileInput.addEventListener('change', function() {
      if (els.fileInput.files[0]) handleFile(els.fileInput.files[0]);
    });
    ['dragenter','dragover'].forEach(function(evt) {
      els.uploadZone.addEventListener(evt, function(e) { e.preventDefault(); els.uploadZone.classList.add('drag-over'); });
    });
    ['dragleave','dragend'].forEach(function(evt) {
      els.uploadZone.addEventListener(evt, function() { els.uploadZone.classList.remove('drag-over'); });
    });
    els.uploadZone.addEventListener('drop', function(e) {
      e.preventDefault(); els.uploadZone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    document.addEventListener('dragover', function(e) { e.preventDefault(); });
    document.addEventListener('drop', function(e) {
      e.preventDefault();
      if (e.dataTransfer.files[0] && els.workspace.hidden) handleFile(e.dataTransfer.files[0]);
    });
  }

  // ─── DOWNLOAD / RESET ─────────────────────────────────────────────────────
  function initDownload() {
    if (!els.downloadBtn) return;
    els.downloadBtn.addEventListener('click', function() {
      if (!state.processedPixels) return;
      var a = document.createElement('a');
      a.download = 'cmyk-simulation.png';
      a.href = els.canvas.toDataURL('image/png');
      a.click();
    });
  }

  function initReset() {
    if (!els.resetBtn) return;
    els.resetBtn.addEventListener('click', function() {
      state.imageData = null; state.processedPixels = null;
      state.gamutPixels = null; state.stats = null;
      state.splitPosition = 50; state.isProcessing = false;
      els.workspace.hidden = true; els.workspace.setAttribute('aria-hidden','true');
      els.uploadSection.hidden = false; els.resultsPanel.hidden = true;
      els.colorPicker.hidden = true; els.fileInput.value = '';
      announce('Tool reset. Upload a new image to begin.');
    });
  }

  // ─── PROGRESS / ERROR / ANNOUNCE ──────────────────────────────────────────
  function showProgress(text, pct) {
    els.progressOverlay.hidden = false;
    els.progressOverlay.setAttribute('aria-hidden','false');
    updateProgressText(text); updateProgress(pct);
  }
  function updateProgress(pct) {
    els.progressBar.style.width = pct + '%';
    els.progressBar.setAttribute('aria-valuenow', pct);
  }
  function updateProgressText(text) { els.progressText.textContent = text; }
  function hideProgress() {
    els.progressOverlay.hidden = true;
    els.progressOverlay.setAttribute('aria-hidden','true');
  }
  function showError(msg) { els.errorMessage.textContent = msg; els.errorBanner.hidden = false; announce('Error: ' + msg); }
  function hideError()    { els.errorBanner.hidden = true; }
  function announce(msg)  {
    if (!els.liveRegion) return;
    els.liveRegion.textContent = '';
    requestAnimationFrame(function() { els.liveRegion.textContent = msg; });
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.documentElement.classList.add('reduced-motion');
    }
    els.workspace.hidden       = true;
    els.workspace.setAttribute('aria-hidden','true');
    els.resultsPanel.hidden    = true;
    els.progressOverlay.hidden = true;
    els.errorBanner.hidden     = true;
    els.colorPicker.hidden     = true;
    if (els.paperDesc) els.paperDesc.textContent = PAPER_DEFAULTS.coated.desc;

    createWorker();
    initUploadZone();
    initControls();
    initSplitSlider();
    initColorPicker();
    initDownload();
    initReset();
    if (els.errorClose) els.errorClose.addEventListener('click', hideError);

    console.log('[CMYK] Ready.');
  }

  document.addEventListener('DOMContentLoaded', init);

})();
