export class MemoryApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', body = null } = {}) {
    super(message);
    this.name = 'MemoryApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export function createMemoryApi({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  let accessToken = '';
  const normalizedBaseUrl = String(baseUrl).replace(/\/$/, '');

  async function request(pathname, { authenticated = false } = {}) {
    const headers = {};
    if (authenticated && accessToken) headers.Authorization = `Bearer ${accessToken}`;

    let response;
    try {
      response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
        method: 'GET',
        headers,
        credentials: 'same-origin'
      });
    } catch (error) {
      throw new MemoryApiError(error.message || 'network_error', { code: 'network_error' });
    }

    const body = await readResponseBody(response);
    if (!response.ok) {
      const code = body?.error || `http_${response.status}`;
      throw new MemoryApiError(code, { status: response.status, code, body });
    }
    return body;
  }

  return Object.freeze({
    health: () => request('/health'),
    universe: () => request('/api/v1/universe', { authenticated: true }),
    setAccessToken(value) {
      accessToken = String(value || '').trim();
    },
    clearAccessToken() {
      accessToken = '';
    },
    hasAccessToken() {
      return accessToken.length > 0;
    }
  });
}
