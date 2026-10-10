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
  // The draft content as of the last point we know this tab agrees with the
  // server: either right after our own successful save, or right after a
  // STALE_DRAFT conflict adopted a field's remote value. Comparing a field's
  // current input value against this baseline is how a conflict is resolved
  // per-field instead of as an all-or-nothing overwrite (see the merge in
  // the STALE_DRAFT branch of save() below).
  let syncedDraft = Object.fromEntries(fields.map(field => [field, form.elements[field].value]));
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

  // Mirrors articleWorkflow.isValidImageUrl: blank is fine (optional field),
  // otherwise it must be a well-formed http(s) URL. Keeps the submit button
  // in sync with the server-side gate in submitForApproval/approve, so a
  // Reporter isn't let through here only to hit a 400 on submit.
  function isValidImageUrl(value) {
    const trimmed = value.trim();
    if (trimmed === '') return true;
    try {
      return ['http:', 'https:'].includes(new URL(trimmed).protocol);
    } catch {
      return false;
    }
  }

  function updateSubmitAvailability() {
    if (!submitButton) return;
    const complete = requiredForSubmit.every(field => form.elements[field].value.trim().length > 0);
    const imageOk = isValidImageUrl(form.elements.imageUrl.value);
    submitButton.disabled = !complete || !imageOk || draftLocked;
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
          // from. This is a real conflict, not something to paper over by
          // resending our whole stale form on top of it - that would
          // silently discard any field the *other* session changed that we
          // simply hadn't touched here. Instead, merge field-by-field: a
          // field we haven't edited since our last known-synced state adopts
          // the server's newer value (and is reflected back into the form so
          // the user sees it); a field we HAVE edited here keeps our local
          // text and is resent, which can still overwrite the server's value
          // for that specific field - an unavoidable same-field conflict
          // with no automatic text-level resolution, but every other field
          // is preserved correctly either way.
          let mergedRemoteField = false;
          for (const field of fields) {
            const touchedLocally = form.elements[field].value !== syncedDraft[field];
            if (!touchedLocally && field in result.latest.draft) {
              form.elements[field].value = result.latest.draft[field];
              syncedDraft[field] = result.latest.draft[field];
              mergedRemoteField = true;
            }
          }
          baseVersion = result.latest.draftVersion;
          setStatus(mergedRemoteField
            ? 'Merged newer changes from another session…'
            : 'Resyncing with the latest saved version…', 'saving');
          updateSubmitAvailability();
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
        syncedDraft = draft;
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
  // debounce timer is never silently abandoned. A save() that fails with an
  // ordinary network/server error neither advances savedVersion nor halts,
  // so without this check the loop would retry the same failing save
  // forever; throw instead so the caller's retry UI (the "Retry save"
  // button) takes over.
  async function flush() {
    while (version !== savedVersion && !halted()) {
      await save();
      if (status.parentElement.dataset.state === 'error' && !halted()) {
        throw new Error(status.textContent || 'Your changes could not be saved.');
      }
    }
  }

  async function submit() {
    if (!submitButton || submitButton.disabled || halted()) return;
    submitButton.disabled = true;
    submitStatus.textContent = 'Submitting…';
    try {
      await flush();
      const response = await fetch(form.dataset.submitUrl, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && result.error === 'STALE_DRAFT' && result.latest) {
        baseVersion = result.latest.draftVersion;
        throw new Error(result.message || 'Newer changes were saved from another session. Reload before submitting.');
      }
      if (!response.ok) throw new Error(result.message || 'This article could not be submitted.');
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
    // If flush() throws (an unrecoverable save error), stay on the page -
    // save() has already put the retry UI into its error state - rather
    // than navigating away and losing the unsaved text.
    backLink.addEventListener('click', async event => {
      if (version === savedVersion || halted()) return;
      event.preventDefault();
      try {
        await flush();
        window.location.href = backLink.href;
      } catch {
        /* save() already surfaced the error via the retry UI. */
      }
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
  // work. save() can't be reused here: if a normal (non-keepalive) save is
  // already in flight it returns that stale promise unchanged, so any edits
  // made since that request started would never be sent once the page is
  // gone. Always dispatch a fresh keepalive request carrying the current
  // form values, independent of any save already in flight.
  window.addEventListener('pagehide', () => {
    if (halted() || version === savedVersion) return;
    const draft = Object.fromEntries(fields.map(field => [field, form.elements[field].value]));
    fetch(form.dataset.saveUrl, {
      method: 'PATCH', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, baseVersion })
    }).catch(() => {});
  });
  window.addEventListener('beforeunload', event => {
    if (version !== savedVersion && !halted()) { event.preventDefault(); event.returnValue = ''; }
  });
})();

