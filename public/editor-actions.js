(() => {
  const root = document.getElementById('review');
  if (!root) return;

  const articleUrl = `/editor/articles/${encodeURIComponent(root.dataset.articleId)}`;
  const DELETE_CONFIRMATION = 'Delete this article together with its comments and view statistics? This cannot be undone.';
  const statusLine = document.getElementById('action-status');

  function showStatus(message, isError = false) {
    statusLine.textContent = message;
    statusLine.className = isError ? 'notice notice-error' : 'notice';
    statusLine.hidden = !message;
  }

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 401 || response.status === 403) throw new Error('Your session has ended. Sign in again as an editor.');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'The request failed. Try again.');
    return payload.data;
  }

  // The server renders the review page, so reloading its content keeps the status, badges and forms correct.
  async function refreshReview() {
    const response = await fetch(articleUrl, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error('The article could not be reloaded.');
    const fresh = new DOMParser().parseFromString(await response.text(), 'text/html').getElementById('review-content');
    if (!fresh) throw new Error('The article could not be reloaded.');
    document.getElementById('review-content').replaceWith(fresh);
  }

  function setBusy(busy) {
    root.querySelectorAll('#review-content button').forEach(button => { button.disabled = busy; });
  }

  async function perform(task, successMessage) {
    showStatus('Working\u2026');
    setBusy(true);
    try {
      await task();
      showStatus(successMessage);
    } catch (error) {
      showStatus(error instanceof TypeError ? 'The server could not be reached. Try again.' : error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function changeThenRefresh(method, path, body) {
    await request(method, `${articleUrl}${path}`, body);
    await refreshReview().catch(() => window.location.reload());
  }

  const handlers = {
    approve: () => perform(() => changeThenRefresh('POST', '/approve'), 'Approved. The new version is now public.'),
    return() {
      const note = document.getElementById('return-note').value.trim();
      if (!note) return showStatus('Write a correction note before returning the article.', true);
      return perform(() => changeThenRefresh('POST', '/return', { note }), 'Returned to the reporter with your note.');
    },
    async delete() {
      if (!window.confirm(DELETE_CONFIRMATION)) return;
      await perform(async () => {
        await request('DELETE', articleUrl);
        window.location.assign('/editor');
      }, 'Deleted. Going back to the desk\u2026');
    }
  };

  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (button && Object.hasOwn(handlers, button.dataset.action)) handlers[button.dataset.action]();
  });

  root.addEventListener('submit', event => {
    if (event.target.id !== 'edit-form') return;
    event.preventDefault();
    const content = Object.fromEntries(new FormData(event.target));
    perform(() => changeThenRefresh('PATCH', '', content), 'Changes saved to the working copy.');
  });
})();
