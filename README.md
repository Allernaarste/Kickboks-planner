# Kickboks-planner

Weekrooster-app (PWA) voor kickbokslessen in Utrecht.

## Gyms

| Gym | Roosterbron | Workit 💼 |
|---|---|---|
| The Colosseum | live gescrapet — agenda-widget (Europe Web Company) | ✅ [via Workit](https://workit.nl/locaties/4251-the-colosseum-gym) |
| SB Gym | live gescrapet — SportBit-rooster op [sbgym.nl](https://sbgym.nl/lesrooster/) | ✅ |
| Commit Rivierenwijk | live gescrapet — Virtuagym-weekrooster | ✅ [via Workit](https://workit.nl/locaties/4317-commit-rivierenwijk) |
| Impact Fit | [impactfit.nl](https://impactfit.nl/lesrooster/) publiceert het rooster alleen als afbeelding; app toont laatst bekende rooster | — |
| Tigers Gym | live gescrapet — weektabel op [tigersgym.nl](https://tigersgym.nl/) | — |

Gyms met een **💼 Workit**-label zijn aangesloten bij [Workit](https://workit.nl/) (Bedrijfsfitness Nederland), zodat je er met je sportabonnement via je werkgever terechtkunt. In de app kun je hierop filteren met de Workit-chip.

## Hoe het werkt

- `index.html` — de app zelf (PWA, offline via `sw.js`)
- `schedules.json` — het actuele weekrooster per gym, met per gym een `live`-status
- `scripts/fetch-schedules.mjs` — Playwright-scraper die de roosters live ophaalt: vangt API-responses en inline JSON (`__NEXT_DATA__`, ld+json), scrapet de DOM van alle frames (SportBit-/week-grid-/tabel-/tekstlayouts), opent rooster-widget-iframes direct, en volgt zelf rooster-links op de site ("actief zoeken")
- `scripts/lib/parse.mjs` — pure parse-heuristiek met tests (`node scripts/lib/parse.test.mjs`)
- `.github/workflows/update-schedules.yml` — draait elke ochtend (06:00 NL) en commit het verse rooster

Per gym toont de app of het rooster **● Live** is (vers opgehaald) of dat het **● laatst bekende rooster** is. Een scrape telt pas als live bij ≥3 lessen op ≥2 verschillende dagen; anders blijft het laatst bekende rooster staan, eerlijk gemarkeerd. Levert geen enkele gym live data, dan faalt de workflow zichtbaar. Impact Fit publiceert zijn rooster uitsluitend als afbeelding (en ClassPass toont alleen de lessen van vandaag), dus die gym blijft op het laatst bekende rooster staan totdat er een machine-leesbare bron is.
