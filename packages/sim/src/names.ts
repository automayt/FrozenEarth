import type { Rng } from './rng';

const FIRST = [
  'Ada', 'Bram', 'Cora', 'Dax', 'Edda', 'Finn', 'Greta', 'Hale', 'Ivy', 'Jory', 'Kesh', 'Lena', 'Mako', 'Nell',
  'Orin', 'Pia', 'Quill', 'Rhea', 'Soren', 'Tova', 'Ulf', 'Vera', 'Wren', 'Yara', 'Zeke', 'Astrid', 'Bo',
  'Calla', 'Dov', 'Esk', 'Frey', 'Gus', 'Hild', 'Ines', 'Joss', 'Kai', 'Liv', 'Moss', 'Nils', 'Oda',
];

const LAST = [
  'Frost', 'Ember', 'Rook', 'Vale', 'Thorn', 'Hollow', 'Marsh', 'Stone', 'Birch', 'Crane', 'Drift', 'Fell',
  'Grey', 'Hearth', 'Isle', 'Kettle', 'Lark', 'Moor', 'North', 'Pike', 'Rime', 'Sleet', 'Tarn', 'Wick',
];

export function pawnName(rng: Rng): string {
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

export const FACTION_COLORS = [0xe0533a, 0x3a9ae0, 0x5ac24a, 0xe0b43a, 0xb05ae0, 0x3ad0c0, 0xe07ab4, 0xa0a0a0];
