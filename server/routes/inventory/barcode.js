/** Barcode lookup across Open Facts, a China catalog, and UPCitemdb. */
import express from 'express';
import { createLogger } from '../../logger.js';

const router = express.Router();
const log = createLogger('InventoryBarcode');
const USER_AGENT = 'YuvomiInventoryBarcode/1.1 (self-hosted)';
const SOURCE_NAMES = {
  beauty: 'Open Beauty Facts',
  product: 'Open Products Facts',
  food: 'Open Food Facts',
  petfood: 'Open Pet Food Facts',
};

// Free anonymous plans: UPCitemdb 100/day and 6/minute; ApiZero 20/day.
// Stay below those ceilings and avoid repeated requests for the same product.
const positiveCache = new Map();
const CACHE_MS = 12 * 60 * 60 * 1000;
const recentUpcCalls = [];
let upcDay = '';
let upcCount = 0;
let chinaDay = '';
let chinaCount = 0;
let lastChinaCall = 0;

function sameCode(a, b) {
  return /^\d{8,14}$/.test(String(a || '')) &&
    String(a).padStart(14, '0') === String(b).padStart(14, '0');
}

function takeQuota(provider) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (provider === 'upc') {
    if (upcDay !== day) { upcDay = day; upcCount = 0; }
    while (recentUpcCalls.length && recentUpcCalls[0] <= now - 60000) recentUpcCalls.shift();
    if (upcCount >= 90 || recentUpcCalls.length >= 5) throw new Error('UPCitemdb free limit');
    upcCount += 1;
    recentUpcCalls.push(now);
  } else {
    if (chinaDay !== day) { chinaDay = day; chinaCount = 0; }
    if (chinaCount >= 18 || now - lastChinaCall < 1100) throw new Error('ApiZero free limit');
    chinaCount += 1;
    lastChinaCall = now;
  }
}

async function getJson(url, { quota } = {}) {
  if (quota) takeQuota(quota);
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(7000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function lookupOpenFacts(barcode) {
  const url = new URL(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
  url.searchParams.set('product_type', 'all');
  url.searchParams.set('fields', [
    'code', 'product_type', 'product_name_de', 'product_name',
    'generic_name_de', 'generic_name', 'brands', 'quantity',
  ].join(','));
  const result = await getJson(url);
  const product = Number(result?.status) === 1 ? result.product : null;
  if (!product || (product.code && !sameCode(product.code, barcode))) return null;
  // A brand-only entry is not a product match: keep searching other catalogs.
  const name = String(product.product_name_de || product.product_name ||
    product.generic_name_de || product.generic_name || '').trim();
  if (!name) return null;
  const type = String(product.product_type || '').toLowerCase();
  return {
    barcode, name,
    brand: String(product.brands || '').trim() || null,
    package_text: String(product.quantity || '').trim() || null,
    source: SOURCE_NAMES[type] || 'Open Facts',
  };
}

async function lookupChina(barcode) {
  if (!/^69\d{11}$/.test(barcode)) return null;
  const url = new URL('https://v1.apizero.cn/api/barcode-lookup');
  url.searchParams.set('barcode', barcode);
  const result = await getJson(url, { quota: 'china' });
  const product = result?.code === 0 && result.data?.found ? result.data : null;
  if (!product || !sameCode(product.barcode, barcode)) return null;
  const name = String(product.name || '').trim();
  if (!name) return null;
  return {
    barcode, name,
    brand: String(product.brand || '').trim() || null,
    package_text: String(product.spec || '').trim() || null,
    source: 'ApiZero Produktdatenbank',
  };
}

async function lookupUpcItemDb(barcode) {
  const url = new URL('https://api.upcitemdb.com/prod/trial/lookup');
  url.searchParams.set('upc', barcode);
  const result = await getJson(url, { quota: 'upc' });
  const item = result?.code === 'OK' && Array.isArray(result.items)
    ? result.items.find((candidate) => sameCode(candidate.ean, barcode) || sameCode(candidate.upc, barcode))
    : null;
  const name = String(item?.title || '').trim();
  if (!name) return null;
  return {
    barcode, name,
    brand: String(item.brand || '').trim() || null,
    package_text: String(item.size || '').trim() || null,
    source: 'UPCitemdb',
  };
}

router.get('/:barcode', async (req, res) => {
  const barcode = String(req.params.barcode ?? '').trim();
  if (!/^\d{8,14}$/.test(barcode)) {
    return res.status(400).json({ error: 'Ungültiger Barcode.', code: 400 });
  }
  const cached = positiveCache.get(barcode);
  if (cached && cached.until > Date.now()) return res.json({ data: cached.product });
  if (cached) positiveCache.delete(barcode);

  let unavailable = false;
  for (const provider of [lookupOpenFacts, lookupChina, lookupUpcItemDb]) {
    try {
      const product = await provider(barcode);
      if (!product) continue;
      if (positiveCache.size >= 500) positiveCache.delete(positiveCache.keys().next().value);
      positiveCache.set(barcode, { product, until: Date.now() + CACHE_MS });
      return res.json({ data: product });
    } catch (err) {
      unavailable = true;
      log.warn(`${provider.name} failed for barcode ${barcode}: ${err.message}`);
    }
  }
  if (unavailable) {
    return res.status(503).json({
      error: 'Nicht alle Produktquellen sind erreichbar oder das freie Abfragelimit ist erreicht. Du kannst die Angaben manuell speichern.',
      code: 503,
    });
  }
  return res.status(404).json({ error: 'Produkt wurde nicht gefunden. Du kannst es manuell eintragen.', code: 404 });
});

export default router;
