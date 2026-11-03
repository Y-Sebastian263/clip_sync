'use strict';
// ClipSync LAN: deliberately no public rendezvous, CDN, telemetry or HTTP fallback.
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const SESSION_COOKIE = '__Host-clipsync_session';
const MAX_TEXT = 16 * 1024;
const MAX_BODY = 20 * 1024;
const MAX_CLIPS = 50;
const MAX_DEVICES = 32;
const MAX_STREAMS = 40;
const PENDING_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const ASSET_TYPES = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const rand = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => Date.now();
const utf8bytes = value => Buffer.byteLength(value, 'utf8');
const isText = value => typeof value === 'string' && utf8bytes(value) <= MAX_TEXT;
const loopback = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

function ipv4Number(ip) {
  if (net.isIP(ip) !== 4) return null;
  return ip.split('.').reduce((n, piece) => ((n << 8) | Number(piece)) >>> 0, 0);
}
function sameSubnet(ip, hostIp, netmask) {
  const a = ipv4Number(ip), b = ipv4Number(hostIp), mask = ipv4Number(netmask);
  return a !== null && b !== null && mask !== null && (a & mask) === (b & mask);
}
function findInterface(hostIp) {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address === hostIp) return entry;
    }
  }
  return null;
}
function selectableIps() {
  const matches = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const n = ipv4Number(entry.address);
      if (!entry.internal && entry.family === 'IPv4' && n !== null && (
        (n >>> 24) === 10 || (n >>> 20) === 0xac1 || (n >>> 16) === 0xc0a8
      )) matches.push(entry.address);
    }
  }
  return [...new Set(matches)];
}
function json(res, status, value, headers = {}) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':payload.length,...headers});
  res.end(payload);
}
function error(res, status, message) { json(res, status, {error:message}); }
function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a,'hex'), Buffer.from(b,'hex'));
}
function readBody(req) {
  return new Promise((resolve,reject) => {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reject({status:415,message:'JSON形式で送信してください'}); return;
    }
    let count = 0; let tooLarge = false; const parts = [];
    req.on('data', chunk => {
      count += chunk.length;
      if (count > MAX_BODY) { tooLarge = true; return; }
      parts.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) { reject({status:413,message:'送信サイズが大きすぎます'}); return; }
      try {
        const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
        resolve(body);
      } catch { reject({status:400,message:'不正なJSONです'}); }
    });
    req.on('error', reject);
  });
}
function saveDevices(file, devices) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  const target = path.join(path.dirname(file), `.devices-${process.pid}-${rand(5)}.tmp`);
  fs.writeFileSync(target, JSON.stringify({schema:1,devices},null,2), {encoding:'utf8',mode:0o600,flag:'wx'});
  fs.renameSync(target,file);
  try { fs.chmodSync(file,0o600); } catch { /* Windows ACLs are managed by OS. */ }
}
function loadDevices(file) {
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  if (data.schema !== 1 || !Array.isArray(data.devices)) throw Error('端末データの形式が不正です');
  return data.devices.filter(d => d && typeof d.id === 'string' && /^[a-f0-9]{64}$/.test(d.tokenHash) && typeof d.name === 'string' && Number.isSafeInteger(d.createdAt));
}
function makeApp({hostIp, netmask, storagePath = path.join(__dirname,'data','devices.json'), staticDir = path.join(__dirname,'public'), clock = now}) {
  const devices = loadDevices(storagePath);
  const pending = new Map();
  const streams = new Map();
  const requestTimes = new Map();
  const writeTimes = new Map();
  const pageStart = clock();
  let state = {text:'',version:0,textVersion:0,clips:[]}; // content NEVER written to disk
  const persist = () => saveDevices(storagePath,devices);
  const publicState = () => ({text:state.text,version:state.version,textVersion:state.textVersion,clips:state.clips,connectedDevices:devices.length});
  const authorized = req => {
    if (loopback(req.socket.remoteAddress)) return {id:'local-host',name:'ホスト'};
    const cookie = (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(SESSION_COOKIE+'='));
    if (!cookie) return null;
    const [id, token] = cookie.slice(SESSION_COOKIE.length+1).split('.');
    if (!/^[a-f0-9-]{36}$/.test(id || '') || !/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const device = devices.find(d=>d.id===id);
    if (!device || device.createdAt+SESSION_TTL_MS <= clock()) return null;
    return safeEqualHex(device.tokenHash,hash(token)) ? device : null;
  };
  const checkWriteLimit = (req,res) => {
    const auth=authorized(req);
    if (!auth) { error(res,401,'端末承認が必要です'); return false; }
    const t=clock(),times=(writeTimes.get(auth.id)||[]).filter(x=>t-x<10000);
    if (times.length>=45) { error(res,429,'操作が多すぎます。少し待って再試行してください'); return false; }
    writeTimes.set(auth.id,[...times,t]);
    return true;
  };
  const broadcast = () => {
    const message = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
    for (const [res,id] of streams) {
      if (id !== 'local-host' && !devices.some(d=>d.id===id)) { streams.delete(res);res.end();continue; }
      if (!res.write(message)) { streams.delete(res);res.end(); }
    }
  };
  const sweep = () => {
    const t = clock();
    for (const [id,p] of pending) if (p.createdAt + PENDING_TTL_MS < t) pending.delete(id);
    for (const [ip,times] of writeTimes) {
      const recent=times.filter(x=>t-x<10000);
      if (recent.length) writeTimes.set(ip,recent); else writeTimes.delete(ip);
    }
    for (const [ip,times] of requestTimes) {
      const recent=times.filter(x=>t-x<60000);
      if (recent.length) requestTimes.set(ip,recent); else requestTimes.delete(ip);
    }
    for (const res of streams.keys()) {
      try { res.write(': keep-alive\n\n'); } catch { streams.delete(res); }
    }
  };
  const interval = setInterval(sweep,20000); interval.unref();

  async function handler(req,res) {
    try {
      // Never expose the app to another subnet, even if the router forwards its port.
      const remote = req.socket.remoteAddress || '';
      const isOwner = loopback(remote) && loopback(req.socket.localAddress || '');
      const isLan = isOwner || sameSubnet(remote,hostIp,netmask);
      if (!isLan) { error(res,403,'同一LANの端末からのみ接続できます'); return; }
      const port = req.socket.localPort;
      const host = req.headers.host;
      const accepted = [`${hostIp}:${port}`,`localhost:${port}`,`127.0.0.1:${port}`];
      if (!accepted.includes(host)) { error(res,403,'不正なホスト名です'); return; }
      const origin = `https://${host}`;
      const headers = {
        'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
        'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
        'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
        'Cross-Origin-Resource-Policy':'same-origin',
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Strict-Transport-Security':'max-age=3600'
      };
      for (const [name,value] of Object.entries(headers)) res.setHeader(name,value);
      if (!['GET','HEAD','POST','DELETE'].includes(req.method)) { error(res,405,'許可されていないメソッドです');return; }
      if (['POST','DELETE'].includes(req.method) && req.headers.origin!==origin) {
        error(res,403,'クロスサイト操作を拒否しました');return;
      }
      const url = new URL(req.url,origin);
      const pathname = url.pathname;
      if (pathname==='/api/info' && req.method==='GET') {
        json(res,200,{authorized:!!authorized(req),host:isOwner,joinEnabled:true,hostUrl:`https://${hostIp}:${port}/`,uptimeSec:Math.floor((clock()-pageStart)/1000)});return;
      }
      if (pathname==='/api/state' && req.method==='GET') {
        if(!authorized(req)){error(res,401,'端末承認が必要です');return;}
        json(res,200,publicState());return;
      }
      if (pathname==='/api/events' && req.method==='GET') {
        const auth=authorized(req);
        if(!auth){error(res,401,'端末承認が必要です');return;}
        if(streams.size>=MAX_STREAMS){error(res,503,'接続上限です');return;}
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
        streams.set(res,auth.id);
        req.on('close',()=>streams.delete(res));return;
      }
      if (pathname==='/api/state' && req.method==='POST') {
        if(!checkWriteLimit(req,res))return;
        const body=await readBody(req);
        if(!isText(body.text)){error(res,400,'本文は16 KiB以内にしてください');return;}
        if(!Number.isSafeInteger(body.baseVersion) || body.baseVersion!==state.textVersion){json(res,409,{error:'別の端末が更新しました',state:publicState()});return;}
        state={...state,text:body.text,textVersion:state.textVersion+1,version:state.version+1};broadcast();json(res,200,publicState());return;
      }
      if (pathname==='/api/clips' && req.method==='POST') {
        if(!checkWriteLimit(req,res))return;
        const body=await readBody(req);
        if(!isText(body.text) || !body.text.trim()){error(res,400,'有効な本文を入力してください');return;}
        if(state.clips.length>=MAX_CLIPS){error(res,409,'掲示板は最大50件です。不要な投稿を削除してください');return;}
        state={...state,clips:[{id:crypto.randomUUID(),text:body.text,createdAt:clock()},...state.clips],version:state.version+1};
        broadcast();json(res,201,publicState());return;
      }
      if (pathname.startsWith('/api/clips/') && req.method==='DELETE') {
        if(!checkWriteLimit(req,res))return;
        const id=pathname.slice('/api/clips/'.length);
        if(!/^[a-f0-9-]{36}$/.test(id)){error(res,400,'投稿IDが不正です');return;}
        const next=state.clips.filter(clip=>clip.id!==id);
        if(next.length===state.clips.length){error(res,404,'投稿が見つかりません');return;}
        state={...state,clips:next,version:state.version+1};broadcast();json(res,200,publicState());return;
      }
      if(pathname==='/api/join' && req.method==='POST') {
        if(authorized(req)){error(res,409,'すでに参加しています');return;}
        const ip=remote,t=clock();
        const times=(requestTimes.get(ip)||[]).filter(x=>t-x<60000);
        if(times.length>=4){error(res,429,'申請が多すぎます。少し経ってから再試行してください');return;}
        requestTimes.set(ip,[...times,t]);
        sweep();
        if(pending.size>=20){error(res,503,'承認待ちが多すぎます');return;}
        const body=await readBody(req);
        const name=typeof body.name==='string'?body.name.trim():'';
        if(!name || [...name].length>32){error(res,400,'端末名は1〜32文字にしてください');return;}
        const id=rand(18),secret=rand(),pairCode=String(crypto.randomInt(100000,1000000));
        pending.set(id,{id,secret,pairCode,name,createdAt:t,approved:false,ip});
        json(res,202,{id,secret,pairCode,expiresIn:300});return;
      }
      if(pathname==='/api/join/status' && req.method==='POST') {
        const body=await readBody(req);
        const item=pending.get(body.id);
        if(!item || !item.secret || typeof body.secret!=='string'||item.secret!==body.secret||item.ip!==remote){error(res,404,'申請が見つかりません');return;}
        if(item.createdAt+PENDING_TTL_MS<clock()){pending.delete(body.id);error(res,410,'申請の有効期限が切れました');return;}
        if(item.rejected){pending.delete(body.id);error(res,403,'ホストが接続を拒否しました');return;}
        if(!item.approved){json(res,200,{status:'pending'});return;}
        pending.delete(body.id);
        res.setHeader('Set-Cookie',`${SESSION_COOKIE}=${item.deviceId}.${item.token}; Path=/; Max-Age=${SESSION_TTL_MS/1000}; Secure; HttpOnly; SameSite=Strict`);
        json(res,200,{status:'approved'});return;
      }
      if (pathname.startsWith('/api/admin')) {
        if(!isOwner){error(res,403,'端末管理はホストPCでのみ操作できます');return;}
        if(pathname==='/api/admin'&&req.method==='GET') {
          json(res,200,{pending:[...pending.values()].filter(p=>!p.approved&&!p.rejected).map(p=>({id:p.id,name:p.name,pairCode:p.pairCode,createdAt:p.createdAt})),devices:devices.map(d=>({id:d.id,name:d.name,createdAt:d.createdAt}))});return;
        }
        if(pathname==='/api/admin/approve'&&req.method==='POST') {
          const body=await readBody(req),item=pending.get(body.id);
          if(!item||item.approved||item.rejected||item.createdAt+PENDING_TTL_MS<clock()){error(res,404,'承認申請が見つかりません');return;}
          if(devices.length>=MAX_DEVICES){error(res,409,'登録端末が上限に達しました');return;}
          const token=rand(),deviceId=crypto.randomUUID();
          devices.push({id:deviceId,name:item.name,tokenHash:hash(token),createdAt:clock()});
          persist(); item.approved=true;item.deviceId=deviceId;item.token=token;
          json(res,200,{status:'approved'});return;
        }
        if(pathname==='/api/admin/reject'&&req.method==='POST') {
          const body=await readBody(req),item=pending.get(body.id);
          if(!item){error(res,404,'承認申請が見つかりません');return;}
          item.rejected=true;json(res,200,{status:'rejected'});return;
        }
        if(pathname==='/api/admin/revoke'&&req.method==='POST') {
          const body=await readBody(req),i=devices.findIndex(d=>d.id===body.id);
          if(i<0){error(res,404,'端末が見つかりません');return;}
          const revoked=devices.splice(i,1)[0]; persist();
          for(const [stream,id] of streams)if(id===revoked.id){streams.delete(stream);stream.end();}
          broadcast();json(res,200,{status:'revoked'});return;
        }
      }
      // Only known local files; no traversal, directory listing, uploads or external scripts.
      const assets={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
      if (req.method==='GET'||req.method==='HEAD') {
        const asset=assets[pathname];
        if(asset){const filename=path.join(staticDir,asset);const contents=fs.readFileSync(filename);
          res.writeHead(200,{'Content-Type':ASSET_TYPES[path.extname(filename)],'Content-Length':contents.length});
          res.end(req.method==='HEAD'?undefined:contents);return;}
      }
      error(res,404,'ページが見つかりません');
    } catch(err) {
      if(!res.headersSent)error(res,err.status||500,err.status?err.message:'サーバー内部エラー');
      else res.end();
      if(!err.status)console.error('[ClipSync] Request processing error (content not logged):',err.message);
    }
  }
  return {handler,shutdown(){clearInterval(interval);for(const res of streams.keys())res.end();streams.clear();},state:publicState,devices};
}

async function start() {
  const candidates=selectableIps();
  const hostIp=process.env.CLIPSYNC_HOST_IP || (candidates.length===1?candidates[0]:null);
  if(!hostIp){throw Error('CLIPSYNC_HOST_IP を指定してください。候補: '+candidates.join(', '));}
  const lan=findInterface(hostIp);
  if(!lan || !candidates.includes(hostIp)){throw Error('ホストIPはPCのプライベートIPv4アドレスを指定してください');}
  const cert=process.env.CLIPSYNC_TLS_CERT;
  const key=process.env.CLIPSYNC_TLS_KEY;
  if(!cert||!key){throw Error('HTTPS必須: CLIPSYNC_TLS_CERT と CLIPSYNC_TLS_KEY を指定してください (README参照)');}
  const port=Number(process.env.CLIPSYNC_PORT||4477);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('ポートは1024〜65535で指定してください');
  const tls={cert:fs.readFileSync(cert),key:fs.readFileSync(key),minVersion:'TLSv1.2'};
  const app=makeApp({hostIp,netmask:lan.netmask});
  // Separate listening sockets let us give admin privileges ONLY to local machine requests.
  const lanServer=https.createServer(tls,app.handler);
  const ownerServer=https.createServer(tls,app.handler);
  for(const server of [lanServer,ownerServer]) {
    server.requestTimeout=15000; server.headersTimeout=10000;
    server.maxHeadersCount=60; server.maxConnections=80;
  }
  const listen=(server,ip)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,ip,()=>{server.off('error',reject);resolve();});});
  await listen(lanServer,hostIp);
  try {await listen(ownerServer,'127.0.0.1');}catch(err){lanServer.close();throw err;}
  console.log(`ClipSync LAN started. Host admin: https://localhost:${port}/`);
  console.log(`Other devices on this LAN: https://${hostIp}:${port}/`);
  console.log('Only devices in the local subnet may connect; no external signaling or cloud storage.');
  const stop=()=>{app.shutdown();lanServer.close();ownerServer.close();};
  process.on('SIGINT',()=>{stop();process.exit(0);});
  process.on('SIGTERM',()=>{stop();process.exit(0);});
}
if(require.main===module){start().catch(err=>{console.error('[ClipSync] Startup error:',err.message);process.exitCode=1;});}
module.exports={makeApp,sameSubnet,findInterface,selectableIps,SESSION_COOKIE};
