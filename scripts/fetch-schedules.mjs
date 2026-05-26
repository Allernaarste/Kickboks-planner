/**
 * fetch-schedules.mjs
 *
 * Haalt weekroosters op voor drie kickboks-locaties in Utrecht:
 *
 *   - The Colosseum   → thecolosseum.nl/lesrooster/   (WordPress / custom)
 *   - SB Gym          → sbgym.nl/rooster/             (Virtuagym widget)
 *   - Commit030       → commit-i-do.com/.../rivierenwijk/groepslessen/
 *                                                      (Virtuagym widget)
 *
 * Strategie: Playwright + stealth haalt de pagina op, onderschept *alle*
 * netwerk-responses en bewaart elke JSON die op een rooster lijkt. Faalt
 * dat, dan vallen we terug op DOM-scraping. Faalt dat ook, dan blijven
 * de vorige (handmatig onderhouden) klassen staan — de app toont dus
 * nooit een leeg rooster.
 *
 * Alles wordt uitgebreid gelogd; debug-screenshots + netwerk-dumps gaan
 * naar debug-output/ zodat een gefaalde scrape achteraf gediagnosticeerd
 * kan worden via GitHub Actions Artifacts.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

chromium.use(StealthPlugin());

const OUTPUT = 'schedules.json';
const DEBUG_DIR = 'debug-output';
mkdirSync(DEBUG_DIR, { recursive: true });

// ── Helpers ────────────────────────────────────────────────────────

const DAY_MAP = {
  zo: 0, su: 0, zondag: 0, sunday: 0, sun: 0,
  ma: 1, mo: 1, maandag: 1, monday: 1, mon: 1,
  di: 2, tu: 2, dinsdag: 2, tuesday: 2, tue: 2, tues: 2,
  wo: 3, we: 3, woensdag: 3, wednesday: 3, wed: 3,
  do: 4, th: 4, donderdag: 4, thursday: 4, thu: 4, thur: 4,
  vr: 5, fr: 5, vrijdag: 5, friday: 5, fri: 5,
  za: 6, sa: 6, zaterdag: 6, saturday: 6, sat: 6,
};

function parseDay(s) {
  if (s == null) return null;
  if (typeof s === 'number' && Number.isFinite(s)) {
    if (s >= 0 && s <= 6) return s;
    if (s === 7) return 0; // ISO: 7=Zo
    return null;
  }
  const key = String(s).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return null;
  for (const [k, v] of Object.entries(DAY_MAP)) {
    if (key.startsWith(k)) return v;
  }
  return null;
}

function parseTime(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})[:.h](\d{2})/i);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function parseDur(s) {
  if (s == null) return 60;
  if (typeof s === 'number' && Number.isFinite(s)) {
    if (s > 24 * 60 * 60) return Math.round(s / 1000 / 60);
    if (s > 24 * 60) return Math.round(s / 60);
    return Math.round(s);
  }
  const m = String(s).match(/(\d+)/);
  return m ? +m[1] : 60;
}

function dedupe(classes) {
  const seen = new Set();
  const out = [];
  for (const c of classes) {
    const key = `${c.day}|${c.time}|${(c.type || '').toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function loadOld() {
  if (!existsSync(OUTPUT)) return null;
  try { return JSON.parse(readFileSync(OUTPUT, 'utf8')); } catch (_) { return null; }
}

function saveDebug(name, content) {
  try {
    const path = `${DEBUG_DIR}/${name}`;
    if (typeof content === 'string') writeFileSync(path, content);
    else writeFileSync(path, JSON.stringify(content, null, 2));
  } catch (_) {}
}

// ── Tab-helper: opent pagina + vangt netwerk + bewaart debug ───────

async function openTabWithCapture(browser, url, prefix) {
  const captured = [];     // { url, body }
  const requests = [];     // alle netwerk-URL's voor debug

  const ctx = await browser.newContext({
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' },
  });
  const page = await ctx.newPage();

  page.on('request', req => {
    requests.push(`${req.method()} ${req.url()}`);
  });

  page.on('response', async resp => {
    const u = resp.url();
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    try {
      const text = await resp.text();
      if (text.length > 2_000_000) return;
      let body;
      try { body = JSON.parse(text); } catch { return; }
      captured.push({ url: u, body });
    } catch (_) {}
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Cookie-banner wegklikken
    const cookieSelectors = [
      '#onetrust-accept-btn-handler',
      'button[id*="accept"]',
      'button[class*="accept"]',
      'button[class*="cookie"]',
      '.cookie-accept',
      '[data-accept-cookies]',
      'button:has-text("Accepteren")',
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      'button:has-text("Akkoord")',
      'button:has-text("OK")',
      'a:has-text("Accepteren")',
    ];
    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1200 })) {
          await btn.click({ timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
      } catch (_) {}
    }

    // Geef tijd voor lazy-loaded XHR's en iframes
    await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(2500);

    // Klik "volgende week" zodat de API een tweede week-fetch doet
    for (let i = 0; i < 2; i++) {
      const clicked = await page.evaluate(() => {
        const collect = doc => {
          try {
            return [...doc.querySelectorAll('button, a, [role="button"]')];
          } catch { return []; }
        };
        const all = [
          ...collect(document),
          ...[...document.querySelectorAll('iframe')]
            .flatMap(f => { try { return collect(f.contentDocument); } catch { return []; } }),
        ];
        const re = /(volgende|next|→|»|›)/i;
        const next = all.find(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim();
          return t && re.test(t) && t.length < 40;
        });
        if (next) { next.click(); return true; }
        return false;
      }).catch(() => false);
      if (!clicked) break;
      await page.waitForTimeout(1800);
    }

    // Screenshot + HTML voor debug
    try {
      await page.screenshot({ path: `${DEBUG_DIR}/${prefix}.png`, fullPage: true });
      saveDebug(`${prefix}.html`, await page.content());
    } catch (_) {}
  } catch (e) {
    console.warn(`  Laadwaarschuwing (${url}): ${e.message}`);
  }

  saveDebug(`${prefix}-requests.txt`, requests.join('\n'));
  saveDebug(`${prefix}-captured-urls.txt`, captured.map(c => c.url).join('\n'));

  return { ctx, page, captured };
}

// ── Generieke "is dit een rooster-array?" detector ─────────────────

function findScheduleArrays(jsonValue, depth = 0) {
  const hits = [];
  if (depth > 6 || jsonValue == null) return hits;
  if (Array.isArray(jsonValue)) {
    if (jsonValue.length > 0 && typeof jsonValue[0] === 'object' && jsonValue[0] !== null) {
      const keys = Object.keys(jsonValue[0]).map(k => k.toLowerCase());
      const looksLikeClass =
        keys.some(k => /(start_time|time_start|timestart|start_date|begin|starttime|^time$|^start$)/.test(k)) &&
        keys.some(k => /(name|title|class_name|activity|activity_name|event_name|description)/.test(k));
      if (looksLikeClass) hits.push(jsonValue);
    }
    for (const item of jsonValue) hits.push(...findScheduleArrays(item, depth + 1));
    return hits;
  }
  if (typeof jsonValue === 'object') {
    for (const v of Object.values(jsonValue)) hits.push(...findScheduleArrays(v, depth + 1));
  }
  return hits;
}

function normalizeClass(item, prefix, idx) {
  const tz = 'Europe/Amsterdam';

  let day = null;
  let time = null;

  const startRaw =
    item.start_time ?? item.timestamp ?? item.starttime ?? item.start ??
    item.start_date ?? item.startTime ?? item.time_start ?? item.begin;

  if (startRaw != null) {
    let d;
    if (typeof startRaw === 'number') {
      d = new Date(startRaw > 1e12 ? startRaw : startRaw * 1000);
    } else {
      d = new Date(startRaw);
    }
    if (!isNaN(d)) {
      const parts = new Intl.DateTimeFormat('nl-NL', {
        timeZone: tz, hour: '2-digit', minute: '2-digit',
        weekday: 'short', hour12: false,
      }).formatToParts(d);
      const hh = parts.find(p => p.type === 'hour')?.value;
      const mm = parts.find(p => p.type === 'minute')?.value;
      const wd = parts.find(p => p.type === 'weekday')?.value;
      if (hh && mm) time = `${hh}:${mm}`;
      if (wd) day = parseDay(wd);
    }
  }

  if (day == null) {
    day = parseDay(
      item.day_of_week ?? item.day ?? item.weekday ?? item.start_day ?? item.dayOfWeek
    );
  }
  if (!time) {
    time = parseTime(item.time ?? item.start_time ?? item.begin ?? item.starttime);
  }
  if (day == null || !time) return null;

  const type = String(
    item.name ?? item.title ?? item.activity_name ?? item.class_name ??
    item.event_name ?? item.activity ?? 'Les'
  ).trim().slice(0, 60);

  let dur = parseDur(
    item.duration ?? item.length ?? item.minutes ?? item.duration_minutes
  );
  if (!dur || dur === 60) {
    const endRaw = item.end_time ?? item.endtime ?? item.end ?? item.time_end;
    if (startRaw && endRaw) {
      const s = typeof startRaw === 'number'
        ? new Date(startRaw > 1e12 ? startRaw : startRaw * 1000) : new Date(startRaw);
      const e = typeof endRaw === 'number'
        ? new Date(endRaw > 1e12 ? endRaw : endRaw * 1000) : new Date(endRaw);
      if (!isNaN(s) && !isNaN(e)) {
        const m = Math.round((e - s) / 60000);
        if (m > 0 && m < 240) dur = m;
      }
    }
  }

  const level = String(item.level ?? item.difficulty ?? item.intensity ?? '').trim();

  return { id: `${prefix}${idx}`, day, time, dur, type, level };
}

// ── Virtuagym-strategie (SB Gym, Commit) ───────────────────────────

async function fetchVirtuagym(browser, pageUrl, prefix, name) {
  console.log(`\n[${name}] Ophalen: ${pageUrl}`);
  const { ctx, page, captured } = await openTabWithCapture(browser, pageUrl, prefix);

  let captureIndex = 0;
  for (const cap of captured) {
    if (cap.url.match(/virtuagym|schedule|class|group|planning|widget|event|rooster/i)) {
      saveDebug(`${prefix}-capture-${++captureIndex}.json`, { url: cap.url, body: cap.body });
    }
  }

  const allHits = [];
  for (const cap of captured) {
    allHits.push(...findScheduleArrays(cap.body));
  }
  const seen = new Set();
  const items = [];
  for (const arr of allHits) {
    for (const it of arr) {
      if (typeof it !== 'object' || it === null) continue;
      if (seen.has(it)) continue;
      seen.add(it);
      items.push(it);
    }
  }
  console.log(`  ${items.length} ruwe items uit ${captured.length} JSON-responses`);

  let classes = items
    .map((it, i) => normalizeClass(it, prefix, i + 1))
    .filter(Boolean);

  if (classes.length === 0) {
    console.log('  → Netwerk leeg, probeer DOM-scraping…');
    classes = await scrapeVirtuagymDOM(page, prefix);
  }

  classes = dedupe(classes);
  console.log(`  → ${classes.length} unieke lessen geparseerd`);

  await ctx.close();
  return classes;
}

async function scrapeVirtuagymDOM(page, prefix) {
  const frames = [page, ...page.frames().filter(f => f !== page.mainFrame())];
  for (const frame of frames) {
    try {
      const rows = await frame.evaluate(() => {
        const DAYS = {
          zo: 0, ma: 1, di: 2, wo: 3, do: 4, vr: 5, za: 6,
          su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6,
          zondag: 0, maandag: 1, dinsdag: 2, woensdag: 3,
          donderdag: 4, vrijdag: 5, zaterdag: 6,
          sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
          thursday: 4, friday: 5, saturday: 6,
        };
        const out = [];
        const dayCols = document.querySelectorAll(
          '[class*="day-column"],[class*="day_column"],[class*="weekday-col"],[data-day]'
        );
        if (dayCols.length) {
          dayCols.forEach(col => {
            let dayNum = null;
            const dayAttr = col.getAttribute('data-day') || col.getAttribute('data-weekday');
            if (dayAttr) {
              const n = parseInt(dayAttr, 10);
              if (!isNaN(n)) dayNum = n === 7 ? 0 : n;
            }
            if (dayNum == null) {
              const h = (col.querySelector('h1,h2,h3,h4,[class*="title"],[class*="header"]')?.innerText || '').toLowerCase();
              for (const [k, v] of Object.entries(DAYS)) if (h.includes(k)) { dayNum = v; break; }
            }
            if (dayNum == null) return;
            col.querySelectorAll('[class*="class"],[class*="event"],[class*="item"],li').forEach(item => {
              const text = (item.innerText || '').trim();
              const tm = text.match(/\b(\d{1,2}[:.]\d{2})\b/);
              if (!tm) return;
              const titleEl = item.querySelector('[class*="name"],[class*="title"],h3,h4,h5,strong,b');
              const name = (titleEl?.innerText || '').trim() ||
                text.split('\n').map(l => l.trim()).filter(l => l && !/^\d{1,2}[:.]\d{2}/.test(l))[0] || 'Les';
              out.push({ day: dayNum, time: tm[1], name });
            });
          });
        }
        return out;
      });
      if (rows && rows.length) {
        return rows
          .map((r, i) => ({
            id: `${prefix}${i + 1}`,
            day: r.day,
            time: parseTime(r.time) || '18:00',
            dur: 60,
            type: r.name || 'Les',
            level: '',
          }))
          .filter(c => c.day != null && c.time);
      }
    } catch (_) {}
  }
  return [];
}

// ── The Colosseum ──────────────────────────────────────────────────

async function fetchColosseum(browser) {
  console.log('\n[Colosseum] Ophalen…');

  const urls = [
    'https://thecolosseum.nl/lesrooster/',
    'https://thecolosseum.nl/en/rooster/',
    'https://thecolosseum.nl/rooster/',
  ];

  for (const url of urls) {
    console.log(`  → ${url}`);
    const { ctx, page, captured } = await openTabWithCapture(browser, url, 'colosseum');
    let classes = [];

    // A: JSON-API
    const items = [];
    const seen = new Set();
    for (const cap of captured) {
      for (const arr of findScheduleArrays(cap.body)) {
        for (const it of arr) {
          if (typeof it !== 'object' || it === null || seen.has(it)) continue;
          seen.add(it); items.push(it);
        }
      }
    }
    if (items.length) {
      classes = items.map((it, i) => normalizeClass(it, 'c', i + 1)).filter(Boolean);
    }

    // B: tabel
    if (classes.length === 0) {
      const tableRows = await page.evaluate(() => {
        const rows = [];
        document.querySelectorAll('table tr').forEach(tr => {
          const cells = [...tr.querySelectorAll('td,th')].map(c => c.innerText.trim());
          if (cells.length) rows.push(cells);
        });
        return rows;
      }).catch(() => []);

      if (tableRows.length > 1) {
        const header = tableRows[0].map(h => h.toLowerCase());
        const findCol = re => header.findIndex(h => re.test(h));
        const dayCol = findCol(/dag|day/);
        const timeCol = findCol(/tijd|time|start|wanneer/);
        const typeCol = findCol(/les|type|class|training|naam|name|activiteit/);
        const durCol = findCol(/duur|dur|min/);
        const lvlCol = findCol(/niveau|level/);

        let n = 1;
        for (const row of tableRows.slice(1)) {
          const day = parseDay(row[dayCol] ?? row[0]);
          const time = parseTime(row[timeCol] ?? row[1]);
          if (day == null || !time) continue;
          classes.push({
            id: `c${n++}`,
            day, time,
            dur: durCol >= 0 ? parseDur(row[durCol]) : 60,
            type: (typeCol >= 0 ? row[typeCol] : row.find(c => c && c.length > 2 && !/\d{1,2}[:.]\d{2}/.test(c))) ?? 'Les',
            level: lvlCol >= 0 ? row[lvlCol] : 'Alle niveaus',
          });
        }
      }
    }

    // C: div-rooster
    if (classes.length === 0) {
      const blocks = await page.evaluate(() => {
        const DAYS = {
          maandag: 1, monday: 1, dinsdag: 2, tuesday: 2,
          woensdag: 3, wednesday: 3, donderdag: 4, thursday: 4,
          vrijdag: 5, friday: 5, zaterdag: 6, saturday: 6,
          zondag: 0, sunday: 0,
        };
        const out = [];
        document.querySelectorAll('[class*="day"],[class*="weekday"],[class*="schedule"],[class*="rooster"],[class*="timetable"]').forEach(container => {
          const title = (container.querySelector('h1,h2,h3,h4,[class*="title"],[class*="name"]')?.innerText || '').toLowerCase();
          let dayNum = null;
          for (const [k, v] of Object.entries(DAYS)) if (title.includes(k)) { dayNum = v; break; }
          if (dayNum == null) return;
          container.querySelectorAll('[class*="event"],[class*="class"],[class*="item"],[class*="les"],[class*="training"],li').forEach(it => {
            const txt = (it.innerText || '').trim();
            const tm = txt.match(/\b(\d{1,2}[:.]\d{2})\b/);
            if (!tm) return;
            out.push({ day: dayNum, time: tm[1], text: txt });
          });
        });
        return out;
      }).catch(() => []);

      let n = 1;
      for (const b of blocks) {
        const time = parseTime(b.time);
        if (!time) continue;
        const lines = b.text.split('\n').map(l => l.trim()).filter(Boolean);
        const type = lines.find(l => !/\d{1,2}[:.]\d{2}/.test(l) && l.length > 1 && l.length < 50) || 'Les';
        classes.push({ id: `c${n++}`, day: b.day, time, dur: 60, type, level: 'Alle niveaus' });
      }
    }

    // D: paginatekst
    if (classes.length === 0) {
      const text = await page.evaluate(() => document.body.innerText).catch(() => '');
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const DAY_WORDS = [
        'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag',
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      ];
      let cur = -1, n = 1;
      for (const line of lines) {
        const lw = line.toLowerCase();
        const dw = DAY_WORDS.find(d => lw === d || lw.startsWith(d + ' ') || lw.endsWith(' ' + d));
        if (dw) { cur = parseDay(dw); continue; }
        if (cur < 0) continue;
        const tm = parseTime(line);
        if (!tm) continue;
        const rest = line.replace(/\b\d{1,2}[:.]\d{2}\b/, '').replace(/\s+/g, ' ').trim();
        if (!rest || rest.length < 2) continue;
        classes.push({ id: `c${n++}`, day: cur, time: tm, dur: 60, type: rest.slice(0, 60), level: 'Alle niveaus' });
      }
    }

    classes = dedupe(classes);
    console.log(`    ${classes.length} lessen`);
    await ctx.close();
    if (classes.length > 0) return classes;
  }
  return [];
}

// ── Hoofd ──────────────────────────────────────────────────────────

const SOURCES = [
  {
    key: 'colosseum',
    name: 'The Colosseum',
    url: 'https://thecolosseum.nl/lesrooster/',
    addr: 'Utrecht',
    fetch: browser => fetchColosseum(browser),
  },
  {
    key: 'sbgym',
    name: 'SB Gym',
    url: 'https://sbgym.nl/rooster/',
    addr: 'Utrecht',
    fetch: browser => fetchVirtuagym(browser, 'https://sbgym.nl/rooster/', 's', 'SB Gym'),
  },
  {
    key: 'commit',
    name: 'Commit Rivierenwijk',
    url: 'https://www.commit-i-do.com/locaties/rivierenwijk/groepslessen/',
    addr: 'Amaliadwarsstraat 2A, Utrecht',
    fetch: browser => fetchVirtuagym(
      browser,
      'https://www.commit-i-do.com/locaties/rivierenwijk/groepslessen/',
      'm', 'Commit'
    ),
  },
];

(async () => {
  const old = loadOld();
  const oldSchools = old?.schools ?? {};

  const browser = await chromium.launch({ headless: true });
  const results = {};

  try {
    const settled = await Promise.allSettled(SOURCES.map(s => s.fetch(browser)));
    SOURCES.forEach((s, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        results[s.key] = r.value;
      } else {
        console.warn(`[${s.name}] gefaald: ${r.reason?.message ?? r.reason}`);
        results[s.key] = [];
      }
    });
  } finally {
    await browser.close();
  }

  const schools = {};
  let totalFresh = 0;
  for (const s of SOURCES) {
    const fresh = results[s.key] ?? [];
    const usingFresh = fresh.length > 0;
    const classes = usingFresh ? fresh : (oldSchools[s.key]?.classes ?? []);
    if (usingFresh) totalFresh += classes.length;
    schools[s.key] = {
      name: s.name,
      url: s.url,
      addr: s.addr,
      classes,
      source: usingFresh ? 'scrape' : 'fallback',
    };
  }

  const out = {
    updated: new Date().toISOString(),
    note: 'Automatisch bijgewerkt door GitHub Actions',
    schools,
  };

  writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log('\n══════════════════════════════════════════');
  console.log(`✓ schedules.json geschreven (${out.updated})`);
  for (const s of SOURCES) {
    const sc = schools[s.key];
    console.log(`  ${s.name.padEnd(22)} ${String(sc.classes.length).padStart(3)} lessen  [${sc.source}]`);
  }
  if (totalFresh === 0) {
    console.warn('⚠ Geen enkele bron leverde nieuwe data — fallback gebruikt.');
  }
})();
