// Ordering uses these weights. Displayed miles and minutes are unweighted sums.
// A lower score is better. Incomplete routes are not scored.
export const LODGING_DEFAULTS = {
  weights: {
    totalMinutes: 1,
    longestDayMinutes: 1.25,
    activityMinutes: 1,
    arrivalDepartureMinutes: 0.7,
    changePenaltyMinutes: 75,
  },
  maxAreas: 3,
  defaultMaxDailyDriveMinutes: 180,
  splitStay: {
    minimumSavingsMinutes: 40,
    relocationAllowanceMinutes: 30,
    checkInMinutes: 20,
    checkOutMinutes: 15,
  },
};

export function mergeLodgingDefaults(overrides = {}) {
  return {
    ...LODGING_DEFAULTS,
    ...overrides,
    weights: { ...LODGING_DEFAULTS.weights, ...overrides.weights },
    splitStay: { ...LODGING_DEFAULTS.splitStay, ...overrides.splitStay },
  };
}
