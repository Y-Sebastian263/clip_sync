'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SERVICE,getDiscoveryHost,encodeName,decodeName,buildAdvertisement,buildQuery,
  queryIsRelevant,parseHostAdvertisements
} = require('../mdns.cjs');

test('discovery hostname stays stable without personal identifiers',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clipsync-mdns-test-'));
  try {
    const name=getDiscoveryHost(dir);
    assert.match(name,/^clipsync-[0-9a-f]{8}\.local$/);
    assert.equal(getDiscoveryHost(dir),name);
    const file=path.join(dir,'discovery-name.txt');
    fs.writeFileSync(file,'evil.example.com');
    assert.throws(()=>getDiscoveryHost(dir),/ホスト名/);
  }finally {fs.rmSync(dir,{force:true,recursive:true});}
});

test('DNS-SD advertised hostname resolves to only its LAN address and port',()=>{
  const name='clipsync-a1b2c3d4.local';
  const packet=buildAdvertisement({hostName:name,hostIp:'192.168.11.24',port:4477});
  assert.deepEqual(parseHostAdvertisements(packet),[{host:name,ip:'192.168.11.24',port:4477}]);
  assert.equal(packet.includes(Buffer.from('192.168.11.24')),false,'discovery does not put decimal IP string in TXT');
  assert.equal(packet.includes(Buffer.from('secret')),false);
  assert.equal(packet.includes(Buffer.from('iPad')),false);
  assert.equal(queryIsRelevant(buildQuery(),name),true);
  assert.equal(queryIsRelevant(Buffer.from([0,1,2,3]),name),false);
  const forged=Buffer.from(packet);forged[2]=0;
  assert.deepEqual(parseHostAdvertisements(forged),[]);
  assert.throws(()=>buildAdvertisement({hostName:'evil.com',hostIp:'192.168.11.24',port:4477}),/Invalid/);
  const wire=encodeName(SERVICE);
  assert.equal(decodeName(wire,0).name,SERVICE);
});
