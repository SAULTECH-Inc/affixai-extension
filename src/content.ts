/**
 * Content script — runs on every page. Listens for FILL_FORM messages from
 * the popup, discovers all fillable form fields on the page, and
 * intelligently matches each field to the user's AffixAI vault data.
 *
 * Matching strategy (in priority order):
 *   1. `name` attribute exact/partial match against vault keys
 *   2. `id` attribute exact/partial match
 *   3. `autocomplete` attribute (maps to standard vault keys)
 *   4. Adjacent `<label>` text similarity
 *   5. `placeholder` text similarity
 */

type VaultData = Record<string, string | null>;

// Maps autocomplete tokens → vault key names.
const AUTOCOMPLETE_MAP: Record<string, string> = {
  'given-name': 'first_name',
  'family-name': 'last_name',
  name: 'full_name',
  email: 'email',
  tel: 'phone',
  'street-address': 'address_line1',
  'address-line1': 'address_line1',
  'address-line2': 'address_line2',
  'address-level1': 'state',
  'address-level2': 'city',
  'postal-code': 'postcode',
  'country-name': 'country',
  bday: 'date_of_birth',
  'bday-day': 'birth_day',
  'bday-month': 'birth_month',
  'bday-year': 'birth_year',
  organization: 'employer_name',
  'organization-title': 'job_title',
};

// Normalise a string for fuzzy comparison.
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Score how well a field attribute matches a vault key (0–1).
function similarity(attr: string, vaultKey: string): number {
  const a = normalise(attr);
  const b = normalise(vaultKey);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  // Substring overlap ratio
  let overlap = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) overlap++;
  }
  return overlap / Math.max(a.length, b.length, 1);
}

function bestVaultMatch(
  field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  vault: VaultData
): string | null {
  // 1. autocomplete attribute
  const ac = field.getAttribute('autocomplete');
  if (ac && AUTOCOMPLETE_MAP[ac]) {
    const mapped = AUTOCOMPLETE_MAP[ac];
    if (vault[mapped] != null) return vault[mapped];
  }

  // Collect candidates from name, id, placeholder.
  const attrs = [
    field.name,
    field.id,
    (field as HTMLInputElement).placeholder || '',
  ].filter(Boolean);

  // Also grab the associated <label> text.
  const labelEl =
    field.id
      ? document.querySelector<HTMLLabelElement>(`label[for="${field.id}"]`)
      : field.closest('label');
  if (labelEl) attrs.push(labelEl.textContent?.trim() ?? '');

  let bestKey: string | null = null;
  let bestScore = 0.35; // minimum threshold to bother filling

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
      !f.readOnly &&
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
