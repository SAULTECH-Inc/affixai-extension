/**
 * Service worker — handles auth token storage and API calls on behalf of
 * the content script (which cannot make credentialed cross-origin requests
 * without CORS pre-flight complications).
 */

const API_BASE: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) ||
  'https://affixai-backend.vercel.app/api/v1';

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
