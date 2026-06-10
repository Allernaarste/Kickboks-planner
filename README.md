# Kickboks-planner

Weekrooster-app (PWA) voor kickbokslessen in Utrecht.

## Gyms

| Gym | Rooster | Workit 💼 |
|---|---|---|
| The Colosseum | [thecolosseum.nl](https://thecolosseum.nl/en/rooster/) | ✅ [via Workit](https://workit.nl/locaties/4251-the-colosseum-gym) |
| SB Gym | [sbgym.nl](https://sbgym.nl/lesrooster/) | ✅ |
| Commit Rivierenwijk | [commit-i-do.com](https://www.commit-i-do.com/locaties/rivierenwijk/groepslessen-rivierenwijk/) | ✅ [via Workit](https://workit.nl/locaties/4317-commit-rivierenwijk) |
| Impact Fit | [impactfit.nl](https://impactfit.nl/lesrooster/) | — |
| Tigers Gym | [tigersgym.nl](https://tigersgym.nl/) | — |

Gyms met een **💼 Workit**-label zijn aangesloten bij [Workit](https://workit.nl/) (Bedrijfsfitness Nederland), zodat je er met je sportabonnement via je werkgever terechtkunt. In de app kun je hierop filteren met de Workit-chip.

## Hoe het werkt

- `index.html` — de app zelf (PWA, offline via `sw.js`)
- `schedules.json` — het actuele weekrooster per gym, met per gym een `live`-status
- `scripts/fetch-schedules.mjs` — Playwright-scraper die de roosters live ophaalt: vangt API-responses van rooster-widgets (o.a. Virtuagym), scrapet anders de DOM van alle frames, en volgt zo nodig zelf rooster-links op de site
- `.github/workflows/update-schedules.yml` — draait elke ochtend (06:00 NL) en commit het verse rooster

Per gym toont de app of het rooster **● Live** is (vers opgehaald) of dat het **● laatst bekende rooster** is. Lukt het ophalen van een gym niet, dan blijft het laatst bekende rooster staan en wordt dat eerlijk gemarkeerd; levert geen enkele gym live data, dan faalt de workflow zichtbaar.
