/* Clip Sync: session-only text sharing over PeerJS/WebRTC DataChannels. */
(() => {
  "use strict";

  const MAX_BYTES = 16 * 1024;
  const MAX_HISTORY = 50;
  const ROOM_PREFIX = "clip-sync-v1-";
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "overall-status", "message", "text-count", "paste-btn", "copy-btn",
    "device-name", "setup-panel", "host-btn", "join-code", "join-btn", "room-panel",
    "room-code", "copy-code-btn", "qr-code", "guest-panel", "guest-message", "leave-btn",
    "requests-card", "requests", "devices", "device-count", "history", "clear-history", "toast"
  ].map((id) => [id, $(id)]));

  let peer = null;
  let role = null;
  let roomCode = "";
  let hostConnection = null;
  let approved = false;
  let peers = new Map();
  let pending = new Map();
  let roster = [];
  let history = [];
  let toastTimer;
  let retryTimer;
  let retryAttempt = 0;
  let peerStarted = 0;
  let everConnected = false;
  let recovering = false;
  let resumeToken = "";
  const trusted = new Map();
  const links = new Map();
  const clientId = crypto.randomUUID();
  let state = { text: "", clock: 0, author: "" };
  let deferredState = null;
  let composing = false;
  let oversized = false;

  const encoder = new TextEncoder();
  const name = () => ui["device-name"].value.trim().slice(0, 32) || "名前のない端末";
  const shortCode = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (n) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[n % 32]).join("");
  const validCode = (code) => /^[A-HJ-NP-Z2-9]{10}$/.test(code);
  const safeText = (value) => typeof value === "string" && encoder.encode(value).length <= MAX_BYTES;

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 4200);
  }

  function setStatus(label, kind = "") {
    ui["overall-status"].textContent = label;
    ui["overall-status"].className = `status-pill ${kind}`;
  }

  function updateControls() {
    ui["copy-btn"].disabled = !ui.message.value;
    ui["text-count"].textContent = `${ui.message.value.length.toLocaleString()} 文字`;
  }

  function updateStatus() {
    if (!role) setStatus("未接続");
    else if (recovering) setStatus("再接続中…", "waiting");
    else if (role === "host") setStatus(peers.size ? `${peers.size} 台と接続中` : "参加を待機中", peers.size ? "connected" : "waiting");
    else setStatus(approved ? "接続中" : "接続待ち", approved ? "connected" : "waiting");
    updateControls();
  }

  function saveName() {
    try { localStorage.setItem("clip-sync-name", name()); } catch { /* private mode */ }
  }

  function setupMode(mode) {
    role = mode;
    ui["setup-panel"].hidden = !!mode;
    ui["room-panel"].hidden = mode !== "host";
    ui["guest-panel"].hidden = mode !== "guest";
    ui["leave-btn"].hidden = !mode;
    ui["device-name"].disabled = !!mode;
    updateStatus();
  }

  function leave(message) {
    role = null; // Invalidate callbacks before closing transports.
    clearTimeout(retryTimer);
    retryTimer = null;
    const old = peer;
    peer = null;
    for (const connection of [...links.keys()]) dropLink(connection, false);
    old?.destroy();
    hostConnection = null;
    peers.clear(); pending.clear(); trusted.clear();
    roster = []; roomCode = ""; approved = false;
    everConnected = false; recovering = false; resumeToken = ""; retryAttempt = 0;
    ui["qr-code"].replaceChildren();
    setupMode(null);
    renderRequests(); renderDevices();
    if (message) showToast(message);
  }

  function markDisconnected() {
    if (!role) return;
    if (!recovering) showToast("接続が切れました。再接続中…");
    recovering = true;
    updateStatus();
  }

  function scheduleRecovery(immediate = false) {
    if (!role || navigator.onLine === false) return;
    if (retryTimer && !immediate) return;
    clearTimeout(retryTimer);
    const delay = immediate ? 0 : Math.min(30000, 1000 * 2 ** Math.min(retryAttempt++, 5)) + Math.random() * 500;
    retryTimer = setTimeout(() => { retryTimer = null; recover(); }, delay);
  }

  function recover() {
    if (!role || navigator.onLine === false) return;
    if (!peer || peer.destroyed || (!peer.open && Date.now() - peerStarted > 20000)) {
      createPeer();
    } else if (peer.disconnected) {
      peerStarted = Date.now();
      try { peer.reconnect(); } catch { /* retry with backoff */ }
    } else if (peer.open && role === "guest" && !hostConnection) {
      connectHost();
    }
    if (!peer?.open || (role === "guest" && !hostConnection?.open)) scheduleRecovery();
  }

  function createPeer() {
    const old = peer;
    peer = null;
    for (const connection of [...links.keys()]) dropLink(connection);
    old?.destroy();
    peerStarted = Date.now();
    try {
      const instance = role === "host" ? new Peer(ROOM_PREFIX + roomCode) : new Peer();
      peer = instance;
      instance.on("open", () => {
        if (peer !== instance || !role) return;
        clearTimeout(retryTimer); retryTimer = null;
        if (role === "guest") connectHost();
        else {
          if (peers.size === trusted.size) {
            if (recovering && everConnected) showToast("再接続しました");
            recovering = false; retryAttempt = 0;
          }
          updateStatus();
        }
      });
      instance.on("connection", (connection) => {
        if (peer !== instance) { connection.close(); return; }
        incomingConnection(connection);
      });
      const failed = () => {
        if (peer !== instance || !role) return;
        markDisconnected(); scheduleRecovery();
      };
      instance.on("disconnected", failed);
      instance.on("close", failed);
      instance.on("error", (error) => {
        if (peer !== instance || !role) return;
        if (["browser-incompatible", "invalid-id", "invalid-key", "ssl-unavailable"].includes(error?.type)) {
          leave("このブラウザまたは接続設定では接続できません。"); return;
        }
        failed();
      });
      scheduleRecovery(); // Also covers a signaling connection that never opens.
    } catch { markDisconnected(); scheduleRecovery(); }
  }

  function send(connection, data) {
    if (!connection?.open || !links.has(connection)) return false;
    try { connection.send(data); return true; }
    catch { dropLink(connection); return false; }
  }

  function watchLink(connection) {
    const link = { started: Date.now(), lastSeen: Date.now(), lastPing: 0, sent: null };
    links.set(connection, link);
    const failed = () => dropLink(connection);
    connection.on("close", failed);
    connection.on("error", failed);
    // addEventListener preserves PeerJS's own ICE handlers.
    const rtc = connection.peerConnection;
    const check = () => {
      if (["disconnected", "failed", "closed"].includes(rtc?.connectionState) ||
          ["disconnected", "failed", "closed"].includes(rtc?.iceConnectionState)) failed();
    };
    rtc?.addEventListener("connectionstatechange", check);
    rtc?.addEventListener("iceconnectionstatechange", check);
    link.cleanup = () => {
      rtc?.removeEventListener("connectionstatechange", check);
      rtc?.removeEventListener("iceconnectionstatechange", check);
    };
    connection.on("data", (data) => {
      if (!links.has(connection)) return;
      link.lastSeen = Date.now();
      if (data?.type === "ping") send(connection, { type: "pong" });
    });
  }

  function dropLink(connection, retry = true) {
    const link = links.get(connection);
    if (!link) return;
    links.delete(connection); link.cleanup();
    const accepted = peers.get(connection.peer)?.connection === connection;
    if (accepted) peers.delete(connection.peer);
    if (pending.get(connection.peer)?.connection === connection) pending.delete(connection.peer);
    if (hostConnection === connection) { hostConnection = null; approved = false; roster = []; }
    connection.close();
    if (!role) return;
    renderRequests(); renderDevices();
    if (retry && (accepted || role === "guest")) markDisconnected();
    if (role === "host") broadcastRoster();
    if (retry) scheduleRecovery();
    updateStatus();
  }

  function connectHost() {
    if (role !== "guest" || hostConnection || !peer?.open) return;
    try {
      hostConnection = peer.connect(ROOM_PREFIX + roomCode, {
        reliable: true, metadata: { name: name(), resumeToken }
      });
      attachGuestConnection(hostConnection);
    } catch { markDisconnected(); scheduleRecovery(); }
  }

  function renderQr() {
    const url = new URL(location.href);
    url.hash = `join=${roomCode}`;
    try {
      const code = qrcode(0, "M");
      code.addData(url.href);
      code.make();
      ui["qr-code"].innerHTML = code.createSvgTag({ cellSize: 4, margin: 0 });
    } catch {
      ui["qr-code"].textContent = "QRコードを表示できません。接続コードを入力してください。";
    }
  }

  function startHost() {
    if (role) return;
    if (!window.isSecureContext) {
      showToast("HTTPS対応のブラウザで開いてください。"); return;
    }
    if (!window.Peer) {
      showToast("接続機能を読み込めませんでした。ページを再読み込みしてください。"); return;
    }
    saveName();
    roomCode = shortCode();
    ui["room-code"].textContent = roomCode;
    renderQr();
    setupMode("host");
    ui["room-panel"].scrollIntoView({ block: "nearest" });
    createPeer();
  }

  function startGuest() {
    if (role) return;
    if (!window.Peer || !window.isSecureContext) {
      showToast("HTTPS対応のブラウザで開いてください。"); return;
    }
    const code = ui["join-code"].value.toUpperCase().replace(/[\s-]/g, "");
    if (!validCode(code)) { showToast("10文字の接続コードを入力してください。"); return; }
    saveName();
    roomCode = code;
    setupMode("guest");
    ui["guest-message"].textContent = "接続先を探しています…";
    createPeer();
  }

  function attachGuestConnection(connection) {
    watchLink(connection);
    connection.on("open", () => {
      if (hostConnection !== connection) return;
      ui["guest-message"].textContent = "ホスト端末の承認を待っています…";
      updateStatus();
    });
    connection.on("data", (data) => {
      if (hostConnection !== connection || !links.has(connection) || !data || typeof data !== "object") return;
      if (data.type === "rejected" || data.type === "ended") {
        leave(data.type === "rejected" ? "接続リクエストが拒否されました。" : "ホストが接続を終了しました。");
      } else if (data.type === "welcome" && !approved) {
        resumeToken = typeof data.resumeToken === "string" ? data.resumeToken : "";
        approved = true;
        recovering = false; retryAttempt = 0;
        clearTimeout(retryTimer); retryTimer = null;
        showToast(everConnected ? "再接続しました" : `${String(data.name || "ホスト").slice(0, 32)}が接続しました`);
        everConnected = true;
        ui["guest-message"].textContent = "接続しました。テキストは0.5秒ごとに自動同期します。";
        acknowledgeState(connection, data.state);
        receiveState(data.state);
        syncText();
        updateStatus();
      } else if (approved && data.type === "roster" && Array.isArray(data.devices)) {
        const previous = new Set(roster.map((item) => item.id));
        const next = data.devices.filter((item) => item && typeof item.name === "string" && typeof item.id === "string").slice(0, 20);
        for (const item of next) {
          if (!item.host && item.id !== peer?.id && !previous.has(item.id)) showToast(`${item.name.slice(0, 32)}が接続しました`);
        }
        roster = next;
        renderDevices();
      } else if (approved && data.type === "clip") {
        acknowledgeState(connection, data.state);
        receiveState(data.state);
      } else if (approved && data.type === "sync") {
        sendState(connection, true);
      }
    });
  }

  function incomingConnection(connection) {
    if (role !== "host") { connection.close(); return; }
    watchLink(connection);
    const requestName = String(connection.metadata?.name || "名前のない端末").slice(0, 32);
    connection.on("open", () => {
      if (!links.has(connection) || role !== "host") return;
      const token = connection.metadata?.resumeToken;
      const known = typeof token === "string" ? trusted.get(token) : null;
      const request = { connection, name: known?.name || requestName, token: known ? token : null };
      pending.set(connection.peer, request);
      if (known) acceptRequest(connection.peer);
      else { renderRequests(); showToast(`${requestName} から接続リクエストが届きました。`); }
    });
    connection.on("data", (data) => {
      if (peers.get(connection.peer)?.connection !== connection || !links.has(connection) || !data) return;
      if (data.type === "clip") {
        acknowledgeState(connection, data.state);
        receiveState(data.state);
        // Echo only a newer winning revision, never the received revision itself.
        syncText();
      } else if (data.type === "sync") sendState(connection, true);
    });
  }

  function acceptRequest(id) {
    const request = pending.get(id);
    if (!request || !request.connection.open) return;
    pending.delete(id);
    const resumed = !!request.token;
    if (resumed) {
      for (const item of [...peers.values()]) {
        if (item.token === request.token) dropLink(item.connection, false);
      }
    } else request.token = crypto.randomUUID();
    trusted.set(request.token, { name: request.name });
    peers.set(id, request);
    captureEdit();
    send(request.connection, { type: "welcome", name: name(), resumeToken: request.token, state });
    if (links.has(request.connection)) links.get(request.connection).sent = { ...state };
    recovering = peers.size < trusted.size;
    retryAttempt = 0; everConnected = true;
    showToast(resumed ? "再接続しました" : `${request.name}が接続しました`);
    renderRequests(); broadcastRoster(); updateStatus();
  }

  function rejectRequest(id) {
    const request = pending.get(id);
    if (!request) return;
    send(request.connection, { type: "rejected" });
    // Allow the reliable channel to deliver the rejection before closing.
    pending.delete(id);
    setTimeout(() => dropLink(request.connection, false), 500);
    renderRequests();
  }

  function broadcastRoster() {
    if (!peer || role !== "host") return;
    const devices = [{ id: peer.id, name: name(), host: true }, ...Array.from(peers, ([id, item]) => ({ id, name: item.name, host: false }))];
    for (const item of peers.values()) send(item.connection, { type: "roster", devices });
    renderDevices();
  }

  function renderRequests() {
    ui.requests.replaceChildren();

    for (const [id, item] of pending) {
      const li = document.createElement("li");
      li.className = "device-row";
      const avatar = document.createElement("span"); avatar.className = "device-avatar"; avatar.textContent = "?";
      const info = document.createElement("span"); info.className = "device-info";
      const label = document.createElement("strong"); label.textContent = item.name; info.append(label);
      const actions = document.createElement("span"); actions.className = "request-actions";
      const accept = document.createElement("button"); accept.className = "button button-primary"; accept.textContent = "承認"; accept.onclick = () => acceptRequest(id);
      const reject = document.createElement("button"); reject.className = "button button-outline"; reject.textContent = "拒否"; reject.onclick = () => rejectRequest(id);
      reject.autofocus = true;
      actions.append(accept, reject); li.append(avatar, info, actions); ui.requests.append(li);
    }
    const dialog = ui["requests-card"];
    if (pending.size && !dialog.open) dialog.showModal();
    else if (!pending.size && dialog.open) dialog.close();
  }

  function renderDevices() {
    ui.devices.replaceChildren();
    const devices = role === "host" ? Array.from(peers.values(), ({ name: deviceName }) => ({ name: deviceName, label: "接続中" }))
      : approved ? roster.filter((item) => item.id !== peer?.id).map((item) => ({ name: item.name, label: item.host ? "ホスト" : "ホスト経由" })) : [];
    ui["device-count"].textContent = String(devices.length);
    if (!devices.length) { const li = document.createElement("li"); li.className = "empty-state"; li.textContent = "まだ接続していません。"; ui.devices.append(li); return; }
    for (const item of devices) {
      const li = document.createElement("li"); li.className = "device-row";
      const avatar = document.createElement("span"); avatar.className = "device-avatar"; avatar.textContent = "▣";
      const info = document.createElement("span"); info.className = "device-info";
      const label = document.createElement("strong"); label.textContent = item.name;
      const sub = document.createElement("small"); sub.textContent = item.label;
      info.append(label, sub); li.append(avatar, info); ui.devices.append(li);
    }
  }

  function addHistory(text, direction, source) {
    history.unshift({ text, direction, source, time: new Date() });
    history = history.slice(0, MAX_HISTORY);
    renderHistory();
  }

  function renderHistory() {
    ui.history.replaceChildren();
    if (!history.length) { const li = document.createElement("li"); li.className = "empty-state"; li.textContent = "コピーに成功したテキストがここに表示されます。"; ui.history.append(li); return; }
    for (const item of history) {
      const li = document.createElement("li"); li.className = "history-item";
      const icon = document.createElement("span"); icon.className = "history-icon"; icon.textContent = "⧉";
      const detail = document.createElement("div"); detail.className = "history-detail";
      const meta = document.createElement("div"); meta.className = "history-meta";
      const title = document.createElement("span"); title.textContent = `${item.direction} · ${item.source}`;
      const time = document.createElement("time"); time.textContent = item.time.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
      meta.append(title, time);
      const preview = document.createElement("p"); preview.className = "history-text"; preview.textContent = item.text;
      detail.append(meta, preview);
      const use = document.createElement("button"); use.className = "text-button history-use"; use.textContent = "呼び出し";
      use.onclick = () => { ui.message.value = item.text; captureEdit(); updateControls(); ui.message.focus(); };
      li.append(icon, detail, use); ui.history.append(li);
    }
  }

  function compare(a, b) {
    return a.clock - b.clock || (a.author > b.author ? 1 : a.author < b.author ? -1 : 0);
  }

  function validState(value) {
    return value && safeText(value.text) && Number.isSafeInteger(value.clock) && value.clock >= 0 &&
      value.clock < Number.MAX_SAFE_INTEGER - 1 && typeof value.author === "string" && value.author.length <= 64;
  }

  function acknowledgeState(connection, incoming) {
    if (validState(incoming) && links.has(connection)) links.get(connection).sent = { ...incoming };
  }

  function captureEdit() {
    const text = ui.message.value;
    if (composing) return;
    if (text === state.text) {
      if (deferredState) {
        const incoming = deferredState; deferredState = null; receiveState(incoming);
      }
      return;
    }
    if (!safeText(text)) {
      if (!oversized) showToast("同期できるのは16 KiBまでです。テキストを短くしてください。");
      oversized = true; return;
    }
    oversized = false;
    state = { text, clock: Math.max(Date.now(), state.clock + 1, (deferredState?.clock || 0) + 1), author: clientId };
    deferredState = null;
  }

  function receiveState(incoming) {
    if (!validState(incoming)) return;
    captureEdit();
    if (compare(incoming, state) <= 0) return;
    // Preserve an in-progress IME composition or oversized local draft.
    if (composing || !safeText(ui.message.value)) {
      if (!deferredState || compare(incoming, deferredState) > 0) deferredState = incoming;
      return;
    }
    state = { text: incoming.text, clock: incoming.clock, author: incoming.author };
    ui.message.value = state.text;
    updateControls();
    // Receiving is never a local edit, and does not add a copy-history entry.
  }

  function sendState(connection, force = false) {
    const link = links.get(connection);
    if (!link || !connection.open) return;
    if (!force && link.sent?.text === state.text && compare(link.sent, state) >= 0) return;
    if (send(connection, { type: "clip", state })) link.sent = { ...state };
  }

  function syncText() {
    captureEdit();
    if (composing || !safeText(ui.message.value)) return;
    if (role === "host") {
      for (const item of peers.values()) sendState(item.connection);
    } else if (approved) sendState(hostConnection);
  }

  function resume() {
    if (!role || navigator.onLine === false || document.visibilityState === "hidden") return;
    for (const [connection, link] of [...links]) {
      if (Date.now() - link.lastSeen > 35000) dropLink(connection);
      else if (connection.open) {
        send(connection, { type: "sync" });
        if (role === "host" ? peers.get(connection.peer)?.connection === connection : approved) sendState(connection, true);
      }
    }
    scheduleRecovery(true);
    syncText();
  }

  setInterval(syncText, 500);
  setInterval(() => {
    if (!role || navigator.onLine === false || document.visibilityState === "hidden") return;
    const now = Date.now();
    for (const [connection, link] of [...links]) {
      if ((!connection.open && now - link.started > 20000) || (connection.open && now - link.lastSeen > 35000)) {
        dropLink(connection); continue;
      }
      if (connection.open && now - link.lastPing > 10000) {
        link.lastPing = now; send(connection, { type: "ping" });
      }
    }
  }, 5000);

  async function writeClipboard(text, codeOnly = false) {
    try { await navigator.clipboard.writeText(text); if (!codeOnly) addHistory(text, "コピー", "この端末"); showToast("クリップボードにコピーしました。"); }
    catch {
      if (codeOnly) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ui["room-code"]);
        selection.removeAllRanges();
        selection.addRange(range);
      } else { ui.message.focus(); ui.message.select(); }
      showToast("自動コピーできません。選択した内容を手動でコピーしてください。");
    }
  }

  async function pasteClipboard() {
    try {
      ui.message.value = await navigator.clipboard.readText();
      captureEdit(); updateControls();
      showToast("クリップボードから貼り付けました。");
    } catch { ui.message.focus(); showToast("自動で読み取れません。入力欄を長押しして貼り付けてください。"); }
  }

  // Keep the request visible until an explicit approval or rejection.
  ui["requests-card"].addEventListener("cancel", (event) => event.preventDefault());
  ui["host-btn"].addEventListener("click", startHost);
  ui["join-btn"].addEventListener("click", startGuest);
  ui["join-code"].addEventListener("keydown", (event) => { if (event.key === "Enter") startGuest(); });
  ui["leave-btn"].addEventListener("click", () => leave("接続を終了しました。"));
  ui["paste-btn"].addEventListener("click", pasteClipboard);
  ui["copy-btn"].addEventListener("click", () => writeClipboard(ui.message.value));
  ui["copy-code-btn"].addEventListener("click", () => writeClipboard(roomCode, true));
  ui.message.addEventListener("input", () => { captureEdit(); updateControls(); });
  ui.message.addEventListener("compositionstart", () => { composing = true; });
  ui.message.addEventListener("compositionend", () => { composing = false; captureEdit(); updateControls(); });
  ui["clear-history"].addEventListener("click", () => { history = []; renderHistory(); });
  ui["device-name"].addEventListener("change", saveName);
  window.addEventListener("online", resume);
  window.addEventListener("offline", () => {
    if (!role) return;
    clearTimeout(retryTimer); retryTimer = null;
    markDisconnected();
    for (const connection of [...links.keys()]) dropLink(connection);
  });
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", resume);

  try { ui["device-name"].value = localStorage.getItem("clip-sync-name") || ""; } catch { /* private mode */ }
  if (!ui["device-name"].value) {
    const platform = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "iPhone" : /Android/i.test(navigator.userAgent) ? "Android" : "PC";
    ui["device-name"].value = `${platform}-${shortCode().slice(0, 4)}`;
  }
  const fragment = new URLSearchParams(location.hash.slice(1));
  const invitedCode = (fragment.get("join") || "").toUpperCase();
  if (validCode(invitedCode)) {
    ui["join-code"].value = invitedCode;
    window.history.replaceState(null, "", location.pathname + location.search);
    showToast("接続コードを入力しました。「参加」を押してください。");
  }
  if (!window.isSecureContext) showToast("クリップボードを使うにはHTTPSで開いてください。");
  updateControls();
})();
