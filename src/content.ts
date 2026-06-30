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
