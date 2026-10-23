import { resolveLeg } from "./legs.mjs";

export function minutesOf(hhmm) {
  const [hour, minute] = String(hhmm || "0:0").split(":").map(Number);
  return hour * 60 + minute;
}

export function formatClock(total) {
  const extra = Math.floor(total / 1440);
  const mins = ((total % 1440) + 1440) % 1440;
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  const suffix = hour >= 12 ? "p.m." : "a.m.";
  const hour12 = hour % 12 || 12;
  const label = `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
  return extra > 0 ? `${label} (+${extra}d)` : label;
}

export function addDays(iso, count) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return date.toISOString().slice(0, 10);
}

const HIKE_CAP = 8 * 60;

function block(fields) {
  return { ...fields, end: fields.start + fields.minutes };
}

export function buildItinerary(input) {
  if (input.stay) return buildStayItinerary(input);
  const dayCount = Math.max(1, Number(input.dayCount) || 1);
  const dates = Array.from({ length: dayCount }, (_, index) => addDays(input.startDate, index));
  const conflicts = [];
  const days = dates.map((date) => ({ date, items: [] }));
  const cursors = [];
  const hikeMinutes = dates.map(() => 0);

  function sunset(index) {
    const value = input.sunsetByDate?.[dates[index]];
    return Number.isFinite(value) ? value : null;
  }

  function openDay(index) {
    const items = days[index].items;
    let cursor = index === 0 && input.airport ? minutesOf(input.landingTime) + Number(input.bufferMin || 0) : minutesOf(input.departTime);
    if (index === 0 && input.airport) {
      const landing = minutesOf(input.landingTime);
      items.push(block({
        id: "buffer",
        kind: "buffer",
        title: "Baggage and vehicle pickup",
        start: landing,
        minutes: Number(input.bufferMin || 0),
        note: "Allowance you set after landing. It is not a measured wait.",
      }));
    }
    if (index === 0) {
      if (input.driveToMin == null) {
        items.push(block({
          id: "drive-in",
          kind: "missing",
          title: "Drive to the park",
          start: cursor,
          minutes: 0,
          note: "No verified road time. The clock was not moved to imitate one.",
        }));
        conflicts.push({
          code: "missing-drive",
          message: "Driving time to the park is missing, so later activities are not delayed by an assumed drive.",
          suggestion: "Confirm a start that routes, or keep the arrival time unknown.",
        });
      } else {
        items.push(block({
          id: "drive-in",
          kind: "drive",
          title: "Drive to the park entrance",
          start: cursor,
          minutes: input.driveToMin,
          note: "Road estimate at typical speeds. Not live traffic.",
        }));
        cursor += input.driveToMin;
      }
      const dusk = sunset(0);
      if (dusk != null && cursor > dusk) {
        conflicts.push({
          code: "late-arrival",
          message: `The drive reaches the entrance at ${formatClock(cursor)}, after sunset at ${formatClock(dusk)}.`,
          suggestion: "Your arrival leaves limited daylight; move the longer hike to tomorrow and choose a shorter activity today.",
        });
      }
    }
    cursors[index] = cursor;
  }

  for (let index = 0; index < dayCount; index += 1) openDay(index);

  function fits(index, cursor, added, hikeMins) {
    const end = cursor + added;
    const dusk = sunset(index);
    if (dusk != null && end > dusk) return false;
    if (index === dayCount - 1 && input.driveBackMin != null && end + input.driveBackMin > minutesOf(input.returnBy)) return false;
    if (index === dayCount - 1 && input.driveBackMin == null && end > minutesOf(input.returnBy)) return false;
    if (dusk == null && hikeMinutes[index] + hikeMins > HIKE_CAP) return false;
    return true;
  }

  function place(index, trail, allowOverflow) {
    const previous = [...days[index].items].reverse().find((item) => item.kind === "hike");
    const knownDrive = previous ? trail.fromPreviousMin : trail.fromEntranceMin;
    const parts = [];
    if (knownDrive == null) {
      parts.push({
        kind: "missing",
        title: `Drive to ${trail.name}`,
        minutes: 0,
        trailId: trail.id,
        note: previous
          ? "No verified drive from the previous stop. No minutes were added."
          : "No verified drive from the entrance to this trailhead. No minutes were added.",
      });
    } else if (knownDrive > 0) {
      parts.push({
        kind: "drive",
        title: previous ? `Drive to ${trail.name}` : `Drive from the entrance to ${trail.name}`,
        minutes: knownDrive,
        trailId: trail.id,
        note: previous ? "Road estimate from the previous trailhead in this order." : "Road estimate from the park entrance.",
      });
    }
    parts.push({ kind: "parking", title: `Parking for ${trail.name}`, minutes: 15, trailId: trail.id, note: "15-minute parking allowance. An assumption, not a lot count." });
    parts.push({ kind: "hike", title: trail.name, minutes: trail.minutes, trailId: trail.id, note: "Top of the published duration. Not shortened to fit." });
    if (trail.minutes >= 180) {
      parts.push({ kind: "meal", title: "Meal", minutes: 45, trailId: trail.id, note: "45-minute meal because the hike is at least 3 hours. An assumption." });
    } else {
      parts.push({ kind: "rest", title: "Rest", minutes: 15, trailId: trail.id, note: "15-minute rest after the hike. An assumption." });
    }
    const added = parts.reduce((sum, part) => sum + part.minutes, 0);
    const cursor = cursors[index];
    if (!allowOverflow && !fits(index, cursor, added, trail.minutes)) return false;
    if (allowOverflow && !fits(index, cursor, added, trail.minutes)) {
      conflicts.push({
        code: "overflow",
        trailId: trail.id,
        message: `${trail.name} still takes ${Math.round((trail.minutes / 60) * 10) / 10} hours on ${dates[index]}, past the time that day can hold. It was not shortened.`,
        suggestion: "Choose a shorter trail, put it on another day, or extend the trip.",
      });
    }
    let at = cursor;
    for (const part of parts) {
      days[index].items.push(block({ ...part, id: `${trail.id}-${part.kind}`, start: at }));
      at += part.minutes;
    }
    cursors[index] = at;
    hikeMinutes[index] += trail.minutes;
    return true;
  }

  const pinned = dates.map(() => []);
  const floating = [];
  for (const trail of input.trails || []) {
    if (Number.isInteger(trail.preferredDay) && trail.preferredDay >= 0 && trail.preferredDay < dayCount) pinned[trail.preferredDay].push(trail);
    else floating.push(trail);
  }
  for (let index = 0; index < dayCount; index += 1) {
    for (const trail of pinned[index]) place(index, trail, true);
  }
  for (const trail of floating) {
    let placed = false;
    for (let index = 0; index < dayCount; index += 1) {
      if (place(index, trail, false)) {
        placed = true;
        if (index > 0) {
          conflicts.push({
            code: "deferred",
            trailId: trail.id,
            message: `${trail.name} is on ${dates[index]} because it does not fit on an earlier day without shortening the hike or the drive.`,
            suggestion: "Keep it on this day, choose a shorter trail first, or change the order.",
          });
        }
        break;
      }
    }
    if (!placed) place(dayCount - 1, trail, true);
  }

  const last = dayCount - 1;
  const backCursor = cursors[last];
  if (input.roundTrip === false) {
    days[last].items.push(block({
      id: "one-way",
      kind: "note",
      title: "One-way plan",
      start: backCursor,
      minutes: 0,
      note: "Return driving is not included. The deadline is not a round-trip arrival.",
    }));
  } else if (input.driveBackMin == null) {
    days[last].items.push(block({
      id: "drive-back",
      kind: "missing",
      title: "Return drive",
      start: backCursor,
      minutes: 0,
      note: "Return road time is missing, so it was not checked against the deadline.",
    }));
    conflicts.push({
      code: "missing-return",
      message: "Return driving time is missing. The deadline was not compared with an invented drive.",
      suggestion: "Calculate a round trip before treating the return as timed.",
    });
  } else {
    const end = backCursor + input.driveBackMin;
    days[last].items.push(block({
      id: "drive-back",
      kind: "drive",
      title: "Return drive",
      start: backCursor,
      minutes: input.driveBackMin,
      note: "Road estimate back to the start. Not live traffic.",
    }));
    if (end > minutesOf(input.returnBy)) {
      conflicts.push({
        code: "return-late",
        message: `The return ends at ${formatClock(end)}, after the ${formatClock(minutesOf(input.returnBy))} deadline. The drive was kept at full length.`,
        suggestion: "Drop a trail, leave earlier, or move the deadline.",
      });
    }
  }

  for (let index = 0; index < dayCount; index += 1) {
    if (hikeMinutes[index] > HIKE_CAP) {
      conflicts.push({
        code: "overloaded",
        message: `${dates[index]} has ${Math.round((hikeMinutes[index] / 60) * 10) / 10} hours of hiking, past an 8-hour planning day. Nothing was compressed.`,
        suggestion: "Move one hike to another day or replace the longest with a shorter trail.",
      });
    }
  }

  const hikingMiles = (input.trails || []).reduce((sum, trail) => sum + (trail.miles || 0), 0);
  const missingHikeMiles = (input.trails || []).filter((trail) => trail.miles == null).length;
  return { days, conflicts, hikingMiles, missingHikeMiles, hikeMinutes };
}

function namedPoint(point, role, fallback) {
  if (!point) return null;
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  const unroutable = Boolean(point.unroutable) || !Number.isFinite(lat) || !Number.isFinite(lon);
  return {
    id: point.id || role,
    name: point.name || point.label || fallback,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    role,
    unroutable,
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function buildStayItinerary(input) {
  const dayCount = Math.max(1, Number(input.dayCount) || 1);
  const dates = Array.from({ length: dayCount }, (_, index) => addDays(input.startDate, index));
  const conflicts = [];
  const days = dates.map((date) => ({ date, items: [] }));
  const cursors = dates.map(() => minutesOf(input.departTime));
  const hikeMinutes = dates.map(() => 0);
  const position = dates.map(() => null);
  const legs = [];
  let sawPending = false;
  const book = input.stay.legBook || {};
  const checkIn = Number(input.stay.checkInMin ?? 20);
  const checkOut = Number(input.stay.checkOutMin ?? 15);
  const relocation = Number(input.stay.relocationMin ?? 0);
  const maxDrive = Number(input.stay.maxDailyDriveMin ?? 180);
  const origin = namedPoint(input.originPoint, "origin", "Start");
  const entrance = namedPoint(input.entrancePoint, "entrance", "Park reference");

  function lodgingOn(date) {
    return namedPoint(input.stay.nightByDate?.[date], "lodging", "Lodging");
  }

  function morningLodging(index) {
    if (index === 0) return lodgingOn(dates[0]);
    return lodgingOn(dates[index - 1]);
  }

  function operatingBase(index) {
    return morningLodging(index) || entrance;
  }

  function endPoint(index) {
    const last = index === dates.length - 1;
    if (last && input.roundTrip !== false) return origin;
    if (last) return lodgingOn(dates[index]);
    return lodgingOn(dates[index]) || entrance;
  }

  function sunset(index) {
    const value = input.sunsetByDate?.[dates[index]];
    return Number.isFinite(value) ? value : null;
  }

  function pushAllowance(index, id, title, minutes, note) {
    if (!(minutes > 0)) return;
    const start = cursors[index];
    days[index].items.push(block({ id, kind: "buffer", title, start, minutes, note }));
    cursors[index] += minutes;
  }

  function pushDrive(index, from, to, kind) {
    if (!from || !to) return { status: "unknown", minutes: null, miles: null };
    const resolved = resolveLeg(book, from, to);
    if (resolved.status === "known" && resolved.minutes === 0 && resolved.miles === 0) return resolved;
    const known = resolved.status === "known";
    const start = cursors[index];
    const id = `leg-${index}-${legs.length}`;
    days[index].items.push(block({
      id,
      kind: known ? "drive" : "missing",
      title: kind === "transfer" ? `Lodging transfer to ${to.name}` : `Drive to ${to.name}`,
      start,
      minutes: known ? resolved.minutes : 0,
      note: known
        ? `${kind[0].toUpperCase()}${kind.slice(1)} road estimate from ${from.name}. Not live traffic.`
        : resolved.status === "pending"
          ? `The road time from ${from.name} to ${to.name} is still loading. Nothing was filled in.`
          : `No verified road time from ${from.name} to ${to.name}. Nothing was added, and this leg is not zero.`,
      legKind: kind,
    }));
    if (known) cursors[index] += resolved.minutes;
    legs.push({
      id,
      date: dates[index],
      kind,
      fromName: from.name,
      toName: to.name,
      fromRole: from.role,
      toRole: to.role,
      fromLat: from.lat,
      fromLon: from.lon,
      toLat: to.lat,
      toLon: to.lon,
      minutes: known ? resolved.minutes : null,
      miles: known ? resolved.miles : null,
      status: resolved.status,
    });
    if (resolved.status === "pending") sawPending = true;
    else if (!known && kind === "arrival") {
      conflicts.push({
        code: "missing-drive",
        message: `Driving time from ${from.name} to ${to.name} on ${dates[index]} is missing, so later activities are not delayed by an assumed drive.`,
        suggestion: "Confirm a start and a base that route, or keep the arrival time unknown.",
      });
    } else if (!known && kind === "departure") {
      conflicts.push({
        code: "missing-return",
        message: `Return driving time from ${from.name} to ${to.name} is missing. The deadline was not compared with an invented drive.`,
        suggestion: "Calculate the departure leg before treating the return as timed.",
      });
    } else if (!known) {
      conflicts.push({
        code: "missing-leg",
        message: `Driving time from ${from.name} to ${to.name} on ${dates[index]} is missing, so it was not counted as zero.`,
        suggestion: "Wait for a verified road leg, or choose a place that can be routed.",
      });
    }
    return resolved;
  }

  function openDay(index) {
    const items = days[index].items;
    let cursor = index === 0 && input.airport ? minutesOf(input.landingTime) + Number(input.bufferMin || 0) : minutesOf(input.departTime);
    if (index === 0 && input.airport) {
      const landing = minutesOf(input.landingTime);
      items.push(block({
        id: "buffer",
        kind: "buffer",
        title: "Baggage and vehicle pickup",
        start: landing,
        minutes: Number(input.bufferMin || 0),
        note: "Allowance you set after landing. It is not a measured wait.",
      }));
    }
    cursors[index] = cursor;
    if (index === 0) {
      const bed = lodgingOn(dates[0]);
      if (!origin) {
        conflicts.push({
          code: "missing-drive",
          message: "Driving time to the lodging is missing because the start is unresolved.",
          suggestion: "Confirm a start before treating arrival time as known.",
        });
        position[index] = bed || entrance;
        return;
      }
      if (bed) {
        pushDrive(index, origin, bed, "arrival");
        pushAllowance(index, "check-in", `Check-in at ${bed.name}`, checkIn, "Check-in allowance. It is not a measured wait and it does not reserve the property.");
        position[index] = bed;
      } else if (entrance) {
        pushDrive(index, origin, entrance, "arrival");
        position[index] = entrance;
      }
      const dusk = sunset(0);
      if (dusk != null && cursors[index] > dusk) {
        conflicts.push({
          code: "late-arrival",
          message: `The drive reaches ${position[index]?.name || "the first stop"} at ${formatClock(cursors[index])}, after sunset at ${formatClock(dusk)}.`,
          suggestion: "Your arrival leaves limited daylight; move the longer hike to tomorrow and choose a shorter activity today.",
        });
      }
      return;
    }
    const morning = morningLodging(index);
    position[index] = morning || entrance;
    if (morning) {
      pushAllowance(index, `checkout-${index}`, `Check-out at ${morning.name}`, checkOut, "Check-out allowance before the first drive. An assumption, not a property rule.");
    }
  }

  function transferExtra(index, end) {
    const morning = morningLodging(index);
    if (end?.role === "lodging" && morning && end.id !== morning.id) return checkIn + relocation;
    return 0;
  }

  function fits(index, cursor, added, hikeMins, from, trail) {
    const end = endPoint(index);
    const back = end ? resolveLeg(book, trail, end) : { status: "known", minutes: 0 };
    const drive = resolveLeg(book, from, trail);
    if (drive.status === "pending" || back.status === "pending") return true;
    if (drive.status !== "known" || back.status !== "known") return false;
    const extra = transferExtra(index, end);
    const finish = cursor + added + (back.minutes || 0) + extra;
    const dusk = sunset(index);
    if (dusk != null && finish > dusk) return false;
    if (index === dayCount - 1 && finish > minutesOf(input.returnBy)) return false;
    if (dusk == null && hikeMinutes[index] + hikeMins > HIKE_CAP) return false;
    return true;
  }

  function place(index, trail, allowOverflow) {
    const from = position[index] || operatingBase(index);
    const trailPoint = namedPoint({ id: trail.id, name: trail.name, lat: trail.lat, lon: trail.lon }, "trail", trail.name);
    const parts = [];
    const drive = resolveLeg(book, from, trailPoint);
    if (!from || !trailPoint || drive.status !== "known") {
      parts.push({
        kind: "missing",
        title: `Drive to ${trail.name}`,
        minutes: 0,
        trailId: trail.id,
        note: drive.status === "pending"
          ? `The road time from ${from?.name || "the start of the day"} to ${trail.name} is still loading. No minutes were added.`
          : `No verified drive from ${from?.name || "the start of the day"} to ${trail.name}. No minutes were added, and this leg is not zero.`,
      });
    } else if (drive.minutes > 0) {
      parts.push({
        kind: "drive",
        title: `Drive to ${trail.name}`,
        minutes: drive.minutes,
        miles: drive.miles,
        trailId: trail.id,
        from,
        to: trailPoint,
        note: `Road estimate from ${from.name}. Not live traffic.`,
      });
    }
    parts.push({ kind: "parking", title: `Parking for ${trail.name}`, minutes: 15, trailId: trail.id, note: "15-minute parking allowance. An assumption, not a lot count." });
    parts.push({ kind: "hike", title: trail.name, minutes: trail.minutes, trailId: trail.id, note: "Top of the published duration. Not shortened to fit." });
    if (trail.minutes >= 180) parts.push({ kind: "meal", title: "Meal", minutes: 45, trailId: trail.id, note: "45-minute meal because the hike is at least 3 hours. An assumption." });
    else parts.push({ kind: "rest", title: "Rest", minutes: 15, trailId: trail.id, note: "15-minute rest after the hike. An assumption." });
    const added = parts.reduce((sum, part) => sum + part.minutes, 0);
    const cursor = cursors[index];
    const canFit = fits(index, cursor, added, trail.minutes, from, trailPoint);
    if (!allowOverflow && !canFit) return false;
    if (allowOverflow && !canFit && drive.status !== "pending") {
      conflicts.push({
        code: "overflow",
        trailId: trail.id,
        message: `${trail.name} still takes ${Math.round((trail.minutes / 60) * 10) / 10} hours on ${dates[index]}, past the time that day can hold. It was not shortened.`,
        suggestion: "Choose a shorter trail, put it on another day, or extend the trip.",
      });
    }
    let at = cursor;
    for (const part of parts) {
      if (part.kind === "drive" && part.from && part.to) {
        legs.push({
          id: `${trail.id}-drive-${index}`,
          date: dates[index],
          kind: "local",
          fromName: part.from.name,
          toName: part.to.name,
          fromRole: part.from.role,
          toRole: "trail",
          fromLat: part.from.lat,
          fromLon: part.from.lon,
          toLat: part.to.lat,
          toLon: part.to.lon,
          minutes: part.minutes,
          miles: part.miles,
          status: "known",
        });
      } else if (part.kind === "missing") {
        const status = drive.status === "pending" ? "pending" : "unknown";
        if (status === "pending") sawPending = true;
        else {
          conflicts.push({
            code: "missing-leg",
            trailId: trail.id,
            message: `Driving time from ${from?.name || "the day's start"} to ${trail.name} on ${dates[index]} is missing, so it was not counted as zero.`,
            suggestion: "Use a trailhead with a verified road leg, or leave the time blank.",
          });
        }
        legs.push({
          id: `${trail.id}-drive-${index}`,
          date: dates[index],
          kind: "local",
          fromName: from?.name || "Start of day",
          toName: trail.name,
          fromRole: from?.role || "lodging",
          toRole: "trail",
          minutes: null,
          miles: null,
          status,
        });
      }
      days[index].items.push(block({ ...part, id: `${trail.id}-${part.kind}`, start: at }));
      at += part.minutes;
    }
    cursors[index] = at;
    hikeMinutes[index] += trail.minutes;
    position[index] = trailPoint;
    return true;
  }

  for (let index = 0; index < dayCount; index += 1) openDay(index);

  const pinned = dates.map(() => []);
  const floating = [];
  for (const trail of input.trails || []) {
    if (Number.isInteger(trail.preferredDay) && trail.preferredDay >= 0 && trail.preferredDay < dayCount) pinned[trail.preferredDay].push(trail);
    else floating.push(trail);
  }
  for (let index = 0; index < dayCount; index += 1) {
    for (const trail of pinned[index]) place(index, trail, true);
  }
  for (const trail of floating) {
    let placed = false;
    for (let index = 0; index < dayCount; index += 1) {
      if (place(index, trail, false)) {
        placed = true;
        if (index > 0) {
          conflicts.push({
            code: "deferred",
            trailId: trail.id,
            message: `${trail.name} is on ${dates[index]} because it does not fit on an earlier day without shortening the hike or the drive.`,
            suggestion: "Keep it on this day, choose a shorter trail first, or change the order.",
          });
        }
        break;
      }
    }
    if (!placed) place(dayCount - 1, trail, true);
  }

  function closeDay(index) {
    let from = position[index] || operatingBase(index);
    const hadHike = days[index].items.some((item) => item.kind === "hike");
    if (!hadHike && entrance && from && (from.lat !== entrance.lat || from.lon !== entrance.lon)) {
      pushDrive(index, from, entrance, "local");
      from = entrance;
      position[index] = entrance;
    }
    const end = endPoint(index);
    if (!end || !from) return;
    const morning = morningLodging(index);
    let kind = "local";
    if (end.role === "origin") kind = "departure";
    else if (morning && end.role === "lodging" && end.id !== morning.id) kind = "transfer";
    pushDrive(index, from, end, kind);
    if (kind === "transfer") {
      pushAllowance(index, `relocate-${index}`, `Check-in at ${end.name}`, checkIn + relocation, "Check-in and relocation allowance for a lodging change. It does not reserve the property.");
    }
    const dusk = sunset(index);
    if (index === dayCount - 1 && input.roundTrip !== false) {
      const departure = legs.filter((leg) => leg.date === dates[index] && leg.kind === "departure").pop();
      if (departure?.status === "known" && cursors[index] > minutesOf(input.returnBy)) {
        conflicts.push({
          code: "return-late",
          message: `The return ends at ${formatClock(cursors[index])}, after the ${formatClock(minutesOf(input.returnBy))} deadline. The drive was kept at full length.`,
          suggestion: "Drop a trail, leave earlier, or move the deadline.",
        });
      }
    }
    if (dusk != null && cursors[index] > dusk && hadHike) {
      const already = conflicts.some((conflict) => conflict.code === "late-arrival" && index === 0);
      if (!already && days[index].items.some((item) => item.kind === "hike" && item.end > dusk)) {
        conflicts.push({
          code: "overflow",
          message: `${dates[index]} runs past sunset at ${formatClock(dusk)}. The hike was kept at full length.`,
          suggestion: "Move a hike to another day or start earlier.",
        });
      }
    }
  }

  for (let index = 0; index < dayCount; index += 1) closeDay(index);

  for (let index = 0; index < dayCount; index += 1) {
    if (hikeMinutes[index] > HIKE_CAP) {
      conflicts.push({
        code: "overloaded",
        message: `${dates[index]} has ${Math.round((hikeMinutes[index] / 60) * 10) / 10} hours of hiking, past an 8-hour planning day. Nothing was compressed.`,
        suggestion: "Move one hike to another day or replace the longest with a shorter trail.",
      });
    }
    const mine = legs.filter((leg) => leg.date === dates[index]);
    const dayComplete = mine.length > 0 && mine.every((leg) => leg.status === "known");
    const dayMinutes = mine.reduce((sum, leg) => sum + (leg.status === "known" ? leg.minutes : 0), 0);
    if (dayMinutes > maxDrive) {
      const kinds = [...new Set(mine.filter((leg) => leg.status === "known").map((leg) => leg.kind))].join(", ");
      const baseName = (morningLodging(index) || entrance)?.name || "this base";
      const coverage = dayComplete ? "driving" : "known driving, with another leg still unknown";
      conflicts.push({
        code: "long-drive",
        message: `${dates[index]} at ${baseName} is ${Math.round(dayMinutes)} minutes of ${coverage} (${kinds || "local"}), past your ${maxDrive} minute daily limit.`,
        suggestion: "Choose a closer base, drop a stop, or raise the daily driving limit.",
      });
    }
  }

  if (sawPending) {
    conflicts.push({
      code: "routes-pending",
      message: "Some driving legs are still loading. Totals stay incomplete until every requested leg returns.",
      suggestion: "Wait for the route request to finish before treating the day as timed.",
    });
  }

  const known = legs.filter((leg) => leg.status === "known");
  const complete = legs.length > 0 && legs.every((leg) => leg.status === "known");
  const byDate = dates.map((date) => {
    const mine = legs.filter((leg) => leg.date === date);
    const dayComplete = mine.every((leg) => leg.status === "known");
    const minutes = mine.reduce((sum, leg) => sum + (leg.status === "known" ? leg.minutes : 0), 0);
    return {
      date,
      minutes: dayComplete ? minutes : null,
      knownMinutes: minutes,
      complete: dayComplete,
      kinds: [...new Set(mine.map((leg) => leg.kind))],
    };
  });
  const longestDay = byDate.reduce((best, day) => ((day.knownMinutes || 0) > (best?.knownMinutes || 0) ? day : best), byDate[0] || null);
  const hikingMiles = (input.trails || []).reduce((sum, trail) => sum + (trail.miles || 0), 0);
  const missingHikeMiles = (input.trails || []).filter((trail) => trail.miles == null).length;
  return {
    days,
    conflicts,
    hikingMiles,
    missingHikeMiles,
    hikeMinutes,
    travel: {
      complete,
      miles: complete ? round1(known.reduce((sum, leg) => sum + leg.miles, 0)) : null,
      minutes: complete ? known.reduce((sum, leg) => sum + leg.minutes, 0) : null,
      knownMiles: round1(known.reduce((sum, leg) => sum + leg.miles, 0)),
      knownMinutes: known.reduce((sum, leg) => sum + leg.minutes, 0),
      legs,
      longestDay,
    },
  };
}
