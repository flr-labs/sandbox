export function stripHtml(html = "") {
  return String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function hoursFromDuration(duration = "") {
  const text = String(duration).toLowerCase();
  const range = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(hour|minute)/);
  if (range) return range[3].startsWith("minute") ? Number(range[2]) / 60 : Number(range[2]);
  const one = text.match(/(\d+(?:\.\d+)?)\s*(hour|minute)/);
  if (!one) return null;
  return one[2].startsWith("minute") ? Number(one[1]) / 60 : Number(one[1]);
}

export function trailMiles(text) {
  const labeled = text.match(/Distance:\s*([0-9]+(?:\.[0-9]+)?)\s*miles?/i);
  if (labeled) return Number(labeled[1]);
  const matches = [...text.matchAll(/\b([0-9]+(?:\.[0-9]+)?)\s*miles?\b/gi)];
  for (const match of matches) {
    const before = text.slice(Math.max(0, match.index - 16), match.index);
    const after = text.slice(match.index, match.index + match[0].length + 10);
    if (/mile\s+[0-9]/i.test(before)) continue;
    if (/miles?\s+away/i.test(after)) continue;
    return Number(match[1]);
  }
  return null;
}

export function elevationGain(text) {
  const labeled = text.match(/Elevation (?:Gain|Change):\s*([0-9][0-9,]*)\s*feet/i);
  if (labeled) return Number(labeled[1].replace(/,/g, ""));
  const loose = text.match(/([0-9][0-9,]*)\s*feet of elevation/i);
  return loose ? Number(loose[1].replace(/,/g, "")) : null;
}

export function routeType(text) {
  if (/point-to-point|point to point/i.test(text)) return "point-to-point";
  if (/out-and-back|out and back/i.test(text)) return "out-and-back";
  if (/\bloop\b/i.test(text)) return "loop";
  return null;
}

export function difficultyOf(text, miles) {
  const explicit = text.match(/Difficulty:\s*(Easy|Moderate|Strenuous)/i);
  if (explicit) {
    const level = explicit[1].toLowerCase();
    return { level, estimated: false, why: `NPS labels the difficulty ${level}.` };
  }
  const cleaned = text
    .replace(/moderate drop-?offs/gi, "")
    .replace(/difficult to/gi, "")
    .replace(/makes it difficult/gi, "");
  const levels = [];
  if (/least difficult|relatively easy|\beasy\b/i.test(cleaned)) levels.push("easy");
  if (/moderately|\bmoderate\b/i.test(cleaned)) levels.push("moderate");
  if (/\bstrenuous\b/i.test(cleaned)) levels.push("strenuous");
  const unique = [...new Set(levels)];
  if (unique.length > 1) return { level: "mixed", estimated: false, why: "The page states more than one difficulty for this listing." };
  if (unique.length === 1) return { level: unique[0], estimated: false, why: `The description calls this ${unique[0]}.` };
  if (miles == null) return { level: "unknown", estimated: false, why: "No difficulty word or trail distance was stated." };
  if (miles < 2) return { level: "easy", estimated: true, why: `${miles} miles, and the page states no difficulty. This level is a distance estimate.` };
  if (miles < 5) return { level: "moderate", estimated: true, why: `${miles} miles, and the page states no difficulty. This level is a distance estimate.` };
  return { level: "strenuous", estimated: true, why: `${miles} miles, and the page states no difficulty. This level is a distance estimate.` };
}

export function isCollection(title = "") {
  return /hike an |hike a |easy or moderate|strenuous trail$|trails to|several trails|variety of hikes|full moon/i.test(title);
}

export function seasonalNotes(text) {
  const notes = [];
  if (/closed in winter|winter closure|not (?:plowed|maintained) in winter/i.test(text)) notes.push("The description mentions a winter closure or unmaintained winter conditions.");
  if (/flash flood/i.test(text)) notes.push("The description mentions flash floods.");
  if (/seasonal/i.test(text)) notes.push("The description mentions seasonal limits.");
  if (/permit/i.test(text)) notes.push("The description mentions a permit.");
  return notes;
}

export function parseActivity(activity) {
  const text = stripHtml(
    [activity.title, activity.shortDescription, activity.duration, activity.durationDescription, activity.longDescription, activity.activityDescription]
      .filter(Boolean)
      .join(" "),
  );
  const miles = trailMiles(text);
  const level = difficultyOf(text, miles);
  const names = (activity.activities || []).map((item) => item.name || "");
  const hikeNamed = names.some((name) => /hiking/i.test(name)) || /\btrail\b|\bhike\b/i.test(activity.title || "");
  const duration = activity.duration || activity.durationDescription || "";
  const hours = hoursFromDuration(duration);
  const collection = isCollection(activity.title || "");
  const image = (activity.images || [])[0] || {};
  const schedulable = hikeNamed && !collection && ["easy", "moderate", "strenuous"].includes(level.level) && hours != null;
  return {
    id: String(activity.id),
    name: activity.title || "Untitled activity",
    url: activity.url || "",
    hikeNamed,
    collection,
    duration: duration || "",
    hours,
    minutes: hours == null ? null : Math.round(hours * 60),
    miles,
    elevation: elevationGain(text),
    routeType: routeType(text),
    level: level.level,
    levelEstimated: level.estimated,
    why: collection ? "This listing covers more than one trail, so it is not scheduled as a single hike." : level.why,
    permit: String(activity.isReservationRequired) === "true",
    seasonNotes: seasonalNotes(text),
    lat: activity.latitude === "" || activity.latitude == null ? null : Number(activity.latitude),
    lon: activity.longitude === "" || activity.longitude == null ? null : Number(activity.longitude),
    image: image.url || "",
    imageCredit: image.credit || "",
    imageAlt: image.altText || activity.title || "",
    schedulable,
    blurb: stripHtml(activity.shortDescription || "").slice(0, 280),
  };
}
