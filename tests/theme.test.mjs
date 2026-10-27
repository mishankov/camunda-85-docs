import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const site = fileURLToPath(new URL('../site/', import.meta.url));
const article = '/docs/self-managed/setup/deploy/local/docker-compose/index.html';
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

async function assertTheme(page, theme, preference) {
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  assert.equal(await page.locator('#theme-choice button[aria-pressed="true"]').getAttribute('data-theme-choice'), preference);
  assert.equal(await page.evaluate(() => window.CamundaTheme.getPreference()), preference);
  assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme), theme);
}

async function dispatchThemeKey(page, options = {}, target = 'body') {
  await page.locator(target).evaluate((el, options) => el.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, key: 'D', code: 'KeyD', shiftKey: true, ...options,
  })), options);
}

// Resolve transparent ancestor backgrounds, including alpha, so a dark foreground
// accidentally left on a dark surface fails with a useful element and ratio.
async function assertReadable(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    assert.equal(await locator.count(), 1, `Missing contrast target ${selector}`);
    const colors = await locator.evaluate(el => {
      const parse = value => {
        const channels = value.match(/[\d.]+/g)?.map(Number);
        if (!channels || channels.length < 3) throw new Error(`Unsupported color ${value}`);
        return [...channels.slice(0, 3), channels[3] ?? 1];
      };
      const over = (front, back) => [...front.slice(0, 3).map((c, i) => c * front[3] + back[i] * (1 - front[3])), 1];
      const chain = [];
      for (let node = el; node; node = node.parentElement) chain.unshift(node);
      let background = [255, 255, 255, 1];
      for (const node of chain) background = over(parse(getComputedStyle(node).backgroundColor), background);
      const foreground = over(parse(getComputedStyle(el).color), background);
      return { foreground, background };
    });
    const luminance = color => color.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const values = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => b - a);
    const contrast = (values[0] + 0.05) / (values[1] + 0.05);
    assert.ok(contrast >= 4.5, `${selector} contrast ${contrast.toFixed(2)}:1 is below 4.5:1 (${JSON.stringify(colors)})`);
  }
}

test('theme follows the system initially and reacts to changes without saving an override', async () => {
  for (const initial of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme: initial });
    const page = await context.newPage();
    await page.goto(base);
    await assertTheme(page, initial, 'system');
    assert.equal(await page.evaluate(() => localStorage.getItem('camunda85-theme')), null);
    const changed = initial === 'light' ? 'dark' : 'light';
    await page.emulateMedia({ colorScheme: changed });
    await assertTheme(page, changed, 'system');
    assert.equal(await page.evaluate(() => localStorage.getItem('camunda85-theme')), null);
    await context.close();
  }
});

test('theme selector persists an explicit choice across article navigation and reload', async () => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(base);
  const choice = page.locator('#theme-choice');
  assert.equal(await choice.getAttribute('aria-keyshortcuts'), 'Shift+D');
  assert.match(await choice.getAttribute('title'), /Shift\s*\+\s*D/i);
  assert.deepEqual(await choice.locator('button').evaluateAll(buttons => buttons.map(button => button.dataset.themeChoice)), ['system', 'light', 'dark']);
  await choice.locator('[data-theme-choice="dark"]').click();
  await assertTheme(page, 'dark', 'dark');
  await choice.locator('[data-theme-choice="light"]').focus();
  await page.keyboard.press('Enter');
  await assertTheme(page, 'light', 'light');
  await choice.locator('[data-theme-choice="dark"]').focus();
  await page.keyboard.press('Space');
  await assertTheme(page, 'dark', 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('camunda85-theme')), 'dark');
  await page.goto(`${base}${article}`);
  assert.ok(await page.locator('.search-button').evaluate(el => el.getBoundingClientRect().width >= 220), 'Desktop search stays wide');
  await assertTheme(page, 'dark', 'dark');
  await page.reload();
  await assertTheme(page, 'dark', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#theme-choice [data-theme-choice="light"]').click();
  await assertTheme(page, 'light', 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await assertTheme(page, 'light', 'light');
  await page.locator('#theme-choice [data-theme-choice="system"]').click();
  await assertTheme(page, 'dark', 'system');
  await page.reload();
  await assertTheme(page, 'dark', 'system');
  await context.close();
});

test('Shift+D shares the theme action and respects keyboard, editing, and dialog guards', async () => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(base);
  await page.keyboard.press('Shift+d');
  await assertTheme(page, 'light', 'light');
  await dispatchThemeKey(page, { key: 'В' }); // Russian layout, same physical key.
  await assertTheme(page, 'dark', 'dark');
  await page.keyboard.press('Shift+d');
  await assertTheme(page, 'light', 'system');
  for (const options of [
    { repeat: true }, { isComposing: true }, { keyCode: 229 },
    { ctrlKey: true }, { altKey: true }, { metaKey: true },
    { shiftKey: false }, { code: 'KeyF' },
  ]) {
    await dispatchThemeKey(page, options);
    await assertTheme(page, 'light', 'system');
  }
  await page.locator('#theme-choice button').evaluateAll(buttons => buttons.forEach(button => { button.disabled = true; }));
  await dispatchThemeKey(page);
  await assertTheme(page, 'light', 'system');
  await page.locator('#theme-choice button').evaluateAll(buttons => buttons.forEach(button => { button.disabled = false; }));
  await page.evaluate(() => {
    for (const tag of ['input', 'textarea', 'div']) {
      const el = document.createElement(tag);
      el.id = `draft-${tag}`;
      if (tag === 'div') el.contentEditable = 'true';
      document.body.append(el);
    }
  });
  for (const tag of ['input', 'textarea', 'div']) {
    const draft = page.locator(`#draft-${tag}`);
    await draft.fill('Unsaved draft');
    await draft.focus();
    await page.keyboard.press('Shift+d');
    await assertTheme(page, 'light', 'system');
    assert.match(await draft.evaluate(el => el.value ?? el.textContent), /^Unsaved draft/);
  }
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Control+k');
  await page.locator('#search-input').fill('BPMN primer');
  await dispatchThemeKey(page);
  await assertTheme(page, 'light', 'system');
  assert.equal(await page.locator('#search-dialog').evaluate(el => el.open), true);
  assert.equal(await page.locator('#search-input').inputValue(), 'BPMN primer');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'theme-test-dialog';
    document.body.append(dialog);
    dialog.showModal();
  });
  await dispatchThemeKey(page);
  await assertTheme(page, 'light', 'system');
  await page.locator('#theme-test-dialog').evaluate(el => el.close());
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Shift+d');
  await assertTheme(page, 'light', 'light');
  await context.close();
});

test('light and dark content, examples, and search remain readable; dark layouts fit mobile', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}${article}`);
  for (const theme of ['light', 'dark']) {
    await page.locator(`#theme-choice [data-theme-choice="${theme}"]`).click();
    await assertTheme(page, theme, theme);
    await assertReadable(page, ['.markdown p', '.markdown a', '.markdown pre', '.markdown pre code', '.markdown p code', '#theme-choice button']);
    if (theme === 'dark') await page.screenshot({ path: 'test-results/theme-dark-article.png' });
    await page.locator('.search-button').click();
    await page.locator('#search-input').fill('BPMN primer');
    await page.locator('.search-result').first().waitFor();
    await assertReadable(page, ['#search-dialog', '#search-input', '#search-status', '.search-result strong', '.search-result p']);
    if (theme === 'dark') await page.screenshot({ path: 'test-results/theme-dark-search.png' });
    await page.keyboard.press('Escape');
  }
  await page.goto(base);
  await assertTheme(page, 'dark', 'dark');
  await page.screenshot({ path: 'test-results/theme-dark-home.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}${article}`);
  await assertTheme(page, 'dark', 'dark');
  assert.equal(await page.locator('#theme-choice').isVisible(), true);
  assert.ok(await page.locator('.search-button').evaluate(el => el.getBoundingClientRect().width >= innerWidth - 40), 'Mobile search spans the available row');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/theme-dark-mobile.png' });
  assert.deepEqual(errors, []);
  await context.close();
});

test('file URLs apply the system theme before content and retain an explicit choice on reload', async () => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto(pathToFileURL(path.join(site, 'index.html')).href, { waitUntil: 'domcontentloaded' });
  await assertTheme(page, 'dark', 'system');
  const scriptOrder = await page.locator('head').evaluate(head => {
    const nodes = [...head.children];
    const theme = nodes.findIndex(el => el.tagName === 'SCRIPT' && el.getAttribute('src')?.endsWith('theme.js'));
    const css = nodes.findIndex(el => el.matches('link[rel=stylesheet]'));
    return { theme, css, deferred: theme < 0 || nodes[theme].hasAttribute('defer') || nodes[theme].hasAttribute('async') };
  });
  assert.ok(scriptOrder.theme >= 0 && scriptOrder.theme < scriptOrder.css && !scriptOrder.deferred, 'Theme initialization must run synchronously before the stylesheet');
  await page.locator('#theme-choice [data-theme-choice="light"]').click();
  await assertTheme(page, 'light', 'light');
  await page.reload();
  await assertTheme(page, 'light', 'light');
  await page.locator('#theme-choice [data-theme-choice="system"]').click();
  await assertTheme(page, 'dark', 'system');
  await context.close();
});
