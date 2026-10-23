# ParkPilot experience amendment

The running example is the Recommend planner: a searchable NPS catalog, a confirmed start, a road route, fuel, trail comparison, a day timeline, a map, and packing. Lodging is still not priced. Figures on the page come from the live responses, not from the October 22 sample list below.

The sample list is the set retrieved while the product was being checked. It is not what the page displays after a refresh.

The original guide already has three places: Discover, My Trip, and Prepare. This note keeps that shell and changes what each place is allowed to show, based on the data that actually returns.

## How this sits on the original design

The design guide asks for progressive disclosure: Discover is visual, Plan is structured, Prepare is operational. Mobile is for today’s action. Desktop is for comparison. Those rules stay.

What changes is the cost story. The first guide’s budget asked the traveler to type a lodging rate, meals, and airfare, then showed a partial total. Those prices are not in the free feeds. The first screen now logs only measurements we can retrieve or compute:

- Distance from a verified airport road point to the park visitor center.
- Distance from a verified closer location, when that point routes.
- The number of trails that can be scheduled: one hike, one difficulty, and a published duration. A page that lists many trails does not count.
- Estimated gas: those miles divided by the traveler’s MPG, times a weekly gasoline price. The live example uses the EIA U.S. regular series and shows the week. The Rocky Mountain price was the earlier Utah check, and it is not applied unless you type it.
- The NPS private-vehicle entrance fee, because that amount is published.

Weather is not part of choosing the park. Historical visitation can still appear as context, labeled with the month and year. The forecast, active alerts, backup trail, and packing list open after an itinerary exists. That is the original Prepare step, used the day you are there as well as before you leave. “Live” means the latest Open-Meteo forecast and NWS alert for the visitor-center point, refreshed on request. It is not a sensor on the trail.

## Three flows

**Recommend.** Search any national park. Rank and explain using trail count, airport distance, location distance, and gas. If a start pin does not route, miles and gas stay unverified. A park with only mixed trail pages shows a trail count of zero.

**Plan.** Filter the schedulable trails by easy, moderate, or strenuous and build the day. Keep the duration text, the permit flag, and the day-capacity check. Do not open the forecast on this screen.

**Today.** Read the saved day against the forecast for that park’s visitor center. Name the point and the check time. If a strenuous trail meets precipitation, offer one easier trail from the same catalog and wait for approval. The packing line is an estimate from duration, difficulty, and the high, low, and precipitation.

## Sample figures, retrieved October 22, 2026

- Zion: 7 schedulable trails. Las Vegas airport to the visitor center, 178.7 miles, 208 minutes. St. George, 47 miles, 65 minutes. Entrance $35.
- Bryce Canyon: 4 schedulable trails. From the Zion visitor center, 85 miles, 124 minutes. No airport pin verified yet. Entrance $35.
- Capitol Reef: entrance $20. Trail pages mix several hikes, so the schedulable count is zero.
- Acadia confirms the same pattern outside Utah: Hulls Cove Visitor Center has its own forecast, and Bar Harbor to that center is about 3 miles. The Bangor airport pin did not route.

## Where to stay

Lodging is chosen in My Trip and is not priced. Two paths share one trip: search an exact place, or compare up to three towns. States stay distinct: area selected, exact property selected, and booking confirmed by you. A search or a “use this base” action never marks a reservation.

Towns come from the OpenRouteService place catalog. Nearby lodging places are grouped by town, then each town is geocoded to one reference point. Road time to that point is a real driving route. When a property is confirmed, its coordinates replace the reference and the same legs are recalculated.

Before trails are selected, the comparison is provisional and says so. Adding trails updates the comparison. The selected base remains until the traveler accepts a proposed change. Direct edits, including assigning a property or changing the daily driving limit, recalculate immediately.

The score is deterministic. Total driving is the base. The longest day has weight 1.25, driving that touches a trail has weight 1, and the arrival plus departure portion has weight 0.7. Each lodging change adds 75 minutes. Those weights order the cards. The miles on the card are the unweighted sum. Incomplete coverage is not scored, and an unknown leg is never stored as zero.

A split stay is shown next to the single-base cards. It is suggested only when the driving savings beat the best single base by at least 40 minutes after subtracting 30 minutes of relocation, 20 minutes of check-in, and 15 minutes of check-out. The preferred daily driving limit starts at 180 minutes.

The day clock uses those same legs: arrival once, each lodging transfer once, local drives, and the departure once. Fuel uses that mileage. Hiking distance stays on its own line. Airport pickup, parking, meals, rest, and daylight allowances stay in the timeline.

A development fixture of three towns exists only behind `PARKPILOT_LODGING_FIXTURE=1` and an explicit button. If the catalog fails, the page says so and does not fill in sample towns.

## What to change in the kit

- **PRODUCT_PRD.md.** Replace the lodging-led budget acceptance test with airport distance, location distance, schedulable trail count, and gas. Move forecast weather from comparison into Prepare / Today.
- **DESIGN_SYSTEM.md.** The first card shows those four measurements. The budget chart of typed lodging rates comes out. Today’s screen keeps the manual refresh, the risk label, and the packing estimate.
- **DATA_AND_TRUST.md.** Gas and road distance stay estimated. Weather on Today is the visitor-center forecast. A failed route is unverified.
- **TECHNICAL_PLAN.md.** One trip object still carries the park, the start point, the selected activity IDs, and the last weather check.
- **CURSOR_PROMPTS.md and QA_AND_DEMO.md.** Add a case where lodging is absent on purpose, a case where the airport pin will not route, and a case where Today is opened before any trail is selected.
