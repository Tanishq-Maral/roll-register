(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;

  document.getElementById('user-name').textContent = user.name;
  wireLogout();

  await loadTemplates();

  document.getElementById('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('upload-error');
    const btn = document.getElementById('upload-btn');
    errorEl.textContent = '';
    const fileInput = document.getElementById('sheet-file');
    if (!fileInput.files.length) return;

    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    fd.append('name', document.getElementById('sheet-name').value.trim());

    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      await apiFetch('/api/templates', { method: 'POST', body: fd });
      document.getElementById('upload-form').reset();
      showToast('Sheet uploaded.');
      await loadTemplates();
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Upload sheet';
    }
  });
})();

async function loadTemplates() {
  const container = document.getElementById('templates-list');
  container.innerHTML = '';
  let templates = [];
  try {
    ({ templates } = await apiFetch('/api/templates'));
  } catch (err) {
    showToast(err.message, true);
    return;
  }

  if (!templates.length) {
    container.innerHTML = `<div class="card empty-state">No sheets yet. Upload one above to get started.</div>`;
    return;
  }

  for (const t of templates) {
    const card = document.createElement('div');
    card.className = 'card template-card';
    card.innerHTML = `
      <div>
        <h3>${escapeHtml(t.name)}</h3>
        <div class="meta">${t.headers.length} field${t.headers.length === 1 ? '' : 's'} · ${t.existingRowCount} existing row${t.existingRowCount === 1 ? '' : 's'} · fields: ${t.headers.map(escapeHtml).join(', ')}</div>
      </div>
      <div class="actions">
        <a class="btn btn-primary btn-small" href="/scan.html?template=${t.id}">Scan a form</a>
        <a class="btn btn-small" href="/records.html?template=${t.id}">View records</a>
        <button class="btn btn-small delete-btn" data-id="${t.id}">Delete</button>
      </div>
    `;
    container.appendChild(card);
  }

  container.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this sheet and all of its saved records? This cannot be undone.')) return;
      try {
        await apiFetch(`/api/templates/${btn.dataset.id}`, { method: 'DELETE' });
        showToast('Sheet deleted.');
        await loadTemplates();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
