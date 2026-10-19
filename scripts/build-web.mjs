// Bundles the React UI (web/src/main.jsx) into dist/web with esbuild. `node scripts/build-web.mjs --watch` rebuilds on change.
import { cp, mkdir, rm } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const out = 'dist/web';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp('web/index.html', `${out}/index.html`);
await cp('web/styles.css', `${out}/styles.css`);

const options = {
  entryPoints: ['web/src/main.jsx'],
  bundle: true,
  outfile: `${out}/app.js`,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  minify: !watch,
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching web/ …');
} else {
  await esbuild.build(options);
}
