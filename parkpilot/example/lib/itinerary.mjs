export function fallbackDays(dates, trails, difficulty = "all") {
  const ranked = [...trails].sort((a, b) => rank(a, difficulty) - rank(b, difficulty));
  const used = new Set();
  return dates.map((date) => {
    const trail = ranked.find((item) => !used.has(item.id));
    if (trail) used.add(trail.id);
    return { date, trailIds: trail ? [trail.id] : [], note: "" };
  });
}

function rank(trail, difficulty) {
  const wanted = Array.isArray(difficulty)
    ? difficulty.filter((level) => level && level !== "all")
    : !difficulty || difficulty === "all" ? [] : [difficulty];
  if (!wanted.length) return trail.level === "unknown" || trail.level === "mixed" ? 1 : 0;
  if (wanted.includes(trail.level)) return 0;
  if (!trail.level || trail.level === "unknown") return 1;
  return 2;
}

export function acceptSuggestion(raw, dates, trails) {
  const allowed = new Set(trails.map((trail) => trail.id));
  const days = raw?.days;
  if (!Array.isArray(days) || days.length !== dates.length) return null;
  const seen = new Set();
  const clean = [];
  for (let index = 0; index < dates.length; index += 1) {
    const day = days[index];
    if (!day || day.date !== dates[index]) return null;
    const ids = [];
    for (const id of Array.isArray(day.trailIds) ? day.trailIds : []) {
      if (!allowed.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length === 2) break;
    }
    const note = typeof day.note === "string" ? day.note.trim().slice(0, 240) : "";
    clean.push({ date: dates[index], trailIds: ids, note });
  }
  return clean;
}
