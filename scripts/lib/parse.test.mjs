/**
 * Tests voor parse.mjs — draai met: node scripts/lib/parse.test.mjs
 */
import assert from 'assert';
import {
  parseDay, parseTime, parseDateTime,
  classFromObject, extractClassesFromJSON,
  isValidSchedule, finishClasses,
} from './parse.mjs';

// ── parse-helpers ──
assert.equal(parseDay('Maandag'), 1);
assert.equal(parseDay('di'), 2);
assert.equal(parseDay('Thursday'), 4);
assert.equal(parseDay(7), 0);
assert.equal(parseDay('Kickboksen'), null);
assert.equal(parseTime('18:00'), '18:00');
assert.equal(parseTime('9.30'), '09:30');
assert.equal(parseTime('19u15'), '19:15');
assert.equal(parseTime('99:99'), null);
assert.deepEqual(parseDateTime('2026-06-15 18:30:00'), { day: 1, time: '18:30' });
assert.equal(parseDateTime('volgende week'), null);

// ── Virtuagym-achtige payload (epoch-seconden, genest onder data) ──
const mon = new Date('2026-06-15T18:00:00'); // maandag
const vg = {
  status: 'ok',
  data: {
    schedule: [
      { activity_name: 'Kickboksen', start_time: Math.floor(mon.getTime()/1000), duration: 60 },
      { activity_name: 'Boksen',     start_time: Math.floor(mon.getTime()/1000) + 86400 + 3600, duration: 75 },
      { activity_name: 'Sparring',   start_time: Math.floor(mon.getTime()/1000) + 2*86400, duration: 60 },
    ],
  },
};
const vgClasses = finishClasses(extractClassesFromJSON(vg), 's');
assert.equal(vgClasses.length, 3);
assert.deepEqual(vgClasses[0], { id: 's01', day: 1, time: '18:00', dur: 60, type: 'Kickboksen', level: '' });
assert.equal(vgClasses[1].day, 2);
assert.equal(vgClasses[1].time, '19:00');
assert.equal(vgClasses[1].dur, 75);
assert.ok(isValidSchedule(vgClasses));

// ── ISO-datums + start/eind voor duur ──
const iso = [
  { name: 'Kickboxing Beginners', start: '2026-06-15T18:00:00', end: '2026-06-15T19:00:00' },
  { name: 'Kickboxing Advanced',  start: '2026-06-16T19:15:00', end: '2026-06-16T20:45:00' },
  { name: 'Open Mat',             start: '2026-06-20T10:00:00', end: '2026-06-20T11:30:00' },
];
const isoClasses = finishClasses(extractClassesFromJSON(iso), 'c');
assert.equal(isoClasses.length, 3);
assert.equal(isoClasses[1].dur, 90);
assert.equal(isoClasses[2].day, 6);

// ── Dagnaam + losse tijd ──
const named = [
  { title: 'Kickboksen', day: 'maandag', time: '18:00' },
  { title: 'Kickboksen', day: 'woensdag', time: '19:00', level: 'Gevorderd' },
  { title: 'Yoga', day: 'zaterdag', time: '09:30' },
];
const namedClasses = finishClasses(extractClassesFromJSON(named), 't');
assert.equal(namedClasses.length, 3);
assert.equal(namedClasses[1].level, 'Gevorderd');

// ── Ruis wordt geweigerd ──
assert.equal(classFromObject({ name: 'Cookiebeleid', id: 5 }), null);
assert.equal(classFromObject({ start: '18:00' }), null);
assert.equal(classFromObject(null), null);
const noise = { menu: [{ name: 'Home', url: '/' }, { name: 'Contact', url: '/contact' }] };
assert.deepEqual(extractClassesFromJSON(noise), []);

// dagnamen/nummers als "lesnaam" gefilterd, maar namen die op een
// dag-afkorting lijken (Matwork ~ "ma") blijven staan
const dom = finishClasses([
  { day: 1, time: '18:00', name: 'Maandag' },
  { day: 1, time: '18:00', name: '123' },
  { day: 1, time: '18:00', name: 'Matwork' },
  { day: 1, time: '18:00', name: 'Kickboksen' },
  { day: 1, time: '18.00', name: 'Kickboksen' }, // duplicaat, andere notatie
], 'x');
assert.deepEqual(dom.map(c => c.type).sort(), ['Kickboksen', 'Matwork']);

// ── validatie ──
assert.ok(!isValidSchedule([]));
assert.ok(!isValidSchedule(finishClasses([
  { day: 1, time: '18:00', name: 'A' }, { day: 1, time: '19:00', name: 'B' }, { day: 1, time: '20:00', name: 'C' },
], 'x'))); // 3 lessen maar 1 dag

console.log('✓ alle parse-tests geslaagd');

// ── ronde 4: AM/PM, ruisfilters ──
assert.equal(parseTime('7:00 PM'), '19:00');
assert.equal(parseTime('12:15 AM'), '00:15');
assert.equal(parseTime('11:30 am'), '11:30');
const r4 = finishClasses([
  { day: 1, time: '18:00', name: 'Vrijdag 17 juni' },
  { day: 1, time: '18:00', name: 'Groepslessen' },
  { day: 1, time: '18:00', name: '* De bokszak trainingen worden in de Garage gegeven.' },
  { day: 1, time: '18:00', name: 'Kickboksen wedstrijdgroep' },
  { day: 2, time: '7:00 PM', name: 'Boxing' },
], 'x');
assert.deepEqual(r4.map(c => `${c.day} ${c.time} ${c.type}`), ['1 18:00 Kickboksen wedstrijdgroep', '2 19:00 Boxing']);
console.log('✓ ronde-4 tests geslaagd');
