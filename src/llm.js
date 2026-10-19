function createLlmClient(config) {
  const enabled = Boolean((config?.apiKey || config?.allowNoKey) && config?.baseUrl && config?.model);

  function endpoint() {
    if (/\/chat\/completions$/i.test(config.baseUrl)) return config.baseUrl;
    return `${config.baseUrl}/chat/completions`;
  }

  async function complete(messages, options = {}) {
    if (!enabled) {
      const error = new Error('LLM is not configured');
      error.code = 'LLM_DISABLED';
      throw error;
    }
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 2048,
        ...(options.responseFormat ? { response_format: options.responseFormat } : {})
      }),
      signal: options.signal || AbortSignal.timeout(60000)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status})`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`LLM returned non-JSON response`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('LLM response did not contain choices[0].message.content');
    }
    return content;
  }

  async function completeJson(messages, options = {}) {
    const content = await complete(messages, {
      ...options,
      responseFormat: { type: 'json_object' }
    });
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (error) {
      throw new Error(`LLM JSON parse failed`);
    }
  }

  return { enabled, complete, completeJson };
}

module.exports = { createLlmClient };
