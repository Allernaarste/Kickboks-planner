/**
 * parse.mjs — pure parse-/heuristiekfuncties van de rooster-scraper.
 * Gescheiden van fetch-schedules.mjs zodat ze lokaal testbaar zijn zonder Playwright.
 */

// ── Parse-helpers ──────────────────────────────────────────────────

const DAY_MAP = {
  zondag:0, sunday:0, zon:0, sun:0, zo:0, su:0,
  maandag:1, monday:1, maa:1, mon:1, ma:1, mo:1,
  dinsdag:2, tuesday:2, din:2, tue:2, di:2, tu:2,
  woensdag:3, wednesday:3, woe:3, wed:3, wo:3, we:3,
  donderdag:4, thursday:4, don:4, thu:4, do:4, th:4,
  vrijdag:5, friday:5, vri:5, fri:5, vr:5, fr:5,
  zaterdag:6, saturday:6, zat:6, sat:6, za:6, sa:6,
};

export function parseDay(s) {
  if (s == null) return null;
  if (typeof s === 'number' && s >= 0 && s <= 7) return s % 7; // 7 = zondag bij sommige API's
  const key = String(s).trim().toLowerCase().replace(/[^a-z]/g, '');
  for (const [k, v] of Object.entries(DAY_MAP)) {
    if (key === k || key.startsWith(k)) return v;
  }
  return null;
}

export function parseTime(s) {
  if (s == null) return null;
  const m = String(s).match(/(\d{1,2})[:.uh](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2];
  const ap = m[3]?.toLowerCase();
  if (ap?.startsWith('p') && h < 12) h += 12;
  if (ap?.startsWith('a') && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2,'0')}:${m[2]}`;
}

export function parseDateTime(v) {
  // Epoch (s of ms) of ISO-achtige datum → { day, time }
  if (v == null) return null;
  let d = null;
  if (typeof v === 'number') d = new Date(v > 1e12 ? v : v * 1000);
  else if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(v)) d = new Date(v.replace(' ', 'T'));
  if (!d || isNaN(d)) return null;
  const y = d.getFullYear();
  if (y < 2020 || y > 2035) return null;
  return {
    day:  d.getDay(),
    time: `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
  };
}

export function parseDur(s) {
  if (s == null) return 60;
  const m = String(s).match(/(\d+)/);
  const n = m ? +m[1] : 60;
  return n >= 15 && n <= 240 ? n : 60;
}


export const MIN_CLASSES = 3;
export const MIN_DAYS    = 2;

// Exacte dagnaam (voor ruisfilter; parseDay matcht ook prefixen)
export function isDayWord(s) {
  const key = String(s ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return key in DAY_MAP;
}

export function dedupe(classes) {
  const seen = new Set();
  return classes.filter(c => {
    const k = `${c.day}|${c.time}|${c.type.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function isValidSchedule(classes) {
  if (classes.length < MIN_CLASSES) return false;
  return new Set(classes.map(c => c.day)).size >= MIN_DAYS;
}

// ── Heuristiek: les-achtige objecten in willekeurige JSON ──────────

const NAME_FIELDS  = ['name','title','activity_name','class_name','activityName','className','lesson','activity','event_name','les'];
const START_FIELDS = ['start','start_time','startTime','starttime','start_at','startAt','start_date','startDate','start_datetime','startDateTime','begin','from','time','starts_at','datetime','date_time'];
const DAY_FIELDS   = ['day_of_week','dayOfWeek','day','weekday','week_day','dag'];
const DUR_FIELDS   = ['duration','length','dur','duration_in_minutes','minutes'];
const END_FIELDS   = ['end','end_time','endTime','end_at','until','till','to'];
const LVL_FIELDS   = ['level','difficulty','niveau','subtitle','sub_title'];

const pick = (o, fields) => {
  for (const f of fields) if (o[f] != null && o[f] !== '') return o[f];
  return null;
};

export function classFromObject(o) {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const name = pick(o, NAME_FIELDS);
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return null;

  let day = null, time = null, dur = null;
  const start = pick(o, START_FIELDS);
  const dt = parseDateTime(start);
  if (dt) ({ day, time } = dt);
  if (time == null) time = parseTime(start);
  if (day == null) day = parseDay(pick(o, DAY_FIELDS));
  if (day == null || time == null) return null;

  const end = pick(o, END_FIELDS);
  const endDt = parseDateTime(end);
  if (endDt && dt) {
    const [h1,m1] = time.split(':').map(Number);
    const [h2,m2] = endDt.time.split(':').map(Number);
    const diff = (h2*60+m2) - (h1*60+m1);
    if (diff >= 15 && diff <= 240) dur = diff;
  }
  if (dur == null) dur = parseDur(pick(o, DUR_FIELDS));

  const level = String(pick(o, LVL_FIELDS) ?? '').trim().slice(0, 40);
  return { day, time, dur, type: name.trim().slice(0, 50), level };
}

// Doorzoek geneste JSON op arrays met les-achtige objecten
export function extractClassesFromJSON(node, depth = 0) {
  if (depth > 6 || node == null) return [];
  if (Array.isArray(node)) {
    const direct = node.map(classFromObject).filter(Boolean);
    if (direct.length >= 2) return direct;
    return node.flatMap(x => extractClassesFromJSON(x, depth + 1));
  }
  if (typeof node === 'object') {
    return Object.values(node).flatMap(x => extractClassesFromJSON(x, depth + 1));
  }
  return [];
}


export function finishClasses(raw, prefix) {
  const cleaned = raw
    .map(r => ({
      day:   r.day,
      time:  parseTime(r.time),
      dur:   r.dur ?? 60,
      type:  String(r.type ?? r.name ?? '').replace(/\s+/g, ' ').trim(),
      level: String(r.level ?? '').trim(),
    }))
    .filter(c => c.day != null && c.time && c.type && c.type.length > 1)
    // ruis: regels die zelf een dagnaam of puur nummer zijn
    .filter(c => !isDayWord(c.type) && !/^\d+$/.test(c.type))
    // ruis: datumkoppen ("Vrijdag 17 juni"), kale kopjes, voetnoten, te lange teksten
    .filter(c => !/^(zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(c.type))
    .filter(c => !/^groepsless?en$/i.test(c.type))
    .filter(c => !c.type.startsWith('*') && c.type.length <= 70);
  const unique = dedupe(cleaned)
    .sort((a, b) => (a.day - b.day) || a.time.localeCompare(b.time))
    .map((c, i) => ({ id: `${prefix}${String(i + 1).padStart(2, '0')}`, ...c }));
  return unique;
}

