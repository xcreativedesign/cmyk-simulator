/**
 * main.js — CMYK Simulator
 * Processes on main thread using chunked setTimeout — no Worker complexity.
 * Clean, simple, works on every browser and host.
 */

'use strict';

(function () {

  // ─── PAPER PROFILES ───────────────────────────────────────────────────────
  var PAPERS = {
    coated:   { name:'Coated',    dotGain:0.15, inkLimit:300, gamutReduction:0,    sg:0.8, hg:0.4, desc:'Coated / Glossy — ISO Coated v2 (FOGRA39 approx.) — Ink limit: 300%' },
    uncoated: { name:'Uncoated',  dotGain:0.22, inkLimit:280, gamutReduction:0.08, sg:1.0, hg:0.5, desc:'Uncoated / Matte — ISO Uncoated (FOGRA29 approx.) — Ink limit: 280%' },
    newsprint:{ name:'Newsprint', dotGain:0.30, inkLimit:240, gamutReduction:0.18, sg:1.3, hg:0.6, desc:'Newsprint — SNAP standard — Ink limit: 240% — Heavy dot gain' }
  };

  // ─── COLOR MATH ───────────────────────────────────────────────────────────
  function rgbToCmyk(r, g, b) {
    var k = 1 - Math.max(r, g, b);
    if (k >= 1) return { c:0, m:0, y:0, k:1 };
    var d = 1 - k;
    return { c:(1-r-k)/d, m:(1-g-k)/d, y:(1-b-k)/d, k:k };
  }

  function cmykToRgb(c, m, y, k) {
    return {
      r: Math.round(255*(1-c)*(1-k)),
      g: Math.round(255*(1-m)*(1-k)),
      b: Math.round(255*(1-y)*(1-k))
    };
  }

  function dotGain(v, gain, sg, hg) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    var mb = Math.sin(Math.PI * v);
    var pw = v < 0.5 ? hg + (sg-hg)*(v*2) : sg - (sg-hg)*((v-0.5)*2);
    return Math.min(1, Math.max(0, v + gain*mb*pw));
  }

  function outOfGamut(r, g, b, pt) {
    var p = PAPERS[pt];
    var rn=r/255, gn=g/255, bn=b/255;
    var mx=Math.max(rn,gn,bn), mn=Math.min(rn,gn,bn);
    var li=(mx+mn)/2;
    var sat = mx===mn ? 0 : (mx-mn)/(li>0.5 ? 2-mx-mn : mx+mn);
    var hue=0, d=mx-mn;
    if (d>0) {
      if (mx===rn) hue=((gn-bn)/d+(gn<bn?6:0))/6;
      else if (mx===gn) hue=((bn-rn)/d+2)/6;
      else hue=((rn-gn)/d+4)/6;
    }
    var thr = 0.82 - p.gamutReduction;
    if ((hue>0.22&&hue<0.42&&sat>0.7)||(hue>0.55&&hue<0.72&&sat>0.75&&li>0.3)||(hue>0.05&&hue<0.12&&sat>0.85)) thr -= 0.12;
    if (li<0.08||li>0.94) return false;
    return sat > thr;
  }

  function getPixelCmyk(r, g, b, pt, gain) {
    var p = PAPERS[pt];
    var raw = rgbToCmyk(r/255, g/255, b/255);
    return {
      c: Math.round(dotGain(raw.c, gain, p.sg, p.hg) * 100),
      m: Math.round(dotGain(raw.m, gain, p.sg, p.hg) * 100),
      y: Math.round(dotGain(raw.y, gain, p.sg, p.hg) * 100),
      k: Math.round(dotGain(raw.k, gain, p.sg, p.hg) * 100),
      tac: 0  // filled below
    };
    var out = getPixelCmyk(r,g,b,pt,gain);
    out.tac = out.c+out.m+out.y+out.k;
    return out;
  }
  // fix the above (closure issue) — clean version:
  function pixelCmyk(r, g, b, pt, gain) {
    var p = PAPERS[pt];
    var raw = rgbToCmyk(r/255, g/255, b/255);
    var c = Math.round(dotGain(raw.c, gain, p.sg, p.hg) * 100);
    var m = Math.round(dotGain(raw.m, gain, p.sg, p.hg) * 100);
    var y = Math.round(dotGain(raw.y, gain, p.sg, p.hg) * 100);
    var k = Math.round(dotGain(raw.k, gain, p.sg, p.hg) * 100);
    return { c:c, m:m, y:y, k:k, tac:c+m+y+k };
  }

  function dominantColors(pixels) {
    var buckets = {}, total = Math.floor(pixels.length/4);
    for (var i=0; i<total; i+=10) {
      var idx=i*4;
      if (pixels[idx+3]<128) continue;
      var r=Math.round(pixels[idx]/32)*32;
      var g=Math.round(pixels[idx+1]/32)*32;
      var b=Math.round(pixels[idx+2]/32)*32;
      var key=r+','+g+','+b;
      buckets[key]=(buckets[key]||0)+1;
    }
    var entries=[];
    for (var k in buckets) entries.push([k,buckets[k]]);
    entries.sort(function(a,z){return z[1]-a[1];});
    return entries.slice(0,5).map(function(e){
      var parts=e[0].split(',').map(Number);
      var r=parts[0],g=parts[1],b=parts[2];
      var raw=rgbToCmyk(r/255,g/255,b/255);
      return { r:r,g:g,b:b, c:Math.round(raw.c*100), m:Math.round(raw.m*100), y:Math.round(raw.y*100), k:Math.round(raw.k*100) };
    });
  }

  // ─── CHUNKED MAIN-THREAD PROCESSING ───────────────────────────────────────
  // Process CHUNK_SIZE pixels per setTimeout tick — keeps UI alive during processing.
  var CHUNK_SIZE = 80000;  // ~80k pixels per frame — fast but non-blocking

  function processPixels(src, settings, onProgress, onDone) {
    var p      = PAPERS[settings.paperType];
    var gain   = settings.dotGain;
    var count  = Math.floor(src.length / 4);
    var out    = new Uint8ClampedArray(src.length);
    var gam    = new Uint8ClampedArray(src.length);
    var totalTAC=0, maxTAC=0, oogCount=0, procCount=0;
    var i      = 0;

    function chunk() {
      var end = Math.min(i + CHUNK_SIZE, count);

      for (; i < end; i++) {
        var idx = i*4;
        var r=src[idx], g=src[idx+1], b=src[idx+2], a=src[idx+3];

        if (a === 0) {
          out[idx]=255; out[idx+1]=255; out[idx+2]=255; out[idx+3]=255;
          gam[idx+3]=0;
          continue;
        }

        var raw = rgbToCmyk(r/255, g/255, b/255);
        var c = dotGain(raw.c, gain, p.sg, p.hg);
        var m = dotGain(raw.m, gain, p.sg, p.hg);
        var y = dotGain(raw.y, gain, p.sg, p.hg);
        var k = dotGain(raw.k, gain, p.sg, p.hg);

        if (p.gamutReduction > 0) {
          c = Math.min(1, c + c*p.gamutReduction*0.5);
          m = Math.min(1, m + m*p.gamutReduction*0.3);
          y = Math.min(1, y + y*p.gamutReduction*0.3);
        }

        var tac = (c+m+y+k)*100;
        totalTAC += tac;
        if (tac > maxTAC) maxTAC = tac;

        var oog = outOfGamut(r, g, b, settings.paperType);
        if (oog) oogCount++;

        var rgb = cmykToRgb(settings.showC?c:0, settings.showM?m:0, settings.showY?y:0, settings.showK?k:0);
        out[idx]=rgb.r; out[idx+1]=rgb.g; out[idx+2]=rgb.b; out[idx+3]=a;

        if (settings.gamutOverlay && oog) {
          gam[idx]=220; gam[idx+1]=38; gam[idx+2]=38; gam[idx+3]=150;
        } else {
          gam[idx+3]=0;
        }
        procCount++;
      }

      var pct = Math.round((i/count)*100);
      onProgress(pct);

      if (i < count) {
        setTimeout(chunk, 0);  // yield to browser, then continue
      } else {
        // Done — compute stats
        var avgTAC  = procCount > 0 ? totalTAC/procCount : 0;
        var oogPct  = procCount > 0 ? (oogCount/procCount)*100 : 0;
        var lim     = p.inkLimit;
        var risk;
        if (maxTAC > lim+30 || oogPct > 25)
          risk={level:'danger', label:'High Risk', message:'Max ink coverage ('+Math.round(maxTAC)+'%) exceeds the '+lim+'% limit for '+p.name+' paper. Printer may reject the file.'};
        else if (maxTAC > lim || oogPct > 10)
          risk={level:'caution', label:'Caution', message:'Some areas approach the '+lim+'% ink limit for '+p.name+' paper. Review highlighted regions.'};
        else
          risk={level:'safe', label:'Looking Good', message:'Ink coverage is within acceptable range for '+p.name+' paper. Always verify with ICC soft proof before final production.'};

        onDone({
          outputPixels: out,
          gamutPixels: gam,
          stats: {
            avgTAC: Math.round(avgTAC),
            maxTAC: Math.round(maxTAC),
            outOfGamutPercent: Math.round(oogPct*10)/10,
            dominantColors: dominantColors(src),
            risk: risk,
            inkLimit: lim
          }
        });
      }
    }

    setTimeout(chunk, 0);  // start async
  }

  // ─── STATE ────────────────────────────────────────────────────────────────
  var state = {
    isProcessing:  false,
    imageData:     null,
    outputPixels:  null,
    gamutPixels:   null,
    stats:         null,
    splitPos:      50,
    isDragging:    false,
    settings: {
      paperType:'coated', dotGain:0.15,
      showC:true, showM:true, showY:true, showK:true,
      gamutOverlay:false
    }
  };

  // ─── DOM ──────────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  var els = {
    uploadZone:      $('upload-zone'),
    fileInput:       $('file-input'),
    workspace:       $('workspace'),
    uploadSection:   $('upload-section'),
    canvas:          $('main-canvas'),
    splitHandle:     $('split-handle'),
    paperBtns:       document.querySelectorAll('.paper-btn'),
    dotGainSlider:   $('dot-gain-slider'),
    dotGainValue:    $('dot-gain-value'),
    channelToggles:  document.querySelectorAll('.channel-toggle'),
    gamutToggle:     $('gamut-toggle'),
    progressOverlay: $('progress-overlay'),
    progressBar:     $('progress-bar'),
    progressText:    $('progress-text'),
    errorBanner:     $('error-banner'),
    errorMessage:    $('error-message'),
    errorClose:      $('error-close'),
    colorPicker:     $('color-picker-tooltip'),
    avgTacVal:       $('avg-tac-val'),
    maxTacVal:       $('max-tac-val'),
    tacBar:          $('tac-bar'),
    outGamutVal:     $('out-gamut-val'),
    riskBadge:       $('risk-badge'),
    riskMessage:     $('risk-message'),
    dominantColors:  $('dominant-colors'),
    downloadBtn:     $('download-btn'),
    resetBtn:        $('reset-btn'),
    liveRegion:      $('live-region'),
    resizedNotice:   $('resized-notice'),
    imageInfo:       $('image-info'),
    resultsPanel:    $('results-panel'),
    paperDesc:       $('paper-desc'),
    tacLimitLine:    $('tac-limit-line'),
    tacLimitLabel:   $('tac-limit-label')
  };

  // ─── FILE VALIDATION & PREPARATION ───────────────────────────────────────
  var MAX_SIZE = 5 * 1024 * 1024;
  var MAX_DIM  = 1500;
  var ACCEPTED = ['image/jpeg','image/png','image/webp'];

  function prepareFile(file, onStep, onDone, onError) {
    console.log('[CMYK] prepareFile:', file.name, file.size, file.type);

    if (file.size > MAX_SIZE) { onError('File too large. Please use an image under 5MB.'); return; }
    if (ACCEPTED.indexOf(file.type) === -1) { onError('Unsupported format. Please use JPG, PNG, or WEBP.'); return; }

    onStep('Loading image\u2026');
    var url = URL.createObjectURL(file);
    var img = new Image();

    img.onload = function() {
      URL.revokeObjectURL(url);
      console.log('[CMYK] Image loaded:', img.naturalWidth, 'x', img.naturalHeight);
      onStep('Preparing canvas\u2026');

      var w = img.naturalWidth, h = img.naturalHeight;
      var wasResized = w > MAX_DIM || h > MAX_DIM;
      if (wasResized) {
        var scale = MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      var cv  = document.createElement('canvas');
      cv.width  = w;
      cv.height = h;
      var ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

      var imageData = ctx.getImageData(0, 0, w, h);
      console.log('[CMYK] ImageData pixels:', imageData.data.length);
      onDone(imageData, w, h, wasResized);
    };

    img.onerror = function() {
      URL.revokeObjectURL(url);
      onError('Could not load image. The file may be corrupted.');
    };

    img.src = url;
  }

  // ─── COORDINATE MAPPING (letterbox fix) ──────────────────────────────────
  function canvasCoords(canvas, clientX, clientY) {
    var rect  = canvas.getBoundingClientRect();
    var scale = Math.min(rect.width/canvas.width, rect.height/canvas.height);
    var rw    = canvas.width  * scale;
    var rh    = canvas.height * scale;
    var ox    = (rect.width  - rw) / 2;
    var oy    = (rect.height - rh) / 2;
    var relX  = clientX - ox;
    var relY  = clientY - oy;
    if (relX<0||relY<0||relX>rw||relY>rh) return { valid:false, x:0, y:0 };
    return { valid:true, x:Math.round(relX/scale), y:Math.round(relY/scale) };
  }

  // ─── HANDLE FILE ──────────────────────────────────────────────────────────
  function handleFile(file) {
    if (!file || state.isProcessing) return;
    hideError();
    showProgress('Loading image\u2026', 0);

    prepareFile(file,
      function(msg) { updateProgressText(msg); },
      function(imageData, w, h, wasResized) {
        state.imageData    = imageData;
        state.outputPixels = null;
        state.gamutPixels  = null;
        state.stats        = null;

        els.canvas.width  = w;
        els.canvas.height = h;
        if (els.imageInfo)     els.imageInfo.textContent = w + ' \xd7 ' + h + 'px';
        if (els.resizedNotice) els.resizedNotice.hidden = !wasResized;

        // Draw original immediately so user sees the image
        els.canvas.getContext('2d').putImageData(imageData, 0, 0);

        els.uploadSection.hidden = true;
        els.workspace.hidden     = false;
        els.workspace.setAttribute('aria-hidden','false');

        runProcessing();
      },
      function(errMsg) {
        hideProgress();
        showError(errMsg);
      }
    );
  }

  // ─── RUN PROCESSING ───────────────────────────────────────────────────────
  var debounceTimer = null;

  function runProcessing() {
    if (!state.imageData) return;
    if (state.isProcessing) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      state.isProcessing = true;
      showProgress('Converting to CMYK\u2026 0%', 0);
      console.log('[CMYK] Starting processing. Pixels:', state.imageData.data.length, 'Settings:', JSON.stringify(state.settings));

      processPixels(
        state.imageData.data,
        state.settings,
        function onProgress(pct) {
          updateProgress(pct);
          updateProgressText('Converting to CMYK\u2026 ' + pct + '%');
        },
        function onDone(result) {
          console.log('[CMYK] Processing done. avgTAC:', result.stats.avgTAC, 'maxTAC:', result.stats.maxTAC);
          state.outputPixels = result.outputPixels;
          state.gamutPixels  = result.gamutPixels;
          state.stats        = result.stats;
          state.isProcessing = false;
          hideProgress();
          renderCanvas();
          updateResults();
          announce('Done. ' + result.stats.risk.label + '. Avg ink: ' + result.stats.avgTAC + '%.');
        }
      );
    }, 60);
  }

  // ─── CANVAS RENDER ────────────────────────────────────────────────────────
  function renderCanvas() {
    if (!state.imageData || !state.outputPixels) return;
    var ctx = els.canvas.getContext('2d');
    var w   = els.canvas.width;
    var h   = els.canvas.height;
    var sx  = Math.round((state.splitPos/100) * w);

    ctx.putImageData(new ImageData(new Uint8ClampedArray(state.imageData.data), w, h), 0, 0, 0, 0, sx, h);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(state.outputPixels), w, h), 0, 0, sx, 0, w-sx, h);

    if (state.settings.gamutOverlay && state.gamutPixels) {
      var off = document.createElement('canvas');
      off.width=w; off.height=h;
      off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(state.gamutPixels), w, h), 0, 0);
      ctx.drawImage(off, sx, 0, w-sx, h, sx, 0, w-sx, h);
    }

    // Divider
    ctx.save();
    ctx.beginPath(); ctx.moveTo(sx,0); ctx.lineTo(sx,h);
    ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=2; ctx.stroke();

    // Labels
    ctx.font='700 11px system-ui,sans-serif'; ctx.textBaseline='top';
    if (sx > 70)   { ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(8,8,80,22);      ctx.fillStyle='#fff'; ctx.fillText('RGB ORIGINAL',   14,    14); }
    if (sx < w-90) { ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(sx+8,8,108,22);  ctx.fillStyle='#fff'; ctx.fillText('CMYK SIMULATED', sx+14, 14); }
    ctx.restore();

    updateSplitHandle();
  }

  // ─── SPLIT HANDLE ─────────────────────────────────────────────────────────
  function updateSplitHandle() {
    if (!state.imageData) return;
    var rect  = els.canvas.getBoundingClientRect();
    var cont  = els.canvas.parentElement.getBoundingClientRect();
    var scale = Math.min(rect.width/els.canvas.width, rect.height/els.canvas.height);
    var rw    = els.canvas.width * scale;
    var ox    = (rect.width - rw) / 2;
    els.splitHandle.style.left = (ox + (state.splitPos/100)*rw + rect.left - cont.left) + 'px';
  }

  function initSplitSlider() {
    function move(clientX) {
      if (!state.isDragging) return;
      var rect  = els.canvas.getBoundingClientRect();
      var scale = Math.min(rect.width/els.canvas.width, rect.height/els.canvas.height);
      var rw    = els.canvas.width * scale;
      var ox    = (rect.width - rw) / 2;
      state.splitPos = Math.min(100, Math.max(0, ((clientX-rect.left-ox)/rw)*100));
      renderCanvas();
    }
    els.splitHandle.addEventListener('mousedown',  function(e){ state.isDragging=true; e.preventDefault(); });
    els.splitHandle.addEventListener('touchstart', function(){  state.isDragging=true; }, {passive:true});
    document.addEventListener('mousemove', function(e){ move(e.clientX); });
    document.addEventListener('mouseup',   function(){  state.isDragging=false; });
    document.addEventListener('touchmove', function(e){ if(state.isDragging) move(e.touches[0].clientX); }, {passive:true});
    document.addEventListener('touchend',  function(){  state.isDragging=false; });
    els.splitHandle.addEventListener('keydown', function(e){
      if (e.key==='ArrowLeft')  { state.splitPos=Math.max(0,  state.splitPos-(e.shiftKey?10:1)); renderCanvas(); }
      if (e.key==='ArrowRight') { state.splitPos=Math.min(100,state.splitPos+(e.shiftKey?10:1)); renderCanvas(); }
    });
    window.addEventListener('resize', function(){ if(state.imageData) updateSplitHandle(); });
  }

  // ─── COLOR PICKER ─────────────────────────────────────────────────────────
  function initColorPicker() {
    var container = els.canvas.parentElement;
    var throttle  = false;

    container.addEventListener('mousemove', function(e) {
      if (!state.imageData || !state.outputPixels || throttle) return;
      throttle = true;
      requestAnimationFrame(function(){ throttle=false; });

      var rect   = els.canvas.getBoundingClientRect();
      var coords = canvasCoords(els.canvas, e.clientX-rect.left, e.clientY-rect.top);
      if (!coords.valid) { els.colorPicker.hidden=true; return; }

      var x   = Math.min(coords.x, els.canvas.width-1);
      var y   = Math.min(coords.y, els.canvas.height-1);
      var idx = (y * els.canvas.width + x) * 4;
      var r   = state.imageData.data[idx];
      var g   = state.imageData.data[idx+1];
      var b   = state.imageData.data[idx+2];
      var a   = state.imageData.data[idx+3];
      if (a < 10) { els.colorPicker.hidden=true; return; }

      var cmyk = pixelCmyk(r, g, b, state.settings.paperType, state.settings.dotGain);

      var cRect = container.getBoundingClientRect();
      var tx = e.clientX-cRect.left+16, ty = e.clientY-cRect.top+16;
      if (tx+190>cRect.width)  tx = e.clientX-cRect.left-196;
      if (ty+130>cRect.height) ty = e.clientY-cRect.top-136;

      els.colorPicker.style.left = tx+'px';
      els.colorPicker.style.top  = ty+'px';
      els.colorPicker.hidden     = false;

      $('cp-swatch').style.background = 'rgb('+r+','+g+','+b+')';
      $('cp-c').textContent = cmyk.c+'%'; $('cp-m').textContent = cmyk.m+'%';
      $('cp-y').textContent = cmyk.y+'%'; $('cp-k').textContent = cmyk.k+'%';
      $('cp-tac').textContent = cmyk.tac+'%';
    });

    container.addEventListener('mouseleave', function(){ els.colorPicker.hidden=true; });
  }

  // ─── RESULTS ──────────────────────────────────────────────────────────────
  function updateResults() {
    if (!state.stats) return;
    var s = state.stats;
    els.avgTacVal.textContent   = s.avgTAC+'%';
    els.maxTacVal.textContent   = s.maxTAC+'%';
    els.outGamutVal.textContent = s.outOfGamutPercent+'%';

    var pct = Math.min(100,(s.maxTAC/400)*100);
    els.tacBar.style.width = pct+'%';
    els.tacBar.className   = 'tac-bar-fill '+(s.maxTAC>s.inkLimit+30?'danger':s.maxTAC>s.inkLimit?'caution':'safe');
    if (els.tacLimitLine)  els.tacLimitLine.style.left  = ((s.inkLimit/400)*100)+'%';
    if (els.tacLimitLabel) els.tacLimitLabel.textContent = s.inkLimit+'%';

    els.riskBadge.textContent   = s.risk.label;
    els.riskBadge.className     = 'risk-badge '+s.risk.level;
    els.riskMessage.textContent = s.risk.message;

    els.dominantColors.innerHTML = '';
    s.dominantColors.forEach(function(col){
      var sw   = document.createElement('div');
      sw.className = 'color-swatch';
      var bg = document.createElement('div');
      bg.className='swatch-bg';
      bg.style.background='rgb('+col.r+','+col.g+','+col.b+')';
      var info=document.createElement('div');
      info.className='swatch-info';
      info.innerHTML='<span class="swatch-c">C'+col.c+'</span><span class="swatch-m">M'+col.m+'</span><span class="swatch-y">Y'+col.y+'</span><span class="swatch-k">K'+col.k+'</span>';
      sw.appendChild(bg); sw.appendChild(info);
      els.dominantColors.appendChild(sw);
    });
    els.resultsPanel.hidden = false;
  }

  // ─── CONTROLS ─────────────────────────────────────────────────────────────
  function initControls() {
    // Paper
    els.paperBtns.forEach(function(btn){
      btn.addEventListener('click', function(){
        els.paperBtns.forEach(function(b){ b.classList.remove('active'); b.setAttribute('aria-pressed','false'); });
        btn.classList.add('active'); btn.setAttribute('aria-pressed','true');
        state.settings.paperType = btn.dataset.paper;
        var p = PAPERS[state.settings.paperType];
        var g = Math.round(p.dotGain*100);
        els.dotGainSlider.value = g;
        els.dotGainValue.textContent = g+'%';
        state.settings.dotGain = p.dotGain;
        if (els.paperDesc) els.paperDesc.textContent = p.desc;
        if (state.imageData) runProcessing();
      });
    });

    // Dot gain
    els.dotGainSlider.addEventListener('input', function(){
      var v = parseInt(els.dotGainSlider.value,10);
      els.dotGainValue.textContent = v+'%';
      state.settings.dotGain = v/100;
      if (state.imageData) runProcessing();
    });

    // Channels
    els.channelToggles.forEach(function(toggle){
      toggle.addEventListener('click', function(){
        var ch     = toggle.dataset.channel;
        var active = toggle.classList.contains('active');
        toggle.classList.toggle('active',!active);
        toggle.setAttribute('aria-pressed',String(!active));
        state.settings['show'+ch.toUpperCase()] = !active;
        if (state.imageData && state.outputPixels) runProcessing();
      });
    });

    // Gamut
    els.gamutToggle.addEventListener('click', function(){
      var active = els.gamutToggle.classList.contains('active');
      els.gamutToggle.classList.toggle('active',!active);
      els.gamutToggle.setAttribute('aria-pressed',String(!active));
      state.settings.gamutOverlay = !active;
      if (state.outputPixels) renderCanvas();
    });
  }

  // ─── UPLOAD ZONE ──────────────────────────────────────────────────────────
  function initUploadZone() {
    els.uploadZone.addEventListener('click', function(){ els.fileInput.click(); });
    els.uploadZone.addEventListener('keydown', function(e){
      if (e.key==='Enter'||e.key===' '){ e.preventDefault(); els.fileInput.click(); }
    });
    els.fileInput.addEventListener('change', function(){
      if (els.fileInput.files && els.fileInput.files[0]) handleFile(els.fileInput.files[0]);
    });
    ['dragenter','dragover'].forEach(function(evt){
      els.uploadZone.addEventListener(evt,function(e){ e.preventDefault(); els.uploadZone.classList.add('drag-over'); });
    });
    ['dragleave','dragend'].forEach(function(evt){
      els.uploadZone.addEventListener(evt,function(){ els.uploadZone.classList.remove('drag-over'); });
    });
    els.uploadZone.addEventListener('drop',function(e){
      e.preventDefault(); els.uploadZone.classList.remove('drag-over');
      if (e.dataTransfer&&e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    document.addEventListener('dragover',function(e){e.preventDefault();});
    document.addEventListener('drop',function(e){
      e.preventDefault();
      if (e.dataTransfer&&e.dataTransfer.files[0]&&els.workspace.hidden) handleFile(e.dataTransfer.files[0]);
    });
  }

  // ─── DOWNLOAD / RESET ─────────────────────────────────────────────────────
  function initActions() {
    if (els.downloadBtn) {
      els.downloadBtn.addEventListener('click', function(){
        if (!state.outputPixels) return;
        var a=document.createElement('a');
        a.download='cmyk-simulation.png';
        a.href=els.canvas.toDataURL('image/png');
        a.click();
      });
    }
    if (els.resetBtn) {
      els.resetBtn.addEventListener('click', function(){
        state.imageData=null; state.outputPixels=null;
        state.gamutPixels=null; state.stats=null;
        state.splitPos=50; state.isProcessing=false;
        els.workspace.hidden=true; els.workspace.setAttribute('aria-hidden','true');
        els.uploadSection.hidden=false; els.resultsPanel.hidden=true;
        els.colorPicker.hidden=true; els.fileInput.value='';
        announce('Tool reset. Upload a new image to begin.');
      });
    }
  }

  // ─── PROGRESS / ERROR / ANNOUNCE ──────────────────────────────────────────
  function showProgress(text,pct){ els.progressOverlay.hidden=false; updateProgressText(text); updateProgress(pct); }
  function updateProgress(pct)   { els.progressBar.style.width=pct+'%'; els.progressBar.setAttribute('aria-valuenow',pct); }
  function updateProgressText(t) { els.progressText.textContent=t; }
  function hideProgress()        { els.progressOverlay.hidden=true; }
  function showError(msg)        { els.errorMessage.textContent=msg; els.errorBanner.hidden=false; announce('Error: '+msg); }
  function hideError()           { els.errorBanner.hidden=true; }
  function announce(msg)         {
    if (!els.liveRegion) return;
    els.liveRegion.textContent='';
    requestAnimationFrame(function(){ els.liveRegion.textContent=msg; });
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      document.documentElement.classList.add('reduced-motion');

    els.workspace.hidden       = true;
    els.workspace.setAttribute('aria-hidden','true');
    els.resultsPanel.hidden    = true;
    els.progressOverlay.hidden = true;
    els.errorBanner.hidden     = true;
    els.colorPicker.hidden     = true;

    if (els.paperDesc) els.paperDesc.textContent = PAPERS.coated.desc;

    initUploadZone();
    initControls();
    initSplitSlider();
    initColorPicker();
    initActions();
    if (els.errorClose) els.errorClose.addEventListener('click', hideError);

    console.log('[CMYK] Ready. No worker — main thread chunked processing.');
  }

  document.addEventListener('DOMContentLoaded', init);

})();
