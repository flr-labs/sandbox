const retrievedAt = "2026-10-22T00:00:00.000Z";

export function fixtureAreas() {
  return [
    {
      id: "fixture-springdale",
      name: "Springdale",
      reference: { name: "Springdale town reference", lat: 37.1889, lon: -112.9986 },
      source: "Development fixture, not a live place catalog",
      retrievedAt,
      fixture: true,
    },
    {
      id: "fixture-hurricane",
      name: "Hurricane",
      reference: { name: "Hurricane town reference", lat: 37.1753, lon: -113.2899 },
      source: "Development fixture, not a live place catalog",
      retrievedAt,
      fixture: true,
    },
    {
      id: "fixture-kanab",
      name: "Kanab",
      reference: { name: "Kanab town reference", lat: 37.0475, lon: -112.5263 },
      source: "Development fixture, not a live place catalog",
      retrievedAt,
      fixture: true,
    },
  ];
}
