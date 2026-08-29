/*
 * images.js
 * ---------
 * Resize/grayscale/cover-crop via @cf-wasm/photon (a Rust image library
 * compiled to WASM) — Workers have no <canvas>/OffscreenCanvas, so this
 * replaces the extension's canvas-based processImage()/cropToCover().
 *
 * Callers should wrap these in try/catch per-image (see worker.js) so a
 * photon failure (corrupt image, unsupported format, oversized image)
 * degrades to "skip this image" rather than failing the whole build.
 */
const { PhotonImage, resize, crop, SamplingFilter } = require('@cf-wasm/photon/workerd');

async function processImage(bytes, maxWidth, grayscale) {
  let img;
  try {
    img = PhotonImage.new_from_byteslice(bytes);
    const scale = Math.min(1, maxWidth / img.get_width());
    const w = Math.max(1, Math.round(img.get_width() * scale));
    const h = Math.max(1, Math.round(img.get_height() * scale));
    const resized = resize(img, w, h, SamplingFilter.Lanczos3);
    img.free();
    img = resized;
    if (grayscale) img.grayscale();
    const out = img.get_bytes_jpeg(72);
    return new Uint8Array(out);
  } finally {
    if (img) img.free();
  }
}

// Crop-to-fill onto targetW x targetH, centered — same treatment as the
// extension's cropToCover().
async function cropToCover(bytes, targetW, targetH, grayscale) {
  let img;
  try {
    img = PhotonImage.new_from_byteslice(bytes);
    const scale = Math.max(targetW / img.get_width(), targetH / img.get_height());
    const scaledW = Math.max(1, Math.round(img.get_width() * scale));
    const scaledH = Math.max(1, Math.round(img.get_height() * scale));
    const scaledImg = resize(img, scaledW, scaledH, SamplingFilter.Lanczos3);
    img.free();
    img = scaledImg;
    const offsetX = Math.max(0, Math.round((scaledW - targetW) / 2));
    const offsetY = Math.max(0, Math.round((scaledH - targetH) / 2));
    const cropped = crop(img, offsetX, offsetY, Math.min(scaledW, offsetX + targetW), Math.min(scaledH, offsetY + targetH));
    img.free();
    img = cropped;
    if (grayscale) img.grayscale();
    const out = img.get_bytes_jpeg(80);
    return new Uint8Array(out);
  } finally {
    if (img) img.free();
  }
}

module.exports = { processImage, cropToCover };
