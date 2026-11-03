'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const https = require('node:https');
const {makeApp,sameSubnet,SESSION_COOKIE} = require('../server.cjs');

test('IPv4 CIDR filter is exact',()=>{
  assert.equal(sameSubnet('192.168.1.99','192.168.1.20','255.255.255.0'),true);
  assert.equal(sameSubnet('192.168.2.99','192.168.1.20','255.255.255.0'),false);
  assert.equal(sameSubnet('8.8.8.8','192.168.1.20','255.255.255.0'),false);
  assert.equal(sameSubnet('::1','192.168.1.20','255.255.255.0'),false);
  assert.equal(sameSubnet('192.168.1.99','192.168.1.20','255.255.255.255'),false);
});

test('HTTPS session, approval, board synchronization, revocation and restart',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'clipsync-test-'));
  const key=path.join(tmp,'key.pem'),cert=path.join(tmp,'cert.pem'),store=path.join(tmp,'devices.json');
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
  }catch(e){fs.rmSync(tmp,{recursive:true,force:true});throw Error('テストにOpenSSLが必要です: '+e.message);}
  let fakeTime=Date.now();
  const app=makeApp({hostIp:'127.0.0.1',netmask:'255.255.255.0',storagePath:store,clock:()=>fakeTime,discoveryHost:'clipsync-a1b2c3d4.local',discoveryStatus:()=>true});
  const server=https.createServer({cert:fs.readFileSync(cert),key:fs.readFileSync(key)},app.handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  t.after(async()=>{app.shutdown();await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});});
  function request(pathname,{method='GET',body,guest=false,cookie,origin=true,hostHeader,guestIP='127.0.0.2'}={}) {
    return new Promise((resolve,reject)=>{
      const raw=body===undefined?undefined:JSON.stringify(body);
      const options={hostname:'127.0.0.1',port,path:pathname,method,rejectUnauthorized:false,
        localAddress:guest?guestIP:'127.0.0.1',headers:{Host:hostHeader||`127.0.0.1:${port}`}};
      if(raw!==undefined){options.headers['Content-Type']='application/json';options.headers['Content-Length']=Buffer.byteLength(raw);}
      if(cookie)options.headers.Cookie=cookie;
      if(origin&&['POST','DELETE'].includes(method))options.headers.Origin=`https://127.0.0.1:${port}`;
      const req=https.request(options,res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{let data={};try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{}resolve({status:res.statusCode,body:data,headers:res.headers});});});
      req.on('error',reject);req.end(raw);
    });
  }
  assert.equal((await request('/api/state',{guest:true})).status,401);
  assert.equal((await request('/api/admin',{guest:true})).status,403);
  const info=await request('/api/info');
  assert.equal(info.body.discoveryUrl,`https://clipsync-a1b2c3d4.local:${port}/`);
  assert.equal(info.body.mdnsActive,true);
  assert.equal((await request('/api/info',{guest:true,hostHeader:`clipsync-a1b2c3d4.local:${port}`})).status,200);
  assert.equal((await request('/api/info',{guest:true,guestIP:'127.0.1.2'})).status,403);
  assert.equal((await request('/api/info',{guest:true,hostHeader:'evil.invalid'})).status,403);
  assert.equal((await request('/api/join',{method:'POST',guest:true,body:{name:'iPad'},origin:false})).status,403);
  const join=await request('/api/join',{method:'POST',guest:true,body:{name:'iPad'}});
  assert.equal(join.status,202);
  const {id,secret}=join.body;
  assert.ok(id&&secret);
  assert.match(join.body.pairCode,/^[0-9]{6}$/);
  const admin=await request('/api/admin');
  assert.equal(admin.status,200);
  assert.equal(admin.body.pending.length,1);
  assert.equal(admin.body.pending[0].name,'iPad');
  assert.equal(admin.body.pending[0].pairCode,join.body.pairCode);
  const waiting=await request('/api/join/status',{method:'POST',guest:true,body:{id,secret}});
  assert.equal(waiting.body.status,'pending');
  assert.equal((await request('/api/join/status',{method:'POST',guest:true,body:{id,secret:'wrong'}})).status,404);
  assert.equal((await request('/api/admin/approve',{method:'POST',body:{id}})).status,200);
  const approved=await request('/api/join/status',{method:'POST',guest:true,body:{id,secret}});
  assert.equal(approved.status,200);
  assert.equal(approved.body.status,'approved');
  const cookie=approved.headers['set-cookie'][0].split(';')[0];
  assert.ok(cookie.startsWith(SESSION_COOKIE+'='));
  assert.match(approved.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/state',{guest:true,cookie})).status,200);
  let seen=(await request('/api/admin')).body.devices[0];
  assert.equal(seen.online,true);
  assert.equal(seen.lastSeenAt,fakeTime);
  fakeTime+=46000;
  seen=(await request('/api/admin')).body.devices[0];
  assert.equal(seen.online,false,'presence must expire even with a registered cookie');
  assert.equal((await request('/api/ping',{method:'POST',guest:true,cookie,body:{}})).status,200);
  seen=(await request('/api/admin')).body.devices[0];
  assert.equal(seen.online,true,'new valid heartbeat restores online status');
  assert.equal(seen.lastSeenAt,fakeTime);
  assert.equal((await request('/api/ping',{method:'POST',guest:true,body:{}})).status,401);
  assert.equal((await request('/api/ping',{method:'POST',guest:true,cookie,body:{},origin:false})).status,403);
  assert.equal((await request('/api/state',{guest:true,cookie,guestIP:'127.0.0.3'})).status,200);
  const updated=await request('/api/state',{method:'POST',guest:true,cookie,body:{text:'ひみつの文章',baseVersion:0}});
  assert.equal(updated.status,200);
  assert.equal(updated.body.text,'ひみつの文章');
  assert.equal(updated.body.textVersion,1);
  assert.equal((await request('/api/state',{method:'POST',guest:true,cookie,body:{text:'古い編集',baseVersion:0}})).status,409);
  const clip=await request('/api/clips',{method:'POST',guest:true,cookie,body:{text:'<img src=x onerror=alert(1)>'}});
  assert.equal(clip.status,201);
  assert.equal(clip.body.clips[0].text,'<img src=x onerror=alert(1)>');
  const clipId=clip.body.clips[0].id;
  assert.equal((await request('/api/clips/'+clipId,{method:'DELETE',guest:true,cookie})).status,200);
  assert.equal((await request('/api/state',{method:'POST',guest:true,cookie,body:{text:'新しいテキスト',baseVersion:1}})).status,200);
  assert.equal((await request('/api/clips',{method:'POST',guest:true,cookie,body:{text:'z'.repeat(16*1024+1)}})).status,400);
  assert.equal((await request('/api/clips',{method:'POST',guest:true,cookie,body:{text:'z'.repeat(21*1024)}})).status,413);
  const stored=fs.readFileSync(store,'utf8');
  assert.ok(!stored.includes('ひみつの文章'));
  assert.ok(!stored.includes('<img'));
  assert.ok(!stored.includes(cookie.split('=')[1]));
  const restarted=makeApp({hostIp:'127.0.0.1',netmask:'255.255.255.0',storagePath:store});
  assert.equal(restarted.state().text,'');
  assert.equal(restarted.devices.length,1);
  assert.equal(restarted.devices[0].lastSeenAt,undefined,'presence must not persist to disk');
  restarted.shutdown();
  const deviceId=(await request('/api/admin')).body.devices[0].id;
  assert.equal((await request('/api/admin/revoke',{method:'POST',body:{id:deviceId}})).status,200);
  assert.equal((await request('/api/state',{guest:true,cookie})).status,401);
});
