import { FileDigest, MAX_DIGEST_TEXT } from '@techie-mind/contracts';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Images are shrunk to this longest side: enough for the local vision model to read text. */
const MAX_SIDE = 1280;
/** Scanned PDFs (almost no text layer): this many first pages are read as images. */
const SCANNED_PAGES = 4;
const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|csv|x-yaml|yaml|javascript|x-ndjson))/;
const TEXT_EXT = /\.(?:txt|md|csv|tsv|json|xml|ya?ml|log|html?|js|ts|py|java|c|cpp|go|rs|sql)$/i;

export function isAnalyzable(file: File): boolean {
  return (
    file.type === 'application/pdf' ||
    /\.pdf$/i.test(file.name) ||
    file.type.startsWith('image/') ||
    TEXT_TYPES.test(file.type) ||
    TEXT_EXT.test(file.name)
  );
}

async function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas) {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
      : await new Promise<Blob>((ok, fail) =>
          canvas.toBlob(
            (b) => (b ? ok(b) : fail(new Error('image encode failed'))),
            'image/jpeg',
            0.85,
          ),
        );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { base64: btoa(binary), width: canvas.width, height: canvas.height };
}

async function imageDigest(file: File): Promise<FileDigest> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  );
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return FileDigest.parse({
    name: file.name,
    kind: 'image',
    pages: 1,
    text: '',
    images: [await canvasToJpeg(canvas)],
  });
}

async function pdfDigest(file: File): Promise<FileDigest> {
  const pdf = await getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
  }).promise;
  try {
    const parts: string[] = [];
    let length = 0;
    for (let n = 1; n <= pdf.numPages && length < MAX_DIGEST_TEXT; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (text) {
        const chunk = `[Page ${n}]\n${text}\n`;
        parts.push(chunk);
        length += chunk.length;
      }
    }
    const text = parts.join('\n').slice(0, MAX_DIGEST_TEXT);
    // A scanned PDF has (almost) no text layer: read its first pages as images instead.
    const images: FileDigest['images'] = [];
    if (text.replace(/\[Page \d+\]/g, '').trim().length < 100 * Math.min(pdf.numPages, 3)) {
      for (let n = 1; n <= Math.min(pdf.numPages, SCANNED_PAGES); n++) {
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(2, MAX_SIDE / Math.max(base.width, base.height)),
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
        images.push(await canvasToJpeg(canvas));
      }
    }
    return FileDigest.parse({ name: file.name, kind: 'pdf', pages: pdf.numPages, text, images });
  } finally {
    await pdf.destroy();
  }
}

async function textDigest(file: File): Promise<FileDigest> {
  return FileDigest.parse({
    name: file.name,
    kind: 'text',
    pages: 1,
    text: (await file.text()).slice(0, MAX_DIGEST_TEXT),
    images: [],
  });
}

/** Read an attached file in the panel. Nothing leaves the browser here. */
export async function buildDigest(file: File): Promise<FileDigest> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return pdfDigest(file);
  if (file.type.startsWith('image/')) return imageDigest(file);
  return textDigest(file);
}
