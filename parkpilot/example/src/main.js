import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { recommendPacking } from "../lib/advice.mjs";
import { parkMatches, recommendedHikes, schedulableLevels, selectedLevels } from "../lib/choices.mjs";
import { fuelCost } from "../lib/fuel.mjs";
import { buildItineraryPdf } from "../lib/itinerary-pdf.mjs";
import { legKey, lodgingPairs, resolveLeg, stayNights } from "../lib/legs.mjs";
import { LODGING_DEFAULTS } from "../lib/lodging-defaults.mjs";
import {
  STATUS_LABEL,
  applyProposal,
  assignArea,
  assignProperty,
  confirmBooking,
  nightStatus,
  proposalFrom,
  recommendStays,
  routingPlace,
} from "../lib/lodging.mjs";
import { addDays, buildItinerary, formatClock } from "../lib/schedule.mjs";
import { lodgingHtml, measure } from "./lodging-view.js";

const KEY = "parkpilot-plan-v1";
const SAVED_KEY = "parkpilot-saved-trips";

const state = {
  parks: [],
  parksStatus: "loading",
  parksMeta: null,
  query: "",
  stateFilter: "",
  activityFilter: [],
  activityQuery: "",
  locationQuery: "",
  hikeLevels: {},
  hikeIndexStatus: "idle",
  showAllParks: false,
  catalogOpen: true,
  parkCode: "",
  detail: null,
  detailStatus: "idle",
  originQuery: "",
  geocodeStatus: "idle",
  candidates: [],
  origin: null,
  airport: false,
  landingTime: "16:30",
  bufferMin: 75,
  startDate: todayET(1),
  dayCount: 3,
  departTime: "08:00",
  returnBy: "19:00",
  groupSize: 2,
  difficulty: [],
  showOthers: false,
  mpg: 25,
  price: "",
  priceTouched: false,
  fuelMeta: null,
  fuelStatus: "loading",
  roundTrip: true,
  selected: [],
  route: null,
  routeStatus: "idle",
  weather: null,
  weatherStatus: "idle",
  packing: [],
  packComposer: false,
  packDraft: "",
  packDraftGroup: "permit",
  packNotice: "",
  savedId: "",
  copyNotice: "",
  emailDraft: "",
  focusId: "",
  previewId: "",
  mobile: "list",
  explain: null,
  explainStatus: "idle",
  scrollToItem: false,
  lodgingMode: "help",
  maxDailyDriveMin: LODGING_DEFAULTS.defaultMaxDailyDriveMinutes,
  maxStayMiles: 60,
  lodgingQuery: "",
  lodgingLookup: "idle",
  lodgingHits: [],
  lodgingChoice: null,
  lodgingSource: "",
  lodgingRetrieved: "",
  lodgingNights: {},
  nightPick: {},
  areaCatalog: null,
  areaStatus: "idle",
  legBook: {},
  legStatus: "idle",
  proposal: null,
  proposalDismissedFor: "",
  openDetails: {},
  stage: "park",
  parkOpen: false,
  itineraryOpen: false,
  tripAirports: [],
  suggestion: null,
  suggestionStatus: "idle",
  parkMap: false,
  trailMapId: "",
  airports: null,
  airportStatus: "idle",
  townProfiles: {},
  scrollToStay: false,
};

let map;
let mapLayer;
let fitted = "";
let lastFocus = "";
let routeToken = 0;
let weatherToken = 0;
let legToken = 0;
let proximityToken = 0;
let proximityBusy = false;
let suggestToken = 0;
let detailRetryTimer = 0;
let routeTimer;
let weatherTimer;
let legTimer;

function todayET(offset = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return addDays(parts, offset);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function money(value) {
  if (value == null || Number.isNaN(Number(value))) return "Not calculated";
  return Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function hoursLabel(mins) {
  if (mins == null) return "Not calculated";
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  if (!hour) return `${minute} min`;
  if (!minute) return `${hour} hr`;
  return `${hour} hr ${minute} min`;
}

function fresh(iso) {
  if (!iso) return "";
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))} ET`;
}

function tripDates() {
  const count = Math.min(10, Math.max(1, Number(state.dayCount) || 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.startDate)) return [];
  return Array.from({ length: count }, (_, index) => addDays(state.startDate, index));
}

function selectedTrails() {
  const trails = state.detail?.trails || [];
  return state.selected.map((item) => {
    const trail = trails.find((entry) => entry.id === item.id);
    return trail ? { ...trail, preferredDay: item.preferredDay } : null;
  }).filter(Boolean);
}

function sunsetMap() {
  const sunsetByDate = {};
  for (const day of state.weather?.days || []) {
    if (day.kind !== "unavailable" && day.sunset != null) sunsetByDate[day.date] = day.sunset;
  }
  return sunsetByDate;
}

function activeNightPlaces() {
  const places = {};
  for (const date of stayNights(tripDates())) {
    const place = routingPlace(state.lodgingNights[date]);
    if (place) places[date] = place;
  }
  return places;
}

function lodgingActive() {
  return Object.keys(activeNightPlaces()).length > 0;
}

function entrancePoint() {
  const point = state.detail?.point;
  if (!point) return null;
  return {
    id: "entrance",
    name: point.name,
    lat: point.lat,
    lon: point.lon,
    unroutable: Boolean(point.fallback),
  };
}

function originPoint() {
  if (!state.origin) return null;
  return { id: "origin", name: state.origin.label, lat: state.origin.lat, lon: state.origin.lon };
}

function stayConfig(nightByDate = activeNightPlaces()) {
  const dates = Object.keys(nightByDate).sort();
  const changes = dates.some((date, index) => index > 0 && nightByDate[date]?.id !== nightByDate[dates[index - 1]]?.id);
  return {
    nightByDate,
    legBook: state.legBook,
    checkInMin: LODGING_DEFAULTS.splitStay.checkInMinutes,
    checkOutMin: LODGING_DEFAULTS.splitStay.checkOutMinutes,
    relocationMin: changes ? LODGING_DEFAULTS.splitStay.relocationAllowanceMinutes : 0,
    maxDailyDriveMin: Number(state.maxDailyDriveMin) || LODGING_DEFAULTS.defaultMaxDailyDriveMinutes,
  };
}

function planInput(nightByDate) {
  const timed = selectedTrails().filter((trail) => trail.minutes != null);
  return {
    startDate: state.startDate,
    dayCount: Number(state.dayCount) || 1,
    departTime: state.departTime,
    returnBy: state.returnBy,
    airport: state.airport,
    landingTime: state.landingTime,
    bufferMin: Number(state.bufferMin) || 0,
    roundTrip: state.roundTrip,
    sunsetByDate: sunsetMap(),
    originPoint: originPoint(),
    entrancePoint: entrancePoint(),
    trails: timed.map((trail) => ({
      id: trail.id,
      name: trail.name,
      minutes: trail.minutes,
      miles: trail.miles,
      lat: trail.lat,
      lon: trail.lon,
      preferredDay: Number.isInteger(trail.preferredDay) ? trail.preferredDay : null,
    })),
    stay: stayConfig(nightByDate),
  };
}

function currentPlan() {
  if (lodgingActive() && state.origin && state.detail?.point) return buildItinerary(planInput());
  const ordered = selectedTrails();
  const timed = ordered.filter((trail) => trail.minutes != null);
  const driveKnown = state.route?.ok;
  return buildItinerary({
    startDate: state.startDate,
    dayCount: Number(state.dayCount) || 1,
    departTime: state.departTime,
    returnBy: state.returnBy,
    airport: state.airport,
    landingTime: state.landingTime,
    bufferMin: Number(state.bufferMin) || 0,
    roundTrip: state.roundTrip,
    driveToMin: driveKnown ? state.route.toPark?.minutes ?? null : null,
    driveBackMin: state.roundTrip ? (driveKnown ? state.route.returnLeg?.minutes ?? null : null) : null,
    sunsetByDate: sunsetMap(),
    trails: timed.map((trail, index) => ({
      id: trail.id,
      name: trail.name,
      minutes: trail.minutes,
      miles: trail.miles,
      preferredDay: Number.isInteger(trail.preferredDay) ? trail.preferredDay : null,
      fromEntranceMin: driveKnown ? state.route.spurs?.[trail.id]?.minutes ?? null : null,
      fromPreviousMin: driveKnown ? (index === 0 ? state.route.spurs?.[trail.id]?.minutes ?? null : state.route.viaLegs?.[trail.id]?.minutes ?? null) : null,
    })),
  });
}

function drivingNow() {
  if (lodgingActive() && state.origin) {
    const travel = currentPlan().travel;
    return {
      complete: Boolean(travel?.complete),
      miles: travel?.complete ? travel.miles : null,
      minutes: travel?.complete ? travel.minutes : null,
      knownMiles: travel?.knownMiles ?? null,
      knownMinutes: travel?.knownMinutes ?? null,
    };
  }
  return {
    complete: Boolean(state.route?.ok),
    miles: state.route?.ok ? state.route.miles : null,
    minutes: state.route?.ok ? state.route.minutes : null,
    knownMiles: null,
    knownMinutes: null,
  };
}

function fuelNow() {
  return fuelCost(drivingNow().miles, Number(state.mpg), Number(state.price));
}

function hikingMiles(trails) {
  const known = trails.filter((trail) => trail.miles != null);
  const miles = Math.round(known.reduce((sum, trail) => sum + trail.miles, 0) * 10) / 10;
  return { miles, known: known.length, missing: trails.length - known.length };
}

function save() {
  const snapshot = {
    query: state.query,
    stateFilter: state.stateFilter,
    activityFilter: state.activityFilter,
    parkCode: state.parkCode,
    originQuery: state.originQuery,
    origin: state.origin,
    airport: state.airport,
    landingTime: state.landingTime,
    bufferMin: state.bufferMin,
    startDate: state.startDate,
    dayCount: state.dayCount,
    departTime: state.departTime,
    returnBy: state.returnBy,
    groupSize: state.groupSize,
    difficulty: state.difficulty,
    mpg: state.mpg,
    price: state.price,
    priceTouched: state.priceTouched,
    roundTrip: state.roundTrip,
    selected: state.selected,
    packing: state.packing,
    lodgingMode: state.lodgingMode,
    maxDailyDriveMin: state.maxDailyDriveMin,
    maxStayMiles: state.maxStayMiles,
    lodgingQuery: state.lodgingQuery,
    lodgingChoice: state.lodgingChoice,
    lodgingNights: state.lodgingNights,
    nightPick: state.nightPick,
    proposalDismissedFor: state.proposalDismissedFor,
    stage: state.stage,
    parkOpen: state.parkOpen,
    itineraryOpen: state.itineraryOpen,
    tripAirports: state.tripAirports,
  };
  sessionStorage.setItem(KEY, JSON.stringify(snapshot));
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (!saved) return;
    Object.assign(state, saved);
    if (typeof state.activityFilter === "string") state.activityFilter = state.activityFilter ? [state.activityFilter] : [];
    if (!Array.isArray(state.activityFilter)) state.activityFilter = [];
    if (!Array.isArray(state.tripAirports)) state.tripAirports = [];
    state.difficulty = selectedLevels(state.difficulty);
    if (state.stage === "budget" || state.stage === "stay" || state.stage === "trip") state.stage = "plan";
    if (state.stage === "record") {
      state.stage = "park";
      state.parkOpen = true;
    }
    if (state.stage === "weather" || state.stage === "packing") state.stage = "plan";
    if (!state.lodgingMode) state.lodgingMode = "help";
    if (!["park", "trails", "plan", "saved"].includes(state.stage)) state.stage = "park";
    if (state.stage !== "park" && state.stage !== "saved" && !state.parkCode) state.stage = "park";
    state.parkOpen = Boolean(state.parkOpen && state.parkCode);
  } catch {
    sessionStorage.removeItem(KEY);
  }
}

function clipSentence(text, limit) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  const slice = value.slice(0, limit);
  const end = slice.lastIndexOf(". ");
  return end > 80 ? slice.slice(0, end + 1) : `${slice.trim()}…`;
}

function photo(url, alt) {
  if (!url) return `<div class="photo-miss">No NPS photo on this record</div>`;
  return `<img src="${esc(url)}" alt="${esc(alt || "National park photograph")}" />`;
}

function badge(trail) {
  const level = ["easy", "moderate", "strenuous", "mixed"].includes(trail.level) ? trail.level : "unknown";
  const label = { easy: "Easy", moderate: "Moderate", strenuous: "Strenuous", mixed: "Mixed", unknown: "Not available" }[level];
  const estimated = trail.levelEstimated ? `<span class="badge est">Distance estimate</span>` : "";
  return `<span class="badge ${level}">${esc(label)}</span>${estimated}`;
}

function blank(value, unit, missing) {
  if (value == null || value === "") return missing;
  return `${value}${unit || ""}`;
}

function fitText(trail) {
  const parts = [trail.why];
  const levels = selectedLevels(state.difficulty);
  if (levels.length) {
    parts.push(levels.includes(trail.level)
      ? `It matches your ${trail.level} preference.`
      : `Your preference is ${levels.join(" and ")}; this listing is ${trail.level}.`);
  }
  const sunsets = (state.weather?.days || []).filter((day) => day.sunset != null && day.sunrise != null);
  if (trail.hours && sunsets.length) {
    const daylight = Math.max(...sunsets.map((day) => (day.sunset - day.sunrise) / 60));
    if (trail.hours > daylight) parts.push(`The published duration is longer than the daylight at the weather point on these dates.`);
  } else if (trail.hours && state.weatherStatus === "error") {
    parts.push("Daylight was not checked because weather did not load.");
  }
  if (!trail.schedulable) parts.push("It stays off the automatic clock until it has one difficulty and a duration.");
  return parts.join(" ");
}

function matchingAlerts(trail) {
  const alerts = state.detail?.alerts?.items || [];
  const name = trail.name.toLowerCase();
  return alerts.filter((alert) => `${alert.title} ${alert.description}`.toLowerCase().includes(name));
}

function difficultyLabel(value = state.difficulty) {
  const names = { easy: "Easy", moderate: "Moderate", strenuous: "Strenuous" };
  const levels = selectedLevels(value);
  if (!levels.length) return "Any level";
  return levels.map((level) => names[level] || level).join(" and ");
}

function choiceSummary() {
  const search = state.query.trim();
  const location = state.stateFilter || "All states";
  const activity = state.activityFilter.length ? state.activityFilter.join(", ") : "Any activity";
  const hikes = selectedLevels(state.difficulty).length ? `${difficultyLabel()} hikes` : "Any hike level";
  return [search ? `Search "${search}"` : "", location, activity, hikes].filter(Boolean).join(" · ");
}

function choiceRecallHtml() {
  return `<p class="choice-recall"><span>Your choices</span> ${esc(choiceSummary())} <button class="btn quiet" type="button" data-action="stage" data-stage="park">Edit choices</button></p>`;
}

function levelNote() {
  if (!selectedLevels(state.difficulty).length || state.parksStatus !== "ok") return "";
  const pending = state.parks.filter((park) => state.hikeLevels[park.code] === undefined).length;
  const failed = state.parks.filter((park) => state.hikeLevels[park.code] === null).length;
  if (pending) return ` Checking hike levels for ${state.parks.length - pending} of ${state.parks.length} parks. A park stays listed until its level is known.`;
  if (failed) return ` ${failed} ${failed === 1 ? "park could" : "parks could"} not be checked, so ${failed === 1 ? "it stays" : "they stay"} listed.`;
  return "";
}

function visibleParks() {
  const choices = {
    query: state.query,
    stateFilter: state.stateFilter,
    activityFilter: state.activityFilter,
    difficulty: state.difficulty,
  };
  return state.parks.filter((park) => parkMatches(park, choices, state.hikeLevels[park.code]));
}

function catalogHtml() {
  if (state.parksStatus === "loading") return `<section class="card park-card-sheet" id="stage-park"><h2>Discovery</h2><p class="lede">Loading the National Park Service catalog.</p></section>`;
  if (state.parksStatus === "error") return `<section class="card park-card-sheet" id="stage-park"><h2>Discovery</h2><p class="lede">The park list did not load. This is not an empty catalog.</p></section>`;
  const matches = visibleParks();
  const shown = state.query || state.showAllParks ? matches : matches.slice(0, 12);
  return `<section class="card park-card-sheet" id="stage-park">
    <h2>Discovery</h2>
    <p class="lede">${matches.length} of ${state.parks.length} national parks match these choices.${esc(levelNote())}</p>
    ${matches.length ? `<div class="park-grid">${shown.map((park) => `<button class="park-card" type="button" data-park="${esc(park.code)}" aria-pressed="${park.code === state.parkCode}">
      ${photo(park.image, park.imageAlt)}
      <span><strong>${esc(park.name)}</strong><small>${esc(park.states.split(",").join(", "))}${park.fee == null ? "" : ` · vehicle ${money(park.fee)}`}</small></span>
    </button>`).join("")}</div>` : `<p class="lede">No park matches these choices. The catalog itself loaded.</p>`}
    ${shown.length < matches.length ? `<button class="btn" type="button" data-action="all-parks" style="margin-top:12px">Show all ${matches.length}</button>` : ""}
    <p class="source">${esc(state.parksMeta?.source || "NPS")} · ${esc(fresh(state.parksMeta?.retrievedAt))}</p>
  </section>`;
}

function suggestDay() {
  const dates = tripDates();
  if (!dates.length) return null;
  const loads = dates.map(() => 0);
  for (const item of state.selected) {
    const minutes = (state.detail?.trails || []).find((entry) => entry.id === item.id)?.minutes || 0;
    const day = Number.isInteger(item.preferredDay) && item.preferredDay < dates.length ? item.preferredDay : 0;
    loads[day] += minutes;
  }
  let best = 0;
  loads.forEach((minutes, index) => {
    if (minutes < loads[best]) best = index;
  });
  return best;
}

function dayWeather(date) {
  return (state.weather?.days || []).find((day) => day.date === date) || null;
}

function dayWeatherText(date) {
  if (state.weatherStatus === "loading" || state.weatherStatus === "idle") return "Weather is loading";
  const day = dayWeather(date);
  if (state.weatherStatus === "error" || !day || day.kind === "unavailable") return "Weather not available";
  const high = day.high == null ? null : `${day.high}°`;
  const low = day.low == null ? null : `${day.low}°`;
  const temp = high && low ? `${high} / ${low}` : high || low || "Temperature not available";
  return [temp, day.sky || "Sky not labeled"].join(" · ");
}

function weatherCardsHtml(dates, { hikeLabel, markIndex, markNote, omitNote } = {}) {
  const place = state.detail?.point?.name || "the park point";
  if (!dates.length) return "";
  if (state.weatherStatus === "loading" || state.weatherStatus === "idle") {
    return `<p class="meta">Weather for these dates is still loading.</p>`;
  }
  if (state.weatherStatus === "error" || !state.weather?.days?.length) {
    return `<p class="meta">Weather is not available for these dates.</p>`;
  }
  const cards = dates.map((date, index) => {
    const day = dayWeather(date);
    const missing = !day || day.kind === "unavailable";
    const kind = !day ? "" : day.kind === "forecast" ? "Forecast" : day.kind === "seasonal" ? "Seasonal" : "Unavailable";
    const hike = hikeLabel ? hikeLabel(date, index) : "";
    const marked = markIndex === index;
    return `<article class="${marked ? "is-on" : ""}">
      <span class="cast-date">${esc(readableDate(date))}${marked && markNote ? ` · ${esc(markNote)}` : ""}</span>
      ${hike ? `<span class="cast-hike">${esc(hike)}</span>` : ""}
      ${missing ? `<strong>Not available</strong>` : `${skyMark(skyKind(day.sky))}<strong>${day.high == null ? "—" : `${esc(day.high)}°`}</strong><span>${day.low == null ? "Low unavailable" : `Low ${esc(day.low)}°`}</span><span>${esc(day.sky || "Sky not labeled")}</span><span>${day.precip == null ? "Precip unavailable" : `${esc(day.precip)} in`}</span><span>${day.wind == null ? "Wind unavailable" : `${esc(day.wind)} mph`}</span><span>${esc(kind)}</span>`}
    </article>`;
  }).join("");
  return `<div class="trail-weather">${cards}</div>${omitNote ? "" : `<p class="meta">Weather is for ${esc(place)} on these trip dates. It is not a separate forecast at the trailhead.</p>`}`;
}

function weatherCardHtml() {
  const place = state.detail?.point?.name || "the park point";
  return `<section class="card weather-card" id="trip-weather">
    <h2>Weather</h2>
    <p class="lede">These dates at ${esc(place)}. This is the park forecast, not a separate reading at a trailhead.</p>
    ${weatherCardsHtml(tripDates(), { omitNote: true })}
  </section>`;
}

function recommendationHtml(park) {
  const matches = recommendedHikes(park.trails || [], state.difficulty);
  const rest = (park.trails || []).filter((trail) => !matches.includes(trail));
  const pending = matches.filter((trail) => !state.selected.some((item) => item.id === trail.id));
  const shown = state.showOthers ? [...matches, ...rest] : matches;
  return `<section class="card" id="recommended-hikes">
    <h2>Trails</h2>
    ${suggestionHtml()}
    ${rest.length ? `<button class="chip" type="button" data-action="others" aria-pressed="${state.showOthers}">${state.showOthers ? "Showing every hiking listing" : `Show ${rest.length} other listings`}</button>` : ""}
    ${shown.length ? shown.map((trail) => trailCard(trail)).join("") : `<p class="lede">No listed hike matches ${esc(difficultyLabel())}. Nothing was added to Trails.</p>`}
    <div class="trail-actions">
      ${pending.length ? `<button class="btn primary" type="button" data-action="approve-matching">Approve these ${pending.length} ${pending.length === 1 ? "hike" : "hikes"}</button>` : ""}
    </div>
  </section>`;
}

function parkRecordBar() {
  return `<div class="park-overlay-bar"><p class="eyebrow" id="park-overlay-title">The park</p><button id="close-park" class="btn" type="button" data-action="close-park">Back to parks</button></div>`;
}

function parkRecordMove() {
  const ready = state.detailStatus === "ok" && state.detail;
  const blocked = state.detailStatus === "loading" ? "Waiting for the park record" : "Choose a park to continue";
  return `<div class="stage-move">
    <button class="btn" type="button" data-action="close-park">Back</button>
    <button class="btn primary" type="button" data-action="stage" data-stage="trails" ${ready ? "" : "disabled"}>${ready ? "Continue to Select Trails" : blocked}</button>
  </div>`;
}

function detailUnavailable(message) {
  const known = state.parks.find((park) => park.code === state.parkCode);
  return `<section class="card">
    ${parkRecordBar()}
    ${known?.image ? `<figure class="hero-photo">${photo(known.image, known.imageAlt)}<figcaption>${esc(known.name)}</figcaption></figure>` : ""}
    <h2>${esc(known?.name || "The park")}</h2>
    <p class="lede">${esc(message)}</p>
    <button class="btn" type="button" data-action="reload-park">Try again</button>
    ${parkRecordMove()}
  </section>`;
}

function detailHtml() {
  if (state.detailStatus === "loading") return `<section class="card">${parkRecordBar()}<h2>The park</h2><p class="lede">Loading the park record, visitor center, trails, and alerts.</p>${parkRecordMove()}</section>`;
  if (state.detailStatus === "limited") {
    const minutes = Math.max(1, Math.ceil(((state.detailRetryAt || Date.now()) - Date.now()) / 60000));
    return detailUnavailable(`The National Park Service rate limit is in effect. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Trails were not replaced with samples.`);
  }
  if (state.detailStatus === "error") return detailUnavailable("That park record did not load. Trails were not replaced with samples.");
  const park = state.detail;
  if (!park) return `<section class="card">${parkRecordBar()}<h2>The park</h2><p class="lede">Loading the park record, visitor center, trails, and alerts.</p>${parkRecordMove()}</section>`;
  const image = park.images?.[0];
  const overview = clipSentence(park.description, 320);
  const highlights = park.activities.slice(0, 5);
  const placeLabel = park.point.fallback ? `${park.point.name} · map point, not a visitor center or trailhead` : `${park.point.name} · visitor center, not a trailhead`;
  const alertSummary = park.alerts.state === "empty"
    ? "No active alerts were in the NPS response."
    : park.alerts.state === "unavailable"
      ? "Park alerts did not load."
      : `${park.alerts.items.length} official ${park.alerts.items.length === 1 ? "alert" : "alerts"}`;
  return `<section class="card">
    ${parkRecordBar()}
    <figure class="hero-photo">${photo(image?.url, image?.alt)}<figcaption>${esc(image?.caption || park.name)}${image?.credit ? ` · ${esc(image.credit)}` : ""}</figcaption></figure>
    <h2>${esc(park.name)}</h2>
    <p>${esc(overview || "No short overview was on this park record.")}</p>
    <div class="facts">
      <span>${esc(park.states.split(",").join(", "))}</span>
      <span>${park.fee == null ? "Entrance fee not in this record" : `${money(park.fee)} per private vehicle`}</span>
      <span>${esc(placeLabel)}</span>
    </div>
    <h3>Highlights</h3>
    <div class="facts">${highlights.map((item) => `<span>${esc(item)}</span>`).join("") || "<span>No activities were listed on the park record.</span>"}</div>
    ${park.remoteAccess ? `<p>${esc(park.remoteAccess)}</p>` : ""}
    <details ${state.openDetails["park-alerts"] ? "open" : ""} data-keep="park-alerts">
      <summary>Alerts. ${esc(alertSummary)}</summary>
      <div class="block">${park.alerts.state === "ok" ? park.alerts.items.map((alert) => `<p><strong>${esc(alert.title)}</strong> ${esc(alert.description)}</p>`).join("") : `<p>${esc(alertSummary)} That is not a certification that every road and trail is open.</p>`}</div>
    </details>
    ${parkAirportOutline()}
    <details ${state.openDetails["park-stay"] ? "open" : ""} data-keep="park-stay">
      <summary>Where to stay</summary>
      ${whereToStayHtml()}
    </details>
    <details ${state.openDetails["park-more"] ? "open" : ""} data-keep="park-more">
      <summary>More about the park</summary>
      <p>${esc(park.description || "No description was published.")}</p>
      <h3>Access</h3>
      <p>${esc(park.directions || "NPS did not include directions text on this record.")}</p>
      ${park.hours ? `<p class="meta">${esc(park.hours)}</p>` : ""}
      <p class="meta"><a href="${esc(park.url)}" target="_blank" rel="noreferrer">Park page on NPS.gov</a></p>
      <p class="source">${esc(park.source)} · ${esc(fresh(park.retrievedAt))}</p>
    </details>
    <div class="stage-move">
      <button class="btn" type="button" data-action="close-park">Back</button>
      <button class="btn primary" type="button" data-action="stage" data-stage="trails">Choose trails</button>
    </div>
  </section>`;
}

function parkAirportOutline() {
  let body;
  if (state.airportStatus === "loading" || state.airportStatus === "idle") {
    body = `<p class="meta">Looking up the nearest airports.</p>`;
  } else if (state.airportStatus !== "ok") {
    body = `<p class="meta">${esc(state.airports?.reason || "Airports did not load. No airport was guessed.")}</p>`;
  } else {
    const airports = state.airports?.airports || [];
    body = airports.length
      ? `<ul class="airport-outline">${airports.map((airport, index) => {
          const distance = airport.roadMiles != null
            ? `${airport.roadMiles} mi by road`
            : airport.straightMiles != null
              ? `${airport.straightMiles} mi straight-line`
              : "Distance not available";
          const added = state.tripAirports.some((item) => item.iata === airport.iata);
          return `<li>
            <div class="airport-outline-main"><strong>${esc(airport.name)} · ${esc(airport.iata)}</strong><span class="distance">${esc(distance)}</span></div>
            <button class="btn" type="button" data-action="add-airport" data-index="${index}" aria-pressed="${added}">${added ? "Remove from itinerary" : "Add to itinerary"}</button>
          </li>`;
        }).join("")}</ul><p class="meta">Adding an airport does not book a flight.</p>`
      : `<p class="meta">No scheduled commercial airport was returned. None was guessed.</p>`;
  }
  return `<details ${state.openDetails["park-airports"] ? "open" : ""} data-keep="park-airports">
    <summary>Closest airports</summary>
    ${body}
  </details>`;
}

function airportHtml() {
  if (state.airportStatus === "loading" || state.airportStatus === "idle") return `<p class="lede" id="airports">Looking up the nearest scheduled commercial airports.</p>`;
  if (state.airportStatus === "error" || state.airportStatus === "unavailable" || state.airportStatus === "empty") {
    return `<p class="lede" id="airports">${esc(state.airports?.reason || "Airports did not load. No airport was guessed.")}</p>`;
  }
  const airports = state.airports?.airports || [];
  if (!airports.length) return `<p class="lede" id="airports">No scheduled commercial airport was returned. None was guessed.</p>`;
  return `<div id="airports">
    <p class="lede">The three nearest scheduled U.S. commercial airports, measured to ${esc(state.airports.entrance || "the visitor center")}. Straight-line miles are not a drive. Adding one to the itinerary, or using it as the start, does not book a flight.</p>
    <div class="airport-list">
      ${airports.map((airport, index) => {
        const label = `${airport.name} (${airport.iata})`;
        const added = state.tripAirports.some((item) => item.iata === airport.iata);
        const started = state.origin?.label === label;
        return `<article class="airport-card">
        <div>
          <strong>${esc(airport.name)} · ${esc(airport.iata)}</strong>
          <p class="meta">${esc(airport.type)}${airport.city ? ` · ${esc(airport.city)}` : ""}</p>
          <p class="meta">${airport.straightMiles == null ? "Straight-line distance unavailable" : `${esc(airport.straightMiles)} mi straight-line`} · ${airport.roadMiles == null ? "Road miles not verified" : `${esc(airport.roadMiles)} mi · ${esc(hoursLabel(airport.roadMinutes))} by road`}</p>
        </div>
        <div class="airport-actions">
          <button class="btn" type="button" data-action="add-airport" data-index="${index}" aria-pressed="${added}">${added ? "Remove from itinerary" : "Add to itinerary"}</button>
          <button class="btn ${started ? "primary" : ""}" type="button" data-action="use-airport" data-index="${index}" aria-pressed="${started}">${started ? "Starting point" : "Use as start"}</button>
        </div>
      </article>`;
      }).join("")}
    </div>
    <p class="source">${esc(state.airports.source || "")} · ${esc(fresh(state.airports.retrievedAt))}</p>
  </div>`;
}

function roundMiles(value) {
  return Math.round(value * 10) / 10;
}

function outlineShift(trail) {
  let shift = 0;
  if (trail.level === "strenuous") shift -= 30;
  else if (trail.level === "easy" && (trail.minutes == null || trail.minutes < 90)) shift += 30;
  if (trail.minutes != null && trail.minutes >= 240) shift -= 30;
  return shift;
}

function outlineGap(trail) {
  if (trail.level === "strenuous") return 30;
  if (trail.level === "moderate") return 20;
  if (trail.level === "easy") return 15;
  return 0;
}

function suggestedStart(row, event) {
  if (event.endLabel) return `${event.startLabel}–${event.endLabel}`;
  if (event.driveKnown) return event.startLabel;
  if (row.leaveLabel) return `${row.leaveLabel} at the entrance`;
  if (event.outlined) return `${event.startLabel} · drive not included`;
  return "Time pending";
}

function tripDays() {
  if (!state.detail) return [];
  const plan = currentPlan();
  const dates = tripDates();
  const places = activeNightPlaces();
  const fallback = Object.values(places)[0] || null;
  const mpg = Number(state.mpg);
  const price = Number(state.price);
  return dates.map((date, index) => {
    const place = places[date] || places[dates[index - 1]] || fallback;
    const night = state.lodgingNights[date] || state.lodgingNights[dates[index - 1]];
    const stay = night?.property?.label || night?.area?.name || place?.name || "";
    const day = (plan.days || []).find((item) => item.date === date) || { items: [] };
    const explicit = selectedTrails().filter((trail) => trail.preferredDay === index);
    const auto = selectedTrails().filter((trail) => !Number.isInteger(trail.preferredDay) && day.items.some((item) => item.kind === "hike" && item.trailId === trail.id));
    const assigned = [...explicit, ...auto];
    const entrance = entrancePoint();
    const entranceOut = place && entrance ? resolveLeg(state.legBook, place, entrance) : { status: "unknown", minutes: null, miles: null };
    const entranceBack = place && entrance ? resolveLeg(state.legBook, entrance, place) : { status: "unknown", minutes: null, miles: null };
    const entranceKnown = entranceOut.status === "known" && entranceBack.status === "known";
    const entranceMiles = entranceKnown ? roundMiles(entranceOut.miles + entranceBack.miles) : null;
    let cursor = clockMinutes(state.departTime);
    let blocked = cursor == null;
    let milesKnown = 0;
    let complete = true;
    const events = assigned.map((trail, eventIndex) => {
      const point = trail.lat == null || trail.lon == null ? null : { lat: trail.lat, lon: trail.lon, name: trail.name };
      const out = place && point ? resolveLeg(state.legBook, place, point) : { status: "unknown", minutes: null, miles: null };
      const back = place && point ? resolveLeg(state.legBook, point, place) : { status: "unknown", minutes: null, miles: null };
      const driveKnown = out.status === "known" && back.status === "known";
      const miles = driveKnown ? roundMiles(out.miles + back.miles) : null;
      if (driveKnown) milesKnown = roundMiles(milesKnown + miles);
      else complete = false;
      let startLabel = "Time pending";
      let endLabel = "";
      let outlined = false;
      const canOutline = trail.minutes != null || ["easy", "moderate", "strenuous"].includes(trail.level);
      if (!blocked && driveKnown) {
        const start = cursor + out.minutes;
        startLabel = formatClock(start);
        if (trail.minutes != null) {
          const end = start + trail.minutes;
          endLabel = formatClock(end);
          cursor = end + back.minutes;
        } else blocked = true;
      } else if (!blocked && canOutline) {
        const start = Math.max(0, cursor + (eventIndex === 0 ? outlineShift(trail) : 0));
        startLabel = formatClock(start);
        outlined = true;
        if (trail.minutes != null) cursor = start + trail.minutes + outlineGap(trail);
        else blocked = true;
      } else blocked = true;
      return { trail, out, back, driveKnown, miles, startLabel, endLabel, outlined };
    });
    if (!assigned.length) complete = true;
    let miles = assigned.length && complete ? milesKnown : null;
    let entranceFallback = false;
    if (assigned.length && !events.some((event) => event.driveKnown) && entranceMiles != null) {
      miles = entranceMiles;
      complete = true;
      milesKnown = entranceMiles;
      entranceFallback = true;
    }
    return {
      date,
      index,
      stay,
      place,
      events,
      miles,
      knownMiles: !complete && milesKnown ? milesKnown : null,
      entranceFallback,
      leaveLabel: entranceFallback && cursor != null && entranceKnown ? formatClock(cursor + entranceOut.minutes) : "",
      gas: fuelCost(miles, mpg, price),
      pending: events.some((event) => event.out.status === "pending" || event.back.status === "pending"),
      notices: (plan.conflicts || []).filter((conflict) => String(conflict.message || "").includes(date)),
    };
  });
}

function milesLine(row) {
  if (!row) return "Not calculated";
  if (!row.events?.length) return "No trail drive";
  if (row.entranceFallback && row.miles != null) return `${row.miles} mi to the park entrance and back`;
  if (row.miles != null) return `${row.miles} mi`;
  if (row.pending) return "Driving time unavailable";
  if (row.knownMiles) return `${row.knownMiles} mi known, incomplete`;
  return "Driving time unavailable";
}

function driveTotals(rows) {
  const active = rows.filter((row) => row.events.length);
  const complete = active.length > 0 && active.every((row) => row.miles != null);
  const miles = complete ? roundMiles(active.reduce((sum, row) => sum + row.miles, 0)) : null;
  const knownSum = roundMiles(rows.reduce((sum, row) => sum + (row.miles ?? row.knownMiles ?? 0), 0));
  const mpg = Number(state.mpg);
  const price = Number(state.price);
  return {
    miles,
    gas: fuelCost(miles, mpg, price),
    knownMiles: complete ? null : knownSum || null,
    knownGas: complete ? null : fuelCost(knownSum || null, mpg, price),
  };
}

function selectedStayNames() {
  const names = stayNights(tripDates()).map((date) => state.lodgingNights[date]?.property?.label || state.lodgingNights[date]?.area?.name || "").filter(Boolean);
  return [...new Set(names)];
}

function staySummaryCard() {
  const nights = stayNights(tripDates());
  if (!hasBase()) return `<section class="card stay-summary"><div class="stay-summary-row"><div class="stay-summary-copy"><h2>Stay</h2><p class="meta">No base is on the itinerary yet.</p></div><button class="stay-change" type="button" data-action="open-stay">Choose a stay</button></div></section>`;
  const names = selectedStayNames();
  const open = nights.some((date) => !state.lodgingNights[date]?.area && !state.lodgingNights[date]?.property);
  const body = names.length === 1
    ? `<p class="stay-one"><strong>${esc(names[0])}</strong><span class="meta">${esc(stayDateLine(nights))}</span></p>`
    : `<ul class="day-summary">${nights.map((date) => {
      const night = state.lodgingNights[date];
      const place = night?.property?.label || night?.area?.name || "";
      return `<li><strong>${esc(readableDate(date))}</strong> ${place ? esc(place) : "No base"}</li>`;
    }).join("")}</ul>`;
  const action = open
    ? `<button class="stay-change" type="button" data-action="open-stay">Resolve open nights</button>`
    : `<button class="stay-change" type="button" data-action="open-stay">Change base</button>`;
  return `<section class="card stay-summary"><div class="stay-summary-row"><div class="stay-summary-copy"><h2>Stay</h2>${body}<p class="meta">Selecting this place does not reserve it.</p></div>${action}</div></section>`;
}

function clockMinutes(time) {
  const [hour, minute] = String(time || "").split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function stayOutlineHtml() {
  const nights = stayNights(tripDates());
  const named = nights.map((date) => ({
    date,
    name: state.lodgingNights[date]?.property?.label || state.lodgingNights[date]?.area?.name || "",
  })).filter((night) => night.name);
  if (!named.length) return `<p class="meta">No stay selected.</p>`;
  const names = [...new Set(named.map((night) => night.name))];
  const body = names.length === 1
    ? `<strong>${esc(names[0])}</strong><p class="meta">${esc(stayDateLine(nights))}</p>`
    : named.map((night) => `<p><strong>${esc(readableDate(night.date))}</strong> ${esc(night.name)}</p>`).join("");
  return `<article class="itinerary-stay"><p class="eyebrow">Stay</p>${body}<p class="meta">Selecting this place does not reserve it.</p></article>`;
}

function itineraryPaneHtml() {
  const trails = selectedTrails();
  const stay = Object.values(state.lodgingNights).find((night) => night?.area || night?.property);
  const stayName = stay?.property?.label || stay?.area?.name || "";
  return `<div class="itinerary-head">
      <h2>Itinerary</h2>
      <button class="itinerary-dismiss" type="button" data-action="toggle-itinerary" aria-label="Hide itinerary"><span class="itinerary-arrow-mark" aria-hidden="true"></span></button>
    </div>
    ${stayOutlineHtml()}
    ${state.tripAirports.map((airport) => `<article class="itinerary-item">
      <p><strong>${esc(airport.name)} (${esc(airport.iata)})</strong><span class="meta">Airport${state.origin?.label === airport.label ? " · starting point" : ""}</span></p>
      <button class="itinerary-remove" type="button" data-action="remove-airport" data-iata="${esc(airport.iata)}">Remove</button>
    </article>`).join("")}
    ${trails.length ? tripDays().map((row) => {
      if (!row.events.length) return "";
      const drive = row.miles != null ? `${milesLine(row)}${row.gas == null ? "" : ` · ${money(row.gas)}`}` : row.pending ? "Driving time unavailable" : milesLine(row);
      return `<section class="itinerary-day"><h3>${esc(readableDate(row.date))}</h3><p class="meta">${esc(drive)}</p>${row.events.map((event) => {
        const timing = suggestedStart(row, event);
        return `<article class="itinerary-item ${state.focusId === event.trail.id ? "is-on" : ""}">
      <button type="button" data-action="focus" data-id="${esc(event.trail.id)}"><strong>${esc(event.trail.name)}</strong><span class="itinerary-trail-meta">${badge(event.trail)}<span class="meta">${esc(timing)}</span></span></button>
      <button class="itinerary-remove" type="button" data-action="remove" data-id="${esc(event.trail.id)}">Remove</button>
    </article>`;
      }).join("")}</section>`;
    }).join("") : `<p class="meta">Approve a hike and it remains here.</p>`}
    ${(stayName || state.tripAirports.length || trails.length) ? `<button class="itinerary-remove itinerary-clear" type="button" data-action="clear-itinerary">Remove all</button>` : ""}`;
}

function tripHtml() {
  if (!state.detail) return "";
  const airportHint = state.origin && /airport/i.test(state.origin.label) && !state.airport
    ? `<p class="meta">This match looks like an airport. Turn on airport arrival if you are landing here.</p>`
    : "";
  return `<section class="card" id="plan-your-route">
    <h2>Map your journey</h2>
    <p class="lede">The stay from the first module is already on these nights. Set the start, then the distance, arrival, and gas use the roads that come back.</p>
    ${whereToStayHtml()}
    <div class="route-section">
      <h3>Map Your Route</h3>
      <label>Start from an airport, city, or street address
        <input id="originQuery" value="${esc(state.originQuery)}" placeholder="Las Vegas airport, or 1101 Zion Park Blvd, Springdale, UT" />
      </label>
      <div class="trail-actions">
        <button class="btn primary" type="button" data-action="geocode">Find this place</button>
      </div>
      ${state.geocodeStatus === "loading" ? `<p class="meta">Looking up that place.</p>` : ""}
      ${state.geocodeStatus === "empty" ? `<p class="meta">Nothing matched. Try a city or a street, and do not route yet.</p>` : ""}
      ${state.geocodeStatus === "error" ? `<p class="meta">The geocoder did not respond. The start stays unresolved.</p>` : ""}
      ${state.candidates.length ? `<div class="candidates">${state.candidates.map((item, index) => `<button class="btn" type="button" data-action="confirm-origin" data-index="${index}" aria-pressed="${state.origin?.label === item.label}">
        ${esc(item.label)} <small>${esc(item.layer || "place")}</small>
      </button>`).join("")}</div><p class="meta">Choose the match before a route is calculated. A single result can still be the wrong place.</p>` : ""}
      ${state.origin ? `<p><strong>Using</strong> ${esc(state.origin.label)}</p>` : ""}
      ${airportHint}
      <label class="check"><input id="airport" type="checkbox" ${state.airport ? "checked" : ""} /> This start is an airport arrival</label>
      <div class="trip-grid">
        ${state.airport ? `<label>Landing time <input id="landingTime" type="time" value="${esc(state.landingTime)}" /></label>
          <label>Baggage and vehicle pickup, minutes <input id="bufferMin" type="number" min="0" max="240" value="${esc(state.bufferMin)}" /></label>` : `<label>Departure time <input id="departTime" type="time" value="${esc(state.departTime)}" /></label><div></div>`}
        <label>First day <input id="startDate" type="date" value="${esc(state.startDate)}" /></label>
        <label>Return deadline <input id="returnBy" type="time" value="${esc(state.returnBy)}" /></label>
        ${state.airport ? `<label>Later mornings start at <input id="departTime" type="time" value="${esc(state.departTime)}" /></label>` : ""}
      </div>
    </div>
    ${budgetHtml()}
  </section>`;
}

function budgetHtml() {
  if (!state.detail) return "";
  const park = state.detail;
  const drive = drivingNow();
  const fuel = fuelNow();
  const fee = park.fee;
  const known = [fuel, fee].filter((value) => value != null);
  const total = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  const hikes = hikingMiles(selectedTrails());
  const driveLabel = state.roundTrip ? "Round trip" : "One way";
  const miles = drive.complete ? `${drive.miles} mi` : "Not calculated";
  const driveTime = drive.complete ? hoursLabel(drive.minutes) : "Not calculated";
  let routeNote = "Confirm a start to calculate a road route to the visitor center.";
  if (lodgingActive()) {
    routeNote = drive.complete
      ? `${driveLabel} driving through the lodging legs: ${drive.miles} mi, ${hoursLabel(drive.minutes)}. Hiking miles stay separate.`
      : `Driving through the lodging legs is incomplete.${drive.knownMiles ? ` Known portion so far: ${drive.knownMiles} mi. That is not the trip total, and missing legs are not zero.` : " Missing road time was not filled in."}`;
  } else if (state.routeStatus === "loading") routeNote = "Calculating the road route.";
  else if (state.route && !state.route.ok) routeNote = state.route.reason;
  else if (state.route?.ok) {
    routeNote = `${driveLabel} road estimate to ${state.route.pointName}: ${state.route.miles} mi, ${hoursLabel(state.route.minutes)}. ${state.route.omitReason || "Driving between published trailheads is included when those legs succeed."}`;
  }
  const missingCoords = selectedTrails().filter((trail) => trail.lat == null).length;
  return `<div class="drive-block">
    <h3>The Drive</h3>
    <div class="figures">
      <div><span>${esc(driveLabel)} driving</span><strong>${esc(miles)}</strong><small>Road miles, not a straight line</small></div>
      <div><span>Driving time</span><strong>${esc(driveTime)}</strong><small>Typical speed, not live traffic</small></div>
      <div><span>Fuel</span><strong>${esc(fuel == null ? "Not calculated" : money(fuel))}</strong><small>One vehicle</small></div>
    </div>
    <p>${esc(routeNote)}</p>
    ${missingCoords ? `<p class="meta">${missingCoords} selected trail${missingCoords === 1 ? "" : "s"} ha${missingCoords === 1 ? "s" : "ve"} no published coordinate, so that driving is not in the mileage.</p>` : ""}
    <div class="split" style="margin-top:12px">
      <div>
        <label class="check"><input id="roundTrip" type="checkbox" ${state.roundTrip ? "checked" : ""} /> Include the drive back</label>
        <div class="trip-grid">
          <label>Vehicle MPG <input id="mpg" type="number" min="1" step="0.1" value="${esc(state.mpg)}" /></label>
          <label>Price per gallon <input id="price" type="number" min="0" step="0.001" value="${esc(state.price)}" /></label>
        </div>
        <p class="meta">Fuel is total driving miles ÷ MPG × price per gallon. ${state.fuelMeta ? `${esc(state.fuelMeta.series)} for ${esc(state.fuelMeta.area)}, week of ${esc(state.fuelMeta.period)}, ${money(state.fuelMeta.price)}.` : "The weekly fuel price has not loaded, so enter one to estimate fuel."} MPG is the figure you enter, not a vehicle record. Gas is for one vehicle and does not multiply by the group of ${esc(state.groupSize)}.</p>
      </div>
      <div>
        <table class="money">
          <tr><td>${state.roundTrip ? "Fuel, round trip" : "Fuel, one way"}</td><td>${esc(fuel == null ? "Missing" : money(fuel))}</td></tr>
          <tr><td>NPS private-vehicle entrance</td><td>${fee == null ? "Not in this record" : esc(money(fee))}</td></tr>
          <tr class="total"><td>Known charges</td><td>${total == null ? "None yet" : esc(money(total))}</td></tr>
        </table>
        <p class="meta">Known charges are the driving budget plus entrance fee when both exist. Lodging rates, meals, permits, and ferry or flight fares are not priced here. A missing line is not zero.</p>
      </div>
    </div>
    <p class="source">${state.route?.source ? `${esc(state.route.source)} · ${esc(fresh(state.route.retrievedAt))}` : "Route not requested yet."} ${state.fuelMeta ? `Fuel ${esc(fresh(state.fuelMeta.retrievedAt))}.` : ""}</p>
  </div>`;
}

function trailsHtml() {
  const park = state.detail;
  if (!park) return "";
  if (!park.trails.length) {
    return `<section class="card"><h2>Trails</h2><p class="lede">NPS returned no hiking activities for ${esc(park.name)}. That is an empty activity list, not proof the park has no trails.</p><p class="source">${park.listedActivities} things-to-do records were read.</p></section>`;
  }
  const structured = recommendedHikes(park.trails, state.difficulty);
  const rest = park.trails.filter((trail) => !structured.includes(trail));
  const approved = park.trails.filter((trail) => state.selected.some((item) => item.id === trail.id));
  const shown = [];
  for (const trail of state.showOthers ? [...approved, ...structured, ...rest] : [...approved, ...structured]) {
    if (!shown.includes(trail)) shown.push(trail);
  }
  return `<section class="card">
    <h2>Trails</h2>
    <p class="lede">${approved.length} approved ${approved.length === 1 ? "hike is" : "hikes are"} in Trails. ${structured.length} ${structured.length === 1 ? "listing matches" : "listings match"} ${esc(difficultyLabel())}. ${rest.length} more are a different level or not a single hike.</p>
    ${approved.length ? `<ul class="approved-list">${approved.map((trail) => `<li>${esc(trail.name)}</li>`).join("")}</ul>` : `<p class="meta">No hikes are approved yet. Approve a recommendation on the park, or add one below.</p>`}
    <button class="chip" type="button" data-action="others" aria-pressed="${state.showOthers}">${state.showOthers ? "Showing every hiking listing" : `Show ${rest.length} other listings`}</button>
    ${shown.length ? shown.map((trail) => trailCard(trail)).join("") : `<p class="lede">Nothing at that level can be scheduled from the NPS text. Show the other listings to see what was withheld.</p>`}
  </section>`;
}

function selectionReason(trail) {
  const levels = selectedLevels(state.difficulty);
  const names = { easy: "easy", moderate: "moderate", strenuous: "strenuous" };
  const known = names[trail.level];
  let why = "it is a listed hike for this park";
  if (levels.length && known && levels.includes(trail.level)) why = `it is ${known}, which matches the hiking preference`;
  else if (levels.length && (!trail.level || trail.level === "unknown")) why = "it is a listed hike and its difficulty is not available yet, so it stays in the list";
  else if (known) why = `it is a listed ${known} hike`;
  const time = trail.duration ? `The published time is ${trail.duration}.` : "A duration was not published.";
  return `Selected because ${why}. ${time}`;
}

function suggestionHtml() {
  const suggestion = state.suggestion?.parkCode === state.parkCode ? state.suggestion : null;
  const byId = new Map((state.detail?.trails || []).map((trail) => [trail.id, trail]));
  const days = suggestion?.days || [];
  const choice = [tripSummary(), selectedLevels(state.difficulty).length ? `${difficultyLabel()} hikes` : "Any hike level", state.activityFilter.join(", ")].filter(Boolean).join(" · ");
  return `<div class="plan-suggest">
    <h3>Suggested itinerary</h3>
    <p class="meta">Uses ${esc(choice)}. A day can include only hikes already listed for this park.</p>
    <button class="btn primary" type="button" data-action="suggest-itinerary" ${state.suggestionStatus === "loading" ? "disabled" : ""}>${state.suggestionStatus === "loading" ? "Writing the days" : "Suggest an itinerary"}</button>
    ${suggestion?.reason ? `<p class="meta">${esc(suggestion.reason)}</p>` : ""}
    ${days.length ? `<ol class="suggest-days">${days.map((day) => {
      const trails = day.trailIds.map((id) => byId.get(id)).filter(Boolean);
      const names = trails.map((trail) => trail.name);
      const reasons = trails.map((trail) => selectionReason(trail));
      const empty = "No remaining listed hike was left for this day.";
      return `<li><strong>${esc(readableDate(day.date))}</strong> ${names.length ? names.map((name) => esc(name)).join(", ") : "No hike placed."}${reasons.length ? reasons.map((reason) => `<span class="suggest-reason">${esc(reason)}</span>`).join("") : `<span class="suggest-reason">${esc(empty)}</span>`}${day.note ? `<span class="meta">${esc(day.note)}</span>` : ""}</li>`;
    }).join("")}</ol>` : ""}
    ${suggestion ? `<p class="source">${suggestion.authored ? "Written from the listed hikes and these dates." : "Filled from the listed hikes. No model text was added."} ${esc(fresh(suggestion.retrievedAt))}</p>` : ""}
    ${days.some((day) => day.trailIds.length) ? `<button class="btn" type="button" data-action="apply-suggestion">Add these hikes to the itinerary</button>` : ""}
  </div>`;
}

function leadLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "Not available";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function trailFacts(trail) {
  return [trail.duration ? leadLabel(trail.duration) : "Not available", leadLabel(trail.routeType)].join(" · ");
}

function trailSecondary(trail) {
  const distance = trail.miles == null || trail.miles === "" ? "Not available" : `${trail.miles} mi`;
  const gain = trail.elevation == null || trail.elevation === "" ? "Not available" : `${trail.elevation} ft gain`;
  return `${distance} · ${gain}`;
}

function preferenceFit(trail) {
  const levels = selectedLevels(state.difficulty);
  if (!levels.length) return trail.schedulable ? "NPS published one difficulty and a duration, so it can be placed on a day." : "";
  if (!levels.includes(trail.level) || trail.levelEstimated) return "";
  return `Matches your preference for ${trail.level} hikes.`;
}

function daylightConflict(trail) {
  const sunsets = (state.weather?.days || []).filter((day) => day.sunset != null && day.sunrise != null);
  if (!trail.hours || !sunsets.length) return "";
  const daylight = Math.max(...sunsets.map((day) => (day.sunset - day.sunrise) / 60));
  if (trail.hours > daylight) return "The published duration is longer than the daylight on these dates.";
  return "";
}

function trailCard(trail) {
  const alerts = matchingAlerts(trail);
  const chosen = state.selected.some((item) => item.id === trail.id);
  const fit = preferenceFit(trail);
  const conflict = daylightConflict(trail);
  const status = [
    trail.permit ? "Reservation required." : "",
    ...trail.seasonNotes,
    alerts.length ? alerts.map((alert) => alert.title).join(". ") : "",
    conflict,
    trail.schedulable ? "" : "Not placed on the clock.",
  ].filter(Boolean);
  const sourceKey = `sources-${trail.id}`;
  const sources = [
    trail.why || "",
    trail.levelEstimated ? "The difficulty is estimated from distance, not an NPS label." : "",
    selectedLevels(state.difficulty).length && !selectedLevels(state.difficulty).includes(trail.level) ? `Your preference is ${difficultyLabel()}. This listing is ${trail.level}.` : "",
    trail.lat == null ? "NPS did not publish a trailhead coordinate." : `Trailhead ${trail.lat}, ${trail.lon}.`,
  ].filter(Boolean);
  const level = ["easy", "moderate", "strenuous", "mixed"].includes(trail.level) ? trail.level : "unknown";
  return `<article class="trail${state.previewId === trail.id ? " is-open" : ""}" data-level="${level}">
    <figure class="trail-photo">
      <div class="trail-frame">${photo(trail.image, trail.imageAlt || trail.name)}</div>
      <figcaption class="trail-credit">${trail.imageCredit ? esc(trail.imageCredit) : "Photo credit not on this record"}</figcaption>
    </figure>
    <div class="trail-body">
      <h3>${esc(trail.name)}</h3>
      <p class="trail-primary">${badge(trail)} <span>${esc(trailFacts(trail))}</span></p>
      <p class="trail-secondary">${esc(trailSecondary(trail))}</p>
      ${fit ? `<p class="trail-fit">${esc(fit)}</p>` : ""}
      <ul class="trail-status">${status.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
      <details class="trail-sources" ${state.openDetails[sourceKey] ? "open" : ""} data-keep="${esc(sourceKey)}">
        <summary>Conditions & sources</summary>
        <div class="trail-source-body">
          ${sources.map((line) => `<p>${esc(line)}</p>`).join("")}
          ${trail.url ? `<p><a href="${esc(trail.url)}" target="_blank" rel="noreferrer">Activity on NPS.gov</a></p>` : `<p>No NPS.gov activity link was on this record.</p>`}
        </div>
      </details>
    </div>
    <div class="trail-actions">
      ${chosen ? `<label class="day-assign">Day <select data-day="${esc(trail.id)}" aria-label="Day for ${esc(trail.name)}">${tripDates().map((date, index) => `<option value="${index}" ${state.selected.find((item) => item.id === trail.id)?.preferredDay === index ? "selected" : ""}>${esc(readableDate(date))}</option>`).join("")}</select></label>` : ""}
      <button class="btn ${chosen ? "" : "primary"}" type="button" data-action="${chosen ? "remove" : "add"}" data-id="${esc(trail.id)}" aria-pressed="${chosen}">${chosen ? "Remove" : "Add to itinerary"}</button>
      <button class="btn" type="button" data-action="preview" data-id="${esc(trail.id)}" aria-pressed="${state.previewId === trail.id}">${state.previewId === trail.id ? "Hide details" : "View details"}</button>
    </div>
    ${state.previewId === trail.id ? trailDetailHtml(trail) : ""}
  </article>`;
}

function trailConditionsHtml(trail) {
  const alerts = matchingAlerts(trail);
  const lines = [
    trail.blurb || "No description was published for this trail.",
    ...(trail.seasonNotes?.length ? trail.seasonNotes : ["No seasonal condition was stated on this activity."]),
    ...(alerts.length ? alerts.map((alert) => `${alert.title}. ${alert.description}`) : ["No alert title matched this trail. Park-wide alerts stay on the park record."]),
    trail.permit ? "Reservation required." : "No reservation flag was on this activity. That does not mean a permit is unnecessary.",
  ];
  const daylight = daylightConflict(trail);
  if (daylight) lines.push(daylight);
  return lines.map((line) => `<p>${esc(line)}</p>`).join("");
}

function trailWeatherHtml(trail) {
  const dates = tripDates();
  const assigned = state.selected.find((item) => item.id === trail.id);
  const dayIndex = Number.isInteger(assigned?.preferredDay) ? assigned.preferredDay : null;
  return weatherCardsHtml(dates, { markIndex: dayIndex, markNote: "this hike" });
}

function trailDetailHtml(trail) {
  const mapped = state.trailMapId === trail.id;
  const canMap = Number.isFinite(Number(trail.lat)) && Number.isFinite(Number(trail.lon));
  return `<div class="trail-detail">
    <section>
      <h4>Conditions</h4>
      ${trailConditionsHtml(trail)}
      ${trail.url ? `<p class="meta"><a href="${esc(trail.url)}" target="_blank" rel="noreferrer">Activity on NPS.gov</a></p>` : `<p class="meta">No NPS.gov activity link was on this record.</p>`}
    </section>
    <section>
      <h4>Weather</h4>
      ${trailWeatherHtml(trail)}
    </section>
    <section>
      <h4>Trail map</h4>
      ${canMap ? `<button class="btn" type="button" data-action="show-trail-map" data-id="${esc(trail.id)}" aria-pressed="${mapped}">${mapped ? "Hide map" : "View trail on map"}</button>
        ${mapped ? `<div id="trail-path-map" class="trail-path-map" aria-label="Map centered on the ${esc(trail.name)} trailhead"></div><p class="meta">The pin is the published trailhead. NPS did not provide a trail path, so no line is drawn.</p>` : ""}` : `<p class="meta">NPS did not publish a trailhead coordinate, so a trail path cannot be shown.</p>`}
    </section>
  </div>`;
}

function planMapCard() {
  return `<section class="card plan-map-card" id="plan-map-card"><h2>Map</h2><div id="plan-map-slot"></div></section>`;
}

function settingsOutlineHtml() {
  const days = Math.min(10, Math.max(1, Number(state.dayCount) || 1));
  const hours = (Number(state.maxDailyDriveMin) || 180) / 60;
  const activity = state.activityFilter.length ? state.activityFilter.join(", ") : "Any activity";
  const items = [
    ["Park", state.detail?.name || "Not chosen"],
    ["Trip Start", readableDate(state.startDate)],
    ["Duration", `${days} ${days === 1 ? "day" : "days"}`],
    ["Location", state.stateFilter || "All states"],
    ["Activity", activity],
    ["Hiking Preference", difficultyLabel()],
    ["Group Size", String(state.groupSize || 1)],
    ["Max drive to the park", `${state.maxStayMiles} miles`],
    ["Max daily driving", `${hours} ${hours === 1 ? "hour" : "hours"}`],
  ];
  return `<section class="card settings-outline" aria-label="Trip settings"><h2>Settings</h2><dl>${items.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl></section>`;
}

function planHtml() {
  if (!state.detail) return "";
  runProximity();
  const rows = tripDays();
  const levelName = { easy: "Easy", moderate: "Moderate", strenuous: "Strenuous", mixed: "Mixed" };
  const placed = rows.flatMap((row) => row.events.map((event) => ({ row, event })));
  const outlined = placed.some(({ row, event }) => suggestedStart(row, event).includes("drive not included"));
  const depart = formatClock(clockMinutes(state.departTime) ?? 8 * 60);
  return `<section class="card" id="itinerary-plan">
    <h2>Itinerary</h2>
    ${placed.length ? `<table class="compare"><thead><tr><th>Date</th><th>Trail</th><th>Level</th><th>Distance</th><th>Time</th><th>Suggested start</th></tr></thead><tbody>
      ${placed.map(({ row, event }) => {
        const trail = event.trail;
        const level = levelName[trail.level] || "Not available";
        return `<tr><td>${esc(readableDate(row.date))}</td><td><button type="button" data-action="focus" data-id="${esc(trail.id)}">${esc(trail.name)}</button></td><td>${esc(level)}${trail.levelEstimated ? " est." : ""}</td><td>${esc(blank(trail.miles, " mi", "Not stated"))}</td><td>${esc(trail.duration || (trail.minutes != null ? hoursLabel(trail.minutes) : "Not stated"))}</td><td>${esc(suggestedStart(row, event))}</td></tr>`;
      }).join("")}
    </tbody></table>${outlined ? `<p class="meta">Where the drive is not known, the suggested start is counted from the ${esc(depart)} departure. A strenuous hike, or one published at 4 hours or more, starts 30 minutes earlier. An easy hike under 90 minutes starts 30 minutes later. The next hike follows the published duration, plus 15, 20, or 30 minutes by difficulty. The drive is not included.</p>` : ""}` : `<p class="lede">Approve an activity in Select Trails. The drive can still be estimated without one.</p>`}
  </section>`;
}

function skyKind(sky) {
  const text = String(sky || "").toLowerCase();
  if (/snow|ice|sleet/.test(text)) return "snow";
  if (/thunder|storm/.test(text)) return "storm";
  if (/rain|drizzle|shower/.test(text)) return "rain";
  if (/fog/.test(text)) return "fog";
  if (/cloud|overcast/.test(text)) return "cloud";
  if (/clear|sun/.test(text)) return "sun";
  return "unknown";
}

function skyMark(kind) {
  const marks = {
    sun: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="12" /><g stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M32 8v8M32 48v8M8 32h8M48 32h8M14 14l6 6M44 44l6 6M50 14l-6 6M20 44l-6 6" /></g></svg>`,
    cloud: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M22 44h24a10 10 0 0 0 1-20 14 14 0 0 0-27-3A9 9 0 0 0 22 44z" /></svg>`,
    rain: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 34h26a9 9 0 0 0 1-18 12 12 0 0 0-23-2 8 8 0 0 0-4 20z" /><g stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M24 42l-3 8M32 42l-3 8M40 42l-3 8" /></g></svg>`,
    storm: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 32h28a9 9 0 0 0 0-18 12 12 0 0 0-23-1 8 8 0 0 0-5 19z" /><path d="M30 34l-6 12h8l-4 12 12-16h-8z" /></svg>`,
    snow: `<svg viewBox="0 0 64 64" aria-hidden="true"><g stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M32 10v44M14 20l36 24M50 20L14 44" /><path d="M32 18l-4-4M32 18l4-4M32 46l-4 4M32 46l4 4" /></g></svg>`,
    fog: `<svg viewBox="0 0 64 64" aria-hidden="true"><g stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 24h40M16 32h32M12 40h40M20 48h24" /></g></svg>`,
    unknown: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="16" fill="none" stroke="currentColor" stroke-width="3" /><path d="M32 42v.5M28 26a4 4 0 1 1 6 3c-1 1-2 2-2 4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" /></svg>`,
  };
  return `<span class="sky-mark sky-${kind}">${marks[kind] || marks.unknown}</span>`;
}

function weatherTrouble(day) {
  const notes = [];
  if (day.precip != null && Number(day.precip) >= 0.25) notes.push(`${day.precip} in of precipitation`);
  if (day.wind != null && Number(day.wind) >= 25) notes.push(`wind ${day.wind} mph`);
  if (day.high != null && Number(day.high) <= 32) notes.push(`a high of ${day.high}°F`);
  if (day.low != null && Number(day.low) <= 20) notes.push(`a low of ${day.low}°F`);
  return notes;
}

function weatherHtml() {
  if (!state.detail) return "";
  if (state.weatherStatus === "loading") return `<section class="card weather-desk"><h2>Weather desk</h2><p class="lede">Requesting conditions for the trip dates at ${esc(state.detail.point.name)}.</p></section>`;
  if (state.weatherStatus === "error" || !state.weather) return `<section class="card weather-desk"><h2>Weather desk</h2><p class="lede">Weather is unavailable for ${esc(state.detail.point.name)}. Temperature, rain, and wind stay blank.</p></section>`;
  const weather = state.weather;
  const trouble = weather.days.flatMap((day) => weatherTrouble(day).map((note) => `${day.date.slice(5)}: ${note}`));
  const alertLine = weather.alerts.state === "ok"
    ? weather.alerts.items.join(" ")
    : weather.alerts.state === "empty"
      ? "No active NWS alert for this point. That is not a safety certification."
      : "NWS alerts did not load for this point.";
  return `<section class="card weather-desk">
    <div class="weather-banner">
      <p class="desk-kicker">Regional desk · ${esc(state.detail.point.name)}</p>
      <h2>Weather</h2>
      <p>${esc(weather.caveat)} ${state.detail.point.fallback ? "This park had no visitor-center coordinate, so the point is the park map marker." : ""}</p>
    </div>
    <div class="weather-cast">
      ${weather.days.map((day) => {
        const kind = skyKind(day.sky);
        const notes = weatherTrouble(day);
        return `<article class="cast-day">
          ${skyMark(kind)}
          <span class="cast-date">${esc(day.date.slice(5))}</span>
          <strong>${day.high == null ? "—" : `${esc(day.high)}°`}</strong>
          <span>${day.kind === "forecast" ? "Forecast" : day.kind === "seasonal" ? "Seasonal" : "Unavailable"}</span>
          <span>${esc(day.sky || "Sky not labeled")}</span>
          <span>${day.low == null ? "Low unavailable" : `Low ${esc(day.low)}°`}</span>
          <span>${day.precip == null ? "Precip unavailable" : `${esc(day.precip)} in`}</span>
          <span>${day.wind == null ? "Wind unavailable" : `${esc(day.wind)} mph`}</span>
          ${notes.length ? `<span class="cast-trouble">${esc(notes.join(" · "))}</span>` : ""}
        </article>`;
      }).join("")}
    </div>
    <p class="weather-ticker">${esc(alertLine)}</p>
    <p class="lede">${trouble.length ? `Route context uses only reported figures: ${esc(trouble.join("; "))}.` : "No day in this window has precipitation of 0.25 in or more, wind of 25 mph or more, or a high at or below 32°F. A missing figure is not treated as clear."}</p>
    <p class="source">${esc(weather.source)} · ${esc(fresh(weather.retrievedAt))}${weather.timezone ? ` · ${esc(weather.timezone)}` : ""}</p>
  </section>`;
}

function packChip(item) {
  return `<article class="pack-chip${item.checked ? " is-on" : ""}">
        <button type="button" data-action="toggle-pack" data-id="${esc(item.id)}" aria-pressed="${item.checked ? "true" : "false"}">
          <strong>${esc(item.text)}</strong>
          <span>${esc(item.reason)}</span>
        </button>
        ${item.custom ? `<button class="pack-remove" type="button" data-action="drop-pack" data-id="${esc(item.id)}" aria-label="Remove ${esc(item.text)}">×</button>` : ""}
      </article>`;
}

function packingHtml() {
  if (!state.detail) return "";
  syncPacking();
  const groups = [
    ["apparel", "Apparel", "No apparel item was suggested from the weather on these dates."],
    ["consumable", "Consumable", "No consumable was suggested."],
    ["permit", "Permits/Misc", "No permit was marked, and no extra item has been added."],
  ];
  const columns = groups.map(([group, label, empty]) => {
    const items = state.packing.filter((item) => item.group === group || (group === "permit" && item.group === "custom"));
    return `<section class="pack-group"><h3>${label}</h3>${items.length ? `<div class="pack-list">${items.map(packChip).join("")}</div>` : `<p class="meta">${empty}</p>`}</section>`;
  }).join("");
  return `<section class="card" id="packing">
    <h2>Packing</h2>
    <p class="lede">Apparel, consumables, and permits or other items. Tap an item when it is packed.</p>
    <div class="pack-columns">${columns}</div>
    <div class="pack-actions">
      <button class="btn" type="button" data-action="add-pack">Add an item</button>
      <button class="btn primary" type="button" data-action="save-trip">Save itinerary</button>
    </div>
  </section>`;
}

function emailTemplate() {
  const park = state.detail?.name || "Trip";
  const rows = tripDays();
  const nights = stayNights(tripDates());
  const stayNames = [...new Set(nights.map((date) => state.lodgingNights[date]?.property?.label || state.lodgingNights[date]?.area?.name).filter(Boolean))];
  const levelName = { easy: "Easy", moderate: "Moderate", strenuous: "Strenuous", mixed: "Mixed" };
  const placed = rows.flatMap((row) => row.events.map((event) => ({ row, event })));
  const outlined = placed.some(({ row, event }) => suggestedStart(row, event).includes("drive not included"));
  const depart = formatClock(clockMinutes(state.departTime) ?? 8 * 60);
  const card = "background:#ffffff;border:1px solid #d7e0da;border-radius:18px;padding:18px;margin:0 0 16px;";
  const heading = "margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:-0.03em;font-weight:650;";
  const stayBody = stayNames.length
    ? `${stayNames.length === 1
      ? `<p style="margin:0;font-size:18px;"><strong>${esc(stayNames[0])}</strong></p><p style="margin:4px 0 0;color:#5c6b66;">${esc(stayDateLine(nights))}</p>`
      : `<ul style="margin:0;padding-left:18px;">${nights.map((date) => {
        const night = state.lodgingNights[date];
        const place = night?.property?.label || night?.area?.name || "No base";
        return `<li><strong>${esc(readableDate(date))}</strong> ${esc(place)}</li>`;
      }).join("")}</ul>`}<p style="margin:8px 0 0;color:#5c6b66;">Selecting this place does not reserve it.</p>`
    : `<p style="margin:0;color:#5c6b66;">No base is on the itinerary yet.</p>`;
  const weatherDays = state.weather?.days || [];
  const weatherCells = weatherDays.map((day) => `<td style="width:${Math.floor(100 / Math.max(weatherDays.length, 1))}%;background:#f6f4ee;border-radius:14px;padding:12px;vertical-align:top;">
      <div style="color:#5c6b66;font-size:12px;">${esc(readableDate(day.date))}</div>
      <div style="font-family:Georgia,serif;font-size:28px;margin:4px 0;">${day.high == null ? "—" : `${esc(day.high)}°`}</div>
      <div>${esc(day.sky || "Sky not labeled")}</div>
      <div style="color:#5c6b66;font-size:13px;margin-top:6px;">${day.low == null ? "Low unavailable" : `Low ${esc(day.low)}°`}</div>
      <div style="color:#5c6b66;font-size:13px;">${day.precip == null ? "Precip unavailable" : `${esc(day.precip)} in`}</div>
      <div style="color:#5c6b66;font-size:13px;">${day.wind == null ? "Wind unavailable" : `${esc(day.wind)} mph`}</div>
    </td>`).join("");
  const weatherBody = weatherDays.length
    ? `<table role="presentation" width="100%" style="border-collapse:separate;border-spacing:8px 0;"><tr>${weatherCells}</tr></table>`
    : `<p style="margin:0;color:#5c6b66;">Weather is not available for these dates.</p>`;
  const tableHead = ["Date", "Trail", "Level", "Distance", "Time", "Suggested start"].map((label) => `<th style="text-align:left;padding:8px 6px;border-bottom:1px solid #d7e0da;color:#5c6b66;font-size:12px;font-weight:650;">${label}</th>`).join("");
  const tableRows = placed.map(({ row, event }) => {
    const trail = event.trail;
    const level = levelName[trail.level] || "Not available";
    const cell = "padding:10px 6px;border-bottom:1px solid #e6eeea;vertical-align:top;";
    return `<tr>
      <td style="${cell}">${esc(readableDate(row.date))}</td>
      <td style="${cell}font-weight:650;">${esc(trail.name)}</td>
      <td style="${cell}">${esc(level)}${trail.levelEstimated ? " est." : ""}</td>
      <td style="${cell}">${esc(blank(trail.miles, " mi", "Not stated"))}</td>
      <td style="${cell}">${esc(trail.duration || (trail.minutes != null ? hoursLabel(trail.minutes) : "Not stated"))}</td>
      <td style="${cell}">${esc(suggestedStart(row, event))}</td>
    </tr>`;
  }).join("");
  const itineraryBody = placed.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>${tableHead}</tr></thead><tbody>${tableRows}</tbody></table>${outlined ? `<p style="margin:12px 0 0;color:#5c6b66;font-size:13px;">Where the drive is not known, the suggested start is counted from the ${esc(depart)} departure. A strenuous hike, or one published at 4 hours or more, starts 30 minutes earlier. An easy hike under 90 minutes starts 30 minutes later. The next hike follows the published duration, plus 15, 20, or 30 minutes by difficulty. The drive is not included.</p>` : ""}`
    : `<p style="margin:0;color:#5c6b66;">Approve an activity in Select Trails.</p>`;
  const groups = [
    ["apparel", "Apparel", "No apparel item was suggested from the weather on these dates."],
    ["consumable", "Consumable", "No consumable was suggested."],
    ["permit", "Permits/Misc", "No permit was marked, and no extra item has been added."],
  ];
  const packCells = groups.map(([group, label, empty]) => {
    const items = state.packing.filter((item) => item.group === group || (group === "permit" && item.group === "custom"));
    const cards = items.length
      ? items.map((item) => `<div style="background:#f6f4ee;border:1px solid #d7e0da;border-radius:16px;padding:12px 14px;margin:0 0 8px;min-height:96px;box-sizing:border-box;">
          <strong>${esc(item.text)}</strong>
          <div style="color:#5c6b66;font-size:12px;line-height:1.35;margin-top:4px;">${esc(item.reason)}</div>
        </div>`).join("")
      : `<p style="margin:0;color:#5c6b66;font-size:14px;">${esc(empty)}</p>`;
    return `<td style="width:33.33%;vertical-align:top;padding:0 8px;"><h3 style="margin:0 0 8px;font-size:15px;">${label}</h3>${cards}</td>`;
  }).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(park)} itinerary</title></head>
<body style="margin:0;padding:28px;background:#f6f4ee;color:#142b26;font-family:Inter,Arial,sans-serif;">
  <div style="max-width:920px;margin:0 auto;">
    <p style="margin:0;letter-spacing:0.08em;text-transform:uppercase;font-size:12px;color:#5c6b66;">ParkPilot</p>
    <h1 style="margin:6px 0 4px;font-family:Georgia,'Times New Roman',serif;font-size:40px;letter-spacing:-0.03em;">Itinerary</h1>
    <p style="margin:0 0 18px;font-size:16px;">${esc(park)} · ${esc(tripSummary())}</p>
    <section style="${card}"><h2 style="margin:0 0 6px;font-family:Inter,Arial,sans-serif;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#5c6b66;">Stay</h2>${stayBody}</section>
    <section style="${card}"><h2 style="${heading}">Weather</h2>${weatherBody}</section>
    <section style="${card}"><h2 style="${heading}">Itinerary</h2>${itineraryBody}</section>
    <section style="${card}"><h2 style="${heading}">Packing</h2><p style="margin:0 0 14px;color:#5c6b66;">Apparel, consumables, and permits or other items.</p><table role="presentation" width="100%" style="border-collapse:collapse;"><tr>${packCells}</tr></table></section>
    <p style="margin:8px 0 0;color:#5c6b66;font-size:13px;">This is a trip note, not a reservation or a booking.</p>
  </div>
</body>
</html>`;
}

function loadSavedTrips() {
  try {
    const trips = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    return Array.isArray(trips) ? trips.filter((trip) => trip && trip.id && trip.html) : [];
  } catch {
    return [];
  }
}

function storeSavedTrips(trips) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(trips.slice(0, 30)));
}

function tripSettings() {
  return {
    query: state.query,
    stateFilter: state.stateFilter,
    activityFilter: state.activityFilter,
    activityQuery: state.activityQuery,
    locationQuery: state.locationQuery,
    parkCode: state.parkCode,
    originQuery: state.originQuery,
    origin: state.origin,
    airport: state.airport,
    landingTime: state.landingTime,
    bufferMin: state.bufferMin,
    startDate: state.startDate,
    dayCount: state.dayCount,
    departTime: state.departTime,
    returnBy: state.returnBy,
    groupSize: state.groupSize,
    difficulty: state.difficulty,
    mpg: state.mpg,
    price: state.price,
    priceTouched: state.priceTouched,
    roundTrip: state.roundTrip,
    selected: state.selected,
    packing: state.packing,
    lodgingMode: state.lodgingMode,
    maxDailyDriveMin: state.maxDailyDriveMin,
    maxStayMiles: state.maxStayMiles,
    lodgingQuery: state.lodgingQuery,
    lodgingChoice: state.lodgingChoice,
    lodgingNights: state.lodgingNights,
    nightPick: state.nightPick,
    proposalDismissedFor: state.proposalDismissedFor,
    tripAirports: state.tripAirports,
  };
}

function applyTripPlan(plan) {
  const fields = ["query", "stateFilter", "activityQuery", "locationQuery", "parkCode", "originQuery", "origin", "airport", "landingTime", "bufferMin", "startDate", "dayCount", "departTime", "returnBy", "groupSize", "mpg", "price", "priceTouched", "roundTrip", "lodgingMode", "maxDailyDriveMin", "maxStayMiles", "lodgingQuery", "lodgingChoice", "proposalDismissedFor"];
  for (const field of fields) {
    if (plan[field] !== undefined) state[field] = plan[field];
  }
  state.activityFilter = Array.isArray(plan.activityFilter) ? plan.activityFilter : [];
  state.difficulty = selectedLevels(plan.difficulty);
  state.selected = Array.isArray(plan.selected) ? plan.selected : [];
  state.packing = Array.isArray(plan.packing) ? plan.packing : [];
  state.lodgingNights = plan.lodgingNights && typeof plan.lodgingNights === "object" ? plan.lodgingNights : {};
  state.nightPick = plan.nightPick && typeof plan.nightPick === "object" ? plan.nightPick : {};
  state.tripAirports = Array.isArray(plan.tripAirports) ? plan.tripAirports : [];
}

function saveCurrentTrip() {
  if (!state.detail) return;
  syncPacking();
  const id = `trip-${Date.now()}`;
  const trip = {
    id,
    savedAt: new Date().toISOString(),
    parkName: state.detail.name,
    summary: tripSummary(),
    html: emailTemplate(),
    plan: JSON.parse(JSON.stringify(tripSettings())),
  };
  storeSavedTrips([trip, ...loadSavedTrips()]);
  state.savedId = id;
  state.copyNotice = "Itinerary saved. Export as PDF and the templated email are on this page.";
  state.emailDraft = "";
  state.stage = "saved";
  state.stageJustChanged = true;
}

async function openSavedTrip(id) {
  const trip = loadSavedTrips().find((item) => item.id === id);
  state.savedId = id;
  state.emailDraft = "";
  if (!trip?.plan?.parkCode) {
    state.copyNotice = "Save this itinerary again to open it with these settings.";
    paint();
    return;
  }
  const plan = trip.plan;
  const airports = Array.isArray(plan.tripAirports) ? plan.tripAirports : [];
  const samePark = state.detail?.code === plan.parkCode && state.detailStatus === "ok";
  applyTripPlan(plan);
  state.copyNotice = "";
  state.packComposer = false;
  state.previewId = "";
  state.trailMapId = "";
  state.focusId = "";
  state.parkOpen = false;
  state.stage = "plan";
  state.stageJustChanged = true;
  state.mobile = "list";
  if (samePark) {
    const valid = new Set((state.detail.trails || []).map((trail) => trail.id));
    state.selected = state.selected.filter((item) => valid.has(item.id));
    state.tripAirports = airports;
    touchPlan();
    touchWeather();
    paint();
    return;
  }
  state.detail = null;
  state.areaCatalog = null;
  state.areaStatus = "idle";
  state.legBook = {};
  state.tripAirports = airports;
  await loadPark(plan.parkCode, { keepPlan: true });
}

function savedTripsHtml() {
  const trips = loadSavedTrips();
  const selected = trips.find((trip) => trip.id === state.savedId) || trips[0] || null;
  const list = trips.length
    ? `<ul class="saved-list">${trips.map((trip) => `<li class="saved-row">
        <button class="saved-trip${selected?.id === trip.id ? " is-on" : ""}" type="button" data-action="open-saved" data-id="${esc(trip.id)}" aria-label="Open the ${esc(trip.parkName || "saved")} itinerary"><strong>${esc(trip.parkName || "Trip")}</strong><span>${esc(trip.summary || "")}</span></button>
        <div class="saved-actions">
          <button class="saved-action" type="button" data-action="pdf-saved" data-id="${esc(trip.id)}">Export as PDF</button>
          <button class="saved-action" type="button" data-action="email-saved" data-id="${esc(trip.id)}">Templated email</button>
          <button class="saved-action" type="button" data-action="delete-saved" data-id="${esc(trip.id)}">Remove</button>
        </div>
      </li>`).join("")}</ul>`
    : `<p class="lede">Save an itinerary from Itinerary. Nothing is stored yet.</p>`;
  const note = selected && (state.copyNotice || state.emailDraft) ? `<div class="saved-note">
      ${state.copyNotice ? `<p class="meta" role="status">${esc(state.copyNotice)}</p>` : ""}
      ${state.emailDraft ? `<label class="email-draft">Email text<textarea id="email-draft" readonly>${esc(state.emailDraft)}</textarea></label>` : ""}
    </div>` : "";
  return `<section class="card" id="saved-trips"><h2>Save Trips</h2><p class="lede">Open a saved trip to return to Itinerary with its settings. Export it as a PDF, or copy it as a templated email.</p>${list}${note}</section>`;
}

function snapshotPlain(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  return (doc.body?.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function itineraryPdfModel(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const sections = [...doc.querySelectorAll("section")].map((section) => {
    const heading = section.querySelector("h2")?.textContent?.trim() || "";
    const headers = [...section.querySelectorAll("th")].map((cell) => cell.textContent.trim());
    if (headers.length) {
      return {
        heading,
        paragraphs: [...section.querySelectorAll("p")].map((node) => node.textContent.trim()).filter(Boolean),
        table: {
          headers,
          rows: [...section.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent.trim())),
        },
      };
    }
    const columns = [...section.querySelectorAll("td")].filter((cell) => cell.querySelector("h3"));
    if (columns.length) {
      return {
        heading,
        paragraphs: [...section.children].filter((node) => node.tagName === "P").map((node) => node.textContent.trim()).filter(Boolean),
        cards: columns.flatMap((cell) => {
          const label = cell.querySelector("h3")?.textContent?.trim() || "";
          const items = [...cell.querySelectorAll("div")].filter((node) => node.querySelector(":scope > strong"));
          if (!items.length) return [{ title: label, body: cell.querySelector("p")?.textContent?.trim() || "" }];
          return items.map((item) => ({
            title: `${label}: ${item.querySelector("strong")?.textContent?.trim() || ""}`,
            body: [...item.querySelectorAll("div")].map((node) => node.textContent.trim()).filter(Boolean).join(" "),
          }));
        }),
      };
    }
    const weather = [...section.querySelectorAll("td")].filter((cell) => cell.querySelector("div"));
    if (weather.length) {
      return {
        heading,
        cards: weather.map((cell) => {
          const lines = [...cell.querySelectorAll("div")].map((node) => node.textContent.trim()).filter(Boolean);
          return { title: lines[0] || "", body: lines.slice(1).join(" · ") };
        }),
      };
    }
    return {
      heading,
      paragraphs: [...section.querySelectorAll("p, li")].map((node) => node.textContent.trim()).filter(Boolean),
    };
  });
  const root = doc.querySelector("body > div") || doc.body;
  const lead = [...(root?.children || [])].filter((node) => node.tagName === "P").map((node) => node.textContent.trim()).filter(Boolean);
  if (!sections.length) {
    return {
      kicker: "ParkPilot",
      title: (doc.querySelector("title")?.textContent || "Itinerary").replace(/ itinerary$/i, ""),
      subtitle: "",
      sections: [{ heading: "Itinerary", paragraphs: [doc.body?.innerText || ""].filter(Boolean) }],
      footer: "",
    };
  }
  return {
    kicker: lead[0] || "ParkPilot",
    title: doc.querySelector("h1")?.textContent?.trim() || "Itinerary",
    subtitle: doc.querySelector("h1")?.nextElementSibling?.textContent?.trim() || "",
    sections,
    footer: lead.length > 1 ? lead.at(-1) : "",
  };
}

function itineraryPdfName(model) {
  const source = (model.subtitle || model.title || "trip").split("·")[0].trim();
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "trip"}-itinerary.pdf`;
}

function exportPdf(html) {
  const model = itineraryPdfModel(html);
  const bytes = buildItineraryPdf(model);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = itineraryPdfName(model);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return link.download;
}

function copyTemplatedEmail(html) {
  const plain = snapshotPlain(html);
  const write = navigator.clipboard?.write && typeof ClipboardItem !== "undefined"
    ? navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    })])
    : navigator.clipboard.writeText(plain);
  write.then(() => {
    state.emailDraft = "";
    state.copyNotice = "Templated email copied. Paste it into Gmail or Docs.";
    paint();
  }).catch(() => {
    state.emailDraft = plain;
    state.copyNotice = "Copy was blocked. The email text is in the box below.";
    paint();
  });
}

function selectedAreaId() {
  const nights = stayNights(tripDates()).map((date) => state.lodgingNights[date]).filter(Boolean);
  if (!nights.length || nights.some((night) => night.property)) return "";
  const ids = nights.map((night) => night.area?.id).filter(Boolean);
  if (!ids.length || ids.some((id) => id !== ids[0])) return "";
  return ids[0];
}

function hasBase() {
  return Object.values(state.lodgingNights).some((night) => night?.area || night?.property);
}

function currentRanking() {
  const areas = state.areaCatalog?.areas || [];
  if (!areas.length || !state.origin || !state.detail?.point) return null;
  return recommendStays({
    startDate: state.startDate,
    dayCount: Number(state.dayCount) || 1,
    departTime: state.departTime,
    returnBy: state.returnBy,
    airport: state.airport,
    landingTime: state.landingTime,
    bufferMin: Number(state.bufferMin) || 0,
    roundTrip: state.roundTrip,
    sunsetByDate: sunsetMap(),
    origin: originPoint(),
    entrance: entrancePoint(),
    nights: stayNights(tripDates()),
    trails: selectedTrails().filter((trail) => trail.minutes != null).map((trail) => ({
      id: trail.id,
      name: trail.name,
      minutes: trail.minutes,
      miles: trail.miles,
      lat: trail.lat,
      lon: trail.lon,
      preferredDay: Number.isInteger(trail.preferredDay) ? trail.preferredDay : null,
    })),
    candidates: areas,
    legBook: state.legBook,
    maxDailyDriveMin: Number(state.maxDailyDriveMin) || LODGING_DEFAULTS.defaultMaxDailyDriveMinutes,
    remoteAccess: state.detail.remoteAccess || "",
  });
}

function syncProposal() {
  if (state.proposal?.kind === "manual" || state.proposal?.kind === "split") return;
  const ranking = currentRanking();
  const selected = selectedAreaId();
  const next = proposalFrom(ranking, selected);
  if (!next) {
    if (state.proposal?.kind === "ranking") state.proposal = null;
    return;
  }
  if (state.proposalDismissedFor === next.proposedId) return;
  state.proposal = next;
}

function entranceLeg(area) {
  const entrance = state.detail?.point;
  if (!area?.reference || !entrance || entrance.fallback) return { status: "unknown", miles: null, minutes: null };
  return resolveLeg(state.legBook, area.reference, entrance);
}

function straightMiles(from, to) {
  const lat1 = Number(from?.lat);
  const lon1 = Number(from?.lon);
  const lat2 = Number(to?.lat);
  const lon2 = Number(to?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const miles = 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(miles * 10) / 10;
}

function areaDistanceFields(area) {
  const entrance = state.detail?.point;
  const known = area.parkLeg?.status === "known" && area.parkLeg.miles != null;
  const straight = !known && entrance && !entrance.fallback && area.reference ? straightMiles(area.reference, entrance) : null;
  return {
    parkDistance: known ? `${area.parkLeg.miles} mi by road${area.parkLeg.minutes != null ? ` · ${hoursLabel(area.parkLeg.minutes)}` : ""}` : "",
    parkMiles: known ? area.parkLeg.miles : null,
    parkStraight: straight == null ? "" : `${straight} mi straight-line`,
  };
}

function townRegion(area) {
  const label = `${area.reference?.name || ""} ${area.name || ""}`;
  const match = label.match(/,\s*([A-Z]{2})\b/);
  if (match) return match[1];
  return String(state.detail?.states || "").split(",").filter(Boolean)[0] || "";
}

function longestTravelLabel(metrics) {
  const day = metrics?.longestDay;
  const minutes = day?.complete ? day.minutes : day?.knownMinutes;
  if (minutes == null) return "Longest driving day is not calculated.";
  const when = day.date ? readableDate(day.date) : "That day";
  const clock = hoursLabel(minutes);
  const tripEnd = (day.kinds || []).some((kind) => kind === "arrival" || kind === "departure");
  const incomplete = day.complete ? "" : " Another leg that day is still unknown, so this is not the full day.";
  if (tripEnd) return `${when} · ${clock} of known driving, including the trip to or from the park. This is arrival or departure travel, not a trail-day loop.${incomplete}`;
  return `${when} · ${clock} of driving between the base and the scheduled stops.${incomplete}`;
}

function travelImpactLabel(metrics) {
  if (!metrics?.complete) {
    return metrics?.knownMiles ? `Incomplete comparison. Known portion ${metrics.knownMiles} mi. Missing time is not zero.` : "This comparison is incomplete. Missing road time stays unknown.";
  }
  const activity = metrics.activityMinutes == null ? "Activity-day driving was not separated." : `Activity days ${hoursLabel(metrics.activityMinutes)}.`;
  const ends = hoursLabel((metrics.arrivalMinutes || 0) + (metrics.departureMinutes || 0));
  return `${metrics.totalMiles} mi · ${hoursLabel(metrics.totalMinutes)} total. ${activity} Arrival and departure ${ends}.`;
}

function whereToStayHtml() {
  if (!state.detail) return "";
  const needsPhoto = (state.areaCatalog?.areas || []).some((area) => !state.townProfiles[area.id]?.image && state.townProfiles[area.id]?.state !== "loading" && !state.townProfiles[area.id]?.tried);
  if (needsPhoto) loadTownProfiles();
  const nights = stayNights(tripDates());
  const ranking = state.lodgingMode === "help" ? currentRanking() : null;
  const catalogAreas = state.areaCatalog?.areas || [];
  const prepared = (ranking?.areas || catalogAreas.map((area) => ({
    ...area,
    metrics: { complete: false, knownMiles: 0, longestDay: {} },
    reason: "Distance to the entrance is not verified yet.",
    tradeoff: "Missing road time is not shown as zero.",
    conflicts: [],
    legs: [],
    provisional: selectedTrails().length === 0,
  }))).map((area) => ({ ...area, parkLeg: entranceLeg(area) }));
  const maxMiles = Number(state.maxStayMiles);
  const within = [];
  const beyond = [];
  const unverified = [];
  for (const area of prepared) {
    if (area.parkLeg?.status !== "known") unverified.push(area);
    else if (maxMiles > 0 && area.parkLeg.miles > maxMiles) beyond.push(area);
    else {
      if (/not verified|no verified/.test(area.reason || "")) area.reason = `${area.parkLeg.miles} miles by road from the town reference to the entrance.`;
      within.push(area);
    }
  }
  const rank = new Map((ranking?.areas || []).map((area, index) => [area.id, index]));
  const ordered = [...within, ...unverified].sort((a, b) => {
    if (!rank.size) return 0;
    return (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.name.localeCompare(b.name);
  });
  const picked = ordered.find((area) => area.id === selectedAreaId());
  const rest = ordered.filter((area) => area !== picked);
  const shownAreas = picked ? [picked, ...rest.slice(0, 2)] : rest.slice(0, 3);
  const outsideAreas = beyond
    .sort((a, b) => a.parkLeg.miles - b.parkLeg.miles || a.name.localeCompare(b.name))
    .slice(0, 2)
    .map((area) => ({ ...area, outside: true }));
  const defaults = ranking?.defaults || LODGING_DEFAULTS;
  const lookupText = {
    idle: "Search, then choose a match. The list can contain more than one place.",
    loading: "Looking up that place.",
    empty: "Nothing matched. Try a town, a property name, or a street. No route was guessed.",
    error: "The geocoder did not respond. The place stays unresolved.",
    ok: "Choose the match that is actually your stay.",
  }[state.lodgingLookup] || "";
  const areaMessage = {
    idle: "Looking up lodging areas.",
    loading: "Looking up lodging areas from the place catalog.",
    empty: state.areaCatalog?.reason || "No town reference came back.",
    error: state.areaCatalog?.reason || "The place catalog did not respond. No sample towns were substituted.",
    unavailable: state.areaCatalog?.reason || "Driving bases are not available for this park.",
    ok: "",
    fixture: "These are labeled development samples, not live catalog results.",
  }[state.areaStatus] || "";
  const proposal = state.proposal ? {
    summary: state.proposal.kind === "split"
      ? `Split the stay: ${state.proposal.proposedName}.`
      : `Use ${state.proposal.proposedName || state.proposal.area?.name} instead of the current base.`,
    before: measure(state.proposal.before, "Current plan"),
    after: measure(state.proposal.after, "Proposed plan"),
    nights: (state.proposal.affectedNights || state.proposal.dates || []).join(", ") || "None",
  } : null;
  return lodgingHtml({
    mode: state.lodgingMode,
    omitTripLength: true,
    editingNights: Boolean(state.openDetails.editNights),
    tripSpan: tripSummary(),
    maxMiles: state.maxStayMiles,
    maxHours: (Number(state.maxDailyDriveMin) || 180) / 60,
    dayCount: state.dayCount,
    groupSize: state.groupSize,
    accessNote: state.detail.remoteAccess || "",
    query: state.lodgingQuery,
    lookupText,
    hits: state.lodgingHits,
    choiceIndex: state.lodgingHits.findIndex((hit) => hit.label === state.lodgingChoice?.label),
    choiceLabel: state.lodgingChoice?.label || "",
    choiceAddress: state.lodgingChoice?.label || "",
    nights: nights.map((date) => {
      const night = state.lodgingNights[date];
      const status = nightStatus(night);
      const place = routingPlace(night);
      return {
        date,
        status,
        statusLabel: STATUS_LABEL[status],
        placeName: place ? `${place.name}${place.estimate === "property" ? " · exact property" : place.estimate === "area" ? " · town reference" : ""}` : "",
        picked: state.nightPick[date] !== false,
        locked: Boolean(night?.confirmed),
        confirmed: Boolean(night?.confirmed),
      };
    }),
    areaStatus: state.areaStatus,
    areaMessage,
    provisional: Boolean(ranking ? ranking.provisional : selectedTrails().length === 0 && state.lodgingMode === "help"),
    areas: [...shownAreas, ...outsideAreas].map((area) => ({
      id: area.id,
      outside: Boolean(area.outside),
      ...areaDistanceFields(area),
      focusId: `stay-${area.id}`,
      name: area.name,
      fixture: Boolean(area.fixture),
      provisional: Boolean(area.provisional),
      reason: area.reason,
      tradeoff: area.tradeoff,
      image: state.townProfiles[area.id]?.image || "",
      imageAlt: state.townProfiles[area.id]?.image ? `${area.name} photograph` : "",
      imageCredit: state.townProfiles[area.id]?.image ? (String(state.townProfiles[area.id]?.source || "").includes("Wikipedia") ? "Wikipedia" : "Photo credit not on this record") : "",
      complete: area.metrics?.complete === true,
      blurb: state.townProfiles[area.id]?.blurb || "",
      population: state.townProfiles[area.id]?.population ?? null,
      populationYear: state.townProfiles[area.id]?.populationYear ?? null,
      populationName: state.townProfiles[area.id]?.populationName || "",
      distanceLabel: (() => {
        if (area.parkLeg?.status === "known") return `${area.parkLeg.miles} mi · ${hoursLabel(area.parkLeg.minutes)} to the entrance`;
        const property = Object.values(state.lodgingNights).find((night) => night?.area?.id === area.id && night.property);
        if (property && lodgingActive()) {
          const drive = drivingNow();
          if (drive.complete) return `${drive.miles} mi · ${hoursLabel(drive.minutes)} using the property`;
          if (drive.knownMiles) return `Incomplete · known portion ${drive.knownMiles} mi using the property, not the trip total`;
          return "Incomplete · property routes are not verified";
        }
        if (area.metrics.complete) return `${area.metrics.totalMiles} mi · ${hoursLabel(area.metrics.totalMinutes)}`;
        if (area.metrics.knownMiles) return `Incomplete · known portion ${area.metrics.knownMiles} mi, not the trip total`;
        return "Distance to the entrance is not verified";
      })(),
      longestLabel: longestTravelLabel(area.metrics),
      travelImpact: travelImpactLabel(area.metrics),
      staySpan: stayDateLine(nights),
      entranceLabel: state.detail.point.fallback ? "No visitor-center entrance coordinate" : `Entrance: ${state.detail.point.name}`,
      estimate: (() => {
        const property = Object.values(state.lodgingNights).find((night) => night?.area?.id === area.id && night.property);
        if (property) return `Property coordinates: ${property.property.label}. The town reference was ${area.reference?.name || area.name}.`;
        return area.metrics.complete ? "Town reference, routes complete" : "Town reference, routes incomplete";
      })(),
      referenceName: area.reference?.name || area.name,
      source: area.source,
      fresh: fresh(area.retrievedAt),
      conflicts: area.conflicts?.find((conflict) => conflict.code === "long-drive")?.message || "",
      selected: selectedAreaId() === area.id,
      review: hasBase() && selectedAreaId() !== area.id,
      focused: state.focusId === `stay-${area.id}`,
      legs: (() => {
        const property = Object.values(state.lodgingNights).find((night) => night?.area?.id === area.id && night.property);
        return property && lodgingActive() ? (currentPlan().travel?.legs || area.legs) : area.legs;
      })(),
    })),
    split: ranking?.split ? {
      name: ranking.split.name,
      suggested: ranking.split.suggested,
      math: ranking.split.savingsMinutes == null
        ? "The driving comparison is incomplete, so the savings are unknown rather than zero."
        : `Driving changes by ${ranking.split.savingsMinutes} minutes before allowances. Allowances subtract ${ranking.split.allowanceMinutes} minutes. Net ${ranking.split.netMinutes} minutes. The suggestion threshold is ${ranking.split.thresholdMinutes} minutes.`,
      nights: ranking.split.assignments.map((assignment) => `${assignment.date} ${assignment.name}`).join("; "),
      legs: ranking.split.legs,
    } : null,
    proposal,
    defaults: {
      checkIn: defaults.splitStay.checkInMinutes,
      checkOut: defaults.splitStay.checkOutMinutes,
      relocation: defaults.splitStay.relocationAllowanceMinutes,
    },
    method: `Conflicts are checked first. Complete routes are then ordered by a score: total driving × ${defaults.weights.totalMinutes}, plus the longest day × ${defaults.weights.longestDayMinutes}, trail driving × ${defaults.weights.activityMinutes}, and arrival plus departure × ${defaults.weights.arrivalDepartureMinutes}. Each lodging change adds ${defaults.weights.changePenaltyMinutes} minutes to the score. Displayed miles are the unweighted sum. A split is suggested only when it saves at least ${defaults.splitStay.minimumSavingsMinutes} driving minutes after a ${defaults.splitStay.relocationAllowanceMinutes}-minute relocation, a ${defaults.splitStay.checkInMinutes}-minute check-in, and a ${defaults.splitStay.checkOutMinutes}-minute check-out. The daily driving limit is ${state.maxDailyDriveMin} minutes. Unknown legs are excluded from the score.`,
    legNote: state.legStatus === "loading" ? "Road legs are loading. Incomplete totals stay blank." : state.legStatus === "error" ? "The routing service did not respond. Missing legs stay unknown." : "Road legs come from the same driving request as the clock and the fuel line.",
    openDetails: state.openDetails,
  });
}

const STAGES = [
  { id: "park", label: "Discovery", icon: "discovery" },
  { id: "trails", label: "Select Trails", icon: "trails" },
  { id: "plan", label: "Itinerary", icon: "itinerary" },
  { id: "saved", label: "Save Trips", icon: "saved" },
];

function stageIcon(name) {
  const paths = {
    discovery: `<circle cx="12" cy="12" r="8.25"/><path d="m15.1 8.9-1.15 4.2-4.2 1.15 1.15-4.2z"/>`,
    trails: `<path d="M12 21V9.5"/><path d="M12 9.5H6.2L7.6 7 6.2 4.5H12"/><path d="M12 9.5h5.8L16.4 7l1.4-2.5H12"/>`,
    itinerary: `<rect x="4.5" y="5" width="15" height="14.5" rx="2"/><path d="M8 3.5v3M16 3.5v3M4.5 10h15"/>`,
    saved: `<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.5a1 1 0 0 1 1-1z"/>`,
  };
  return `<svg class="step-glyph" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
}

function itineraryReady() {
  return Boolean(state.detail) && (state.selected.length > 0 || hasBase() || state.tripAirports.length > 0);
}

function paneMode() {
  if (state.stage === "saved" || !state.detail) return "off";
  if (state.stage === "park" || state.stage === "trails") {
    if (state.parkMap) return "map";
    return itineraryReady() && state.itineraryOpen ? "itinerary" : "off";
  }
  return "map";
}

function mapReady() {
  return paneMode() === "map";
}

function stageReady(id) {
  if (id === "park" || id === "saved") return true;
  return Boolean(state.detail);
}

function goStage(id) {
  if (!stageReady(id)) return;
  if (state.stage === id) {
    if (id === "park" && state.parkOpen) {
      state.parkOpen = false;
      paint();
    }
    return;
  }
  state.parkOpen = false;
  state.stage = id;
  state.stageJustChanged = true;
  if (id === "park") state.mobile = "list";
  paint();
}

function adventureOpen() {
  if (state.openDetails.adventure == null) return window.matchMedia("(min-width: 721px)").matches;
  return state.openDetails.adventure !== false;
}

function adventureHtml() {
  const open = adventureOpen();
  const currentIndex = Math.max(0, STAGES.findIndex((stage) => stage.id === state.stage));
  const currentLabel = STAGES[currentIndex]?.label || "Discovery";
  return `<div class="nav-brand"><img class="nav-mark" src="/nps-arrowhead.png" alt="National Park Service arrowhead" /><span class="nav-brand-label">Park<span>Pilot</span></span></div>
    <p class="nav-kicker">Modules</p>
    <button id="adventure-toggle" class="nav-collapse" type="button" data-action="toggle-adventure" aria-expanded="${open}" aria-label="${open ? "Collapse panel" : "Expand panel"}">
      <span class="nav-collapse-icon" aria-hidden="true"></span>
      <span class="nav-collapse-label">Collapse panel</span>
    </button>
    <p class="nav-now">Now: ${esc(currentLabel)}</p>
    <ol class="adventure-steps">
      ${STAGES.map((stage, index) => {
        const ready = stageReady(stage.id);
        const here = state.stage === stage.id;
        const done = index < currentIndex && ready;
        return `<li>
          <button class="adventure-step${here ? " is-on" : ""}${done ? " is-done" : ""}" type="button" data-action="stage" data-stage="${stage.id}" ${ready ? "" : "disabled"} aria-current="${here ? "step" : "false"}" aria-label="${esc(stage.label)}">
            <span class="step-icon">${stageIcon(stage.icon)}</span><span class="step-label">${esc(stage.label)}</span>
          </button>
        </li>`;
      }).join("")}
    </ol>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateParts(iso) {
  const [year, month, day] = String(iso || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day, label: MONTHS[month - 1] };
}

function stayDateLine(nights) {
  if (!nights.length) return "This trip length has no overnight.";
  const start = dateParts(nights[0]);
  const end = dateParts(nights[nights.length - 1]);
  const count = `${nights.length} ${nights.length === 1 ? "night" : "nights"}`;
  if (!start || !end) return count;
  const sameDay = nights.length === 1 || nights[0] === nights[nights.length - 1];
  const range = sameDay
    ? `${start.label} ${start.day}`
    : start.month === end.month && start.year === end.year
      ? `${start.label} ${start.day}–${end.day}`
      : `${start.label} ${start.day}–${end.label} ${end.day}`;
  return `${range} · ${count}`;
}

function readableDate(iso) {
  const part = dateParts(iso);
  if (!part) return "Choose a date";
  return `${part.label} ${part.day}, ${part.year}`;
}

function tripSummary() {
  const dates = tripDates();
  const start = dateParts(dates[0]);
  const end = dateParts(dates[dates.length - 1]);
  if (!start || !end) return "Add a start date.";
  const count = dates.length;
  const unit = count === 1 ? "day" : "days";
  let range = `${start.label} ${start.day}`;
  if (count > 1 && start.year !== end.year) range = `${start.label} ${start.day}, ${start.year}–${end.label} ${end.day}, ${end.year}`;
  else if (count > 1 && start.month !== end.month) range = `${start.label} ${start.day}–${end.label} ${end.day}`;
  else if (count > 1) range = `${start.label} ${start.day}–${end.day}`;
  return `${range} · ${count} ${unit}`;
}

function optionalFilters() {
  const chips = [];
  if (state.stateFilter) chips.push({ kind: "state", value: state.stateFilter, label: state.stateFilter });
  for (const name of state.activityFilter) chips.push({ kind: "activity", value: name, label: name });
  for (const level of selectedLevels(state.difficulty)) chips.push({ kind: "level", value: level, label: `${difficultyLabel(level)} hikes` });
  return chips;
}

function filterBarHtml() {
  if (state.parksStatus !== "ok") return "";
  const states = [...new Set(state.parks.flatMap((park) => park.states.split(",").filter(Boolean)))].sort();
  const locationTerm = state.locationQuery.trim().toLowerCase();
  const locationChoices = states.filter((code) => code.toLowerCase().includes(locationTerm));
  const activities = [...new Set(state.parks.flatMap((park) => park.activities))].sort();
  const activityTerm = state.activityQuery.trim().toLowerCase();
  const activityChoices = activities.filter((name) => name.toLowerCase().includes(activityTerm));
  const activityLabel = state.activityFilter.length === 0 ? "Any activity" : state.activityFilter.length === 1 ? state.activityFilter[0] : `${state.activityFilter.length} activities`;
  const levels = [["easy", "Easy"], ["moderate", "Moderate"], ["strenuous", "Strenuous"]];
  const pickedLevels = selectedLevels(state.difficulty);
  const chips = optionalFilters();
  const days = Math.min(10, Math.max(1, Number(state.dayCount) || 1));
  return `<div class="filter-bar card">
    <div class="trip-toolbar">
      <label class="trip-field">Search Parks <input id="query" value="${esc(state.query)}" placeholder="Zion, Utah, Acadia" /></label>
      <div class="trip-field">
        <label for="startDate">Trip Start</label>
        <span class="date-control">
          <button class="date-face" type="button" data-action="open-calendar">${esc(readableDate(state.startDate))}</button>
          <input id="startDate" type="date" value="${esc(state.startDate)}" aria-label="Trip Start" />
        </span>
      </div>
      <div class="trip-field">
        <label for="dayCount">Duration</label>
        <div class="stepper">
          <button type="button" data-action="duration-step" data-step="-1" aria-label="Fewer days" ${days <= 1 ? "disabled" : ""}>−</button>
          <input id="dayCount" type="number" min="1" max="10" inputmode="numeric" value="${esc(days)}" aria-describedby="trip-summary" />
          <span class="stepper-unit">days</span>
          <button type="button" data-action="duration-step" data-step="1" aria-label="More days" ${days >= 10 ? "disabled" : ""}>+</button>
        </div>
      </div>
      <div class="trip-field activity-filter">
        <span class="filter-caption">Location</span>
        <details class="activity-menu" ${state.openDetails.location ? "open" : ""} data-keep="location">
          <summary>${esc(state.stateFilter || "All states")}</summary>
          <div class="activity-options">
            <input id="locationQuery" value="${esc(state.locationQuery)}" placeholder="Find a state" aria-label="Find a state" />
            <p class="meta">A park stays listed when it is in the state you choose.</p>
            <label class="check"><input type="radio" name="stateChoice" value="" ${state.stateFilter === "" ? "checked" : ""} /> All states</label>
            ${locationChoices.map((code) => `<label class="check"><input type="radio" name="stateChoice" value="${esc(code)}" ${state.stateFilter === code ? "checked" : ""} /> ${esc(code)}</label>`).join("") || `<p class="meta">No state matches that search.</p>`}
          </div>
        </details>
      </div>
      <div class="trip-field activity-filter">
        <span class="filter-caption">Activity</span>
        <details class="activity-menu" ${state.openDetails.activities ? "open" : ""} data-keep="activities">
          <summary>${esc(activityLabel)}</summary>
          <div class="activity-options">
            <input id="activityQuery" value="${esc(state.activityQuery)}" placeholder="Find an activity" aria-label="Find an activity" />
            <p class="meta">A park stays listed when it includes every activity you check.</p>
            ${activityChoices.map((name) => `<label class="check"><input type="checkbox" data-activity="${esc(name)}" ${state.activityFilter.includes(name) ? "checked" : ""} /> ${esc(name)}</label>`).join("") || `<p class="meta">No activity matches that search.</p>`}
          </div>
        </details>
      </div>
      <div class="trip-field activity-filter">
        <span class="filter-caption">Hiking Preference</span>
        <details class="activity-menu" ${state.openDetails.difficulty ? "open" : ""} data-keep="difficulty">
          <summary>${esc(difficultyLabel())}</summary>
          <div class="activity-options">
            <p class="meta">A park stays listed when it has a schedulable hike at any level you check. Until that level is known, the park stays listed.</p>
            ${levels.map(([value, label]) => `<label class="check"><input id="level-${value}" type="checkbox" data-level="${value}" ${pickedLevels.includes(value) ? "checked" : ""} /> <span class="badge ${value}">${esc(label)}</span></label>`).join("")}
          </div>
        </details>
      </div>
    </div>
    <div class="trip-toolbar trip-limits">
      <label class="trip-field">Group Size
        <input id="groupSize" type="number" min="1" max="12" value="${esc(state.groupSize)}" />
      </label>
      <label class="trip-field">Max drive to the park, miles
        <input id="maxStayMiles" type="number" min="5" max="400" step="5" value="${esc(state.maxStayMiles)}" />
      </label>
      <label class="trip-field">Max daily driving, hours
        <input id="maxDailyDrive" type="number" min="0.5" max="12" step="0.5" value="${esc((Number(state.maxDailyDriveMin) || 180) / 60)}" />
      </label>
    </div>
    <div class="trip-summary-row">
      <p id="trip-summary" class="trip-summary">${esc(tripSummary())}</p>
      <button class="filter-clear" type="button" data-action="clear-filters">Clear filters</button>
    </div>
    ${chips.length ? `<div class="filter-chips">
      ${chips.map((chip) => `<button class="filter-chip" type="button" data-action="remove-filter" data-kind="${esc(chip.kind)}" data-value="${esc(chip.value)}" aria-label="Remove ${esc(chip.label)}">${esc(chip.label)} <span aria-hidden="true">×</span></button>`).join("")}
    </div>` : ""}
  </div>`;
}

function needsParkHtml() {
  return `<section class="card"><h2>This step needs a park</h2><p class="lede">Go back to Discovery. This step stays blank until that record loads.</p></section>`;
}

function stageBody() {
  if (state.stage === "park") {
    const motion = state.parkJustOpened ? " is-entering" : "";
    const filters = filterBarHtml();
    const overlay = state.parkOpen
      ? `<button class="park-veil" type="button" data-action="close-park" aria-label="Close the park"></button><div class="park-overlay${motion}" role="dialog" aria-modal="true" aria-labelledby="park-overlay-title">${filters}${detailHtml()}</div>`
      : "";
    const covered = state.parkOpen ? " is-covered" : "";
    return `<div class="park-stage${covered}${motion}"><div class="park-under">${state.parkOpen ? "" : filters}${catalogHtml()}</div>${overlay}</div>`;
  }
  if (state.stage === "trails") {
    return state.detail ? `${filterBarHtml()}${weatherCardHtml()}${recommendationHtml(state.detail)}` : needsParkHtml();
  }
  if (state.stage === "plan") {
    if (state.detailStatus === "loading" && !state.detail) return `<section class="card"><h2>Itinerary</h2><p class="lede">Opening this saved trip.</p></section>`;
    const body = planHtml();
    return body ? `${settingsOutlineHtml()}${staySummaryCard()}${weatherCardHtml()}${body}${planMapCard()}${packingHtml()}` : needsParkHtml();
  }
  if (state.stage === "saved") return savedTripsHtml();
  return needsParkHtml();
}

function stageMoveHtml() {
  if (state.stage === "park" && state.parkOpen) return "";
  const index = Math.max(0, STAGES.findIndex((stage) => stage.id === state.stage));
  const prev = STAGES[index - 1];
  const next = STAGES[index + 1];
  const nextReady = next ? stageReady(next.id) : false;
  const blocked = state.detailStatus === "loading" ? "Waiting for the park record" : "Choose a park to continue";
  return `<div class="stage-move">
    ${prev ? `<button class="btn" type="button" data-action="stage" data-stage="${prev.id}">Back</button>` : `<span></span>`}
    ${next ? `<button class="btn primary" type="button" data-action="stage" data-stage="${next.id}" ${nextReady ? "" : "disabled"}>${nextReady ? `Continue to ${esc(next.label)}` : blocked}</button>` : ""}
  </div>`;
}

function sheetHtml() {
  const motion = state.stageJustChanged ? " is-entering" : "";
  return `<div class="stage-panel${motion}">${stageBody()}${stageMoveHtml()}</div>`;
}

function packDialogHtml() {
  return `<dialog id="pack-dialog" aria-labelledby="pack-dialog-title">
      <form>
        <h2 id="pack-dialog-title">Add a packing item</h2>
        <label>Item<input id="packItem" name="packItem" type="text" maxlength="80" placeholder="Type an item" autocomplete="off" /></label>
        <label>Category
          <select id="packGroup" name="packGroup">
            <option value="apparel">Apparel</option>
            <option value="consumable">Consumable</option>
            <option value="permit">Permits/Misc</option>
          </select>
        </label>
        <p id="pack-dialog-note" class="meta" role="status"></p>
        <div class="pack-actions">
          <button class="btn" type="button" data-action="cancel-pack">Cancel</button>
          <button class="btn primary" type="button" data-action="save-pack-item">Add to list</button>
        </div>
      </form>
    </dialog>`;
}

function ensurePackDialog() {
  const existing = document.getElementById("pack-dialog");
  if (!state.packComposer) {
    existing?.close();
    existing?.remove();
    return;
  }
  if (existing?.open) return;
  existing?.remove();
  document.body.insertAdjacentHTML("beforeend", packDialogHtml());
  const dialog = document.getElementById("pack-dialog");
  const field = document.getElementById("packItem");
  const group = document.getElementById("packGroup");
  const note = document.getElementById("pack-dialog-note");
  if (field) field.value = state.packDraft || "";
  if (group) group.value = ["apparel", "consumable", "permit"].includes(state.packDraftGroup) ? state.packDraftGroup : "permit";
  if (note) note.textContent = state.packNotice || "";
  dialog.showModal();
  field?.focus();
}

function commitPackItem(text, group) {
  const field = document.getElementById("packItem");
  const typed = String(text ?? field?.value ?? state.packDraft ?? "").trim();
  const picked = group || document.getElementById("packGroup")?.value || state.packDraftGroup || "permit";
  if (!typed) {
    state.packNotice = "Type an item, then add it to the list.";
    const note = document.getElementById("pack-dialog-note");
    if (note) note.textContent = state.packNotice;
    field?.focus();
    return;
  }
  state.packing.push({
    id: `custom-${Date.now()}`,
    group: ["apparel", "consumable", "permit"].includes(picked) ? picked : "permit",
    text: typed,
    reason: "Added by you.",
    source: "you",
    checked: false,
    custom: true,
    edited: true,
  });
  state.packComposer = false;
  state.packDraft = "";
  state.packDraftGroup = "permit";
  state.packNotice = "";
  paint();
}

function syncPacking() {
  const recommended = recommendPacking({ days: state.weather?.days || [], trails: selectedTrails() });
  const prior = new Map(state.packing.map((item) => [item.id, item]));
  const next = recommended.map((item) => {
    const old = prior.get(item.id);
    if (!old) return { ...item, checked: false, custom: false, edited: false };
    return { ...item, text: old.edited ? old.text : item.text, checked: old.checked, edited: old.edited, custom: false };
  });
  state.packing = [...next, ...state.packing.filter((item) => item.custom)];
}

function statsHtml() {
  const drive = drivingNow();
  const driveText = drive.complete ? `${drive.miles} driving mi` : drive.knownMiles ? `${drive.knownMiles} known driving mi, incomplete` : "Driving miles not calculated";
  const hikes = hikingMiles(selectedTrails());
  const hike = hikes.known ? `${hikes.miles} hiking mi` : "Hiking miles not stated";
  const extra = hikes.missing ? ` · ${hikes.missing} without a distance` : "";
  return `<span>${esc(driveText)}</span><span>${esc(hike)}${esc(extra)}</span>`;
}

let paintQueued = false;

function paint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paintNow();
  });
}

function paintNow() {
  const active = document.activeElement;
  const id = active?.id;
  const caret = active?.selectionStart;
  const y = window.scrollY;
  document.getElementById("adventure").innerHTML = adventureHtml();
  const intro = document.querySelector(".intro");
  if (intro) {
    const copy = {
      park: ["Discovery.", "Open a park for a short overview, then choose trails. A missing figure stays blank."],
      trails: ["Select Trails.", "Add hikes to the days you have. Missing distance or time stays unavailable."],
      plan: ["Itinerary.", "The drive, the stay, and the weather use the same dates."],
      saved: ["Save Trips.", "Open a saved trip to return to Itinerary with its settings."],
    }[state.stage] || ["Discovery.", "A missing figure stays blank."];
    intro.innerHTML = `<h1>${copy[0]}</h1><p>${copy[1]}</p>`;
  }
  restoreMapHome();
  document.getElementById("sheet").innerHTML = sheetHtml();
  document.getElementById("map-stats").innerHTML = statsHtml();
  placePlanMap();
  const pane = paneMode();
  document.body.dataset.mobile = state.mobile;
  document.body.dataset.stage = state.stage || "park";
  document.body.dataset.pane = pane;
  document.body.dataset.map = pane === "off" ? "off" : "on";
  const itinerary = document.getElementById("itinerary-pane");
  if (itinerary) itinerary.innerHTML = itineraryPaneHtml();
  const toggle = document.getElementById("itinerary-toggle");
  if (toggle) {
    const count = state.selected.length + state.tripAirports.length;
    toggle.hidden = !(["park", "trails"].includes(state.stage) && itineraryReady() && !state.itineraryOpen);
    toggle.setAttribute("aria-expanded", String(Boolean(state.itineraryOpen)));
    const countNode = toggle.querySelector(".itinerary-arrow-count");
    if (countNode) countNode.textContent = String(count);
  }
  document.body.classList.toggle("nav-collapsed", !adventureOpen());
  document.getElementById("mobile-list").setAttribute("aria-pressed", String(state.mobile === "list"));
  const mapButton = document.getElementById("mobile-map");
  mapButton.textContent = pane === "itinerary" ? "Itinerary" : "Map";
  mapButton.setAttribute("aria-pressed", String(state.mobile === "map"));
  if (id) {
    const next = document.getElementById(id);
    if (next) {
      next.focus();
      if (caret != null && next.setSelectionRange) next.setSelectionRange(caret, caret);
    }
  }
  if (state.parkJustOpened) {
    state.parkJustOpened = false;
    document.querySelector(".park-overlay")?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("close-park")?.focus();
  } else if (state.stageJustChanged) {
    state.stageJustChanged = false;
    document.querySelector(".stage-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    window.scrollTo(0, y);
  }
  if (state.scrollToStay) {
    state.scrollToStay = false;
    document.getElementById("stay-suggest")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const hideMap = document.getElementById("hide-park-map");
  if (hideMap) hideMap.hidden = !(["park", "trails"].includes(state.stage) && state.parkMap);
  if (state.scrollToPreview) {
    state.scrollToPreview = false;
    document.querySelector(".trail-detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  if (state.scrollToTrailMap) {
    state.scrollToTrailMap = false;
    document.getElementById("trail-path-map")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  if (state.scrollToItem && state.focusId) {
    const escape = CSS.escape(state.focusId);
    document.querySelector(`[data-action="focus"][data-id="${escape}"], [data-stay-card="${escape}"]`)?.scrollIntoView({ block: "center" });
    state.scrollToItem = false;
  }
  document.querySelectorAll("img").forEach((image) => {
    image.addEventListener("error", () => {
      const miss = document.createElement("div");
      miss.className = "photo-miss";
      miss.textContent = "Photo did not load";
      image.replaceWith(miss);
    }, { once: true });
  });
  document.querySelectorAll("details[data-keep]").forEach((details) => {
    details.addEventListener("toggle", () => {
      const key = details.dataset.keep;
      const menus = ["location", "activities", "difficulty"];
      if (details.open && menus.includes(key)) {
        const othersOpen = menus.some((name) => name !== key && state.openDetails[name]);
        for (const name of menus) state.openDetails[name] = name === key;
        if (othersOpen) paint();
        return;
      }
      state.openDetails[key] = details.open;
    });
  });
  if (mapReady()) syncMap();
  syncTrailMap();
  ensurePackDialog();
  save();
}

let trailMap = null;

function syncTrailMap() {
  const node = document.getElementById("trail-path-map");
  if (trailMap) {
    try { trailMap.remove(); } catch { /* The previous map node was already replaced. */ }
    trailMap = null;
  }
  if (!node) return;
  const trail = (state.detail?.trails || []).find((item) => item.id === state.trailMapId);
  const lat = Number(trail?.lat);
  const lon = Number(trail?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  trailMap = L.map(node, { scrollWheelZoom: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 16,
    attribution: "&copy; OpenStreetMap",
  }).addTo(trailMap);
  L.marker([lat, lon], { icon: pin("hike", "•", true) }).addTo(trailMap);
  trailMap.setView([lat, lon], 14);
  requestAnimationFrame(() => trailMap?.invalidateSize());
}

function restoreMapHome() {
  const home = document.querySelector(".map-pane");
  const stats = document.getElementById("map-stats");
  const mapNode = document.getElementById("map");
  const note = document.querySelector(".map-note");
  const hide = document.getElementById("hide-park-map");
  if (!home || !mapNode || !stats || !note || mapNode.parentElement === home) return;
  home.append(stats, mapNode, note);
  if (hide) home.append(hide);
}

function placePlanMap() {
  const home = document.querySelector(".map-pane");
  const stats = document.getElementById("map-stats");
  const mapNode = document.getElementById("map");
  const note = document.querySelector(".map-note");
  if (!home || !mapNode || !stats || !note) return;
  const slot = state.stage === "plan" ? document.getElementById("plan-map-slot") : null;
  if (!slot) return;
  slot.append(stats, mapNode, note);
  requestAnimationFrame(() => map?.invalidateSize());
}

function ensureMap() {
  if (map) return;
  map = L.map("map", { scrollWheelZoom: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 16,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
  map.setView([39.8, -98.6], 4);
}

function pin(kind, label, on) {
  return L.divIcon({
    className: "park-pin",
    html: `<span class="${kind}${on ? " on" : ""}">${label}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function syncMap() {
  ensureMap();
  mapLayer.clearLayers();
  const bounds = [];
  const add = (lat, lon, kind, label, id) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const marker = L.marker([lat, lon], { icon: pin(kind, label, state.focusId === id), keyboard: true }).addTo(mapLayer);
    marker.on("click", () => {
      state.focusId = id;
      state.scrollToItem = true;
      paint();
    });
    bounds.push([lat, lon]);
  };
  if (state.origin) add(state.origin.lat, state.origin.lon, "start", "A", "start");
  if (state.detail?.point && !state.detail.point.fallback) add(state.detail.point.lat, state.detail.point.lon, "gate", "P", "entrance");
  const staySeen = new Set();
  for (const place of Object.values(activeNightPlaces())) {
    if (staySeen.has(place.id)) continue;
    staySeen.add(place.id);
    add(place.lat, place.lon, "stay", "S", `stay-${place.id}`);
  }
  let geometry = [];
  const plan = lodgingActive() ? currentPlan() : null;
  if (plan?.travel?.legs) {
    for (const leg of plan.travel.legs) {
      if (leg.status !== "known" || leg.fromLat == null) continue;
      const record = state.legBook[legKey({ lat: leg.fromLat, lon: leg.fromLon }, { lat: leg.toLat, lon: leg.toLon })];
      if (!record?.geometry || record.geometry.length < 2) continue;
      const line = record.geometry.map(([lon, lat]) => [lat, lon]).filter((pair) => pair.every(Number.isFinite));
      if (line.length > 1) {
        L.polyline(line, { color: "#1E5346", weight: 4 }).addTo(mapLayer);
        geometry.push(line);
      }
    }
  } else if (state.route?.ok && Array.isArray(state.route.geometry) && state.route.geometry.length > 1) {
    geometry = state.route.geometry.map(([lon, lat]) => [lat, lon]).filter((pair) => pair.every(Number.isFinite));
    L.polyline(geometry, { color: "#1E5346", weight: 4 }).addTo(mapLayer);
  }
  const focusArea = (state.areaCatalog?.areas || []).find((area) => `stay-${area.id}` === state.focusId);
  const entrance = state.detail?.point;
  let stayFrame = null;
  let stayDistance = "";
  if (focusArea?.reference) {
    const from = [Number(focusArea.reference.lat), Number(focusArea.reference.lon)];
    add(from[0], from[1], "stay", "S", state.focusId);
    const record = entrance && !entrance.fallback ? state.legBook[legKey(focusArea.reference, entrance)] : null;
    const roadLine = record?.geometry?.length > 1
      ? record.geometry.map(([lon, lat]) => [lat, lon]).filter((pair) => pair.every(Number.isFinite))
      : [];
    const to = entrance && !entrance.fallback ? [Number(entrance.lat), Number(entrance.lon)] : null;
    if (roadLine.length > 1 && record?.miles != null) {
      const roadLabel = record.minutes == null ? `${record.miles} mi by road` : `${record.miles} mi · ${hoursLabel(record.minutes)} by road`;
      L.polyline(roadLine, { color: "#1E5346", weight: 4 }).bindTooltip(roadLabel, { permanent: true, direction: "center", className: "map-distance" }).addTo(mapLayer);
      bounds.push(...roadLine);
      stayFrame = from.every(Number.isFinite) && to?.every(Number.isFinite) ? [from, to] : roadLine;
      stayDistance = `${focusArea.name} to ${entrance.name}: ${roadLabel}.`;
    } else if (to && from.every(Number.isFinite) && to.every(Number.isFinite)) {
      const miles = record?.miles != null ? null : straightMiles(focusArea.reference, entrance);
      const label = record?.miles != null
        ? `${record.miles} mi by road. The road line was not returned.`
        : miles == null ? "Road miles are not verified." : `${miles} mi straight-line. Road miles are not verified.`;
      L.polyline([from, to], { color: "#ba7843", weight: 3, dashArray: "7 7" }).bindTooltip(label, { permanent: true, direction: "center", className: "map-distance" }).addTo(mapLayer);
      bounds.push(from, to);
      stayFrame = [from, to];
      stayDistance = `${focusArea.name} to ${entrance?.name || "the park"}: ${label}`;
    }
  }
  const note = document.querySelector(".map-note");
  if (note) {
    note.textContent = stayDistance
      ? `${stayDistance} Selecting this town does not reserve a stay.`
      : "The line is the driving route when a road path exists. A dashed line is the straight-line span when the road path is missing. S marks a lodging base. Numbered markers are trailheads with published coordinates. A hike is never drawn as a path.";
  }
  selectedTrails().forEach((trail, index) => add(trail.lat, trail.lon, "hike", String(index + 1), trail.id));
  const preview = state.detail?.trails?.find((trail) => trail.id === state.previewId);
  if (preview) add(preview.lat, preview.lon, "hike", "•", preview.id);
  const key = `${state.parkCode}|${state.origin?.label || ""}|${geometry.length}|${state.selected.map((item) => item.id).join(",")}|${state.previewId}|${state.focusId}|${Object.values(activeNightPlaces()).map((place) => place.id).join(",")}`;
  if (stayFrame && state.focusId !== lastFocus) {
    map.fitBounds(stayFrame, { padding: [48, 48], maxZoom: 11 });
    lastFocus = state.focusId;
    fitted = key;
  } else if (key !== fitted && bounds.length) {
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 12 });
    fitted = key;
  }
  if (!stayFrame && state.focusId && state.focusId !== lastFocus) {
    lastFocus = state.focusId;
    const stay = Object.values(activeNightPlaces()).find((place) => `stay-${place.id}` === state.focusId);
    const wanted = state.focusId === "start"
      ? state.origin
      : state.focusId === "entrance"
        ? state.detail?.point
        : stay || selectedTrails().find((trail) => trail.id === state.focusId) || preview;
    if (wanted && Number.isFinite(Number(wanted.lat)) && Number.isFinite(Number(wanted.lon))) map.panTo([Number(wanted.lat), Number(wanted.lon)], { animate: false });
  }
  requestAnimationFrame(() => map.invalidateSize());
}

async function loadParks() {
  try {
    const response = await fetch("/api/parks");
    if (!response.ok) throw new Error("parks");
    const body = await response.json();
    state.parks = body.parks || [];
    state.parksMeta = body;
    state.parksStatus = "ok";
  } catch {
    state.parksStatus = "error";
  }
  paint();
  if (selectedLevels(state.difficulty).length) loadHikeIndex();
  if (state.parkCode) loadPark(state.parkCode);
}

async function loadHikeIndex() {
  if (state.hikeIndexStatus === "loading" || state.hikeIndexStatus === "ok" || state.hikeIndexStatus === "limited" || !state.parks.length) return;
  state.hikeIndexStatus = "loading";
  const codes = state.parks.map((park) => park.code);
  const batches = [];
  for (let index = 0; index < codes.length; index += 3) batches.push(codes.slice(index, index + 3));
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor];
      cursor += 1;
      if (state.hikeIndexStatus === "limited") return;
      try {
        const response = await fetch(`/api/hike-levels?codes=${batch.join(",")}`);
        const body = await response.json();
        if (response.status === 429) {
          state.hikeIndexStatus = "limited";
          return;
        }
        if (!response.ok) throw new Error("levels");
        for (const [code, levels] of Object.entries(body.levels || {})) {
          if (levels == null && Array.isArray(state.hikeLevels[code])) continue;
          state.hikeLevels[code] = levels;
        }
      } catch {
        for (const code of batch) {
          if (state.hikeLevels[code] === undefined) state.hikeLevels[code] = null;
        }
      }
      if (selectedLevels(state.difficulty).length) paint();
    }
  };
  await Promise.all([worker(), worker()]);
  if (state.hikeIndexStatus === "limited") {
    paint();
    return;
  }
  state.hikeIndexStatus = Object.values(state.hikeLevels).some((levels) => levels == null) && state.parks.some((park) => state.hikeLevels[park.code] == null)
    ? "error"
    : "ok";
  paint();
}

async function loadFuel() {
  try {
    const response = await fetch("/api/fuel");
    if (!response.ok) throw new Error("fuel");
    state.fuelMeta = await response.json();
    state.fuelStatus = "ok";
    if (!state.priceTouched) state.price = state.fuelMeta.price;
  } catch {
    state.fuelStatus = "error";
  }
  paint();
}

function scheduleDetailRetry(code, seconds) {
  clearTimeout(detailRetryTimer);
  detailRetryTimer = setTimeout(() => {
    if (state.parkCode === code && state.detailStatus === "limited") loadPark(code);
  }, seconds * 1000);
}

async function loadPark(code, options = {}) {
  state.parkCode = code;
  state.catalogOpen = false;
  state.detailStatus = "loading";
  state.previewId = "";
  state.trailMapId = "";
  paint();
  try {
    const response = await fetch(`/api/parks/${code}`);
    if (state.parkCode !== code) return;
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      state.detail = null;
      state.detailStatus = "limited";
      const seconds = Math.max(1, Number(body.retryAfter) || 60);
      state.detailRetryAt = Date.now() + seconds * 1000;
      scheduleDetailRetry(code, seconds);
    } else if (!response.ok) {
      throw new Error("detail");
    } else {
    const detail = await response.json();
    if (state.parkCode !== code) return;
    const valid = new Set(detail.trails.map((trail) => trail.id));
    state.selected = state.selected.filter((item) => valid.has(item.id));
    state.detail = detail;
    state.detailStatus = "ok";
    state.hikeLevels[code] = schedulableLevels(detail.trails || []);
    state.route = null;
    state.weather = null;
    state.airports = null;
    state.airportStatus = "idle";
    if (!options.keepPlan) state.tripAirports = [];
    state.suggestion = null;
    state.suggestionStatus = "idle";
    state.townProfiles = {};
    loadAirports();
    state.lodgingMode = state.lodgingMode === "known" ? "known" : "help";
    if (needsStayAreas()) loadAreas(false);
    }
  } catch {
    state.detailStatus = "error";
    state.detail = null;
    state.catalogOpen = true;
  }
  paint();
  touchPlan();
  touchWeather();
}

async function runGeocode() {
  state.geocodeStatus = "loading";
  state.candidates = [];
  paint();
  try {
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(state.originQuery)}`);
    const body = await response.json();
    if (!response.ok) throw new Error("geo");
    state.candidates = body.results || [];
    state.geocodeStatus = state.candidates.length ? "ok" : "empty";
  } catch {
    state.geocodeStatus = "error";
  }
  paint();
}

function touchRoute() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(runRoute, 250);
}

function touchWeather() {
  clearTimeout(weatherTimer);
  weatherTimer = setTimeout(runWeather, 250);
}

function touchPlan() {
  if (state.detail && (lodgingActive() || state.areaCatalog?.areas?.length)) {
    if (state.origin) touchLegs();
    runProximity();
  }
  if (!lodgingActive()) touchRoute();
}

function proximityPairs() {
  const entrance = state.detail?.point;
  if (!entrance || entrance.fallback) return [];
  const pairs = [];
  const seen = new Set();
  const add = (from, to) => {
    const key = legKey(from, to);
    if (!key || seen.has(key)) return;
    seen.add(key);
    pairs.push({ key, from: { lat: Number(from.lat), lon: Number(from.lon) }, to: { lat: Number(to.lat), lon: Number(to.lon) } });
  };
  for (const area of state.areaCatalog?.areas || []) {
    if (area.reference) add(area.reference, entrance);
  }
  const base = Object.values(state.lodgingNights).map((night) => routingPlace(night)).find(Boolean);
  if (base) {
    add(base, entrance);
    add(entrance, base);
    for (const trail of selectedTrails()) {
      if (trail.lat != null && trail.lon != null) {
        add(base, trail);
        add(trail, base);
      }
    }
  }
  return pairs;
}

async function runProximity() {
  if (proximityBusy) return;
  const missing = proximityPairs().filter((pair) => pair.key && !(pair.key in state.legBook));
  if (!missing.length || !state.detail) return;
  proximityBusy = true;
  const token = ++proximityToken;
  try {
    const response = await fetch("/api/legs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairs: missing.slice(0, 40) }),
    });
    const body = await response.json();
    if (!response.ok || token !== proximityToken) return;
    for (const leg of body.legs || []) {
      if (leg?.key) state.legBook[leg.key] = leg;
    }
    paint();
  } catch {
    if (token !== proximityToken) return;
  } finally {
    proximityBusy = false;
  }
}

async function loadAirports() {
  if (!state.parkCode) return;
  const code = state.parkCode;
  state.airportStatus = "loading";
  paint();
  try {
    const response = await fetch(`/api/airports?parkCode=${code}`);
    const body = await response.json();
    if (state.parkCode !== code) return;
    state.airports = body;
    state.airportStatus = body.state || "error";
  } catch {
    if (state.parkCode !== code) return;
    state.airports = { airports: [], reason: "The airport catalog did not respond. No airport was guessed." };
    state.airportStatus = "error";
  }
  paint();
}

async function loadTownProfiles() {
  const areas = state.areaCatalog?.areas || [];
  await Promise.all(areas.map(async (area) => {
    const existing = state.townProfiles[area.id];
    if (existing?.image || existing?.state === "loading" || existing?.tried) return;
    state.townProfiles[area.id] = { state: "loading" };
    const region = townRegion(area);
    try {
      const response = await fetch(`/api/town?name=${encodeURIComponent(area.name)}&region=${encodeURIComponent(region)}`);
      const body = await response.json();
      state.townProfiles[area.id] = { ...body, tried: true };
    } catch {
      state.townProfiles[area.id] = { state: "empty", tried: true };
    }
    paint();
  }));
}

function touchLegs() {
  clearTimeout(legTimer);
  legTimer = setTimeout(runLegs, 250);
}

function basisPoints() {
  const bases = [];
  for (const area of state.areaCatalog?.areas || []) {
    if (Number.isFinite(Number(area.reference?.lat)) && Number.isFinite(Number(area.reference?.lon))) {
      bases.push({ id: area.id, name: area.name, lat: Number(area.reference.lat), lon: Number(area.reference.lon) });
    }
  }
  for (const place of Object.values(activeNightPlaces())) bases.push(place);
  return bases;
}

async function runLegs() {
  if (!state.origin || !state.detail?.point) {
    state.legStatus = "idle";
    syncProposal();
    paint();
    return;
  }
  const blocked = Boolean(state.detail.remoteAccess || state.detail.point.fallback);
  const pairs = lodgingPairs({
    origin: state.origin,
    entrance: blocked ? null : state.detail.point,
    trails: blocked ? [] : selectedTrails().filter((trail) => trail.lat != null && trail.lon != null),
    bases: basisPoints(),
  }).slice(0, 60);
  if (blocked) {
    for (const pair of pairs) {
      if (pair.key) state.legBook[pair.key] = { key: pair.key, status: "unknown", minutes: null, miles: null, geometry: [] };
    }
    state.legStatus = "unavailable";
    syncProposal();
    paint();
    return;
  }
  const missing = pairs.filter((pair) => pair.key && !(pair.key in state.legBook));
  if (!missing.length) {
    state.legStatus = "ok";
    syncProposal();
    paint();
    return;
  }
  const token = ++legToken;
  state.legStatus = "loading";
  paint();
  try {
    const response = await fetch("/api/legs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairs: missing }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error("legs");
    if (token !== legToken) return;
    for (const leg of body.legs || []) {
      if (leg?.key) state.legBook[leg.key] = leg;
    }
    state.legStatus = "ok";
  } catch {
    if (token !== legToken) return;
    state.legStatus = "error";
  }
  syncProposal();
  paint();
}

function needsStayAreas() {
  if (state.areaStatus === "loading") return false;
  if (state.areaStatus === "idle") return true;
  return (state.areaStatus === "error" || state.areaStatus === "empty") && !(state.areaCatalog?.areas || []).length;
}

async function loadAreas(fixture = false) {
  if (!state.parkCode) return;
  state.areaStatus = "loading";
  state.lodgingMode = "help";
  paint();
  try {
    const response = await fetch(`/api/lodging/areas?parkCode=${state.parkCode}${fixture ? "&fixture=1" : ""}`);
    const body = await response.json();
    state.areaCatalog = body;
    state.areaStatus = body.state || "error";
  } catch {
    state.areaCatalog = { state: "error", areas: [], reason: "The place catalog did not respond. No sample towns were substituted." };
    state.areaStatus = "error";
  }
  touchPlan();
  runProximity();
  loadTownProfiles();
}

function syncNightWindow() {
  const allowed = new Set(stayNights(tripDates()));
  const next = {};
  for (const [date, night] of Object.entries(state.lodgingNights || {})) {
    if (allowed.has(date)) next[date] = night;
  }
  state.lodgingNights = next;
}

function stageProposal(proposal) {
  state.proposal = proposal;
  state.proposalDismissedFor = "";
  paint();
}

async function runRoute() {
  if (!state.detail || !state.origin) return;
  const token = ++routeToken;
  state.route = null;
  state.routeStatus = "loading";
  paint();
  try {
    const response = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parkCode: state.parkCode,
        origin: state.origin,
        roundTrip: state.roundTrip,
        mpg: Number(state.mpg),
        pricePerGallon: Number(state.price),
        vias: selectedTrails().filter((trail) => trail.lat != null).map((trail) => ({ id: trail.id, name: trail.name, lat: trail.lat, lon: trail.lon })),
      }),
    });
    const body = await response.json();
    if (token !== routeToken) return;
    state.route = body;
    state.routeStatus = "done";
  } catch {
    if (token !== routeToken) return;
    state.route = { ok: false, reason: "The routing service did not respond. Miles and fuel stay blank." };
    state.routeStatus = "error";
  }
  paint();
}

async function runWeather() {
  if (!state.detail?.point || !tripDates().length) return;
  const token = ++weatherToken;
  state.weatherStatus = "loading";
  paint();
  try {
    const response = await fetch(`/api/weather?lat=${state.detail.point.lat}&lon=${state.detail.point.lon}&dates=${tripDates().join(",")}`);
    if (!response.ok) throw new Error("weather");
    const body = await response.json();
    if (token !== weatherToken) return;
    state.weather = body;
    state.weatherStatus = "ok";
  } catch {
    if (token !== weatherToken) return;
    state.weather = null;
    state.weatherStatus = "error";
  }
  paint();
}

function move(id, direction) {
  const index = state.selected.findIndex((item) => item.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= state.selected.length) return;
  const [item] = state.selected.splice(index, 1);
  state.selected.splice(next, 0, item);
  touchPlan();
}

function forgetSuggestion() {
  suggestToken += 1;
  state.suggestion = null;
  state.suggestionStatus = "idle";
}

async function suggestItinerary() {
  if (!state.detail) return;
  const token = ++suggestToken;
  const dates = tripDates();
  const wanted = selectedLevels(state.difficulty);
  const trails = recommendedHikes(state.detail.trails || [], state.difficulty)
    .sort((a, b) => {
      const score = (trail) => !wanted.length ? (trail.level === "unknown" ? 1 : 0) : wanted.includes(trail.level) ? 0 : 1;
      return score(a) - score(b);
    })
    .slice(0, 16)
    .map((trail) => ({
    id: trail.id,
    name: trail.name,
    level: trail.level,
    miles: trail.miles,
    duration: trail.duration || "",
    hours: trail.hours ?? null,
    permit: Boolean(trail.permit),
  }));
  state.suggestionStatus = "loading";
  paint();
  try {
    const response = await fetch("/api/itinerary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        park: state.detail.name,
        dates,
        difficulty: selectedLevels(state.difficulty).length ? selectedLevels(state.difficulty) : "all",
        activities: state.activityFilter,
        location: state.stateFilter,
        trails,
      }),
    });
    const body = await response.json();
    if (token !== suggestToken) return;
    state.suggestion = { ...body, parkCode: state.parkCode };
    state.suggestionStatus = response.ok ? "ok" : "error";
  } catch {
    if (token !== suggestToken) return;
    state.suggestion = { authored: false, days: [], parkCode: state.parkCode, reason: "The suggestion did not load.", retrievedAt: new Date().toISOString() };
    state.suggestionStatus = "error";
  }
  paint();
}

async function runLodgingSearch() {
  state.lodgingLookup = "loading";
  state.lodgingHits = [];
  state.lodgingChoice = null;
  paint();
  try {
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(state.lodgingQuery)}`);
    const body = await response.json();
    if (!response.ok) throw new Error("geo");
    state.lodgingHits = body.results || [];
    state.lodgingLookup = state.lodgingHits.length ? "ok" : "empty";
    state.lodgingSource = body.source || "OpenRouteService geocoder";
    state.lodgingRetrieved = body.retrievedAt || "";
  } catch {
    state.lodgingLookup = "error";
  }
  paint();
}

function chooseArea(area) {
  const dates = stayNights(tripDates()).filter((date) => !state.lodgingNights[date]?.confirmed);
  if (selectedAreaId() === area.id) return;
  if (!hasBase()) {
    state.lodgingNights = assignArea(state.lodgingNights, dates, area);
    state.proposal = null;
    touchPlan();
    runProximity();
    paint();
    return;
  }
  const preview = { ...activeNightPlaces() };
  for (const date of dates) {
    preview[date] = { id: area.id, name: area.name, lat: Number(area.reference.lat), lon: Number(area.reference.lon), role: "lodging" };
  }
  stageProposal({
    kind: "manual",
    proposedId: area.id,
    proposedName: area.name,
    area,
    dates,
    affectedNights: dates,
    before: currentPlan().travel || null,
    after: buildItinerary(planInput(preview)).travel,
  });
}

function chooseSplit() {
  const split = currentRanking()?.split;
  if (!split) return;
  const preview = {};
  for (const assignment of split.assignments) {
    if (state.lodgingNights[assignment.date]?.confirmed) {
      const kept = routingPlace(state.lodgingNights[assignment.date]);
      if (kept) preview[assignment.date] = kept;
    } else {
      preview[assignment.date] = {
        id: assignment.area.id,
        name: assignment.area.name,
        lat: Number(assignment.area.reference.lat),
        lon: Number(assignment.area.reference.lon),
        role: "lodging",
      };
    }
  }
  const afterInput = planInput(preview);
  afterInput.stay = { ...afterInput.stay, relocationMin: LODGING_DEFAULTS.splitStay.relocationAllowanceMinutes };
  stageProposal({
    kind: "split",
    proposedId: "split",
    proposedName: split.name,
    assignments: split.assignments,
    dates: split.assignments.map((assignment) => assignment.date),
    affectedNights: split.assignments.filter((assignment) => !state.lodgingNights[assignment.date]?.confirmed).map((assignment) => assignment.date),
    before: lodgingActive() ? currentPlan().travel : drivingNow(),
    after: buildItinerary(afterInput).travel,
  });
}

function handleLodgingAction(action, button) {
  if (action === "lodging-mode") {
    state.lodgingMode = button.dataset.mode || "";
    if (state.lodgingMode === "help" && !["ok", "fixture", "unavailable"].includes(state.areaStatus)) {
      loadAreas(false);
      return true;
    }
    paint();
    return true;
  }
  if (action === "lodging-search") {
    runLodgingSearch();
    return true;
  }
  if (action === "confirm-lodging") {
    state.lodgingChoice = state.lodgingHits[Number(button.dataset.index)] || null;
    paint();
    return true;
  }
  if (action === "assign-property") {
    const dates = stayNights(tripDates()).filter((date) => state.nightPick[date] !== false && !state.lodgingNights[date]?.confirmed);
    if (state.lodgingChoice && dates.length) {
      state.lodgingNights = assignProperty(state.lodgingNights, dates, {
        id: `property:${state.lodgingChoice.label}`,
        label: state.lodgingChoice.label,
        lat: state.lodgingChoice.lat,
        lon: state.lodgingChoice.lon,
        source: state.lodgingSource,
        retrievedAt: state.lodgingRetrieved,
      });
      state.proposal = null;
      touchPlan();
    } else paint();
    return true;
  }
  if (action === "clear-night") {
    const next = { ...state.lodgingNights };
    delete next[button.dataset.date];
    state.lodgingNights = next;
    state.proposal = null;
    touchPlan();
    return true;
  }
  if (action === "use-area") {
    const area = (state.areaCatalog?.areas || []).find((item) => item.id === button.dataset.id);
    if (area) chooseArea(area);
    else paint();
    return true;
  }
  if (action === "use-split") {
    chooseSplit();
    return true;
  }
  if (action === "accept-proposal") {
    if (state.proposal) state.lodgingNights = applyProposal(state.lodgingNights, state.proposal);
    state.proposal = null;
    state.proposalDismissedFor = "";
    touchPlan();
    return true;
  }
  if (action === "dismiss-proposal") {
    state.proposalDismissedFor = state.proposal?.proposedId || "";
    state.proposal = null;
    paint();
    return true;
  }
  if (action === "load-fixture") {
    loadAreas(true);
    return true;
  }
  return false;
}

function onClick(event) {
  const park = event.target.closest("[data-park]");
  if (park) {
    if (park.dataset.park !== state.parkCode) {
      state.selected = [];
      state.lodgingNights = {};
      state.areaCatalog = null;
      state.areaStatus = "idle";
      state.proposal = null;
      state.legBook = {};
      state.lodgingChoice = null;
      state.lodgingMode = "help";
      state.areaStatus = "idle";
      state.parkMap = false;
      state.airports = null;
      state.airportStatus = "idle";
      state.tripAirports = [];
      state.suggestion = null;
      state.townProfiles = {};
      state.openDetails["park-stay"] = false;
    }
    loadPark(park.dataset.park);
    state.stage = "park";
    state.parkOpen = true;
    state.parkJustOpened = true;
    state.lodgingMode = state.lodgingMode || "help";
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === "toggle-itinerary") {
    state.itineraryOpen = !state.itineraryOpen;
    if (window.matchMedia("(max-width: 980px)").matches) state.mobile = state.itineraryOpen ? "map" : "list";
    paint();
    return;
  }
  if (action === "toggle-adventure") {
    const open = !adventureOpen();
    state.openDetails.adventure = open;
    document.body.classList.toggle("nav-collapsed", !open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Collapse panel" : "Expand panel");
    return;
  }
  if (action === "reload-park") {
    loadPark(state.parkCode);
    return;
  }
  if (action === "close-park") {
    state.parkOpen = false;
    paint();
    return;
  }
  if (action === "stage") {
    goStage(button.dataset.stage);
    return;
  }
  if (action === "catalog") state.catalogOpen = true;
  if (action === "all-parks") state.showAllParks = true;
  if (action === "clear-filters") {
    state.query = "";
    state.stateFilter = "";
    state.activityFilter = [];
    state.activityQuery = "";
    state.locationQuery = "";
    state.difficulty = [];
    state.startDate = todayET(1);
    state.dayCount = 3;
    state.groupSize = 2;
    state.maxStayMiles = 60;
    state.maxDailyDriveMin = LODGING_DEFAULTS.defaultMaxDailyDriveMinutes;
    forgetSuggestion();
    syncNightWindow();
    touchWeather();
    touchPlan();
  }
  if (action === "add-airport" || action === "remove-airport") {
    const airport = action === "remove-airport"
      ? state.tripAirports.find((item) => item.iata === button.dataset.iata)
      : state.airports?.airports?.[Number(button.dataset.index)];
    if (airport) {
      const iata = airport.iata;
      const exists = state.tripAirports.some((item) => item.iata === iata);
      state.tripAirports = exists
        ? state.tripAirports.filter((item) => item.iata !== iata)
        : [...state.tripAirports, { iata, name: airport.name, label: airport.label || `${airport.name} (${iata})`, lat: airport.lat, lon: airport.lon }];
    }
  }
  if (action === "apply-suggestion" && state.suggestion?.parkCode === state.parkCode) {
    const dates = tripDates();
    for (const day of state.suggestion.days || []) {
      const preferredDay = dates.indexOf(day.date);
      for (const trailId of day.trailIds || []) {
        const item = state.selected.find((entry) => entry.id === trailId);
        if (item) item.preferredDay = preferredDay >= 0 ? preferredDay : null;
        else state.selected.push({ id: trailId, preferredDay: preferredDay >= 0 ? preferredDay : null });
      }
    }
    touchPlan();
    runProximity();
  }
  if (action === "suggest-itinerary") {
    suggestItinerary();
    return;
  }
  if (action === "toggle-more-filters") {
    state.openDetails.moreFilters = !state.openDetails.moreFilters;
    paint();
    return;
  }
  if (action === "remove-filter") {
    if (button.dataset.kind === "state") state.stateFilter = "";
    if (button.dataset.kind === "activity") state.activityFilter = state.activityFilter.filter((name) => name !== button.dataset.value);
    if (button.dataset.kind === "level") state.difficulty = selectedLevels(state.difficulty).filter((level) => level !== button.dataset.value);
  }
  if (action === "duration-step") {
    const current = Math.min(10, Math.max(1, Number(state.dayCount) || 1));
    const next = Math.min(10, Math.max(1, current + Number(button.dataset.step || 0)));
    if (next !== current) {
      state.dayCount = next;
      forgetSuggestion();
      syncNightWindow();
      touchWeather();
      touchPlan();
    }
    paint();
    return;
  }
  if (action === "approve-matching") {
    for (const trail of recommendedHikes(state.detail?.trails || [], state.difficulty)) {
      if (!state.selected.some((item) => item.id === trail.id)) state.selected.push({ id: trail.id, preferredDay: null });
    }
    state.scrollToStay = true;
    touchPlan();
    runProximity();
    paint();
    return;
  }
  if (action === "go-stay" || action === "open-stay") {
    state.stage = "park";
    state.parkOpen = true;
    state.openDetails["park-stay"] = true;
    state.parkJustOpened = true;
    if (needsStayAreas()) loadAreas(false);
    else loadTownProfiles();
    paint();
    return;
  }
  if (action === "open-calendar") {
    const input = document.getElementById("startDate");
    if (typeof input?.showPicker === "function") input.showPicker();
    else input?.focus();
    return;
  }
  if (action === "toggle-edit-nights") {
    state.openDetails.editNights = !state.openDetails.editNights;
    paint();
    return;
  }
  if (action === "hide-park-map") {
    state.parkMap = false;
    if (window.matchMedia("(max-width: 980px)").matches) state.mobile = "list";
    paint();
    return;
  }
  if (action === "use-airport") {
    const airport = state.airports?.airports?.[Number(button.dataset.index)];
    if (airport) {
      state.origin = { label: `${airport.name} (${airport.iata})`, lat: airport.lat, lon: airport.lon, layer: "airport" };
      state.originQuery = state.origin.label;
      state.airport = true;
      touchPlan();
    }
  }
  if (action === "geocode") runGeocode();
  if (action === "confirm-origin") {
    state.origin = state.candidates[Number(button.dataset.index)];
    touchPlan();
  }
  if (action === "others") state.showOthers = !state.showOthers;
  if (action === "preview") {
    const opening = state.previewId !== id;
    state.previewId = opening ? id : "";
    state.trailMapId = "";
    if (opening) {
      state.focusId = id;
      state.scrollToPreview = true;
    }
  }
  if (action === "show-trail-map") {
    state.previewId = id;
    state.trailMapId = state.trailMapId === id ? "" : id;
    state.focusId = id;
    if (state.trailMapId) state.scrollToTrailMap = true;
  }
  if (action === "close-preview") {
    state.previewId = "";
    state.trailMapId = "";
  }
  if (action === "add" && !state.selected.some((item) => item.id === id)) state.selected.push({ id, preferredDay: suggestDay() });
  if (action === "remove") state.selected = state.selected.filter((item) => item.id !== id);
  if (action === "add" || action === "remove") {
    if (action === "add") state.scrollToStay = true;
    touchPlan();
    runProximity();
  }
  if (action === "up") move(id, -1);
  if (action === "down") move(id, 1);
  if (action === "clear-itinerary") {
    state.selected = [];
    state.tripAirports = [];
    state.lodgingNights = {};
    state.proposal = null;
    state.suggestion = null;
    if (String(state.focusId || "").startsWith("stay-")) state.focusId = "";
    touchPlan();
  }
  if (action === "focus") state.focusId = id;
  if (action === "focus-stay") {
    state.focusId = id;
    state.parkMap = true;
    state.scrollToItem = true;
    if (window.matchMedia("(max-width: 980px)").matches) state.mobile = "map";
  }
  if (handleLodgingAction(action, button)) return;
  if (action === "add-pack") {
    state.packComposer = true;
    state.packDraft = "";
    state.packDraftGroup = "permit";
    state.packNotice = "";
    paint();
    return;
  }
  if (action === "cancel-pack") {
    state.packComposer = false;
    state.packDraft = "";
    state.packDraftGroup = "permit";
    state.packNotice = "";
  }
  if (action === "drop-pack") state.packing = state.packing.filter((item) => item.id !== id);
  if (action === "toggle-pack") {
    const item = state.packing.find((entry) => entry.id === id);
    if (item) item.checked = !item.checked;
  }
  if (action === "save-trip") {
    saveCurrentTrip();
    paint();
    return;
  }
  if (action === "open-saved") {
    openSavedTrip(id);
    return;
  }
  if (action === "delete-saved") {
    const next = loadSavedTrips().filter((trip) => trip.id !== id);
    storeSavedTrips(next);
    if (state.savedId === id) state.savedId = next[0]?.id || "";
    state.copyNotice = "";
    state.emailDraft = "";
  }
  if (action === "pdf-saved" || action === "email-saved") {
    const trip = loadSavedTrips().find((item) => item.id === id);
    if (!trip) return;
    if (action === "pdf-saved") {
      try {
        exportPdf(trip.html);
        state.copyNotice = "Itinerary PDF downloaded.";
      } catch {
        state.copyNotice = "The PDF could not be created.";
      }
      paintNow();
      return;
    }
    copyTemplatedEmail(trip.html);
    return;
  }
  paint();
}

function onInput(event) {
  const field = event.target;
  if (field.closest?.("#pack-dialog")) return;
  if (field.id === "query") state.query = field.value;
  if (field.id === "activityQuery") state.activityQuery = field.value;
  if (field.id === "locationQuery") state.locationQuery = field.value;
  if (field.id === "originQuery") state.originQuery = field.value;
  if (field.id === "mpg") state.mpg = field.value;
  if (field.id === "price") {
    state.price = field.value;
    state.priceTouched = true;
  }
  if (field.id === "bufferMin") state.bufferMin = field.value;
  if (field.id === "groupSize") state.groupSize = field.value;
  if (field.id === "dayCount") state.dayCount = field.value;
  if (field.id === "lodgingQuery") state.lodgingQuery = field.value;
  if (field.id === "maxStayMiles") {
    const miles = Number(field.value);
    if (miles > 0) state.maxStayMiles = miles;
  }
  if (field.id === "maxDailyDrive") {
    const hours = Number(field.value);
    if (hours > 0) state.maxDailyDriveMin = Math.round(hours * 60);
  }
  const packText = field.dataset.packText;
  if (packText) {
    const item = state.packing.find((entry) => entry.id === packText);
    if (item) {
      item.text = field.value;
      item.edited = true;
    }
  }
  if (["query", "activityQuery", "locationQuery", "originQuery", "mpg", "price", "bufferMin", "groupSize", "dayCount", "lodgingQuery", "maxDailyDrive", "maxStayMiles"].includes(field.id) || packText) paint();
  if (field.id === "dayCount") {
    forgetSuggestion();
    syncNightWindow();
    touchWeather();
    touchPlan();
  }
}

function onChange(event) {
  const field = event.target;
  if (field.closest?.("#pack-dialog")) return;
  if (field.name === "stateChoice") {
    state.stateFilter = field.value;
    state.openDetails.location = false;
  }
  if (field.dataset.activity) {
    const name = field.dataset.activity;
    const selected = new Set(state.activityFilter);
    if (field.checked) selected.add(name);
    else selected.delete(name);
    state.activityFilter = [...selected];
    forgetSuggestion();
  }
  if (field.id === "airport") state.airport = field.checked;
  if (field.id === "roundTrip") {
    state.roundTrip = field.checked;
    touchPlan();
  }
  if (field.id === "landingTime") state.landingTime = field.value;
  if (field.id === "departTime") state.departTime = field.value;
  if (field.id === "returnBy") state.returnBy = field.value;
  if (field.id === "startDate") {
    state.startDate = field.value;
    forgetSuggestion();
    syncNightWindow();
    touchWeather();
    touchPlan();
  }
  if (field.dataset.level) {
    const level = field.dataset.level;
    const picked = new Set(selectedLevels(state.difficulty));
    if (field.checked) picked.add(level);
    else picked.delete(level);
    state.difficulty = [...picked];
    forgetSuggestion();
    if (state.difficulty.length && state.hikeIndexStatus !== "loading" && state.hikeIndexStatus !== "ok") loadHikeIndex();
  }
  if (field.dataset.day) {
    const item = state.selected.find((entry) => entry.id === field.dataset.day);
    if (item) item.preferredDay = field.value === "" ? null : Number(field.value);
  }
  if (field.dataset.pack) {
    const item = state.packing.find((entry) => entry.id === field.dataset.pack);
    if (item) item.checked = field.checked;
  }
  if (field.dataset.night) state.nightPick[field.dataset.night] = field.checked;
  if (field.dataset.confirmNight) {
    state.lodgingNights = confirmBooking(state.lodgingNights, field.dataset.confirmNight, field.checked);
  }
  paint();
}

function boot() {
  restore();
  document.body.dataset.stage = state.stage || "park";
  document.body.dataset.pane = paneMode();
  document.body.dataset.map = paneMode() === "off" ? "off" : "on";
  document.body.classList.toggle("nav-collapsed", !adventureOpen());
  document.querySelector("#app").innerHTML = `
    <aside id="adventure" class="app-nav" aria-label="Trip modules"></aside>
    <div class="app-main">
      <section class="intro wrap">
        <h1>Choose your adventure.</h1>
        <p>Pick the park and the activities, carry the stay into the drive, then read the days against the weather. A missing figure stays blank.</p>
      </section>
      <div class="workspace wrap">
        <div id="sheet" class="sheet"></div>
        <aside class="map-pane">
          <div id="map-stats" class="map-stats"></div>
          <div id="map"></div>
          <p class="map-note">The line is the driving route when a road path exists. S marks a lodging base. Numbered markers are trailheads with published coordinates. A hike is never drawn as a path.</p>
          <button id="hide-park-map" class="btn quiet" type="button" data-action="hide-park-map" hidden>Hide map</button>
        </aside>
        <aside id="itinerary-pane" class="itinerary-pane" aria-label="Itinerary"></aside>
        <button id="itinerary-toggle" class="itinerary-arrow" type="button" data-action="toggle-itinerary" hidden aria-expanded="false" aria-controls="itinerary-pane">
          <span class="itinerary-arrow-mark" aria-hidden="true"></span>
          <span class="itinerary-arrow-count">0</span>
          <span class="itinerary-arrow-label">Itinerary</span>
        </button>
      </div>
      <div class="mobile-switch wrap">
        <button class="btn" id="mobile-list" type="button">List</button>
        <button class="btn" id="mobile-map" type="button">Map</button>
      </div>
      <footer class="wrap"><p>NPS records, OpenRouteService roads and place search, Open-Meteo, and EIA gasoline stay on the server with your keys. OpenStreetMap draws the base map. Lodging areas are towns from that place catalog, not prices or vacancies. A labeled development fixture loads only when you ask for it and the server allows it.</p></footer>
    </div>`;
  document.getElementById("adventure").addEventListener("click", onClick);
  document.getElementById("sheet").addEventListener("click", onClick);
  document.getElementById("itinerary-pane").addEventListener("click", onClick);
  document.querySelector(".map-pane").addEventListener("click", onClick);
  document.getElementById("itinerary-toggle").addEventListener("click", onClick);
  document.addEventListener("input", (event) => {
    if (event.target?.id === "packItem") state.packDraft = event.target.value;
  }, true);
  document.addEventListener("change", (event) => {
    if (event.target?.id === "packGroup") state.packDraftGroup = event.target.value;
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target?.id !== "packItem") return;
    event.preventDefault();
    commitPackItem();
  }, true);
  document.addEventListener("click", (event) => {
    const packAction = event.target.closest?.("#pack-dialog [data-action]")?.dataset.action;
    if (packAction !== "save-pack-item" && packAction !== "cancel-pack") return;
    event.preventDefault();
    event.stopPropagation();
    if (packAction === "cancel-pack") {
      state.packComposer = false;
      state.packDraft = "";
      state.packDraftGroup = "permit";
      state.packNotice = "";
      paint();
      return;
    }
    commitPackItem();
  }, true);
  document.getElementById("sheet").addEventListener("input", onInput);
  document.getElementById("sheet").addEventListener("change", onChange);
  document.getElementById("mobile-list").addEventListener("click", () => { state.mobile = "list"; paint(); });
  document.getElementById("mobile-map").addEventListener("click", () => { state.mobile = "map"; paint(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.stage === "park" && state.parkOpen) {
      state.parkOpen = false;
      paint();
    }
  });
  paint();
  loadParks();
  loadFuel();
}

boot();
