/**
 * Tests: lokale Vorrat-Erweiterungen im Frontend
 * Modul: /public/pages/pantry.js (`__localTest`)
 *
 * Tags: Suche trifft Tags, Eingabe bereinigt und verwirft Dubletten.
 * Lagerort: der gewählte Chip wird beim Anlegen vorbelegt, und der Scanner
 * startet ohne Ort wie bisher, bei einem Ort nur mit Barcode = ja.
 *
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-pantry-local-ui.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };
global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, yuvomi: {} };
global.location = { pathname: '/pantry' };
global.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} } }),
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  documentElement: { lang: 'de' },
  activeElement: null,
};

const { __localTest: L } = await import('../public/pages/pantry.js');

function setItems(items) {
  L.state.items = items;
  L.state.filter = 'all';
  L.state.locationFilter = 'all';
  L.state.query = '';
}

test('Suche: „frühstück" findet Artikel über ihren Tag, auch als Teilwort', () => {
  setItems([
    { id: 1, name: 'Milch', quantity: 1, tags: ['Backen', 'Frühstück'] },
    { id: 2, name: 'Zucker', quantity: 1, tags: ['Backen'] },
    { id: 3, name: 'Müsli', quantity: 1, tags: [] },
    { id: 4, name: 'Brot', quantity: 1 },
  ]);
  L.state.query = 'frühstück';
  assert.deepEqual(L.visibleItems().map((i) => i.name), ['Milch']);
  L.state.query = 'back';
  assert.deepEqual(L.visibleItems().map((i) => i.name), ['Milch', 'Zucker']);
  L.state.query = 'müsli';
  assert.deepEqual(L.visibleItems().map((i) => i.name), ['Müsli']);
});

test('Tag-Eingabe: Leerraum bereinigt, leer und doppelt verworfen', () => {
  const panel = { _pantryTags: [] };
  assert.equal(L.addPantryTag(panel, '  Backen  '), true);
  assert.equal(L.addPantryTag(panel, 'backen'), false);
  assert.equal(L.addPantryTag(panel, '   '), false);
  assert.equal(L.addPantryTag(panel, 'Kaffee   und Kuchen'), true);
  assert.deepEqual(panel._pantryTags, ['Backen', 'Kaffee und Kuchen']);
  assert.equal(L.normalizePantryTag('x'.repeat(50)).length, 40);
});

test('Lagerort-Vorauswahl: nur ein echter Ort aus dem Chip, nicht „Alle"/„Ohne Lagerort"', () => {
  L.state.locations = [
    { id: 1, name: 'Abstellkammer', barcode_scan: 1 },
    { id: 8, name: 'Schublade Kosmetik', barcode_scan: 0 },
  ];
  L.state.locationFilter = 'all';
  assert.equal(L.selectedFilterLocation(), null);
  L.state.locationFilter = 'none';
  assert.equal(L.selectedFilterLocation(), null);
  L.state.locationFilter = '1';
  assert.equal(L.selectedFilterLocation()?.name, 'Abstellkammer');
  L.state.locationFilter = '99';
  assert.equal(L.selectedFilterLocation(), null);
});

test('Scanner beim Anlegen: ohne Ort ja, Ort mit Barcode = ja ja, = nein nein', () => {
  assert.equal(L.autoScanFor(null), true);
  assert.equal(L.autoScanFor({ id: 1, barcode_scan: 1 }), true);
  assert.equal(L.autoScanFor({ id: 2 }), true);
  assert.equal(L.autoScanFor({ id: 8, barcode_scan: 0 }), false);
});
