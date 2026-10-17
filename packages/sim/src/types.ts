import type { ItemCategory, SkillKey, WorkType } from '@fe/defs';

export type EntityId = number;
export type Kind = 'pawn' | 'item' | 'plant' | 'building' | 'construct';

/** Faction id 0 means "nobody". Real factions start at 1. */
export const NO_FACTION = 0;

interface Base {
  id: EntityId;
  x: number;
  y: number;
  faction: number;
}

export interface Item extends Base {
  kind: 'item';
  def: string;
  count: number;
  /** 0 = fresh, 1 = rotten. Only for items with spoilDays. */
  rot: number;
}

export interface Plant extends Base {
  kind: 'plant';
  def: string;
  growth: number;
  /** Set when a blight is killing it. */
  blighted?: boolean;
}

export type BillMode = 'count' | 'forever' | 'until';

export interface Bill {
  id: number;
  recipe: string;
  mode: BillMode;
  /** For "count": how many more times. For "until": the stock level to keep. */
  target: number;
  suspended: boolean;
}

export interface Building extends Base {
  kind: 'building';
  def: string;
  /** Pawn who claimed this bed, or 0. */
  owner: EntityId;
  bills: Bill[];
  /** Hit points left; at 0 the building is wrecked. Full is maxHp(def). */
  hp: number;
}

export interface Construct extends Base {
  kind: 'construct';
  def: string;
  delivered: Record<string, number>;
  progress: number;
}

export interface PathState {
  /** Cell indices to walk through, excluding the start cell. */
  cells: number[];
  /** Absolute tick at which the pawn arrives in each cell. */
  times: number[];
  idx: number;
  goal: number;
  adj: boolean;
  /** Tick and cell the walk started from, for client interpolation. */
  t0: number;
  fx: number;
  fy: number;
}

export interface Needs {
  food: number;
  rest: number;
  mood: number;
}

/** An active health condition on a pawn. */
export interface PawnCondition {
  key: string;
  severity: number;
  immunity: number;
  /** Tick when a timed condition ends, or 0. */
  until: number;
  /** Wounds: tend quality (0-1) once a doctor has dressed them. Absent while untended. */
  tended?: number;
  /** Worst stage already announced in a letter, so wavering doesn't repeat it. */
  told?: number;
}

export interface PawnSkill {
  level: number;
  xp: number;
}

export interface Carried {
  def: string;
  count: number;
  rot: number;
}

export interface Pawn extends Base {
  kind: 'pawn';
  name: string;
  needs: Needs;
  priorities: Record<WorkType, number>;
  job: Job | null;
  path: PathState | null;
  carrying: Carried | null;
  bed: EntityId;
  asleep: boolean;
  conditions: PawnCondition[];
  traits: string[];
  // -- clothing and skills
  /** Worn apparel item keys, one per slot. */
  apparel: string[];
  skills: Record<SkillKey, PawnSkill>;
  /** Short mood explanations, for the inspect pane. */
  thoughts: string[];
  /** Equipped weapon key; '' = fists. */
  weapon: string;
  /** Under direct player control: no work, no needs-driven jobs, only orders. */
  drafted: boolean;
  /** Knocked down by pain or blood loss: can't move or act. */
  downed: boolean;
  /** Captured raiders: 'held' in the colony, or 'leaving' once released. '' for everyone else. */
  prisoner: PrisonerState;
  /** Wild animals: which kind (see ANIMALS). Absent for people. */
  species?: string;
  /** Animals: whoever last hurt them, to flee from or turn on. */
  aggro?: EntityId;
  /** Animals: the colony whose hunters are after it. */
  hunted?: number;
  /** Moving quietly: slower, harder to see and hear. */
  sneaking?: boolean;
  /** Steered directly by its player (WASD), not by orders. */
  possessed?: boolean;
  /** Held steering direction while possessed. */
  steer?: [dx: number, dy: number];
  /** Someone this pawn couldn't find a way to attack, and until when it leaves them be. */
  giveUp?: [target: EntityId, until: number];
}

export type PrisonerState = '' | 'held' | 'leaving';

export type Entity = Pawn | Item | Plant | Building | Construct;

interface JobBase {
  stage: number;
}

export type Job =
  | (JobBase & { type: 'wander'; dest: number; until: number })
  | (JobBase & { type: 'haul'; item: EntityId; dest: number; /** Settlement or colony the goods were taken from, while the thief is still at risk. */ stolen?: number; /** Where they were taken from. */ stolenAt?: number })
  | (JobBase & { type: 'deliver'; item: EntityId; target: EntityId; count: number })
  | (JobBase & { type: 'build'; target: EntityId })
  | (JobBase & { type: 'mine'; cell: number; progress: number })
  | (JobBase & { type: 'cut'; target: EntityId; progress: number; harvest: boolean })
  | (JobBase & { type: 'sow'; cell: number; plant: string; progress: number })
  | (JobBase & { type: 'eat'; item: EntityId; count: number; progress: number })
  | (JobBase & { type: 'sleep'; bed: EntityId; cell: number; rest?: boolean })
  | (JobBase & { type: 'extinguish'; cell: number; progress: number })
  | (JobBase & { type: 'warm'; dest: number; until: number })
  | (JobBase & { type: 'wear'; item: EntityId; slot: string })
  /**
   * Fight a pawn. `forced` = an explicit player order (keeps hitting a downed target);
   * `chase` = walk after the target instead of giving up when it is out of reach.
   */
  | (JobBase & { type: 'attack'; target: EntityId; forced: boolean; chase: boolean; next: number; until: number; /** A covered cell to shoot from, once picked (-1 = none worth it). */ spot?: number })
  | (JobBase & { type: 'ignite'; cell: number })
  /** Drafted: walk to a cell and hold there. */
  | (JobBase & { type: 'goto'; dest: number })
  | (JobBase & { type: 'control'; /** Goods taken by hand from someone's stockpile, while still at risk. */ stolen?: number; stolenAt?: number })
  /** Drafted: stand ready, shooting hostiles in range. Ends now and then to rescan. */
  | (JobBase & { type: 'hold'; until: number })
  | (JobBase & { type: 'tend'; patient: EntityId; progress: number })
  /** Raiders leaving the map, optionally grabbing loot on the way. */
  | (JobBase & { type: 'flee'; dest: number; item: EntityId })
  /** Raiders smashing a wall or door (or sappers digging rock) that stands between them and the colony. */
  | (JobBase & { type: 'bash'; cell: number; next: number; progress: number; until: number })
  /** Mend a damaged building. */
  | (JobBase & { type: 'repair'; target: EntityId })
  /** Carry a downed pawn to a bed: a colony-mate to recover, or (`capture`) a raider to hold prisoner. */
  | (JobBase & { type: 'rescue'; patient: EntityId; bed: EntityId; capture: boolean })
  /** Pick up a weapon item and wield it (dropping the old one), or with item 0 just drop the current one. */
  | (JobBase & { type: 'equip'; item: EntityId })
  /** Bring food to a patient who can't get up for it, and feed them. */
  | (JobBase & { type: 'feed'; patient: EntityId; item: EntityId; count: number; progress: number })
  | (JobBase & {
      type: 'bill';
      bench: EntityId;
      bill: number;
      sources: { item: EntityId; count: number }[];
      gathered: Carried[];
      progress: number;
    });

export type JobType = Job['type'];

export type ZoneKind = 'stockpile' | 'grow';

export interface Zone {
  id: number;
  faction: number;
  kind: ZoneKind;
  cells: number[];
  /** Grow zones: what to plant. */
  plant: string;
  /** Stockpiles: accepted item categories. */
  allow: ItemCategory[];
}

/** A hostile NPC faction's current raid. */
export interface RaidState {
  /** The colony being raided. */
  target: number;
  /** Raiders who arrived. */
  size: number;
  /** The raid breaks and everyone flees once this many raiders are down or dead. */
  breakAt: number;
  /** Raiders killed so far (ones who escaped don't count). */
  dead: number;
  /** Tick after which the raiders give up and leave. */
  until: number;
  fled: boolean;
  /** Sappers dig through rock as well as smashing walls. */
  sapper?: boolean;
  /** What they're trying to do right now; it shifts as the fight goes. Missing = assault. */
  goal?: RaidGoal;
  goalSince?: number;
  /** Recent wounds dealt to the colony and taken from it (decaying), to judge how it's going. */
  dealt?: number;
  taken?: number;
  /** Fires set so far. */
  fires?: number;
  /** Defenders standing when the current goal was set, to tell progress from stalemate. */
  foes?: number;
  /** Raids on settlements: wounds each player colony dealt the raiders, to thank them after. */
  helpers?: Record<number, number>;
}

/** assault: go for the colonists. loot: grab goods and go. burn: torch fields and outbuildings. siege: dig in out there and pick off anyone who shows. */
export type RaidGoal = 'assault' | 'loot' | 'burn' | 'siege';

export interface Faction {
  id: number;
  name: string;
  color: number;
  home: { x: number; y: number };
  isPlayer: boolean;
  /** Set on raider factions. Hostile to every player faction. */
  raid?: RaidState;
  /** Set on NPC settlements. */
  settlement?: SettlementState;
  /** The wildlife factions: grazing prey, and predators that hunt. */
  wild?: 'prey' | 'predator';
}

export interface SettlementState {
  /** Starting goodwill toward any colony; set by the settlement's temperament. */
  temper: number;
  /** Goodwill toward each player faction, -100..100. Missing = temper. */
  goodwill: Record<number, number>;
  /** Cells from home its people consider theirs. */
  radius: number;
  /** 'leaving' while the frost drives them inward; 'fallen' once everyone is gone. */
  state: 'home' | 'leaving' | 'fallen';
  /** Where they're heading while leaving, else -1. */
  dest: number;
  /** While leaving: settle wherever they are by this tick. */
  until: number;
  /** Player factions whose colonists have come near (and had the letter). */
  met: number[];
  /** Jobs colonies have agreed to do for them. Missing on older saves. */
  requests?: SettlementRequest[];
}

/** Goods a settlement asked a colony for, and what it promised in return. */
export interface SettlementRequest {
  id: number;
  faction: number;
  /** An item key, or "cat:<category>" for any item of that category. */
  item: string;
  count: number;
  /** What they'll hand over: items, or a settler who wants to join you. */
  reward: [item: string, count: number] | 'recruit';
  goodwill: number;
  until: number;
  why: string;
}

export type Tone = 'good' | 'neutral' | 'bad';

export interface GameMessage {
  tick: number;
  /** 0 = everyone. */
  faction: number;
  text: string;
  tone: Tone;
  /** Optional cell to jump the camera to. */
  at?: number;
  /** Said in direct answer to one of this faction's commands (a refusal or a result), not news. */
  reply?: true;
}

export interface Condition {
  key: string;
  until: number;
  /** 0 = whole map. */
  faction: number;
}

export interface ChoiceOption {
  key: string;
  label: string;
}

/** A letter that asks a player to decide something. */
export interface Choice {
  id: number;
  faction: number;
  event: string;
  title: string;
  text: string;
  options: ChoiceOption[];
  /** Tick at which the last option is chosen automatically. */
  expires: number;
  at?: number;
}

export interface Room {
  id: number;
  cells: number[];
  temp: number;
}

/** Designation kinds stored per cell. */
export const DESIG = { none: 0, mine: 1, cut: 2, harvest: 3, steal: 4 } as const;
export type DesigKind = keyof typeof DESIG;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Command =
  | ({ c: 'designate'; kind: 'mine' | 'chop' | 'cut' | 'harvest' | 'steal' | 'cancel' } & Rect)
  | ({ c: 'build'; def: string; hollow: boolean } & Rect)
  | ({ c: 'zone'; kind: ZoneKind; plant?: string } & Rect)
  | ({ c: 'unzone' } & Rect)
  | ({ c: 'deconstruct' } & Rect)
  /** Strip an area: remove your zones, take down your buildings (refunded), cancel your blueprints. */
  | ({ c: 'packUp' } & Rect)
  /** Move the colony's home: colonists drift there, and frost warnings follow it. */
  | { c: 'setHome'; x: number; y: number }
  | { c: 'setPriority'; pawn: EntityId; work: WorkType; prio: number }
  | { c: 'zoneSettings'; zone: number; plant?: string; allow?: ItemCategory[] }
  | { c: 'addBill'; bench: EntityId; recipe: string; mode: BillMode; target: number }
  | { c: 'updateBill'; bench: EntityId; bill: number; mode?: BillMode; target?: number; suspended?: boolean }
  | { c: 'removeBill'; bench: EntityId; bill: number }
  | { c: 'choose'; choice: number; option: string }
  | { c: 'offerTrade'; to: number; give: [string, number][]; want: [string, number][]; note?: string }
  | { c: 'settlementTrade'; settlement: number; give: [string, number][]; want: [string, number][] }
  | { c: 'deliverRequest'; settlement: number; request: number }
  | { c: 'steal'; pawn: EntityId; item: EntityId }
  | { c: 'hunt'; pawns: EntityId[]; on: boolean }
  | { c: 'possess'; pawn: EntityId; on: boolean }
  | { c: 'steer'; pawn: EntityId; dx: number; dy: number }
  | { c: 'sneak'; pawn: EntityId; on: boolean }
  | { c: 'interact'; pawn: EntityId }
  | { c: 'draft'; pawns: EntityId[]; on: boolean }
  | { c: 'move'; pawns: EntityId[]; x: number; y: number }
  | { c: 'attack'; pawns: EntityId[]; target: EntityId }
  /** Carry a downed raider to a free bed and hold them prisoner. The nearest listed pawn goes. */
  | { c: 'capture'; pawns: EntityId[]; target: EntityId }
  /** Wield a weapon lying on the map; item 0 drops the current one. */
  | { c: 'equip'; pawn: EntityId; item: EntityId }
  /** Let a prisoner go. */
  | { c: 'release'; pawn: EntityId };

/** Full state a client needs to render the world. */
export interface Snapshot {
  w: number;
  h: number;
  seed: number;
  tick: number;
  terrain: Uint8Array;
  rock: Uint8Array;
  desig: Uint8Array;
  desigFaction: Uint8Array;
  fire: Uint8Array;
  ents: Entity[];
  zones: Zone[];
  factions: Faction[];
  rooms: Room[];
  conditions: Condition[];
  choices: Choice[];
  coldOffset: number;
  /** Frost line settings; the client computes the line itself from these. */
  frost?: import('./frost').FrostParams;
}

/** Changes since the previous delta. Every field is an idempotent upsert or removal. */
export interface Delta {
  tick: number;
  ents: Entity[];
  removed: EntityId[];
  /** Flattened [cell, terrain, rock, desig, desigFaction, fire] sextuples. */
  cells: number[];
  zones: Zone[];
  removedZones: number[];
  factions: Faction[];
  msgs: GameMessage[];
  /** Present when room shapes changed. Replaces the full list. */
  rooms?: Room[];
  /** Present when only temperatures changed: [roomId, temp] pairs. */
  roomTemps?: number[];
  conditions?: Condition[];
  /** Present when choices changed. Replaces the full list. */
  choices?: Choice[];
  coldOffset?: number;
  /**
   * Attacks this delta, flattened SHOT_FIELDS tuples: [shooter, target, sx, sy, tx, ty, hit, weapon index].
   * The target is a pawn, or a building being smashed.
   */
  shots?: number[];
}

export const SHOT_FIELDS = 8;

export const CELL_FIELDS = 6;
