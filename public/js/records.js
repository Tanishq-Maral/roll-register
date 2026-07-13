let templateId = null;
let headers = [];

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  wireLogout();

  templateId = qs('template');
  if (!templateId) {
    window.location.href = '/dashboard.html';
    return;
  }

  let template;
  try {
    ({ template } = await apiFetch(`/api/templates/${templateId}`));
  } catch (err) {
    showToast(err.message, true);
    window.location.href = '/dashboard.html';
    return;
  }

  headers = template.headers;
  document.getElementById('sheet-name-label').textContent = template.name;
  document.getElementById('scan-more-link').href = `/scan.html?template=${templateId}`;
  document.getElementById('export-btn').href = `/api/templates/${templateId}/export`;

  await loadRecords();
})();

async function loadRecords() {
  const wrap = document.getElementById('table-wrap');
  let records = [];
  try {
    ({ records } = await apiFetch(`/api/records?templateId=${templateId}`));
  } catch (err) {
    showToast(err.message, true);
    return;
  }

  if (!records.length) {
    wrap.innerHTML = `<div class="empty-state">No records saved yet. Scan a form to add your first one.</div>`;
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}<th></th></tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  records.forEach((record) => {
    const tr = document.createElement('tr');
    tr.dataset.id = record.id;
    headers.forEach((h) => {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.textContent = record.data[h] || '';
      td.dataset.field = h;
      td.addEventListener('blur', () => updateRecord(tr));
      tr.appendChild(td);
    });
    const actionTd = document.createElement('td');
    actionTd.innerHTML = `<button class="btn btn-small btn-danger delete-row" title="Delete row">Delete</button>`;
    actionTd.querySelector('.delete-row').addEventListener('click', () => deleteRecord(record.id, tr));
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  wrap.innerHTML = '';
  wrap.appendChild(table);
}

async function updateRecord(tr) {
  const data = {};
  tr.querySelectorAll('td[data-field]').forEach((td) => {
    data[td.dataset.field] = td.textContent.trim();
  });
  try {
    await apiFetch(`/api/records/${tr.dataset.id}`, { method: 'PUT', body: { data } });
  } catch (err) {
    showToast(err.message, true);
  }
}

async function deleteRecord(id, tr) {
  if (!confirm('Delete this record?')) return;
  try {
    await apiFetch(`/api/records/${id}`, { method: 'DELETE' });
    tr.remove();
    showToast('Record deleted.');
  } catch (err) {
    showToast(err.message, true);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
