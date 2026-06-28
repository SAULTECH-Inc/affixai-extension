/**
 * Extension popup — rendered when the user clicks the toolbar icon.
 *
 * Tabs:
 *   Fill  — auto-fill the current page from vault data
 *   Sign  — list documents awaiting the user's signature
 *
 * Auth states:
 *   loading → terms → login → (ready tabs)
 */
import { useEffect, useState } from 'react';

const API_BASE: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) ||
  'https://affixai-backend.vercel.app/api/v1';

const SIGN_BASE = 'https://affix-ai.com/sign';

type AuthState = 'loading' | 'terms' | 'login' | 'ready';
type ActiveTab = 'fill' | 'sign';

interface PendingDoc {
  document_id: string;
  document_title: string;
  invite_token: string;
  sender_name: string | null;
  sender_email: string | null;
  role: string;
  created_at: string;
}

export default function Popup() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [activeTab, setActiveTab] = useState<ActiveTab>('fill');

  // Fill tab state
  const [filling, setFilling] = useState(false);
  const [fillResult, setFillResult] = useState<{ filled: number; total: number } | null>(null);

  // Sign tab state
  const [docs, setDocs] = useState<PendingDoc[] | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);

  // Auth form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  // ---- Boot ------------------------------------------------------------------

  useEffect(() => {
    chrome.storage.local.get(['affixai_terms', 'affixai_token'], (res) => {
      if (!res.affixai_terms) setAuth('terms');
      else if (!res.affixai_token) setAuth('login');
      else setAuth('ready');
    });
  }, []);

  // Load pending docs whenever the Sign tab is opened
  useEffect(() => {
    if (auth === 'ready' && activeTab === 'sign' && docs === null) {
      loadPendingDocs();
    }
  }, [auth, activeTab]);

  // ---- Handlers --------------------------------------------------------------

  async function acceptTerms() {
    await chrome.storage.local.set({ affixai_terms: true });
    setAuth('login');
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
      setAuth('ready');
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleFill() {
    setFilling(true);
    setFillResult(null);
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
      setFillResult(response);
    } catch (err: any) {
      setError(err.message);
      if (err.message.includes('Session expired')) {
        await chrome.runtime.sendMessage({ type: 'CLEAR_TOKEN' });
        setAuth('login');
      }
    } finally {
      setFilling(false);
    }
  }

  async function loadPendingDocs() {
    setDocsLoading(true);
    setError('');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'FETCH_PENDING_DOCS' });
      if (result.error) throw new Error(result.error);
      setDocs(result);
    } catch (err: any) {
      setError(err.message);
      if (err.message.includes('Session expired')) {
        await chrome.runtime.sendMessage({ type: 'CLEAR_TOKEN' });
        setAuth('login');
      }
    } finally {
      setDocsLoading(false);
    }
  }

  async function openSignPage(token: string) {
    await chrome.tabs.create({ url: `${SIGN_BASE}/${token}` });
    window.close();
  }

  async function handleSignOut() {
    await chrome.runtime.sendMessage({ type: 'CLEAR_TOKEN' });
    setAuth('login');
    setDocs(null);
    setFillResult(null);
  }

  // ---- Pre-auth screens ------------------------------------------------------

  if (auth === 'loading') {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="h-6 w-6 rounded-full border-2 border-purple-300 border-t-purple-500 animate-spin" />
      </div>
    );
  }

  if (auth === 'terms') {
    return (
      <div className="p-5 space-y-4">
        <Header />
        <div className="text-sm text-gray-600 leading-relaxed">
          <p className="font-semibold text-gray-900 mb-2">Before you start:</p>
          <ul className="list-disc pl-4 space-y-1 text-[13px]">
            <li>AffixAI reads your encrypted vault to fill forms and list documents.</li>
            <li>Your data is never stored on-device or sent to third parties.</li>
            <li>You can review and clear all data from your AffixAI account.</li>
            <li>
              By using this extension you agree to our{' '}
              <a href="https://affix-ai.com/terms" target="_blank" rel="noreferrer"
                className="text-purple-600 hover:underline">Terms of Service</a>{' '}
              and{' '}
              <a href="https://affix-ai.com/privacy" target="_blank" rel="noreferrer"
                className="text-purple-600 hover:underline">Privacy Policy</a>.
            </li>
          </ul>
        </div>
        <button onClick={acceptTerms}
          className="w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-semibold hover:opacity-90 transition">
          Accept &amp; Continue
        </button>
      </div>
    );
  }

  if (auth === 'login') {
    return (
      <div className="p-5 space-y-4">
        <Header />
        <form onSubmit={handleLogin} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full h-9 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full h-9 px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40" />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button type="submit"
            className="w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-semibold hover:opacity-90 transition">
            Sign in to AffixAI
          </button>
        </form>
        <p className="text-center text-xs text-gray-500">
          Don't have an account?{' '}
          <a href="https://affix-ai.com/register" target="_blank" rel="noreferrer"
            className="text-purple-600 hover:underline">Sign up free</a>
        </p>
      </div>
    );
  }

  // ---- Authenticated (tabs) --------------------------------------------------

  return (
    <div className="flex flex-col" style={{ minHeight: 280 }}>
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100">
        <Header />
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-100">
        {(['fill', 'sign'] as ActiveTab[]).map((tab) => (
          <button key={tab} onClick={() => { setActiveTab(tab); setError(''); }}
            className={[
              'flex-1 py-2.5 text-xs font-semibold transition border-b-2',
              activeTab === tab
                ? 'border-purple-500 text-purple-600'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            ].join(' ')}>
            {tab === 'fill' ? '⚡ Auto-fill' : '✍️ Sign documents'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 p-4 space-y-3">
        {activeTab === 'fill' ? (
          <FillTab
            filling={filling}
            result={fillResult}
            error={error}
            onFill={handleFill}
          />
        ) : (
          <SignTab
            docs={docs}
            loading={docsLoading}
            error={error}
            onSign={openSignPage}
            onRefresh={loadPendingDocs}
          />
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 px-4 py-2.5 flex items-center justify-between text-[11px] text-gray-500">
        <a href="https://affix-ai.com/dashboard" target="_blank" rel="noreferrer"
          className="hover:text-purple-600 transition">Open dashboard ↗</a>
        <button onClick={handleSignOut} className="hover:text-red-500 transition">Sign out</button>
      </div>
    </div>
  );
}

// ---- Fill tab ---------------------------------------------------------------

function FillTab({
  filling,
  result,
  error,
  onFill,
}: {
  filling: boolean;
  result: { filled: number; total: number } | null;
  error: string;
  onFill: () => void;
}) {
  return (
    <>
      <p className="text-[12px] text-gray-500 leading-relaxed">
        Click below to fill every form field on this page using data from your
        AffixAI vault. You can review and edit any field before submitting.
      </p>

      <button onClick={onFill} disabled={filling}
        className="w-full py-3 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-60 flex items-center justify-center gap-2">
        {filling ? (
          <>
            <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" />
            Filling…
          </>
        ) : (
          'Fill this page with my data'
        )}
      </button>

      {result && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-800">
          ✓ Filled <strong>{result.filled}</strong> of{' '}
          <strong>{result.total}</strong> field{result.total !== 1 ? 's' : ''}.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}
    </>
  );
}

// ---- Sign tab ---------------------------------------------------------------

function SignTab({
  docs,
  loading,
  error,
  onSign,
  onRefresh,
}: {
  docs: PendingDoc[] | null;
  loading: boolean;
  error: string;
  onSign: (token: string) => void;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-5 w-5 rounded-full border-2 border-purple-300 border-t-purple-500 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {error}
        </div>
        <button onClick={onRefresh}
          className="w-full py-2 rounded-xl border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50 transition">
          Retry
        </button>
      </div>
    );
  }

  if (!docs || docs.length === 0) {
    return (
      <div className="text-center py-8 space-y-2">
        <div className="text-3xl">🎉</div>
        <p className="text-sm font-medium text-gray-700">All caught up!</p>
        <p className="text-[12px] text-gray-500">No documents are waiting for your signature.</p>
        <button onClick={onRefresh}
          className="mt-2 text-[11px] text-purple-600 hover:underline">
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          {docs.length} pending
        </span>
        <button onClick={onRefresh}
          className="text-[11px] text-purple-600 hover:underline">
          Refresh
        </button>
      </div>

      <div className="space-y-2 max-h-48 overflow-y-auto pr-0.5">
        {docs.map((doc) => (
          <div key={doc.document_id}
            className="rounded-xl border border-gray-200 bg-white p-3 space-y-2">
            <div>
              <div className="text-[13px] font-semibold text-gray-900 leading-tight truncate">
                {doc.document_title}
              </div>
              {doc.sender_name && (
                <div className="text-[11px] text-gray-500 mt-0.5">
                  from {doc.sender_name}
                </div>
              )}
              <div className="text-[10px] text-gray-400 mt-0.5 capitalize">
                {doc.role.replace('_', ' ')} ·{' '}
                {new Date(doc.created_at).toLocaleDateString()}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => onSign(doc.invite_token)}
                className="flex-1 py-1.5 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 text-white text-[12px] font-semibold hover:opacity-90 transition">
                Sign now ↗
              </button>
              <button
                onClick={() => onSign(doc.invite_token)}
                title="Open in AffixAI"
                className="px-3 py-1.5 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition">
                View
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Shared header ----------------------------------------------------------

function Header() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-sm shrink-0">
        <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth={2.5}>
          <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
      </div>
      <div>
        <div className="font-bold text-gray-900 text-[15px] leading-none">AffixAI</div>
        <div className="text-[10px] text-gray-500 uppercase tracking-widest mt-0.5">
          Form filler &amp; signer
        </div>
      </div>
    </div>
  );
}
