export function fuelCost(miles, mpg, pricePerGallon) {
  if (miles == null || !Number.isFinite(Number(miles))) return null;
  if (!(Number(mpg) > 0) || !(Number(pricePerGallon) > 0)) return null;
  return Math.round((Number(miles) / Number(mpg)) * Number(pricePerGallon) * 100) / 100;
}

export function numbersAreGrounded(text, packet) {
  const allowed = new Set(["0"]);
  const walk = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      allowed.add(String(value));
      allowed.add(String(Math.round(value)));
      allowed.add(value.toFixed(1));
      allowed.add(value.toFixed(2));
    } else if (typeof value === "string") {
      for (const match of value.matchAll(/\d+(?:\.\d+)?/g)) allowed.add(match[0]);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(packet);
  return [...String(text).matchAll(/\d+(?:\.\d+)?/g)].every((match) => allowed.has(match[0]));
}
