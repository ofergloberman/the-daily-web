// Shared by the explain scripts: reads an explain() result and times a query.

// Collects stage names, index names and document counts from any explain shape (find or aggregate, any server version).
function summarize(explain) {
  const out = { stages: new Set(), indexes: new Set(), docs: 0, keys: 0, collscans: 0 };
  (function walk(node, key) {
    if (Array.isArray(node)) return node.forEach(item => walk(item));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'rejectedPlans' || k === 'allPlansExecution') continue;
      if (k === 'stage' && typeof v === 'string') { out.stages.add(v); if (v === 'COLLSCAN') out.collscans++; }
      if (k === 'indexName') out.indexes.add(v);
      if (k === 'indexesUsed' && Array.isArray(v)) v.forEach(name => out.indexes.add(name));
      if (k === 'collectionScans' && typeof v === 'number') out.collscans += v;
      if (k === 'totalDocsExamined' && typeof v === 'number') out.docs += v;
      if (k === 'totalKeysExamined' && typeof v === 'number') out.keys += v;
      walk(v, k);
    }
  })(explain);
  return out;
}

async function timed(fn) {
  const runs = [];
  for (let i = 0; i < 3; i++) { const start = performance.now(); await fn(); runs.push(performance.now() - start); }
  return Math.round(runs.sort((a, b) => a - b)[1]); // median of three
}

module.exports = { summarize, timed };
