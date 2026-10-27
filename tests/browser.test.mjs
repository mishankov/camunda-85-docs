import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

test('keyboard search opens, preserves its query, and navigates to an attributed article', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.keyboard.press('Control+k');
  await page.locator('#search-input').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#search-input').evaluate(el => el === document.activeElement), true);
  await page.locator('#search-input').fill('BPMN primer');
  await page.locator('.search-result').first().waitFor();
  assert.equal(await page.locator('.search-result strong').first().textContent(), 'BPMN primer');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), false);
  await page.keyboard.press('/');
  assert.equal(await page.locator('#search-input').inputValue(), 'BPMN primer');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('.search-result').first().evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.waitForURL('**/docs/components/modeler/bpmn/bpmn-primer/index.html');
  assert.equal(await page.locator('h1').textContent(), 'BPMN primer');
  assert.equal(await page.locator('.primary-nav a[aria-current]').textContent(), 'Using Camunda 8');
  assert.equal(await page.locator('.sidebar a[aria-current=page]').isVisible(), true);
  assert.equal(await page.locator('.original-link').getAttribute('href'), 'https://unsupported.docs.camunda.io/8.5/docs/components/modeler/bpmn/bpmn-primer/');
  await page.screenshot({ path: 'test-results/article.png', fullPage: false });
  assert.deepEqual(errors, []);
  await page.close();
});

test('shortcuts respect IME, key repeat, disabled commands, dialogs, and other layouts', async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const dispatch = options => page.evaluate(options => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options })), options);
  for (const options of [{ key: 'k', code: 'KeyK', ctrlKey: true, repeat: true }, { key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true }]) {
    await dispatch(options);
    assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), false);
  }
  await page.locator('.search-button').evaluate(el => { el.disabled = true; });
  await dispatch({ key: 'k', code: 'KeyK', ctrlKey: true });
  assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), false);
  await page.locator('.search-button').evaluate(el => { el.disabled = false; });
  await page.evaluate(() => { const other = document.createElement('dialog'); other.id = 'other'; document.body.append(other); other.showModal(); });
  await dispatch({ key: 'k', code: 'KeyK', ctrlKey: true });
  assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), false);
  await page.locator('#other').evaluate(el => el.close());
  await dispatch({ key: 'л', code: 'KeyK', metaKey: true });
  assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), true);
  await page.locator('#search-input').fill('zeebe');
  await page.locator('#search-input').dispatchEvent('compositionstart');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), true);
  await page.locator('#search-input').dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await page.locator('.search-button').click();
  await page.locator('#search-input').fill('a-search-with-no-matching-documents-912049');
  await page.waitForFunction(() => document.querySelector('#search-status').textContent.startsWith('No pages match'));
  assert.equal(await page.locator('.search-result').count(), 0);
  await page.close();
});

test('archive works with file URLs, expanded examples, and small screens', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(pathToFileURL(path.join(site, 'index.html')).href);
  await page.locator('.search-button').click();
  await page.locator('#search-input').fill('Docker Compose');
  await page.locator('.search-result').first().waitFor();
  await page.locator('#close-search').click();
  await page.goto(`${base}/docs/self-managed/setup/deploy/local/docker-compose/index.html`);
  assert.equal(await page.locator('[role=tab]').count(), 0);
  assert.ok(await page.locator('.example-label').count() >= 4);
  assert.ok(await page.getByText('No additional input is required.', { exact: true }).isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await page.screenshot({ path: 'test-results/home.png', fullPage: true });
  await page.close();
});

test('source hierarchy preserves Events, and section navigation works from the keyboard', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${base}/docs/components/modeler/bpmn/escalation-events/index.html`);
  const current = page.locator('.sidebar a[aria-current=page]');
  const labels = await current.evaluate(link => {
    const labels = [];
    for (let node = link.parentElement; node; node = node.parentElement) {
      if (node.matches('details.nav-group')) labels.unshift(node.querySelector(':scope > summary').firstChild.textContent.trim());
    }
    return labels;
  });
  assert.deepEqual(labels, ['Modeler', 'BPMN', 'Events']);
  const events = page.locator('.sidebar summary').filter({ hasText: /^Events$/ });
  await events.focus();
  await page.keyboard.press('Enter');
  assert.equal(await current.isVisible(), false);
  await page.keyboard.press('Space');
  assert.equal(await current.isVisible(), true);
  assert.equal(await events.evaluate(el => el === document.activeElement), true);
  await page.screenshot({ path: 'test-results/hierarchy-desktop.png' });
  const managed = page.locator('.primary-nav a', { hasText: 'Self-Managed' });
  await managed.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL('**/docs/self-managed/about-self-managed/index.html');
  assert.equal(await page.locator('.primary-nav a[aria-current]').textContent(), 'Self-Managed');
  assert.equal(await page.locator('.sidebar nav').getAttribute('aria-label'), 'Self-Managed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  assert.equal(await page.locator('.section-menu').evaluate(el => el.open), false);
  const contents = page.locator('.section-menu > summary');
  await contents.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.section-menu').evaluate(el => el.open), true);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.section-menu').evaluate(el => el.open), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/hierarchy-mobile.png' });
  await page.close();
});

test('every section has its own complete navigation, including generated API schemas', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const sections = [
    ['guides', 'Guides', 'Get started'],
    ['components', 'Using Camunda 8', 'Modeler'],
    ['self-managed', 'Self-Managed', 'Setup'],
    ['apis-tools', 'APIs & tools', 'Clients & SDKs'],
    ['reference', 'Reference', 'Release notes'],
    ['tags', 'Topics', null],
  ];
  await page.goto(base);
  for (const [section, label, category] of sections) {
    await page.locator('.primary-nav a').filter({ hasText: label }).click();
    assert.match(page.url(), new RegExp(`/docs/${section}/`));
    assert.equal(await page.locator('.primary-nav a[aria-current]').textContent(), label);
    assert.equal(await page.locator('.sidebar nav').getAttribute('aria-label'), label);
    if (category) assert.ok((await page.locator('.sidebar summary').allTextContents()).some(text => text.trim() === category));
  }
  await page.goto(`${base}/docs/apis-tools/tasklist-api-rest/schemas/responses/task-response/index.html`);
  const ancestors = await page.locator('.sidebar a[aria-current=page]').evaluate(link => {
    const names = [];
    for (let node = link.parentElement; node; node = node.parentElement) {
      if (node.matches('details.nav-group')) names.unshift(node.querySelector(':scope > summary').firstChild.textContent.trim());
    }
    return names;
  });
  assert.deepEqual(ancestors, ['APIs', 'Tasklist API (REST)', 'Schemas', 'Responses']);
  await page.close();
});
