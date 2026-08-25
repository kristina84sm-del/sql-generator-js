async function callOpenAIOnce({ apiKey, model, temperature, systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const ms = timeoutMs || 90000;
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model, temperature,
        max_tokens: maxTokens || 8000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error ${response.status}: ${err?.error?.message || response.statusText}`);
    }
    const data = await response.json();
    const raw = (data.choices?.[0]?.message?.content || "").trim();
    const usage = data.usage || {};
    try {
      const parsed = JSON.parse(raw);
      parsed.__usage = usage;
      return parsed;
    } catch {
      const e = new Error(`Модель вернула невалидный JSON: ${raw.slice(0, 300)}`);
      e.raw = raw;
      throw e;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Превышено время ожидания ответа от OpenAI.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOpenAIJson(opts) {
  try {
    return await callOpenAIOnce(opts);
  } catch (e) {
    if (!/невалидный JSON/i.test(e.message || "")) throw e;
    const maxTokens = Math.min(Number(opts.maxTokens || 8000), 3500);
    return callOpenAIOnce({
      ...opts,
      maxTokens,
      userPrompt: (opts.userPrompt || "") + "\n\nВерни ТОЛЬКО один валидный JSON-объект, без обрезки и без текста вокруг.",
    });
  }
}

module.exports = { callOpenAIJson };
