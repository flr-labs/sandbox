import assert from "node:assert/strict";
import test from "node:test";
import { difficultyOf, elevationGain, hoursFromDuration, parseActivity, routeType, trailMiles } from "./parse.mjs";
import { fuelCost, numbersAreGrounded } from "./fuel.mjs";
import { buildItinerary, formatClock } from "./schedule.mjs";
import { recommendPacking } from "./advice.mjs";

test("published difficulty wins over distance", () => {
  const text = "Difficulty: Easy. Distance: 5.5 miles. Relatively easy depending on how much of the rim you walk.";
  assert.equal(difficultyOf(text, 5.5).level, "easy");
  assert.equal(difficultyOf(text, 5.5).estimated, false);
});

test("drop-off wording is not a difficulty", () => {
  const text = "A moderate out-and-back with moderate drop-offs. Distance: 3.3 miles. Elevation Gain: 650 feet.";
  const level = difficultyOf(text, trailMiles(text));
  assert.equal(level.level, "moderate");
  assert.equal(routeType(text), "out-and-back");
  assert.equal(elevationGain(text), 650);
});

test("miles away is not trail length", () => {
  assert.equal(trailMiles("The viewpoint is 100 miles away and worth a stop."), null);
});

test("two stated levels stay mixed", () => {
  assert.equal(difficultyOf("This easy or moderate trail changes by section.", 2).level, "mixed");
});

test("distance estimates are labeled when no word is present", () => {
  const estimate = difficultyOf("A walk along the river.", 3.5);
  assert.equal(estimate.level, "moderate");
  assert.equal(estimate.estimated, true);
});

test("duration uses the top of the range", () => {
  assert.equal(hoursFromDuration("1-8 Hours"), 8);
  assert.equal(hoursFromDuration("30-60 Minutes"), 1);
});

test("collection pages are not one hike", () => {
  const trail = parseActivity({
    id: "1",
    title: "Hike an Easy or Moderate Trail",
    shortDescription: "Choose among several trails.",
    duration: "1-3 Hours",
    activities: [{ name: "Hiking" }],
  });
  assert.equal(trail.schedulable, false);
  assert.equal(trail.collection, true);
});

test("fuel uses miles divided by mpg times price", () => {
  assert.equal(fuelCost(100, 25, 4), 16);
  assert.equal(fuelCost(null, 25, 4), null);
  assert.equal(fuelCost(100, 0, 4), null);
});

test("a normal day keeps the hike and the return", () => {
  const plan = buildItinerary({
    startDate: "2026-10-24",
    dayCount: 1,
    departTime: "08:00",
    returnBy: "21:00",
    airport: false,
    roundTrip: true,
    driveToMin: 180,
    driveBackMin: 180,
    sunsetByDate: { "2026-10-24": 19 * 60 },
    trails: [{ id: "overlook", name: "Canyon Overlook", minutes: 120, miles: 1, fromEntranceMin: 10, fromPreviousMin: 10 }],
  });
  assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.days[0].items.some((item) => item.kind === "hike" && item.minutes === 120));
  const back = plan.days[0].items.find((item) => item.id === "drive-back");
  assert.equal(back.minutes, 180);
  assert.ok(formatClock(back.end).includes("p.m."));
});

test("a late airport arrival does not shorten the hike", () => {
  const plan = buildItinerary({
    startDate: "2026-10-24",
    dayCount: 2,
    departTime: "08:00",
    returnBy: "20:00",
    airport: true,
    landingTime: "16:30",
    bufferMin: 75,
    roundTrip: true,
    driveToMin: 60,
    driveBackMin: 60,
    sunsetByDate: { "2026-10-24": 18 * 60, "2026-10-25": 18 * 60 },
    trails: [{ id: "long", name: "Fairyland Loop", minutes: 300, miles: 8, fromEntranceMin: 20, fromPreviousMin: 20 }],
  });
  assert.ok(plan.conflicts.some((conflict) => conflict.code === "late-arrival"));
  assert.equal(plan.days[0].items.some((item) => item.kind === "hike"), false);
  const hike = plan.days[1].items.find((item) => item.kind === "hike");
  assert.equal(hike.minutes, 300);
  assert.ok(plan.conflicts.some((conflict) => conflict.code === "deferred"));
});

test("an overloaded day keeps every hour", () => {
  const trails = [1, 2, 3].map((n) => ({
    id: `h${n}`,
    name: `Trail ${n}`,
    minutes: 300,
    miles: 6,
    fromEntranceMin: 0,
    fromPreviousMin: 0,
    preferredDay: 0,
  }));
  const plan = buildItinerary({
    startDate: "2026-10-24",
    dayCount: 1,
    departTime: "07:00",
    returnBy: "21:00",
    airport: false,
    roundTrip: true,
    driveToMin: 0,
    driveBackMin: 0,
    sunsetByDate: {},
    trails,
  });
  const hiking = plan.days[0].items.filter((item) => item.kind === "hike");
  assert.equal(hiking.length, 3);
  assert.equal(hiking.reduce((sum, item) => sum + item.minutes, 0), 900);
  assert.ok(plan.conflicts.some((conflict) => conflict.code === "overloaded" || conflict.code === "overflow"));
});

test("a park without a road time adds no invented drive", () => {
  const plan = buildItinerary({
    startDate: "2026-10-24",
    dayCount: 1,
    departTime: "09:00",
    returnBy: "17:00",
    airport: false,
    roundTrip: true,
    driveToMin: null,
    driveBackMin: null,
    trails: [],
  });
  const drive = plan.days[0].items.find((item) => item.id === "drive-in");
  assert.equal(drive.minutes, 0);
  assert.equal(drive.kind, "missing");
  assert.ok(plan.conflicts.some((conflict) => conflict.code === "missing-drive"));
  assert.ok(plan.conflicts.some((conflict) => conflict.code === "missing-return"));
});

test("missing weather does not invent a rain item", () => {
  const items = recommendPacking({ days: [{ date: "2026-10-24", kind: "unavailable", high: null, precip: null }], trails: [] });
  assert.equal(items.some((item) => /waterproof/i.test(item.text)), false);
  assert.ok(items.some((item) => item.source === "missing"));
});

test("forecast rain produces a specific packing reason", () => {
  const items = recommendPacking({
    days: [{ date: "2026-10-24", kind: "forecast", high: 66, low: 45, precip: 0.1, wind: 8 }],
    trails: [{ id: "a", name: "Watchman", minutes: 120, miles: 3.3, elevation: 400, permit: false }],
  });
  const rain = items.find((item) => item.id === "rain");
  assert.equal(rain.group, "apparel");
  assert.equal(items.find((item) => item.id === "water").group, "consumable");
  assert.match(rain.reason, /forecast for 2026-10-24/);
  assert.match(rain.reason, /0\.1 in/);
});

test("a reservation flag becomes a permit packing item", () => {
  const items = recommendPacking({
    days: [],
    trails: [{ id: "angels", name: "Angels Landing", minutes: 180, permit: true }],
  });
  const permit = items.find((item) => item.id === "permit-angels");
  assert.equal(permit.group, "permit");
  assert.match(permit.text, /Angels Landing/);
});

test("model text cannot introduce a new number", () => {
  const packet = { miles: 47, gas: 8.4 };
  assert.equal(numbersAreGrounded("The drive is 47 miles and fuel is 8.40.", packet), true);
  assert.equal(numbersAreGrounded("Expect 12 trailheads.", packet), false);
});
