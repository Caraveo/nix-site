import { HttpError } from "./validate.js";

export const PACKS = {
  pack100: { id: "pack100", units: 100, amount: "2.99" },
  pack500: { id: "pack500", units: 500, amount: "12.99" },
  pack2000: { id: "pack2000", units: 2000, amount: "39.99" },
};

const ALIASES = {
  pack100: "pack100",
  "100": "pack100",
  small: "pack100",
  pack500: "pack500",
  "500": "pack500",
  medium: "pack500",
  pack2000: "pack2000",
  "2000": "pack2000",
  large: "pack2000",
};

export function requirePack(value) {
  const id = ALIASES[String(value || "").trim().toLowerCase()];
  if (!id) throw new HttpError(400, "unknown_pack");
  return PACKS[id];
}

export function publicPacks() {
  return Object.values(PACKS).map((pack) => ({
    id: pack.id,
    units: pack.units,
    amount: pack.amount,
    currency: "USD",
  }));
}
