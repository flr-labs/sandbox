import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { remoteAccessNote } from "../lib/access.mjs";
import { fuelCost, numbersAreGrounded } from "../lib/fuel.mjs";
import { legKey } from "../lib/legs.mjs";
import { areasFromCatalog } from "../lib/lodging.mjs";
import { fixtureAreas } from "../lib/lodging-fixture.mjs";
import { schedulableLevels } from "../lib/choices.mjs";
import { acceptSuggestion, fallbackDays } from "../lib/itinerary.mjs";
import { parseActivity, stripHtml } from "../lib/parse.mjs";

const envPath = fileURLToPath(new URL("../../.env.local", import.meta.url));
let envText = "";
try {
  envText = readFileSync(envPath, "utf8");
} catch {
  envText = "";
}
const env = Object.fromEntries(
  envText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const HOST_KEYS = [
  "NPS_API_KEY",
  "OPENAI_API_KEY",
  "NWS_USER_AGENT",
  "SERPAPI_API_KEY",
  "UDOT_API_KEY",
  "OPENROUTESERVICE_API_KEY",
  "EIA_API_KEY",
  "PARKPILOT_LODGING_FIXTURE",
];
for (const key of HOST_KEYS) {
  if (process.env[key]) env[key] = process.env[key];
}

const cache = new Map();
const SKY = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Drizzle",
  61: "Rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Showers",
  81: "Showers",
  82: "Heavy showers",
  95: "Thunderstorm",
};

function now() {
  return new Date().toISOString();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function getJson(url, headers = {}, ms = 25000) {
  const response = await fetch(url, { headers: { "User-Agent": env["NWS_USER_AGENT"], Accept: "application/json", ...headers }, signal: AbortSignal.timeout(ms) });
  if (!response.ok) {
    const error = new Error(`status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

let npsPausedUntil = 0;

function readDisk(name) {
  try {
    return JSON.parse(readFileSync(new URL(`../.cache/${name}.json`, import.meta.url), "utf8"));
  } catch {
    return null;
  }
}

function writeDisk(name, value) {
  try {
    const dir = fileURLToPath(new URL("../.cache/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`../.cache/${name}.json`, import.meta.url), JSON.stringify(value));
  } catch {
    // Hosted runtimes cannot always write next to the app. The in-memory cache still holds this response.
  }
}

function rateLimit(retryAfter) {
  const error = new Error("nps rate limit");
  error.status = 429;
  error.retryAfter = retryAfter;
  return error;
}

async function nps(path) {
  const wait = npsPausedUntil - Date.now();
  if (wait > 0) throw rateLimit(Math.ceil(wait / 1000));
  const response = await fetch(`https://developer.nps.gov/api/v1${path}`, {
    headers: { "User-Agent": env["NWS_USER_AGENT"], Accept: "application/json", "X-Api-Key": env["NPS_API_KEY"] },
    signal: AbortSignal.timeout(25000),
  });
  if (response.status === 429) {
    const retryAfter = Math.max(1, Number(response.headers.get("retry-after")) || 60);
    npsPausedUntil = Date.now() + retryAfter * 1000;
    throw rateLimit(retryAfter);
  }
  if (!response.ok) {
    const error = new Error(`status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function moneyFee(park) {
  const fees = park.entranceFees || [];
  const vehicle = fees.find((fee) => /private vehicle/i.test(fee.title || fee.entranceFeeType || ""));
  return vehicle ? Number(vehicle.cost) : null;
}

function card(park) {
  const image = (park.images || [])[0] || {};
  return {
    code: park.parkCode,
    name: park.fullName,
    states: park.states || "",
    designation: park.designation || "",
    activities: (park.activities || []).map((activity) => activity.name).filter(Boolean),
    image: image.url || "",
    imageCredit: image.credit || "",
    imageAlt: image.altText || park.fullName,
    fee: moneyFee(park),
    remoteAccess: remoteAccessNote(park.parkCode),
  };
}

function isNationalPark(park) {
  const designation = park.designation || "";
  return designation === "National Park" || designation.startsWith("National Park ") || designation.startsWith("National Park&");
}

export async function nationalParks() {
  if (cache.has("parks")) return cache.get("parks");
  try {
    const parks = [];
    for (let start = 0; start < 650; start += 50) {
      const page = await nps(`/parks?limit=50&start=${start}`);
      const rows = page.data || [];
      parks.push(...rows.filter(isNationalPark).map(card));
      if (rows.length < 50) break;
    }
    parks.sort((a, b) => a.name.localeCompare(b.name));
    const payload = { retrievedAt: now(), source: "NPS park list", parks };
    cache.set("parks", payload);
    writeDisk("parks", payload);
    return payload;
  } catch (error) {
    const stored = readDisk("parks");
    if (error.status === 429 && stored?.parks?.length) {
      cache.set("parks", stored);
      return stored;
    }
    throw error;
  }
}

async function levelsForPark(code) {
  const detail = cache.get(`park:${code}`);
  if (detail?.trails) return schedulableLevels(detail.trails);
  if (cache.has(`hikes:${code}`)) return cache.get(`hikes:${code}`);
  const levels = new Set();
  let total = Infinity;
  for (let start = 0; start < 200 && start < total; start += 50) {
    const page = await nps(`/thingstodo?parkCode=${code}&limit=50&start=${start}`);
    total = Number(page.total || 0);
    const batch = page.data || [];
    for (const trail of batch.map(parseActivity)) {
      if (trail.schedulable) levels.add(trail.level);
    }
    if (!batch.length || levels.size === 3) break;
  }
  const list = [...levels].sort();
  cache.set(`hikes:${code}`, list);
  return list;
}

export async function hikeLevelsFor(codes) {
  if (Date.now() < npsPausedUntil) throw rateLimit(Math.ceil((npsPausedUntil - Date.now()) / 1000));
  const levels = {};
  await Promise.all(codes.map(async (code) => {
    try {
      levels[code] = await levelsForPark(code);
    } catch (error) {
      if (error.status === 429) throw error;
      levels[code] = null;
    }
  }));
  return { retrievedAt: now(), source: "NPS things to do", levels };
}

async function activitiesFor(code) {
  const rows = [];
  let total = 0;
  for (let start = 0; start < 200; start += 50) {
    const page = await nps(`/thingstodo?parkCode=${code}&limit=50&start=${start}`);
    total = Number(page.total || total);
    const batch = page.data || [];
    rows.push(...batch);
    if (!batch.length || rows.length >= total) break;
  }
  return { rows, total };
}

export async function parkDetail(code) {
  if (!/^[a-z]{4}$/.test(code)) throw new Error("bad park");
  const key = `park:${code}`;
  if (cache.has(key)) return cache.get(key);
  const stored = readDisk(`park-${code}`);
  if (Date.now() < npsPausedUntil && stored?.trails) {
    cache.set(key, stored);
    return stored;
  }
  try {
  const [parkPage, centers, things, alerts] = await Promise.all([
    nps(`/parks?parkCode=${code}&limit=1`),
    nps(`/visitorcenters?parkCode=${code}&limit=20`),
    activitiesFor(code),
    nps(`/alerts?parkCode=${code}&limit=20`).catch(() => null),
  ]);
  const park = (parkPage.data || [])[0];
  if (!park) {
    const error = new Error("missing park");
    error.status = 404;
    throw error;
  }
  const places = centers.data || [];
  const center = places.find((item) => /visitor center/i.test(item.name || "") && item.latitude) || places.find((item) => item.latitude) || null;
  const trails = things.rows.map(parseActivity).filter((trail) => trail.hikeNamed);
  const alertRows = alerts
    ? (alerts.data || []).map((alert) => ({
      id: alert.id,
      title: alert.title,
      category: alert.category,
      description: stripHtml(alert.description || "").slice(0, 320),
      url: alert.url || "",
    }))
    : null;
  const detail = {
    ...card(park),
    retrievedAt: now(),
    source: "NPS parks, visitor centers, things to do, and alerts",
    description: stripHtml(park.description || ""),
    directions: stripHtml(park.directionsInfo || ""),
    weatherInfo: stripHtml(park.weatherInfo || ""),
    url: park.url,
    images: (park.images || []).slice(0, 6).map((image) => ({
      url: image.url,
      credit: image.credit || "",
      alt: image.altText || park.fullName,
      caption: image.caption || image.title || "",
    })),
    topics: (park.topics || []).map((topic) => topic.name).filter(Boolean).slice(0, 8),
    hours: stripHtml(park.operatingHours?.[0]?.description || ""),
    point: center
      ? { name: center.name, lat: Number(center.latitude), lon: Number(center.longitude), fallback: false }
      : { name: `${park.fullName} map point`, lat: Number(park.latitude), lon: Number(park.longitude), fallback: true },
    trails,
    trailTotal: trails.length,
    listedActivities: Number(things.total || 0),
    alerts: alertRows == null ? { state: "unavailable", items: [] } : { state: alertRows.length ? "ok" : "empty", items: alertRows },
  };
  cache.set(key, detail);
  writeDisk(`park-${code}`, detail);
  return detail;
  } catch (error) {
    if (error.status === 429 && stored?.trails) {
      cache.set(key, stored);
      return stored;
    }
    throw error;
  }
}

async function geocode(text) {
  const params = new URLSearchParams({ text: String(text).slice(0, 140), size: "5", "boundary.country": "USA" });
  const body = await getJson(`https://api.heigit.org/pelias/v1/search?${params}`, {
    Authorization: env["OPENROUTESERVICE_API_KEY"],
  });
  return (body.features || []).map((feature) => ({
    label: feature.properties?.label || text,
    lat: feature.geometry.coordinates[1],
    lon: feature.geometry.coordinates[0],
    layer: feature.properties?.layer || "",
    confidence: feature.properties?.confidence ?? null,
  }));
}

async function routeCoords(coordinates, attempt = 0) {
  let response;
  try {
    response = await fetch("https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson", {
    method: "POST",
    headers: {
      Authorization: env["OPENROUTESERVICE_API_KEY"],
      "Content-Type": "application/json",
      Accept: "application/geo+json, application/json",
      "User-Agent": env["NWS_USER_AGENT"],
    },
    body: JSON.stringify({ coordinates }),
    signal: AbortSignal.timeout(25000),
  });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!response.ok) {
    const raw = await response.text();
    let detail = "";
    let badIndex = null;
    try {
      const err = JSON.parse(raw);
      detail = typeof err.error === "string" ? err.error : err.error?.message || "";
      const match = detail.match(/coordinate (\d+)/i);
      if (match) badIndex = Number(match[1]);
    } catch {
      detail = "";
    }
    if ((response.status === 403 || response.status === 429) && attempt < 1 && badIndex == null) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return routeCoords(coordinates, attempt + 1);
    }
    return { ok: false, status: response.status, detail, badIndex };
  }
  const body = await response.json();
  const feature = body.features?.[0];
  const summary = feature?.properties?.summary;
  const segments = feature?.properties?.segments || [];
  if (!summary) return { ok: false, status: 200 };
  return {
    ok: true,
    miles: summary.distance / 1609.344,
    minutes: summary.duration / 60,
    geometry: feature.geometry?.coordinates || [],
    legs: segments.map((segment) => ({
      miles: Math.round((segment.distance / 1609.344) * 10) / 10,
      minutes: Math.round(segment.duration / 60),
    })),
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export async function planRoute(body) {
  const park = await parkDetail(body.parkCode);
  const note = remoteAccessNote(body.parkCode);
  const origin = body.origin;
  if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
    return { ok: false, reason: "Choose a resolved start before routing." };
  }
  if (note) {
    return {
      ok: false,
      remote: true,
      reason: note,
      pointName: park.point.name,
      point: park.point,
      retrievedAt: now(),
      source: "Park access note. No driving route was requested.",
    };
  }
  if (park.point.fallback) {
    return {
      ok: false,
      reason: `${park.name} has no visitor-center coordinate in this NPS response. The park map point was not used as a driveway, so miles and fuel stay blank.`,
      pointName: park.point.name,
      point: park.point,
      retrievedAt: now(),
    };
  }
  const entrance = [park.point.lon, park.point.lat];
  const start = [Number(origin.lon), Number(origin.lat)];
  const vias = (body.vias || [])
    .filter((via) => Number.isFinite(Number(via.lat)) && Number.isFinite(Number(via.lon)))
    .slice(0, 8)
    .map((via) => ({ id: String(via.id), name: via.name || "Trailhead", coord: [Number(via.lon), Number(via.lat)] }));
  const roundTrip = body.roundTrip !== false;
  const buildChain = (stops) => {
    const chain = [start, entrance, ...stops.map((via) => via.coord)];
    if (roundTrip) chain.push(start);
    return chain;
  };
  let stops = [...vias];
  const skipped = [];
  let routed = await routeCoords(buildChain(stops));
  while (!routed.ok && routed.badIndex != null && stops.length) {
    const viaIndex = routed.badIndex - 2;
    if (viaIndex < 0 || viaIndex >= stops.length) break;
    skipped.push({ id: stops[viaIndex].id, name: stops[viaIndex].name });
    stops.splice(viaIndex, 1);
    routed = await routeCoords(buildChain(stops));
  }
  if (!routed.ok && vias.length && (routed.badIndex == null || routed.badIndex > 1)) {
    routed = await routeCoords(buildChain([]));
    if (routed.ok) skipped.push(...stops.map((via) => ({ id: via.id, name: via.name })));
    stops = [];
  }
  if (!routed.ok) {
    const refused = routed.status === 403 || routed.status === 429;
    return {
      ok: false,
      reason: refused
        ? "The routing service refused the request. Miles and fuel stay blank."
        : "No road route was found from that start to the visitor center. Miles and fuel stay blank.",
      pointName: park.point.name,
      point: park.point,
      retrievedAt: now(),
      source: "OpenRouteService",
    };
  }
  const legCount = routed.legs.length;
  const toPark = routed.legs[0] || null;
  const back = roundTrip ? routed.legs[legCount - 1] : null;
  const middle = stops.length ? routed.legs.slice(1, roundTrip ? -1 : undefined) : [];
  const viaLegs = {};
  stops.forEach((via, index) => {
    viaLegs[via.id] = middle[index] || null;
  });
  const spurs = {};
  const skippedIds = new Set(skipped.map((item) => item.id));
  await Promise.all(vias.map(async (via) => {
    if (skippedIds.has(via.id)) {
      spurs[via.id] = null;
      return;
    }
    const spur = await routeCoords([entrance, via.coord]);
    spurs[via.id] = spur.ok ? { miles: round1(spur.miles), minutes: Math.round(spur.minutes) } : null;
  }));
  const miles = round1(routed.miles);
  const price = Number(body.pricePerGallon);
  const mpg = Number(body.mpg);
  return {
    ok: true,
    retrievedAt: now(),
    source: "OpenRouteService driving-car, OpenStreetMap roads. Typical speed, not live traffic.",
    roundTrip,
    miles,
    minutes: Math.round(routed.minutes),
    geometry: routed.geometry,
    pointName: park.point.name,
    point: park.point,
    toPark,
    returnLeg: back,
    viaLegs,
    spurs,
    trailheadsOmitted: skipped.length > 0,
    omitReason: skipped.length
      ? `No routable road point for ${skipped.map((item) => item.name).join(", ")}. Those trailheads are not included in the driving miles.`
      : "",
    fuel: fuelCost(miles, mpg, price),
    mpg: Number.isFinite(mpg) ? mpg : null,
    pricePerGallon: Number.isFinite(price) ? price : null,
    attribution: "© OpenStreetMap contributors, route © openrouteservice",
  };
}

function clockMinutes(stamp) {
  if (!stamp) return null;
  const time = String(stamp).split("T")[1] || "";
  const [hour, minute] = time.split(":").map(Number);
  if (!Number.isFinite(hour)) return null;
  return hour * 60 + minute;
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 10) / 10;
}

async function forecastDays(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=16`;
  const body = await getJson(url, {}, 20000);
  return {
    timezone: body.timezone,
    days: body.daily.time.map((date, index) => ({
      date,
      high: body.daily.temperature_2m_max[index],
      low: body.daily.temperature_2m_min[index],
      precip: body.daily.precipitation_sum[index],
      wind: body.daily.wind_speed_10m_max[index],
      sunrise: clockMinutes(body.daily.sunrise[index]),
      sunset: clockMinutes(body.daily.sunset[index]),
      sky: SKY[body.daily.weather_code[index]] || "Reported code without a local label",
      kind: "forecast",
    })),
  };
}

async function seasonalDays(lat, lon, dates) {
  const years = [2022, 2023, 2024];
  const collected = [];
  for (const year of years) {
    const keys = dates.map((date) => `${year}-${date.slice(5)}`).sort();
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${keys[0]}&end_date=${keys[keys.length - 1]}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto`;
      const body = await getJson(url, {}, 20000);
      collected.push(body.daily);
    } catch {
      collected.push(null);
    }
  }
  return dates.map((date) => {
    const samples = collected.map((daily) => {
      if (!daily) return null;
      const key = `${daily.time[0].slice(0, 4)}-${date.slice(5)}`;
      const index = daily.time.indexOf(key);
      if (index < 0) return null;
      return {
        high: daily.temperature_2m_max[index],
        low: daily.temperature_2m_min[index],
        precip: daily.precipitation_sum[index],
        wind: daily.wind_speed_10m_max[index],
        sunrise: clockMinutes(daily.sunrise[index]),
        sunset: clockMinutes(daily.sunset[index]),
        sky: SKY[daily.weather_code[index]] || "Mixed skies",
      };
    }).filter(Boolean);
    if (!samples.length) {
      return { date, high: null, low: null, precip: null, wind: null, sunrise: null, sunset: null, sky: null, kind: "unavailable", years: [] };
    }
    return {
      date,
      high: average(samples.map((sample) => sample.high)),
      low: average(samples.map((sample) => sample.low)),
      precip: average(samples.map((sample) => sample.precip)),
      wind: average(samples.map((sample) => sample.wind)),
      sunrise: samples.find((sample) => sample.sunrise != null)?.sunrise ?? null,
      sunset: samples.find((sample) => sample.sunset != null)?.sunset ?? null,
      sky: "Seasonal average",
      kind: "seasonal",
      years: years.filter((_, index) => collected[index] && collected[index].time.includes(`${years[index]}-${date.slice(5)}`)),
    };
  });
}

export async function weatherFor(lat, lon, dates) {
  const point = { lat: Number(lat), lon: Number(lon) };
  let forecast = null;
  let forecastError = false;
  try {
    forecast = await forecastDays(point.lat, point.lon);
  } catch {
    forecastError = true;
  }
  const forecastByDate = new Map((forecast?.days || []).map((day) => [day.date, day]));
  const missing = dates.filter((date) => !forecastByDate.has(date));
  let seasonal = [];
  let seasonalError = false;
  if (missing.length) {
    try {
      seasonal = await seasonalDays(point.lat, point.lon, missing);
    } catch {
      seasonalError = true;
      seasonal = missing.map((date) => ({ date, high: null, low: null, precip: null, wind: null, sunrise: null, sunset: null, sky: null, kind: "unavailable", years: [] }));
    }
  }
  const seasonalByDate = new Map(seasonal.map((day) => [day.date, day]));
  const days = dates.map((date) => forecastByDate.get(date) || seasonalByDate.get(date) || { date, kind: "unavailable", high: null, low: null, precip: null, wind: null, sunrise: null, sunset: null, sky: null });
  let alerts = { state: "unavailable", items: [] };
  try {
    const nws = await getJson(`https://api.weather.gov/alerts/active?point=${point.lat.toFixed(4)},${point.lon.toFixed(4)}`, { Accept: "application/geo+json" }, 15000);
    const items = (nws.features || []).slice(0, 4).map((feature) => feature.properties?.headline).filter(Boolean);
    alerts = { state: items.length ? "ok" : "empty", items };
  } catch {
    alerts = { state: "unavailable", items: [] };
  }
  return {
    retrievedAt: now(),
    source: "Open-Meteo. Active alerts from NWS when the point lookup succeeds.",
    timezone: forecast?.timezone || null,
    forecastError,
    seasonalError,
    days,
    alerts,
    caveat: "This is one coordinate, the visitor center or park reference point, not the trail itself.",
  };
}

async function peliasSearch(searchParams) {
  const params = new URLSearchParams(searchParams);
  return getJson(`https://api.heigit.org/pelias/v1/search?${params}`, {
    Authorization: env["OPENROUTESERVICE_API_KEY"],
  });
}

function venueRows(body) {
  return (body.features || []).map((feature) => ({
    locality: feature.properties?.locality || feature.properties?.localadmin || "",
    region: feature.properties?.region_a || feature.properties?.region || "",
  })).filter((row) => row.locality);
}

export async function lodgingAreas(parkCode, { fixture = false } = {}) {
  if (fixture) {
    if (env.PARKPILOT_LODGING_FIXTURE !== "1" && process.env.PARKPILOT_LODGING_FIXTURE !== "1") {
      return {
        state: "error",
        areas: [],
        fixture: false,
        reason: "Development fixtures are disabled. No sample towns were substituted.",
        retrievedAt: now(),
        source: "ParkPilot",
      };
    }
    return {
      state: "fixture",
      fixture: true,
      areas: fixtureAreas(),
      retrievedAt: now(),
      source: "Development fixture, not a live place catalog",
      reason: "These towns are a labeled development sample.",
    };
  }
  const park = await parkDetail(parkCode);
  const note = remoteAccessNote(parkCode);
  if (note) {
    return { state: "unavailable", areas: [], fixture: false, reason: note, retrievedAt: now(), source: "Park access note" };
  }
  if (park.point.fallback) {
    return {
      state: "unavailable",
      areas: [],
      fixture: false,
      reason: `${park.name} has no visitor-center coordinate, so nearby towns were not searched from the park map pin.`,
      retrievedAt: now(),
      source: "NPS visitor center",
    };
  }
  if (!env.OPENROUTESERVICE_API_KEY) {
    return {
      state: "error",
      areas: [],
      fixture: false,
      reason: "The place catalog key is missing. No sample towns were substituted.",
      retrievedAt: now(),
      source: "OpenRouteService geocoder",
    };
  }
  try {
    const lat = park.point.lat;
    const lon = park.point.lon;
    const focus = {
      "focus.point.lat": String(lat),
      "focus.point.lon": String(lon),
      "boundary.circle.lat": String(lat),
      "boundary.circle.lon": String(lon),
      "boundary.circle.radius": "55",
    };
    const [hotels, camps, reverse] = await Promise.all([
      peliasSearch({ ...focus, text: "hotel", size: "20", layers: "venue" }),
      peliasSearch({ ...focus, text: "campground", size: "15", layers: "venue" }),
      getJson(`https://api.heigit.org/pelias/v1/reverse?point.lat=${lat}&point.lon=${lon}&size=1&layers=locality,localadmin`, {
        Authorization: env["OPENROUTESERVICE_API_KEY"],
      }).catch(() => null),
    ]);
    const venues = [...venueRows(hotels), ...venueRows(camps)];
    const reverseProps = reverse?.features?.[0]?.properties || {};
    const reverseLocality = reverseProps.locality || reverseProps.localadmin || reverseProps.name || "";
    if (reverseLocality) venues.push({ locality: reverseLocality, region: reverseProps.region_a || reverseProps.region || "" });
    const counts = new Map();
    for (const venue of venues) {
      const key = venue.locality.toLowerCase();
      const prior = counts.get(key);
      counts.set(key, { name: venue.locality, region: venue.region || prior?.region || "", count: (prior?.count || 0) + 1 });
    }
    const top = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5);
    const geocoded = [];
    if (reverseLocality) {
      const hits = await geocode(`${reverseLocality}${reverseProps.region_a ? `, ${reverseProps.region_a}` : ""}`);
      const hit = hits.find((item) => /locality|localadmin|neighbourhood|borough|county/i.test(item.layer || "")) || hits[0];
      if (hit) geocoded.push({ name: reverseLocality, label: hit.label, lat: hit.lat, lon: hit.lon });
    }
    for (const row of top) {
      const hits = await geocode(`${row.name}${row.region ? `, ${row.region}` : ""}`);
      const hit = hits.find((item) => /locality|localadmin|neighbourhood|borough|county/i.test(item.layer || "")) || hits[0];
      if (hit) geocoded.push({ name: row.name, label: hit.label, lat: hit.lat, lon: hit.lon });
    }
    const source = "OpenRouteService geocoder. Towns are grouped from nearby lodging places, then each town is geocoded to one reference point.";
    const built = areasFromCatalog(venues, geocoded, {
      retrievedAt: now(),
      source,
      limit: 3,
      preferred: reverseLocality ? [reverseLocality] : [],
    });
    if (built.areas.length) return saveLodgingAreas(parkCode, {
      state: "ok",
      areas: built.areas,
      skipped: built.skipped,
      fixture: false,
      retrievedAt: now(),
      source,
      reason: "",
    });
  } catch {
    // The primary catalog can refuse the request. A second place search still runs below.
  }
  try {
    const fallback = await lodgingAreasFromOverpass(park);
    if (fallback?.areas?.length) return saveLodgingAreas(parkCode, fallback);
  } catch {
    // Keep the saved areas when both live lookups fail.
  }
  const saved = cachedLodgingAreas(parkCode);
  if (saved) return saved;
  return {
    state: "error",
    areas: [],
    fixture: false,
    reason: "The place catalog did not respond. No sample towns were substituted.",
    retrievedAt: now(),
    source: "OpenRouteService geocoder",
  };
}

function cachedLodgingAreas(parkCode) {
  const stored = readDisk(`lodging-areas-${parkCode}`);
  if (stored?.state === "ok" && Array.isArray(stored.areas) && stored.areas.length && !stored.fixture) return stored;
  return null;
}

function saveLodgingAreas(parkCode, body) {
  writeDisk(`lodging-areas-${parkCode}`, body);
  return body;
}

function milesBetween(fromLat, fromLon, toLat, toLon) {
  const radius = 3958.8;
  const a1 = fromLat * Math.PI / 180;
  const a2 = toLat * Math.PI / 180;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLon = (toLon - fromLon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function lodgingAreasFromOverpass(park) {
  const lat = Number(park.point.lat);
  const lon = Number(park.point.lon);
  const query = `[out:json][timeout:12];node["place"~"^(city|town|village)$"](around:40000,${lat},${lon});out body;`;
  const endpoints = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  let body = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Accept: "application/json",
          "User-Agent": env["NWS_USER_AGENT"] || "ParkPilot",
        },
        body: query,
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) continue;
      body = await response.json();
      break;
    } catch {
      body = null;
    }
  }
  const places = (body?.elements || [])
    .map((element) => ({
      name: String(element.tags?.name || "").trim(),
      lat: Number(element.lat),
      lon: Number(element.lon),
      kind: element.tags?.place || "place",
    }))
    .filter((place) => place.name && Number.isFinite(place.lat) && Number.isFinite(place.lon))
    .sort((a, b) => milesBetween(lat, lon, a.lat, a.lon) - milesBetween(lat, lon, b.lat, b.lon) || a.name.localeCompare(b.name))
    .slice(0, 3);
  if (!places.length) return null;
  const source = "OpenStreetMap places within 25 miles of the visitor center, ordered by straight-line distance. This is not a driving distance.";
  return {
    state: "ok",
    areas: places.map((place) => ({
      id: `area-${place.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      name: place.name,
      reference: { name: `${place.name} ${place.kind} point`, lat: place.lat, lon: place.lon },
      venueCount: null,
      source,
      retrievedAt: now(),
      fixture: false,
    })),
    skipped: [],
    fixture: false,
    retrievedAt: now(),
    source,
    reason: "",
  };
}

export async function routeLegs(pairs) {
  const limited = (pairs || []).filter((pair) => (
    Number.isFinite(Number(pair?.from?.lat))
    && Number.isFinite(Number(pair?.from?.lon))
    && Number.isFinite(Number(pair?.to?.lat))
    && Number.isFinite(Number(pair?.to?.lon))
  )).slice(0, 60);
  const legs = new Array(limited.length);
  let cursor = 0;
  async function worker() {
    while (cursor < limited.length) {
      const index = cursor;
      cursor += 1;
      const pair = limited[index];
      const from = { lat: Number(pair.from.lat), lon: Number(pair.from.lon) };
      const to = { lat: Number(pair.to.lat), lon: Number(pair.to.lon) };
      const key = legKey(from, to);
      const cacheKey = `leg:${key}`;
      if (key && cache.has(cacheKey)) {
        legs[index] = cache.get(cacheKey);
        continue;
      }
      const routed = await routeCoords([[from.lon, from.lat], [to.lon, to.lat]]);
      const row = routed.ok
        ? { key, status: "known", minutes: Math.round(routed.minutes), miles: round1(routed.miles), geometry: routed.geometry || [] }
        : { key, status: "unknown", minutes: null, miles: null, geometry: [] };
      if (key && routed.ok) cache.set(cacheKey, row);
      legs[index] = row;
    }
  }
  if (limited.length) await Promise.all(Array.from({ length: Math.min(3, limited.length) }, () => worker()));
  return {
    retrievedAt: now(),
    source: "OpenRouteService driving-car, OpenStreetMap roads. Typical speed, not live traffic.",
    legs: legs.filter(Boolean),
  };
}

export async function fuelPrice() {
  if (cache.has("fuel")) return cache.get("fuel");
  const query = [
    `api_key=${encodeURIComponent(env["EIA_API_KEY"])}`,
    "frequency=weekly",
    "data[0]=value",
    "facets[series][]=EMM_EPMR_PTE_NUS_DPG",
    "sort[0][column]=period",
    "sort[0][direction]=desc",
    "length=1",
  ].join("&");
  const body = await getJson(`https://api.eia.gov/v2/petroleum/pri/gnd/data/?${query}`, {}, 30000);
  const row = body.response?.data?.[0];
  if (!row) throw new Error("empty fuel");
  const payload = {
    retrievedAt: now(),
    source: "EIA weekly retail gasoline",
    price: Number(row.value),
    period: row.period,
    area: row["area-name"] || "U.S.",
    series: row["series-description"] || "U.S. regular gasoline",
    units: row.units || "$/GAL",
  };
  cache.set("fuel", payload);
  return payload;
}

function modelJson(text) {
  const start = String(text || "").indexOf("{");
  const end = String(text || "").lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function suggestItinerary(packet) {
  const dates = (Array.isArray(packet.dates) ? packet.dates : []).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).slice(0, 10);
  const trails = (Array.isArray(packet.trails) ? packet.trails : []).filter((trail) => trail && trail.id && trail.name).slice(0, 16);
  const difficulty = packet.difficulty || "all";
  const fallback = fallbackDays(dates, trails, difficulty);
  const plain = {
    authored: false,
    days: fallback,
    park: packet.park || "",
    retrievedAt: now(),
  };
  if (!dates.length) return { ...plain, reason: "Add a start date before asking for a day-by-day plan." };
  if (!trails.length) return { ...plain, reason: "No schedulable hike is listed for these choices." };
  if (!env["OPENAI_API_KEY"]) return { ...plain, reason: "No model key is configured, so the days use the listed hikes in preference order." };
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env["OPENAI_API_KEY"]}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: "system", content: "Plan a national park hiking itinerary. Reply with JSON only. Shape: {\"days\":[{\"date\":\"YYYY-MM-DD\",\"trailIds\":[\"id\"],\"note\":\"one sentence\"}]}. Include each supplied date once, in the same order. trailIds may contain only ids from the supplied trails, with no repeats. Prefer trails whose level matches difficulty when difficulty is not all. Leave trailIds empty when suitable hikes run out. Notes may use only facts in the JSON. Do not add distances, times, prices, weather, permits, or names that are not supplied. Do not say a hike or flight is booked." },
          { role: "user", content: JSON.stringify({ park: packet.park, dates, difficulty, activities: packet.activities || [], location: packet.location || "", trails }) },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const quota = response.status === 429;
      return { ...plain, reason: quota ? "The model account has no remaining credits, so the days use the listed hikes in preference order." : "The model did not respond. The days below use the listed hikes in preference order." };
    }
    const body = await response.json();
    const accepted = acceptSuggestion(modelJson(body.choices?.[0]?.message?.content || ""), dates, trails);
    if (!accepted) return { ...plain, rejected: true, reason: "The model plan did not stay within the listed hikes and dates." };
    const grounded = { dates, trails, difficulty, activities: packet.activities || [], location: packet.location || "" };
    return {
      authored: true,
      days: accepted.map((day) => ({ ...day, note: day.note && numbersAreGrounded(day.note, grounded) ? day.note : "" })),
      park: packet.park || "",
      retrievedAt: now(),
      source: "OpenAI day plan using only the supplied hikes and dates",
    };
  } catch {
    return { ...plain, reason: "The model did not respond. The days below use the listed hikes in preference order." };
  }
}

async function explain(packet) {
  const fallback = packet.notes?.length ? packet.notes.join(" ") : "No extra tradeoff was calculated from this packet.";
  if (!env["OPENAI_API_KEY"]) return { authored: false, text: fallback, retrievedAt: now() };
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env["OPENAI_API_KEY"]}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 280,
        messages: [
          { role: "system", content: "Explain this national park plan in 2 short paragraphs. Use only facts and numbers present in the JSON. Do not add prices, times, distances, weather, or availability. If a figure is missing, say it is missing." },
          { role: "user", content: JSON.stringify(packet) },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return { authored: false, text: fallback, retrievedAt: now() };
    const body = await response.json();
    const text = body.choices?.[0]?.message?.content?.trim() || "";
    if (!text || !numbersAreGrounded(text, packet)) return { authored: false, text: fallback, retrievedAt: now(), rejected: true };
    return { authored: true, text, retrievedAt: now(), source: "OpenAI explanation of the supplied packet" };
  } catch {
    return { authored: false, text: fallback, retrievedAt: now() };
  }
}

const STATE_FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", DC: "11", FL: "12", GA: "13",
  HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25",
  MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36",
  NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47", TX: "48",
  UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55", WY: "56",
};

const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};

function haversineMiles(from, to) {
  const radius = 3958.8;
  const lat1 = Number(from.lat) * Math.PI / 180;
  const lat2 = Number(to.lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (Number(to.lon) - Number(from.lon)) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else quoted = false;
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

async function commercialAirports() {
  if (cache.has("airports")) return cache.get("airports");
  const response = await fetch("https://davidmegginson.github.io/ourairports-data/airports.csv", {
    headers: { "User-Agent": env["NWS_USER_AGENT"] || "ParkPilot" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("airports");
  const text = await response.text();
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0] || "");
  const column = (name) => header.indexOf(name);
  const typeIndex = column("type");
  const nameIndex = column("name");
  const latIndex = column("latitude_deg");
  const lonIndex = column("longitude_deg");
  const countryIndex = column("iso_country");
  const serviceIndex = column("scheduled_service");
  const iataIndex = column("iata_code");
  const cityIndex = column("municipality");
  const airports = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = parseCsvLine(line);
    const type = cells[typeIndex];
    if (cells[countryIndex] !== "US") continue;
    if (cells[serviceIndex] !== "yes") continue;
    if (type !== "large_airport" && type !== "medium_airport") continue;
    const iata = cells[iataIndex];
    const lat = Number(cells[latIndex]);
    const lon = Number(cells[lonIndex]);
    if (!iata || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    airports.push({
      name: cells[nameIndex],
      iata,
      city: cells[cityIndex] || "",
      type: type === "large_airport" ? "Large airport" : "Medium airport",
      lat,
      lon,
    });
  }
  cache.set("airports", airports);
  return airports;
}

export async function closestAirports(parkCode) {
  const park = await parkDetail(parkCode);
  if (park.point.fallback) {
    return {
      state: "unavailable",
      airports: [],
      reason: `${park.name} has no visitor-center coordinate, so nearby airports were not measured.`,
      source: "OurAirports",
      retrievedAt: now(),
    };
  }
  const catalog = await commercialAirports();
  const ranked = catalog
    .map((airport) => ({ ...airport, straightMiles: round1(haversineMiles(park.point, airport)) }))
    .sort((a, b) => a.straightMiles - b.straightMiles || a.name.localeCompare(b.name))
    .slice(0, 3);
  const routed = await routeLegs(ranked.map((airport) => ({
    from: { lat: airport.lat, lon: airport.lon },
    to: { lat: park.point.lat, lon: park.point.lon },
  })));
  return {
    state: ranked.length ? "ok" : "empty",
    airports: ranked.map((airport, index) => {
      const leg = routed.legs[index];
      return {
        ...airport,
        roadMiles: leg?.status === "known" ? leg.miles : null,
        roadMinutes: leg?.status === "known" ? leg.minutes : null,
      };
    }),
    entrance: park.point.name,
    reason: ranked.length ? "" : "No scheduled U.S. commercial airport was found in the airport catalog.",
    source: "OurAirports scheduled large and medium U.S. airports. Straight-line miles use those coordinates. Road miles are OpenRouteService driving-car when the leg returns.",
    retrievedAt: now(),
  };
}

function clipText(text, limit = 280) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  const slice = value.slice(0, limit);
  const end = slice.lastIndexOf(". ");
  return `${(end > 80 ? slice.slice(0, end + 1) : slice).trim()}…`;
}

async function censusPopulation(name, region) {
  const fips = STATE_FIPS[String(region || "").trim().toUpperCase()];
  const key = env.CENSUS_API_KEY;
  if (!fips || !key) return null;
  const wanted = String(name || "").trim().toLowerCase();
  for (const year of [2023, 2022, 2021]) {
    try {
      const rows = await getJson(`https://api.census.gov/data/${year}/acs/acs5?get=NAME,B01003_001E&for=place:*&in=state:${fips}&key=${encodeURIComponent(key)}`, {}, 8000);
      const match = (rows || []).slice(1).find((row) => {
        const label = String(row[0] || "").toLowerCase();
        return label.startsWith(`${wanted} city`) || label.startsWith(`${wanted} town`) || label.startsWith(`${wanted} village`) || label.startsWith(`${wanted} cdp`);
      });
      const value = Number(match?.[1]);
      if (!match || !Number.isFinite(value) || value < 0) continue;
      return { population: value, year, name: match[0] };
    } catch {
      continue;
    }
  }
  return null;
}

export async function townProfile(name, region) {
  const place = String(name || "").trim();
  const code = String(region || "").trim().toUpperCase();
  if (!place) return { state: "empty", reason: "Name the town." };
  const cacheKey = `town:${place.toLowerCase()}|${code}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const stateName = STATE_NAMES[code] || code;
  const [summary, census] = await Promise.all([
    (async () => {
      try {
        const search = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`${place} ${stateName}`)}&srlimit=1&format=json`, {}, 8000);
        const title = search?.query?.search?.[0]?.title;
        if (!title) return null;
        return await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {}, 8000);
      } catch {
        return null;
      }
    })(),
    censusPopulation(place, code).catch(() => null),
  ]);
  const payload = {
    state: summary?.extract || census ? "ok" : "empty",
    name: place,
    blurb: summary?.extract ? clipText(summary.extract) : "",
    image: summary?.thumbnail?.source || summary?.originalimage?.source || "",
    imagePage: summary?.content_urls?.desktop?.page || "",
    population: census?.population ?? null,
    populationYear: census?.year ?? null,
    populationName: census?.name || "",
    source: [
      summary?.extract ? "Wikipedia summary" : "",
      census ? `U.S. Census Bureau ACS ${census.year} total population` : "",
    ].filter(Boolean).join(". ") || "No town summary or census population came back.",
    retrievedAt: now(),
  };
  if (payload.state === "ok") cache.set(cacheKey, payload);
  return payload;
}

export async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/api/parks" && req.method === "GET") {
      const payload = await nationalParks();
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const state = (url.searchParams.get("state") || "").toUpperCase();
      const activity = (url.searchParams.get("activity") || "").toLowerCase();
      send(200, {
        ...payload,
        parks: payload.parks.filter((park) => {
          const hay = `${park.name} ${park.states}`.toLowerCase();
          if (q && !hay.includes(q)) return false;
          if (state && !park.states.split(",").includes(state)) return false;
          if (activity && !park.activities.some((name) => name.toLowerCase() === activity)) return false;
          return true;
        }),
      });
      return;
    }
    if (url.pathname === "/api/hike-levels" && req.method === "GET") {
      const codes = [...new Set((url.searchParams.get("codes") || "").split(",").map((code) => code.trim().toLowerCase()))]
        .filter((code) => /^[a-z]{4}$/.test(code))
        .slice(0, 4);
      if (!codes.length) return send(400, { levels: {}, reason: "Name the parks to check." });
      send(200, await hikeLevelsFor(codes));
      return;
    }
    const detail = url.pathname.match(/^\/api\/parks\/([a-z]{4})$/);
    if (detail && req.method === "GET") {
      send(200, await parkDetail(detail[1]));
      return;
    }
    if (url.pathname === "/api/geocode" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      if (q.trim().length < 3) return send(400, { results: [], reason: "Enter at least three characters." });
      const results = await geocode(q.trim());
      send(200, { retrievedAt: now(), source: "OpenRouteService geocoder", results, state: results.length ? "ok" : "empty" });
      return;
    }
    if (url.pathname === "/api/airports" && req.method === "GET") {
      const parkCode = (url.searchParams.get("parkCode") || "").toLowerCase();
      if (!/^[a-z]{4}$/.test(parkCode)) return send(400, { state: "error", airports: [], reason: "Choose a park first." });
      send(200, await closestAirports(parkCode));
      return;
    }
    if (url.pathname === "/api/town" && req.method === "GET") {
      const name = url.searchParams.get("name") || "";
      const region = url.searchParams.get("region") || "";
      if (!name.trim()) return send(400, { state: "empty", reason: "Name the town." });
      send(200, await townProfile(name, region));
      return;
    }
    if (url.pathname === "/api/lodging/areas" && req.method === "GET") {
      const parkCode = url.searchParams.get("parkCode") || "";
      if (!/^[a-z]{4}$/.test(parkCode)) return send(400, { state: "error", areas: [], reason: "Choose a park first." });
      send(200, await lodgingAreas(parkCode, { fixture: url.searchParams.get("fixture") === "1" }));
      return;
    }
    if (url.pathname === "/api/legs" && req.method === "POST") {
      send(200, await routeLegs((await readBody(req)).pairs || []));
      return;
    }
    if (url.pathname === "/api/route" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.parkCode || !body.origin) return send(400, { ok: false, reason: "Choose a park and a confirmed start." });
      send(200, await planRoute(body));
      return;
    }
    if (url.pathname === "/api/weather" && req.method === "GET") {
      const dates = (url.searchParams.get("dates") || "").split(",").filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).slice(0, 10);
      if (!dates.length) return send(400, { error: "Add trip dates." });
      send(200, await weatherFor(url.searchParams.get("lat"), url.searchParams.get("lon"), dates));
      return;
    }
    if (url.pathname === "/api/fuel" && req.method === "GET") {
      send(200, await fuelPrice());
      return;
    }
    if (url.pathname === "/api/explain" && req.method === "POST") {
      send(200, await explain(await readBody(req)));
      return;
    }
    if (url.pathname === "/api/itinerary" && req.method === "POST") {
      send(200, await suggestItinerary(await readBody(req)));
      return;
    }
    send(404, { error: "not found" });
  } catch (error) {
    if (error.status === 429) {
      send(429, { error: "The National Park Service rate limit is in effect. Trails were not replaced with samples.", retryAfter: error.retryAfter || 60 });
      return;
    }
    const missing = error.status === 404;
    send(missing ? 404 : 502, { error: missing ? "That park was not in the NPS response." : "A source did not respond. Nothing was filled in with a sample." });
  }
}
