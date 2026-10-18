// Run the real adapter in isolated Chromium without any live ChatGPT traffic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const paths = { '/c/fixture-conversation': path.join(root, 'test/browser/chatgpt-audit.html') };
for (const name of ['dom', 'shared']) paths[`/extension/${name}.js`] = path.join(root, `extension/${name}.js`);
for (const name of ['chatgpt-modern-attachment', 'chatgpt-modern-generated-image']) paths[`/fixtures/${name}.html`] = path.join(root, `test/fixtures/${name}.html`);
paths['/fixtures/input-image.png'] = path.join(root, 'test/fixtures/image-equivalence/source.png');
paths['/backend-api/estuary/content'] = paths['/fixtures/input-image.png'];
const output = path.join(os.tmpdir(), 'aichat-chatgpt-browser-check.js');
fs.writeFileSync(output, `async page => {
  const paths = ${JSON.stringify(paths)};
  await page.route('**/*', route => {
    const pathname = route.request().url().replace(/^https:\\/\\/[^/]+/, '').split('?')[0];
    return paths[pathname] ? route.fulfill({ path: paths[pathname], contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.png') || pathname === '/backend-api/estuary/content' ? 'image/png' : 'text/html' }) : route.abort();
  });
  await page.goto('https://chatgpt.com/c/fixture-conversation');
  await page.waitForFunction(() => window.regressionResult);
  const result = await page.evaluate(() => window.regressionResult);
  if (result.error) throw new Error(result.error);
  return result;
}`);
console.log(output);
