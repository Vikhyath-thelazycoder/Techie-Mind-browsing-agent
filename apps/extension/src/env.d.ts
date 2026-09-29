/** Injected at build time by scripts/build.ts. */
declare const __TARGET__: 'chrome' | 'firefox';
declare const __VERSION__: string;

/** Vite: `import url from './file?url'` gives the built file's URL. */
declare module '*?url' {
  const url: string;
  export default url;
}
