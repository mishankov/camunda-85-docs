import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const site = fileURLToPath(new URL('../site/', import.meta.url));
let browser, server, base;
before(async () => {
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const filename = path.resolve(site, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
      if (!filename.startsWith(site)) { res.writeHead(403).end(); return; }
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
      const data = await readFile(filename);
      res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  await mkdir('test-results', { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function searchPage(query, fixture) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  if (fixture) await page.addInitScript(pages => { window.CAMUNDA_SEARCH = pages; }, fixture);
  await page.goto(base);
  await page.locator('.search-button').click();
  await page.locator('#search-input').fill(query);
  await page.waitForFunction(() => /^\d+ matching pages/.test(document.querySelector('#search-status').textContent));
  return page;
}

test('the real start-event phrase ranks None events before scattered matches and appears in its snippet', async () => {
  const page = await searchPage('start event is required');
  const titles = await page.locator('.search-result-title').allTextContents();
  const none = titles.indexOf('None events');
  assert.ok(none >= 0, 'None events must be returned');
  const amazon = titles.findIndex(title => /Amazon|EventBridge/i.test(title));
  assert.ok(amazon === -1 || none < amazon, `Exact phrase should rank before Amazon/EventBridge: ${titles.join(', ')}`);
  const result = page.locator('.search-result').filter({ has: page.locator('.search-result-title', { hasText: /^None events$/ }) });
  assert.ok((await result.locator('p strong').allTextContents()).some(text => text.toLowerCase() === 'start event is required'));
  assert.match(await result.locator('p').textContent(), /A none start event is required if you want to trigger a process via a form/);
  await page.screenshot({ path: 'test-results/search-highlights-light.png' });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.CamundaTheme.setPreference('dark'));
  await page.locator('.search-button').click();
  await page.screenshot({ path: 'test-results/search-highlights-dark.png' });
  await page.close();
});

test('whole phrases outrank title words in a different order and retain source capitalization', async () => {
  const fixture = [
    { title: 'Start event required is', section: 'Fixture', url: 'scattered.html', text: 'Start in a process. The event is optional; another task may be required.' },
    { title: 'None events', section: 'Fixture', url: 'exact.html', text: `${'Start in the introduction. '.repeat(35)}A none Start Event Is Required to begin. ${'Further explanation follows. '.repeat(12)}` },
  ];
  const page = await searchPage('START event IS required', fixture);
  assert.equal(await page.locator('.search-result-title').first().textContent(), 'None events');
  assert.deepEqual(await page.locator('.search-result').first().locator('p strong').allTextContents(), ['Start Event Is Required']);
  const snippet = await page.locator('.search-result p').first().textContent();
  assert.ok(snippet.startsWith('…'));
  assert.match(snippet, /A none Start Event Is Required to begin/);
  assert.ok(snippet.length <= 212);
  assert.ok(snippet.indexOf('Start Event Is Required') > 35, 'Phrase has useful leading context');
  assert.ok(snippet.indexOf('Start Event Is Required') < 150, 'Phrase is centered in the snippet');
  const scattered = page.locator('.search-result').nth(1);
  assert.deepEqual(await scattered.locator('.search-result-title strong').allTextContents(), ['Start', 'event', 'required', 'is']);
  await page.close();
});

test('exact title highlights preserve the existing result keyboard flow', async () => {
  const page = await searchPage('bPmN PrImEr');
  const first = page.locator('.search-result').first();
  assert.equal(await first.locator('.search-result-title').textContent(), 'BPMN primer');
  assert.deepEqual(await first.locator('.search-result-title strong').allTextContents(), ['BPMN primer']);
  await page.keyboard.press('ArrowDown');
  assert.equal(await first.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.waitForURL('**/docs/components/modeler/bpmn/bpmn-primer/index.html');
  assert.equal(await page.locator('h1').textContent(), 'BPMN primer');
  await page.close();
});

test('scattered terms show the substantive matching passage and highlight only matched fragments', async () => {
  const fixture = [{
    title: 'Process signals', section: 'Fixture', url: 'signals.html',
    text: `The process is available. ${'General overview of a model. '.repeat(25)}Correlations connect a signal to the subscription; delivery is asynchronous. ${'Additional guidance. '.repeat(12)}`,
  }];
  const page = await searchPage('is correlations asynchronous', fixture);
  const result = page.locator('.search-result').first();
  assert.equal(await result.locator('.search-result-title strong').count(), 0);
  const snippet = await result.locator('p').textContent();
  assert.match(snippet, /Correlations connect a signal to the subscription; delivery is asynchronous/);
  const bold = await result.locator('p strong').allTextContents();
  assert.ok(bold.includes('Correlations'));
  assert.ok(bold.includes('asynchronous'));
  assert.ok(bold.every(text => ['is', 'correlations', 'asynchronous'].includes(text.toLowerCase())));
  await page.close();
});

test('HTML-like source text and queries remain literal text without executable elements', async () => {
  const literal = '<img src=x onerror=window.searchInjected=true>';
  const page = await searchPage(literal, [{ title: `Literal ${literal} example`, section: '<script>section</script>', url: 'literal.html', text: `Example markup: ${literal}. Use it as plain text.` }]);
  const result = page.locator('.search-result').first();
  assert.equal(await result.locator('img,script,iframe,svg').count(), 0);
  assert.equal(await page.evaluate(() => window.searchInjected), undefined);
  assert.equal(await result.locator('.search-result-title strong').textContent(), literal);
  assert.equal(await result.locator('p strong').textContent(), literal);
  assert.equal(await result.locator('small').textContent(), '<script>section</script>');
  assert.equal(await page.locator('#search-input').inputValue(), literal);
  await page.close();
});
