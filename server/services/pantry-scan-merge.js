/**
 * Modul: Vorrat - Scan-Zusammenführung (lokale Erweiterung, local/*-custom)
 * Zweck: Reine Regeln dafür, wohin ein gescannter Artikel gehört, ohne DB.
 *
 *  - Gleiche EAN schon im Vorrat → die Menge kommt zu der Zeile, die auch der
 *    nächtliche Dubletten-Lauf auf dem Host behalten würde
 *    (yuvomi-vorrat-dubletten, Regel "gleiche EAN"): von Hand gepflegt, sonst
 *    mit Bestand, sonst die älteste. Zeilen mit Bestand UND MHD sind eigene
 *    Chargen (der Verbrauchssync bucht nach MHD ab) und nehmen nichts auf.
 *  - Zeilen OHNE EAN, deren Name im Produktnamen steckt (z. B. "Rucola" aus
 *    der Einkaufsliste ↔ "LIDL Priméale Rucola 125g"), sind Kandidaten zum
 *    Ersetzen - nur als Vorschlag, die Entscheidung trifft der Mensch. Was er
 *    bestätigt, landet als Zuordnung in `pantry_aliases`.
 */

/** Wörter eines Namens: klein, NFC, nur Buchstaben/Ziffern. */
export function nameWords(name) {
  return String(name ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('de')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Schlüssel für Zuordnungen: Wörter mit einem Leerzeichen dazwischen. */
export function aliasKey(name) {
  return nameWords(name).join(' ');
}

/**
 * Steckt der Name einer Einkaufslisten-Zeile im Produktnamen? Jedes Wort ab drei
 * Buchstaben muss vorkommen - als ganzes Wort oder, ab fünf Buchstaben, als
 * Grundwort am Ende eines zusammengesetzten Wortes ("tomaten" in
 * "rispentomaten", aber nicht "fisch" in "thunfischfilets").
 */
export function placeholderMatches(placeholderName, productName) {
  const wanted = nameWords(placeholderName).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  if (!wanted.length) return false;
  const have = nameWords(productName);
  return wanted.every((w) => have.some((h) => h === w || (w.length >= 5 && h.endsWith(w))));
}

const FACTORS = new Map([
  ['g>kg', 0.001], ['kg>g', 1000],
  ['ml>l', 0.001], ['l>ml', 1000],
]);

/** Menge in eine andere Einheit umrechnen; null = nicht umrechenbar. */
export function convertQuantity(quantity, fromUnit, toUnit) {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return null;
  if (fromUnit === toUnit) return q;
  const f = FACTORS.get(`${fromUnit}>${toUnit}`);
  return f === undefined ? null : q * f;
}

const hasStock = (row) => Number(row?.quantity) > 0;

/** Von Hand gepflegt (ohne MHD gerechnet): Mindestmenge, Notiz, Foto, Tags. */
export function isCurated(row) {
  return row.min_quantity !== null && row.min_quantity !== undefined
    || Boolean(String(row.notes ?? '').trim())
    || Boolean(row.photo_key)
    || (Boolean(row.tags) && row.tags !== '[]');
}

/**
 * Zeile, die eine gescannte Menge gleicher EAN aufnimmt, oder null.
 * Reihenfolge wie im Host-Skript: gepflegt > mit Bestand > älteste.
 */
export function pickMergeTarget(rows) {
  const open = rows.filter((r) => !(r.expires_on && hasStock(r)));
  open.sort((a, b) =>
    Number(isCurated(b)) - Number(isCurated(a))
    || Number(hasStock(b)) - Number(hasStock(a))
    || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
    || a.id - b.id);
  return open[0] ?? null;
}

/**
 * Wie kommt eine neue Menge in die Zielzeile?
 * @returns {{ quantity: number, unit: string }|null} null = nicht zusammenführbar
 *   (Ziel hat Bestand in einer nicht umrechenbaren Einheit)
 */
export function mergedAmount(target, quantity, unit) {
  const converted = convertQuantity(quantity, unit, target.unit);
  if (converted !== null) {
    return { quantity: Number(target.quantity) + converted, unit: target.unit };
  }
  // Leere Zeile in anderer Einheit (z. B. "0 Stk" ↔ "500 g"): übernimmt Menge
  // und Einheit des Scans.
  if (!hasStock(target)) return { quantity: Number(quantity), unit };
  return null;
}
