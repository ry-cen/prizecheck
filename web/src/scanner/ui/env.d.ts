// What the scanner page reads of Vite's `import.meta.env`, and the browser tests' hook (see testHooks.ts).
interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}
interface Window {
  /** Set by a browser test before the page loads. Honoured only by the dev server's build (`import.meta.env.DEV`);
   * a production build drops the branch and the stub with it. */
  __PRIZECHECK_SCANNER_TEST__?: unknown;
}
