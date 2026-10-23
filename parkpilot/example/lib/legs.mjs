export function pointKey(point) {
  if (!point || point.unroutable) return null;
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function legKey(from, to) {
  const start = pointKey(from);
  const end = pointKey(to);
  if (!start || !end || start === end) return null;
  return `${start}|${end}`;
}

export function resolveLeg(book, from, to) {
  if (!from || !to || from.unroutable || to.unroutable) return { status: "unknown", minutes: null, miles: null };
  const key = legKey(from, to);
  if (!key) return { status: "known", minutes: 0, miles: 0 };
  if (!book || !(key in book)) return { status: "pending", minutes: null, miles: null };
  const found = book[key];
  if (!found || found.status === "unknown" || found.minutes == null || found.miles == null) {
    return { status: "unknown", minutes: null, miles: null };
  }
  return { status: "known", minutes: Number(found.minutes), miles: Number(found.miles) };
}

export function stayNights(dates) {
  if (!dates?.length) return [];
  if (dates.length === 1) return [dates[0]];
  return dates.slice(0, -1);
}

function addPair(list, seen, from, to) {
  const key = legKey(from, to);
  if (!key || seen.has(key)) return;
  seen.add(key);
  list.push({ key, from: { lat: Number(from.lat), lon: Number(from.lon) }, to: { lat: Number(to.lat), lon: Number(to.lon) } });
}

export function lodgingPairs({ origin, entrance, trails = [], bases = [] }) {
  const pairs = [];
  const seen = new Set();
  const stops = [entrance, ...trails].filter(Boolean);
  for (const base of bases) {
    addPair(pairs, seen, origin, base);
    addPair(pairs, seen, base, origin);
    for (const stop of stops) {
      addPair(pairs, seen, base, stop);
      addPair(pairs, seen, stop, base);
    }
  }
  addPair(pairs, seen, origin, entrance);
  addPair(pairs, seen, entrance, origin);
  for (const trail of trails) {
    addPair(pairs, seen, origin, trail);
    addPair(pairs, seen, trail, origin);
    addPair(pairs, seen, entrance, trail);
    addPair(pairs, seen, trail, entrance);
  }
  for (let i = 0; i < trails.length; i += 1) {
    for (let j = 0; j < trails.length; j += 1) {
      if (i !== j) addPair(pairs, seen, trails[i], trails[j]);
    }
  }
  for (let i = 0; i < bases.length; i += 1) {
    for (let j = 0; j < bases.length; j += 1) {
      if (i !== j) addPair(pairs, seen, bases[i], bases[j]);
    }
  }
  return pairs;
}
