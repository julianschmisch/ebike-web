// eBike App für den Browser (Bluefy auf dem iPhone), abgespeckt: nur Fahrstufe
// wählen und Akkustand sehen. Die Seite kann im Hintergrund nicht laufen, darum
// gibt es hier keine Zähler. Die Logik steckt in core.js.

import {
  desFromKeyText, keyFromBluetoothName, FrameAssembler, FrameKind,
  gearSymbol, buildGearCommand, encryptCommand, splitForBle, PAD_ORDER, isSafeCommandValue,
} from './core.js';

const SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
const CHAR_NOTIFY = '0000ff01-0000-1000-8000-00805f9b34fb';
const CHAR_WRITE = '0000ff02-0000-1000-8000-00805f9b34fb';
const NO_DATA_MS = 20000;
const CHUNK_PAUSE_MS = 50;
const GEAR_CONFIRM_MS = 3000;
const RECONNECT_FOR_MS = 120000;
const RECONNECT_EVERY_MS = 4000;

// ------------------------------------------------------------ Speicher

const store = {
  get(key) {
    try {
      return localStorage.getItem('ebike.' + key);
    } catch (_) {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem('ebike.' + key);
      else localStorage.setItem('ebike.' + key, String(value));
    } catch (_) {
      // Ohne Speicher läuft die App trotzdem.
    }
  },
  num(key, fallback = 0) {
    const n = Number(store.get(key));
    return Number.isFinite(n) && store.get(key) !== null ? n : fallback;
  },
};

// ------------------------------------------------------------ Sprache

let english = (() => {
  const saved = store.get('lang');
  if (saved === 'en') return true;
  if (saved === 'de') return false;
  return !String(navigator.language || 'de').toLowerCase().startsWith('de');
})();
const tr = (de, en) => (english ? en : de);
const localNum = (s) => (english ? s : s.replace('.', ','));

// ------------------------------------------------------------ Zustand

const state = {
  link: 'idle', // idle | connecting | connected | error
  message: null,
  data: null,
  bikeName: '',
  pendingGear: null,
  reconnecting: false,
  lockOn: false,
  log: [],
};

let device = null;
let server = null;
let writeChar = null;
let notifyChar = null;
let assembler = null;
let des = null;
let watchdog = null;
let userDisconnect = false;
let reconnectTimer = null;
let workingPad = null;
let gearWaiter = null;
let gearTarget = null;
let wakeLock = null;
let logOpen = false;

function log(text) {
  const t = new Date().toLocaleTimeString();
  state.log.push(`${t}  ${text}`);
  if (state.log.length > 200) state.log.shift();
  scheduleRender();
}

function fail(text) {
  state.link = 'error';
  state.reconnecting = false;
  state.message = text;
  log('Fehler: ' + text);
  scheduleRender();
}

// ------------------------------------------------------------ Verbindung

async function connect(acceptAll) {
  if (!navigator.bluetooth) {
    fail(tr(
      'Dieser Browser kann kein Bluetooth. Bitte diese Seite in der App "Bluefy" öffnen.',
      'This browser cannot use Bluetooth. Please open this page in the "Bluefy" app.',
    ));
    return;
  }
  if (state.link === 'connecting' || state.link === 'connected') return;
  state.message = null;
  userDisconnect = false;
  const options = acceptAll
    ? { acceptAllDevices: true, optionalServices: [SERVICE] }
    : { filters: [{ namePrefix: 'TA' }], optionalServices: [SERVICE] };
  let dev;
  try {
    dev = await navigator.bluetooth.requestDevice(options);
  } catch (e) {
    if (e && e.name === 'NotFoundError') {
      log('Auswahl abgebrochen oder kein Rad gefunden.');
      scheduleRender();
      return;
    }
    fail(tr('Die Suche hat nicht geklappt: ', 'The search failed: ') + (e?.message ?? e));
    return;
  }
  await attach(dev);
}

async function attach(dev) {
  device = dev;
  const name = dev.name || '';
  const key = keyFromBluetoothName(name);
  if (!key) {
    fail(tr(
      'Der Bluetooth-Name des Rads ist zu kurz, daraus lässt sich kein Schlüssel ableiten.',
      'The Bluetooth name of the bike is too short to derive a key from.',
    ));
    return;
  }
  state.bikeName = name;
  des = desFromKeyText(key);
  assembler = new FrameAssembler(des);
  dev.removeEventListener('gattserverdisconnected', onGattDisconnected);
  dev.addEventListener('gattserverdisconnected', onGattDisconnected);
  state.link = 'connecting';
  state.data = null;
  scheduleRender();
  try {
    await setupGatt(dev);
  } catch (e) {
    log('Verbindungsfehler: ' + (e?.message ?? e));
    try {
      dev.gatt?.disconnect();
    } catch (_) {
      // schon getrennt
    }
    fail(tr(
      'Die Verbindung hat nicht geklappt. Rad aus- und wieder einschalten und erneut versuchen.',
      'Connecting failed. Turn the bike off and on again and retry.',
    ));
    return;
  }
  state.link = 'connected';
  state.reconnecting = false;
  state.message = null;
  log('Verbunden. Warte auf Daten.');
  armWatchdog();
  requestWakeLock();
  scheduleRender();
}

async function setupGatt(dev) {
  log('Verbinde mit dem Rad …');
  server = await dev.gatt.connect();
  const svc = await server.getPrimaryService(SERVICE);
  notifyChar = await svc.getCharacteristic(CHAR_NOTIFY);
  try {
    writeChar = await svc.getCharacteristic(CHAR_WRITE);
  } catch (_) {
    writeChar = null;
    log('Kanal FF02 zum Senden nicht gefunden. Nur Anzeige möglich.');
  }
  notifyChar.removeEventListener('characteristicvaluechanged', onValue);
  notifyChar.addEventListener('characteristicvaluechanged', onValue);
  assembler.reset();
  await notifyChar.startNotifications();
  log('Benachrichtigungen auf FF01 eingeschaltet.');
}

function onGattDisconnected() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  if (userDisconnect) {
    state.link = 'idle';
    state.data = null;
    scheduleRender();
    return;
  }
  if (state.link !== 'connected') return;
  log('Verbindung zum Rad verloren.');
  state.data = null;
  state.link = 'idle';
  state.message = tr('Die Verbindung zum Rad wurde getrennt.', 'The connection to the bike was lost.');
  startReconnect();
  scheduleRender();
}

function startReconnect() {
  if (!device) return;
  state.reconnecting = true;
  const until = Date.now() + RECONNECT_FOR_MS;
  const tryOnce = async () => {
    if (!state.reconnecting || userDisconnect) return;
    if (Date.now() > until) {
      state.reconnecting = false;
      scheduleRender();
      return;
    }
    log('Versuche automatisch, das Rad wieder zu verbinden.');
    try {
      state.link = 'connecting';
      scheduleRender();
      await setupGatt(device);
      state.link = 'connected';
      state.reconnecting = false;
      state.message = null;
      armWatchdog();
      requestWakeLock();
      scheduleRender();
    } catch (e) {
      log('Wiederverbinden nicht geklappt: ' + (e?.message ?? e));
      state.link = 'idle';
      scheduleRender();
      reconnectTimer = setTimeout(tryOnce, RECONNECT_EVERY_MS);
    }
  };
  reconnectTimer = setTimeout(tryOnce, 2000);
}

async function disconnect() {
  userDisconnect = true;
  state.reconnecting = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (watchdog) clearTimeout(watchdog);
  try {
    device?.gatt?.disconnect();
  } catch (_) {
    // schon getrennt
  }
  state.link = 'idle';
  state.data = null;
  releaseWakeLock();
  scheduleRender();
}

function armWatchdog() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (state.link !== 'connected') return;
    log(`Seit ${NO_DATA_MS / 1000} Sekunden keine Daten.`);
    fail(tr(
      'Kommunikationsfehler: Das Rad sendet keine Daten. Bitte das Rad aus- und wieder einschalten.',
      'Communication error: the bike is not sending data. Please turn the bike off and on again.',
    ));
    try {
      device?.gatt?.disconnect();
    } catch (_) {
      // egal
    }
  }, NO_DATA_MS);
}

// ------------------------------------------------------------ Daten vom Rad

let garbageInRow = 0;

function onValue(event) {
  const dv = event.target.value;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  let result;
  try {
    result = assembler.push(bytes);
  } catch (e) {
    log('Fehler beim Entschlüsseln: ' + (e?.message ?? e));
    return;
  }
  if (!result) return;
  if (result.kind === FrameKind.garbage) {
    garbageInRow++;
    log(`Kein lesbarer Text nach dem Entschlüsseln (Nr. ${garbageInRow}).`);
    if (garbageInRow >= 5) {
      state.message = tr(
        'Die Daten vom Rad lassen sich nicht lesen. Bitte das Protokoll unter "Diagnose" weitergeben.',
        'The data from the bike cannot be read. Please pass on the log under "Diagnostics".',
      );
      scheduleRender();
    }
    return;
  }
  if (result.kind === FrameKind.reset) {
    log('Puffer zu groß, wurde geleert.');
    return;
  }
  onFrame(result);
}

let lastLoggedText = null;

function onFrame(result) {
  garbageInRow = 0;
  state.data = result.data;
  state.message = null;
  if (result.text !== lastLoggedText) {
    lastLoggedText = result.text;
    log('Entschlüsselt: ' + result.text);
  }
  if (gearTarget !== null && result.data.gear === gearTarget && gearWaiter) {
    gearWaiter();
  }
  armWatchdog();
  scheduleRender();
}

// ------------------------------------------------------------ Bildschirm anlassen

async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator) || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    state.lockOn = true;
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      state.lockOn = false;
      scheduleRender();
    });
    scheduleRender();
  } catch (_) {
    // Bildschirm kann dann ausgehen
  }
}

function releaseWakeLock() {
  try {
    wakeLock?.release();
  } catch (_) {
    // egal
  }
  wakeLock = null;
  state.lockOn = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.link === 'connected') requestWakeLock();
});

// ------------------------------------------------------------ Fahrstufe

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendEncrypted(json, style) {
  const encrypted = encryptCommand(des, json, style);
  const withoutResponse = writeChar.properties.writeWithoutResponse && !!writeChar.writeValueWithoutResponse;
  const chunks = splitForBle(encrypted);
  for (let i = 0; i < chunks.length; i++) {
    if (withoutResponse) await writeChar.writeValueWithoutResponse(chunks[i]);
    else await writeChar.writeValue(chunks[i]);
    if (i < chunks.length - 1) await sleep(CHUNK_PAUSE_MS);
  }
}

async function setGear(gear) {
  const d = state.data;
  if (state.link !== 'connected' || !writeChar || !des || state.pendingGear !== null) return;
  if (!d) {
    state.message = tr('Noch keine Daten vom Rad. Bitte kurz warten.', 'No data from the bike yet. Please wait a moment.');
    scheduleRender();
    return;
  }
  if (d.gear === gear) return;
  if (!isSafeCommandValue(d.defaultMode) || !isSafeCommandValue(d.firmware)) {
    state.message = tr(
      'Die Daten vom Rad sind unvollständig, es wird nichts gesendet.',
      'The data from the bike is incomplete, nothing will be sent.',
    );
    log(`Senden abgebrochen: md=${d.defaultMode} ve=${d.firmware}`);
    scheduleRender();
    return;
  }
  const json = buildGearCommand({
    gear,
    light: String(d.light ?? 0),
    mode: d.defaultMode,
    firmware: d.firmware,
  });
  state.pendingGear = gear;
  state.message = null;
  scheduleRender();
  const order = [...(workingPad ? [workingPad] : []), ...PAD_ORDER.filter((s) => s !== workingPad)];
  try {
    for (const style of order) {
      if (state.link !== 'connected') return;
      let confirmed = false;
      const waiter = new Promise((resolve) => {
        gearWaiter = () => {
          confirmed = true;
          resolve();
        };
      });
      gearTarget = gear;
      log(`Sende Fahrstufe ${gear} (Auffüllen: ${style}): ${json}`);
      await sendEncrypted(json, style);
      await Promise.race([waiter, sleep(GEAR_CONFIRM_MS)]);
      gearWaiter = null;
      gearTarget = null;
      if (confirmed) {
        workingPad = style;
        log(`Das Rad hat Fahrstufe ${gear} übernommen (Auffüllen: ${style}).`);
        return;
      }
      log(`Keine Reaktion des Rads (Auffüllen: ${style}).`);
    }
    state.message = tr(
      'Das Rad hat die Fahrstufe nicht übernommen. Bitte das Protokoll unter "Diagnose" weitergeben.',
      'The bike did not accept the assist level. Please pass on the log under "Diagnostics".',
    );
  } catch (e) {
    log('Fehler beim Senden: ' + (e?.message ?? e));
    state.message = tr('Senden hat nicht geklappt. Bitte erneut versuchen.', 'Sending failed. Please try again.');
  } finally {
    gearWaiter = null;
    gearTarget = null;
    state.pendingGear = null;
    scheduleRender();
  }
}

// ------------------------------------------------------------ Anzeige

const $app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function pill() {
  const map = {
    idle: [state.reconnecting ? tr('Suche läuft …', 'Searching …') : tr('Nicht verbunden', 'Not connected'), '#8a8a8e'],
    connecting: [tr('Verbinde …', 'Connecting …'), '#ffb74d'],
    connected: [tr('Verbunden', 'Connected'), '#69f0ae'],
    error: [tr('Fehler', 'Error'), '#ff5252'],
  };
  const [text, color] = map[state.link];
  return `<div class="center"><span class="pill" style="color:${color}">${esc(text)}</span></div>`;
}

const FLAG_DE = '<svg viewBox="0 0 42 28" width="42" height="28"><rect width="42" height="9.4" fill="#000"/><rect y="9.3" width="42" height="9.4" fill="#DD0000"/><rect y="18.6" width="42" height="9.4" fill="#FFCE00"/></svg>';
const FLAG_EN = '<svg viewBox="0 0 42 28" width="42" height="28"><rect width="42" height="28" fill="#012169"/><path d="M0 0L42 28M42 0L0 28" stroke="#fff" stroke-width="6.2"/><path d="M0 0L42 28M42 0L0 28" stroke="#C8102E" stroke-width="2.2"/><path d="M21 0V28M0 14H42" stroke="#fff" stroke-width="10"/><path d="M21 0V28M0 14H42" stroke="#C8102E" stroke-width="5.6"/></svg>';

function langRow() {
  return `<div class="lang">
    <button class="flag${english ? '' : ' sel'}" data-act="lang-de" aria-label="Deutsch">${FLAG_DE}</button>
    <button class="flag${english ? ' sel' : ''}" data-act="lang-en" aria-label="English">${FLAG_EN}</button>
  </div>`;
}

function connectView() {
  const busy = state.link === 'connecting' || state.reconnecting;
  const supported = !!navigator.bluetooth;
  return `
    ${busy
      ? `<div class="center busy"><span class="spin"></span> ${esc(state.reconnecting ? tr('Suche nach dem Rad …', 'Searching for the bike …') : tr('Verbinde mit dem Rad …', 'Connecting to the bike …'))}</div>`
      : `<button class="btn primary" data-act="connect" ${supported ? '' : 'disabled'}>${esc(tr('Rad suchen', 'Find bike'))}</button>
         <button class="link dim" data-act="connect-all">${esc(tr('Alle Geräte anzeigen', 'Show all devices'))}</button>`}
    ${state.reconnecting ? `<button class="link dim" data-act="disconnect">${esc(tr('Suche abbrechen', 'Cancel search'))}</button>` : ''}
    ${supported ? '' : `<div class="msg">${esc(tr('Dieser Browser kann kein Bluetooth. Bitte diese Seite in der App "Bluefy" öffnen.', 'This browser cannot use Bluetooth. Please open this page in the "Bluefy" app.'))}</div>`}
    <div class="faint center small">${esc(tr('Die Seite muss geöffnet und der Bildschirm an bleiben, damit die Verbindung hält.', 'Keep this page open and the screen on so the connection stays alive.'))}</div>
    ${langRow()}`;
}

function liveView() {
  const d = state.data;
  if (!d) {
    return `<div class="center wait"><span class="spin big"></span><div>${esc(tr('Warte auf Daten vom Rad …', 'Waiting for data from the bike …'))}</div>
      <button class="btn" data-act="disconnect">${esc(tr('Trennen', 'Disconnect'))}</button></div>`;
  }
  const pct = d.battery === null ? 0 : d.battery;
  // Grün über 50 %, Orange bis 21 %, ab 20 % abwärts Rot.
  const barColor = pct > 50 ? '#69f0ae' : pct > 20 ? '#ffb74d' : '#ff5252';
  const gearLabel = { 0: tr('Unterstützung aus', 'Assist off'), 1: 'Eco', 2: 'Normal', 3: 'Sport' }[d.gear] ?? tr('Unbekannt', 'Unknown');
  const canSend = !!writeChar && state.pendingGear === null;
  const buttons = [[0, 'N'], [1, 'Eco'], [2, 'Normal'], [3, 'Sport']]
    .map(([g, label]) => (d.gear === g
      ? `<button class="gbtn cur" disabled>${label}</button>`
      : `<button class="gbtn" data-act="gear" data-gear="${g}" ${canSend ? '' : 'disabled'}>${label}</button>`))
    .join('');
  return `
    <div class="dial"><div class="sym">${esc(gearSymbol(d.gear))}</div><div class="faint">${esc(gearLabel)}</div></div>
    <div class="gears">${buttons}</div>
    ${state.pendingGear !== null ? `<div class="center pending">${esc(tr('Fahrstufe wird gesetzt …', 'Setting assist level …'))}</div>` : ''}
    <div class="row top"><span class="small">${esc(tr('Akku', 'Battery'))}</span><b class="small">${d.battery === null ? '–' : d.battery + ' %'}</b></div>
    <div class="bar"><div style="width:${pct}%;background:${barColor}"></div></div>
    <button class="btn plain" data-act="disconnect">${esc(tr('Trennen', 'Disconnect'))}</button>
    ${state.lockOn ? '' : `<div class="faint small center">${esc(tr('Hinweis: Der Bildschirm kann ausgehen. Dann trennt iOS die Verbindung.', 'Note: the screen may turn off. iOS then drops the connection.'))}</div>`}`;
}

function diagnose() {
  const text = state.log.length ? state.log.join('\n') : tr('Noch keine Einträge.', 'No entries yet.');
  return `<details id="diag" ${logOpen ? 'open' : ''}><summary>${esc(tr('Diagnose', 'Diagnostics'))}</summary>
    <pre>${esc(text)}</pre>
    <button class="btn outline" data-act="copy-log">${esc(tr('Protokoll kopieren', 'Copy log'))}</button></details>`;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/** Gleicht das vorhandene DOM mit dem neuen ab, ohne Elemente neu zu bauen.
 *  So gehen Tipper auf Tasten nicht verloren, wenn gerade neue Daten kommen. */
function syncAttrs(o, n) {
  for (const a of Array.from(o.attributes)) {
    if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  }
  for (const a of Array.from(n.attributes)) {
    if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  }
}

function patch(oldEl, newEl) {
  const oc = Array.from(oldEl.childNodes);
  const nc = Array.from(newEl.childNodes);
  const max = Math.max(oc.length, nc.length);
  for (let i = 0; i < max; i++) {
    const o = oc[i];
    const n = nc[i];
    if (!n) {
      oldEl.removeChild(o);
    } else if (!o) {
      oldEl.appendChild(n.cloneNode(true));
    } else if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) {
      oldEl.replaceChild(n.cloneNode(true), o);
    } else if (o.nodeType === 3) {
      if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
    } else if (o.nodeType === 1) {
      syncAttrs(o, n);
      patch(o, n);
    }
  }
}

function render() {
  document.documentElement.lang = english ? 'en' : 'de';
  const pre0 = document.querySelector('#diag pre');
  const atBottom = !pre0 || pre0.scrollTop + pre0.clientHeight >= pre0.scrollHeight - 20;
  const html = `
    ${pill()}
    ${state.message ? `<div class="msg">${esc(state.message)}</div>` : ''}
    ${state.link === 'connected' ? liveView() : connectView()}
    ${diagnose()}
    <div class="faint small center foot">${esc(tr('Gesendet wird nur die Fahrstufe, wenn du sie antippst.', 'The only thing sent to the bike is the assist level you tap.'))}</div>`;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  patch($app, tpl.content);
  const pre = document.querySelector('#diag pre');
  if (pre && atBottom) pre.scrollTop = pre.scrollHeight;
}

// ------------------------------------------------------------ Bedienung

document.addEventListener('toggle', (e) => {
  if (e.target && e.target.id === 'diag') logOpen = e.target.open;
}, true);

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  switch (el.dataset.act) {
    case 'connect': await connect(false); break;
    case 'connect-all': await connect(true); break;
    case 'disconnect': await disconnect(); break;
    case 'gear': await setGear(Number(el.dataset.gear)); break;
    case 'lang-de':
    case 'lang-en':
      english = el.dataset.act === 'lang-en';
      store.set('lang', english ? 'en' : 'de');
      scheduleRender();
      break;
    case 'copy-log':
      try {
        await navigator.clipboard.writeText(state.log.join('\n'));
        alertBox(tr('Protokoll kopiert', 'Log copied'));
      } catch (_) {
        alertBox(tr('Kopieren nicht möglich. Text markieren und kopieren.', 'Copying failed. Select the text and copy it.'));
      }
      break;
    default:
  }
});

function alertBox(text) {
  state.message = text;
  scheduleRender();
  setTimeout(() => {
    if (state.message === text) {
      state.message = null;
      scheduleRender();
    }
  }, 2500);
}

// Für Tests von außen (nur Lesen).
window.__ebike = { state };

render();
