// 将 src/ 打包为单文件 index.html(three.js 与代码全部内联,可离线打开)
import { build, context } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: !watch,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
  logLevel: 'info',
};

function emit(result) {
  const code = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const tpl = readFileSync('src/template.html', 'utf8');
  const html = tpl.replace('/*__BUNDLE__*/', () => code);
  writeFileSync('index.html', html);
  console.log(`index.html  ${(html.length / 1024).toFixed(0)} KB`);
}

if (watch) {
  const ctx = await context({ ...opts, plugins: [{ name: 'emit', setup(b) { b.onEnd(emit); } }] });
  await ctx.watch();
} else {
  emit(await build(opts));
}
