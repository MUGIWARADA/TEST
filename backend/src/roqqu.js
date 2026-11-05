import { DEMO_ROQQU_BALANCES, DEMO_ROQQU_HISTORY } from './fixtures.js';

const BASE_URL = 'https://api.roqqu.com/prod/v1';
export const ROQQU_WALLET_TOKENS = Object.freeze(['btc', 'eth', 'trx']);

function upstreamError(response) {
  if (response.status === 401 || response.status === 403) {
    const error = new Error('Roqqu rejected this API key. Check the key and its account.');
    error.code = 'ROQQU_AUTH_FAILED'; error.statusCode = 401; return error;
  }
  if (response.status === 429) {
    const error = new Error('Roqqu rate limit reached. Wait before requesting this data again.');
    error.code = 'ROQQU_RATE_LIMITED'; error.statusCode = 429; return error;
  }
  const error = new Error('Roqqu returned an unsuccessful response.');
  error.code = 'ROQQU_UPSTREAM_ERROR'; error.statusCode = 502; return error;
}

async function readJsonLimited(response, maxBytes = 5 * 1024 * 1024) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error('Roqqu response exceeds the wallet-list safety limit.');
    error.code = 'ROQQU_RESPONSE_TOO_LARGE'; throw error;
  }
  if (!response.body?.getReader) {
    const data = await response.json();
    if (Buffer.byteLength(JSON.stringify(data)) > maxBytes) {
      const error = new Error('Roqqu response exceeds the wallet-list safety limit.');
      error.code = 'ROQQU_RESPONSE_TOO_LARGE'; throw error;
    }
    return data;
  }
  const reader = response.body.getReader();
  const chunks = []; let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      const error = new Error('Roqqu response exceeds the wallet-list safety limit.');
      error.code = 'ROQQU_RESPONSE_TOO_LARGE'; throw error;
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readResponse(response) {
  if (!response.ok) throw upstreamError(response);
  let data;
  try { data = await readJsonLimited(response); } catch (cause) {
    const error = new Error(cause?.code === 'ROQQU_RESPONSE_TOO_LARGE' ? 'Roqqu returned more wallet data than this integration safely accepts.' : 'Roqqu returned an invalid response.');
    error.code = cause?.code || 'ROQQU_INVALID_RESPONSE'; error.statusCode = 502; throw error;
  }
  if (data?.status !== 'success' || data.data === undefined || data.data === null) {
    const error = new Error(data?.message === 'unsupported token supplied' ? 'Roqqu does not support that wallet token.' : 'Roqqu did not confirm the read request.');
    error.code = 'ROQQU_UPSTREAM_ERROR'; error.statusCode = 502; throw error;
  }
  return data.data;
}

export class RoqquClient {
  constructor({ apiKey, fetchImpl = fetch }) {
    if (typeof apiKey !== 'string' || !apiKey) {
      const error = new Error('A Roqqu API key is required for live reads.');
      error.code = 'ROQQU_NOT_CONNECTED'; error.statusCode = 409; throw error;
    }
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async getWallets(token) {
    const normalizedToken = typeof token === 'string' ? token.toLowerCase() : '';
    if (!ROQQU_WALLET_TOKENS.includes(normalizedToken)) {
      const error = new Error('Only BTC, ETH, and TRX wallet reads are supported by this connection.');
      error.code = 'ROQQU_UNSUPPORTED_TOKEN'; error.statusCode = 400; throw error;
    }
    const response = await this.fetchImpl(`${BASE_URL}/user/wallets`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: normalizedToken })
    });
    const data = await readResponse(response);
    if (!Array.isArray(data)) {
      const error = new Error('Roqqu returned an unexpected wallet-list response.');
      error.code = 'ROQQU_INVALID_RESPONSE'; error.statusCode = 502; throw error;
    }
    return data.map((wallet) => ({
      address: typeof wallet.address === 'string' ? wallet.address : '',
      token: typeof wallet.type === 'string' ? wallet.type.toLowerCase() : normalizedToken,
      total_received: finiteAmount(wallet.total_received),
      total_received_usdt: finiteAmount(wallet.total_received_usdt),
      genesis: wallet.genesis === 1 || wallet.genesis === true,
      created_at: typeof wallet.created_at === 'string' ? wallet.created_at : null
    })).filter((wallet) => wallet.address);
  }

  async getAddressDetails(token, address) {
    const normalizedToken = typeof token === 'string' ? token.toLowerCase() : '';
    if (!ROQQU_WALLET_TOKENS.includes(normalizedToken) || typeof address !== 'string' || address.length < 3 || address.length > 256) {
      const error = new Error('A supported wallet token and valid address are required.');
      error.code = 'INVALID_ROQQU_ADDRESS'; error.statusCode = 400; throw error;
    }
    const url = new URL(`${BASE_URL}/blockchain/address`);
    url.searchParams.set('symbol', normalizedToken);
    url.searchParams.set('addr', address);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' }
    });
    return readResponse(response);
  }
}

function finiteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function roqquMockData() {
  return { balances: structuredClone(DEMO_ROQQU_BALANCES), history: structuredClone(DEMO_ROQQU_HISTORY) };
}
