import { inflateSync } from 'node:zlib';
import type { BrowserContext, Route } from '@playwright/test';

/**
 * Stand-in model servers for real-browser tests. They speak the real wire formats (Ollama
 * `/api/tags` + `/api/chat`, the Laya adapter `/v1/classify`) and answer with simple, visible rules
 * so tests are deterministic. They are NOT the models: real-model runs use `npm run bench:models`.
 */
export interface ModelTraffic {
  /** Every request body the extension sent to a model endpoint (as text). */
  bodies: string[];
  laya: number;
  chat: number;
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'one',
  'now',
  'open',
  'please',
  'with',
  'of',
  'to',
  'show',
  'me',
]);

/** Pick the element line sharing the most words with the request (what a model would do here). */
function pickElement(request: string, page: string): string | null {
  const words = request
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));
  let best: { id: string; score: number } | null = null;
  for (const line of page.split('\n')) {
    const m = /^(\S+) \| (link|button) \| (.+)$/.exec(line);
    if (!m) continue;
    const text = m[3]!.toLowerCase();
    const score = words.filter((w) => text.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { id: m[1]!, score };
  }
  return best?.id ?? null;
}

export async function serveModelStandIns(
  context: BrowserContext,
  options: { laya?: 'escalate' | 'search' | 'down'; model?: 'element' | 'abstain' | 'down' } = {},
): Promise<ModelTraffic> {
  const traffic: ModelTraffic = { bodies: [], laya: 0, chat: 0 };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await context.route(/^http:\/\/127\.0\.0\.1:8765\//, async (route) => {
    if (options.laya === 'down') return route.abort('connectionrefused');
    traffic.bodies.push(route.request().postData() ?? '');
    traffic.laya += 1;
    return json(
      route,
      options.laya === 'search'
        ? { category: 'search', confidence: 0.92, escalate: false }
        : { category: 'pick_result', confidence: 0.41, escalate: true },
    );
  });

  await context.route(/^http:\/\/127\.0\.0\.1:11434\//, async (route) => {
    if (options.model === 'down') return route.abort('connectionrefused');
    const url = new URL(route.request().url());
    if (url.pathname === '/api/tags') return json(route, { models: [{ name: 'qwen2.5vl:7b' }] });
    const raw = route.request().postData() ?? '';
    traffic.bodies.push(raw);
    traffic.chat += 1;
    const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string }> };
    const user = body.messages.at(-1)?.content ?? '';
    const request = /^User request: (.*)$/m.exec(user)?.[1] ?? '';
    const id = options.model === 'abstain' ? null : pickElement(request, user);
    const answer = id
      ? { kind: 'element', elementId: id, media: false, confidence: 0.84, reason: 'best match' }
      : { kind: 'abstain', question: 'Which item do you mean?', confidence: 0, reason: 'unsure' };
    return json(route, {
      model: body.model,
      message: { role: 'assistant', content: JSON.stringify(answer) },
      done: true,
    });
  });
  return traffic;
}

// ── Phase 4: a stand-in vision model that really reads the pixels it is sent ──────────────────

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  pixel(x: number, y: number): [number, number, number, number];
}

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced — what canvas.convertToBlob produces). */
export function decodePng(base64: string): DecodedImage {
  const buf = Buffer.from(base64, 'base64');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!channels) throw new Error('unsupported PNG colour type');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= channels ? out[y * stride + x - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const v = [cur, cur + a, cur + b, cur + ((a + b) >> 1), cur + paeth][filter]!;
      out[y * stride + x] = v & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = y * stride + x * channels;
      return [out[i]!, out[i + 1]!, out[i + 2]!, channels === 4 ? out[i + 3]! : 255];
    },
  };
}

const COLOURS: Record<string, (r: number, g: number, b: number) => boolean> = {
  red: (r, g, b) => r > 180 && g < 70 && b < 70,
  blue: (r, g, b) => b > 180 && r < 80 && g < 130,
  green: (r, g, b) => g > 120 && r < 80 && b < 100,
};

export interface VisionTraffic extends ModelTraffic {
  images: DecodedImage[];
  vision: number;
}

/**
 * Laya escalates, the text model abstains (tiles have no names), and the vision stand-in finds the
 * colour named in the target by scanning the decoded screenshot for it.
 */
export async function serveVisionStandIns(context: BrowserContext): Promise<VisionTraffic> {
  const traffic: VisionTraffic = { bodies: [], laya: 0, chat: 0, images: [], vision: 0 };
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route(/^http:\/\/127\.0\.0\.1:8765\//, async (route) => {
    traffic.laya += 1;
    return json(route, { category: 'pick_result', confidence: 0.4, escalate: true });
  });
  await context.route(/^http:\/\/127\.0\.0\.1:11434\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/tags') return json(route, { models: [{ name: 'qwen2.5vl:7b' }] });
    const raw = route.request().postData() ?? '';
    const body = JSON.parse(raw) as { messages: Array<{ content: string; images?: string[] }> };
    const user = body.messages.at(-1)!;
    traffic.bodies.push(user.images ? raw.replace(/"images":\["[^"]*"\]/, '"images":["…"]') : raw);
    if (!user.images) {
      traffic.chat += 1;
      const answer = {
        kind: 'abstain',
        question: 'Which item?',
        confidence: 0,
        reason: 'unnamed tiles',
      };
      return json(route, { message: { role: 'assistant', content: JSON.stringify(answer) } });
    }
    traffic.vision += 1;
    const image = decodePng(user.images[0]!);
    traffic.images.push(image);
    const colour = Object.keys(COLOURS).find((c) => user.content.toLowerCase().includes(c));
    let box: number[] | null = null;
    if (colour) {
      let [x1, y1, x2, y2] = [Infinity, Infinity, -1, -1];
      for (let y = 0; y < image.height; y += 2) {
        for (let x = 0; x < image.width; x += 2) {
          const [r, g, b] = image.pixel(x, y);
          if (COLOURS[colour]!(r, g, b)) {
            x1 = Math.min(x1, x);
            y1 = Math.min(y1, y);
            x2 = Math.max(x2, x);
            y2 = Math.max(y2, y);
          }
        }
      }
      if (x2 > x1 && y2 > y1) box = [x1, y1, x2, y2];
    }
    const answer = box
      ? { found: true, box, label: `${colour} item`, confidence: 0.8 }
      : { found: false, reason: 'not visible' };
    return json(route, { message: { role: 'assistant', content: JSON.stringify(answer) } });
  });
  return traffic;
}
