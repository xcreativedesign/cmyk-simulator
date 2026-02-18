/**
 * worker.js
 * CMYK Simulator — Web Worker
 *
 * Runs all heavy pixel processing off the main thread.
 * The UI never freezes, no matter how large the image.
 *
 * Communication protocol:
 * Receives: { type: 'process', pixels: Uint8ClampedArray, width, height, settings }
 * Sends:    { type: 'result', outputPixels, gamutPixels, stats, width, height }
 *           { type: 'progress', percent }
 *           { type: 'error', message }
 */

'use strict';

// ─── INLINE COLOR ENGINE ────────────────────────────────────────────────────
// We inline the necessary functions here so the worker is self-contained.
// importScripts is avoided for GitHub Pages compatibility.

const PAPER_PROFILES = {
  coated: {
    name: 'Coated',
    dotGain: 0.15,
    inkLimit: 300,
    gamutReduction: 0,
    shadowGain: 0.8,
    highlightGain: 0.4
  },
  uncoated: {
    name: 'Uncoated',
    dotGain: 0.22,
    inkLimit: 280,
    gamutReduction: 0.08,
    shadowGain: 1.0,
    highlightGain: 0.5
  },
  newsprint: {
    name: 'Newsprint',
    dotGain: 0.30,
    inkLimit: 240,
    gamutReduction: 0.18,
    shadowGain: 1.3,
    highlightGain: 0.6
  }
};

function rgbToCmyk(r, g, b) {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  const denom = 1 - k;
  return {
    c: (1 - r - k) / denom,
    m: (1 - g - k) / denom,
    y: (1 - b - k) / denom,
    k
  };
}

function cmykToRgb(c, m, y, k) {
  return {
    r: Math.round(255 * (1 - c) * (1 - k)),
    g: Math.round(255 * (1 - m) * (1 - k)),
    b: Math.round(255 * (1 - y) * (1 - k))
  };
}

function applyDotGain(value, gain, shadowGain, highlightGain) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  const midtoneBoost = Math.sin(Math.PI * value);
  const positionalWeight = value < 0.5
    ? highlightGain + (shadowGain - highlightGain) * (value * 2)
    : shadowGain - (shadowGain - highlightGain) * ((value - 0.5) * 2);
  return Math.min(1, Math.max(0, value + gain * midtoneBoost * positionalWeight));
}

function isOutOfGamut(r, g, b, paperType) {
  const profile = PAPER_PROFILES[paperType];
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (lightness > 0.5 ? 2 - max - min : max + min);

  let hue = 0;
  if (max !== min) {
    const d = max - min;
    if (max === rn) hue = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) hue = ((bn - rn) / d + 2) / 6;
    else hue = ((rn - gn) / d + 4) / 6;
  }

  let gamutThreshold = 0.82 - profile.gamutReduction;
  const isNeonGreen = hue > 0.22 && hue < 0.42 && saturation > 0.7;
  const isElectricBlue = hue > 0.55 && hue < 0.72 && saturation > 0.75 && lightness > 0.3;
  const isBrightOrange = hue > 0.05 && hue < 0.12 && saturation > 0.85;
  if (isNeonGreen || isElectricBlue || isBrightOrange) gamutThreshold -= 0.12;
  if (lightness < 0.08 || lightness > 0.94) return false;
  return saturation > gamutThreshold;
}

function extractDominantColors(pixels, sampleRate) {
  const buckets = {};
  const total = pixels.length / 4;
  for (let i = 0; i < total; i += sampleRate) {
    const idx = i * 4;
    if (pixels[idx + 3] < 128) continue;
    const r = Math.round(pixels[idx] / 32) * 32;
    const g = Math.round(pixels[idx + 1] / 32) * 32;
    const b = Math.round(pixels[idx + 2] / 32) * 32;
    const key = `${r},${g},${b}`;
    buckets[key] = (buckets[key] || 0) + 1;
  }
  return Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key]) => {
      const [r, g, b] = key.split(',').map(Number);
      const c = rgbToCmyk(r / 255, g / 255, b / 255);
      return {
        r, g, b,
        c: Math.round(c.c * 100),
        m: Math.round(c.m * 100),
        y: Math.round(c.y * 100),
        k: Math.round(c.k * 100)
      };
    });
}

// ─── MAIN PROCESSING FUNCTION ───────────────────────────────────────────────
function processImage(pixels, settings) {
  const { paperType, dotGain, showC, showM, showY, showK, gamutOverlay } = settings;
  const profile = PAPER_PROFILES[paperType];
  const gain = dotGain;
  const pixelCount = pixels.length / 4;

  const outputPixels = new Uint8ClampedArray(pixels.length);
  const gamutPixels = new Uint8ClampedArray(pixels.length);

  let totalTAC = 0;
  let maxTAC = 0;
  let outOfGamutCount = 0;
  let processedCount = 0;
  const progressInterval = Math.floor(pixelCount / 20); // report every 5%

  for (let i = 0; i < pixelCount; i++) {
    // Report progress every 5%
    if (i % progressInterval === 0) {
      self.postMessage({
        type: 'progress',
        percent: Math.round((i / pixelCount) * 100)
      });
    }

    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const a = pixels[idx + 3];

    if (a === 0) {
      outputPixels[idx] = 255; outputPixels[idx + 1] = 255;
      outputPixels[idx + 2] = 255; outputPixels[idx + 3] = 255;
      gamutPixels[idx + 3] = 0;
      continue;
    }

    let { c, m, y, k } = rgbToCmyk(r / 255, g / 255, b / 255);

    c = applyDotGain(c, gain, profile.shadowGain, profile.highlightGain);
    m = applyDotGain(m, gain, profile.shadowGain, profile.highlightGain);
    y = applyDotGain(y, gain, profile.shadowGain, profile.highlightGain);
    k = applyDotGain(k, gain, profile.shadowGain, profile.highlightGain);

    if (profile.gamutReduction > 0) {
      c = Math.min(1, c + c * profile.gamutReduction * 0.5);
      m = Math.min(1, m + m * profile.gamutReduction * 0.3);
      y = Math.min(1, y + y * profile.gamutReduction * 0.3);
    }

    const tac = (c + m + y + k) * 100;
    totalTAC += tac;
    if (tac > maxTAC) maxTAC = tac;

    const oog = isOutOfGamut(r, g, b, paperType);
    if (oog) outOfGamutCount++;

    const fc = showC ? c : 0;
    const fm = showM ? m : 0;
    const fy = showY ? y : 0;
    const fk = showK ? k : 0;

    const rgb = cmykToRgb(fc, fm, fy, fk);
    outputPixels[idx] = rgb.r;
    outputPixels[idx + 1] = rgb.g;
    outputPixels[idx + 2] = rgb.b;
    outputPixels[idx + 3] = a;

    if (gamutOverlay && oog) {
      gamutPixels[idx] = 220; gamutPixels[idx + 1] = 38;
      gamutPixels[idx + 2] = 38; gamutPixels[idx + 3] = 150;
    } else {
      gamutPixels[idx + 3] = 0;
    }

    processedCount++;
  }

  const avgTAC = processedCount > 0 ? totalTAC / processedCount : 0;
  const outOfGamutPercent = processedCount > 0 ? (outOfGamutCount / processedCount) * 100 : 0;

  // Risk assessment
  const limit = profile.inkLimit;
  let risk;
  if (maxTAC > limit + 30 || outOfGamutPercent > 25) {
    risk = { level: 'danger', label: 'High Risk', message: `Max ink coverage (${Math.round(maxTAC)}%) exceeds the ${limit}% limit for ${profile.name} paper. Printer may reject the file.` };
  } else if (maxTAC > limit || outOfGamutPercent > 10) {
    risk = { level: 'caution', label: 'Caution', message: `Some areas approach the ${limit}% ink limit for ${profile.name} paper. Review highlighted regions.` };
  } else {
    risk = { level: 'safe', label: 'Looking Good', message: `Ink coverage is within acceptable range for ${profile.name} paper. Always verify with ICC soft proof before final production.` };
  }

  const dominantColors = extractDominantColors(pixels, 8);

  return {
    outputPixels,
    gamutPixels,
    stats: {
      avgTAC: Math.round(avgTAC),
      maxTAC: Math.round(maxTAC),
      outOfGamutCount,
      outOfGamutPercent: Math.round(outOfGamutPercent * 10) / 10,
      dominantColors,
      risk,
      inkLimit: limit
    }
  };
}

// ─── MESSAGE HANDLER ────────────────────────────────────────────────────────
self.onmessage = function (e) {
  const { type, pixels, settings } = e.data;
  if (type !== 'process') return;

  try {
    // pixels arrives as ArrayBuffer after transfer — wrap it back
    const pixelArray = pixels instanceof Uint8ClampedArray
      ? pixels
      : new Uint8ClampedArray(pixels);

    if (!pixelArray || pixelArray.length === 0) {
      throw new Error('No pixel data received. Image may not have loaded correctly.');
    }

    const result = processImage(pixelArray, settings);
    self.postMessage(
      {
        type: 'result',
        outputPixels: result.outputPixels,
        gamutPixels: result.gamutPixels,
        stats: result.stats
      },
      [result.outputPixels.buffer, result.gamutPixels.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || 'Unknown processing error' });
  }
};
