import type { VisualCapture } from '@techie-mind/agent-core';
import type { PrivacyRegionsResponse } from '@techie-mind/contracts';

/**
 * Local visual privacy (spec §14 layer 4, §15): the screenshot is decoded, scaled and has every
 * sensitive region painted solid black INSIDE the background, before it exists anywhere else. Only
 * the redacted PNG leaves this function; the raw capture is dropped with the bitmap.
 */

/** Width sent to the vision model: a multiple of 28 (Qwen2.5-VL's patch size) so it is not resized. */
const TARGET_WIDTH = 1008;
const PATCH = 28;
/** Painted margin around each region, in CSS pixels. */
const PAD = 3;

function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function redactCapture(
  dataUrl: string,
  regions: PrivacyRegionsResponse,
  now: () => number = () => performance.now(),
): Promise<VisualCapture> {
  const started = now();
  const { viewport } = regions;
  const width = Math.max(PATCH, Math.min(TARGET_WIDTH, Math.floor(viewport.width / PATCH) * PATCH));
  const scale = width / viewport.width;
  const height = Math.max(PATCH, Math.round((viewport.height * scale) / PATCH) * PATCH);
  const bitmap = await createImageBitmap(new Blob([dataUrlBytes(dataUrl)], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas in this browser');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  ctx.fillStyle = '#000';
  for (const { box } of regions.regions) {
    ctx.fillRect(
      Math.floor((box.x - PAD) * scale),
      Math.floor((box.y - PAD) * scale),
      Math.ceil((box.width + PAD * 2) * scale),
      Math.ceil((box.height + PAD * 2) * scale),
    );
  }
  const png = await canvas.convertToBlob({ type: 'image/png' });
  return {
    image: {
      base64: toBase64(await png.arrayBuffer()),
      width,
      height,
      redacted: true,
      regions: regions.regions.length,
    },
    scale,
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    ms: now() - started,
  };
}
