// Dependency-free contract verification; run from a repository root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const manifest = JSON.parse(fs.readFileSync('contracts/activity-contract.v1.sha256.json', 'utf8'));
for (const [file, expected] of Object.entries(manifest.files)) {
  assert.equal(hash(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')), expected, 'Contract drift: ' + file);
}
const codec = ['service/activity-contract.ts', 'service/src/integration/activity-contract.ts'].find(fs.existsSync);
if (codec) assert.equal(hash(fs.readFileSync(codec, 'utf8').replace(/\r\n/g, '\n')), manifest.typescriptCodec, 'TypeScript codec drift');
const publisher = ['infra/activity-publisher.ts', 'cdk/lib/activity-publisher.ts'].find(fs.existsSync);
if (publisher) assert.equal(hash(fs.readFileSync(publisher, 'utf8').replace(/\r\n/g, '\n')), manifest.publisher, 'Publisher drift');
const snapshots = JSON.parse(fs.readFileSync('contracts/fixtures/activity-v1.json', 'utf8'));
const wires = JSON.parse(fs.readFileSync('contracts/fixtures/activity-wire-v1.json', 'utf8'));
const template = JSON.parse(fs.readFileSync('contracts/activity-input-template.v1.json', 'utf8'));
if (publisher) assert.ok(fs.readFileSync(publisher, 'utf8').includes(template), 'Publisher must use the contracted transformer');
const metrics = ['shopSeconds','volunteerSeconds','packsOpened','battleWins','battleLosses','battleDraws','fmeaSubmitted'];
assert.equal(snapshots.length, 4);
assert.equal(wires.length, snapshots.length);
for (let i = 0; i < snapshots.length; i++) {
  const e = snapshots[i];
  assert.equal(e.eventId, hash(JSON.stringify([e.orgId,e.source,e.type,e.entityId,e.entityVersion,e.subject.namespace,e.subject.id])));
  const flat = {...e, eventType:e.type, subjectNamespace:e.subject.namespace,subjectId:e.subject.id,...e.metrics};
  const row = {dynamodb:{NewImage:Object.fromEntries(Object.entries(flat).map(([key,value]) => [key,typeof value === 'number' ? {N:String(value)} : {S:value}]))}};
  const lookup = jsonPath => jsonPath.slice(2).split('.').reduce((value,key) => value[key],row);
  const rendered = template.replace(/"<(\$\.[^>]+)>"/g,(_match,jsonPath) => JSON.stringify(lookup(jsonPath)));
  assert.ok(!rendered.includes('<$.'), 'All variable fields must have explicit string encoding');
  const wire = JSON.parse(rendered);
  assert.deepEqual(wire, wires[i], 'Pipe transformation mismatch');
  const canonical = {...wire.activity,entityVersion:Number(wire.activity.entityVersion),metrics:Object.fromEntries(metrics.map(k=>[k,Number(wire.activity.metrics[k])]))};
  assert.deepEqual(canonical,e);
}
console.log('Activity contract hashes, event identities, and Pipe round trips passed (' + manifest.revision + ').');
