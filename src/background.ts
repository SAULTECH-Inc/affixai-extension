/**
 * Service worker — handles auth token storage and API calls on behalf of
 * the content script (which cannot make credentialed cross-origin requests
 * without CORS pre-flight complications).
 */

const API_BASE: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) ||
  'https://affixai-backend.vercel.app/api/v1';

// ── Cloud picker state ────────────────────────────────────────────────────────
let cloudPickerWindowId: number | null = null;
let cloudPickerSource: 'drive' | 'dropbox' | null = null;

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (cloudPickerWindowId === null || cloudPickerSource === null) return;
  if (tab.windowId !== cloudPickerWindowId) return;
  if (changeInfo.status !== 'complete') return;

  const url = tab.url || '';
  let fileUrl: string | null = null;
  let filename = 'document.pdf';

  if (cloudPickerSource === 'drive') {
    // Detect when user opens a file: drive.google.com/file/d/FILE_ID/...
    const m = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) {
      fileUrl = `https://drive.google.com/uc?export=download&id=${m[1]}&confirm=t`;
      const raw = (tab.title || 'document').replace(/ - Google Drive$/, '').trim();
      filename = raw.endsWith('.pdf') ? raw : raw + '.pdf';
    }
  } else if (cloudPickerSource === 'dropbox') {
    // Detect when user opens a file: dropbox.com/s/... or dropbox.com/scl/...
    if (/dropbox\.com\/(s|scl)\//.test(url)) {
      fileUrl = url.split('?')[0] + '?dl=1';
      const raw = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'document.pdf');
      filename = raw.endsWith('.pdf') ? raw : 'document.pdf';
    }
  }

  if (fileUrl) {
    chrome.storage.session.set({ affixai_cloud_file: { url: fileUrl, filename } });
    const wid = cloudPickerWindowId;
    cloudPickerWindowId = null;
    cloudPickerSource = null;
    chrome.windows.remove(wid, () => { void chrome.runtime.lastError; });
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === cloudPickerWindowId) {
    cloudPickerWindowId = null;
    cloudPickerSource = null;
    chrome.storage.session.set({ affixai_cloud_picker_cancelled: true });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_VAULT') {
    handleFetchVault().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.type === 'FETCH_PENDING_DOCS') {
    handleFetchPendingDocs().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.type === 'SAVE_TOKEN') {
    chrome.storage.local.set({ affixai_token: msg.token }, () =>
      sendResponse({ ok: true })
    );
    return true;
  }

  if (msg.type === 'CLEAR_TOKEN') {
    chrome.storage.local.remove('affixai_token', () =>
      sendResponse({ ok: true })
    );
    return true;
  }

  if (msg.type === 'GET_AUTH_STATE') {
    chrome.storage.local.get('affixai_token', (res) =>
      sendResponse({ authenticated: !!res.affixai_token })
    );
    return true;
  }

  if (msg.type === 'UPLOAD_PDF_BYTES') {
    handleUploadPdfBytes(msg.base64, msg.filename).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: msg.url });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OPEN_CLOUD_PICKER') {
    cloudPickerSource = msg.source as 'drive' | 'dropbox';
    const url = msg.source === 'drive' ? 'https://drive.google.com' : 'https://www.dropbox.com';
    if (cloudPickerWindowId !== null) {
      chrome.windows.remove(cloudPickerWindowId, () => { void chrome.runtime.lastError; });
    }
    chrome.windows.create({ url, type: 'popup', width: 960, height: 700 }, (win) => {
      cloudPickerWindowId = win?.id ?? null;
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'CANCEL_CLOUD_PICKER') {
    if (cloudPickerWindowId !== null) {
      chrome.windows.remove(cloudPickerWindowId, () => { void chrome.runtime.lastError; });
      cloudPickerWindowId = null;
    }
    cloudPickerSource = null;
    sendResponse({ ok: true });
    return true;
  }

  // Content scripts cannot access chrome.storage.session directly — route here.
  if (msg.type === 'STORE_SIGNING_PDF') {
    chrome.storage.session.set(
      { affixai_signing_pdf: msg.base64, affixai_signing_name: msg.filename },
      () => sendResponse({ ok: true })
    );
    return true;
  }
});

async function getToken(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get('affixai_token', (res) =>
      resolve(res.affixai_token ?? null)
    );
  });
}

async function handleFetchVault(): Promise<Record<string, any>> {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(`${API_BASE}/data-vault/flat`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    await chrome.storage.local.remove('affixai_token');
    throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(`Vault fetch failed: ${res.status}`);
  return res.json();
}

async function handleFetchPendingDocs(): Promise<any[]> {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(`${API_BASE}/documents/pending-mine`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    await chrome.storage.local.remove('affixai_token');
    throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(`Failed to fetch pending documents: ${res.status}`);
  return res.json();
}

async function handleUploadPdfBytes(base64: string, filename: string): Promise<any> {
  const token = await getToken();
  if (!token) throw new Error('Not signed in to AffixAI. Click the extension icon to log in.');

  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/pdf' });

  const form = new FormData();
  form.append('file', blob, filename.endsWith('.pdf') ? filename : `${filename}.pdf`);

  const res = await fetch(`${API_BASE}/documents/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (res.status === 401) {
    await chrome.storage.local.remove('affixai_token');
    throw new Error('Session expired. Click the extension icon to sign in again.');
  }
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const doc = await res.json();
  return { document_id: doc.id };
}
