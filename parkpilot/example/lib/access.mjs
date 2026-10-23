export const REMOTE_ACCESS = {
  isro: "Isle Royale has no road from the mainland. Ferries and seaplanes run seasonally from Michigan and Minnesota. Their fares are not in this driving budget.",
  chis: "Channel Islands National Park is reached by boat or plane from the Ventura coast. That crossing is not a driving route, and its fare is missing.",
  drto: "Dry Tortugas is reached by ferry or seaplane from Key West. There is no road to the park, so driving miles and fuel stay blank.",
  npsa: "The National Park of American Samoa is reached by air and local boat. A mainland driving route would be invented, so fuel stays blank.",
  viis: "Virgin Islands National Park is on St. John. The usual access is a flight to St. Thomas and a ferry. Those fares are missing from the driving budget.",
  glba: "Glacier Bay is reached by boat or plane. A road route is not the access, so driving miles and fuel stay blank.",
  katm: "Katmai has no road access. Travel is by plane and boat, and those fares are missing.",
  kova: "Kobuk Valley has no road access. Driving miles and fuel stay blank.",
  gaar: "Gates of the Arctic has no road access. Travel is by air, and that fare is missing.",
  lacl: "Lake Clark has no road access. Travel is by air and boat, and those fares are missing.",
};

export function remoteAccessNote(code) {
  return REMOTE_ACCESS[code] || null;
}
