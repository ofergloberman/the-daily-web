(() => {
  const root = document.getElementById('review');
  if (!root) return;

  const articleUrl = `/editor/articles/${encodeURIComponent(root.dataset.articleId)}`;
  const DELETE_CONFIRMATION = 'Delete this article together with its comments and view statistics? This cannot be undone.';
  const statusLine = document.getElementById('action-status');
  const signInLink = document.getElementById('action-signin');
  const SESSION_ENDED_MESSAGE = 'Your session has ended. Sign in again as an editor.';
  const NETWORK_MESSAGE = 'The server could not be reached. Try again.';
  const REQUEST_FAILED_MESSAGE = 'The request failed. Try again.';

  function showStatus(message, isError = false, needsSignIn = false) {
    statusLine.textContent = message;
    statusLine.className = isError ? 'notice notice-error' : 'notice';
    statusLine.hidden = !message;
    signInLink.hidden = !needsSignIn;
  }

  // An error that remembers whether the Editor needs the sign-in link.
  function requestError(message, needsSignIn = false) {
    return Object.assign(new Error(message), { needsSignIn });
  }

  function showFailure(error) {
    showStatus(error instanceof TypeError ? NETWORK_MESSAGE : error.message, true, error.needsSignIn === true);
  }

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    // A proxy's HTML error page is not JSON; it falls through to the generic message below.
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw requestError(SESSION_ENDED_MESSAGE, true);
    if (response.status === 403) throw requestError(payload.message || SESSION_ENDED_MESSAGE);
    if (!response.ok || payload.data === undefined) throw requestError(payload.message || REQUEST_FAILED_MESSAGE);
    return payload.data;
  }

  // The server renders the review page, so reloading its content keeps the status, badges and forms correct.
  // The page is HTML on success and when the article is missing (its own not-found page). Asking for JSON
  // makes sign-in, permission and server errors (401, 403, 500, 503) come back as small JSON, not an error page.
  async function refreshReview() {
    const response = await fetch(articleUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
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
      showFailure(error);
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
