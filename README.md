# Kickboks-planner

Weekrooster-app (PWA) voor kickbokslessen in Utrecht.

## Gyms

| Gym | Rooster | Workit 💼 |
|---|---|---|
| The Colosseum | [thecolosseum.nl](https://thecolosseum.nl/en/rooster/) | ✅ [via Workit](https://workit.nl/locaties/4251-the-colosseum-gym) |
| SB Gym | [sbgym.nl](https://sbgym.nl/lesrooster/) | — |
| Commit Rivierenwijk | [commit-i-do.com](https://www.commit-i-do.com/locaties/rivierenwijk/groepslessen-rivierenwijk/) | ✅ [via Workit](https://workit.nl/locaties/4317-commit-rivierenwijk) |
| Impact Fit | [impactfit.nl](https://impactfit.nl/lesrooster/) | — |
| Tigers Gym | [tigersgym.nl](https://tigersgym.nl/) | — |

Gyms met een **💼 Workit**-label zijn aangesloten bij [Workit](https://workit.nl/) (Bedrijfsfitness Nederland), zodat je er met je sportabonnement via je werkgever terechtkunt. In de app kun je hierop filteren met de Workit-chip.

## Hoe het werkt

- `index.html` — de app zelf (PWA, offline via `sw.js`)
- `schedules.json` — het actuele weekrooster per gym
- `scripts/fetch-schedules.mjs` — Playwright-scraper die de roosters ophaalt
- `.github/workflows/update-schedules.yml` — draait elke maandagochtend en commit het verse rooster

Lukt het ophalen van een gym niet, dan blijft het laatst bekende rooster van die gym staan.
