/**
 * Builds the extension for each browser target:
 *   1. extension pages (side panel, settings) + background as ES modules
 *   2. content script as a single classic IIFE (content scripts cannot be ES modules)
 *   3. per-target manifest.json
 * Usage: tsx scripts/build.ts [chrome|firefox]   (default: both)
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { build, type InlineConfig } from 'vite';
import { buildManifest, PATHS, type Target } from './manifest.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(appDir, 'src');

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(resolve(appDir, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/**
 * Zod ships comments Rollup cannot place (INVALID_ANNOTATION); they are dropped harmlessly. Only that
 * code from node_modules is silenced — every other warning, including ours, is still reported.
 * (onLog, not onwarn: @preact/preset-vite installs its own onwarn, which would replace ours.)
 */
const onLog: NonNullable<NonNullable<InlineConfig['build']>['rollupOptions']>['onLog'] = (
  level,
  log,
  handler,
) => {
  if (level === 'warn' && log.code === 'INVALID_ANNOTATION' && log.id?.includes('/node_modules/')) {
    return;
  }
  handler(level, log);
};

function sharedConfig(target: Target, version: string, outDir: string): InlineConfig {
  return {
    configFile: false,
    logLevel: 'warn',
    root: srcDir,
    publicDir: resolve(appDir, 'public'),
    define: {
      __TARGET__: JSON.stringify(target),
      __VERSION__: JSON.stringify(version),
    },
    build: {
      outDir,
      target: target === 'chrome' ? 'chrome116' : 'firefox128',
      sourcemap: false,
      minify: true,
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: { onLog },
    },
  };
}

async function buildTarget(target: Target, version: string): Promise<void> {
  const outDir = resolve(appDir, 'dist', target);
  await rm(outDir, { recursive: true, force: true });
  const base = sharedConfig(target, version, outDir);

  // 1. Pages + background service worker (ES modules).
  await build({
    ...base,
    plugins: [preact()],
    build: {
      ...base.build,
      emptyOutDir: true,
      rollupOptions: {
        onLog,
        input: {
          sidepanel: resolve(srcDir, 'sidepanel/index.html'),
          settings: resolve(srcDir, 'settings/index.html'),
          background: resolve(srcDir, 'background/index.ts'),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'background' ? PATHS.background : 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });

  // 2. Content script: one self-contained classic script.
  await build({
    ...base,
    publicDir: false,
    build: {
      ...base.build,
      emptyOutDir: false,
      lib: {
        entry: resolve(srcDir, 'content/index.ts'),
        formats: ['iife'],
        name: 'TechieMindContent',
        fileName: () => PATHS.content,
      },
    },
  });

  // 3. Manifest.
  await writeFile(
    resolve(outDir, 'manifest.json'),
    `${JSON.stringify(buildManifest(target, version), null, 2)}\n`,
  );
  console.log(`built ${target} → ${outDir}`);
}

const requested = process.argv[2];
const targets: Target[] =
  requested === 'chrome' || requested === 'firefox' ? [requested] : ['chrome', 'firefox'];

const version = await readVersion();
for (const target of targets) await buildTarget(target, version);
