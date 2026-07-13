async function apiFetch(url, options = {}) {
  const opts = Object.assign({ credentials: 'include' }, options);
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    opts.body = JSON.stringify(opts.body);
  }
  const resp = await fetch(url, opts);
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    // no JSON body (e.g. file download) - fine
  }
  if (!resp.ok) {
    throw new Error((data && data.error) || `Request failed (${resp.status})`);
  }
  return data;
}

async function requireAuthOrRedirect() {
  try {
    const { user } = await apiFetch('/api/auth/me');
    return user;
  } catch (err) {
    window.location.href = '/login.html';
    return null;
  }
}

function showToast(message, isError = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.className = 'toast';
  }, 3200);
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function wireLogout(buttonId = 'logout-btn') {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });
}
