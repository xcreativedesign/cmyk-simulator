/**
 * fileHandler.js
 * CMYK Simulator — File Handling & Image Preparation
 *
 * Responsibilities:
 * - Validate file size and format before any processing
 * - Resize image to max 1500x1500px before processing (user never sees this)
 * - Extract ImageData from canvas for worker
 * - Provide original pixel data for split view
 */

'use strict';

const FileHandler = (() => {

  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  const MAX_DIMENSION = 1500;
  const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const ERROR_MESSAGES = {
    size: 'File too large. Please use an image under 5MB for best performance.',
    type: 'Unsupported file format. Please upload a JPG, PNG, or WEBP image.',
    load: 'Could not load image. The file may be corrupted. Please try another image.',
    generic: 'Something went wrong processing your file. Please try again.'
  };

  /**
   * Validate file before attempting to read it.
   * @param {File} file
   * @returns {{ valid: boolean, error: string|null }}
   */
  function validate(file) {
    if (!file) return { valid: false, error: ERROR_MESSAGES.generic };
    if (file.size > MAX_FILE_SIZE) return { valid: false, error: ERROR_MESSAGES.size };
    if (!ACCEPTED_TYPES.includes(file.type)) return { valid: false, error: ERROR_MESSAGES.type };
    return { valid: true, error: null };
  }

  /**
   * Load a File object into an HTMLImageElement.
   * @param {File} file
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(ERROR_MESSAGES.load));
      };
      img.src = url;
    });
  }

  /**
   * Resize image to fit within MAX_DIMENSION while preserving aspect ratio.
   * Returns an offscreen canvas with the resampled image.
   * @param {HTMLImageElement} img
   * @returns {{ canvas: HTMLCanvasElement, width: number, height: number, wasResized: boolean }}
   */
  function resizeImage(img) {
    let { naturalWidth: w, naturalHeight: h } = img;
    const wasResized = w > MAX_DIMENSION || h > MAX_DIMENSION;

    if (wasResized) {
      const scale = MAX_DIMENSION / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Use high-quality downsampling
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    return { canvas, width: w, height: h, wasResized };
  }

  /**
   * Full pipeline: validate → load → resize → extract pixels.
   * @param {File} file
   * @param {function} onProgress - called with step descriptions
   * @returns {Promise<{ imageData: ImageData, width: number, height: number, canvas: HTMLCanvasElement, wasResized: boolean }>}
   */
  async function prepare(file, onProgress = () => {}) {
    const validation = validate(file);
    if (!validation.valid) throw new Error(validation.error);

    onProgress('Loading image…');
    const img = await loadImage(file);

    onProgress('Preparing for processing…');
    const { canvas, width, height, wasResized } = resizeImage(img);

    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, width, height);

    return { imageData, width, height, canvas, wasResized };
  }

  /**
   * Get pixel data at canvas display coordinates.
   * Handles letterboxing from object-fit:contain by calculating actual offsets.
   *
   * @param {HTMLCanvasElement} displayCanvas - the visible canvas element
   * @param {number} sourceWidth - actual image pixel width
   * @param {number} sourceHeight - actual image pixel height
   * @param {number} clientX - mouse X relative to canvas element
   * @param {number} clientY - mouse Y relative to canvas element
   * @returns {{ x: number, y: number, valid: boolean }} pixel coordinates in source image
   */
  function clientToImageCoords(displayCanvas, sourceWidth, sourceHeight, clientX, clientY) {
    const rect = displayCanvas.getBoundingClientRect();
    const displayW = rect.width;
    const displayH = rect.height;

    // Calculate letterbox offsets (how object-fit: contain scales the image)
    const scaleX = displayW / sourceWidth;
    const scaleY = displayH / sourceHeight;
    const scale = Math.min(scaleX, scaleY);

    const renderedW = sourceWidth * scale;
    const renderedH = sourceHeight * scale;

    const offsetX = (displayW - renderedW) / 2;
    const offsetY = (displayH - renderedH) / 2;

    const relX = clientX - offsetX;
    const relY = clientY - offsetY;

    if (relX < 0 || relY < 0 || relX > renderedW || relY > renderedH) {
      return { x: 0, y: 0, valid: false };
    }

    return {
      x: Math.round(relX / scale),
      y: Math.round(relY / scale),
      valid: true
    };
  }

  /**
   * Read RGBA values at a specific pixel coordinate from an ImageData object.
   * @param {ImageData} imageData
   * @param {number} x
   * @param {number} y
   * @returns {{ r: number, g: number, b: number, a: number }}
   */
  function getPixelAt(imageData, x, y) {
    const idx = (y * imageData.width + x) * 4;
    return {
      r: imageData.data[idx],
      g: imageData.data[idx + 1],
      b: imageData.data[idx + 2],
      a: imageData.data[idx + 3]
    };
  }

  return { validate, prepare, clientToImageCoords, getPixelAt, MAX_FILE_SIZE, ACCEPTED_TYPES };
})();
