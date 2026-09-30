/** Barcode lookup and camera scanner for household inventory items. */
import { api } from '/api.js';
import { vibrate } from '/utils/ux.js';

let stream = null;
let active = false;
let generation = 0;

export function stopInventoryBarcodeScanner(panel = null) {
  generation += 1;
  active = false;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  const video = panel?.querySelector('#inv-barcode-video');
  if (video) {
    video.pause();
    video.srcObject = null;
    video.hidden = true;
  }
  const start = panel?.querySelector('#inv-barcode-scan');
  const stop = panel?.querySelector('#inv-barcode-stop');
  if (start) start.hidden = false;
  if (stop) stop.hidden = true;
}

async function lookup(panel, barcode) {
  const input = panel.querySelector('#inv-barcode');
  const status = panel.querySelector('#inv-barcode-status');
  const button = panel.querySelector('#inv-barcode-lookup');
  const code = String(barcode ?? '').trim();
  if (!/^\d{8,14}$/.test(code)) {
    status.textContent = 'Bitte einen Barcode mit 8 bis 14 Ziffern eingeben.';
    return;
  }

  input.value = code;
  const requestId = (panel._inventoryBarcodeRequestId || 0) + 1;
  panel._inventoryBarcodeRequestId = requestId;
  button.disabled = true;
  status.textContent = 'Produkt wird gesucht …';
  try {
    const result = await api.get(`/inventory/barcode/${encodeURIComponent(code)}`);
    if (!panel.isConnected || requestId !== panel._inventoryBarcodeRequestId) return;
    const product = result.data;
    panel.querySelector('#inv-name').value = product.name;
    if (product.brand) panel.querySelector('#inv-brand').value = product.brand;
    status.textContent = `Gefunden in ${product.source}: ${[product.name, product.brand, product.package_text].filter(Boolean).join(' · ')}`;
    window.yuvomi?.showToast('Produkt gefunden.', 'success');
  } catch (err) {
    if (!panel.isConnected || requestId !== panel._inventoryBarcodeRequestId) return;
    status.textContent = err.data?.error || 'Produkt nicht gefunden. Angaben können manuell eingetragen werden.';
    window.yuvomi?.showToast(err.data?.error ?? 'Produkt wurde nicht gefunden.', 'info');
  } finally {
    if (panel.isConnected && requestId === panel._inventoryBarcodeRequestId) button.disabled = false;
  }
}

async function startScanner(panel) {
  stopInventoryBarcodeScanner(panel);
  const scanGeneration = generation;
  const video = panel.querySelector('#inv-barcode-video');
  const status = panel.querySelector('#inv-barcode-status');
  const cancelled = () => scanGeneration !== generation || !video?.isConnected;

  if (!window.isSecureContext) {
    status.textContent = 'Kamera-Scan benötigt HTTPS. Barcode kann manuell eingegeben werden.';
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = 'Dieser Browser erlaubt hier keinen Kamerazugriff.';
    return;
  }
  if (!('BarcodeDetector' in globalThis)) {
    status.textContent = 'Dieser Browser unterstützt die Barcode-Erkennung nicht. Bitte Nummer manuell eingeben.';
    return;
  }

  try {
    const supported = await globalThis.BarcodeDetector.getSupportedFormats();
    if (cancelled()) return;
    const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => supported.includes(f));
    if (!formats.length) {
      status.textContent = 'Dieser Browser unterstützt keine EAN-/UPC-Barcodes.';
      return;
    }
    const detector = new globalThis.BarcodeDetector({ formats });
    const camera = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (cancelled()) {
      for (const track of camera.getTracks()) track.stop();
      return;
    }
    stream = camera;
    active = true;
    video.srcObject = camera;
    video.hidden = false;
    panel.querySelector('#inv-barcode-scan').hidden = true;
    panel.querySelector('#inv-barcode-stop').hidden = false;
    await video.play();
    if (cancelled()) return;
    status.textContent = 'Barcode vor die Kamera halten …';

    while (active && !cancelled()) {
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video);
          if (cancelled()) break;
          const match = codes.find((entry) => /^\d{8,14}$/.test(entry.rawValue));
          if (match) {
            vibrate(30);
            stopInventoryBarcodeScanner(panel);
            await lookup(panel, match.rawValue);
            break;
          }
        }
      } catch {
        // A single camera frame may fail; keep scanning.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (cancelled() && stream === camera) stopInventoryBarcodeScanner(panel);
  } catch (err) {
    if (cancelled()) return;
    console.error('Inventory barcode scanner:', err);
    stopInventoryBarcodeScanner(panel);
    status.textContent = err?.name === 'NotAllowedError'
      ? 'Kamerazugriff wurde nicht erlaubt.' : 'Kamera konnte nicht geöffnet werden.';
  }
}

export function wireInventoryBarcode(panel, { autoStart = false } = {}) {
  const input = panel.querySelector('#inv-barcode');
  panel.querySelector('#inv-barcode-lookup').addEventListener('click', () => lookup(panel, input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      lookup(panel, input.value);
    }
  });
  panel.querySelector('#inv-barcode-scan').addEventListener('click', () => startScanner(panel));
  panel.querySelector('#inv-barcode-stop').addEventListener('click', () => stopInventoryBarcodeScanner(panel));
  if (autoStart) startScanner(panel);
}
