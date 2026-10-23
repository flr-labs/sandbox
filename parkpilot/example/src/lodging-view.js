function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function hoursLabel(mins) {
  if (mins == null || Number.isNaN(Number(mins))) return "Not calculated";
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  if (!hour) return `${minute} min`;
  if (!minute) return `${hour} hr`;
  return `${hour} hr ${minute} min`;
}

function legLines(legs) {
  if (!legs?.length) return "<li>No driving legs were built for this option.</li>";
  return legs.map((leg) => {
    const time = leg.status === "known" ? `${leg.miles} mi, ${hoursLabel(leg.minutes)}` : leg.status === "pending" ? "Still loading" : "Unknown";
    return `<li>${esc(leg.kind)}: ${esc(leg.fromName)} to ${esc(leg.toName)} · ${esc(time)}</li>`;
  }).join("");
}

function firstFit(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || /missing road|not verified|not shown as zero|no verified time/i.test(value)) return "";
  return value;
}

function disadvantage(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || /missing|unknown|incomplete|not shown as zero|not treated as shorter|lowest calculated|lowest total|less driving|same calculated/i.test(value)) return "";
  return value;
}

function travelSummary(area) {
  if (area.complete === false) return "";
  const text = String(area.travelImpact || area.distanceLabel || "").replace(/\s+/g, " ").trim();
  if (!text || /incomplete|missing|not verified|not calculated/i.test(text)) return "";
  return text;
}

function whyLine(area, index, maxMiles) {
  const limit = maxMiles ? `${maxMiles} mi` : "your";
  if (area.outside) {
    if (area.parkMiles != null) return `Just outside the ${limit} drive limit, ${area.parkMiles} mi by road from the entrance.`;
    return `Just outside the ${limit} drive limit. Road miles are not verified.`;
  }
  const grounded = firstFit(area.reason);
  if (grounded && !/miles by road from the town reference/i.test(grounded)) return grounded;
  if (area.parkMiles != null) {
    return index === 0
      ? `Recommended base inside the ${limit} drive limit, ${area.parkMiles} mi by road from the entrance.`
      : `Another stay inside the ${limit} drive limit, ${area.parkMiles} mi by road from the entrance.`;
  }
  return "";
}

function fromParkLine(area) {
  if (area.parkDistance) return area.parkDistance;
  if (area.parkStraight) return `${area.parkStraight}. Road miles are not verified.`;
  return "";
}

function measure(metrics, label) {
  if (!metrics) return `${label}: not calculated`;
  if (!metrics.complete && metrics.miles == null && metrics.totalMiles == null && metrics.minutes == null && metrics.totalMinutes == null) {
    const known = metrics.knownMiles ?? metrics.knownMinutes;
    return known ? `${label}: incomplete. Known portion ${metrics.knownMiles ?? "—"} mi, not a full estimate.` : `${label}: not calculated`;
  }
  const miles = metrics.totalMiles ?? metrics.miles;
  const minutes = metrics.totalMinutes ?? metrics.minutes;
  if (miles == null || minutes == null) {
    return `${label}: incomplete. Known portion ${metrics.knownMiles ?? "—"} mi. Missing time is not zero.`;
  }
  return `${label}: ${miles} mi, ${hoursLabel(minutes)}`;
}

export function lodgingHtml(ctx) {
  if (!ctx) return "";
  const listed = ctx.areas || [];
  const primary = listed.filter((area) => !area.outside).slice(0, 3);
  const outside = listed.filter((area) => area.outside).slice(0, 2);
  const stayCard = (area, index) => {
    const incomplete = area.complete === false;
    const why = whyLine(area, index, ctx.maxMiles);
    const fromPark = fromParkLine(area);
    const travel = fromPark ? "" : travelSummary(area);
    const tradeoff = incomplete || area.outside ? "" : disadvantage(area.tradeoff);
    const photo = area.image
      ? `<img src="${esc(area.image)}" alt="${esc(area.imageAlt || `${area.name} photograph`)}" referrerpolicy="no-referrer" />`
      : `<div class="photo-miss">No photograph for this area</div>`;
    const credit = area.image ? (area.imageCredit || "Photo credit not on this record") : "No photograph for this area";
    const addClass = area.selected ? "is-on" : area.review ? "" : "is-primary";
    return `<article class="stay-card ${area.focused ? "is-on" : ""} ${area.selected ? "is-selected" : ""}" data-stay-card="${esc(area.focusId)}">
      <figure class="stay-photo">
        <div class="stay-frame">${photo}</div>
        <figcaption class="trail-credit">${esc(credit)}</figcaption>
      </figure>
      <div class="stay-body">
        <p class="eyebrow">${area.outside ? "Just outside" : index === 0 ? "Recommended stay" : "Alternative"}</p>
        <h3>${esc(area.name)}</h3>
        <p class="stay-dates">${esc(area.staySpan || "Overnight dates come from the trip.")}</p>
        ${area.fixture ? `<span class="badge est">Development fixture</span>` : ""}
        ${why ? `<p><strong>Why it fits:</strong> ${esc(why)}</p>` : ""}
        ${fromPark ? `<p><strong>From the park:</strong> ${esc(fromPark)}</p>` : ""}
        ${incomplete ? `<p class="stay-status">Travel estimates incomplete.</p>` : travel ? `<p><strong>Travel:</strong> ${esc(travel)}</p>` : ""}
        ${tradeoff ? `<p><strong>Tradeoff:</strong> ${esc(tradeoff)}</p>` : ""}
        ${area.conflicts ? `<p class="stay-status">${esc(area.conflicts)}</p>` : ""}
        <details class="trail-sources" ${ctx.openDetails?.[area.id] ? "open" : ""} data-keep="${esc(area.id)}">
          <summary>Travel details & sources</summary>
          <div class="trail-source-body">
            <p><strong>From the park.</strong> ${esc(fromPark || "Distance to the park entrance is not verified.")}</p>
            ${incomplete ? `<p>A required road leg has no verified time. Missing time is not counted as zero.</p>` : ""}
            <ul class="note-list">${legLines(area.legs)}</ul>
            ${area.longestLabel ? `<p>${esc(area.longestLabel)}</p>` : ""}
            <p>${esc(area.estimate || "")} Reference: ${esc(area.referenceName)}. ${esc(area.entranceLabel || "")}</p>
            <p>${esc(area.source)} · ${esc(area.fresh)}</p>
          </div>
        </details>
      </div>
      <div class="stay-actions">
        <button class="stay-action ${addClass}" type="button" data-action="use-area" data-id="${esc(area.id)}" aria-pressed="${area.selected}">${area.selected ? "Added to itinerary" : area.review ? "Review this change" : "Add to itinerary"}</button>
        <button class="stay-action" type="button" data-action="focus-stay" data-id="${esc(area.focusId)}">View on map</button>
      </div>
    </article>`;
  };
  const cards = primary.map((area, index) => stayCard(area, index)).join("");
  const outsideCards = outside.map((area) => stayCard(area, 1)).join("");
  const split = ctx.split ? `<article class="stay-card stay-split">
      <h3>Split stay: ${esc(ctx.split.name)}</h3>
      <p>${ctx.split.suggested ? "This split is one plan: two bases, the nights below, and the driving change after relocation, check-in, and check-out allowances." : "A split was compared with one base. It is not recommended, because the savings do not clear the allowance threshold or a route is incomplete."}</p>
      <p>${esc(ctx.split.math)}</p>
      <p class="meta">Nights: ${esc(ctx.split.nights)}</p>
      <div class="trail-actions"><button class="btn" type="button" data-action="use-split">${ctx.split.suggested ? "Review this split" : "Review the comparison"}</button></div>
      <details ${ctx.openDetails?.split ? "open" : ""} data-keep="split">
        <summary>Travel details & sources</summary>
        <ul class="note-list">${legLines(ctx.split.legs)}</ul>
      </details>
    </article>` : "";
  const proposal = ctx.proposal ? `<div class="block" role="region" aria-label="Proposed lodging change">
      <strong>Proposed change.</strong>
      <p>${esc(ctx.proposal.summary)}</p>
      <p>${esc(ctx.proposal.before)}</p>
      <p>${esc(ctx.proposal.after)}</p>
      <p class="meta">Affected nights: ${esc(ctx.proposal.nights)}. Canceling leaves the current plan in place.</p>
      <div class="trail-actions">
        <button class="btn primary" type="button" data-action="accept-proposal">Use this change</button>
        <button class="btn" type="button" data-action="dismiss-proposal">Keep the current plan</button>
      </div>
    </div>` : "";
  const help = `<div aria-live="polite">
      ${ctx.areaMessage ? `<p class="meta">${esc(ctx.areaMessage)}</p>` : ""}
      <div class="stay-grid">${cards}${ctx.split?.suggested ? split : ""}</div>
      ${outsideCards ? `<p class="stay-outside-title">Just outside your drive limit</p><div class="stay-grid">${outsideCards}</div>` : ""}
      ${ctx.split && !ctx.split.suggested ? split : ""}
      ${ctx.areaStatus === "error" || ctx.areaStatus === "empty" ? `<div class="trail-actions"><button class="btn" type="button" data-action="load-fixture">Load labeled sample areas</button></div>` : ""}
    </div>`;
  return `<div class="route-section" id="where-to-stay">
    <p class="lede">Choose a base that fits your trails and travel plans.</p>
    <p class="meta">Selecting an area does not reserve it. An exact property and a booking you confirm are separate steps.</p>
    ${ctx.accessNote ? `<p class="block">${esc(ctx.accessNote)}</p>` : ""}
    <p class="meta">${esc(ctx.tripSpan || "")}${ctx.groupSize ? ` · Group of ${esc(ctx.groupSize)}` : ""}${ctx.maxMiles ? ` · Within ${esc(ctx.maxMiles)} mi of the park` : ""}${ctx.maxHours ? ` · ${esc(ctx.maxHours)} hr daily driving limit` : ""}</p>
    ${help}
    ${proposal}
    <p class="meta">${esc(ctx.legNote || "")}</p>
  </div>`;
}

export { hoursLabel, measure };
