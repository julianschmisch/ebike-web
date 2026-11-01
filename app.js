// eBike App für den Browser (Bluefy auf dem iPhone). Spricht per Web Bluetooth
// mit dem Rad. Die Logik steckt in core.js, hier sind Bluetooth und Bildschirm.

import {
  desFromKeyText, keyFromBluetoothName, maskedBikeName, FrameAssembler, FrameKind,
  gearSymbol, buildGearCommand, encryptCommand, splitForBle, PAD_ORDER, isSafeCommandValue,
  TripMeter, formatDuration, RangeEstimator, GearConsumption, BatteryAlert, distanceMeters,
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
  displayName: store.get('bike_name') || '',
  pendingGear: null,
  reconnecting: false,
  lockOn: false,
  locationOk: null,
  parking: loadJson('parking'),
  last: loadJson('last'),
  log: [],
};

const trip = new TripMeter();
trip.restore(store.num('trip_km'), store.num('trip_ms'));
const total = new TripMeter();
total.restore(store.num('total_km'), 0);
const odometer = new TripMeter();
const gearStats = new GearConsumption();
gearStats.restore(store.get('gear_stats'));
const batteryAlert = new BatteryAlert();
batteryAlert.armed = store.get('alert_armed') !== '0';
let storedRate = store.get('pct_per_km') === null ? null : store.num('pct_per_km');
let range = new RangeEstimator(storedRate);
let rangeKm = null;

let device = null;
let server = null;
let writeChar = null;
let notifyChar = null;
let assembler = null;
let des = null;
let watchdog = null;
let userDisconnect = false;
let reconnectTimer = null;
let lastOdo = 0;
let batteryChecked = false;
let lastFix = null;
let fixBusy = false;
let workingPad = null;
let gearWaiter = null;
let gearTarget = null;
let wakeLock = null;
let lastSave = 0;
let logOpen = false;

function loadJson(key) {
  try {
    const t = store.get(key);
    return t ? JSON.parse(t) : null;
  } catch (_) {
    return null;
  }
}

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
  batteryChecked = false;
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
  captureParking();
  saveAll();
  total.breakLink();
  trip.breakLink();
  odometer.breakLink();
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
  const wasConnected = state.link === 'connected';
  if (wasConnected) captureParking();
  saveAll();
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
  const d = result.data;
  state.data = d;
  state.message = null;
  const now = Date.now();
  const speed = d.speedKmh;
  if (speed !== null) {
    trip.addSample(speed, now);
    total.addSample(speed, now);
    odometer.addSample(speed, now);
  }
  const odo = odometer.distanceKm;
  const deltaKm = odo - lastOdo;
  lastOdo = odo;
  const battery = d.battery;
  if (battery !== null) {
    if (!batteryChecked) {
      batteryChecked = true;
      const lb = state.last?.battery;
      if (typeof lb === 'number' && battery - lb >= GearConsumption.chargeRise) gearStats.markCharged();
    }
    gearStats.addSample({ gear: d.gear, battery, deltaKm });
    checkBatteryAlert(battery);
    range.addSample(odo, battery);
    const r = range.rangeKm(battery);
    if (r === null) rangeKm = null;
    else rangeKm = rangeKm === null ? r : rangeKm * 0.85 + r * 0.15;
  }
  state.last = {
    battery: battery ?? state.last?.battery ?? null,
    gear: d.gear ?? state.last?.gear ?? null,
    at: now,
  };
  saveIfDue(now);
  maybeLocate(now, speed);
  if (result.text !== lastLoggedText) {
    lastLoggedText = result.text;
    log('Entschlüsselt: ' + result.text);
  }
  if (gearTarget !== null && d.gear === gearTarget && gearWaiter) {
    gearWaiter();
  }
  armWatchdog();
  scheduleRender();
}

// ------------------------------------------------------------ Speichern

function saveAll() {
  store.set('trip_km', trip.distanceKm);
  store.set('trip_ms', trip.movingMs);
  store.set('total_km', total.distanceKm);
  store.set('gear_stats', gearStats.encode());
  store.set('alert_armed', batteryAlert.armed ? '1' : '0');
  if (state.last) store.set('last', JSON.stringify(state.last));
  const learned = range.learnedPctPerKm;
  if (learned !== null) {
    storedRate = storedRate === null ? learned : storedRate * 0.7 + learned * 0.3;
    store.set('pct_per_km', storedRate);
  }
}

function saveIfDue(now) {
  if (now - lastSave < 5000) return;
  lastSave = now;
  saveAll();
}

// ------------------------------------------------------------ Akkuwarnung

function checkBatteryAlert(battery) {
  const before = batteryAlert.armed;
  if (batteryAlert.update(battery)) {
    log(`Akkuwarnung ausgelöst bei ${battery} %.`);
    beep();
    try {
      navigator.vibrate?.([300, 150, 300]);
    } catch (_) {
      // nicht überall möglich
    }
  }
  if (batteryAlert.armed !== before) store.set('alert_armed', batteryAlert.armed ? '1' : '0');
}

let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {
    // kein Ton möglich
  }
}

function beep() {
  try {
    if (!audioCtx) return;
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.2;
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(audioCtx.currentTime + i * 0.35);
      o.stop(audioCtx.currentTime + i * 0.35 + 0.2);
    }
  } catch (_) {
    // kein Ton möglich
  }
}

// ------------------------------------------------------------ Parkplatz

function getFix() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      state.locationOk = false;
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        state.locationOk = true;
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() });
      },
      (err) => {
        if (err && err.code === 1) state.locationOk = false;
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

function maybeLocate(now, speed) {
  if (fixBusy || state.locationOk === false) return;
  const stale = !lastFix || now - lastFix.at >= 60000;
  if (!stale) return;
  if (!((speed ?? 0) > 3) && lastFix) return;
  fixBusy = true;
  getFix()
    .then((fix) => {
      if (fix) lastFix = fix;
      scheduleRender();
    })
    .finally(() => {
      fixBusy = false;
    });
}

async function captureParking() {
  if (state.locationOk !== true) return;
  const base = lastFix;
  if (base && Date.now() - base.at < 15 * 60000) {
    state.parking = base;
    store.set('parking', JSON.stringify(base));
    scheduleRender();
  }
  const fresh = await getFix();
  if (!fresh) return;
  if (!base || distanceMeters(base.lat, base.lon, fresh.lat, fresh.lon) < 150) {
    state.parking = fresh;
    lastFix = fresh;
    store.set('parking', JSON.stringify(fresh));
    scheduleRender();
  }
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
  if (document.visibilityState === 'hidden') saveAll();
});
window.addEventListener('pagehide', saveAll);

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
const GEAR_NAMES = { 1: 'Eco', 2: 'Normal', 3: 'Sport' };
const bikeTitle = () => state.displayName.trim() || tr('Mein Tsinova-Rad', 'My Tsinova bike');
const fmtKm = (km) => localNum(km >= 1000 ? km.toFixed(0) : km.toFixed(1)) + ' km';
const approx = (km) => `${tr('ca.', 'approx.')} ${Math.round(km)} km`;

function stamp(ms) {
  const at = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const dayDiff = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
      new Date(at.getFullYear(), at.getMonth(), at.getDate())) / 86400000,
  );
  const time = `${two(at.getHours())}:${two(at.getMinutes())}${english ? '' : ' Uhr'}`;
  if (dayDiff === 0) return tr('heute, ', 'today, ') + time;
  if (dayDiff === 1) return tr('gestern, ', 'yesterday, ') + time;
  return `${two(at.getDate())}.${two(at.getMonth() + 1)}.${at.getFullYear()}, ${time}`;
}

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

function gearRangeList(battery, currentGear) {
  if (typeof battery !== 'number') return '';
  const rows = GearConsumption.gears
    .map((g) => {
      const r = gearStats.rangeKm(g, battery);
      const value = r !== null
        ? approx(r)
        : `${tr('lernt noch', 'still learning')} (${localNum(gearStats.learnedKm(g).toFixed(1))} km)`;
      return `<div class="grow${currentGear === g ? ' cur' : ''}"><span>${GEAR_NAMES[g]}</span><b class="${r === null ? 'dim' : ''}">${esc(value)}</b></div>`;
    })
    .join('');
  return `<div class="small">${esc(tr('Reichweite je Fahrstufe', 'Range per assist level'))}</div>${rows}`;
}

function lastCard() {
  const l = state.last;
  if (!l) return '';
  return `<div class="card">
    <b>${esc(tr('Letzter Stand', 'Last status'))}</b>
    <div class="faint">${esc(stamp(l.at))}</div>
    <div class="row"><span>${esc(tr('Akku', 'Battery'))}</span><b>${l.battery === null ? '–' : l.battery + ' %'}</b></div>
    <div class="row"><span>${esc(tr('Tageskilometer', 'Trip distance'))}</span><b>${esc(localNum(trip.distanceKm.toFixed(2)))} km</b></div>
    <div class="row"><span>${esc(tr('Gesamtkilometer', 'Total distance'))}</span><b>${esc(fmtKm(total.distanceKm))}</b></div>
    ${typeof l.battery === 'number' ? gearRangeList(l.battery, l.gear) : ''}
    <button class="link" data-act="reset">${esc(tr('Tageskilometer zurücksetzen', 'Reset trip distance'))}</button>
  </div>`;
}

function parkingCard() {
  const p = state.parking;
  if (!p) return '';
  const url = `https://maps.apple.com/?ll=${p.lat},${p.lon}&q=eBike`;
  return `<div class="card">
    <div class="row"><b>🅿️ ${esc(tr('Rad zuletzt abgestellt', 'Bike last parked'))}</b>
      <button class="x" data-act="forget-parking" aria-label="${esc(tr('Parkplatz vergessen', 'Forget parking spot'))}">✕</button></div>
    <div class="faint">${esc(stamp(p.at))}</div>
    <a class="link" href="${esc(url)}" target="_blank" rel="noopener">🗺️ ${esc(tr('In Karte öffnen', 'Open in map'))}</a>
  </div>`;
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
    ${state.last ? lastCard() : ''}
    ${parkingCard()}
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
  const speed = d.speedKmh === null ? '–' : localNum(d.speedKmh.toFixed(1)) + ' km/h';
  const gearRange = d.gear !== null && d.battery !== null ? gearStats.rangeKm(d.gear, d.battery) : null;
  const shown = gearRange ?? rangeKm;
  const rangeLabel = gearRange !== null && GEAR_NAMES[d.gear]
    ? `${tr('Reichweite', 'Range')} (${GEAR_NAMES[d.gear]})`
    : tr('Reichweite', 'Range');
  const pct = d.battery === null ? 0 : d.battery;
  const barColor = pct > 50 ? '#69f0ae' : pct > 20 ? '#ffb74d' : '#ff5252';
  const gearLabel = { 0: tr('Unterstützung aus', 'Assist off'), 1: 'Eco', 2: 'Normal', 3: 'Sport' }[d.gear] ?? tr('Unbekannt', 'Unknown');
  const canSend = !!writeChar && state.pendingGear === null;
  const buttons = [[0, 'N'], [1, 'Eco'], [2, 'Normal'], [3, 'Sport']]
    .map(([g, label]) => (d.gear === g
      ? `<button class="gbtn cur" disabled>${label}</button>`
      : `<button class="gbtn" data-act="gear" data-gear="${g}" ${canSend ? '' : 'disabled'}>${label}</button>`))
    .join('');
  const low = d.battery !== null && d.battery <= BatteryAlert.threshold;
  return `
    <div class="center title">${esc(bikeTitle())} <button class="x" data-act="rename" aria-label="${esc(tr('Umbenennen', 'Rename'))}">✎</button></div>
    ${low ? `<div class="alert">🔋 ${esc(d.battery === null ? tr('Akku niedrig', 'Battery low') : tr(`Akku niedrig: nur noch ${d.battery} %`, `Battery low: only ${d.battery} % left`))}</div>` : ''}
    <div class="metrics">
      <div><div class="small">${esc(tr('Geschwindigkeit', 'Speed'))}</div><b>${esc(speed)}</b></div>
      <div><div class="small">${esc(tr('Fahrzeit', 'Ride time'))}</div><b>${esc(formatDuration(trip.movingMs))}</b></div>
      <div><div class="small">${esc(tr('Tageskilometer', 'Trip distance'))}</div><b>${esc(localNum(trip.distanceKm.toFixed(2)))} km</b></div>
    </div>
    <div class="dial"><div class="sym">${esc(gearSymbol(d.gear))}</div><div class="faint">${esc(gearLabel)}</div></div>
    <div class="gears">${buttons}</div>
    ${state.pendingGear !== null ? `<div class="center pending">${esc(tr('Fahrstufe wird gesetzt …', 'Setting assist level …'))}</div>` : ''}
    <div class="center small">${esc(d.power === null ? tr('Leistung –', 'Power –') : tr(`Leistung ${d.power} W`, `Power ${d.power} W`))}</div>
    <div class="row top"><span class="small">${esc(tr('Akku', 'Battery'))}</span><b class="small">${d.battery === null ? '–' : d.battery + ' %'}</b></div>
    <div class="bar"><div style="width:${pct}%;background:${barColor}"></div></div>
    <div class="row top"><span class="small">${esc(rangeLabel)}</span><b>${shown === null ? esc(tr('wird ermittelt …', 'being determined …')) : esc(approx(shown))}</b></div>
    ${shown === null ? `<div class="faint small">${esc(tr('Die Schätzung erscheint nach einigen Kilometern Fahrt.', 'The estimate appears after a few kilometres of riding.'))}</div>` : ''}
    <button class="btn outline" data-act="reset">${esc(tr('Tageskilometer zurücksetzen', 'Reset trip distance'))}</button>
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
  unlockAudio();
  switch (el.dataset.act) {
    case 'connect': await connect(false); break;
    case 'connect-all': await connect(true); break;
    case 'disconnect': await disconnect(); break;
    case 'gear': await setGear(Number(el.dataset.gear)); break;
    case 'reset':
      if (confirm(tr('Tageskilometer und Fahrzeit werden auf 0 gesetzt.', 'Trip distance and ride time will be set to 0.'))) {
        trip.reset();
        store.set('trip_km', 0);
        store.set('trip_ms', 0);
        log('Tageskilometer auf 0 gesetzt.');
        scheduleRender();
      }
      break;
    case 'forget-parking':
      state.parking = null;
      store.set('parking', null);
      scheduleRender();
      break;
    case 'rename': {
      const n = prompt(tr('Name des Rads (leer = Standardname)', 'Bike name (empty = default name)'), state.displayName);
      if (n !== null) {
        state.displayName = n.slice(0, 30);
        store.set('bike_name', state.displayName.trim() ? state.displayName.trim() : null);
        scheduleRender();
      }
      break;
    }
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
window.__ebike = { state, trip, total, gearStats, maskedBikeName };

render();
