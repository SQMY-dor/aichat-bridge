// Generate an isolated Playwright CLI audit. Only these local files can load.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = { '/audit': path.join(root, 'test/browser/claude-gemini-audit.html') };
for (const name of ['claude-dom', 'gemini-dom', 'dom', 'shared', 'image-equivalence']) paths[`/extension/${name}.js`] = path.join(root, `extension/${name}.js`);
for (const name of ['claude-conversation', 'gemini-conversation', 'claude-prefixed-attachment', 'gemini-clipboard-attachment']) paths[`/test/fixtures/${name}.html`] = path.join(root, `test/fixtures/${name}.html`);
const output = path.join(os.tmpdir(), 'aichat-claude-gemini-browser-check.js');
fs.writeFileSync(output, `async page => {
  const paths = ${JSON.stringify(paths)};
  await page.route('**/*', route => {
    const url = route.request().url();
    const origin = ['https://claude.ai/', 'https://gemini.google.com/'].find(value => url.startsWith(value));
    if (!origin) return route.abort();
    const pathname = '/' + url.slice(origin.length).split('?')[0];
    return paths[pathname] ? route.fulfill({ path: paths[pathname], contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/html' }) : route.abort();
  });
  const results = [];
  for (const host of ['claude.ai', 'gemini.google.com']) {
    await page.goto('https://' + host + '/audit');
    await page.waitForFunction(() => window.regressionResult);
    const result = await page.evaluate(() => window.regressionResult);
    if (result.error) throw new Error(JSON.stringify(result));
    results.push(result);
  }
  return { passed: results.reduce((sum, result) => sum + result.passed, 0), results };
}`);
console.log(output);
