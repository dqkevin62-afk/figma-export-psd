// Builds the plugin into dist/: dist/code.js (sandbox) and dist/ui.html
// (UI with all JS, including ag-psd, bundled inline; Figma plugin UIs must
// be a single self-contained HTML file).

import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });

const codeOpts = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2017',
  charset: 'utf8',
  logLevel: 'info',
};

const uiOpts = {
  entryPoints: ['src/ui/main.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2017',
  platform: 'browser',
  charset: 'utf8',
  minify: true,
  logLevel: 'info',
};

function writeUiHtml(js) {
  const template = readFileSync('src/ui/ui.html', 'utf8');
  const html = template.replace('<!--SCRIPT-->', () => '<script>' + js + '</script>');
  writeFileSync('dist/ui.html', html);
  console.log('dist/ui.html written (' + Math.round(html.length / 1024) + ' KB)');
}

async function buildOnce() {
  await esbuild.build(codeOpts);
  const ui = await esbuild.build(uiOpts);
  writeUiHtml(ui.outputFiles[0].text);
}

if (watch) {
  const codeCtx = await esbuild.context(codeOpts);
  await codeCtx.watch();
  const uiCtx = await esbuild.context({
    ...uiOpts,
    plugins: [
      {
        name: 'inline-html',
        setup(build) {
          build.onEnd((result) => {
            if (result.outputFiles && result.outputFiles.length) {
              writeUiHtml(result.outputFiles[0].text);
            }
          });
        },
      },
    ],
  });
  await uiCtx.watch();
  console.log('Watching for changes...');
} else {
  await buildOnce();
}
