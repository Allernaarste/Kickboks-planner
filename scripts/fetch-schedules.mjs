/**
 * fetch-schedules.mjs
 * Haalt roosters live op via Playwright + stealth-modus.
 *
 * Werkwijze per gym:
 *  1. Laad de roosterpagina en vang ÁLLE JSON-responses op (ook uit iframes).
 *     Virtuagym/booking-widgets laden hun rooster via zo'n API-call.
 *  2. Herken les-achtige objecten heuristisch (naam + tijd/datum) — geen
 *     fragiele URL-patronen.
 *  3. Geen API-data? DOM-scraping over álle frames (tabel / divs / tekst).
 *  4. Nog niets? Volg automatisch links op de pagina naar rooster/lesrooster
 *     en probeer het daar opnieuw ("actief zoeken").
 *
 * Validatie: een rooster telt pas als live bij ≥ MIN_CLASSES lessen op
 * ≥ MIN_DAYS verschillende dagen. Anders blijft het laatst bekende rooster
 * staan en wordt de gym gemarkeerd met live:false zodat de app dit toont.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import {
  parseDay, parseTime, parseDateTime, parseDur,
  classFromObject, extractClassesFromJSON,
  dedupe, isValidSchedule, finishClasses,
} from './lib/parse.mjs';

chromium.use(StealthPlugin());

const OUTPUT      = 'schedules.json';
const DEBUG       = process.env.DEBUG_SCHEDULES === '1';

function loadOld() {
  if (existsSync(OUTPUT)) {
    try { return JSON.parse(readFileSync(OUTPUT, 'utf8')); } catch(_) {}
  }
  return null;
}

const SCHOOLS = [
  {
    key: 'colosseum', prefix: 'c',
    name: 'The Colosseum',
    url:  'https://thecolosseum.nl/rooster/',
    altUrls: ['https://thecolosseum.nl/en/rooster/'],
    addr: 'Utrecht',
    workit: true,
    workitUrl: 'https://workit.nl/locaties/4251-the-colosseum-gym',
  },
  {
    key: 'sbgym', prefix: 's',
    name: 'SB Gym',
    url:  'https://sbgym.nl/lesrooster/',
    altUrls: ['https://sbgym.nl/rooster/'],
    addr: 'Utrecht',
    workit: true,
  },
  {
    key: 'commit', prefix: 'm',
    name: 'Commit Rivierenwijk',
    url:  'https://www.commit-i-do.com/locaties/rivierenwijk/groepslessen-rivierenwijk/',
    altUrls: [],
    addr: 'Amaliadwarsstraat 2A, Utrecht',
    workit: true,
    workitUrl: 'https://workit.nl/locaties/4317-commit-rivierenwijk',
  },
  {
    key: 'impactfit', prefix: 'i',
    name: 'Impact Fit',
    url:  'https://impactfit.nl/lesrooster/',
    altUrls: ['https://impactfit.nl/'],
    addr: 'Utrecht',
    workit: false,
  },
  {
    key: 'tigers', prefix: 't',
    name: 'Tigers Gym',
    url:  'https://tigersgym.nl/',
    altUrls: [],
    addr: 'Kroonstraat 9, Utrecht',
    workit: false,
  },
];

// ── DOM-scraping (alle frames) ─────────────────────────────────────

async function scrapeFrameDOM(frame) {
  try {
    return await frame.evaluate(() => {
      const DAYS = {
        zondag:0,sunday:0,zo:0, maandag:1,monday:1,ma:1, dinsdag:2,tuesday:2,di:2,
        woensdag:3,wednesday:3,wo:3, donderdag:4,thursday:4,do:4,
        vrijdag:5,friday:5,vr:5, zaterdag:6,saturday:6,za:6,
      };
      const dayOf = t => {
        const k = String(t ?? '').toLowerCase().trim();
        for (const [w, n] of Object.entries(DAYS)) if (k === w || k.startsWith(w + ' ') || k.startsWith(w + ',')) return n;
        for (const [w, n] of Object.entries(DAYS)) if (w.length > 2 && k.includes(w)) return n;
        return null;
      };
      // Datum (dd-mm of dd/mm of "9 jun") → weekdag
      const MONTHS = { jan:0,feb:1,mrt:2,mar:2,apr:3,mei:4,may:4,jun:5,jul:6,aug:7,sep:8,okt:9,oct:9,nov:10,dec:11 };
      const dayOfDate = t => {
        const k = String(t ?? '').toLowerCase();
        let m = k.match(/\b(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?\b/);
        if (m) {
          const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : new Date().getFullYear();
          const d = new Date(y, +m[2] - 1, +m[1]);
          return isNaN(d) ? null : d.getDay();
        }
        m = k.match(/\b(\d{1,2})\s+(jan|feb|mrt|mar|apr|mei|may|jun|jul|aug|sep|okt|oct|nov|dec)/);
        if (m) {
          const d = new Date(new Date().getFullYear(), MONTHS[m[2]], +m[1]);
          return isNaN(d) ? null : d.getDay();
        }
        return null;
      };
      // Openingstijden-regel: alleen een tijdsbereik, geen lesnaam
      const isOpeningHours = t =>
        /^[^0-9]*\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}\s*(uur)?\s*$/i.test(String(t ?? '').trim()) ||
        /geopend|gesloten|opening/i.test(String(t ?? ''));
      const out = [];

      // 1. Tabellen: rij per les of kolom per dag
      document.querySelectorAll('table').forEach(table => {
        const headers = [...table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')]
          .map(c => c.innerText.trim());
        const headerDays = headers.map(dayOf);
        const rows = [...table.querySelectorAll('tr')];
        rows.forEach(tr => {
          const cells = [...tr.querySelectorAll('td,th')];
          // rij-vorm: [dag of datum, tijd, les, ...]
          const rowText = cells.map(c => c.innerText.trim());
          const rowDay = dayOf(rowText[0]) ?? rowText.map(dayOfDate).find(d => d != null) ?? null;
          const rowTime = rowText.map(t => (t.match(/\b\d{1,2}[:.]\d{2}\b/) || [])[0]).find(Boolean);
          if (rowDay != null && rowTime) {
            const name = rowText.find(t =>
              t.length > 2 && !/^\d{1,2}[:.]\d{2}/.test(t) && dayOf(t) == null &&
              dayOfDate(t) == null && !isOpeningHours(t) && !/^\d[\d\s\-\/:.]*$/.test(t));
            if (name) out.push({ day: rowDay, time: rowTime, name, via: 'table-row' });
            return;
          }
          // kolom-vorm: kolomkop = dag(naam of datum), of cel begint zelf met datum
          cells.forEach((cell, ci) => {
            const txt = cell.innerText.trim();
            const d = headerDays[ci] ?? dayOfDate(headers[ci]) ?? dayOfDate(txt.split('\n')[0]);
            if (d == null) return;
            const times = txt.match(/\b\d{1,2}[:.]\d{2}\b/g);
            if (!times) return;
            txt.split('\n').forEach(line => {
              if (isOpeningHours(line)) return;
              const tm = line.match(/\b(\d{1,2}[:.]\d{2})\b/);
              if (!tm) return;
              const name = line.replace(/\d{1,2}[:.]\d{2}(\s*[-–]\s*\d{1,2}[:.]\d{2})?/g, '').replace(/[|·•]/g, ' ').trim();
              out.push({ day: d, time: tm[1], name: name || null, via: 'table-col' });
            });
          });
        });
      });

      // 2. Dag-containers met les-items
      document.querySelectorAll('[class*="day"],[class*="rooster"],[class*="schedule"],[class*="timetable"],[class*="weekday"],[data-day]').forEach(container => {
        const title = container.querySelector('h1,h2,h3,h4,h5,[class*="title"],[class*="header"],[class*="day-name"],[class*="dayname"]')?.innerText ?? container.getAttribute('data-day') ?? '';
        const d = dayOf(title) ?? dayOfDate(title);
        if (d == null) return;
        container.querySelectorAll('*').forEach(item => {
          if (item.children.length > 3) return;
          const text = item.innerText?.trim() ?? '';
          if (text.length < 5 || text.length > 120 || isOpeningHours(text)) return;
          const tm = text.match(/\b(\d{1,2}[:.]\d{2})\b/);
          if (!tm) return;
          const name = text.replace(/\d{1,2}[:.]\d{2}(\s*[-–]\s*\d{1,2}[:.]\d{2})?/g, '').replace(/\n/g, ' ').trim();
          if (name) out.push({ day: d, time: tm[1], name, via: 'day-container' });
        });
      });

      // 3. Platte paginatekst: dagkop gevolgd door tijdregels
      if (out.length === 0) {
        const lines = (document.body?.innerText ?? '').split('\n').map(l => l.trim()).filter(Boolean);
        let cur = null;
        for (const line of lines) {
          const d = dayOf(line) ?? dayOfDate(line.length < 30 ? line : '');
          if (d != null && line.length < 30 && !/\d{1,2}[:.]\d{2}.*\d{1,2}[:.]\d{2}/.test(line)) { cur = d; continue; }
          if (cur == null) continue;
          if (isOpeningHours(line)) continue;
          const tm = line.match(/\b(\d{1,2}[:.]\d{2})\b/);
          if (!tm) continue;
          const name = line.replace(/\d{1,2}[:.]\d{2}(\s*[-–]\s*\d{1,2}[:.]\d{2})?/g, '').replace(/[|·•]/g, ' ').trim();
          if (name && name.length > 1) out.push({ day: cur, time: tm[1], name, via: 'text' });
        }
      }
      return out;
    });
  } catch (_) {
    return [];
  }
}

// ── Pagina bezoeken: JSON vangen + DOM scrapen ─────────────────────

async function visit(context, url, school, jsonBag) {
  const page = await context.newPage();
  page.on('response', async resp => {
    try {
      const ct = resp.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const json = await resp.json().catch(() => null);
      if (json == null) return;
      jsonBag.push({ url: resp.url(), json });
    } catch (_) {}
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    // Cookie-banners
    for (const sel of [
      '#onetrust-accept-btn-handler', 'button[id*="accept"]', 'button[class*="accept"]',
      'button:has-text("Accepteren")', 'button:has-text("Accept")', 'button:has-text("Akkoord")',
      '.cookie-accept', '[data-accept-cookies]',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1200 })) { await btn.click(); await page.waitForTimeout(400); break; }
      } catch (_) {}
    }
    // Lazy-load triggeren en widgets tijd geven
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(5000);
    // Rooster/lessen-tabs aanklikken (in hoofdframe én widget-frames)
    for (const f of page.frames()) {
      try {
        await f.evaluate(() => {
          const els = [...document.querySelectorAll('a,button,[role="tab"],[role="button"],li')];
          const el = els.find(e => /^(rooster|lesrooster|lessen|classes|schedule|agenda|groepslessen)$/i
            .test((e.innerText ?? '').trim()));
          if (el) el.click();
        });
      } catch (_) {}
    }
    await page.waitForTimeout(3000);
  } catch (e) {
    console.warn(`  ! laadprobleem ${url}: ${e.message.split('\n')[0]}`);
  }

  // Frames loggen + DOM-scrapen
  const frames = page.frames();
  console.log(`  frames: ${frames.length}`);
  frames.forEach(f => console.log(`    · ${f.url().slice(0, 200)}`));
  let domRows = [];
  for (const f of frames) {
    const rows = await scrapeFrameDOM(f);
    if (rows.length) console.log(`  DOM ${f === page.mainFrame() ? 'main' : 'iframe'} (${f.url().slice(0,60)}): ${rows.length} rijen via ${[...new Set(rows.map(r => r.via))].join(',')}`);
    domRows.push(...rows);
  }

  // Diagnose: tijd-regels per frame (eerste 25)
  if (DEBUG) {
    for (const f of frames) {
      const lines = await f.evaluate(() =>
        (document.body?.innerText ?? '').split('\n').map(l => l.trim())
          .filter(l => /\d{1,2}[:.]\d{2}/.test(l)).slice(0, 25)
      ).catch(() => []);
      if (lines.length) {
        console.log(`  tijdregels in ${f.url().slice(0, 80)}:`);
        lines.forEach(l => console.log(`      | ${l.slice(0, 110)}`));
      }
    }
  }

  // Links naar rooster-pagina's verzamelen (voor actief doorzoeken)
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .map(a => a.href)
      .filter(h => /rooster|lesrooster|schedule|timetable|groepsles|planning/i.test(h))
  ).catch(() => []);

  if (DEBUG) {
    try {
      mkdirSync('debug-output', { recursive: true });
      const tag = `${school.key}-${url.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}`;
      await page.screenshot({ path: `debug-output/${tag}.png`, fullPage: true });
      writeFileSync(`debug-output/${tag}.html`, await page.content());
    } catch (_) {}
  }
  const frameUrls = frames.map(f => f.url()).filter(u => u.startsWith('http'));
  await page.close();
  return { domRows, links, frameUrls };
}

// Widget-/rooster-iframes die het waard zijn om direct als pagina te openen
const FRAME_FOLLOW   = /virtuagym|appybee|europewebcompany|sportbit|trainin|eversports|fitmanager|agenda|classes|schedule|rooster|widget/i;
const FRAME_IGNORE   = /google|youtube|gtm|googletagmanager|facebook|hotjar|cookie|maps|recaptcha|vimeo|sw_iframe/i;


async function fetchSchool(context, school) {
  console.log(`\n[${school.key}] ${school.url}`);
  const jsonBag = [];
  const tried = new Set();
  let domRows = [];
  let pendingLinks = [school.url, ...(school.altUrls ?? [])];

  for (let round = 0; round < 6 && pendingLinks.length; round++) {
    const url = pendingLinks.shift();
    if (tried.has(url)) continue;
    tried.add(url);

    const res = await visit(context, url, school, jsonBag);
    domRows.push(...res.domRows);

    // Rooster-widget-iframes direct als pagina openen (hoogste prioriteit)
    for (const fu of res.frameUrls) {
      if (!tried.has(fu) && FRAME_FOLLOW.test(fu) && !FRAME_IGNORE.test(fu)) pendingLinks.unshift(fu);
    }

    // JSON-kandidaten evalueren
    const fromJson = jsonBag.flatMap(({ url: ju, json }) => {
      const cls = extractClassesFromJSON(json);
      if (cls.length) console.log(`  ✓ JSON-bron: ${ju.slice(0, 100)} → ${cls.length} lessen`);
      return cls;
    });
    const DAGEN = ['zo','ma','di','wo','do','vr','za'];
    const sample = cls => cls.slice(0, 12).forEach(c =>
      console.log(`    ${DAGEN[c.day]} ${c.time} ${c.type}${c.level ? ' ('+c.level+')' : ''}`));

    const jsonClasses = finishClasses(fromJson, school.prefix);
    if (isValidSchedule(jsonClasses)) {
      console.log(`  → live via API: ${jsonClasses.length} lessen`);
      sample(jsonClasses);
      return { classes: jsonClasses, live: true, source: 'api' };
    }

    const domClasses = finishClasses(domRows, school.prefix);
    if (isValidSchedule(domClasses)) {
      console.log(`  → live via DOM: ${domClasses.length} lessen`);
      sample(domClasses);
      return { classes: domClasses, live: true, source: 'dom' };
    }

    // Nog niets → rooster-links van deze pagina toevoegen (zelfde domein)
    const host = new URL(school.url).host;
    for (const l of res.links) {
      try {
        if (new URL(l).host === host && !tried.has(l)) pendingLinks.push(l);
      } catch (_) {}
    }
    if (pendingLinks.length) console.log(`  … niets gevonden, probeer: ${pendingLinks[0]}`);
  }

  console.log(`  ✗ geen geldig rooster gevonden (json-responses: ${jsonBag.length}, dom-rijen: ${domRows.length})`);
  if (DEBUG) {
    if (jsonBag.length) {
      console.log(`  JSON-urls gezien:`);
      [...new Set(jsonBag.map(b => b.url))].slice(0, 15).forEach(u => console.log(`    - ${u.slice(0, 130)}`));
    }
    if (domRows.length) {
      console.log(`  voorbeeld dom-rijen (ruwe data, max 15):`);
      domRows.slice(0, 15).forEach(r =>
        console.log(`    [${r.via}] day=${r.day} time=${r.time} name=${JSON.stringify(String(r.name ?? '').slice(0, 50))}`));
    }
  }
  return { classes: [], live: false, source: null };
}

// ── Hoofd ──────────────────────────────────────────────────────────

(async () => {
  const old = loadOld();
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--lang=nl-NL'],
  });
  const context = await browser.newContext({
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' },
  });

  const schools = {};
  let liveCount = 0;

  try {
    for (const school of SCHOOLS) {
      const { classes, live, source } = await fetchSchool(context, school);
      const oldSchool = old?.schools?.[school.key];
      if (live) liveCount++;
      schools[school.key] = {
        name: school.name,
        url:  school.url,
        addr: school.addr,
        workit: school.workit,
        ...(school.workitUrl ? { workitUrl: school.workitUrl } : {}),
        live,
        source: live ? source : (oldSchool?.live ? 'stale' : null),
        fetchedAt: live ? new Date().toISOString() : (oldSchool?.fetchedAt ?? null),
        classes: live ? classes : (oldSchool?.classes ?? []),
      };
    }
  } finally {
    await browser.close();
  }

  const result = {
    updated: new Date().toISOString(),
    note: 'Automatisch bijgewerkt door GitHub Actions',
    schools,
  };

  writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(`\n✓ schedules.json geschreven — ${liveCount}/${SCHOOLS.length} gyms live`);
  for (const s of SCHOOLS) {
    const r = schools[s.key];
    console.log(`  ${r.live ? '🟢' : '🔴'} ${s.name.padEnd(20)} ${String(r.classes.length).padStart(3)} lessen ${r.live ? `(live, ${r.source})` : '(laatst bekende rooster)'}`);
  }

  // Bij 0 live gyms: laat de workflow falen zodat dit zichtbaar is
  if (liveCount === 0) {
    console.error('\n✗ Geen enkele gym leverde live data — zie debug-output artifact.');
    process.exit(1);
  }
})();
