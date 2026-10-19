function createEmbeddingClient(config = {}, overrides = {}) {
  const enabled = overrides.enabled ?? Boolean(config.baseUrl && config.model);

  function endpoint() {
    if (/\/embeddings$/i.test(config.baseUrl || '')) return config.baseUrl;
    return `${config.baseUrl}/embeddings`;
  }

  async function embed(texts, options = {}) {
    const input = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text || '').trim());
    if (!enabled) throw new Error('Embedding provider is not configured');
    if (!input.length || input.some((text) => !text)) throw new Error('Embedding input must contain non-empty text');
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const body = { model: config.model, input };
    const dimensions = Number(options.dimensions || config.dimensions || 0);
    if (dimensions > 0) body.dimensions = dimensions;
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal || AbortSignal.timeout(config.timeoutMs || 15000)
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Embedding request failed (${response.status})`);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error(`Embedding provider returned non-JSON`); }
    const vectors = [...(payload.data || [])]
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map((item) => item.embedding);
    if (vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector) || !vector.length)) {
      throw new Error('Embedding response did not contain one non-empty vector per input');
    }
    const width = vectors[0].length;
    if (vectors.some((vector) => vector.length !== width || vector.some((value) => !Number.isFinite(value)))) {
      throw new Error('Embedding response contains inconsistent or invalid vectors');
    }
    return vectors;
  }

  return {
    enabled,
    model: config.model || '',
    embed: overrides.embed || embed,
    status: () => ({ enabled, model: config.model || '', baseUrlConfigured: Boolean(config.baseUrl) })
  };
}

module.exports = { createEmbeddingClient };
