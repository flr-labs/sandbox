import test from "node:test";
import assert from "node:assert/strict";
import { acceptSuggestion, fallbackDays } from "./itinerary.mjs";

const trails = [
  { id: "easy-1", level: "easy" },
  { id: "hard-1", level: "strenuous" },
  { id: "mod-1", level: "moderate" },
];

test("fallback prefers the requested level and does not repeat a hike", () => {
  const days = fallbackDays(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"], trails, "moderate");
  assert.deepEqual(days.map((day) => day.trailIds[0] || ""), ["mod-1", "easy-1", "hard-1", ""]);
  assert.equal(days[2].date, "2026-11-01");
});

test("a model plan is kept only when every day and hike was supplied", () => {
  const dates = ["2026-12-30", "2026-12-31"];
  const accepted = acceptSuggestion({
    days: [
      { date: "2026-12-30", trailIds: ["mod-1"], note: "Moderate matches the preference." },
      { date: "2026-12-31", trailIds: ["invented", "easy-1"], note: "Second day." },
    ],
  }, dates, trails);
  assert.deepEqual(accepted.map((day) => day.trailIds), [["mod-1"], ["easy-1"]]);
  assert.equal(acceptSuggestion({ days: [{ date: "2026-12-30", trailIds: ["mod-1"] }] }, dates, trails), null);
});
