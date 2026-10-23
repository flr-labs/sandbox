import assert from "node:assert/strict";
import test from "node:test";
import { fuelCost } from "./fuel.mjs";
import { buildItinerary } from "./schedule.mjs";
import { legKey, stayNights } from "./legs.mjs";
import { lodgingHtml } from "../src/lodging-view.js";
import {
  applyProposal,
  areasFromCatalog,
  assignArea,
  assignProperty,
  confirmBooking,
  nightStatus,
  proposalFrom,
  recommendStays,
  routingPlace,
} from "./lodging.mjs";

const origin = { id: "origin", name: "Las Vegas", lat: 36.08, lon: -115.15 };
const entrance = { id: "entrance", name: "Visitor center", lat: 37.2, lon: -112.98 };
const near = {
  id: "springdale",
  name: "Springdale",
  reference: { name: "Springdale town reference", lat: 37.1889, lon: -112.9986 },
  source: "Test catalog",
  retrievedAt: "2026-10-22T00:00:00.000Z",
  fixture: false,
};
const far = {
  id: "far-town",
  name: "Far Town",
  reference: { name: "Far Town reference", lat: 36.5, lon: -114.5 },
  source: "Test catalog",
  retrievedAt: "2026-10-22T00:00:00.000Z",
  fixture: false,
};
const watchman = { id: "watchman", name: "Watchman", minutes: 60, miles: 3, lat: 37.21, lon: -112.95, preferredDay: 0 };
const canyon = { id: "canyon", name: "Canyon", minutes: 90, miles: 2, lat: 37.25, lon: -112.94, preferredDay: 2 };

function bookOf(fn) {
  return new Proxy(Object.create(null), {
    has() { return true; },
    get(_target, property) {
      if (typeof property !== "string" || !property.includes("|")) return undefined;
      return fn(property);
    },
  });
}

function minutesFor(key) {
  if (key.includes("36.50000,-114.50000")) return 240;
  if (key.includes("36.08000,-115.15000") && key.includes("37.18890,-112.99860")) return 80;
  return 20;
}

function knownBook() {
  return bookOf((key) => ({ status: "known", minutes: minutesFor(key), miles: minutesFor(key) / 2 }));
}

function stayInput(extra = {}) {
  return {
    startDate: "2026-10-24",
    dayCount: 3,
    departTime: "08:00",
    returnBy: "20:00",
    airport: false,
    roundTrip: true,
    originPoint: origin,
    entrancePoint: entrance,
    sunsetByDate: {},
    trails: [],
    stay: {
      nightByDate: {
        "2026-10-24": { id: near.id, name: near.name, lat: near.reference.lat, lon: near.reference.lon },
        "2026-10-25": { id: near.id, name: near.name, lat: near.reference.lat, lon: near.reference.lon },
      },
      legBook: knownBook(),
      checkInMin: 20,
      checkOutMin: 15,
      relocationMin: 0,
      maxDailyDriveMin: 180,
    },
    ...extra,
  };
}

test("lodging status never treats a selection as a reservation", () => {
  const areaNight = assignArea({}, ["2026-10-24"], near)["2026-10-24"];
  assert.equal(nightStatus(areaNight), "area");
  assert.equal(areaNight.confirmed, false);
  const property = { id: "inn", label: "Watchman Inn", lat: 37.19, lon: -112.99 };
  const propertyNight = assignProperty({ "2026-10-24": areaNight }, ["2026-10-24"], property)["2026-10-24"];
  assert.equal(nightStatus(propertyNight), "property");
  assert.equal(propertyNight.confirmed, false);
  const booked = confirmBooking({ "2026-10-24": propertyNight }, "2026-10-24", true)["2026-10-24"];
  assert.equal(nightStatus(booked), "confirmed");
  assert.equal(routingPlace(propertyNight).estimate, "property");
  assert.equal(routingPlace(propertyNight).lat, 37.19);
  assert.notEqual(routingPlace(areaNight).lat, routingPlace(propertyNight).lat);
});

test("a one-base stay counts arrival and departure once and keeps hiking separate", () => {
  const plan = buildItinerary(stayInput({ trails: [watchman, canyon] }));
  const kinds = plan.travel.legs.map((leg) => leg.kind);
  assert.equal(kinds.filter((kind) => kind === "arrival").length, 1);
  assert.equal(kinds.filter((kind) => kind === "departure").length, 1);
  assert.equal(kinds.filter((kind) => kind === "transfer").length, 0);
  assert.equal(plan.travel.complete, true);
  assert.equal(plan.hikingMiles, 5);
  assert.ok(plan.days[0].items.some((item) => item.kind === "hike" && item.minutes === 60));
  assert.equal(fuelCost(plan.travel.miles, 25, 4), Math.round((plan.travel.miles / 25) * 4 * 100) / 100);
});

test("a split stay counts the lodging transfer once", () => {
  const plan = buildItinerary(stayInput({
    stay: {
      ...stayInput().stay,
      relocationMin: 30,
      nightByDate: {
        "2026-10-24": { id: near.id, name: near.name, lat: near.reference.lat, lon: near.reference.lon },
        "2026-10-25": { id: far.id, name: far.name, lat: far.reference.lat, lon: far.reference.lon },
      },
    },
  }));
  const kinds = plan.travel.legs.map((leg) => leg.kind);
  assert.equal(kinds.filter((kind) => kind === "arrival").length, 1);
  assert.equal(kinds.filter((kind) => kind === "departure").length, 1);
  assert.equal(kinds.filter((kind) => kind === "transfer").length, 1);
  assert.ok(plan.days[1].items.some((item) => /Check-in at Far Town/.test(item.title)));
});

test("a missing road leg stays unknown and does not become zero miles", () => {
  const base = stayInput({ trails: [watchman] });
  const brokenKey = legKey(
    { lat: near.reference.lat, lon: near.reference.lon },
    { lat: watchman.lat, lon: watchman.lon },
  );
  const legBook = bookOf((key) => (key === brokenKey
    ? { status: "unknown", minutes: null, miles: null }
    : { status: "known", minutes: 30, miles: 15 }));
  const plan = buildItinerary({ ...base, stay: { ...base.stay, legBook } });
  assert.equal(plan.travel.complete, false);
  assert.equal(plan.travel.miles, null);
  assert.equal(plan.travel.minutes, null);
  assert.ok(plan.travel.knownMiles > 0);
  assert.equal(fuelCost(plan.travel.miles, 25, 4), null);
  assert.ok(plan.conflicts.some((conflict) => conflict.code === "missing-leg"));
});

test("a far base names the day it exceeds the driving limit", () => {
  const ranking = recommendStays({
    startDate: "2026-10-24",
    dayCount: 3,
    departTime: "08:00",
    returnBy: "20:00",
    roundTrip: true,
    origin,
    entrance,
    nights: stayNights(["2026-10-24", "2026-10-25", "2026-10-26"]),
    trails: [watchman],
    candidates: [near, far],
    legBook: knownBook(),
    maxDailyDriveMin: 180,
  });
  const farArea = ranking.areas.find((area) => area.id === "far-town");
  const conflict = farArea.conflicts.find((item) => item.code === "long-drive");
  assert.ok(conflict);
  assert.match(conflict.message, /Far Town/);
  assert.match(conflict.message, /2026-10-24/);
  assert.match(conflict.message, /180/);
  assert.equal(ranking.areas[0].id, "springdale");
});

test("recommendations stay provisional until activities exist and do not replace a saved base", () => {
  const shared = {
    startDate: "2026-10-24",
    dayCount: 3,
    departTime: "08:00",
    returnBy: "20:00",
    roundTrip: true,
    origin,
    entrance,
    nights: ["2026-10-24", "2026-10-25"],
    candidates: [near, far],
    legBook: knownBook(),
    maxDailyDriveMin: 180,
  };
  const before = recommendStays({ ...shared, trails: [] });
  assert.equal(before.provisional, true);
  assert.match(before.areas[0].reason, /Selected trails are not in this comparison yet/);
  const nights = assignArea({}, ["2026-10-24", "2026-10-25"], far);
  const after = recommendStays({ ...shared, trails: [watchman, canyon] });
  assert.equal(after.provisional, false);
  assert.equal(nights["2026-10-24"].area.id, "far-town");
  const proposal = proposalFrom(after, "far-town");
  assert.equal(proposal.proposedId, "springdale");
  assert.equal(applyProposal(nights, null)["2026-10-24"].area.id, "far-town");
  const accepted = applyProposal(nights, { ...proposal, kind: "area", dates: proposal.dates, area: near });
  assert.equal(accepted["2026-10-24"].area.id, "springdale");
  assert.equal(nights["2026-10-24"].area.id, "far-town");
});

test("property coordinates replace the town reference in the routed plan", () => {
  const property = { id: "inn", name: "Watchman Inn", lat: 37.11111, lon: -112.91111 };
  const areaPlan = buildItinerary(stayInput());
  const propertyPlan = buildItinerary(stayInput({
    stay: {
      ...stayInput().stay,
      nightByDate: {
        "2026-10-24": property,
        "2026-10-25": property,
      },
    },
  }));
  assert.notEqual(areaPlan.travel.minutes, propertyPlan.travel.minutes);
  assert.ok(propertyPlan.travel.legs.some((leg) => leg.fromName === "Watchman Inn" || leg.toName === "Watchman Inn"));
});

test("a split is suggested only after allowances clear the threshold", () => {
  const ranking = recommendStays({
    startDate: "2026-10-24",
    dayCount: 3,
    departTime: "08:00",
    returnBy: "20:00",
    roundTrip: true,
    origin,
    entrance,
    nights: ["2026-10-24", "2026-10-25"],
    trails: [watchman],
    candidates: [near, far],
    legBook: knownBook(),
    maxDailyDriveMin: 600,
    defaults: { splitStay: { minimumSavingsMinutes: 40, relocationAllowanceMinutes: 30, checkInMinutes: 20, checkOutMinutes: 15 } },
  });
  assert.ok(ranking.split);
  assert.equal(ranking.split.allowanceMinutes, 65);
  if (ranking.split.suggested) assert.ok(ranking.split.netMinutes >= 40);
  else assert.ok(ranking.split.netMinutes == null || ranking.split.netMinutes < 40);
});

test("an incomplete route is not ranked ahead of a complete one", () => {
  const ranking = recommendStays({
    startDate: "2026-10-24",
    dayCount: 2,
    departTime: "08:00",
    returnBy: "20:00",
    roundTrip: true,
    origin,
    entrance,
    nights: ["2026-10-24"],
    trails: [],
    candidates: [far, near],
    maxDailyDriveMin: 600,
    legBook: bookOf((key) => (key.includes("36.50000,-114.50000")
      ? { status: "unknown", minutes: null, miles: null }
      : { status: "known", minutes: 50, miles: 25 })),
  });
  assert.equal(ranking.areas.at(-1).metrics.complete, false);
  assert.equal(ranking.areas.at(-1).metrics.totalMiles, null);
  assert.equal(ranking.areas[0].metrics.complete, true);
  assert.notEqual(ranking.areas[0].id, ranking.areas.find((area) => !area.metrics.complete).id);
});

test("the park locality stays in the candidate list ahead of a busier town", () => {
  const built = areasFromCatalog(
    [
      { locality: "St. George" },
      { locality: "St. George" },
      { locality: "St. George" },
      { locality: "Springdale" },
    ],
    [
      { name: "St. George", label: "St. George, UT", lat: 37.1, lon: -113.5 },
      { name: "Springdale", label: "Springdale, UT", lat: 37.18, lon: -112.99 },
    ],
    { retrievedAt: "2026-10-22T00:00:00.000Z", source: "Test geocoder", limit: 1, preferred: ["Springdale"] },
  );
  assert.equal(built.areas[0].name, "Springdale");
});

test("catalog rows without a geocoded reference are skipped", () => {
  const built = areasFromCatalog(
    [{ locality: "Springdale", region: "UT" }, { locality: "Springdale", region: "UT" }, { locality: "Orderville", region: "UT" }],
    [{ name: "Springdale", label: "Springdale, UT", lat: 37.19, lon: -112.99 }],
    { retrievedAt: "2026-10-22T00:00:00.000Z", source: "Test geocoder", limit: 3 },
  );
  assert.equal(built.areas.length, 1);
  assert.equal(built.areas[0].fixture, false);
  assert.deepEqual(built.skipped, ["Orderville"]);
});

test("a town just outside the drive limit stays separate from the recommended stay", () => {
  const html = lodgingHtml({
    mode: "help",
    maxMiles: 60,
    areaStatus: "ok",
    nights: [],
    openDetails: {},
    areas: [
      {
        id: "springdale",
        name: "Springdale",
        reason: "Lowest total driving for the 2 scheduled trails.",
        parkDistance: "12 mi by road · 20 min",
        parkMiles: 12,
        complete: true,
        distanceLabel: "80 mi · 2 hr",
        selected: false,
        review: false,
        legs: [],
      },
      {
        id: "hurricane",
        name: "Hurricane",
        outside: true,
        parkDistance: "68 mi by road · 1 hr 10 min",
        parkMiles: 68,
        complete: true,
        selected: false,
        review: false,
        legs: [],
      },
    ],
  });
  assert.match(html, /Why it fits:/);
  assert.match(html, /Lowest total driving for the 2 scheduled trails/);
  assert.match(html, /From the park:/);
  assert.match(html, /12 mi by road/);
  assert.match(html, /Just outside your drive limit/);
  assert.match(html, /Just outside the 60 mi drive limit, 68 mi by road/);
  assert.match(html, /<p class="eyebrow">Just outside<\/p>[\s\S]*<h3>Hurricane<\/h3>/);
});

test("the lodging section lists stay choices without a second nights card or invented price", () => {
  const html = lodgingHtml({
    mode: "help",
    maxHours: 3,
    query: "",
    lookupText: "",
    hits: [{ label: "Watchman Inn, Springdale, UT", layer: "venue" }],
    choiceIndex: 0,
    choiceLabel: "Watchman Inn, Springdale, UT",
    nights: [
      { date: "2026-10-24", status: "area", statusLabel: "Area selected", placeName: "Springdale · town reference", picked: true, confirmed: false },
      { date: "2026-10-25", status: "property", statusLabel: "Exact property selected", placeName: "Watchman Inn · exact property", picked: true, confirmed: false },
      { date: "2026-10-26", status: "confirmed", statusLabel: "Booking confirmed by you", placeName: "Watchman Inn", picked: false, locked: true, confirmed: true },
    ],
    areaStatus: "ok",
    areaMessage: "Up to three towns.",
    provisional: true,
    areas: [{
      id: "springdale",
      focusId: "stay-springdale",
      name: "Springdale",
      reason: "Based on the start, the dates, and the park reference.",
      tradeoff: "Lowest calculated driving of the complete options.",
      distanceLabel: "40 mi · 1 hr",
      longestLabel: "Longest day 10-24 · 1 hr",
      entranceLabel: "Entrance: Zion Canyon Visitor Center",
      estimate: "Town reference, routes complete",
      referenceName: "Springdale town reference",
      source: "OpenRouteService geocoder",
      fresh: "Oct 22, 2026",
      conflicts: "",
      selected: false,
      review: false,
      legs: [{ kind: "arrival", fromName: "Las Vegas", toName: "Springdale", status: "known", miles: 40, minutes: 60 }],
    }],
    split: {
      name: "Springdale then Hurricane",
      suggested: false,
      math: "Net 10 minutes. The suggestion threshold is 40 minutes.",
      nights: "2026-10-24 Springdale; 2026-10-25 Hurricane",
      legs: [],
    },
    proposal: {
      summary: "Use Hurricane instead of the current base.",
      before: "Current plan: 80 mi, 2 hr",
      after: "Proposed plan: 50 mi, 1 hr",
      nights: "2026-10-24, 2026-10-25",
    },
    defaults: { checkIn: 20, checkOut: 15, relocation: 30 },
    method: "Unknown legs are excluded from the score.",
    legNote: "Road legs come from the same driving request as the clock and the fuel line.",
    openDetails: {},
  });
  assert.doesNotMatch(html, /I know where I’m staying/);
  assert.doesNotMatch(html, /Help me choose an area/);
  assert.doesNotMatch(html, /Selecting Homebase/);
  assert.match(html, /Add to itinerary/);
  assert.match(html, /View on map/);
  assert.match(html, /From the park/);
  assert.match(html, /Distance to the park entrance is not verified/);
  assert.match(html, /Keep the current plan/);
  assert.match(html, /does not reserve it/);
  assert.doesNotMatch(html, /Provisional/);
  assert.doesNotMatch(html, /\$\d|per night/);
});
