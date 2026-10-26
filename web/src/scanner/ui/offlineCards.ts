// What a tray row shows when the printings route cannot be reached: the name, set code, number and art of the cached
// number table (the table the recognizer reads), so an offline tray still lists its cards.
import { inflateCardTable, parseCardTable } from "../recognize/cardTable";
import { SCANNER_CACHE } from "../worker/messages";

export type CardFace = {
  name: string;
  setCode: string | null;
  number: string;
  image: string | null;
};

export async function readCardFaces(
  cardsKey: string
): Promise<(printingId: string) => CardFace | null> {
  const none = () => null;
  try {
    const cache = await caches.open(SCANNER_CACHE);
    const hit = await cache.match(cardsKey);
    if (!hit) return none;
    const db = parseCardTable(await inflateCardTable(await hit.arrayBuffer()));
    return (id) => {
      const row = db.rowOf.get(id);
      if (row === undefined) return null;
      return {
        name: db.names[row],
        setCode: db.sets[db.setOfRow[row]].code,
        number: db.numbers[row],
        image: db.images[row],
      };
    };
  } catch {
    return none;
  }
}
