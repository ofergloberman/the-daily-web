(() => {
  const form = document.getElementById('draft-form');
  if (!form) return;

  const status = document.getElementById('save-status');
  const retry = document.getElementById('retry-save');
  const submitButton = document.getElementById('submit-button');
  const submitStatus = document.getElementById('submit-status');
  const backLink = document.getElementById('back-link');
  const fields = ['title', 'summary', 'body', 'category', 'imageUrl'];
  const requiredForSubmit = ['title', 'summary', 'body', 'category'];
  let version = 0;
  let savedVersion = 0;
  // The draftVersion this editor last saw - sent as `baseVersion` with every
  // save so the server can detect a write that would overwrite a newer one
  // (another tab/device, or a delayed/out-of-order request) and reject it
  // instead of silently clobbering it.
  let baseVersion = Number(form.dataset.draftVersion || 0);
  let saving = false;
  let savePromise = null;
  let timer;
  let authExpired = false;
  let draftLocked = false;

  function halted() {
    return authExpired || draftLocked;
  }

  function setStatus(message, state, retryable = false) {
    status.textContent = message;
    status.parentElement.dataset.state = state;
    retry.hidden = !retryable;
  }

  function updateSubmitAvailability() {
    if (!submitButton) return;
    const complete = requiredForSubmit.every(field => form.elements[field].value.trim().length > 0);
    submitButton.disabled = !complete || draftLocked;
  }

  function save({ keepalive = false } = {}) {
    clearTimeout(timer);
    if (saving) return savePromise;
    if (version === savedVersion || halted()) return Promise.resolve();
    saving = true;
    const snapshotVersion = version;
    const snapshotBaseVersion = baseVersion;
    const draft = Object.fromEntries(fields.map(field => [field, form.elements[field].value]));
    setStatus('Saving…', 'saving');
    savePromise = (async () => {
      try {
        const response = await fetch(form.dataset.saveUrl, {
          method: 'PATCH', credentials: 'same-origin', keepalive,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...draft, baseVersion: snapshotBaseVersion })
        });
        if (response.status === 401) {
          authExpired = true;
          setStatus('Session ended. Copy unsaved text before signing in again.', 'error');
          return;
        }
        const result = await response.json().catch(() => ({}));
        if (response.status === 409 && result.error === 'STALE_DRAFT' && result.latest) {
          // Another save (a different tab/device, or a request that arrived
          // out of order) already advanced the draft past what we started
          // from. Adopt its version and let the retry below resend our
          // still-unsaved text on top of it - never silently drop it.
          baseVersion = result.latest.draftVersion;
          setStatus('Resyncing with the latest saved version…', 'saving');
          return;
        }
        if (response.status === 409 && result.error === 'DRAFT_LOCKED') {
          draftLocked = true;
          setStatus('This article is now awaiting review and can no longer be edited here.', 'error');
          updateSubmitAvailability();
          return;
        }
        if (!response.ok) throw new Error(result.message || 'Your changes could not be saved.');
        savedVersion = snapshotVersion;
        baseVersion = result.article.draftVersion;
        setStatus(snapshotVersion === version ? 'Saved' : 'Saving…', snapshotVersion === version ? 'saved' : 'saving');
      } catch (error) {
        setStatus(error.message || 'Your changes could not be saved.', 'error', true);
      }
    })().finally(() => {
      saving = false;
      savePromise = null;
      if (savedVersion < version && !halted() && status.parentElement.dataset.state !== 'error') save();
    });
    return savePromise;
  }

  // Waits until every change made so far has either saved or hit an
  // unrecoverable (locked/signed-out) state. Used before submission and
  // before following same-page navigation links, so a save queued by the
  // debounce timer is never silently abandoned.
  async function flush() {
    while (version !== savedVersion && !halted()) await save();
  }

  async function submit() {
    if (!submitButton || submitButton.disabled || halted()) return;
    submitButton.disabled = true;
    submitStatus.textContent = 'Submitting…';
    try {
      await flush();
      const response = await fetch(form.dataset.submitUrl, { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || 'This article could not be submitted.');
      }
      submitStatus.textContent = 'Submitted for review.';
      window.location.href = '/reporter';
    } catch (error) {
      submitStatus.textContent = error.message || 'This article could not be submitted.';
      updateSubmitAvailability();
    }
  }

  form.addEventListener('input', () => {
    version += 1;
    if (!halted()) setStatus('Unsaved changes', 'dirty');
    updateSubmitAvailability();
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  });
  retry.addEventListener('click', () => save());
  if (submitButton) submitButton.addEventListener('click', submit);
  if (backLink) {
    // A click here is in-app navigation, not a real page unload: flush any
    // pending save before leaving so a debounced keystroke is never lost.
    backLink.addEventListener('click', async event => {
      if (version === savedVersion || halted()) return;
      event.preventDefault();
      await flush();
      window.location.href = backLink.href;
    });
  }
  setInterval(() => { if (version > savedVersion && !saving && !halted()) save(); }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && version !== savedVersion && !halted()) save();
  });
  // pagehide fires reliably for real tab closes/refreshes/navigation
  // (including the back-forward cache case beforeunload misses). `keepalive`
  // lets the browser finish sending the request after the page is gone -
  // this is a last-resort net, not the primary save path: ordinary typing
  // already saves promptly above, so a lost unload signal never means lost
  // work.
  window.addEventListener('pagehide', () => {
    if (version !== savedVersion && !halted()) save({ keepalive: true });
  });
  window.addEventListener('beforeunload', event => {
    if (version !== savedVersion && !halted()) { event.preventDefault(); event.returnValue = ''; }
  });
})();

