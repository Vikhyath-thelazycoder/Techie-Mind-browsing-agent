/**
 * Renders the brand mark (same geometry as LogoMark in src/ui/icons.tsx) to the PNG sizes the
 * manifest needs. Run once after changing the logo: npm run icons -w @techie-mind/extension
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#d0543f"/><stop offset="1" stop-color="#9b2f21"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#g)"/>
  <path d="M23 29v-6a9 9 0 0 1 18 0v6" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <rect x="17" y="28" width="30" height="22" rx="5" fill="#fff"/>
  <circle cx="32" cy="37" r="3.2" fill="#9b2f21"/>
  <rect x="30.4" y="38" width="3.2" height="7" rx="1.6" fill="#9b2f21"/>
</svg>`;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${LOGO_SVG.replace(
        '<svg ',
        `<svg width="${size}" height="${size}" `,
      )}</body></html>`,
    );
    await page.screenshot({ path: resolve(outDir, `icon-${size}.png`), omitBackground: true });
    await page.close();
    console.log(`icon-${size}.png`);
  }
} finally {
  await browser.close();
}
