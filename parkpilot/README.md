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

## Where to stay

After a park is chosen, My Trip can take either an exact place or a recommended town. Assigning a place does not reserve it. A separate control records a booking only when you say you already have one.

One base is the default. The same road legs update the day clock, the map, and fuel (`miles ÷ MPG × price`). Hiking miles stay separate. A missing road leg stays blank and is not treated as zero.

Town recommendations use OpenRouteService. Each town is scored from a geocoded reference point. Confirming a property replaces that point and recalculates. Before any trail is selected, the comparison is labeled provisional. A selected base stays until you accept a change.

Defaults, also listed in the ranking details on the page:

- Score weights: total driving 1, longest day 1.25, trail driving 1, arrival plus departure 0.7, and 75 minutes per lodging change. Displayed miles are unweighted.
- Daily driving limit: 180 minutes.
- Split stay: suggested only when driving savings are at least 40 minutes after a 30-minute relocation, a 20-minute check-in, and a 15-minute check-out.

A labeled development fixture is served only when `PARKPILOT_LODGING_FIXTURE=1` and you choose “Load labeled sample areas.” A failed catalog request does not substitute that fixture.
