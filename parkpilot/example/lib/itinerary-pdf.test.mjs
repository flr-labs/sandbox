import assert from "node:assert/strict";
import test from "node:test";
import { buildItineraryPdf } from "./itinerary-pdf.mjs";

test("itinerary pdf is a downloadable document with the saved rows", () => {
  const bytes = buildItineraryPdf({
    kicker: "ParkPilot",
    title: "Itinerary",
    subtitle: "Zion National Park · Oct 24–26, 2026 · 3 days",
    sections: [
      { heading: "Stay", paragraphs: ["Springdale", "Selecting this place does not reserve it."] },
      { heading: "Weather", cards: [{ title: "Oct 24, 2026", body: "72° Sunny" }] },
      {
        heading: "Itinerary",
        table: {
          headers: ["Date", "Trail", "Level", "Distance", "Time", "Suggested start"],
          rows: [["Oct 24, 2026", "Angels Landing", "Strenuous", "5.4 mi", "4 hours", "7:30 a.m. · drive not included"]],
        },
      },
      { heading: "Packing", cards: [{ title: "Apparel: Hat", body: "Added by you." }] },
    ],
    footer: "This is a trip note, not a reservation or a booking.",
  });
  const pdf = Buffer.from(bytes).toString("latin1");
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /%%EOF$/);
  assert.match(pdf, /Angels Landing/);
  assert.match(pdf, /Springdale/);
  assert.doesNotMatch(pdf, /Estimated gas|Total driving/);
  const start = pdf.lastIndexOf("startxref\n") + "startxref\n".length;
  const xref = Number(pdf.slice(start).split("\n", 1)[0]);
  assert.match(pdf.slice(xref, xref + 12), /^xref\n0 /);
  assert.match(pdf.slice(pdf.indexOf("0000000000") > 0 ? pdf.indexOf("1 0 obj") : -1), /^1 0 obj/);
});
