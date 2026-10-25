import assert from "node:assert/strict";
import test from "node:test";
import { parkMatches, recommendedHikes, schedulableLevels } from "./choices.mjs";

const zion = { name: "Zion National Park", states: "UT", activities: ["Hiking", "Camping"] };

test("a park matches every selected choice", () => {
  const choices = { query: "zion", stateFilter: "UT", activityFilter: ["Hiking", "Camping"], difficulty: "easy" };
  assert.equal(parkMatches(zion, choices, ["easy", "moderate"]), true);
  assert.equal(parkMatches(zion, choices, ["moderate"]), false);
  assert.equal(parkMatches(zion, { ...choices, stateFilter: "NV" }, ["easy"]), false);
  assert.equal(parkMatches(zion, { ...choices, activityFilter: ["Hiking", "Fishing"] }, ["easy"]), false);
  assert.equal(parkMatches(zion, { query: "utah" }, ["easy"]), false);
  assert.equal(parkMatches(zion, { query: "ut" }, ["easy"]), false);
});

test("an unknown hike level does not hide a park", () => {
  assert.equal(parkMatches(zion, { difficulty: "strenuous" }, undefined), true);
  assert.equal(parkMatches(zion, { difficulty: "strenuous" }, null), true);
  assert.equal(parkMatches(zion, { difficulty: "strenuous" }, []), false);
});

test("hiking preference matches any checked level", () => {
  assert.equal(parkMatches(zion, { difficulty: ["easy", "strenuous"] }, ["moderate", "strenuous"]), true);
  assert.equal(parkMatches(zion, { difficulty: ["easy"] }, ["moderate"]), false);
  assert.equal(parkMatches(zion, { difficulty: [] }, ["moderate"]), true);
  const trails = [
    { id: "a", schedulable: true, level: "easy" },
    { id: "b", schedulable: true, level: "strenuous" },
    { id: "c", schedulable: false, level: "easy" },
  ];
  assert.deepEqual(recommendedHikes(trails, ["easy", "strenuous"]).map((trail) => trail.id), ["a", "b"]);
});

test("a listed hike stays recommended when its duration or level is missing", () => {
  const trails = [
    { id: "named", hikeNamed: true, schedulable: false, level: "unknown" },
    { id: "easy", hikeNamed: true, schedulable: false, level: "easy" },
    { id: "hard", hikeNamed: true, schedulable: true, level: "strenuous" },
    { id: "mixed", hikeNamed: true, schedulable: false, level: "mixed" },
    { id: "bundle", hikeNamed: true, collection: true, level: "easy" },
  ];
  assert.deepEqual(recommendedHikes(trails, []).map((trail) => trail.id), ["easy", "hard", "named"]);
  assert.deepEqual(recommendedHikes(trails, ["easy"]).map((trail) => trail.id), ["easy", "named"]);
});

test("recommendations are the schedulable hikes at the selected level", () => {
  const trails = [
    { id: "a", schedulable: true, level: "easy" },
    { id: "b", schedulable: true, level: "strenuous" },
    { id: "c", schedulable: false, level: "easy" },
  ];
  assert.deepEqual(recommendedHikes(trails, "easy").map((trail) => trail.id), ["a"]);
  assert.deepEqual(recommendedHikes(trails, "all").map((trail) => trail.id), ["a", "b"]);
  assert.deepEqual(schedulableLevels(trails), ["easy", "strenuous"]);
});
