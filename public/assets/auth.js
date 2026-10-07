// Shared by the log in and sign up pages: posts the form as JSON and goes to the app on success.
(function () {
  const form = document.querySelector('form[data-endpoint]');
  const errorBox = document.getElementById('error');
  const button = form.querySelector('button');
  const label = button.textContent;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.remove('show');
    button.disabled = true;
    button.textContent = 'One moment…';
    try {
      const res = await fetch(form.dataset.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      window.location.href = '/';
    } catch (err) {
      errorBox.textContent = err.message === 'Failed to fetch' ? 'Can’t reach the server. Check your connection and try again.' : err.message;
      errorBox.classList.add('show');
      button.disabled = false;
      button.textContent = label;
    }
  });
})();
