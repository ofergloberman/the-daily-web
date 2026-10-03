const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

test('autosave preserves article text and an unfinished URL without form validation blocking it', async () => {
  const draft = { title: 'Latest title', summary: '', body: 'Unsaved writing', category: '', imageUrl: 'https://' };
  const listeners = {};
  const status = { textContent: '', parentElement: { dataset: {} } };
  const form = {
    dataset: { saveUrl: '/reporter/articles/example/draft' },
    elements: Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, { value }])),
    reportValidity: () => false,
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const retry = { hidden: true, addEventListener() {} };
  const requests = [];
  let scheduledSave;
  runInNewContext(readFileSync(require.resolve('../public/reporter-autosave.js'), 'utf8'), {
    document: {
      getElementById: id => ({ 'draft-form': form, 'save-status': status, 'retry-save': retry })[id],
      addEventListener() {}
    },
    window: { addEventListener() {} },
    setTimeout: callback => { scheduledSave = callback; },
    clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200 }; }
  });
  listeners.input();
  await scheduledSave();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[0].options.body), draft);
  assert.equal(status.textContent, 'Saved');
});
