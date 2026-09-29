const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.join(__dirname, '..');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = process.env.TEST_URL || `http://127.0.0.1:${server.address().port}`;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
    async function device(name, width) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
      await context.addInitScript(() => {
        const NativeRTC = window.RTCPeerConnection;
        window.testConnections = [];
        window.RTCPeerConnection = class extends NativeRTC {
          constructor(...args) { super(...args); window.testConnections.push(this); }
        };
      });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      page.on('response', r => { if (r.status() >= 400 && /\.(js|css)(\?|$)/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
      await page.goto(base);
      await page.locator('#device-name').fill(name);
      return page;
    }
    async function text(page, expected) {
      await page.waitForFunction(value => document.getElementById('message').value === value, expected, { timeout: 20000 });
    }
    async function connected(page) {
      await page.locator('#overall-status').filter({ hasText: /^接続中$/ }).waitFor({ timeout: 30000 });
    }
    async function visibleCode(page, code) {
      assert.equal(await page.locator('#room-code').textContent(), code);
      assert.equal(await page.locator('#room-panel').isVisible(), true);
      assert.equal(await page.locator('#qr-code svg').count(), 1);
      const rect = await page.locator('#room-code').boundingBox();
      assert.ok(rect?.width > 100 && rect?.height > 10, 'code has a visible layout box');
    }
    async function request(page, code) {
      await page.locator('#join-code').fill(code);
      await page.locator('#join-btn').click();
    }
    const host = await device('検証ホスト', 1280);
    // Simulate a browser retaining the old unversioned script. It must never be requested.
    let staleRequests = 0;
    await host.route('**/app.js', route => { staleRequests++; return route.fulfill({ contentType: 'text/javascript', body: 'throw Error("old cached app was loaded")' }); });
    await host.reload();
    await host.locator('#device-name').fill('検証ホスト');
    await host.locator('#host-btn').click();
    const code = await host.locator('#room-code').textContent();
    assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
    assert.equal(staleRequests, 0, 'versioned app bypasses old cached URL');
    await visibleCode(host, code);
    for (const width of [1280, 390, 320]) {
      await host.setViewportSize({ width, height: 844 });
      await host.locator('#room-panel').scrollIntoViewIfNeeded();
      await visibleCode(host, code);
      assert.equal(await host.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await host.bringToFront();
    await host.locator('#copy-code-btn').click();
    assert.equal(await host.evaluate(() => navigator.clipboard.readText()), code);
    assert.equal(await host.locator('.history-item').count(), 0);
    console.log('PASS: code and QR, code copy, 320/390/1280px layout, stale asset URL bypass');

    const a = await device('検証端末A', 390);
    await request(a, 'INVALID');
    assert.equal(await a.locator('#setup-panel').isVisible(), true);
    await request(a, code);
    await host.locator('#requests-card[open]').waitFor({ timeout: 45000 });
    assert.equal(await host.locator('#requests-card').getByText('検証端末A', { exact: true }).count(), 1);
    await host.bringToFront(); await host.keyboard.press('Escape');
    assert.equal(await host.locator('#requests-card').evaluate(el => el.open), true);
    assert.equal(await host.locator('#requests-card').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await host.getByRole('button', { name: '拒否', exact: true }).click();
    await a.locator('#setup-panel').waitFor();
    assert.equal(await host.locator('#requests-card').evaluate(el => el.open), false);
    await visibleCode(host, code);
    await request(a, code);
    await host.getByRole('button', { name: '承認', exact: true }).click({ timeout: 45000 });
    await connected(a);
    await visibleCode(host, code);
    console.log('PASS: invalid code, named popup, explicit rejection and approval, code retained');

    const b = await device('検証端末B', 390);
    await request(b, code);
    await host.getByRole('button', { name: '承認', exact: true }).click({ timeout: 45000 });
    await connected(b);
    await a.locator('#message').fill('Aから日本語 👩‍💻\n改行');
    await text(host, 'Aから日本語 👩‍💻\n改行'); await text(b, 'Aから日本語 👩‍💻\n改行');
    assert.equal(await b.locator('.history-item').count(), 0);
    await host.locator('#message').fill('ホストから全端末');
    await text(a, 'ホストから全端末'); await text(b, 'ホストから全端末');
    await b.locator('#message').fill(''); await text(host, ''); await text(a, '');
    await b.locator('#message').fill(' '.repeat(3)); await text(host, ' '.repeat(3)); await text(a, ' '.repeat(3));
    await a.locator('#message').fill('保存した本文'); await text(host, '保存した本文'); await text(b, '保存した本文');
    for (const page of [host, a, b]) {
      await page.bringToFront();
      await page.locator('#copy-btn').click();
      await page.locator('.history-item').waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '保存した本文');
    }
    await a.locator('#message').fill('別の本文'); await text(host, '別の本文');
    await a.getByRole('button', { name: '呼び出し', exact: true }).click(); await text(host, '保存した本文'); await text(b, '保存した本文');
    await b.bringToFront(); await b.evaluate(() => navigator.clipboard.writeText('貼り付け検証'));
    await b.locator('#paste-btn').click(); await text(host, '貼り付け検証'); await text(a, '貼り付け検証');
    await b.locator('#clear-history').click(); assert.equal(await b.locator('.history-item').count(), 0);
    console.log('PASS: three-device bidirectional/empty/Unicode sync, clipboard on all devices, recall, paste, clear');

    await a.evaluate(() => { for (const rtc of window.testConnections) rtc.close(); });
    await a.locator('#message').fill('接続断の間に編集');
    await connected(a); await text(host, '接続断の間に編集'); await text(b, '接続断の間に編集');
    assert.equal(await host.locator('#requests-card').evaluate(el => el.open), false);
    await a.context().setOffline(true);
    await a.locator('#message').fill('ネット復帰の編集');
    await a.context().setOffline(false);
    await connected(a); await text(host, 'ネット復帰の編集');
    await a.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await a.locator('#message').fill('ページ復帰の編集'); await text(host, 'ページ復帰の編集');
    await visibleCode(host, code);
    assert.equal(await host.locator('#requests-card').evaluate(el => el.open), false);
    console.log('PASS: actual RTC close, offline/online, pageshow, edits restored without reapproval');

    await a.locator('#leave-btn').click();
    await a.locator('#setup-panel').waitFor();
    await b.locator('#leave-btn').click();
    await host.locator('#leave-btn').click();
    assert.equal(await host.locator('#room-panel').isVisible(), false);
    await host.locator('#host-btn').click();
    const nextCode = await host.locator('#room-code').textContent();
    assert.notEqual(nextCode, code); await visibleCode(host, nextCode);
    await host.locator('#leave-btn').click();
    assert.deepEqual(errors, []);
    console.log('PASS: leave/recreate room, no browser errors or missing JS/CSS');
  } finally { await browser?.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
