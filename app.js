/* Clip Sync: session-only text sharing over PeerJS/WebRTC DataChannels. */
(() => {
  "use strict";

  const MAX_BYTES = 16 * 1024;
  const MAX_HISTORY = 50;
  const ROOM_PREFIX = "clip-sync-v1-";
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "overall-status", "message", "text-count", "paste-btn", "send-btn", "copy-btn",
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
  let connectionTimer;

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
    const connected = role === "host" ? peers.size > 0 : approved && !!hostConnection?.open;
    ui["send-btn"].disabled = !connected || !ui.message.value.trim();
    ui["copy-btn"].disabled = !ui.message.value;
    ui["text-count"].textContent = `${ui.message.value.length.toLocaleString()} 文字`;
  }

  function updateStatus() {
    if (!role) setStatus("未接続");
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
    clearTimeout(connectionTimer);
    if (peer) { peer.destroy(); peer = null; }
    hostConnection = null;
    peers.clear();
    pending.clear();
    roster = [];
    roomCode = "";
    approved = false;
    ui["qr-code"].replaceChildren();
    setupMode(null);
    renderRequests();
    renderDevices();
    if (message) showToast(message);
  }

  function peerFailure(error) {
    const type = error?.type || "";
    if (type === "peer-unavailable") showToast("接続先が見つかりません。コードと相手の画面を確認してください。");
    else if (type === "network" || type === "server-error" || type === "socket-error") showToast("接続仲介サーバーに接続できません。通信状態を確認してください。");
    else showToast("接続エラーが発生しました。もう一度お試しください。");
    if (role === "guest") leave();
    else if (role === "host" && type === "unavailable-id") leave("コードの重複が発生しました。もう一度作成してください。");
  }

  function attachPeerEvents(instance) {
    instance.on("error", peerFailure);
    instance.on("disconnected", () => {
      if (peer !== instance || instance.destroyed) return;
      showToast("接続仲介サーバーとの通信が切れました。再接続しています。");
      try { instance.reconnect(); } catch { /* reconnect may already be running */ }
    });
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
    if (!window.Peer || !window.qrcode || !window.isSecureContext) {
      showToast("HTTPS対応のブラウザで開いてください。"); return;
    }
    saveName();
    roomCode = shortCode();
    setupMode("host");
    ui["room-code"].textContent = roomCode;
    renderQr();
    try {
      peer = new Peer(ROOM_PREFIX + roomCode);
      attachPeerEvents(peer);
      peer.on("open", () => updateStatus());
      peer.on("connection", incomingConnection);
    } catch { leave("接続を開始できませんでした。"); }
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
    try {
      peer = new Peer();
      attachPeerEvents(peer);
      peer.on("open", () => {
        hostConnection = peer.connect(ROOM_PREFIX + code, { reliable: true, metadata: { name: name() } });
        attachGuestConnection(hostConnection);
      });
      connectionTimer = setTimeout(() => {
        if (role === "guest" && !approved) leave("接続がタイムアウトしました。もう一度お試しください。");
      }, 45000);
    } catch { leave("接続を開始できませんでした。"); }
  }

  function attachGuestConnection(connection) {
    connection.on("open", () => {
      ui["guest-message"].textContent = "ホスト端末の承認を待っています…";
      updateStatus();
    });
    connection.on("data", (data) => {
      if (!data || typeof data !== "object") return;
      if (data.type === "welcome") {
        clearTimeout(connectionTimer);
        approved = true;
        ui["guest-message"].textContent = "接続しました。テキストを送信できます。";
        updateStatus();
      } else if (approved && data.type === "roster" && Array.isArray(data.devices)) {
        roster = data.devices.filter((item) => item && typeof item.name === "string" && typeof item.id === "string").slice(0, 20);
        renderDevices();
      } else if (approved && data.type === "clip" && safeText(data.text)) {
        receiveText(data.text, String(data.from || "別の端末").slice(0, 32));
      }
    });
    connection.on("close", () => { if (role === "guest") leave("接続が終了しました。"); });
    connection.on("error", () => { if (role === "guest") leave("端末間の接続に失敗しました。"); });
  }

  function incomingConnection(connection) {
    if (role !== "host") { connection.close(); return; }
    const requestName = String(connection.metadata?.name || "名前のない端末").slice(0, 32);
    connection.on("open", () => {
      pending.set(connection.peer, { connection, name: requestName });
      renderRequests();
      showToast(`${requestName} から接続リクエストが届きました。`);
    });
    connection.on("data", (data) => {
      if (!peers.has(connection.peer) || !data || data.type !== "clip" || !safeText(data.text)) return;
      const sender = peers.get(connection.peer).name;
      receiveText(data.text, sender);
      for (const [id, item] of peers) {
        if (id !== connection.peer && item.connection.open) item.connection.send({ type: "clip", text: data.text, from: sender });
      }
    });
    connection.on("close", () => {
      pending.delete(connection.peer);
      const wasApproved = peers.delete(connection.peer);
      renderRequests();
      if (wasApproved) { broadcastRoster(); updateStatus(); }
    });
    connection.on("error", () => connection.close());
  }

  function acceptRequest(id) {
    const request = pending.get(id);
    if (!request || !request.connection.open) return;
    pending.delete(id);
    peers.set(id, request);
    request.connection.send({ type: "welcome" });
    renderRequests();
    broadcastRoster();
    updateStatus();
  }

  function rejectRequest(id) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    request.connection.close();
    renderRequests();
  }

  function broadcastRoster() {
    const devices = [{ id: peer.id, name: name(), host: true }, ...Array.from(peers, ([id, item]) => ({ id, name: item.name, host: false }))];
    for (const item of peers.values()) if (item.connection.open) item.connection.send({ type: "roster", devices });
    renderDevices();
  }

  function renderRequests() {
    ui.requests.replaceChildren();
    ui["requests-card"].hidden = pending.size === 0;
    for (const [id, item] of pending) {
      const li = document.createElement("li");
      li.className = "device-row";
      const avatar = document.createElement("span"); avatar.className = "device-avatar"; avatar.textContent = "?";
      const info = document.createElement("span"); info.className = "device-info";
      const label = document.createElement("strong"); label.textContent = item.name; info.append(label);
      const actions = document.createElement("span"); actions.className = "request-actions";
      const accept = document.createElement("button"); accept.className = "button button-primary"; accept.textContent = "承認"; accept.onclick = () => acceptRequest(id);
      const reject = document.createElement("button"); reject.className = "button button-outline"; reject.textContent = "拒否"; reject.onclick = () => rejectRequest(id);
      actions.append(accept, reject); li.append(avatar, info, actions); ui.requests.append(li);
    }
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
    if (!history.length) { const li = document.createElement("li"); li.className = "empty-state"; li.textContent = "送受信したテキストがここに表示されます。"; ui.history.append(li); return; }
    for (const item of history) {
      const li = document.createElement("li"); li.className = "history-item";
      const icon = document.createElement("span"); icon.className = `history-icon ${item.direction === "送信" ? "sent" : ""}`; icon.textContent = item.direction === "送信" ? "↗" : "↙";
      const detail = document.createElement("div"); detail.className = "history-detail";
      const meta = document.createElement("div"); meta.className = "history-meta";
      const title = document.createElement("span"); title.textContent = `${item.direction} · ${item.source}`;
      const time = document.createElement("time"); time.textContent = item.time.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
      meta.append(title, time);
      const preview = document.createElement("p"); preview.className = "history-text"; preview.textContent = item.text;
      detail.append(meta, preview);
      const use = document.createElement("button"); use.className = "text-button history-use"; use.textContent = "使う";
      use.onclick = () => { ui.message.value = item.text; updateControls(); ui.message.focus(); };
      li.append(icon, detail, use); ui.history.append(li);
    }
  }

  function receiveText(text, sender) {
    ui.message.value = text;
    updateControls();
    addHistory(text, "受信", sender);
    showToast(`${sender} からテキストを受信しました。`);
  }

  function sendText() {
    const text = ui.message.value;
    if (!text.trim()) return;
    if (!safeText(text)) { showToast("一度に送れるのは16 KBまでです。テキストを短くしてください。"); return; }
    if (role === "host") {
      if (!peers.size) { showToast("接続中の端末がありません。"); return; }
      for (const item of peers.values()) if (item.connection.open) item.connection.send({ type: "clip", text, from: name() });
    } else if (role === "guest" && approved && hostConnection?.open) {
      hostConnection.send({ type: "clip", text });
    } else { showToast("接続が完了してから送信してください。"); return; }
    addHistory(text, "送信", "この端末");
    showToast("テキストを送信しました。");
  }

  async function writeClipboard(text, codeOnly = false) {
    try { await navigator.clipboard.writeText(text); showToast("クリップボードにコピーしました。"); }
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
      updateControls();
      showToast("クリップボードから貼り付けました。");
    } catch { ui.message.focus(); showToast("自動で読み取れません。入力欄を長押しして貼り付けてください。"); }
  }

  ui["host-btn"].addEventListener("click", startHost);
  ui["join-btn"].addEventListener("click", startGuest);
  ui["join-code"].addEventListener("keydown", (event) => { if (event.key === "Enter") startGuest(); });
  ui["leave-btn"].addEventListener("click", () => leave("接続を終了しました。"));
  ui["paste-btn"].addEventListener("click", pasteClipboard);
  ui["copy-btn"].addEventListener("click", () => writeClipboard(ui.message.value));
  ui["copy-code-btn"].addEventListener("click", () => writeClipboard(roomCode, true));
  ui["send-btn"].addEventListener("click", sendText);
  ui.message.addEventListener("input", updateControls);
  ui["clear-history"].addEventListener("click", () => { history = []; renderHistory(); });
  ui["device-name"].addEventListener("change", saveName);
  window.addEventListener("beforeunload", () => peer?.destroy());

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
