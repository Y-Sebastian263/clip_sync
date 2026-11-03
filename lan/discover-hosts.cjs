'use strict';
// Windows/macOS/Linux helper: find ClipSync LAN hosts via multicast DNS-SD.
// Browser JavaScript cannot send mDNS queries; this is an optional local CLI.
const dgram = require('node:dgram');
const net = require('node:net');
const {MULTICAST,MDNS_PORT,buildQuery,parseHostAdvertisements} = require('./mdns.cjs');
const arg = process.argv[2] || '';
if(arg && net.isIP(arg)!==4){console.error('Usage: node discover-hosts.cjs [your-LAN-IPv4]');process.exit(1);}
const socket=dgram.createSocket('udp4');
const found=new Map();
const finish=()=>{
  socket.close();
  if(!found.size)console.log('ClipSyncホストが見つかりませんでした。ホストPCの表示URLをお試しください。');
  else for(const host of found.values())console.log(`ClipSync: https://${host.host}:${host.port}/  (IP fallback: https://${host.ip}:${host.port}/)`);
};
socket.on('error',err=>{console.error('Discovery failed:',err.message);process.exitCode=1;finish();});
socket.on('message',packet=>{
  for(const item of parseHostAdvertisements(packet)){
    if(!found.has(item.host)){
      found.set(item.host,item);
      console.log(`ホストを検出: ${item.host} / ${item.ip}:${item.port}`);
    }
  }
});
socket.bind(0,'0.0.0.0',()=>{
  if(arg)socket.setMulticastInterface(arg);
  socket.setMulticastTTL(1);
  socket.send(buildQuery(),MDNS_PORT,MULTICAST,err=>{if(err)console.error('Discovery query failed:',err.message);});
  setTimeout(finish,3500).unref?.(); // timer is short; keep the socket alive until finish
});
