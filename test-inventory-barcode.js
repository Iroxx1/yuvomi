process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('./server/db.js');
const { default: barcodeRouter } = await import('./server/routes/inventory/barcode.js');
const { default: itemsRouter } = await import('./server/routes/inventory/items.js');
const db = dbmod.get();
const userId = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('barcode-owner', 'Barcode Owner', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = userId;
  req.session = { userId };
  next();
});
app.use('/barcode', barcodeRouter);
app.use('/items', itemsRouter);
const server = app.listen(0, '127.0.0.1');
const base = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; server.close(); });

async function call(path, { method = 'GET', body } = {}) {
  const response = await realFetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('universal lookup handles beauty products, unknown products, and upstream errors', async () => {
  assert.equal((await call('/barcode/invalid')).status, 400);
  let requested;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({ status: 1, product: {
      product_type: 'beauty', product_name_de: 'Duschgel', brands: 'Beispielmarke', quantity: '250 ml',
    } }), { status: 200 });
  };
  const found = await call('/barcode/3560070791460');
  assert.equal(found.status, 200);
  assert.equal(found.body.data.name, 'Duschgel');
  assert.equal(found.body.data.source, 'Open Beauty Facts');
  assert.match(requested, /product_type=all/);

  globalThis.fetch = async () => new Response(JSON.stringify({ status: 0 }), { status: 200 });
  assert.equal((await call('/barcode/3560070791460')).status, 200); // successful lookups are cached
  assert.equal((await call('/barcode/3560070791461')).status, 404);
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await call('/barcode/3560070791462')).status, 503);
});

test('Korean product falls back from an unnamed Open Facts record to exact UPCitemdb match', async () => {
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    if (host.includes('openfoodfacts')) return new Response(JSON.stringify({
      status: 1, product: { code: '8809525249565', product_type: 'beauty', brands: 'Beauty of Joseon' },
    }), { status: 200 });
    if (host === 'api.upcitemdb.com') return new Response(JSON.stringify({
      code: 'OK', items: [
        { ean: '8800000000000', title: 'Wrong item' },
        { ean: '8809525249565', title: 'Dynasty Cream', brand: 'Beauty of Joseon', size: '50 ml' },
      ],
    }), { status: 200 });
    throw new Error(`Unexpected provider ${host}`);
  };
  const found = await call('/barcode/8809525249565');
  assert.equal(found.status, 200);
  assert.equal(found.body.data.name, 'Dynasty Cream');
  assert.equal(found.body.data.source, 'UPCitemdb');
  assert.equal(found.body.data.barcode, '8809525249565');
});

test('Chinese body-care product falls back to ApiZero and validates the returned code', async () => {
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname;
    if (host.includes('openfoodfacts')) return new Response('{}', { status: 404 });
    if (host === 'v1.apizero.cn') return new Response(JSON.stringify({
      code: 0, data: { found: true, barcode: '6907376500056',
        name: '强生婴儿牛奶沐浴露300毫升', brand: '强生婴儿', spec: '300毫升' },
    }), { status: 200 });
    throw new Error(`Unexpected provider ${host}`);
  };
  const found = await call('/barcode/6907376500056');
  assert.equal(found.status, 200);
  assert.equal(found.body.data.source, 'ApiZero Produktdatenbank');
  assert.equal(found.body.data.name, '强生婴儿牛奶沐浴露300毫升');
});

test('inventory stores, searches, validates, and clears an optional barcode', async () => {
  const added = await call('/items', { method: 'POST', body: { name: 'Badeartikel', barcode: '3560070791460' } });
  assert.equal(added.status, 201);
  assert.equal(added.body.data.barcode, '3560070791460');
  const id = added.body.data.id;
  const searched = await call('/items?q=3560070791460');
  assert.equal(searched.status, 200);
  assert.equal(searched.body.data.some((item) => item.id === id), true);
  const updated = await call(`/items/${id}`, { method: 'PUT', body: { name: 'Badeartikel neu' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.barcode, null);
  assert.equal((await call('/items', { method: 'POST', body: { name: 'Falsch', barcode: 'bad' } })).status, 400);
});
