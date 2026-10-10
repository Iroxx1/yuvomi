/**
 * Test: lokale Vorrat-Erweiterungen Tags und Barcode-Schalter je Lagerort
 * Zweck: Tags werden bereinigt gespeichert (JSON), als Liste ausgeliefert und
 *        bleiben bei PUT/PATCH ohne `tags` erhalten; `barcode_scan` je Lagerort
 *        hat Default 1, lässt sich allein umschalten und Umbenennen lässt ihn
 *        stehen. Upstream-Verhalten (Name Pflicht beim PUT) bleibt.
 * Ausführen: node --experimental-sqlite --test test/test-pantry-local-tags.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const db = dbmod.get();

const USER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('owner', 'Owner', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = USER;
  req.authRole = 'member';
  req.session = { userId: USER, role: 'member' };
  next();
});
app.use('/pantry', pantryRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

const itemRow = (id) => db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id);
const locRow = (id) => db.prepare('SELECT * FROM pantry_locations WHERE id = ?').get(id);

// --------------------------------------------------------------------------
// Tags
// --------------------------------------------------------------------------
test('POST /pantry: Tags werden bereinigt, doppelte ohne Groß-/Kleinschreibung verworfen', async () => {
  const r = await call('POST', '/pantry', {
    name: 'Milch',
    tags: ['  Backen ', 'Frühstück', 'backen', '', 'Kaffee   und  Kuchen'],
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.tags, ['Backen', 'Frühstück', 'Kaffee und Kuchen']);
  assert.equal(itemRow(r.body.data.id).tags, '["Backen","Frühstück","Kaffee und Kuchen"]');
});

test('POST /pantry: ohne Tags → [] in der Antwort, NULL in der DB', async () => {
  const r = await call('POST', '/pantry', { name: 'Zucker' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.tags, []);
  assert.equal(itemRow(r.body.data.id).tags, null);
});

test('POST /pantry: ungültige Tags → 400', async () => {
  assert.equal((await call('POST', '/pantry', { name: 'X', tags: 'Backen' })).status, 400);
  assert.equal((await call('POST', '/pantry', { name: 'X', tags: [42] })).status, 400);
  assert.equal((await call('POST', '/pantry', { name: 'X', tags: ['x'.repeat(41)] })).status, 400);
  const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
  assert.equal((await call('POST', '/pantry', { name: 'X', tags: many })).status, 400);
});

test('PUT /pantry/:id: ohne `tags` bleiben sie, mit [] werden sie geleert', async () => {
  const created = await call('POST', '/pantry', { name: 'Mehl', tags: ['Backen'] });
  const id = created.body.data.id;

  const keep = await call('PUT', `/pantry/${id}`, { name: 'Mehl Typ 405', quantity: 2 });
  assert.equal(keep.status, 200);
  assert.deepEqual(keep.body.data.tags, ['Backen']);

  const change = await call('PUT', `/pantry/${id}`, { name: 'Mehl Typ 405', tags: ['Backen', 'Frühstück'] });
  assert.deepEqual(change.body.data.tags, ['Backen', 'Frühstück']);

  const clear = await call('PUT', `/pantry/${id}`, { name: 'Mehl Typ 405', tags: [] });
  assert.deepEqual(clear.body.data.tags, []);
  assert.equal(itemRow(id).tags, null);
});

test('PATCH /pantry/:id: Mengen-Schritt lässt Tags stehen und liefert sie als Liste', async () => {
  const created = await call('POST', '/pantry', { name: 'Eier', quantity: 6, tags: ['Frühstück'] });
  const id = created.body.data.id;
  const r = await call('PATCH', `/pantry/${id}`, { quantity: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.quantity, 5);
  assert.deepEqual(r.body.data.tags, ['Frühstück']);
  assert.equal(itemRow(id).tags, '["Frühstück"]');
});

test('GET /pantry: Tags als Liste, kaputter Wert in der DB wird zu []', async () => {
  const created = await call('POST', '/pantry', { name: 'Kaputt' });
  db.prepare('UPDATE pantry_items SET tags = ? WHERE id = ?').run('{kein json', created.body.data.id);
  const r = await call('GET', '/pantry');
  assert.equal(r.status, 200);
  const byName = new Map(r.body.data.map((i) => [i.name, i]));
  assert.deepEqual(byName.get('Kaputt').tags, []);
  assert.deepEqual(byName.get('Eier').tags, ['Frühstück']);
});

// --------------------------------------------------------------------------
// Barcode-Schalter je Lagerort
// --------------------------------------------------------------------------
test('Lagerorte: Seed-Orte haben barcode_scan = 1', async () => {
  const r = await call('GET', '/pantry/locations');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 5);
  assert.ok(r.body.data.every((l) => l.barcode_scan === 1));
});

test('POST /pantry/locations: barcode_scan Default 1, 0 wird übernommen, Unsinn → 400', async () => {
  const a = await call('POST', '/pantry/locations', { name: 'Garage' });
  assert.equal(a.status, 201);
  assert.equal(a.body.data.barcode_scan, 1);

  const b = await call('POST', '/pantry/locations', { name: 'Schublade Kosmetik', barcode_scan: 0 });
  assert.equal(b.status, 201);
  assert.equal(b.body.data.barcode_scan, 0);

  const c = await call('POST', '/pantry/locations', { name: 'Dachboden', barcode_scan: 'vielleicht' });
  assert.equal(c.status, 400);
});

test('PUT /pantry/locations/:id: nur barcode_scan schalten lässt Name und Icon stehen', async () => {
  const created = await call('POST', '/pantry/locations', { name: 'Speis', icon: 'archive' });
  const id = created.body.data.id;

  const off = await call('PUT', `/pantry/locations/${id}`, { barcode_scan: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.barcode_scan, 0);
  assert.equal(off.body.data.name, 'Speis');
  assert.equal(off.body.data.icon, 'archive');

  // Umbenennen (schickt nur den Namen) lässt den Schalter stehen.
  const renamed = await call('PUT', `/pantry/locations/${id}`, { name: 'Speisekammer' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.barcode_scan, 0);
  assert.equal(locRow(id).name, 'Speisekammer');

  const on = await call('PUT', `/pantry/locations/${id}`, { barcode_scan: 1 });
  assert.equal(on.body.data.barcode_scan, 1);
});

test('PUT /pantry/locations/:id: ohne Name und ohne Schalter bleibt der Name Pflicht', async () => {
  const created = await call('POST', '/pantry/locations', { name: 'Flur' });
  const r = await call('PUT', `/pantry/locations/${created.body.data.id}`, {});
  assert.equal(r.status, 400);
});
