/**
 * fetch-schedules.mjs
 * Haalt roosters op via Playwright + stealth-modus (omzeilt bot-detectie).
 *
 * The Colosseum  → thecolosseum.nl/en/rooster/
 * SB Gym         → sbgym.nl/lesrooster/  (Virtuagym embed)
 * Commit         → commit-i-do.com/…/groepslessen-rivierenwijk/  (Virtuagym embed)
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

chromium.use(StealthPlugin());

const OUTPUT  = 'schedules.json';
const DEBUG   = process.env.DEBUG_SCHEDULES === '1';

// ── Helpers ────────────────────────────────────────────────────────

const DAY_MAP = {
  zo:0, su:0, zondag:0, sunday:0,
  ma:1, mo:1, maandag:1, monday:1,
  di:2, tu:2, dinsdag:2, tuesday:2,
  wo:3, we:3, woensdag:3, wednesday:3,
  do:4, th:4, donderdag:4, thursday:4,
  vr:5, fr:5, vrijdag:5, friday:5,
  za:6, sa:6, zaterdag:6, saturday:6,
};

function parseDay(s) {
  if (s == null) return null;
  const key = String(s).trim().toLowerCase().replace(/[^a-z]/g, '');
  for (const [k, v] of Object.entries(DAY_MAP)) {
    if (key.startsWith(k)) return v;
  }
  return null;
}

function parseTime(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})[:\.](\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : null;
}

function parseDur(s) {
  if (!s) return 60;
  const m = String(s).match(/(\d+)/);
  return m ? +m[1] : 60;
}

function loadOld() {
  if (existsSync(OUTPUT)) {
    try { return JSON.parse(readFileSync(OUTPUT, 'utf8')); } catch(_) {}
  }
  return null;
}

async function newPage(browser, url) {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' });
  await page.setViewportSize({ width: 1280, height: 800 });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    // Cookie-banner wegklikken (veelgebruikte knoppen)
    for (const sel of [
      'button[id*="accept"]', 'button[class*="accept"]', 'button[class*="cookie"]',
      '#onetrust-accept-btn-handler', '.cookie-accept', '[data-accept-cookies]',
      'a[href*="accept"]', 'button:has-text("Accepteren")', 'button:has-text("Accept")',
      'button:has-text("Akkoord")', 'button:has-text("OK")',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          await page.waitForTimeout(500);
          break;
        }
      } catch(_) {}
    }
    await page.waitForTimeout(2000);
  } catch(e) {
    console.warn(`  Laadwaarschuwing (${url}): ${e.message}`);
  }
  return page;
}

// ── Virtuagym-intercept ────────────────────────────────────────────

function virtuagymFromJSON(items, prefix) {
  const result = [];
  let i = 0;
  for (const item of items) {
    const day = parseDay(
      item.day_of_week ?? item.day ?? item.weekday ?? item.start_day ?? ''
    );
    let time = parseTime(item.start_time ?? item.time ?? item.begin ?? '');
    // Soms is start_time een Unix-timestamp of ISO-datum
    if (!time && item.start_time) {
      const d = new Date(typeof item.start_time === 'number'
        ? item.start_time * 1000
        : item.start_time);
      if (!isNaN(d)) {
        time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const resolvedDay = d.getDay();
        if (day === null) {
          result.push({
            id: `${prefix}${++i}`,
            day: resolvedDay, time,
            dur: parseDur(item.duration ?? item.length ?? 60),
            type: String(item.name ?? item.activity_name ?? item.class_name ?? item.title ?? 'Les').trim(),
            level: String(item.level ?? item.difficulty ?? '').trim(),
          });
          continue;
        }
      }
    }
    if (day === null || !time) continue;
    result.push({
      id: `${prefix}${++i}`,
      day, time,
      dur: parseDur(item.duration ?? item.length ?? 60),
      type: String(item.name ?? item.activity_name ?? item.class_name ?? item.title ?? 'Les').trim(),
      level: String(item.level ?? item.difficulty ?? '').trim(),
    });
  }
  return result;
}

async function fetchVirtuagym(browser, pageUrl, prefix, schoolName) {
  console.log(`\n[${schoolName}] Ophalen: ${pageUrl}`);
  const captured = [];

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9' });
  await page.setViewportSize({ width: 1280, height: 800 });

  page.on('response', async resp => {
    const url = resp.url();
    const ct  = resp.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    if (!url.match(/groupclass|schedule|planning|classes|groepslessen/i)) return;
    try {
      const json = await resp.json();
      const list = json?.data ?? json?.classes ?? json?.result ?? json?.items
                   ?? json?.group_classes ?? (Array.isArray(json) ? json : null);
      if (list?.length) {
        console.log(`  ✓ API-response gevangen: ${url} (${list.length} items)`);
        captured.push(...list);
      }
    } catch(_) {}
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 45_000 });
    // Cookie-banner
    for (const sel of [
      'button[id*="accept"]', '#onetrust-accept-btn-handler',
      'button:has-text("Accepteren")', 'button:has-text("Accept")',
      'button:has-text("Akkoord")', '.cookie-accept',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) { await btn.click(); break; }
      } catch(_) {}
    }
    // Scroll om lazy-load te triggeren
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    // Volgende week ook laden (soms worden alleen huidige-week calls gemaakt)
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button,a')];
      const next = btns.find(b => /volgende|next|>/i.test(b.innerText ?? b.getAttribute('aria-label') ?? ''));
      if (next) next.click();
    });
    await page.waitForTimeout(2000);
  } catch(e) {
    console.warn(`  Laadwaarschuwing: ${e.message}`);
  }

  if (DEBUG) {
    try {
      mkdirSync('debug-output', { recursive: true });
      await page.screenshot({ path: `debug-output/${prefix}-virtuagym.png`, fullPage: true });
    } catch(_) {}
  }
  await page.close();

  if (captured.length > 0) {
    const classes = virtuagymFromJSON(captured, prefix);
    console.log(`  → ${classes.length} lessen geparseerd`);
    return classes;
  }

  // DOM-fallback
  console.log(`  → Geen API-data. Probeer DOM-scraping…`);
  return scrapeVirtuagymDOM(browser, pageUrl, prefix, schoolName);
}

async function scrapeVirtuagymDOM(browser, pageUrl, prefix, schoolName) {
  const page = await newPage(browser, pageUrl);
  try {
    const rows = await page.evaluate(() => {
      const out = [];
      const sels = [
        '.group-class-item', '.class-item', '.schedule-item', '.lesson-item',
        '[class*="group-class"]', '[class*="class-block"]', '[class*="schedule-row"]',
        '[data-activity-id]', '[class*="booking-item"]', 'li[class*="class"]',
      ];
      for (const sel of sels) {
        const nodes = [...document.querySelectorAll(sel)];
        if (!nodes.length) continue;
        nodes.forEach(n => {
          const text = n.innerText ?? '';
          const timeM = text.match(/\b(\d{1,2}[:.]\d{2})\b/);
          const dayEl  = n.closest('[class*="day"]') ?? n.querySelector('[class*="day"],[class*="datum"]');
          const nameEl = n.querySelector('[class*="name"],[class*="title"],h3,h4,strong');
          out.push({
            raw:  text.trim().slice(0, 300),
            time: timeM?.[1] ?? null,
            day:  dayEl?.innerText?.trim() ?? null,
            name: nameEl?.innerText?.trim() ?? null,
          });
        });
        if (out.length) break;
      }
      return out;
    });

    const classes = rows
      .filter(r => r.time)
      .map((r, i) => ({
        id:    `${prefix}${i + 1}`,
        day:   parseDay(r.day) ?? 1,
        time:  parseTime(r.time) ?? '18:00',
        dur:   60,
        type:  r.name ?? r.raw.split('\n')[0].trim().slice(0, 40),
        level: '',
      }));
    console.log(`  → DOM-scraping: ${classes.length} rijen`);
    return classes;
  } finally {
    await page.close();
  }
}

// ── The Colosseum ─────────────────────────────────────────────────

// Try each URL candidate until one gives us HTTP 200
async function openColosseumPage(browser) {
  const candidates = [
    'https://thecolosseum.nl/rooster/',
    'https://thecolosseum.nl/en/rooster/',
    'https://thecolosseum.nl/lesrooster/',
  ];
  for (const url of candidates) {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' });
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (resp && resp.status() < 400) {
        console.log(`\n[colosseum] Geladen: ${url} (${resp.status()})`);
        // accept cookies and wait for JS to settle
        for (const sel of ['button[id*="accept"]','#onetrust-accept-btn-handler',
          'button:has-text("Accepteren")','button:has-text("Accept")','button:has-text("Akkoord")']) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1500 })) { await btn.click(); break; }
          } catch(_) {}
        }
        await page.waitForTimeout(2000);
        return page;
      }
    } catch(_) {}
    await page.close();
  }
  // last resort: return a page on the first URL even if it failed
  return newPage(browser, candidates[0]);
}

async function fetchColosseum(browser) {
  const page = await openColosseumPage(browser);
  const classes = [];

  try {
    // Strategie 1: tabel
    const tableRows = await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll('table tr').forEach(tr => {
        const cells = [...tr.querySelectorAll('td,th')].map(c => c.innerText.trim());
        if (cells.length >= 2) rows.push(cells);
      });
      return rows;
    });

    const DAY_LOOKUP = {
      maandag:1,monday:1,dinsdag:2,tuesday:2,woensdag:3,wednesday:3,
      donderdag:4,thursday:4,vrijdag:5,friday:5,zaterdag:6,saturday:6,zondag:0,sunday:0,
    };

    if (tableRows.length > 1) {
      let idN = 1;
      // Detecteer kolomindex
      const header = tableRows[0].map(h => h.toLowerCase());
      const dayCol  = header.findIndex(h => /dag|day/i.test(h));
      const timeCol = header.findIndex(h => /tijd|time|start/i.test(h));
      const typeCol = header.findIndex(h => /les|type|class|training|naam|name/i.test(h));
      const durCol  = header.findIndex(h => /duur|dur|min/i.test(h));
      const lvlCol  = header.findIndex(h => /niveau|level/i.test(h));

      if (dayCol >= 0 && timeCol >= 0) {
        for (const row of tableRows.slice(1)) {
          const day  = parseDay(row[dayCol]);
          const time = parseTime(row[timeCol]);
          if (day === null || !time) continue;
          classes.push({
            id:    `c${idN++}`,
            day, time,
            dur:   durCol >= 0 ? parseDur(row[durCol]) : 60,
            type:  typeCol >= 0 ? row[typeCol] : row.find(c => c.length > 2 && !/\d{1,2}:\d{2}/.test(c)) ?? 'Les',
            level: lvlCol >= 0 ? row[lvlCol] : 'Alle niveaus',
          });
        }
      } else {
        // Probeer kolom 0 = dag, kolom 1 = tijd, kolom 2 = type
        for (const row of tableRows.slice(1)) {
          const day  = parseDay(row[0]);
          const time = parseTime(row[1] ?? '');
          if (day === null || !time) continue;
          classes.push({
            id:    `c${classes.length + 1}`,
            day, time,
            dur:   row[3] ? parseDur(row[3]) : 60,
            type:  row[2] ?? 'Les',
            level: row[4] ?? 'Alle niveaus',
          });
        }
      }
    }

    // Strategie 2: div-gebaseerd rooster (WordPress timetable plugins)
    if (classes.length === 0) {
      const divData = await page.evaluate(() => {
        const DAYS = {
          maandag:1,monday:1,dinsdag:2,tuesday:2,woensdag:3,wednesday:3,
          donderdag:4,thursday:4,vrijdag:5,friday:5,zaterdag:6,saturday:6,zondag:0,sunday:0,
        };
        const out = [];
        const containers = document.querySelectorAll(
          '[class*="day"],[class*="rooster"],[class*="schedule"],[class*="timetable"],[class*="weekday"]'
        );
        containers.forEach(container => {
          const title = (container.querySelector('h2,h3,h4,[class*="title"],[class*="day-name"]')?.innerText ?? '').toLowerCase();
          let dayNum = null;
          for (const [k, v] of Object.entries(DAYS)) {
            if (title.includes(k)) { dayNum = v; break; }
          }
          if (dayNum === null) return;
          container.querySelectorAll('[class*="les"],[class*="class"],[class*="item"],[class*="training"]').forEach(item => {
            const text = item.innerText.trim();
            const timeM = text.match(/\b(\d{1,2}[:.]\d{2})\b/);
            if (!timeM) return;
            out.push({ day: dayNum, time: timeM[1], text });
          });
        });
        return out;
      });

      let idN = 1;
      for (const row of divData) {
        const time = parseTime(row.time);
        if (!time) continue;
        const lines = row.text.split('\n').map(l => l.trim()).filter(Boolean);
        classes.push({
          id:    `c${idN++}`,
          day:   row.day,
          time,
          dur:   60,
          type:  lines.find(l => !/\d{1,2}[:.]\d{2}/.test(l)) ?? 'Les',
          level: 'Alle niveaus',
        });
      }
    }

    // Strategie 3: volledige paginatekst → regelmatig patroon zoeken
    if (classes.length === 0) {
      const text = await page.evaluate(() => document.body.innerText);
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const DAY_WORDS = ['maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag','zondag',
                         'monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      let currentDay = -1;
      let idN = 1;
      for (const line of lines) {
        const lw = line.toLowerCase();
        const dw = DAY_WORDS.find(d => lw.startsWith(d) || lw === d);
        if (dw) { currentDay = parseDay(dw); continue; }
        if (currentDay < 0) continue;
        const time = parseTime(line);
        if (!time) continue;
        const rest = line.replace(/\d{1,2}[:.]\d{2}/, '').trim();
        classes.push({
          id: `c${idN++}`, day: currentDay, time, dur: 60,
          type: rest || 'Les', level: 'Alle niveaus',
        });
      }
    }

    if (DEBUG) {
      try {
        mkdirSync('debug-output', { recursive: true });
        await page.screenshot({ path: 'debug-output/colosseum.png', fullPage: true });
        writeFileSync('debug-output/colosseum.html', await page.content());
      } catch(_) {}
    }
  } finally {
    await page.close();
  }

  console.log(`  → ${classes.length} lessen gevonden`);
  return classes;
}

// ── Hoofd ──────────────────────────────────────────────────────────

(async () => {
  const old = loadOld();
  const browser = await chromium.launch({ headless: true });

  let colosseumClasses, sbClasses, commitClasses;

  try {
    [colosseumClasses, sbClasses, commitClasses] = await Promise.all([
      fetchColosseum(browser),
      fetchVirtuagym(browser,
        'https://sbgym.nl/lesrooster/',
        's', 'SB Gym'),
      fetchVirtuagym(browser,
        'https://www.commit-i-do.com/locaties/rivierenwijk/groepslessen-rivierenwijk/',
        'm', 'Commit'),
    ]);
  } finally {
    await browser.close();
  }

  const fallback = (key, fresh) =>
    fresh.length > 0 ? fresh : (old?.schools?.[key]?.classes ?? []);

  const result = {
    updated: new Date().toISOString(),
    note: 'Automatisch bijgewerkt door GitHub Actions',
    schools: {
      colosseum: {
        name: 'The Colosseum',
        url:  'https://thecolosseum.nl/rooster/',
        addr: 'Utrecht',
        classes: fallback('colosseum', colosseumClasses),
      },
      sbgym: {
        name: 'SB Gym',
        url:  'https://sbgym.nl/lesrooster/',
        addr: 'Utrecht',
        classes: fallback('sbgym', sbClasses),
      },
      commit: {
        name: 'Commit Rivierenwijk',
        url:  'https://www.commit-i-do.com/locaties/rivierenwijk/groepslessen-rivierenwijk/',
        addr: 'Amaliadwarsstraat 2A, Utrecht',
        classes: fallback('commit', commitClasses),
      },
    },
  };

  writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(`\n✓ schedules.json geschreven (${new Date().toISOString()})`);
  console.log(`  Colosseum: ${result.schools.colosseum.classes.length} lessen`);
  console.log(`  SB Gym:    ${result.schools.sbgym.classes.length} lessen`);
  console.log(`  Commit:    ${result.schools.commit.classes.length} lessen`);
})();
