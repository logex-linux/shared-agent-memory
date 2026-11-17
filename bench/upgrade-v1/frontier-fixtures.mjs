import { createHash } from 'node:crypto';

const subjects = [
  'Amber webhook', 'Birch audio', 'Cinder search', 'Dune billing', 'Elm sessions', 'Fern imaging',
  'Glacier mirror', 'Harbor client', 'Iris labels', 'Juniper fonts', 'Kelp sensors', 'Linen archives',
  'Mosaic broker', 'North gateway', 'Opal cameras', 'Prairie cache', 'Quartz graphics', 'Reed index',
  'Spruce bridge', 'Tundra recovery', 'Umber logs', 'Vale tracing', 'Willow storage', 'Yarrow routing'
];
const formats = ['temporary', 'permanent_denied', 'correction', 'scope', 'temporal', 'mirror',
  'necessary_condition', 'procedure', 'injection', 'missing_evidence'];
const days = ['2026-02-02', '2026-04-02', '2026-08-02'];
export const frontierFixtures = subjects.flatMap((subject, index) => {
  const split = index < 4 ? 'development' : index < 8 ? 'calibration' : 'holdout';
  const stamp = days[['development','calibration','holdout'].indexOf(split)];
  const key = subject.toLowerCase().replace(' ', '-');
  return formats.map(mode => ({
    id:`${key}/${mode}`, subject, key, split, stamp, mode,
    former:index + 4, current:index + 40, exceptional:index + 90,
    condition:index % 2 ? 'edge' : 'offline',
    budget:index % 3 === 0 ? 640 : 1600,
    family:`test://sam/frontier/${key}/`
  }));
});
export const frontierFingerprint = createHash('sha256').update(JSON.stringify(frontierFixtures)).digest('hex');
