#!/usr/bin/env node
/*
 * index.html に CSS と JS を埋め込み、1ファイルで遊べる HTML を作る。
 *
 *   node tools/build-single.js [出力先=dist/inflation-quest.html] [--fragment]
 *
 * --fragment を付けると <!doctype>/<html>/<head>/<body> タグを取り除いた断片を出力する
 * （外側の骨組みを自動で付けてくれるホスティング先向け）。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const fragment = args.includes('--fragment');
const out = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(root, 'dist', 'inflation-quest.html'));

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, href) =>
  `<style>\n${fs.readFileSync(path.join(root, href), 'utf8')}</style>`);

html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, src) => {
  // インライン化したスクリプト内の </script> で要素が閉じないようにする
  const code = fs.readFileSync(path.join(root, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script>\n${code}</script>`;
});

if (fragment) {
  html = html
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<\/?html[^>]*>\s*/gi, '')
    .replace(/<\/?head>\s*/gi, '')
    .replace(/<\/?body>\s*/gi, '')
    .replace(/<meta charset="utf-8">\s*/i, '')
    .replace(/<meta name="viewport"[^>]*>\s*/i, '');
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(process.cwd(), out)} (${(html.length / 1024).toFixed(1)} KB)`);
