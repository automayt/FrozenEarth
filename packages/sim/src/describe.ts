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
    case 'haul':
      return `Hauling ${name(job.item)}`;
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
      return job.stage === 0 ? 'Going to sleep' : 'Sleeping';
    case 'bill': {
      const b = lookup(job.bench);
      const bill = b && b.kind === 'building' ? b.bills.find((x) => x.id === job.bill) : undefined;
      return bill ? RECIPES[bill.recipe].label : 'Working at bench';
    }
  }
}
