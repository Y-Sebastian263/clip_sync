const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.join(__dirname, "..");
  const server = http.createServer((req, res) => {
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url);
    try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || undefined});
    const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']});
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#message').fill('ブラウザ検証');
    await page.locator('#copy-btn').click();
    await page.getByRole('button', {name:'呼び出し', exact:true}).waitFor();
    await page.locator('#message').fill('変更');
    await page.getByRole('button', {name:'呼び出し', exact:true}).click();
    if (await page.locator('#message').inputValue() !== 'ブラウザ検証') throw Error('recall failed');
    if (await page.locator('#send-btn').count()) throw Error('send button remains');
    await page.locator('#host-btn').click();
    const code = await page.locator('#room-code').textContent();
    const guest = await context.newPage();
    guest.on('pageerror', e => errors.push(e.message));
    await guest.goto(`http://127.0.0.1:${server.address().port}`);
    await guest.locator('#join-code').fill(code);
    await guest.locator('#join-btn').click();
    await page.locator('#requests-card[open]').waitFor({timeout:45000});
    await page.keyboard.press('Escape');
    if (!await page.locator('#requests-card').evaluate(el => el.open)) throw Error('approval dismissed without a decision');
    await page.getByRole('button', {name:'承認', exact:true}).click();
    if (await page.locator('#requests-card').evaluate(el => el.open)) throw Error('approval dialog stayed open');
    await guest.locator('#overall-status').filter({hasText: /^接続中$/}).waitFor({timeout:20000});
    await guest.locator('#message').fill('real WebRTC guest to host');
    await page.waitForFunction(() => document.getElementById('message').value === 'real WebRTC guest to host');
    await page.locator('#message').fill('real WebRTC host to guest');
    await guest.waitForFunction(() => document.getElementById('message').value === 'real WebRTC host to guest');
    await guest.evaluate(() => dispatchEvent(new Event('offline')));
    await guest.locator('#message').fill('edited while reconnecting');
    await guest.evaluate(() => dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.getElementById('message').value === 'edited while reconnecting', null, {timeout:20000});
    if (await page.getByRole('button', {name:'承認', exact:true}).count()) throw Error('reapproval required');
    console.log('Real PeerJS/WebRTC: bidirectional sync and event-triggered reconnect PASS');
    for (const width of [1280, 390]) {
      await page.setViewportSize({width, height:844});
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(`overflow ${width}`);
    }
    if (errors.length) throw Error(errors.join('\n'));
    console.log('Chromium: copy, history, recall, no send button, desktop/mobile widths, no runtime errors PASS');
  } finally { await browser?.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
