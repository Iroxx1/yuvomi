/**
 * Test: lokale Vorrat-Erweiterung Scan-Zusammenführung und Zuordnungen
 * Zweck: Ein Scan mit bekannter EAN stockt die vorhandene Zeile auf (dieselbe
 *        Wahl wie der nächtliche Dubletten-Lauf auf dem Host), Chargen mit MHD
 *        bleiben getrennt, ersetzte Platzhalter ohne EAN werden gelöscht und als
 *        Zuordnung (pantry_aliases) gemerkt. Ohne `merge_existing` bleibt POST
 *        wie bei Upstream (Bring-Sync, Skripte).
 * Ausführen: node --experimental-sqlite --test test/test-pantry-local-scan-merge.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const merge = await import('../server/services/pantry-scan-merge.js');
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

const LOC = db.prepare('SELECT id FROM pantry_locations ORDER BY sort_order, id').all().map((l) => l.id);

/** Zeile direkt anlegen; created_at steuerbar für "älteste". */
function row(fields) {
  const f = { quantity: 0, unit: 'g', location_id: LOC[0], category: 'Sonstiges', created_at: '2026-10-01T00:00:00Z', ...fields };
  return db.prepare(`
    INSERT INTO pantry_items (name, quantity, unit, location_id, category, barcode, expires_on, min_quantity, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(f.name, f.quantity, f.unit, f.location_id, f.category, f.barcode ?? null, f.expires_on ?? null,
    f.min_quantity ?? null, USER, f.created_at).lastInsertRowid;
}
const get = (id) => db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id);
const countEan = (ean) => db.prepare('SELECT COUNT(*) AS n FROM pantry_items WHERE barcode = ?').get(ean).n;

// --------------------------------------------------------------------------
// Reine Regeln
// --------------------------------------------------------------------------
test('placeholderMatches: Wort im Produktnamen, Teilwort erst ab fünf Buchstaben', () => {
  assert.equal(merge.placeholderMatches('Rucola', 'LIDL Priméale Rucola 125g 0.99€ 1kg 7.92€'), true);
  assert.equal(merge.placeholderMatches('Wiener', 'Wiener Würstchen'), true);
  assert.equal(merge.placeholderMatches('Tomaten', 'Cocktail-Rispentomaten'), true);
  assert.equal(merge.placeholderMatches('Salz', 'Salzstangen'), false);
  assert.equal(merge.placeholderMatches('Putenbrust mit Honig', 'Putenbrust mit Honig, hauchfein'), true);
  assert.equal(merge.placeholderMatches('Äpfel', 'Apfel'), false);
  assert.equal(merge.placeholderMatches('', 'Apfel'), false);
  assert.equal(merge.aliasKey('  Kräuter (im Topf) '), 'kräuter im topf');
});

test('pickMergeTarget: gepflegt > mit Bestand > älteste; Charge mit MHD und Bestand nie', () => {
  const a = { id: 1, quantity: 0, created_at: '2026-01-01' };
  const b = { id: 2, quantity: 100, created_at: '2026-02-01' };
  const c = { id: 3, quantity: 0, min_quantity: 1, created_at: '2026-03-01' };
  const d = { id: 4, quantity: 50, expires_on: '2026-12-01', created_at: '2025-01-01' };
  assert.equal(merge.pickMergeTarget([a, b]).id, 2);
  assert.equal(merge.pickMergeTarget([a, b, c]).id, 3);
  assert.equal(merge.pickMergeTarget([d]), null);
  assert.equal(merge.pickMergeTarget([a, { ...a, id: 5, created_at: '2026-01-02' }]).id, 1);
});

test('mergedAmount: umrechnen, leere Zeile übernimmt Einheit, sonst null', () => {
  assert.deepEqual(merge.mergedAmount({ quantity: 1, unit: 'kg' }, 500, 'g'), { quantity: 1.5, unit: 'kg' });
  assert.deepEqual(merge.mergedAmount({ quantity: 0, unit: 'pcs' }, 1000, 'g'), { quantity: 1000, unit: 'g' });
  assert.equal(merge.mergedAmount({ quantity: 2, unit: 'pcs' }, 125, 'g'), null);
});

// --------------------------------------------------------------------------
// Routen
// --------------------------------------------------------------------------
test('Rucola: Abgleich zeigt Ziel und Platzhalter, Speichern stockt auf und ersetzt', async () => {
  const leer = row({ name: 'LIDL Priméale Rucola 125g', barcode: '20205775', created_at: '2026-09-18T08:33:48Z' });
  const voll = row({ name: 'LIDL Priméale Rucola 125g', barcode: '20205775', quantity: 125, location_id: LOC[1], created_at: '2026-10-21T15:19:48Z' });
  const platz = row({ name: 'Rucola', unit: 'pcs', quantity: 1, created_at: '2026-10-20T09:26:40Z' });
  row({ name: 'Salz', unit: 'pcs', quantity: 1 });

  const m = await call('GET', '/pantry/scan-match?barcode=20205775&name=LIDL%20Prim%C3%A9ale%20Rucola%20125g');
  assert.equal(m.status, 200);
  assert.equal(m.body.data.target.id, voll);
  assert.ok(m.body.data.target.location_name);
  assert.deepEqual(m.body.data.placeholders.map((p) => [p.id, p.alias]), [[platz, false]]);

  const r = await call('POST', '/pantry', {
    name: 'LIDL Priméale Rucola 125g', quantity: 125, unit: 'g', location_id: LOC[2], barcode: '20205775',
    merge_existing: true, replace_ids: [platz], alias_pack: { quantity: 125, unit: 'g' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.merged_into, voll);
  assert.deepEqual(r.body.replaced_ids, [platz]);
  assert.equal(get(voll).quantity, 250);
  assert.equal(get(voll).location_id, LOC[1], 'Zeile mit Bestand bleibt an ihrem Ort');
  assert.equal(get(leer).quantity, 0, 'die leere Dublette nimmt nichts auf');
  assert.equal(get(platz), undefined);
  assert.equal(countEan('20205775'), 2, 'keine neue Zeile');

  const aliases = await call('GET', '/pantry/aliases');
  const rucola = aliases.body.data.find((a) => a.name_key === 'rucola');
  assert.equal(rucola.barcode, '20205775');
  assert.equal(rucola.pack_quantity, 125);
  assert.equal(rucola.pack_unit, 'g');

  // Nächster Einkauf aus Bring legt wieder "Rucola" an → jetzt vorgewählt.
  const wieder = row({ name: 'rucola', unit: 'pcs', quantity: 1 });
  const m2 = await call('GET', '/pantry/scan-match?barcode=20205775&name=');
  assert.deepEqual(m2.body.data.placeholders.map((p) => [p.id, p.alias]), [[wieder, true]]);

  const del = await call('DELETE', `/pantry/aliases/${rucola.id}`);
  assert.equal(del.status, 204);
  assert.equal((await call('DELETE', `/pantry/aliases/${rucola.id}`)).status, 404);
});

test('Leere Zielzeile zieht an den gewählten Ort und übernimmt eine andere Einheit', async () => {
  const leer = row({ name: 'Äpfel', barcode: '4056489186267', unit: 'pcs', location_id: LOC[0] });
  const r = await call('POST', '/pantry', {
    name: 'Apfel', quantity: 1000, unit: 'g', location_id: LOC[3], barcode: '4056489186267', merge_existing: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.merged_into, leer);
  const z = get(leer);
  assert.equal(z.quantity, 1000);
  assert.equal(z.unit, 'g');
  assert.equal(z.location_id, LOC[3]);
  assert.equal(z.name, 'Äpfel', 'Name der vorhandenen Zeile bleibt');
});

test('Gepflegtes bleibt, Lücken werden gefüllt', async () => {
  const z = row({ name: 'Mehl', barcode: '4000000000017', unit: 'kg', quantity: 1, min_quantity: 1 });
  const r = await call('POST', '/pantry', {
    name: 'Mehl Typ 405', quantity: 500, unit: 'g', barcode: '4000000000017', merge_existing: true,
    min_quantity: 3, notes: 'Neu', tags: ['Backen'],
  });
  assert.equal(r.status, 200);
  const after = get(z);
  assert.equal(after.quantity, 1.5);
  assert.equal(after.min_quantity, 1);
  assert.equal(after.notes, 'Neu');
  assert.deepEqual(r.body.data.tags, ['Backen']);
});

test('Neue Zeile: mit MHD, ohne merge_existing, oder Bestand in anderer Einheit', async () => {
  row({ name: 'Joghurt', barcode: '4000000000024', unit: 'g', quantity: 500 });
  const mhd = await call('POST', '/pantry', {
    name: 'Joghurt', quantity: 500, unit: 'g', barcode: '4000000000024', merge_existing: true, expires_on: '2026-11-30',
  });
  assert.equal(mhd.status, 201);

  const alt = await call('POST', '/pantry', { name: 'Joghurt', quantity: 500, unit: 'g', barcode: '4000000000024' });
  assert.equal(alt.status, 201);
  assert.deepEqual(alt.body.replaced_ids, []);

  row({ name: 'Eier', barcode: '4000000000031', unit: 'pcs', quantity: 6 });
  const eier = await call('POST', '/pantry', {
    name: 'Eier', quantity: 600, unit: 'g', barcode: '4000000000031', merge_existing: true,
  });
  assert.equal(eier.status, 201);
  assert.equal(countEan('4000000000031'), 2);
});

test('replace_ids: nur Zeilen ohne EAN, und nur mit Barcode im Request', async () => {
  const mitEan = row({ name: 'Nudeln', barcode: '4000000000048', quantity: 500 });
  const ohne = row({ name: 'Nudeln', unit: 'pcs', quantity: 1 });

  const ohneBarcode = await call('POST', '/pantry', { name: 'Nudeln', replace_ids: [ohne] });
  assert.equal(ohneBarcode.status, 201);
  assert.ok(get(ohne), 'ohne Barcode wird nichts ersetzt');

  const r = await call('POST', '/pantry', {
    name: 'Mafalde Nudeln', quantity: 500, unit: 'g', barcode: '4000000000055', replace_ids: [mitEan, ohne],
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.replaced_ids, [ohne]);
  assert.ok(get(mitEan), 'Zeile mit EAN bleibt');
  assert.equal(get(ohne), undefined);
  const alias = db.prepare("SELECT * FROM pantry_aliases WHERE name_key = 'nudeln'").get();
  assert.equal(alias.barcode, '4000000000055');
  assert.equal(alias.pack_quantity, 500, 'ohne alias_pack zählt die gespeicherte Menge');

  assert.equal((await call('POST', '/pantry', { name: 'X', barcode: '4000000000062', replace_ids: 'eins' })).status, 400);
  assert.equal((await call('POST', '/pantry', { name: 'X', barcode: '4000000000062', replace_ids: [0] })).status, 400);
});

test('scan-match: ungültiger Barcode → 400, unbekannte EAN → kein Ziel', async () => {
  assert.equal((await call('GET', '/pantry/scan-match?barcode=abc')).status, 400);
  const r = await call('GET', '/pantry/scan-match?barcode=99999999&name=Gibt%20es%20nicht');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.target, null);
  assert.deepEqual(r.body.data.placeholders, []);
});
