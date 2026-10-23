import { buildItinerary } from "./schedule.mjs";
import { mergeLodgingDefaults } from "./lodging-defaults.mjs";
import { pointKey } from "./legs.mjs";

export const STATUS_LABEL = {
  empty: "Not set",
  area: "Area selected",
  property: "Exact property selected",
  confirmed: "Booking confirmed by you",
};

export function nightStatus(night) {
  if (!night || (!night.area && !night.property)) return "empty";
  if (night.confirmed) return "confirmed";
  if (night.property) return "property";
  return "area";
}

export function routingPlace(night) {
  if (!night) return null;
  if (night.property && Number.isFinite(Number(night.property.lat)) && Number.isFinite(Number(night.property.lon))) {
    return {
      id: night.property.id || `property:${night.property.label}`,
      name: night.property.label || night.property.name || "Property",
      label: night.property.label || night.property.name || "Property",
      lat: Number(night.property.lat),
      lon: Number(night.property.lon),
      role: "lodging",
      estimate: "property",
      referenceName: night.area?.reference?.name || night.area?.name || "",
    };
  }
  const reference = night.area?.reference;
  if (!reference || !Number.isFinite(Number(reference.lat)) || !Number.isFinite(Number(reference.lon))) return null;
  return {
    id: night.area.id,
    name: night.area.name,
    label: reference.name || night.area.name,
    lat: Number(reference.lat),
    lon: Number(reference.lon),
    role: "lodging",
    estimate: "area",
    referenceName: reference.name || night.area.name,
  };
}

export function assignArea(nights, dates, area) {
  const next = { ...nights };
  for (const date of dates) {
    const prev = nights[date] || {};
    if (prev.confirmed) continue;
    next[date] = { status: "area", area, property: null, confirmed: false };
  }
  return next;
}

export function assignProperty(nights, dates, property) {
  const next = { ...nights };
  for (const date of dates) {
    const prev = nights[date] || {};
    if (prev.confirmed) continue;
    next[date] = {
      status: "property",
      area: prev.area || null,
      property: { ...property, confirmed: false },
      confirmed: false,
    };
  }
  return next;
}

export function confirmBooking(nights, date, confirmed) {
  const prev = nights[date];
  if (!prev || (!prev.area && !prev.property)) return nights;
  const on = Boolean(confirmed);
  return {
    ...nights,
    [date]: {
      ...prev,
      confirmed: on,
      status: on ? "confirmed" : (prev.property ? "property" : "area"),
    },
  };
}

export function applyProposal(nights, proposal) {
  if (!proposal) return nights;
  if (proposal.kind === "split") {
    const next = { ...nights };
    for (const assignment of proposal.assignments || []) {
      const prev = next[assignment.date] || {};
      if (prev.confirmed) continue;
      next[assignment.date] = { status: "area", area: assignment.area, property: null, confirmed: false };
    }
    return next;
  }
  return assignArea(nights, proposal.dates || [], proposal.area);
}

export function areasFromCatalog(venues, geocodedLocalities, { retrievedAt, source, limit = 3, preferred = [] } = {}) {
  const counts = new Map();
  for (const venue of venues || []) {
    const name = String(venue.locality || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const row = counts.get(key) || { name, count: 0, region: venue.region || "" };
    row.count += 1;
    if (!row.region && venue.region) row.region = venue.region;
    counts.set(key, row);
  }
  const preferredNames = new Set(preferred.map((name) => String(name).toLowerCase()));
  const ordered = [...counts.values()].sort((a, b) => {
    const rank = (row) => (preferredNames.has(row.name.toLowerCase()) ? 0 : 1);
    return rank(a) - rank(b) || b.count - a.count || a.name.localeCompare(b.name);
  });
  const areas = [];
  const skipped = [];
  for (const row of ordered) {
    if (areas.length >= limit) break;
    const geo = (geocodedLocalities || []).find((item) => item.name?.toLowerCase() === row.name.toLowerCase());
    if (!geo || !Number.isFinite(Number(geo.lat)) || !Number.isFinite(Number(geo.lon))) {
      skipped.push(row.name);
      continue;
    }
    areas.push({
      id: `area-${row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      name: row.name,
      reference: { name: geo.label || `${row.name} reference`, lat: Number(geo.lat), lon: Number(geo.lon) },
      venueCount: row.count,
      source,
      retrievedAt,
      fixture: false,
    });
  }
  return { areas, skipped };
}

function areaPoint(area) {
  return {
    id: area.id,
    name: area.name,
    label: area.reference?.name || area.name,
    lat: Number(area.reference?.lat),
    lon: Number(area.reference?.lon),
    role: "lodging",
  };
}

function metricsOf(plan, weights) {
  const travel = plan.travel;
  const legs = travel?.legs || [];
  const activityMinutes = legs
    .filter((leg) => leg.status === "known" && (leg.fromRole === "trail" || leg.toRole === "trail"))
    .reduce((sum, leg) => sum + leg.minutes, 0);
  const arrivalMinutes = legs.filter((leg) => leg.kind === "arrival" && leg.status === "known").reduce((sum, leg) => sum + leg.minutes, 0);
  const departureMinutes = legs.filter((leg) => leg.kind === "departure" && leg.status === "known").reduce((sum, leg) => sum + leg.minutes, 0);
  const changes = legs.filter((leg) => leg.kind === "transfer").length;
  const longest = travel?.longestDay || { date: "", minutes: null, complete: false, kinds: [] };
  const complete = Boolean(travel?.complete);
  const score = complete
    ? travel.minutes * weights.totalMinutes
      + (longest.minutes || 0) * weights.longestDayMinutes
      + activityMinutes * weights.activityMinutes
      + (arrivalMinutes + departureMinutes) * weights.arrivalDepartureMinutes
      + changes * weights.changePenaltyMinutes
    : null;
  return {
    complete,
    score,
    totalMinutes: complete ? travel.minutes : null,
    totalMiles: complete ? travel.miles : null,
    knownMinutes: travel?.knownMinutes ?? 0,
    knownMiles: travel?.knownMiles ?? 0,
    longestDay: longest,
    activityMinutes: complete ? activityMinutes : null,
    arrivalMinutes: complete ? arrivalMinutes : null,
    departureMinutes: complete ? departureMinutes : null,
    changes,
    coverage: {
      known: legs.filter((leg) => leg.status === "known").length,
      total: legs.length,
    },
  };
}

function evaluatePlan(baseInput, nightByDate, relocationMin) {
  return buildItinerary({
    ...baseInput,
    stay: {
      ...baseInput.stay,
      nightByDate,
      relocationMin,
    },
  });
}

function tradeoffText(area, leader) {
  if (!area.metrics.complete) return "Missing road time stays unknown, so this option is not treated as shorter.";
  if (!leader || leader.id === area.id) return "Lowest calculated driving of the complete options.";
  if (leader.metrics.totalMinutes == null || area.metrics.totalMinutes == null) return "The comparison is incomplete.";
  const delta = area.metrics.totalMinutes - leader.metrics.totalMinutes;
  if (delta === 0) return `Same calculated driving time as ${leader.name}.`;
  if (delta > 0) return `${delta} minutes more driving than ${leader.name}.`;
  return `${Math.abs(delta)} minutes less driving than ${leader.name}.`;
}

function reasonText(area, provisional, trailCount) {
  if (!area.metrics.complete) return "A required road leg has no verified time, so this plan is not treated as shorter.";
  const arrival = (area.metrics.longestDay?.kinds || []).some((kind) => kind === "arrival" || kind === "departure");
  if (area.conflicts.some((conflict) => conflict.code === "long-drive")) {
    return arrival
      ? "The long day includes the drive to or from the park, and that driving is past the daily limit."
      : "At least one day of driving is past the daily limit.";
  }
  if (provisional) return "Based on the start and the dates. Selected trails are not in this comparison yet.";
  if (area.leader) return trailCount ? `Lowest total driving for the ${trailCount} scheduled ${trailCount === 1 ? "trail" : "trails"}.` : "Lowest total driving among the complete options.";
  return "A complete road comparison for the scheduled stops.";
}

export function recommendStays(input) {
  const defaults = mergeLodgingDefaults(input.defaults);
  const nights = input.nights || [];
  const provisional = !(input.trails || []).length;
  if (input.remoteAccess) {
    return {
      areas: [],
      split: null,
      provisional,
      blocked: input.remoteAccess,
      defaults,
      nights,
    };
  }
  const maxDaily = Number(input.maxDailyDriveMin) > 0 ? Number(input.maxDailyDriveMin) : defaults.defaultMaxDailyDriveMinutes;
  const baseInput = {
    startDate: input.startDate,
    dayCount: input.dayCount,
    departTime: input.departTime,
    returnBy: input.returnBy,
    airport: input.airport,
    landingTime: input.landingTime,
    bufferMin: input.bufferMin,
    roundTrip: input.roundTrip,
    sunsetByDate: input.sunsetByDate || {},
    originPoint: input.origin,
    entrancePoint: input.entrance,
    trails: input.trails || [],
    stay: {
      legBook: input.legBook || {},
      checkInMin: defaults.splitStay.checkInMinutes,
      checkOutMin: defaults.splitStay.checkOutMinutes,
      relocationMin: 0,
      maxDailyDriveMin: maxDaily,
    },
  };
  const candidates = (input.candidates || []).slice(0, defaults.maxAreas);
  const evaluated = candidates.map((area) => {
    const point = areaPoint(area);
    const nightByDate = Object.fromEntries(nights.map((date) => [date, point]));
    const plan = evaluatePlan(baseInput, nightByDate, 0);
    const metrics = metricsOf(plan, defaults.weights);
    return {
      ...area,
      point,
      metrics,
        conflicts: plan.conflicts || [],
        legs: plan.travel?.legs || [],
        nights: nights.map((date) => ({ date, areaId: area.id, name: area.name })),
      };
    });
  const complete = evaluated.filter((area) => area.metrics.complete);
  complete.sort((a, b) => a.metrics.score - b.metrics.score || a.name.localeCompare(b.name));
  const incomplete = evaluated.filter((area) => !area.metrics.complete);
  const areas = [...complete, ...incomplete];
  const leader = complete[0] || null;
  if (leader) leader.leader = true;
  for (const area of areas) {
    area.tradeoff = tradeoffText(area, leader);
    area.reason = reasonText(area, provisional, (input.trails || []).length);
    area.provisional = provisional;
  }

  let split = null;
  if (nights.length >= 2 && candidates.length >= 2) {
    const cut = Math.ceil(nights.length / 2);
    let best = null;
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = 0; j < candidates.length; j += 1) {
        if (i === j) continue;
        const first = candidates[i];
        const second = candidates[j];
        const nightByDate = {};
        const assignments = nights.map((date, index) => {
          const area = index < cut ? first : second;
          nightByDate[date] = areaPoint(area);
          return { date, area, areaId: area.id, name: area.name };
        });
        const plan = evaluatePlan(baseInput, nightByDate, defaults.splitStay.relocationAllowanceMinutes);
        const metrics = metricsOf(plan, defaults.weights);
        const option = { first, second, assignments, metrics, conflicts: plan.conflicts || [], legs: plan.travel?.legs || [], changes: assignments.reduce((count, assignment, index) => (index > 0 && assignment.areaId !== assignments[index - 1].areaId ? count + 1 : count), 0) };
        if (!best || (option.metrics.complete && (!best.metrics.complete || option.metrics.totalMinutes < best.metrics.totalMinutes))) best = option;
      }
    }
    if (best) {
      const allowance = defaults.splitStay.relocationAllowanceMinutes + defaults.splitStay.checkInMinutes + defaults.splitStay.checkOutMinutes;
      const savings = leader?.metrics.complete && best.metrics.complete ? leader.metrics.totalMinutes - best.metrics.totalMinutes : null;
      const net = savings == null ? null : savings - allowance;
      const suggested = net != null && net >= defaults.splitStay.minimumSavingsMinutes;
      split = {
        suggested,
        name: `${best.first.name} then ${best.second.name}`,
        assignments: best.assignments,
        metrics: best.metrics,
        conflicts: best.conflicts,
        savingsMinutes: savings,
        allowanceMinutes: allowance,
        netMinutes: net,
        thresholdMinutes: defaults.splitStay.minimumSavingsMinutes,
        allowances: defaults.splitStay,
        changes: best.changes,
        provisional,
      };
    }
  }

  return { areas, split, provisional, blocked: "", defaults, nights, leaderId: leader?.id || "" };
}

export function proposalFrom(ranking, selectedId) {
  if (!ranking || !selectedId) return null;
  const proposed = ranking.areas.find((area) => area.metrics.complete);
  if (!proposed || proposed.id === selectedId) return null;
  const current = ranking.areas.find((area) => area.id === selectedId);
  return {
    kind: "ranking",
    selectedId,
    proposedId: proposed.id,
    proposedName: proposed.name,
    area: proposed,
    dates: ranking.nights || [],
    before: current?.metrics || null,
    after: proposed.metrics,
    affectedNights: ranking.nights || [],
  };
}

export function sameReference(left, right) {
  return pointKey(left) != null && pointKey(left) === pointKey(right);
}
