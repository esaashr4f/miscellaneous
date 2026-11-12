// Bundles the official Anthropic SDK into a single plain script the extension's
// background page can load. Re-run with `npm run build:vendor` after upgrading the SDK.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const version = JSON.parse(
  readFileSync(new URL('../node_modules/@anthropic-ai/sdk/package.json', import.meta.url)),
).version;

await build({
  stdin: {
    contents: "export { default as Anthropic } from '@anthropic-ai/sdk';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  format: 'iife',
  globalName: 'AnthropicSDK',
  platform: 'browser',
  target: 'firefox115',
  minify: false,
  legalComments: 'inline',
  banner: { js: `/* @anthropic-ai/sdk ${version}, bundled unmodified with esbuild (see scripts/build-vendor.mjs). */` },
  outfile: 'extension/vendor/anthropic-sdk.js',
});
console.log(`vendor/anthropic-sdk.js built from @anthropic-ai/sdk ${version}`);
