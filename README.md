# ParkPilot

A trip planner for U.S. national parks. Choose a park, confirm a start, and the page builds a road route, a fuel estimate, a trail comparison, and a day-by-day timeline on a map.

Driving miles, hike durations, and fuel are calculated in code. Missing road access, missing trailhead coordinates, and missing weather stay blank. The page does not draw a hiking path, because the National Park Service activities do not include a verified trail line.

## Run

From the repo root, copy the env template, then install and start the example app:

```bash
cp .env.example .env.local
cd example
npm install
npm test
npm run dev
```

Open `http://127.0.0.1:43123`.

Fill in `.env.local` at the repo root. That file is gitignored. The browser only calls `/api` on this dev server. Without a key, that source fails and the page says so.

`npm test` checks difficulty parsing, the fuel formula, and the timeline. It does not call the network.

## What the planner uses

- National Park Service park records, visitor centers, things to do, and alerts.
- OpenRouteService for place search and driving routes. The time is typical road speed, not live traffic.
- EIA weekly U.S. regular gasoline. The price and the week are shown, and you can type a different price.
- Open-Meteo for a forecast inside its window, and for 2022–2024 seasonal averages after that. NWS alerts are requested for the same point.
- Fuel is total driving miles ÷ the MPG you enter × price per gallon, for one vehicle.

Parks that are reached by ferry or plane, including Isle Royale, are not given a driving route. A trailhead that is not on a road is left out of the mileage and named.

An optional explanation can be requested from the model. It is kept only when every number in it already appears in the calculated packet. Otherwise the page keeps the calculated notes.
