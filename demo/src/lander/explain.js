// "What's happening": one or two plain-English sentences for the part of the flight being shown, and the next
// event on the plan. Pure (no DOM): the Execute page (main.js) writes it into the card under the HUD.
// Keys are the phase ids of mission.js PHASES, plus 'separation' (the coast while the upper stage is still
// attached) and 'surface-ops' (the rover drive after the landing).

export const EXPLAIN = {
  leo: {
    title: 'Launch and parking orbit',
    what: 'The rocket has put the lander and its upper stage into a low circular orbit around the Earth.',
    why: 'Waiting here lets the team check the spacecraft and start the trip to the Moon at the exact point of the orbit that lines up with where the Moon will be.',
  },
  tli: {
    title: 'Trans-lunar injection',
    what: 'The upper stage fires for a few minutes and adds about 3 km/s, stretching the orbit until it reaches the Moon.',
    why: 'This is the biggest push of the trip. The upper stage does it so the lander keeps its own propellant for the landing.',
  },
  separation: {
    title: 'Upper stage separation',
    what: 'The burn is over and the empty upper stage is about to be released; the lander flies on alone.',
    why: 'Dropping the dead weight means every later manoeuvre costs far less propellant.',
  },
  coast: {
    title: 'Coasting to the Moon',
    what: 'The engine is off. The lander falls away from the Earth for about four days, slowing all the way, with small correction burns to stay on target.',
    why: 'No thrust is needed between the two bodies: gravity does the work, and tiny corrections now save large ones later.',
  },
  'approach-moon': {
    title: 'Lunar approach',
    what: 'The Moon’s gravity is now stronger than the Earth’s, and the lander speeds up as it falls towards the Moon.',
    why: 'The path is aimed to pass just above the surface, over the pole, so one burn can capture it into orbit.',
  },
  loi: {
    title: 'Lunar orbit insertion',
    what: 'The lander fires its engine against its direction of travel to slow down.',
    why: 'Without this burn it would swing past the Moon and back out into space; with it, the Moon captures it into a low orbit.',
  },
  llo: {
    title: 'Low lunar orbit',
    what: 'The lander circles the Moon about 100 km up, once every two hours, while its systems are checked.',
    why: 'It waits until the Moon’s rotation brings the landing site under the orbit and the Sun and Earth are above the site’s skyline.',
  },
  doi: {
    title: 'Descent orbit insertion',
    what: 'A short braking burn lowers the far side of the orbit to about 15 km above the surface.',
    why: 'Starting the landing from low down means the long final burn fights gravity for less time and uses less propellant.',
  },
  'descent-coast': {
    title: 'Coasting to the descent point',
    what: 'The lander falls half an orbit down to the low point, engine off, facing backwards and ready to brake.',
    why: 'The powered descent has to start at one precise place and time to end at the landing site.',
  },
  braking: {
    title: 'Powered descent: braking',
    what: 'The engine burns at high thrust to kill about 1.7 km/s of orbital speed while the lander drops towards the site.',
    why: 'There is no air to slow it down, so the engine has to remove all the speed. This is where most of the propellant goes.',
  },
  approach: {
    title: 'Powered descent: approach',
    what: 'The lander pitches upright and steers towards the target, now only a few kilometres away, with the terrain in view.',
    why: 'Upright, its sensors can see the ground, check slopes and hazards, and divert to a safer spot if needed.',
  },
  terminal: {
    title: 'Terminal descent',
    what: 'The lander comes straight down at a slow, steady speed for the last tens of metres.',
    why: 'A vertical, gentle finish keeps the touchdown inside the legs’ limits and keeps sideways speed near zero so it does not tip.',
  },
  landed: {
    title: 'Touchdown',
    what: 'The engine is off and the lander stands on the surface at the site chosen on the Map.',
    why: 'Now sunlight on the panels and a line of sight to the Earth decide how long it can work, which is why the site and date were chosen together.',
  },
  'surface-ops': {
    title: 'Surface operations',
    what: 'The rover drives the route planned on the Map, over real LOLA terrain, from the touchdown point.',
    why: 'The route was checked for slope, battery and radio contact before launch, with a safe haven in reach if something goes wrong.',
  },
};

/** The explanation for a flight state: { key, title, what, why }. Unknown phases get a neutral entry. */
export function explainFor({ phase, tliStageAttached = false, surfaceOps = false } = {}) {
  const key = surfaceOps ? 'surface-ops' : phase === 'coast' && tliStageAttached ? 'separation' : phase;
  const e = EXPLAIN[key];
  return e ? { key, ...e } : { key: 'unknown', title: 'In flight', what: 'The lander is following the planned trajectory.', why: '' };
}

/** The first event of the plan strictly after tMs: { name, inS } or null. */
export function nextEvent(events, tMs) {
  let best = null;
  for (const e of events ?? []) if (Number.isFinite(e.tMs) && e.tMs > tMs && (!best || e.tMs < best.tMs)) best = e;
  return best ? { id: best.id, name: best.name, inS: (best.tMs - tMs) / 1000 } : null;
}
