import { BUILDINGS, ITEMS, PLANTS, RECIPES } from '@fe/defs';
import type { Entity, Job } from './types';

/** Human-readable job text for the inspect pane. Works on client mirrors too. */
export function describeJob(job: Job | null, lookup: (id: number) => Entity | undefined): string {
  if (!job) return 'Idle';
  const name = (id: number) => {
    const e = lookup(id);
    if (!e) return 'something';
    if (e.kind === 'item') return ITEMS[e.def]?.label.toLowerCase() ?? e.def;
    if (e.kind === 'plant') return PLANTS[e.def]?.label.toLowerCase() ?? e.def;
    if (e.kind === 'building' || e.kind === 'construct') return BUILDINGS[e.def]?.label.toLowerCase() ?? e.def;
    return e.name;
  };
  switch (job.type) {
    case 'wander':
      return 'Wandering';
    case 'ignite':
      return 'Setting a fire';
    case 'control':
      return job.stolen ? 'Sneaking off with stolen goods (under your control)' : 'Under your direct control';
    case 'haul':
      return job.stolen ? 'Sneaking off with stolen goods' : `Hauling ${name(job.item)}`;
    case 'deliver':
      return `Delivering materials to ${name(job.target)}`;
    case 'build':
      return `Building ${name(job.target)}`;
    case 'mine':
      return 'Mining';
    case 'cut':
      return job.harvest ? `Harvesting ${name(job.target)}` : `Cutting ${name(job.target)}`;
    case 'sow':
      return `Sowing ${PLANTS[job.plant]?.label.toLowerCase() ?? job.plant}`;
    case 'eat':
      return 'Eating';
    case 'sleep':
      if (job.rest) return job.stage === 0 ? 'Going to bed to recover' : 'Resting in bed';
      return job.stage === 0 ? 'Going to sleep' : 'Sleeping';
    case 'extinguish':
      return 'Fighting a fire';
    case 'warm':
      return 'Seeking a better temperature';
    case 'wear':
      return `Changing into ${name(job.item)}`;
    case 'attack':
      return `${job.forced ? 'Attacking' : 'Fighting'} ${name(job.target)}`;
    case 'goto':
      return 'Moving (drafted)';
    case 'hold':
      return 'Standing ready';
    case 'tend':
      return `Tending ${name(job.patient)}'s wounds`;
    case 'shelter':
      return `Taking cover from ${name(job.from)}`;
    case 'flee':
      return job.stage === 0 ? 'Looting' : 'Fleeing';
    case 'bash':
      return 'Breaking in';
    case 'repair':
      return `Repairing ${name(job.target)}`;
    case 'rescue':
      if (job.stage === 0) return `Going to ${job.capture ? 'capture' : 'rescue'} ${name(job.patient)}`;
      return job.capture ? `Taking ${name(job.patient)} prisoner` : `Carrying ${name(job.patient)} to bed`;
    case 'feed':
      return job.stage === 0 ? `Fetching food for ${name(job.patient)}` : `Feeding ${name(job.patient)}`;
    case 'equip':
      return job.item ? `Picking up ${name(job.item)}` : 'Dropping weapon';
    case 'bill': {
      const b = lookup(job.bench);
      const bill = b && b.kind === 'building' ? b.bills.find((x) => x.id === job.bill) : undefined;
      return bill ? RECIPES[bill.recipe].label : 'Working at bench';
    }
  }
}
