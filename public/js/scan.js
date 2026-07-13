let templateId = null;
let headers = [];
let focusedInput = null;
let selectedBlob = null;
let savedCount = 0;
let cameraStream = null;
let lastSource = null; // 'camera' | 'upload'

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  wireLogout();

  templateId = qs('template');
  if (!templateId) {
    showToast('No sheet selected.', true);
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
  document.getElementById('view-records-link').href = `/records.html?template=${templateId}`;

  const imageInput = document.getElementById('image-input');
  const extractBtn = document.getElementById('extract-btn');
  const previewWrap = document.getElementById('preview-wrap');
  const previewImg = document.getElementById('preview-img');

  imageInput.addEventListener('change', async () => {
    document.getElementById('extract-error').textContent = '';
    if (!imageInput.files.length) {
      hideExtractBtn();
      return;
    }
    try {
      selectedBlob = await resizeImage(imageInput.files[0], 1800, 0.85);
      lastSource = 'upload';
      previewImg.src = URL.createObjectURL(selectedBlob);
      previewWrap.style.display = 'block';
      showExtractBtn();
    } catch (err) {
      showToast('Could not read that image.', true);
    }
  });

  extractBtn.addEventListener('click', extractText);

  document.getElementById('open-camera-btn').addEventListener('click', openCamera);
  document.getElementById('cancel-camera-btn').addEventListener('click', closeCamera);
  document.getElementById('capture-btn').addEventListener('click', capturePhoto);
  document.getElementById('remove-photo-btn').addEventListener('click', clearSelectedPhoto);
})();

function showExtractBtn() {
  const extractBtn = document.getElementById('extract-btn');
  extractBtn.style.display = 'inline-flex';
  extractBtn.disabled = false;
}

function hideExtractBtn() {
  const extractBtn = document.getElementById('extract-btn');
  extractBtn.style.display = 'none';
  extractBtn.disabled = true;
}

// Clears whichever photo (camera or uploaded) is currently selected, so the
// user is back to choosing "Take photo" / "Upload photo" from scratch.
function clearSelectedPhoto() {
  document.getElementById('preview-wrap').style.display = 'none';
  document.getElementById('preview-img').src = '';
  document.getElementById('image-input').value = '';
  document.getElementById('extract-error').textContent = '';
  hideExtractBtn();
  selectedBlob = null;
  lastSource = null;
}

async function openCamera() {
  const errorEl = document.getElementById('extract-error');
  errorEl.textContent = '';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Camera access is not supported in this browser. Please upload a photo instead.', true);
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (err) {
    showToast('Could not access the camera. Check permissions, or upload a photo instead.', true);
    return;
  }

  document.getElementById('preview-wrap').style.display = 'none';
  document.getElementById('camera-wrap').style.display = 'block';
  const video = document.getElementById('camera-video');
  video.srcObject = cameraStream;
}

function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  document.getElementById('camera-wrap').style.display = 'none';
}

async function capturePhoto() {
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  const previewWrap = document.getElementById('preview-wrap');
  const previewImg = document.getElementById('preview-img');

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

  const rawBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('capture failed'))), 'image/jpeg', 0.92);
  });

  closeCamera();

  try {
    selectedBlob = await resizeImage(rawBlob, 1800, 0.85);
    lastSource = 'camera';
    previewImg.src = URL.createObjectURL(selectedBlob);
    previewWrap.style.display = 'block';
    showExtractBtn();
  } catch (err) {
    showToast('Could not process that photo. Please try again.', true);
  }
}

// Downscale large phone photos client-side before upload, for speed and reliability.
// Accepts either a File (from <input type=file>) or a Blob (from camera capture).
function resizeImage(fileOrBlob, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('resize failed'))), 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(fileOrBlob);
  });
}

async function extractText() {
  const extractBtn = document.getElementById('extract-btn');
  const errorEl = document.getElementById('extract-error');
  errorEl.textContent = '';
  extractBtn.disabled = true;
  extractBtn.textContent = 'Extracting…';

  try {
    const fd = new FormData();
    fd.append('image', selectedBlob, 'form.jpg');
    fd.append('templateId', templateId);
    const { rawText, lines, mapped } = await apiFetch('/api/scans/extract', { method: 'POST', body: fd });
    renderReview(lines, mapped, rawText);
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    extractBtn.disabled = false;
    extractBtn.textContent = 'Extract text';
  }
}

function renderReview(lines, mapped, rawText) {
  document.getElementById('review-area').style.display = 'block';

  const fieldsContainer = document.getElementById('fields-container');
  fieldsContainer.innerHTML = '';
  let matchedCount = 0;

  headers.forEach((header) => {
    const value = mapped[header] || '';
    if (value) matchedCount++;

    const wrap = document.createElement('div');
    wrap.className = 'field' + (value ? ' matched' : '');
    wrap.innerHTML = `
      <label>${escapeHtml(header)}</label>
      <input type="text" data-field="${escapeHtml(header)}" value="${escapeHtml(value)}" placeholder="${value ? '' : 'Not auto-matched — click a line on the right, or type it in'}" />
    `;
    const input = wrap.querySelector('input');
    input.addEventListener('focus', () => setFocused(input));
    input.addEventListener('input', () => {
      wrap.classList.toggle('matched', !!input.value);
    });
    fieldsContainer.appendChild(wrap);
  });

  const stamp = document.getElementById('match-stamp');
  stamp.textContent = `${matchedCount} / ${headers.length} matched`;
  stamp.className = 'stamp ' + (matchedCount === headers.length ? 'matched' : 'unmatched');

  const rawLinesEl = document.getElementById('raw-lines');
  rawLinesEl.innerHTML = '';
  if (!lines.length) {
    rawLinesEl.innerHTML = '<div class="hint">No text was detected in that image.</div>';
  }
  lines.forEach((line) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'raw-line';
    btn.textContent = line;
    btn.addEventListener('click', () => {
      if (!focusedInput) {
        showToast('Click a field on the left first, then click a line to fill it.', true);
        return;
      }
      const colonSplit = line.match(/^[^:\-–]{1,40}[:\-–]\s*(.+)$/);
      focusedInput.value = colonSplit ? colonSplit[1].trim() : line;
      focusedInput.dispatchEvent(new Event('input'));
    });
    rawLinesEl.appendChild(btn);
  });

  focusedInput = fieldsContainer.querySelector('input');

  document.getElementById('save-record-btn').onclick = saveRecord;
}

function setFocused(input) {
  focusedInput = input;
}

async function saveRecord() {
  const inputs = document.querySelectorAll('#fields-container input');
  const data = {};
  inputs.forEach((input) => {
    data[input.dataset.field] = input.value.trim();
  });

  const btn = document.getElementById('save-record-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await apiFetch('/api/records', { method: 'POST', body: { templateId, data } });
    savedCount++;
    showToast('Record saved.');
    document.getElementById('saved-summary').style.display = 'block';
    document.getElementById('saved-count-badge').textContent = `${savedCount} saved this session`;
    resetForNextScan();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save this record';
  }
}

function resetForNextScan() {
  document.getElementById('review-area').style.display = 'none';
  document.getElementById('preview-wrap').style.display = 'none';
  document.getElementById('preview-img').src = '';
  document.getElementById('image-input').value = '';
  hideExtractBtn();
  closeCamera();
  selectedBlob = null;
  lastSource = null;
  focusedInput = null;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
