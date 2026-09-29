const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');

function harness() {
  let now = 100000, sequence = 0;
  const timers = new Map(), registry = new Map(), messages = [], apps = [];
  function timer(fn, delay, interval = false) {
    const id = ++sequence; timers.set(id, { fn, at: now + delay, delay, interval }); return id;
  }
  function tick(ms = 0) {
    const until = now + ms;
    let count = 0;
    while (true) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      if (++count > 10000) throw Error('timer loop');
      const [id, t] = due; now = t.at;
      if (t.interval) t.at += t.delay; else timers.delete(id);
      t.fn();
    }
    now = until;
  }
  class Element {
    constructor() { this.value = ''; this.children = []; this.events = {}; this.hidden = false; }
    addEventListener(e, cb) { (this.events[e] ||= []).push(cb); }
    fire(e) { for (const cb of this.events[e] || []) cb({}); }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    showModal() { this.open = true; } close() { this.open = false; }
    scrollIntoView() {}
    focus() {} select() { this.selected = true; }
  }
  class Connection extends EventEmitter {
    constructor(id, metadata) {
      super(); this.peer = id; this.metadata = metadata; this.open = false;
      const events = {};
      this.peerConnection = {
        connectionState: 'connected', iceConnectionState: 'connected',
        addEventListener: (e, cb) => { (events[e] ||= new Set()).add(cb); },
        removeEventListener: (e, cb) => events[e]?.delete(cb),
        fire: e => { for (const cb of [...events[e] || []]) cb(); }
      };
    }
    send(data) {
      if (!this.open) throw Error('closed');
      messages.push({ connection: this, data: structuredClone(data) });
      timer(() => { if (this.other?.open) this.other.emit('data', structuredClone(data)); }, 0);
    }
    close() {
      if (this.closed) return;
      this.closed = true; this.open = false; this.emit('close'); this.other?.close();
    }
  }
  class Peer extends EventEmitter {
    constructor(id = `guest-${++sequence}`) {
      super(); this.id = id; this.connections = []; this.open = false; this.destroyed = false;
      registry.set(id, this);
      timer(() => { if (!this.destroyed) { this.open = true; this.emit('open', id); } }, 0);
    }
    connect(id, options) {
      const a = new Connection(id, options.metadata); this.connections.push(a);
      timer(() => {
        const target = registry.get(id);
        if (!target?.open) { this.emit('error', { type: 'peer-unavailable' }); return; }
        const b = new Connection(this.id, options.metadata); target.connections.push(b);
        a.other = b; b.other = a; target.emit('connection', b);
        if (a.closed || b.closed) return;
        a.open = b.open = true; b.emit('open'); a.emit('open');
      }, 0);
      return a;
    }
    reconnect() { this.disconnected = false; timer(() => { this.open = true; this.emit('open', this.id); }, 0); }
    destroy() {
      this.destroyed = true; this.open = false;
      if (registry.get(this.id) === this) registry.delete(this.id);
      for (const c of this.connections) c.close();
      this.emit('close');
    }
  }
  function app() {
    const elements = {}, win = new Element(), doc = new Element();
    doc.getElementById = id => elements[id] ||= new Element();
    doc.createElement = () => new Element(); doc.visibilityState = 'visible';
    win.Peer = Peer; win.qrcode = () => ({ addData() {}, make() {}, createSvgTag: () => '<svg/>' });
    win.isSecureContext = true; win.history = { replaceState() {} };
    const clipboard = { value: '', async writeText(text) { this.value = text; }, async readText() { return this.value; } };
    const navigator = { onLine: true, userAgent: 'test', clipboard };
    const context = {
      window: win, document: doc, navigator, Peer, qrcode: win.qrcode,
      TextEncoder, URL, URLSearchParams, Uint8Array, console,
      crypto: { randomUUID: () => `uuid-${++sequence}`, getRandomValues(a) { a.fill(sequence++ % 32); return a; } },
      Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
      Math: Object.assign(Object.create(Math), { random: () => 0 }),
      localStorage: { getItem() { return null; }, setItem() {} },
      location: { href: 'https://example.com/', hash: '', pathname: '/', search: '' },
      setTimeout: (f, d) => timer(f, d), clearTimeout: id => timers.delete(id), setInterval: (f, d) => timer(f, d, true)
    };
    vm.runInNewContext(source, context);
    const result = { elements, win, doc, navigator, clipboard, context,
      click: id => elements[id].fire('click'),
      edit: text => { elements.message.value = text; elements.message.fire('input'); },
      text: () => elements.message.value,
      history: () => elements.history.children.filter(x => x.className === 'history-item'),
      peer: () => [...registry.values()].find(p => p.id === result.id)
    };
    apps.push(result); return result;
  }
  function host() { const a = app(); a.click('host-btn'); tick(); a.id = 'clip-sync-v1-' + a.elements['room-code'].textContent; return a; }
  function join(h, approve = true) {
    const a = app(); a.elements['join-code'].value = h.elements['room-code'].textContent;
    const before = new Set(registry.keys()); a.click('join-btn'); tick(); a.id = [...registry.keys()].find(id => !before.has(id));
    if (approve) { h.elements.requests.children.at(-1).children[2].children[0].onclick(); tick(); }
    return a;
  }
  return { app, host, join, tick, registry, messages };
}

test('500ms automatic sync, three peers, no echo or steady duplicate; empty text syncs', () => {
  const h = harness(), host = h.host(), a = h.join(host), b = h.join(host);
  h.tick(500); h.messages.length = 0;
  a.edit('hello'); h.tick(499); assert.equal(host.text(), ''); h.tick(1);
  assert.equal(host.text(), 'hello'); assert.equal(b.text(), 'hello');
  const clips = () => h.messages.filter(m => m.data.type === 'clip');
  assert.equal(clips().length, 2); h.tick(10000); assert.equal(clips().length, 2);
  assert.equal(host.history().length, 0); assert.equal(a.history().length, 0);
  b.edit(''); h.tick(500); assert.equal(host.text(), ''); assert.equal(a.text(), '');
});

test('simultaneous edits deterministically converge without a loop', () => {
  const h = harness(), host = h.host(), a = h.join(host), b = h.join(host);
  host.edit('host'); a.edit('a'); b.edit('b'); h.tick(1500);
  assert.equal(a.text(), host.text()); assert.equal(b.text(), host.text());
  const count = h.messages.length; h.tick(3000); assert.equal(h.messages.length, count);
});

test('ICE loss reconnects without reapproval and keeps offline edits', () => {
  const h = harness(), host = h.host(), a = h.join(host);
  host.edit('old'); h.tick(500);
  const old = a.peer().connections[0]; old.peerConnection.iceConnectionState = 'failed'; old.peerConnection.fire('iceconnectionstatechange');
  assert.match(a.elements.toast.textContent, /再接続中/);
  a.edit('offline edit'); h.tick(2000);
  assert.equal(host.text(), 'offline edit'); assert.equal(a.text(), 'offline edit');
  assert.equal(host.elements.requests.children.length, 0);
  assert.equal(a.elements.toast.textContent, '再接続しました');
  old.emit('close'); assert.equal(a.elements['overall-status'].textContent, '接続中');
});

test('offline pauses retries; online and pageshow restore transport', () => {
  const h = harness(), host = h.host(), a = h.join(host);
  a.navigator.onLine = false; a.win.fire('offline');
  const count = a.peer().connections.length; h.tick(60000);
  assert.equal(a.peer().connections.length, count);
  host.edit('latest'); h.tick(500); a.navigator.onLine = true; a.win.fire('online'); h.tick();
  assert.equal(a.text(), 'latest');
  a.peer().connections.at(-1).close(); a.win.fire('pageshow'); h.tick();
  assert.equal(a.elements['overall-status'].textContent, '接続中');
});

test('foreground after suspension checks stale channels and resynchronizes', () => {
  const h = harness(), host = h.host(), a = h.join(host);
  host.doc.visibilityState = a.doc.visibilityState = 'hidden'; h.tick(40000);
  host.edit('background draft');
  host.doc.visibilityState = a.doc.visibilityState = 'visible';
  host.doc.fire('visibilitychange'); a.doc.fire('visibilitychange'); h.tick(2000);
  assert.equal(a.text(), 'background draft'); assert.equal(host.elements.requests.children.length, 0);
});

test('copy succeeds on either device, failure and code copy do not record; recall syncs', async () => {
  const h = harness(), host = h.host(), a = h.join(host);
  a.edit('saved'); h.tick(500);
  host.click('copy-btn'); a.click('copy-btn'); await new Promise(setImmediate);
  assert.equal(host.clipboard.value, 'saved'); assert.equal(a.history().length, 1);
  assert.equal(host.history().length, 1);
  host.click('copy-code-btn'); await new Promise(setImmediate); assert.equal(host.history().length, 1);
  a.clipboard.writeText = async () => { throw Error('denied'); };
  a.click('copy-btn'); await new Promise(setImmediate); assert.equal(a.history().length, 1); assert.equal(a.elements.message.selected, true);
  a.edit('other'); h.tick(500);
  const recall = a.history()[0].children[2]; assert.equal(recall.textContent, '呼び出し'); recall.onclick(); h.tick(500);
  assert.equal(host.text(), 'saved');
});

test('rejection stops reconnecting and unknown guests require approval', () => {
  const h = harness(), host = h.host(), a = h.join(host, false);
  a.edit('unauthorized'); h.tick(500); assert.equal(host.text(), '');
  host.elements.requests.children[0].children[2].children[1].onclick(); h.tick(60000);
  assert.equal(a.elements['overall-status'].textContent, '未接続');
});

test('oversized text is not sent; IME text is preserved until composition ends', () => {
  const h = harness(), host = h.host(), a = h.join(host);
  a.edit('あ'.repeat(6000)); h.tick(500); assert.equal(host.text(), '');
  a.edit('valid'); h.tick(500); assert.equal(host.text(), 'valid');
  a.elements.message.fire('compositionstart'); a.edit('編集中'); host.edit('remote'); h.tick(500);
  assert.equal(a.text(), '編集中');
  a.elements.message.fire('compositionend'); h.tick(500); assert.equal(host.text(), '編集中');
});

test('host Peer recreation retains room and resume credentials', () => {
  const h = harness(), host = h.host(), a = h.join(host);
  const room = host.elements['room-code'].textContent; host.peer().destroy(); h.tick(30000);
  assert.equal(host.elements['room-code'].textContent, room);
  assert.equal(a.elements['overall-status'].textContent, '接続中');
  assert.equal(host.elements.requests.children.length, 0);
});

test('failed connection attempts back off and explicit leave cancels all retries', () => {
  const h = harness(), host = h.host();
  const code = host.elements['room-code'].textContent; host.click('leave-btn');
  const a = h.app(); a.elements['join-code'].value = code; a.click('join-btn'); h.tick();
  const peer = [...h.registry.values()][0];
  assert.equal(peer.connections.length, 1); h.tick(19000); assert.equal(peer.connections.length, 1);
  h.tick(15000); assert.ok(peer.connections.length >= 2); assert.ok(peer.connections.length <= 3);
  a.click('leave-btn'); h.tick(120000); assert.equal(h.registry.size, 0);
  assert.equal(a.elements['overall-status'].textContent, '未接続');
});

test('copy records the captured text even if synchronized content changes before promise resolves', async () => {
  const h = harness(), host = h.host(); let done;
  host.clipboard.writeText = () => new Promise(resolve => { done = resolve; });
  host.edit('copied snapshot'); host.click('copy-btn'); host.edit('new draft'); done();
  await new Promise(setImmediate);
  assert.equal(host.history()[0].children[1].children[1].textContent, 'copied snapshot');
});

test('approval pending stays alive without repeated requests; signaling reconnect keeps channels', () => {
  const h = harness(), host = h.host(), a = h.join(host, false);
  h.tick(120000); assert.equal(host.elements.requests.children.length, 1);
  host.elements.requests.children[0].children[2].children[0].onclick(); h.tick();
  host.peer().open = false; host.peer().disconnected = true; host.peer().emit('disconnected'); h.tick(2000);
  a.edit('after signaling recovery'); h.tick(500); assert.equal(host.text(), 'after signaling recovery');
  assert.equal(host.elements['overall-status'].textContent, '1 台と接続中');
});


test('room code is visible at creation, during approval, after reconnect; QR failure is isolated', () => {
  const h = harness(), host = h.host();
  const code = host.elements['room-code'].textContent;
  assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(host.elements['room-panel'].hidden, false);
  const guest = h.join(host, false);
  assert.equal(host.elements['requests-card'].open, true);
  assert.equal(host.elements['room-code'].textContent, code);
  host.elements.requests.children[0].children[2].children[1].onclick(); h.tick(500);
  assert.equal(host.elements['requests-card'].open, false);
  assert.equal(host.elements['room-code'].textContent, code);
  host.click('leave-btn');
  assert.equal(host.elements['room-panel'].hidden, true);
  host.win.qrcode = undefined;
  host.context.qrcode = undefined;
  host.click('host-btn'); h.tick();
  assert.equal(host.elements['room-panel'].hidden, false);
  assert.match(host.elements['room-code'].textContent, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.match(host.elements['qr-code'].textContent, /QRコードを表示できません/);
});

test('HTML asset URLs change whenever app or CSS contents change', () => {
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const file of ['app.js', 'styles.css']) {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 12);
    assert.ok(html.includes(`${file}?v=${hash}`), `${file} cache version must match contents`);
  }
});
