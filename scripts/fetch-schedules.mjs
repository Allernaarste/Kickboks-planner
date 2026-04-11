/**
 * Rooster-scraper voor Kickboks Planner Utrecht
 * Haalt de lessen op van:
 *  - The Colosseum  → thecolosseum.nl/en/rooster/
 *  - SB Gym         → sbgym.virtuagym.com  (Virtuagym)
 *  - Commit         → commit-rivierenwijk.virtuagym.com (Virtuagym)
 *
 * Dag-codering: 0=Zo 1=Ma 2=Di 3=Wo 4=Do 5=Vr 6=Za
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const OUTPUT = 'schedules.json';

// ── Hulpfuncties ────────────────────────────────────────────────

const DAY_MAP = {
  zondag: 0, sunday: 0, zo: 0, su: 0,
  maandag: 1, monday: 1, ma: 1, mo: 1,
  dinsdag: 2, tuesday: 2, di: 2, tu: 2,
  woensdag: 3, wednesday: 3, wo: 3, we: 3,
  donderdag: 4, thursday: 4, do: 4, th: 4,
  vrijdag: 5, friday: 5, vr: 5, fr: 5,
  zaterdag: 6, saturday: 6, za: 6, sa: 6,
};

function parseDay(str) {
  if (!str) return null;
  return DAY_MAP[str.trim().toLowerCase().slice(0, 2)] ?? null;
}

function parseTime(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})[:\.](\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : null;
}

function parseDuration(str) {
  if (!str) return 60;
  const m = str.match(/(\d+)/);
  return m ? parseInt(m[1]) : 60;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
}

// Laad bestaand schedules.json als fallback
function loadFallback() {
  if (existsSync(OUTPUT)) {
    try { return JSON.parse(readFileSync(OUTPUT, 'utf8')); } catch(e) {}
  }
  return null;
}

// ── Browser-instellingen ─────────────────────────────────────────

async function openPage(browser, url) {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
  });
  await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  return page;
}

// ── Virtuagym-scraper (SB Gym + Commit) ─────────────────────────

async function fetchVirtuagym(browser, subdomain, schoolKey) {
  console.log(`\n[${schoolKey}] Ophalen via Virtuagym: ${subdomain}`);
  const captured = [];

  // Intercept JSON API-responses die Virtuagym intern maakt
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9' });
  await page.setViewportSize({ width: 390, height: 844 });

  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('groupclass') && !url.includes('schedule') && !url.includes('classes')) return;
    if (!resp.headers()['content-type']?.includes('json')) return;
    try {
      const json = await resp.json();
      const list = json?.data ?? json?.classes ?? json?.result ?? (Array.isArray(json) ? json : null);
      if (list?.length) captured.push(...list);
    } catch(e) {}
  });

  try {
    await page.goto(`https://${subdomain}.virtuagym.com/groupclass/overview`, {
      waitUntil: 'networkidle', timeout: 45000,
    });
    await page.waitForTimeout(3000); // extra wacht zodat lazy API calls meekomen
  } catch(e) {
    console.warn(`  Navigatie fout: ${e.message}`);
  }

  await page.close();

  if (captured.length) {
    console.log(`  ✓ ${captured.length} items via network-intercept`);
    return parseVirtuagymItems(captured, schoolKey);
  }

  // Fallback: DOM-scraping op Virtuagym
  console.log(`  → Probeer DOM-scraping...`);
  return scrapeVirtuagymDOM(browser, subdomain, schoolKey);
}

async function scrapeVirtuagymDOM(browser, subdomain, schoolKey) {
  const page = await openPage(browser,
    `https://${subdomain}.virtuagym.com/groupclass/overview`);

  const classes = await page.evaluate(() => {
    const results = [];
    // Zoek alle elementen die op een les lijken
    const selectors = [
      '.group-class-item', '.class-item', '.schedule-item',
      '[class*="group-class"]', '[class*="class-item"]', '[class*="schedule-row"]',
      '[data-activity]', '[class*="lesson"]',
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (!nodes.length) continue;
      nodes.forEach(n => {
        const text = n.innerText || '';
        const timeMatch = text.match(/\b(\d{1,2}[:.]\d{2})\b/);
        const dayEl = n.closest('[class*="day"]') ?? n.querySelector('[class*="day"],[class*="date"]');
        results.push({
          raw: text.trim().slice(0, 200),
          time: timeMatch?.[1] ?? null,
          day: dayEl?.innerText?.trim() ?? null,
          name: n.querySelector('[class*="name"],[class*="title"],h3,h4')?.innerText?.trim() ?? null,
        });
      });
      if (results.length) break;
    }
    return results;
  });

  await page.close();
  console.log(`  ✓ DOM: ${classes.length} rijen gevonden`);
  return domRowsToClasses(classes, schoolKey);
}

function parseVirtuagymItems(items, schoolKey) {
  const prefix = schoolKey[0];
  const classes = [];
  items.forEach((item, i) => {
    const day = parseDay(item.day_of_week ?? item.day ?? item.weekday ?? '');
    const time = parseTime(item.start_time ?? item.time ?? item.begin ?? '');
    const dur = parseDuration(String(item.duration ?? item.length ?? 60));
    const type = item.name ?? item.activity_name ?? item.title ?? item.class_name ?? 'Kickboxen';
    const level = item.level ?? item.difficulty ?? '';
    if (day === null || !time) return;
    classes.push({
      id: `${prefix}g${i}`,
      day, time, dur,
      type: type.trim(),
      level: level.trim(),
    });
  });
  return classes;
}

function domRowsToClasses(rows, schoolKey) {
  const prefix = schoolKey[0];
  return rows
    .filter(r => r.time)
    .map((r, i) => ({
      id: `${prefix}d${i}`,
      day: parseDay(r.day) ?? 1,
      time: parseTime(r.time) ?? '18:00',
      dur: 60,
      type: r.name ?? r.raw.split('\n')[0].trim().slice(0, 40) ?? 'Kickboxen',
      level: '',
    }));
}

// ── The Colosseum scraper ────────────────────────────────────────

async function fetchColosseum(browser) {
  console.log('\n[colosseum] Ophalen: thecolosseum.nl/en/rooster/');
  const page = await openPage(browser, 'https://thecolosseum.nl/en/rooster/');

  const classes = await page.evaluate(() => {
    const results = [];
    const DAYS = {
      maandag:1, monday:1, dinsdag:2, tuesday:2, woensdag:3, wednesday:3,
      donderdag:4, thursday:4, vrijdag:5, friday:5, zaterdag:6, saturday:6,
      zondag:0, sunday:0,
    };

    // Probeer tabel-opmaak
    document.querySelectorAll('table tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td,th')].map(td => td.innerText.trim());
      if (cells.length < 2) return;
      results.push({ cells, source: 'table' });
    });

    // Probeer div-gebaseerde roosters (veel WordPress-thema's)
    const dayContainers = document.querySelectorAll(
      '[class*="day"], [class*="rooster"], [class*="schedule"], [class*="timetable"]'
    );
    dayContainers.forEach(container => {
      const dayText = container.querySelector('h2,h3,h4,[class*="title"],[class*="day-name"]')
        ?.innerText?.trim()?.toLowerCase() ?? '';
      const dayNum = Object.keys(DAYS).find(k => dayText.includes(k));
      const items = container.querySelectorAll(
        '[class*="les"],[class*="class"],[class*="training"],[class*="item"]'
      );
      items.forEach(item => {
        const text = item.innerText.trim();
        const timeMatch = text.match(/\b(\d{1,2}[:.]\d{2})\b/);
        results.push({
          cells: [dayText, ...text.split(/\n/).map(s=>s.trim()).filter(Boolean)],
          time: timeMatch?.[1],
          dayNum: dayNum !== undefined ? DAYS[dayNum] : null,
          source: 'div',
        });
      });
    });

    // Probeer simpele lijst met tijden
    if (!results.length) {
      document.querySelectorAll('li, p').forEach(el => {
        const text = el.innerText.trim();
        if (/\b\d{1,2}[:.]\d{2}\b/.test(text) && text.length < 200) {
          results.push({ cells: [text], source: 'list' });
        }
      });
    }

    return results;
  });

  await page.close();
  console.log(`  ✓ ${classes.length} rijen gevonden`);
  return parseColosseumRows(classes);
}

function parseColosseumRows(rows) {
  const results = [];
  let currentDay = 1; // default maandag

  rows.forEach((row, i) => {
    // Probeer dag uit de rij te bepalen
    const dayText = (row.cells?.[0] ?? '').toLowerCase();
    const dayFromText = parseDay(dayText.slice(0, 2));
    if (dayFromText !== null) currentDay = dayFromText;
    if (row.dayNum !== null && row.dayNum !== undefined) currentDay = row.dayNum;

    const allText = row.cells?.join(' ') ?? '';
    const time = parseTime(row.time ?? allText);
    if (!time) return;

    // Klassenaam: eerste cel die geen dag of tijd is
    const nameCell = row.cells?.find(c => {
      if (!c || c.length < 2) return false;
      if (/^\d{1,2}[:.]\d{2}/.test(c)) return false;
      if (parseDay(c.toLowerCase().slice(0,2)) !== null) return false;
      return true;
    });

    const durMatch = allText.match(/(\d+)\s*(min|uur)/i);
    const dur = durMatch ? (durMatch[2].toLowerCase().startsWith('u') ? parseInt(durMatch[1])*60 : parseInt(durMatch[1])) : 60;

    results.push({
      id: `cc${i}`,
      day: currentDay,
      time,
      dur,
      type: nameCell?.slice(0, 50) ?? 'Kickboxen',
      level: '',
    });
  });

  return results;
}

// ── Hoofd ────────────────────────────────────────────────────────

async function main() {
  const fallback = loadFallback();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const result = {
    updated: new Date().toISOString(),
    schools: {
      colosseum: {
        name: 'The Colosseum',
        addr: 'Utrecht',
        classes: fallback?.schools?.colosseum?.classes ?? [],
      },
      sbgym: {
        name: 'SB Gym',
        addr: 'Utrecht',
        classes: fallback?.schools?.sbgym?.classes ?? [],
      },
      commit: {
        name: 'Commit Rivierenwijk',
        addr: 'Rivierenwijk, Utrecht',
        classes: fallback?.schools?.commit?.classes ?? [],
      },
    },
  };

  // The Colosseum
  try {
    const classes = await fetchColosseum(browser);
    if (classes.length >= 3) {
      result.schools.colosseum.classes = classes;
      console.log(`  → ${classes.length} lessen opgeslagen voor The Colosseum`);
    } else {
      console.warn('  ⚠ Te weinig lessen, gebruik fallback');
    }
  } catch(e) {
    console.error('  ✗ Colosseum mislukt:', e.message);
  }

  // SB Gym (Virtuagym)
  try {
    const classes = await fetchVirtuagym(browser, 'sbgym', 'sbgym');
    if (classes.length >= 3) {
      result.schools.sbgym.classes = classes;
      console.log(`  → ${classes.length} lessen opgeslagen voor SB Gym`);
    } else {
      console.warn('  ⚠ Te weinig lessen, gebruik fallback');
    }
  } catch(e) {
    console.error('  ✗ SB Gym mislukt:', e.message);
  }

  // Commit Rivierenwijk (Virtuagym)
  try {
    const classes = await fetchVirtuagym(browser, 'commit-rivierenwijk', 'commit');
    if (classes.length >= 3) {
      result.schools.commit.classes = classes;
      console.log(`  → ${classes.length} lessen opgeslagen voor Commit`);
    } else {
      console.warn('  ⚠ Te weinig lessen, gebruik fallback');
    }
  } catch(e) {
    console.error('  ✗ Commit mislukt:', e.message);
  }

  await browser.close();

  writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(`\n✅ schedules.json opgeslagen (${new Date().toLocaleString('nl-NL')})`);
}

main().catch(e => { console.error('Fatale fout:', e); process.exit(1); });
