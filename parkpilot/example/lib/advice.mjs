export function recommendPacking({ days, trails }) {
  const items = [];
  const push = (item) => {
    if (!items.some((existing) => existing.id === item.id)) items.push(item);
  };
  push({
    id: "water",
    group: "consumable",
    text: "Water",
    reason: "Each planned hike needs drinking water. The amount is not calculated from the route.",
    source: "assumption",
  });
  const known = (days || []).filter((day) => day && day.kind !== "unavailable" && (day.high != null || day.precip != null));
  if (!known.length) {
    push({
      id: "unknown-weather",
      group: "apparel",
      text: "A layer you can add or remove",
      reason: "Weather for these dates is unavailable, so this list does not claim rain, wind, or a temperature.",
      source: "missing",
    });
  }
  for (const day of known) {
    const when = day.kind === "forecast" ? "the forecast" : "seasonal guidance";
    if (Number(day.precip) > 0.01) {
      push({
        id: "rain",
        group: "apparel",
        text: "Waterproof layer",
        reason: `Bring a waterproof layer because ${when} for ${day.date} includes ${day.precip} in of precipitation${day.kind === "seasonal" ? " in the years used for that average" : ""}.`,
        source: day.kind,
      });
    }
    if (day.low != null && day.low <= 40) {
      push({
      id: "warm",
      group: "apparel",
      text: "Warm layer",
        reason: `A warm layer is listed because ${when} puts the low on ${day.date} at ${day.low}°F.`,
        source: day.kind,
      });
    }
    if (day.high != null && day.high >= 80) {
      push({
      id: "sun",
      group: "apparel",
      text: "Sun protection",
        reason: `Sun protection is listed because ${when} puts the high on ${day.date} at ${day.high}°F.`,
        source: day.kind,
      });
    }
    if (day.wind != null && day.wind >= 25) {
      push({
      id: "wind",
      group: "apparel",
      text: "Wind layer",
        reason: `A wind layer is listed because ${when} puts the wind on ${day.date} at ${day.wind} mph.`,
        source: day.kind,
      });
    }
  }
  for (const trail of trails || []) {
    if (trail.permit) {
      push({
        id: `permit-${trail.id}`,
        group: "permit",
        text: `Permit confirmation for ${trail.name}`,
        reason: `NPS marks a reservation as required for ${trail.name}. Availability is not confirmed here.`,
        source: "nps",
      });
    }
    if (trail.elevation != null && trail.elevation >= 1500) {
      push({
      id: "elevation-water",
      group: "consumable",
      text: "Extra water for the climb",
        reason: `Extra water is listed because ${trail.name} publishes ${trail.elevation} feet of elevation gain.`,
        source: "trail",
      });
      break;
    }
  }
  const long = (trails || []).find((trail) => trail.minutes >= 240);
  if (long) {
    push({
    id: "long-hike",
    group: "consumable",
    text: "More food, and a light if you may finish late",
      reason: `${long.name} uses ${Math.round((long.minutes / 60) * 10) / 10} hours at the top of its published range. The light is a buffer for a long effort, not a measured sunset on the trail.`,
      source: "assumption",
    });
  }
  return items;
}

export function tripNotes({ conflicts = [], accessNote, weatherState, trailState }) {
  const notes = [];
  if (accessNote) notes.push({ id: "access", text: accessNote });
  if (weatherState === "unavailable") notes.push({ id: "weather", text: "Weather did not load. Packing and daylight limits are not using a forecast or a seasonal normal." });
  if (trailState === "empty") notes.push({ id: "trails-empty", text: "NPS returned no hiking activities for this park. That is an empty activity list, not proof the park has no trails." });
  if (trailState === "unavailable") notes.push({ id: "trails-down", text: "Trail records did not load. Recommendations are paused rather than filled with sample hikes." });
  for (const conflict of conflicts) notes.push({ id: conflict.code + (conflict.trailId || ""), text: `${conflict.message} ${conflict.suggestion}` });
  return notes;
}
