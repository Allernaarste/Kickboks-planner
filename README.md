# Kickboks Planner Utrecht 🥊

Aggregeert de roosters van drie Utrecht kickboxing gyms in één mobile-first PWA die je op je iPhone kunt toevoegen als app.

**Gyms:** The Colosseum · SB Gym · Commit Rivierenwijk

---

## Hoe werkt het?

```
GitHub Actions (Playwright + stealth)
       │  scrapt 2× per week
       ▼
  schedules.json  ──► GitHub Pages ──► PWA op je iPhone
```

Er is **geen backend server** nodig. GitHub Actions draait elke maandag en donderdag automatisch en scant de gymwebsites via een echte Chromium-browser (met stealth-mode om Cloudflare te omzeilen). Het resultaat wordt opgeslagen in `schedules.json`, waarna GitHub Pages de statische app bijwerkt.

---

## Eenmalige setup (doe dit één keer vanuit je iPhone)

### Stap 1 — Fork de repository

1. Ga naar `github.com` in Safari op je iPhone
2. Log in en zoek naar de repository
3. Tik op **Fork** (rechtsboven) → **Create fork**

### Stap 2 — Activeer GitHub Pages

1. Ga naar je geforkte repo → **Settings** (tandwiel) → **Pages**
2. Kies bij *Source*: **GitHub Actions**
3. Sla op

### Stap 3 — Geef Actions schrijfrechten

1. Ga naar **Settings → Actions → General**
2. Scroll naar *Workflow permissions* → kies **Read and write permissions**
3. Sla op

### Stap 4 — Eerste rooster ophalen

1. Ga naar het tabblad **Actions** in je repo
2. Kies de workflow **Rooster ophalen**
3. Tik op **Run workflow** → **Run workflow** (groen knopje)
4. Wacht ~3-5 minuten tot hij klaar is

### Stap 5 — PWA op je iPhone zetten

1. Open de GitHub Pages URL in Safari:
   `https://<jouw-gebruikersnaam>.github.io/kickboks-planner/`
2. Tik op het **Deel-icoon** (vierkantje met pijl omhoog)
3. Kies **Zet op beginscherm**
4. Tik op **Voeg toe**

De app staat nu als icoon op je beginscherm en werkt ook offline (met de meest recent gecachte data).

---

## Functies

| Functie | Details |
|---|---|
| Roosters | The Colosseum, SB Gym, Commit Rivierenwijk |
| Filters | Per school én per lestype (Kickboksen, Boksen, Zaktraining, Muay Thai, Sparring) |
| Week-navigatie | Huidige en volgende weken |
| Mijn Planning | Sla favoriete trainingen op |
| Agenda-export | Voeg les toe aan Apple Agenda (.ics + wekelijks herhalend) |
| Deel-functie | Stuur je planning via AirDrop / iMessage |
| Pull-to-refresh | Trek scherm naar beneden voor verse data |
| Offline | Service Worker cached de app én het rooster |
| Automatisch bijwerken | Elke maandag + donderdag via GitHub Actions |

---

## Rooster handmatig bijwerken

Ga naar **Actions → Rooster ophalen → Run workflow**.

---

## Lokaal draaien (optioneel)

```bash
npm install
npx playwright install chromium
npm run fetch          # schrijft schedules.json
# open index.html in browser
```

---

## Architectuur

```
scripts/
  fetch-schedules.mjs   ← Playwright scraper (Virtuagym API-intercept + DOM-fallback)
.github/workflows/
  update-schedules.yml  ← GitHub Actions: scrape + commit + deploy Pages
index.html              ← Volledige PWA (vanilla JS, inline CSS, geen build-stap)
manifest.json           ← PWA-manifest voor "Zet op beginscherm"
sw.js                   ← Service Worker (offline + netwerk-eerst voor schedules.json)
schedules.json          ← Gegenereerde roosterdata (wordt door Actions bijgehouden)
icon.svg                ← App-icoon
```
