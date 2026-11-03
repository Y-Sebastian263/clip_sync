'use strict';
// Minimal LAN-only DNS-SD/mDNS advertisement. No discovery of other network devices.
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const MULTICAST = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_clipsync._tcp.local';
const ENUMERATE = '_services._dns-sd._udp.local';
const HOST_RE = /^clipsync-[a-f0-9]{8}\.local$/;

function getDiscoveryHost(directory) {
  const filename = path.join(directory, 'discovery-name.txt');
  fs.mkdirSync(directory, {recursive:true,mode:0o700});
  if (!fs.existsSync(filename)) {
    try {fs.writeFileSync(filename, `clipsync-${crypto.randomBytes(4).toString('hex')}.local\n`, {flag:'wx',mode:0o600});}
    catch (err) {if (err.code !== 'EEXIST') throw err;}
  }
  const name = fs.readFileSync(filename,'utf8').trim().toLowerCase();
  if (!HOST_RE.test(name)) throw Error('LANホスト名の設定が不正です (data/discovery-name.txt)');
  return name;
}
function encodeName(name) {
  const labels = name.split('.');
  if (labels.some(x=>!x || Buffer.byteLength(x,'ascii')>63 || !/^[a-zA-Z0-9_ -]+$/.test(x))) throw Error('Invalid mDNS name');
  return Buffer.concat([...labels.map(x=>{const b=Buffer.from(x,'ascii');return Buffer.concat([Buffer.from([b.length]),b]);}),Buffer.from([0])]);
}
function decodeName(buf,start) {
  if(!Buffer.isBuffer(buf)||start<0||start>=buf.length)throw Error('Invalid mDNS name offset');
  const labels=[];let pos=start,end=null,hops=0;
  while(true) {
    if(++hops>40||pos>=buf.length) throw Error('Malformed DNS name');
    const n=buf[pos];
    if((n&0xc0)===0xc0){if(pos+1>=buf.length)throw Error('Malformed DNS pointer');if(end===null)end=pos+2;pos=((n&0x3f)<<8)|buf[pos+1];continue;}
    if((n&0xc0)!==0||pos+n+1>buf.length)throw Error('Malformed DNS label');
    if(n===0)return {name:labels.join('.').toLowerCase(),next:end===null?pos+1:end};
    labels.push(buf.subarray(pos+1,pos+1+n).toString('ascii'));pos+=n+1;
  }
}
function record(name,type,ttl,data,unique=false) {
  const header=Buffer.alloc(10);
  header.writeUInt16BE(type,0);header.writeUInt16BE(unique?0x8001:1,2);
  header.writeUInt32BE(ttl,4);header.writeUInt16BE(data.length,8);
  return Buffer.concat([encodeName(name),header,data]);
}
function buildAdvertisement({hostIp,hostName,port,ttl=120}) {
  if (net.isIP(hostIp)!==4 || !HOST_RE.test(hostName) || !Number.isInteger(port)||port<1||port>65535)throw Error('Invalid mDNS host settings');
  const instance=`ClipSync-${hostName.slice('clipsync-'.length,-'.local'.length)}.${SERVICE}`;
  const srv=Buffer.alloc(6);srv.writeUInt16BE(port,4);
  const txtKeys=['path=/','tls=1'].map(text=>Buffer.from(text,'ascii'));
  const txt=Buffer.concat(txtKeys.map(item=>Buffer.concat([Buffer.from([item.length]),item])));
  const ip=Buffer.from(hostIp.split('.').map(Number));
  const records=[
    record(ENUMERATE,12,ttl,encodeName(SERVICE)),
    record(SERVICE,12,ttl,encodeName(instance)),
    record(instance,33,ttl,Buffer.concat([srv,encodeName(hostName)]),true),
    record(instance,16,ttl,txt,true),
    record(hostName,1,ttl,ip,true)
  ];
  const header=Buffer.alloc(12);header.writeUInt16BE(0x8400,2);header.writeUInt16BE(records.length,6);
  return Buffer.concat([header,...records]);
}
function buildQuery() {
  const header=Buffer.alloc(12);header.writeUInt16BE(1,4);
  const tail=Buffer.alloc(4);tail.writeUInt16BE(12,0);tail.writeUInt16BE(0x8001,2); // QU: reply directly when possible
  return Buffer.concat([header,encodeName(SERVICE),tail]);
}
function queryIsRelevant(packet,hostName) {
  try {
    if(!Buffer.isBuffer(packet)||packet.length<12||packet.length>1500||(packet.readUInt16BE(2)&0x8000))return false;
    const count=packet.readUInt16BE(4);if(count>20)return false;
    const instance=`clipsync-${hostName.slice(9,-6)}.${SERVICE}`;
    let pos=12;
    for(let i=0;i<count;i++) {
      const x=decodeName(packet,pos);pos=x.next;
      if(pos+4>packet.length)return false;
      const type=packet.readUInt16BE(pos);pos+=4;
      if((x.name===SERVICE||x.name===ENUMERATE||x.name===instance||x.name===hostName) && [1,12,16,33,255].includes(type))return true;
    }
  }catch{ /* Ignore malformed multicast packets. */ }
  return false;
}
function parseHostAdvertisements(packet) {
  try {
    if(!Buffer.isBuffer(packet)||packet.length<12||!(packet.readUInt16BE(2)&0x8000))return [];
    let pos=12;const qCount=packet.readUInt16BE(4);
    if(qCount>20)return [];
    for(let i=0;i<qCount;i++){const n=decodeName(packet,pos);pos=n.next+4;if(pos>packet.length)return [];}
    const count=packet.readUInt16BE(6)+packet.readUInt16BE(8)+packet.readUInt16BE(10);
    if(count>60)return [];
    const hosts=new Map(),services=new Map();
    for(let i=0;i<count;i++){
      const n=decodeName(packet,pos);pos=n.next;
      if(pos+10>packet.length)return [];
      const type=packet.readUInt16BE(pos),size=packet.readUInt16BE(pos+8),start=pos+10;pos=start+size;
      if(pos>packet.length)return [];
      if(type===1&&size===4&&HOST_RE.test(n.name))hosts.set(n.name,[...packet.subarray(start,pos)].join('.'));
      if(type===33&&size>=8&&n.name.endsWith('.'+SERVICE)){
        const port=packet.readUInt16BE(start+4),target=decodeName(packet,start+6).name;
        if(HOST_RE.test(target))services.set(target,port);
      }
    }
    return [...services.entries()].filter(([host])=>hosts.has(host)).map(([host,port])=>({host,ip:hosts.get(host),port}));
  }catch{return [];}
}
function startMdns({hostIp,netmask,hostName,port,logger=console}) {
  const announce=buildAdvertisement({hostIp,hostName,port});
  const goodbye=buildAdvertisement({hostIp,hostName,port,ttl:0});
  const sock=dgram.createSocket({type:'udp4',reuseAddr:true});
  let timer=null,active=false,closed=false,lastReply=0;
  const inSubnet = address => {
    if (net.isIP(address)!==4 || net.isIP(hostIp)!==4 || net.isIP(netmask)!==4) return false;
    const toN=x=>x.split('.').reduce((a,b)=>((a<<8)|Number(b))>>>0,0);
    const mask=toN(netmask);
    return (toN(address)&mask)===(toN(hostIp)&mask);
  };
  const send=(payload,address=MULTICAST,remotePort=MDNS_PORT)=>{
    if(active&&!closed)sock.send(payload,remotePort,address,()=>{});
  };
  sock.on('error',err=>{
    if(!closed)logger.warn(`[ClipSync] mDNS unavailable (${err.code||'error'}). IP address connection remains available.`);
    active=false;closed=true;clearInterval(timer);
    try{sock.close();}catch{}
  });
  sock.on('message',(msg,rinfo)=>{
    if(!active||!inSubnet(rinfo.address)||!queryIsRelevant(msg,hostName))return;
    const t=Date.now();if(t-lastReply<500)return;lastReply=t;
    // Queries sent from an ephemeral port get a one-shot unicast answer; standard mDNS uses multicast.
    if(rinfo.port===MDNS_PORT)send(announce);
    else if(rinfo.port>=1024)send(announce,rinfo.address,rinfo.port);
  });
  sock.bind(MDNS_PORT,'0.0.0.0',()=>{
    if(closed)return;
    try {
      sock.addMembership(MULTICAST,hostIp);sock.setMulticastInterface(hostIp);
      sock.setMulticastTTL(1);sock.setMulticastLoopback(false);
      active=true;send(announce);
      timer=setInterval(()=>send(announce),60000);timer.unref();
    }catch(err){sock.emit('error',err);}
  });
  return {
    get active(){return active&&!closed;},
    close(){if(closed)return; if(active)send(goodbye);closed=true;active=false;clearInterval(timer);try{sock.dropMembership(MULTICAST,hostIp);}catch{}sock.close();}
  };
}
module.exports={SERVICE,MULTICAST,MDNS_PORT,getDiscoveryHost,encodeName,decodeName,buildAdvertisement,buildQuery,queryIsRelevant,parseHostAdvertisements,startMdns};
