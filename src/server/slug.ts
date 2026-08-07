import { randomInt } from 'node:crypto';

/**
 * Short, memorable, read-aloud-able slugs. Deliberately avoids ambiguous or
 * unfortunate words so a slug can be dictated over the phone.
 */
const ADJECTIVES = [
  'amber', 'arctic', 'bold', 'brave', 'bright', 'calm', 'clever', 'cosmic',
  'crisp', 'daring', 'dusty', 'eager', 'electric', 'fluffy', 'gentle', 'giant',
  'glowing', 'golden', 'happy', 'hidden', 'humble', 'icy', 'jolly', 'keen',
  'lively', 'lucky', 'lunar', 'mellow', 'merry', 'mighty', 'misty', 'neat',
  'noble', 'northern', 'polar', 'proud', 'quiet', 'rapid', 'royal', 'silent',
  'silver', 'smooth', 'snowy', 'solar', 'spry', 'stellar', 'sunny', 'swift',
  'tidy', 'vivid', 'warm', 'wandering', 'wild', 'witty', 'zesty',
];

const NOUNS = [
  'acorn', 'anchor', 'aurora', 'badger', 'beacon', 'birch', 'bison', 'bramble',
  'canyon', 'cedar', 'comet', 'coral', 'crane', 'delta', 'ember', 'falcon',
  'fern', 'fjord', 'forest', 'fox', 'glacier', 'harbor', 'heron', 'island',
  'jasper', 'kestrel', 'lantern', 'ledger', 'lynx', 'maple', 'meadow', 'monsoon',
  'narwhal', 'nebula', 'oak', 'ocean', 'orbit', 'osprey', 'otter', 'panther',
  'pebble', 'pine', 'planet', 'prairie', 'quartz', 'raven', 'reef', 'ridge',
  'river', 'sable', 'salmon', 'summit', 'thistle', 'tundra', 'valley', 'walrus',
  'willow', 'wolf', 'zenith',
];

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(arr.length)] as T;
}

/** e.g. "swift-otter-482" - roughly 55 * 59 * 900 = 2.9M combinations. */
export function generateSlug(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomInt(100, 1000)}`;
}

const SLUG_RE = /^[a-z]+-[a-z]+-\d{3}$/;

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && slug.length <= 40 && SLUG_RE.test(slug);
}
