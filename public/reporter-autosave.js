(() => {
  const form = document.getElementById('draft-form');
  if (!form) return;

  const status = document.getElementById('save-status');
  const retry = document.getElementById('retry-save');
  const fields = ['title', 'summary', 'body', 'category', 'imageUrl'];
  let version = 0;
  let savedVersion = 0;
  let saving = false;
  let timer;
  let authExpired = false;

  function setStatus(message, state, retryable = false) {
    status.textContent = message;
    status.parentElement.dataset.state = state;
    retry.hidden = !retryable;
  }

  async function save() {
    clearTimeout(timer);
    if (saving || version === savedVersion || authExpired) return;
    saving = true;
    const snapshotVersion = version;
    const draft = Object.fromEntries(fields.map(field => [field, form.elements[field].value]));
    setStatus('Saving…', 'saving');
    try {
      const response = await fetch(form.dataset.saveUrl, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft)
      });
      if (response.status === 401) {
        authExpired = true;
        setStatus('Session ended. Copy unsaved text before signing in again.', 'error');
        return;
      }
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || 'Your changes could not be saved.');
      }
      savedVersion = snapshotVersion;
      setStatus(snapshotVersion === version ? 'Saved' : 'Saving…', snapshotVersion === version ? 'saved' : 'saving');
    } catch (error) {
      setStatus(error.message || 'Your changes could not be saved.', 'error', true);
    } finally {
      saving = false;
      if (savedVersion < version && status.parentElement.dataset.state !== 'error') save();
    }
  }

  form.addEventListener('input', () => {
    version += 1;
    setStatus('Unsaved changes', 'dirty');
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  });
  retry.addEventListener('click', save);
  setInterval(() => { if (version > savedVersion && !saving && !authExpired) save(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  window.addEventListener('beforeunload', event => {
    if (version > savedVersion) { event.preventDefault(); event.returnValue = ''; }
  });
})();
