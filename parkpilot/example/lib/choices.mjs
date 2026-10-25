export function schedulableLevels(trails = []) {
  return [...new Set(trails.filter((trail) => trail.schedulable).map((trail) => trail.level))].sort();
}

export function selectedLevels(difficulty) {
  if (difficulty == null || difficulty === "" || difficulty === "all") return [];
  const list = Array.isArray(difficulty) ? difficulty : [difficulty];
  return list.filter((level) => level && level !== "all");
}

export function parkMatches(park, choices = {}, levels) {
  const query = String(choices.query || "").trim().toLowerCase();
  if (query && !String(park.name || "").toLowerCase().includes(query)) return false;
  const states = String(park.states || "").split(",").map((code) => code.trim()).filter(Boolean);
  if (choices.stateFilter && !states.includes(choices.stateFilter)) return false;
  const activities = choices.activityFilter || [];
  if (activities.length && !activities.every((name) => (park.activities || []).includes(name))) return false;
  const wanted = selectedLevels(choices.difficulty);
  if (wanted.length) {
    if (!Array.isArray(levels)) return true;
    return wanted.some((level) => levels.includes(level));
  }
  return true;
}

function listedHike(trail) {
  if (!trail || trail.collection || trail.hikeNamed === false) return false;
  if (trail.hikeNamed === true) return true;
  return Boolean(trail.schedulable);
}

function levelFits(trail, wanted) {
  if (!wanted.length) return trail.level !== "mixed";
  if (!trail.level || trail.level === "unknown") return true;
  return wanted.includes(trail.level);
}

export function recommendedHikes(trails = [], difficulty = "all") {
  const wanted = selectedLevels(difficulty);
  return trails
    .filter((trail) => listedHike(trail) && levelFits(trail, wanted))
    .sort((a, b) => fitRank(a, wanted) - fitRank(b, wanted));
}

function fitRank(trail, wanted) {
  if (!wanted.length) return trail.level === "unknown" ? 1 : 0;
  return wanted.includes(trail.level) ? 0 : 1;
}
