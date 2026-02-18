/**
 * colorEngine.js
 * CMYK Simulator — Color Math Engine
 *
 * All color conversion and simulation math lives here.
 * This file is intentionally isolated from UI logic.
 *
 * HONEST DOCUMENTATION:
 * This engine uses simplified mathematical formulas for educational purposes.
 * It does NOT use ICC profiles (FOGRA39, SWOP, GRACoL) or Look-Up Tables.
 * Results are educational approximations, not professional soft proofs.
 * For production print work, use ICC-verified proofing in Photoshop or your RIP.
 *
 * References:
 * - ICC Profile Specification: https://www.color.org/specification/ICC.1-2022-05.pdf
 * - FOGRA39 (ISO Coated v2): https://www.fogra.org
 * - dot gain theory: ISO 12647-2
 */

'use strict';

const ColorEngine = (() => {

  // ─── PAPER PROFILES ────────────────────────────────────────────────────────
  // These are simplified presets, not real ICC profile data.
  // Values represent approximate dot gain and ink limit behavior.
  const PAPER_PROFILES = {
    coated: {
      name: 'Coated',
      dotGain: 15,
      inkLimit: 300,
      gamutReduction: 0,       // minimal gamut reduction
      description: 'Coated / Glossy — ISO Coated v2 (FOGRA39 approximation)',
      shadowGain: 0.8,          // relative shadow behavior
      highlightGain: 0.4        // relative highlight behavior
    },
    uncoated: {
      name: 'Uncoated',
      dotGain: 22,
      inkLimit: 280,
      gamutReduction: 0.08,
      description: 'Uncoated / Matte — ISO Uncoated (FOGRA29 approximation)',
      shadowGain: 1.0,
      highlightGain: 0.5
    },
    newsprint: {
      name: 'Newsprint',
      dotGain: 30,
      inkLimit: 240,
      gamutReduction: 0.18,
      description: 'Newsprint — SNAP (Specifications for Newsprint Advertising Production)',
      shadowGain: 1.3,
      highlightGain: 0.6
    }
  };

  // ─── RGB → CMYK ────────────────────────────────────────────────────────────
  /**
   * Convert normalized RGB (0-1) to CMYK (0-1).
   * Formula: simplified mathematical model (not ICC-based).
   * @param {number} r - Red 0-1
   * @param {number} g - Green 0-1
   * @param {number} b - Blue 0-1
   * @returns {{c: number, m: number, y: number, k: number}}
   */
  function rgbToCmyk(r, g, b) {
    const k = 1 - Math.max(r, g, b);
    if (k === 1) return { c: 0, m: 0, y: 0, k: 1 };
    const denom = 1 - k;
    return {
      c: (1 - r - k) / denom,
      m: (1 - g - k) / denom,
      y: (1 - b - k) / denom,
      k
    };
  }

  // ─── CMYK → RGB ────────────────────────────────────────────────────────────
  /**
   * Convert CMYK (0-1) back to RGB (0-255) for canvas rendering.
   * @param {number} c - Cyan 0-1
   * @param {number} m - Magenta 0-1
   * @param {number} y - Yellow 0-1
   * @param {number} k - Key/Black 0-1
   * @returns {{r: number, g: number, b: number}}
   */
  function cmykToRgb(c, m, y, k) {
    return {
      r: Math.round(255 * (1 - c) * (1 - k)),
      g: Math.round(255 * (1 - m) * (1 - k)),
      b: Math.round(255 * (1 - y) * (1 - k))
    };
  }

  // ─── DOT GAIN (NON-LINEAR CURVE) ───────────────────────────────────────────
  /**
   * Apply dot gain using a non-linear sine curve.
   * Unlike a flat linear addition, this correctly affects midtones most,
   * with reduced effect in shadows and highlights — matching real press behavior.
   *
   * Formula derived from Yule-Nielsen modified Murray-Davies equation (simplified).
   * gain parameter: 0 to 1 (0.15 = 15% dot gain)
   * shadowGain / highlightGain: paper-specific modifiers
   *
   * @param {number} value - CMYK channel value 0-1
   * @param {number} gain - dot gain amount 0-1
   * @param {number} shadowGain - shadow region multiplier (paper profile)
   * @param {number} highlightGain - highlight region multiplier (paper profile)
   * @returns {number} adjusted value 0-1
   */
  function applyDotGain(value, gain, shadowGain = 1.0, highlightGain = 0.5) {
    if (value <= 0) return 0;
    if (value >= 1) return 1;

    // Sine curve: peaks at midtone (0.5), falls off at extremes
    const midtoneBoost = Math.sin(Math.PI * value);

    // Weight by position: shadows use shadowGain, highlights use highlightGain
    const positionalWeight = value < 0.5
      ? highlightGain + (shadowGain - highlightGain) * (value * 2)
      : shadowGain - (shadowGain - highlightGain) * ((value - 0.5) * 2);

    const adjusted = value + gain * midtoneBoost * positionalWeight;
    return Math.min(1, Math.max(0, adjusted));
  }

  // ─── GAMUT WARNING ──────────────────────────────────────────────────────────
  /**
   * Determine if an RGB color is out of gamut for the given paper profile.
   * This is a simplified 3D gamut check using saturation + lightness analysis.
   * Real gamut checking requires 3D LUT comparison against ICC profile data.
   *
   * @param {number} r - Red 0-255
   * @param {number} g - Green 0-255
   * @param {number} b - Blue 0-255
   * @param {string} paperType - 'coated' | 'uncoated' | 'newsprint'
   * @returns {boolean} true if out of gamut
   */
  function isOutOfGamut(r, g, b, paperType) {
    const profile = PAPER_PROFILES[paperType];
    const rn = r / 255, gn = g / 255, bn = b / 255;

    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lightness = (max + min) / 2;
    const saturation = max === min ? 0 : (max - min) / (lightness > 0.5 ? 2 - max - min : max + min);

    // Calculate hue to identify problematic color regions
    let hue = 0;
    if (max !== min) {
      const d = max - min;
      if (max === rn) hue = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
      else if (max === gn) hue = ((bn - rn) / d + 2) / 6;
      else hue = ((rn - gn) / d + 4) / 6;
    }

    // Gamut threshold varies by paper — coated has largest gamut
    let gamutThreshold = 0.82 - profile.gamutReduction;

    // Adjust for specific color regions that compress badly in print
    // Neon green and electric blue are particularly problematic
    const isNeonGreen = hue > 0.22 && hue < 0.42 && saturation > 0.7;
    const isElectricBlue = hue > 0.55 && hue < 0.72 && saturation > 0.75 && lightness > 0.3;
    const isBrightOrange = hue > 0.05 && hue < 0.12 && saturation > 0.85;

    if (isNeonGreen || isElectricBlue || isBrightOrange) {
      gamutThreshold -= 0.12;
    }

    // Very dark or very light colors are rarely out of gamut
    if (lightness < 0.08 || lightness > 0.94) return false;

    return saturation > gamutThreshold;
  }

  // ─── TOTAL INK COVERAGE ────────────────────────────────────────────────────
  /**
   * Calculate Total Area Coverage (TAC) as percentage.
   * @param {number} c - Cyan 0-1
   * @param {number} m - Magenta 0-1
   * @param {number} y - Yellow 0-1
   * @param {number} k - Key 0-1
   * @returns {number} TAC as 0-400
   */
  function totalInkCoverage(c, m, y, k) {
    return (c + m + y + k) * 100;
  }

  // ─── PRINT RISK ASSESSMENT ─────────────────────────────────────────────────
  /**
   * Assess print risk level based on ink coverage and paper type.
   * @param {number} avgTAC - average total area coverage across image
   * @param {number} maxTAC - maximum TAC found in image
   * @param {number} outOfGamutPercent - percentage of out-of-gamut pixels
   * @param {string} paperType
   * @returns {{level: string, label: string, message: string}}
   */
  function assessPrintRisk(avgTAC, maxTAC, outOfGamutPercent, paperType) {
    const profile = PAPER_PROFILES[paperType];
    const limit = profile.inkLimit;

    if (maxTAC > limit + 30 || outOfGamutPercent > 25) {
      return {
        level: 'danger',
        label: 'High Risk',
        message: `Max ink coverage (${Math.round(maxTAC)}%) exceeds ${limit}% limit for ${profile.name} paper. Printer may reject file or drying issues may occur.`
      };
    }
    if (maxTAC > limit || outOfGamutPercent > 10) {
      return {
        level: 'caution',
        label: 'Caution',
        message: `Some areas approach or exceed the ${limit}% ink limit. Review highlighted regions and consider reducing saturation in those areas.`
      };
    }
    return {
      level: 'safe',
      label: 'Looking Good',
      message: `Ink coverage within acceptable range for ${profile.name} paper. Always verify with ICC soft proof before final production.`
    };
  }

  // ─── DOMINANT COLOR EXTRACTION ─────────────────────────────────────────────
  /**
   * Extract dominant colors from sampled pixel data.
   * Uses a simple quantization approach (not k-means, for performance).
   * @param {Uint8ClampedArray} pixels - RGBA pixel array
   * @param {number} sampleRate - sample every nth pixel
   * @returns {Array<{r, g, b, cmyk, count}>}
   */
  function extractDominantColors(pixels, sampleRate = 10) {
    const buckets = {};
    const total = pixels.length / 4;

    for (let i = 0; i < total; i += sampleRate) {
      const idx = i * 4;
      const r = Math.round(pixels[idx] / 32) * 32;
      const g = Math.round(pixels[idx + 1] / 32) * 32;
      const b = Math.round(pixels[idx + 2] / 32) * 32;
      const key = `${r},${g},${b}`;
      buckets[key] = (buckets[key] || 0) + 1;
    }

    return Object.entries(buckets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => {
        const [r, g, b] = key.split(',').map(Number);
        const cmyk = rgbToCmyk(r / 255, g / 255, b / 255);
        return { r, g, b, cmyk, count };
      });
  }

  // ─── FULL IMAGE PROCESSING ─────────────────────────────────────────────────
  /**
   * Process entire image pixel array.
   * Called from Web Worker with ImageData.data.
   *
   * @param {Uint8ClampedArray} sourcePixels - Original RGBA pixels
   * @param {object} settings
   * @param {string} settings.paperType
   * @param {number} settings.dotGain - 0-1 (0.15 = 15%)
   * @param {boolean} settings.showC
   * @param {boolean} settings.showM
   * @param {boolean} settings.showY
   * @param {boolean} settings.showK
   * @param {boolean} settings.gamutOverlay
   * @returns {object} processed result
   */
  function processImage(sourcePixels, settings) {
    const { paperType, dotGain, showC, showM, showY, showK, gamutOverlay } = settings;
    const profile = PAPER_PROFILES[paperType];
    const gain = dotGain;
    const pixelCount = sourcePixels.length / 4;

    const outputPixels = new Uint8ClampedArray(sourcePixels.length);
    const gamutPixels = new Uint8ClampedArray(sourcePixels.length);

    let totalTAC = 0;
    let maxTAC = 0;
    let outOfGamutCount = 0;
    let processedCount = 0;

    for (let i = 0; i < pixelCount; i++) {
      const idx = i * 4;
      const r = sourcePixels[idx];
      const g = sourcePixels[idx + 1];
      const b = sourcePixels[idx + 2];
      const a = sourcePixels[idx + 3];

      // Skip transparent pixels
      if (a === 0) {
        outputPixels[idx] = 255;
        outputPixels[idx + 1] = 255;
        outputPixels[idx + 2] = 255;
        outputPixels[idx + 3] = 255;
        gamutPixels[idx] = 255;
        gamutPixels[idx + 1] = 255;
        gamutPixels[idx + 2] = 255;
        gamutPixels[idx + 3] = 0;
        continue;
      }

      // Convert to CMYK
      let { c, m, y, k } = rgbToCmyk(r / 255, g / 255, b / 255);

      // Apply dot gain (non-linear curve)
      c = applyDotGain(c, gain, profile.shadowGain, profile.highlightGain);
      m = applyDotGain(m, gain, profile.shadowGain, profile.highlightGain);
      y = applyDotGain(y, gain, profile.shadowGain, profile.highlightGain);
      k = applyDotGain(k, gain, profile.shadowGain, profile.highlightGain);

      // Apply gamut reduction for paper type
      if (profile.gamutReduction > 0) {
        c = Math.min(1, c * (1 + profile.gamutReduction * 0.5));
        m = Math.min(1, m * (1 + profile.gamutReduction * 0.3));
        y = Math.min(1, y * (1 + profile.gamutReduction * 0.3));
      }

      // Apply channel toggles
      const fc = showC ? c : 0;
      const fm = showM ? m : 0;
      const fy = showY ? y : 0;
      const fk = showK ? k : 0;

      // Calculate TAC
      const tac = totalInkCoverage(c, m, y, k);
      totalTAC += tac;
      if (tac > maxTAC) maxTAC = tac;

      // Gamut check
      const oog = isOutOfGamut(r, g, b, paperType);
      if (oog) outOfGamutCount++;

      // Convert back to RGB for display
      const rgb = cmykToRgb(fc, fm, fy, fk);
      outputPixels[idx] = rgb.r;
      outputPixels[idx + 1] = rgb.g;
      outputPixels[idx + 2] = rgb.b;
      outputPixels[idx + 3] = a;

      // Gamut overlay pixels
      if (gamutOverlay && oog) {
        gamutPixels[idx] = 220;
        gamutPixels[idx + 1] = 38;
        gamutPixels[idx + 2] = 38;
        gamutPixels[idx + 3] = 140;
      } else {
        gamutPixels[idx] = 0;
        gamutPixels[idx + 1] = 0;
        gamutPixels[idx + 2] = 0;
        gamutPixels[idx + 3] = 0;
      }

      processedCount++;
    }

    const avgTAC = processedCount > 0 ? totalTAC / processedCount : 0;
    const outOfGamutPercent = processedCount > 0 ? (outOfGamutCount / processedCount) * 100 : 0;
    const dominantColors = extractDominantColors(sourcePixels, 8);
    const risk = assessPrintRisk(avgTAC, maxTAC, outOfGamutPercent, paperType);

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
        inkLimit: profile.inkLimit
      }
    };
  }

  // ─── SINGLE PIXEL CMYK (for hover picker) ──────────────────────────────────
  function getPixelCmyk(r, g, b, paperType, dotGain) {
    const profile = PAPER_PROFILES[paperType];
    let { c, m, y, k } = rgbToCmyk(r / 255, g / 255, b / 255);
    c = applyDotGain(c, dotGain, profile.shadowGain, profile.highlightGain);
    m = applyDotGain(m, dotGain, profile.shadowGain, profile.highlightGain);
    y = applyDotGain(y, dotGain, profile.shadowGain, profile.highlightGain);
    k = applyDotGain(k, dotGain, profile.shadowGain, profile.highlightGain);
    return {
      c: Math.round(c * 100),
      m: Math.round(m * 100),
      y: Math.round(y * 100),
      k: Math.round(k * 100),
      tac: Math.round((c + m + y + k) * 100)
    };
  }

  return {
    rgbToCmyk,
    cmykToRgb,
    applyDotGain,
    isOutOfGamut,
    totalInkCoverage,
    processImage,
    getPixelCmyk,
    assessPrintRisk,
    PAPER_PROFILES
  };
})();

// Export for Web Worker and Node (if ever needed)
if (typeof module !== 'undefined') module.exports = ColorEngine;
