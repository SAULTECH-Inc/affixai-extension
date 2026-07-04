/**
 * Content script — runs on every page. Listens for FILL_FORM messages from
 * the popup, discovers all fillable form fields on the page, and
 * intelligently matches each field to the user's AffixAI vault data.
 *
 * Matching strategy (in priority order):
 *   1. `autocomplete` attribute (maps to actual vault key names)
 *   2. Exact / partial match of `name`, `id`, `placeholder` against vault keys
 *      (the backend /flat endpoint now also emits alias-normalised keys such as
 *       "email_address", "phone_number", "street_address" so these match directly)
 *   3. Adjacent <label> text matched the same way
 */

type VaultData = Record<string, string | null>;

// Maps HTML autocomplete tokens → the actual vault key names (or their
// alias-normalised equivalents as returned by the /flat endpoint).
const AUTOCOMPLETE_MAP: Record<string, string> = {
  'given-name':         'first_name',
  'family-name':        'last_name',
  name:                 'full_legal_name',
  email:                'primary_email',
  tel:                  'primary_phone',
  'street-address':     'street_address_line_1',
  'address-line1':      'street_address_line_1',
  'address-line2':      'street_address_line_2',
  'address-level1':     'state_province',
  'address-level2':     'city',
  'postal-code':        'postal_code',
  'country-name':       'country',
  bday:                 'date_of_birth',
  organization:         'employer_name',
  'organization-title': 'job_title',
};

// Normalise a string for fuzzy comparison — lowercase, strip non-alphanumeric.
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Split on word / underscore / camelCase boundaries.
function tokens(s: string): string[] {
  // Insert a space before uppercase letters (camelCase → words), then split.
  const spaced = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Score how well a form field attribute matches a vault key (0–1).
 *
 * Uses both character-level overlap and token-set overlap so that:
 *   "emailAddress"   ↔  "email_address"       → 1.0
 *   "phone"          ↔  "primary_phone"        → 0.9  (token "phone" fully covered)
 *   "email"          ↔  "primary_email"        → 0.9
 *   "address"        ↔  "street_address_line_1"→ 0.67 (partial token overlap)
 */
function similarity(attr: string, vaultKey: string): number {
  const a = normalise(attr);
  const b = normalise(vaultKey);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;

  // Token-set overlap: what fraction of the shorter token set appears in the longer?
  const ta = tokens(attr);
  const tb = tokens(vaultKey);
  const setA = new Set(ta);
  const setB = new Set(tb);
  const shorter = setA.size <= setB.size ? setA : setB;
  const longer  = setA.size <= setB.size ? setB : setA;
  let shared = 0;
  for (const t of shorter) if (longer.has(t)) shared++;
  const tokenScore = shorter.size > 0 ? shared / shorter.size : 0;

  // Character prefix overlap ratio (fallback for non-tokenisable strings).
  let overlap = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) overlap++;
  }
  const charScore = overlap / Math.max(a.length, b.length, 1);

  return Math.max(tokenScore * 0.9, charScore);
}

function bestVaultMatch(
  field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  vault: VaultData
): string | null {
  // 1. autocomplete attribute — direct key lookup (highest confidence).
  const ac = field.getAttribute('autocomplete');
  if (ac && AUTOCOMPLETE_MAP[ac]) {
    const mapped = AUTOCOMPLETE_MAP[ac];
    if (vault[mapped] != null) return vault[mapped];
  }

  // Collect candidates: name, id, placeholder, then associated <label> text.
  const attrs = [
    field.name,
    field.id,
    (field as HTMLInputElement).placeholder || '',
  ].filter(Boolean);

  const labelEl =
    field.id
      ? document.querySelector<HTMLLabelElement>(`label[for="${field.id}"]`)
      : field.closest('label');
  if (labelEl) attrs.push(labelEl.textContent?.trim() ?? '');

  let bestKey: string | null = null;
  let bestScore = 0.3; // minimum threshold to avoid spurious fills

  for (const attr of attrs) {
    for (const [vaultKey, value] of Object.entries(vault)) {
      if (!value) continue;
      const score = similarity(attr, vaultKey);
      if (score > bestScore) {
        bestScore = score;
        bestKey = vaultKey;
      }
    }
  }

  return bestKey ? vault[bestKey]! : null;
}

function fillField(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  // Set via native setter so React's synthetic event system picks up the change.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  // Visual flash to show the user what was filled.
  el.style.transition = 'box-shadow 0.3s';
  el.style.boxShadow = '0 0 0 2px rgba(168,85,247,0.5)';
  setTimeout(() => {
    el.style.boxShadow = '';
  }, 1500);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_PDF_BASE64') {
    fetchPdfBase64().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'INJECT_SIGNING_OVERLAY') {
    injectSigningIframe();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type !== 'FILL_FORM') return;

  const vault: VaultData = msg.vault;
  const fields = Array.from(
    document.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]), textarea, select')
  ).filter(
    (f) =>
      !f.disabled &&
      !('readOnly' in f && f.readOnly) &&
      f.offsetParent !== null // visible check
  );

  let filled = 0;
  for (const field of fields) {
    const value = bestVaultMatch(field, vault);
    if (value) {
      fillField(field, value);
      filled++;
    }
  }

  sendResponse({ filled, total: fields.length });
});

// ---- PDF Toolbox -------------------------------------------------------
// When the user is viewing a PDF in the browser, inject a floating side
// panel so they can upload the PDF to Affix AI without going to the
// dashboard. Uses Shadow DOM to avoid CSS conflicts with any host page.

const PDF_EDITOR_BASE = 'https://affix-ai.com/documents';

function isPdfPage(): boolean {
  return (
    document.contentType === 'application/pdf' ||
    /\.pdf(\?|#|$)/i.test(window.location.href)
  );
}

async function fetchPdfBase64(): Promise<string> {
  const url = window.location.href;
  let buf: ArrayBuffer;

  if (url.startsWith('file://')) {
    // fetch() does not support file:// even with "Allow access to file URLs".
    // Use XMLHttpRequest which works for local files.
    buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        // XHR to file:// returns status 0 on success (no HTTP status code).
        if (xhr.status === 0 || xhr.status === 200) {
          resolve(xhr.response as ArrayBuffer);
        } else {
          reject(new Error(`Could not read the file (${xhr.status})`));
        }
      };
      xhr.onerror = () =>
        reject(new Error(
          'Cannot read this local PDF. Enable "Allow access to file URLs" in Chrome → Extensions → AffixAI.'
        ));
      xhr.send();
    });
  } else {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Could not read the PDF (${resp.status})`);
    buf = await resp.arrayBuffer();
  }

  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength)));
  }
  return btoa(binary);
}

function getPdfFilename(): string {
  try {
    const parts = new URL(window.location.href).pathname.split('/');
    const last = parts[parts.length - 1];
    if (/\.pdf$/i.test(last)) return decodeURIComponent(last);
  } catch { /* ignore */ }
  const title = (document.title || 'document').replace(/[^\w\s.-]/g, '_').trim();
  return title.toLowerCase().endsWith('.pdf') ? title : `${title}.pdf`;
}

const TOOLBOX_HTML = `
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  .wrap{display:flex;align-items:center}
  .tab{
    writing-mode:vertical-rl;text-orientation:mixed;rotate:180deg;
    background:linear-gradient(to bottom,#a855f7,#ec4899);
    color:#fff;border:none;cursor:pointer;
    padding:10px 7px;border-radius:8px 0 0 8px;
    font-size:11px;font-weight:700;letter-spacing:.08em;
    box-shadow:-2px 0 14px rgba(168,85,247,.5);
    transition:opacity .15s;min-height:84px;
    font-family:system-ui,-apple-system,sans-serif;
  }
  .tab:hover{opacity:.88}
  .panel{
    background:#fff;border-radius:12px 0 0 12px;
    box-shadow:-4px 0 24px rgba(0,0,0,.13);
    width:224px;overflow:hidden;
    transition:width .22s cubic-bezier(.4,0,.2,1);
  }
  .panel.closed{width:0}
  .inner{
    padding:13px 12px;display:flex;flex-direction:column;gap:7px;
    width:224px;font-family:system-ui,-apple-system,sans-serif;
  }
  .brand{display:flex;align-items:center;gap:7px;margin-bottom:2px}
  .dot{
    width:24px;height:24px;border-radius:7px;flex-shrink:0;
    background:linear-gradient(135deg,#a855f7,#ec4899);
    display:flex;align-items:center;justify-content:center;
    color:#fff;font-size:13px;font-weight:bold;
  }
  .bname{font-size:13px;font-weight:700;color:#111;line-height:1.2}
  .bsub{font-size:9.5px;color:#888;text-transform:uppercase;letter-spacing:.05em;font-weight:500}
  .st{border-radius:7px;padding:7px 9px;font-size:11px;line-height:1.45;display:none}
  .st.on{display:block}
  .st.ld{background:#f5f3ff;color:#6d28d9}
  .st.ok{background:#f0fdf4;color:#166534}
  .st.er{background:#fef2f2;color:#991b1b}
  .st.nf{background:#eff6ff;color:#1e40af}
  .spin{
    display:inline-block;width:9px;height:9px;
    border:1.5px solid currentColor;border-top-color:transparent;
    border-radius:50%;animation:spin .65s linear infinite;
    margin-right:5px;vertical-align:-1px;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .btn{
    width:100%;padding:9px 11px;border-radius:8px;border:none;
    cursor:pointer;font-size:12px;font-weight:600;
    display:flex;align-items:center;gap:7px;text-align:left;
    font-family:inherit;transition:opacity .15s,transform .1s;line-height:1;
  }
  .btn:active:not(:disabled){transform:scale(.97)}
  .btn:disabled{opacity:.45;cursor:default;pointer-events:none}
  .p{background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff}
  .p:hover:not(:disabled){opacity:.88}
  .s{background:#f9fafb;color:#374151;border:1px solid #e5e7eb}
  .s:hover:not(:disabled){background:#f3f4f6}
  .bi{font-size:14px;line-height:1;flex-shrink:0}
  .bl{flex:1}.bt{display:block}.bs{display:block;font-size:10px;font-weight:400;opacity:.72;margin-top:2px}
</style>
<div class="wrap">
  <button class="tab" id="tab">✦ AffixAI</button>
  <div class="panel" id="panel">
    <div class="inner">
      <div class="brand">
        <div class="dot">✦</div>
        <div><div class="bname">AffixAI</div><div class="bsub">PDF Toolbox</div></div>
      </div>
      <div id="st" class="st"></div>
      <button class="btn p" id="b1">
        <span class="bi">✍️</span>
        <span class="bl"><span class="bt">Open in Affix AI</span><span class="bs">Upload &amp; edit in full editor</span></span>
      </button>
      <button class="btn s" id="b2">
        <span class="bi">⚡</span>
        <span class="bl"><span class="bt">Auto-sign</span><span class="bs">Fill from vault &amp; sign instantly</span></span>
      </button>

      <div class="divider" style="height:1px;background:#f0f0f0;margin:2px 0"></div>

      <button class="btn s" id="b3" style="background:#f0f9ff;border-color:#bae6fd;color:#0369a1">
        <span class="bi">✏️</span>
        <span class="bl"><span class="bt">Sign here</span><span class="bs">Draw &amp; place signature inline</span></span>
      </button>
    </div>
  </div>
</div>`;

function injectPdfToolbox(): void {
  if (document.getElementById('affixai-tb')) return;

  const host = document.createElement('div');
  host.id = 'affixai-tb';
  // Start vertically centered; drag will replace top with px value
  Object.assign(host.style, {
    position: 'fixed',
    top: '50%',
    right: '0',
    transform: 'translateY(-50%)',
    zIndex: '2147483647',
    userSelect: 'none',
  });

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TOOLBOX_HTML;
  document.documentElement.appendChild(host);

  const panel = shadow.getElementById('panel')!;
  const tab   = shadow.getElementById('tab')!;
  const st    = shadow.getElementById('st')!;
  const b1    = shadow.getElementById('b1') as HTMLButtonElement;
  const b2    = shadow.getElementById('b2') as HTMLButtonElement;
  const b3    = shadow.getElementById('b3') as HTMLButtonElement;
  let open    = true;

  // ---- Drag the toolbox (tab is the drag handle) ---------------------------
  // If the user moves > 5px it's a drag; otherwise it's a click (toggle).
  tab.addEventListener('mousedown', (e: MouseEvent) => {
    const startX = e.clientX;
    const startY = e.clientY;
    // Capture the current pixel top before clearing the CSS transform
    const rect = host.getBoundingClientRect();
    let currentTop = rect.top;
    let didDrag = false;

    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const dx = ev.clientX - startX;
      if (!didDrag && Math.abs(dy) < 5 && Math.abs(dx) < 5) return;
      if (!didDrag) {
        // First real move — lock top to pixels so transform doesn't interfere
        didDrag = true;
        host.style.transform = 'none';
        host.style.top = `${currentTop}px`;
      }
      const newTop = Math.max(0, Math.min(window.innerHeight - host.offsetHeight, currentTop + dy));
      host.style.top = `${newTop}px`;
    };

    const onUp = (_ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!didDrag) {
        // It was a click — toggle the panel
        open = !open;
        panel.classList.toggle('closed', !open);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ---- Status & busy helpers -----------------------------------------------
  function setStatus(msg: string, cls: string) {
    st.className = `st on ${cls}`;
    st.innerHTML = cls === 'ld' ? `<span class="spin"></span>${msg}` : msg;
  }
  function clearSt() { st.className = 'st'; st.textContent = ''; }
  function busy(v: boolean) { b1.disabled = v; b2.disabled = v; b3.disabled = v; }

  // ---- Safe sendMessage — handles idle service worker ----------------------
  async function send(msg: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---- File picker for local PDFs (file:// protocol) ----------------------
  // fetch() and XHR both fail for file:// URLs in content scripts.
  // The only reliable approach is a user-triggered <input type="file">.
  // input.click() must be called synchronously before any await — Chrome's
  // user-activation window covers synchronous code within the click handler.
  function pickLocalPdf(): Promise<string> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,.pdf';
      input.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0;pointer-events:none';
      document.documentElement.appendChild(input);
      const cleanup = () => { try { document.documentElement.removeChild(input); } catch { /* ignore */ } };
      input.addEventListener('change', async () => {
        cleanup();
        const file = input.files?.[0];
        if (!file) { resolve(''); return; }
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.byteLength; i += 8192)
          bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.byteLength)));
        resolve(btoa(bin));
      });
      input.addEventListener('cancel', () => { cleanup(); resolve(''); });
      input.click(); // synchronous — still within user-gesture context
    });
  }

  // ---- Button handlers -----------------------------------------------------
  async function run(mode: 'edit' | 'auto') {
    busy(true);
    setStatus('Checking sign-in…', 'ld');

    // For local files, trigger the file picker NOW — synchronously before
    // any await so we're still inside the user-gesture activation window.
    let localBase64 = '';
    if (window.location.href.startsWith('file://')) {
      setStatus('Select the PDF file…', 'ld');
      localBase64 = await pickLocalPdf(); // input.click() ran synchronously above
      if (!localBase64) { busy(false); clearSt(); return; }
    }

    try {
      const auth = await send({ type: 'GET_AUTH_STATE' });
      if (!auth?.authenticated) {
        setStatus('Sign in to AffixAI first — click the ✦ icon in the toolbar.', 'nf');
        busy(false);
        return;
      }
      setStatus('Reading PDF…', 'ld');
      const base64 = localBase64 || await fetchPdfBase64();
      setStatus('Uploading…', 'ld');
      const res = await send({ type: 'UPLOAD_PDF_BYTES', base64, filename: getPdfFilename() });
      if (res?.error) throw new Error(res.error);
      const id = res?.document_id || res?.id;
      if (!id) throw new Error('Upload returned no document ID');

      const url = mode === 'auto'
        ? `https://affix-ai.com/auto-sign?doc=${id}`
        : `${PDF_EDITOR_BASE}/${id}/edit`;

      setStatus('Opened in Affix AI ✓', 'ok');
      setTimeout(clearSt, 3000);
      busy(false);
      await send({ type: 'OPEN_TAB', url });
    } catch (err: any) {
      setStatus(err.message || 'Something went wrong.', 'er');
      busy(false);
    }
  }

  async function openSigningOverlay() {
    busy(true);
    setStatus('Checking sign-in…', 'ld');

    // Same as run() — file picker must be triggered before any await.
    let localBase64 = '';
    if (window.location.href.startsWith('file://')) {
      setStatus('Select the PDF file…', 'ld');
      localBase64 = await pickLocalPdf();
      if (!localBase64) { busy(false); clearSt(); return; }
    }

    try {
      const auth = await send({ type: 'GET_AUTH_STATE' });
      if (!auth?.authenticated) {
        setStatus('Sign in to AffixAI first — click the ✦ icon in the toolbar.', 'nf');
        busy(false);
        return;
      }
      setStatus('Reading PDF…', 'ld');
      const base64 = localBase64 || await fetchPdfBase64();
      await chrome.storage.session.set({
        affixai_signing_pdf: base64,
        affixai_signing_name: getPdfFilename(),
      });
      clearSt();
      busy(false);
      injectSigningIframe();
    } catch (err: any) {
      setStatus(err.message || 'Something went wrong.', 'er');
      busy(false);
    }
  }

  b1.addEventListener('click', () => run('edit'));
  b2.addEventListener('click', () => run('auto'));
  b3.addEventListener('click', () => openSigningOverlay());
}

function injectSigningIframe(): void {
  // Remove any existing overlay
  document.getElementById('affixai-signing-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'affixai-signing-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2147483646',
    background: 'rgba(0,0,0,0.6)',
  });

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('signing.html');
  Object.assign(iframe.style, {
    position: 'absolute', inset: '0',
    width: '100%', height: '100%',
    border: 'none',
  });
  overlay.appendChild(iframe);
  document.documentElement.appendChild(overlay);

  // Listen for the signing page to request close
  window.addEventListener('message', function onClose(e: MessageEvent) {
    if (e.data?.type === 'AFFIXAI_CLOSE_SIGNING') {
      overlay.remove();
      window.removeEventListener('message', onClose);
    }
  });
}

if (isPdfPage()) {
  injectPdfToolbox();
}
