// Kernlogik der eBike-App für den Browser (Bluefy). Eins zu eins aus der
// Dart-App übernommen: Protokoll, Befehle, Zähler, Reichweite, Warnung.
// Diese Datei kennt weder Bluetooth noch Bildschirm und lässt sich testen.

import { Des } from './des.js';

export { Des };

// ------------------------------------------------------------ Protokoll

/** Der Schlüssel besteht aus den letzten 8 Zeichen des Bluetooth-Namens. */
export function keyFromBluetoothName(name) {
  const n = String(name ?? '').trim();
  return n.length < 8 ? null : n.slice(n.length - 8);
}

/** Zeigt einen Namen so an, dass der Schlüssel nicht lesbar ist. */
export function maskedBikeName(name) {
  const n = String(name ?? '').trim();
  if (n.length <= 8) return '•'.repeat(n.length);
  return n.slice(0, n.length - 8) + '•'.repeat(8);
}

export function desFromKeyText(keyText) {
  const bytes = new Uint8Array(keyText.length);
  for (let i = 0; i < keyText.length; i++) bytes[i] = keyText.charCodeAt(i) & 0xff;
  return new Des(bytes);
}

function asIntOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function asStringOrNull(v) {
  return v === null || v === undefined ? null : String(v);
}

/** Die Werte, die das Rad meldet. Fehlende Werte sind null. */
export function bikeDataFromJson(json) {
  let info = {};
  const da = json?.da;
  if (Array.isArray(da) && da.length > 0 && da[0] && typeof da[0] === 'object') {
    info = da[0];
  }
  const be = asIntOrNull(info.be);
  const sp = asIntOrNull(info.sp);
  return {
    battery: be === null ? null : Math.max(0, Math.min(100, be)),
    // Das Rad sendet die Geschwindigkeit in Zehntel km/h.
    speedKmh: sp === null ? null : sp / 10.0,
    power: asIntOrNull(info.po),
    gear: asIntOrNull(info.ge),
    light: asIntOrNull(info.lt),
    driving: asIntOrNull(info.st),
    defaultMode: asStringOrNull(json?.md),
    firmware: asStringOrNull(json?.ve),
    status: asStringOrNull(json?.su),
    errorValue: asStringOrNull(json?.me),
  };
}

/** Kurzzeichen der Fahrstufe: N, 1, 2, S. */
export function gearSymbol(gear) {
  return { 0: 'N', 1: '1', 2: '2', 3: 'S' }[gear] ?? '–';
}

export const FrameKind = Object.freeze({ frame: 'frame', garbage: 'garbage', reset: 'reset' });

/** Sammelt die Stücke des Rads und liefert fertige Antworten. */
export class FrameAssembler {
  static maxBufferBytes = 1024;
  static frameStart = '{"da"';

  constructor(des) {
    this.des = des;
    this.buffer = [];
  }

  /** Nimmt ein Stück entgegen. Gibt null zurück, solange noch Daten fehlen. */
  push(chunk) {
    for (const b of chunk) this.buffer.push(b);
    if (this.buffer.length > FrameAssembler.maxBufferBytes) {
      this.buffer = [];
      return { kind: FrameKind.reset };
    }
    const usable = this.buffer.length - (this.buffer.length % 8);
    if (usable < 8) return null;
    const plain = this.des.decryptEcb(Uint8Array.from(this.buffer.slice(0, usable)));
    let text = '';
    for (const b of plain) text += String.fromCharCode(b);
    if (!text.startsWith(FrameAssembler.frameStart)) {
      this.buffer = [];
      return { kind: FrameKind.garbage };
    }
    // Das Rad hängt nach der letzten Klammer Füllzeichen an.
    const last = text.lastIndexOf('}');
    if (last < 0) return null;
    const candidate = text.slice(0, last + 1);
    try {
      const decoded = JSON.parse(candidate);
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        this.buffer = [];
        return { kind: FrameKind.frame, text: candidate, data: bikeDataFromJson(decoded) };
      }
    } catch (_) {
      // Das JSON ist noch nicht vollständig. Auf weitere Stücke warten.
    }
    return null;
  }

  reset() {
    this.buffer = [];
  }
}

// ------------------------------------------------------------ Befehle

export const PadStyle = Object.freeze({ digit: 'digit', zero: 'zero', pkcs7: 'pkcs7' });
export const PAD_ORDER = [PadStyle.digit, PadStyle.zero, PadStyle.pkcs7];

const SAFE_VALUE = /^[A-Za-z0-9._-]{1,16}$/;

/** Werte aus der letzten Antwort dürfen nur harmlose Zeichen enthalten. */
export function isSafeCommandValue(v) {
  return typeof v === 'string' && SAFE_VALUE.test(v);
}

/** Baut den Befehl für die Fahrstufe (Reihenfolge der Felder wie im SDK). */
export function buildGearCommand({ gear, light, mode, firmware }) {
  return `{"lt":"${light}","st":"1","ge":"${gear}","md":"${mode}","ve":"${firmware}"}`;
}

/** Füllt den Text auf ein Vielfaches von 8 Bytes auf. */
export function padCommand(text, style) {
  const bytes = new TextEncoder().encode(text);
  const rest = (8 - (bytes.length % 8)) % 8;
  let count;
  let fill;
  if (style === PadStyle.digit) {
    count = rest;
    fill = 0x30 + rest;
  } else if (style === PadStyle.zero) {
    count = rest;
    fill = 0;
  } else {
    count = rest === 0 ? 8 : rest;
    fill = count;
  }
  const out = new Uint8Array(bytes.length + count);
  out.set(bytes, 0);
  out.fill(fill, bytes.length);
  return out;
}

export function encryptCommand(des, text, style) {
  return des.encryptEcb(padCommand(text, style));
}

/** Teilt Daten in 20-Byte-Stücke für Bluetooth. */
export function splitForBle(data, size = 20) {
  const out = [];
  for (let i = 0; i < data.length; i += size) out.push(data.slice(i, Math.min(i + size, data.length)));
  return out;
}

// ------------------------------------------------------------ Zähler

/** Tageskilometer / Gesamtkilometer: Strecke und Fahrzeit aus der Geschwindigkeit. */
export class TripMeter {
  static maxGapMs = 5000;
  static movingThresholdKmh = 0.5;

  constructor() {
    this.distanceKm = 0;
    this.movingMs = 0;
    this.lastAt = null;
    this.lastSpeed = null;
  }

  get averageKmh() {
    const h = this.movingMs / 3600000;
    return h <= 0 ? null : this.distanceKm / h;
  }

  restore(distanceKm, movingMs) {
    this.distanceKm = distanceKm > 0 ? distanceKm : 0;
    this.movingMs = movingMs > 0 ? movingMs : 0;
    this.breakLink();
  }

  /** nowMs: Zeit in Millisekunden. */
  addSample(speedKmh, nowMs) {
    if (this.lastAt !== null && this.lastSpeed !== null) {
      let gap = nowMs - this.lastAt;
      if (gap < 0) gap = 0;
      if (gap > TripMeter.maxGapMs) gap = TripMeter.maxGapMs;
      const avg = (this.lastSpeed + speedKmh) / 2;
      this.distanceKm += avg * (gap / 3600000);
      if (avg > TripMeter.movingThresholdKmh) this.movingMs += gap;
    }
    this.lastAt = nowMs;
    this.lastSpeed = speedKmh;
  }

  breakLink() {
    this.lastAt = null;
    this.lastSpeed = null;
  }

  reset() {
    this.distanceKm = 0;
    this.movingMs = 0;
    this.breakLink();
  }
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

// ------------------------------------------------------------ Reichweite

/** Schätzt die Restreichweite aus dem Akkuverbrauch pro Kilometer. */
export class RangeEstimator {
  static priorWeightKm = 3.0;
  static minSpanKm = 1.5;
  static minDropPercent = 4;
  static windowKm = 8.0;
  static chargeRisePercent = 5;

  constructor(priorPctPerKm = null) {
    this.priorPctPerKm = priorPctPerKm;
    this.points = [];
  }

  addSample(odometerKm, percent) {
    if (this.points.length > 0) {
      let minPct = this.points[0].percent;
      for (const p of this.points) if (p.percent < minPct) minPct = p.percent;
      if (percent - minPct >= RangeEstimator.chargeRisePercent) this.points = [];
    }
    if (this.points.length === 0 || this.points[this.points.length - 1].percent !== percent) {
      this.points.push({ km: odometerKm, percent });
    }
    while (this.points.length > 2 && odometerKm - this.points[0].km > RangeEstimator.windowKm) {
      this.points.shift();
    }
  }

  clear() {
    this.points = [];
  }

  get spanKm() {
    return this.points.length < 2 ? 0 : this.points[this.points.length - 1].km - this.points[0].km;
  }

  get dropPercent() {
    return this.points.length < 2 ? 0 : this.points[0].percent - this.points[this.points.length - 1].percent;
  }

  get pctPerKm() {
    const span = this.spanKm;
    const drop = this.dropPercent;
    const prior = this.priorPctPerKm;
    if (prior !== null && prior > 0) {
      if (span > 0 && drop > 0) {
        return (prior * RangeEstimator.priorWeightKm + drop) / (RangeEstimator.priorWeightKm + span);
      }
      return prior;
    }
    if (span >= RangeEstimator.minSpanKm && drop >= RangeEstimator.minDropPercent) return drop / span;
    return null;
  }

  get learnedPctPerKm() {
    if (this.spanKm >= 3.0 && this.dropPercent >= RangeEstimator.minDropPercent) {
      return this.dropPercent / this.spanKm;
    }
    return null;
  }

  rangeKm(percent) {
    const rate = this.pctPerKm;
    if (rate === null || rate <= 0.0001) return null;
    const km = percent / rate;
    return km > 200 ? 200 : km;
  }
}

/** Lernt den Verbrauch je Fahrstufe (Eco, Normal, Sport). */
export class GearConsumption {
  static gears = [1, 2, 3];
  static minKm = 2.0;
  static minPercent = 3.0;
  static settleKm = 1.5;
  static chargeRise = 5;
  static halveAboveKm = 40.0;

  constructor() {
    this.km = { 1: 0, 2: 0, 3: 0 };
    this.pct = { 1: 0, 2: 0, 3: 0 };
    this.floor = null;
    this.settleLeft = 0;
  }

  /** Wurde zwischenzeitlich geladen? */
  markCharged() {
    this.settleLeft = GearConsumption.settleKm;
    this.floor = null;
  }

  addSample({ gear, battery, deltaKm }) {
    let floor = this.floor ?? battery;
    if (battery - floor >= GearConsumption.chargeRise) {
      floor = battery;
      this.settleLeft = GearConsumption.settleKm;
    }
    const settling = this.settleLeft > 0;
    if (this.settleLeft > 0 && deltaKm > 0) {
      this.settleLeft -= deltaKm;
      if (this.settleLeft < 0) this.settleLeft = 0;
    }
    const g = gear;
    const tracked = g !== null && g !== undefined && Object.prototype.hasOwnProperty.call(this.km, g);
    if (battery < floor) {
      const drop = floor - battery;
      floor = battery;
      if (tracked && !settling) this.pct[g] += drop;
    }
    this.floor = floor;
    if (tracked && !settling && deltaKm > 0) {
      this.km[g] += deltaKm;
      if (this.km[g] > GearConsumption.halveAboveKm) {
        this.km[g] /= 2;
        this.pct[g] /= 2;
      }
    }
  }

  learnedKm(gear) {
    return this.km[gear] ?? 0;
  }

  pctPerKm(gear) {
    const km = this.km[gear] ?? 0;
    const pct = this.pct[gear] ?? 0;
    if (km < GearConsumption.minKm || pct < GearConsumption.minPercent) return null;
    return pct / km;
  }

  rangeKm(gear, battery) {
    const rate = this.pctPerKm(gear);
    if (rate === null || rate <= 0.0001) return null;
    const km = battery / rate;
    return km > 200 ? 200 : km;
  }

  encode() {
    const m = {};
    for (const g of GearConsumption.gears) m[String(g)] = [this.km[g], this.pct[g]];
    return JSON.stringify(m);
  }

  restore(text) {
    if (!text) return;
    try {
      const d = JSON.parse(text);
      if (!d || typeof d !== 'object' || Array.isArray(d)) return;
      for (const g of GearConsumption.gears) {
        const v = d[String(g)];
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
          if (v[0] >= 0 && v[1] >= 0) {
            this.km[g] = v[0];
            this.pct[g] = v[1];
          }
        }
      }
    } catch (_) {
      // Unlesbare Daten: von vorn anfangen.
    }
  }
}

// ------------------------------------------------------------ Warnung

/** Warnt einmal bei 15 % und ist erst ab 20 % wieder scharf. */
export class BatteryAlert {
  static threshold = 15;
  static rearm = 20;

  constructor() {
    this.armed = true;
  }

  /** Gibt true zurück, wenn jetzt gewarnt werden soll. */
  update(battery) {
    if (battery >= BatteryAlert.rearm) {
      this.armed = true;
      return false;
    }
    if (battery <= BatteryAlert.threshold && this.armed) {
      this.armed = false;
      return true;
    }
    return false;
  }
}

// ------------------------------------------------------------ Standort

/** Entfernung zwischen zwei Punkten in Metern (Haversine). */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const r = 6371000.0;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}
