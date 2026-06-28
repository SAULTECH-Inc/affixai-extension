/**
 * Service worker — handles auth token storage and API calls on behalf of
 * the content script (which cannot make credentialed cross-origin requests
 * without CORS pre-flight complications).
 */

const API_BASE =
  process.env.VITE_API_URL || 'https://affixai-backend.vercel.app/api/v1';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_VAULT') {
    handleFetchVault().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true; // keep message channel open for async response
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

  // Fetch the full vault flat-map: every field value the user has stored.
  const res = await fetch(`${API_BASE}/data-vault/flat`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // Token expired — clear it so the popup prompts re-login.
    await chrome.storage.local.remove('affixai_token');
    throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(`Vault fetch failed: ${res.status}`);
  return res.json();
}
