import { createHash } from 'node:crypto';

// Split by subject family. Every fact, paraphrase, and related task for a
// subject stays on the same side of the split. All material is fictional.
const families = [
  ['dev', 'amber-ingress', 'webhook verification', 'HMAC-SHA1', 'HMAC-SHA256', 'signature mismatch', 'proxy rewrites the request body', 'capture the unmodified request bytes'],
  ['dev', 'birch-transcode', 'audio resampling', '48 kHz', '16 kHz', 'timestamps drift', 'the container duration is wrong', 'probe decoded sample counts'],
  ['dev', 'cinder-search', 'query fan-out', '24 shards', '8 shards', 'slow exact lookup', 'routing hits a cold shard', 'warm the owning shard'],
  ['dev', 'dune-ledger', 'invoice rounding', 'per invoice', 'per line', 'totals differ', 'tax base was rounded twice', 'compare pre-tax line totals'],
  ['dev', 'elm-agent', 'session expiry', '20 minutes', '45 minutes', 'session disconnects', 'idle timeout fires before heartbeat', 'record heartbeat timestamps'],
  ['dev', 'fern-publisher', 'image export', '72 dpi', '144 dpi', 'blurry preview', 'renderer scales raster layers', 'export vectors at native size'],
  ['dev', 'glacier-mirror', 'artifact retention', '7 days', '21 days', 'missing release archive', 'lifecycle rule covers the mirror', 'check the mirror retention policy'],
  ['dev', 'harbor-gateway', 'retry limit', '6 attempts', '3 attempts', 'repeated upstream requests', 'two layers retry independently', 'disable retry on the inner client'],
  ['test', 'iris-catalog', 'barcode length', '8 digits', '13 digits', 'label rejected', 'scanner strips leading zeroes', 'inspect raw scanner input'],
  ['test', 'juniper-fonts', 'fallback typeface', 'Atlas Sans', 'River Serif', 'missing glyphs', 'subset excludes combining marks', 'compare glyph coverage'],
  ['test', 'kelp-sensor', 'polling interval', '2 seconds', '10 seconds', 'battery drains overnight', 'device never enters sleep mode', 'sample deep-sleep current'],
  ['test', 'linen-archive', 'archive compression', 'DEFLATE', 'Zstandard', 'reader cannot unpack', 'manifest advertises old codec', 'read the codec header'],
  ['test', 'mosaic-broker', 'delivery guarantee', 'at-most-once', 'at-least-once', 'duplicate notification', 'ack arrived after timeout', 'record delivery and ack order'],
  ['test', 'north-router', 'IPv6 MTU', '1500 bytes', '1280 bytes', 'handshake stalls', 'path blocks ICMP too-big', 'probe with smaller packets'],
  ['test', 'opal-camera', 'capture color space', 'Display P3', 'sRGB', 'colors wash out', 'preview ignores ICC profile', 'compare exported ICC metadata'],
  ['test', 'prairie-cache', 'eviction policy', 'FIFO', 'LRU', 'hot entry disappears', 'loader bypasses access bookkeeping', 'inspect access counter updates'],
  ['test', 'quartz-render', 'frame budget', '33 milliseconds', '16 milliseconds', 'animation skips frames', 'large glyph atlas blocks upload', 'measure atlas upload time'],
  ['test', 'reed-index', 'segment size', '128 MiB', '32 MiB', 'incremental index stalls', 'merge overlaps a snapshot', 'trace index merge boundaries'],
  ['test', 'spruce-bridge', 'API schema', 'protocol 2', 'protocol 3', 'response parse error', 'bridge caches old schema', 'invalidate cached schema version'],
  ['test', 'tundra-backup', 'restore checkpoint', 'daily manifest', 'transaction journal', 'record missing after restore', 'backup preceded journal flush', 'check manifest and journal sequence']
];

const time = { early: '2026-01-01T00:00:00.000Z', cutoff: '2026-03-01T00:00:00.000Z', late: '2026-06-01T00:00:00.000Z' };
const earlier = '2026-02-01T00:00:00.000Z';
export const tasks = families.flatMap(([split, subject, setting, oldValue, newValue, symptom, cause, action]) => {
  function make(category, query, records, steps, expected, request = {}) {
    const id = subject + '/' + category;
    return {
      id, split, family: subject, category, query, request,
      records: records.map(([key, content, metadata = {}]) => ({
        key, subject, title: subject + ' ' + setting + ' ' + key,
        content, source: 'test://v1/' + id + '/' + (metadata.origin ?? key), ...metadata
      })),
      steps, expected
    };
  }
  const first = `${subject} uses ${oldValue} for ${setting}.`;
  const second = `${subject} uses ${newValue} for ${setting}.`;
  return [
    make('revision', `What is the current ${setting} for ${subject}?`,
      [['initial', first], ['correction', second]],
      [{type:'new', record:'initial'}, {type:'update', target:'initial', expected_revision:1, record:'correction'}],
      {answer:newValue, evidence:[{key:'initial', revision:2, source:'correction'}], excludes:[{key:'initial', revision:1}]}),
    make('effective-time', `What ${setting} applied to ${subject} on February 1, 2026?`,
      [['current', `${second} Effective March 1, 2026.`, {event_time:time.cutoff, valid_from:time.cutoff}],
       ['late-event', `${first} It applied from January 1 up to March 1, 2026.`, {event_time:time.early, valid_from:time.early, valid_to:time.cutoff}]],
      [{type:'new', record:'current'}, {type:'new', record:'late-event', recorded_at:time.late}],
      {answer:oldValue, evidence:[{key:'late-event', revision:1}], excludes:[{key:'current', revision:1}]},
      {as_of:earlier}),
    make('environment', `What ${setting} is used in production for ${subject}?`,
      [['dev', `In development, ${first}`, {environment:'development'}],
       ['prod', `In production, ${second}`, {environment:'production'}]],
      [{type:'new', record:'dev'}, {type:'branch', target:'dev', expected_revision:1, record:'prod'}],
      {answer:newValue, evidence:[{key:'prod', revision:1}], excludes:[{key:'dev', revision:1}]},
      {context:{environment:'production'}}),
    make('namespace', `What ${setting} is configured for ${subject} in the authorized project?`,
      [['ours', second, {project:'mine'}], ['other', first, {project:'foreign'}]],
      [{type:'new', record:'ours'}, {type:'new', record:'other'}],
      {answer:newValue, evidence:[{key:'ours', revision:1}], excludes:[{key:'other', revision:1}]},
      {project:'mine'}),
    make('cross-event', `For ${subject}, what check did the ${symptom} incident lead to?`,
      [['incident', `During ${subject} operation, ${symptom} was reported.`],
       ['cause', `The investigation established that ${cause}.`],
       ['check', `The follow-up check was to ${action}.`],
       ['distractor', `${symptom} had a different cause in the test simulator. No follow-up check was recorded.`, {environment:'simulator'}]],
      [{type:'new', record:'incident'}, {type:'new', record:'cause'}, {type:'new', record:'check'},
       {type:'new', record:'distractor'}, {type:'relate', from:'incident', to:'cause', relation:'related_to'},
       {type:'relate', from:'cause', to:'check', relation:'supports'}],
      {answer:action, evidence:[{key:'incident', revision:1}, {key:'cause', revision:1}, {key:'check', revision:1}],
       excludes:[{key:'distractor', revision:1}]}, {context:{environment:'production'}}),
    make('consolidation', `Which repeatable diagnostic check for ${subject} is supported by independent sources?`,
      [['incident', `During ${symptom}, maintainers confirmed that ${cause}. They had to ${action}.`],
       ['retelling', `A handoff copied the incident note and says to ${action}.`, {origin:'incident'}],
       ['reproduction', `An independent reproduction confirmed ${cause}. The reproducible check was to ${action}.`]],
      [{type:'new', record:'incident'}, {type:'new', record:'retelling'}, {type:'new', record:'reproduction'},
       {type:'consolidate', sources:['incident','retelling','reproduction']}],
      {answer:action, evidence:[{key:'incident', revision:1}, {key:'reproduction', revision:1}], independent_sources:2}),
    make('forget', `What retained operational evidence remains for ${subject}?`,
      [['original', first], ['correction', second],
       ['summary', `The ${setting} value for ${subject} was summarized as ${newValue}.`],
       ['independent', `A separate investigation confirmed that ${cause}.`]],
      [{type:'new', record:'original'}, {type:'update', target:'original', expected_revision:1, record:'correction'},
       {type:'new', record:'summary', derived_from:[{key:'original', revision:2}]}, {type:'new', record:'independent'},
       {type:'relate', from:'original', to:'independent', relation:'related_to'}, {type:'forget', target:'original', expected_revision:2}],
      {answer:cause, evidence:[{key:'independent', revision:1}], excludes:[{key:'original', revision:1},{key:'original', revision:2},{key:'summary', revision:1}]}),
    make('decision', `Which value was adopted for ${subject} ${setting}?`,
      [['proposal', `Draft: We will adopt ${newValue} for ${setting} if approved. Approval is still open.`, {decision_state:'proposed'}],
       ['reject', `Maintainers rejected ${oldValue} for ${setting}.`, {decision_state:'rejected'}]],
      [{type:'new', record:'proposal'}, {type:'new', record:'reject'}],
      {answer:null, evidence:[], excludes:[{key:'proposal', revision:1},{key:'reject', revision:1}], evidence_status:'insufficient'},
      {decision_state:'adopted'})
  ];
});

export const fingerprint = createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
