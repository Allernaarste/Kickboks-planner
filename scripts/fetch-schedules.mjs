/**
 * fetch-schedules.mjs
 * Haalt roosters op van drie Utrechtse vechtsporten scholen via Playwright.
 * The Colosseum  – DOM-scraping van thecolosseum.nl
 * SB Gym         – Virtuagym network-intercept (sbgym.virtuagym.com)
 * Commit         – Virtuagym network-intercept (commit-rivierenwijk.virtuagym.com)
 *
 * Uitvoer: schedules.json (overschrijft bestaand bestand)
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'fs';

const OUT = 'schedules.json';

// Dag-helpers
const DAY_NL = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'];
function dayIndex(str) {
  if (!str) return -1;
  const s = str.toLowerCase().trim();
  const idx = DAY_NL.findIndex(d => s.startsWith(d));
  if (idx >= 0) return idx;
  // fallback Engels
  const EN = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return EN.findIndex(d => s.startsWith(d));
}

function parseTime(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})[:\.](\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : null;
}

function parseDur(str) {
  if (!str) return 60;
  const m = str.match(/(\d+)/);
  return m ? parseInt(m[1]) : 60;
}

// ── The Colosseum ──────────────────────────────────────────────────────────────
async function fetchColosseum(browser) {
  const page = await browser.newPage();
  const classes = [];
  try {
    await page.goto('https://thecolosseum.nl/en/rooster/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Probeer tabel- of lijststructuur
    const rows = await page.$$eval(
      'table tr, .rooster-row, .schedule-row, .lesson-row, [class*="schedule"] tr, [class*="rooster"] tr',
      rows => rows.map(r => ({
        cells: Array.from(r.querySelectorAll('td, th, [class*="cell"]')).map(c => c.innerText.trim()),
        text: r.innerText.trim()
      }))
    );

    let idCounter = 1;
    for (const row of rows) {
      const { cells } = row;
      if (cells.length < 3) continue;
      // Verwacht: [dag, tijd, type, level?, duur?]
      const dayIdx = dayIndex(cells[0]);
      const time = parseTime(cells[1]);
      if (dayIdx < 0 || !time) continue;
      const type = cells[2] || 'Les';
      const level = cells[3] || 'Alle niveaus';
      const dur = parseDur(cells[4]);
      classes.push({
        id: `c${String(idCounter++).padStart(2,'0')}`,
        day: dayIdx,
        time,
        dur,
        type,
        level
      });
    }

    // Als geen rijen gevonden, probeer tekst-extractie als fallback
    if (classes.length === 0) {
      const text = await page.evaluate(() => document.body.innerText);
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      let currentDay = -1;
      for (const line of lines) {
        const di = dayIndex(line);
        if (di >= 0) { currentDay = di; continue; }
        if (currentDay < 0) continue;
        const time = parseTime(line);
        if (!time) continue;
        const rest = line.replace(/\d{1,2}[:.]\d{2}/, '').trim();
        classes.push({
          id: `c${String(idCounter++).padStart(2,'0')}`,
          day: currentDay,
          time,
          dur: 60,
          type: rest || 'Les',
          level: 'Alle niveaus'
        });
      }
    }
  } catch (e) {
    console.error('Colosseum error:', e.message);
  } finally {
    await page.close();
  }
  console.log(`Colosseum: ${classes.length} lessen gevonden`);
  return classes;
}

// ── Virtuagym helper (SB Gym + Commit) ────────────────────────────────────────
async function fetchVirtuagym(browser, subdomain, prefix) {
  const classes = [];
  const page = await browser.newPage();

  // Intercept API responses
  const captured = [];
  page.on('response', async response => {
    const url = response.url();
    if (url.includes('/api/') && (url.includes('group_lesson') || url.includes('schedule') || url.includes('planning'))) {
      try {
        const json = await response.json();
        captured.push(json);
      } catch (_) {}
    }
  });

  try {
    const url = `https://${subdomain}.virtuagym.com/classes/week`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Scroll door de pagina om lazy-load te triggeren
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // Verwerk gevangen API-data
    for (const json of captured) {
      const items = Array.isArray(json) ? json : (json.data || json.items || json.classes || []);
      let idCounter = classes.length + 1;
      for (const item of items) {
        const start = item.start_time || item.start || item.starttime || '';
        const d = new Date(start);
        const dayIdx = isNaN(d) ? -1 : d.getDay();
        if (dayIdx < 0) continue;
        const time = isNaN(d) ? null : `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        if (!time) continue;
        const end = item.end_time || item.end || item.endtime || '';
        const endD = new Date(end);
        const dur = (!isNaN(endD) && !isNaN(d)) ? Math.round((endD - d) / 60000) : 60;
        classes.push({
          id: `${prefix}${String(idCounter++).padStart(2,'0')}`,
          day: dayIdx,
          time,
          dur: dur || 60,
          type: item.name || item.class_name || item.title || 'Les',
          level: item.level || item.description || 'Alle niveaus'
        });
      }
    }

    // DOM-fallback als API niets opleverde
    if (classes.length === 0) {
      const domClasses = await page.$$eval(
        '.class-item, .lesson-item, .schedule-item, [class*="class-block"], [class*="lesson"]',
        els => els.map(el => ({
          text: el.innerText.trim(),
          dataDay: el.dataset.day || el.dataset.dayofweek || '',
          dataTime: el.dataset.time || el.dataset.starttime || ''
        }))
      );
      let idCounter = classes.length + 1;
      for (const el of domClasses) {
        const lines = el.text.split('\n').map(s => s.trim()).filter(Boolean);
        const time = parseTime(el.dataTime || lines[0]);
        const dayIdx = el.dataDay ? parseInt(el.dataDay) : dayIndex(lines[0]);
        if (!time || dayIdx < 0) continue;
        classes.push({
          id: `${prefix}${String(idCounter++).padStart(2,'0')}`,
          day: dayIdx,
          time,
          dur: 60,
          type: lines[1] || 'Les',
          level: lines[2] || 'Alle niveaus'
        });
      }
    }
  } catch (e) {
    console.error(`${subdomain} error:`, e.message);
  } finally {
    await page.close();
  }
  console.log(`${subdomain}: ${classes.length} lessen gevonden`);
  return classes;
}

// ── Hoofd ──────────────────────────────────────────────────────────────────────
(async () => {
  // Laad bestaande data als fallback
  let existing = { schools: {} };
  try { existing = JSON.parse(readFileSync(OUT, 'utf8')); } catch (_) {}

  const browser = await chromium.launch({ headless: true });

  const [colosseumClasses, sbClasses, commitClasses] = await Promise.all([
    fetchColosseum(browser),
    fetchVirtuagym(browser, 'sbgym', 's'),
    fetchVirtuagym(browser, 'commit-rivierenwijk', 'm')
  ]);

  await browser.close();

  // Gebruik bestaande data als fallback wanneer scraping niets opleverde
  const result = {
    updated: new Date().toISOString(),
    note: 'Automatisch bijgewerkt door GitHub Actions',
    schools: {
      colosseum: {
        name: 'The Colosseum',
        url: 'https://thecolosseum.nl/en/rooster/',
        addr: 'Utrecht',
        classes: colosseumClasses.length > 0
          ? colosseumClasses
          : (existing.schools?.colosseum?.classes || [])
      },
      sbgym: {
        name: 'SB Gym',
        url: 'https://sbgym.nl/lesrooster/',
        addr: 'Utrecht',
        classes: sbClasses.length > 0
          ? sbClasses
          : (existing.schools?.sbgym?.classes || [])
      },
      commit: {
        name: 'Commit Rivierenwijk',
        url: 'https://www.commit-i-do.com/locaties/rivierenwijk/groepslessen-rivierenwijk/',
        addr: 'Amaliadwarsstraat 2A, Utrecht',
        classes: commitClasses.length > 0
          ? commitClasses
          : (existing.schools?.commit?.classes || [])
      }
    }
  };

  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`schedules.json bijgewerkt (${new Date().toISOString()})`);
})();
