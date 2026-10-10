(() => {
  const section = document.getElementById('comments');
  const form = section?.querySelector('form');
  if (!form) return;

  const list = section.querySelector('[data-comment-list]');
  const empty = section.querySelector('[data-comments-empty]');
  const message = section.querySelector('[data-comment-message]');
  const button = form.querySelector('button[type="submit"]');
  const name = form.elements.namedItem('displayName');
  const body = form.elements.namedItem('body');
  let submitting = false;

  function announce(text, error = false) {
    message.textContent = text;
    message.classList.toggle('notice-error', error);
  }

  function appendComment(comment) {
    const item = document.createElement('li');
    item.dataset.commentId = comment.id;
    const author = document.createElement('strong');
    author.textContent = comment.displayName;
    const time = document.createElement('time');
    time.dateTime = comment.createdAt;
    time.textContent = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'long', timeZone: 'Asia/Jerusalem'
    }).format(new Date(comment.createdAt));
    const text = document.createElement('p');
    text.className = 'comment-body';
    text.textContent = comment.body;
    item.append(author, ' · ', time, text);
    list.append(item);
    if (empty) empty.hidden = true;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const payload = { articleId: section.dataset.articleId, body: body.value.trim() };
    if (name) payload.displayName = name.value.trim();
    if (!payload.body || payload.body.length > 2000 ||
        (name && (!payload.displayName || payload.displayName.length > 100))) {
      announce('Enter a name (1–100 characters) and a comment (1–2,000 characters).', true);
      (name && !payload.displayName ? name : body).focus();
      return;
    }

    submitting = true;
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    const submittedBody = body.value;
    announce('Posting your comment…');
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429) {
          const seconds = Number(data.retryAfterSeconds || response.headers.get('Retry-After'));
          announce('You can post three comments per minute.' +
            (Number.isFinite(seconds) && seconds > 0
              ? ` Please try again in ${Math.ceil(seconds)} seconds.` : ' Please try again shortly.'), true);
        } else if (response.status === 400) {
          announce('Check your name (1–100 characters) and comment (1–2,000 characters), then try again.', true);
        } else if (response.status === 404) {
          announce('This article is no longer available for comments.', true);
        } else {
          announce('Unable to post your comment. Your text has been kept; please try again later.', true);
        }
        return;
      }
      const comment = data.comment;
      if (!comment || typeof comment.id !== 'string' || typeof comment.displayName !== 'string' ||
          typeof comment.body !== 'string' || !Number.isFinite(Date.parse(comment.createdAt))) {
        throw new Error('Invalid comment response');
      }
      appendComment(comment);
      // Keep any new text typed while the request was in flight.
      if (body.value === submittedBody) body.value = '';
      announce('Your comment was posted.');
    } catch {
      announce('Could not confirm that your comment was posted. Your text has been kept. Check your connection before trying again.', true);
    } finally {
      submitting = false;
      button.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
})();
