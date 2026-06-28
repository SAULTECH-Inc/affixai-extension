/**
 * Extension popup — rendered when the user clicks the toolbar icon.
 *
 * States:
 *   - terms   : first launch; user must accept T&C
 *   - login   : authenticated; show sign-in form
 *   - ready   : authenticated; show "Fill this page" button + status
 *   - filling : API call in progress
 */
import { useEffect, useState } from 'react';

const API_BASE =
  (process.env.VITE_API_URL as string | undefined) ||
  'https://affixai-backend.vercel.app/api/v1';

type PopupState = 'loading' | 'terms' | 'login' | 'ready' | 'filling';

export default function Popup() {
  const [state, setState] = useState<PopupState>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ filled: number; total: number } | null>(null);

  useEffect(() => {
    // Check T&C acceptance then auth state.
    chrome.storage.local.get(['affixai_terms', 'affixai_token'], (res) => {
      if (!res.affixai_terms) {
        setState('terms');
      } else if (!res.affixai_token) {
        setState('login');
      } else {
        setState('ready');
      }
    });
  }, []);

  async function acceptTerms() {
    await chrome.storage.local.set({ affixai_terms: true });
    setState('login');
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Login failed');
      }
      const { access_token } = await res.json();
      await chrome.runtime.sendMessage({ type: 'SAVE_TOKEN', token: access_token });
      setPassword('');
      setState('ready');
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleFill() {
    setState('filling');
    setResult(null);
    setError('');
    try {
      const vault = await chrome.runtime.sendMessage({ type: 'FETCH_VAULT' });
      if (vault.error) throw new Error(vault.error);

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'FILL_FORM',
        vault,
      });
      setResult(response);
    } catch (err: any) {
      setError(err.message);
      if (err.message.includes('Session expired')) setState('login');
    } finally {
      if (state === 'filling') setState('ready');
    }
  }

  async function handleSignOut() {
    await chrome.runtime.sendMessage({ type: 'CLEAR_TOKEN' });
    setState('login');
    setResult(null);
  }

  // ---- Render ---------------------------------------------------------------

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="h-6 w-6 rounded-full border-2 border-brand/30 border-t-brand animate-spin" />
      </div>
    );
  }

  if (state === 'terms') {
    return (
      <div className="p-5 space-y-4">
        <Header />
        <div className="text-sm text-gray-600 leading-relaxed">
          <p className="font-semibold text-gray-900 mb-2">Before you start:</p>
          <ul className="list-disc pl-4 space-y-1 text-[13px]">
            <li>AffixAI reads your encrypted vault to fill forms.</li>
            <li>Your data is never stored on-device or sent to third parties.</li>
            <li>You can review and clear all data from your AffixAI account.</li>
            <li>
              By using this extension you agree to our{' '}
              <a
                href="https://affix-ai.com/terms"
                target="_blank"
                rel="noreferrer"
                className="text-purple-600 hover:underline"
              >
                Terms of Service
              </a>{' '}
              and{' '}
              <a
                href="https://affix-ai.com/privacy"
                target="_blank"
                rel="noreferrer"
                className="text-purple-600 hover:underline"
              >
                Privacy Policy
              </a>
              .
            </li>
          </ul>
        </div>
        <button
          onClick={acceptTerms}
          className="w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-semibold hover:opacity-90 transition"
        >
          Accept & Continue
        </button>
      </div>
    );
  }

  if (state === 'login') {
    return (
      <div className="p-5 space-y-4">
        <Header />
        <form onSubmit={handleLogin} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full h-9 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full h-9 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40"
            />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            className="w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-semibold hover:opacity-90 transition"
          >
            Sign in to AffixAI
          </button>
        </form>
        <p className="text-center text-xs text-gray-500">
          Don't have an account?{' '}
          <a
            href="https://affix-ai.com/register"
            target="_blank"
            rel="noreferrer"
            className="text-purple-600 hover:underline"
          >
            Sign up free
          </a>
        </p>
      </div>
    );
  }

  // ready | filling
  return (
    <div className="p-5 space-y-4">
      <Header />

      <button
        onClick={handleFill}
        disabled={state === 'filling'}
        className="w-full py-3 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-60 flex items-center justify-center gap-2"
      >
        {state === 'filling' ? (
          <>
            <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" />
            Filling…
          </>
        ) : (
          'Fill this page with my data'
        )}
      </button>

      {result && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          ✓ Filled <strong>{result.filled}</strong> of{' '}
          <strong>{result.total}</strong> field{result.total !== 1 ? 's' : ''}.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="border-t border-gray-100 pt-3 flex items-center justify-between text-xs text-gray-500">
        <a
          href="https://affix-ai.com/dashboard"
          target="_blank"
          rel="noreferrer"
          className="hover:text-purple-600 transition"
        >
          Open dashboard ↗
        </a>
        <button onClick={handleSignOut} className="hover:text-red-500 transition">
          Sign out
        </button>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-sm">
        <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
      </div>
      <div>
        <div className="font-bold text-gray-900 text-[15px] leading-none">AffixAI</div>
        <div className="text-[10px] text-gray-500 uppercase tracking-widest mt-0.5">Auto-fill</div>
      </div>
    </div>
  );
}
