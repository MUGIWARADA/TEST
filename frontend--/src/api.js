import { authClient, getNeonAccessToken } from './auth';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const TOKEN_KEY = 'miroir_token';
const getDemoToken = () => localStorage.getItem(TOKEN_KEY);

async function apiRequest(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});
  const demoToken = getDemoToken();
  const token = demoToken || await getNeonAccessToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
    // Preview proxies may strip Authorization; keep this compatibility header for demo tokens only.
    if (demoToken) headers.set('X-Miroir-Session', demoToken);
  }
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let response;
  try {
    response = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers });
  } catch {
    throw new Error('Could not reach the Miroir API. Check that the backend is running.');
  }

  let data = null;
  try { data = await response.json(); } catch { /* Empty response is valid for some endpoints. */ }
  if (!response.ok) {
    if (response.status === 401 && demoToken) clearSession();
    const error = new Error(data?.error?.message || data?.message || `Request failed (${response.status}).`);
    error.code = data?.error?.code || 'API_ERROR';
    error.status = response.status;
    throw error;
  }
  return data;
}

function storeDemoSession(data) {
  localStorage.setItem(TOKEN_KEY, data.token);
  if (data.demo_data?.strategy_version_id) localStorage.setItem('demo_strategy_version_id', data.demo_data.strategy_version_id);
  if (data.identity) localStorage.setItem('miroir_identity', JSON.stringify(data.identity));
  return data;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('demo_strategy_version_id');
  localStorage.removeItem('miroir_identity');
}

export const api = {
  createDemoSession: async () => storeDemoSession(await apiRequest('/v1/demo/session', {
    method: 'POST',
    body: JSON.stringify({ display_name: 'Demo Trader' })
  })),
  logout: async () => {
    const hadDemoToken = Boolean(getDemoToken());
    try {
      if (hadDemoToken) await apiRequest('/v1/auth/logout', { method: 'POST' });
      if (authClient) await authClient.signOut();
    } finally { clearSession(); }
  },
  getIdentity: () => apiRequest('/v1/me'),
  getStrategies: () => apiRequest('/v1/strategies'),
  getTrades: () => apiRequest('/v1/trades'),
  createTrade: (payload) => apiRequest('/v1/trades', { method: 'POST', body: JSON.stringify(payload) }),
  requestReview: (tradeId) => apiRequest(`/v1/trades/${encodeURIComponent(tradeId)}/review`, { method: 'POST' }),
  getStats: (currency = 'USD') => apiRequest(`/v1/stats?currency=${encodeURIComponent(currency)}`),
  getProgress: () => apiRequest('/v1/progress'),
  getRoqquStatus: () => apiRequest('/v1/roqqu/status'),
  connectRoqqu: (apiKey) => apiRequest('/v1/roqqu/connect', { method: 'POST', body: JSON.stringify({ api_key: apiKey }) }),
  disconnectRoqqu: () => apiRequest('/v1/roqqu/disconnect', { method: 'POST' }),
  getRoqquBalances: () => apiRequest('/v1/roqqu/balances'),
  getRoqquHistory: ({ symbol, address } = {}) => {
    const query = new URLSearchParams();
    if (symbol) query.set('symbol', symbol);
    if (address) query.set('address', address);
    return apiRequest(`/v1/roqqu/history${query.size ? `?${query}` : ''}`);
  },
  clearSession
};
