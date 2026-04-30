// Netlify serverless функция: архитектурный аудит ER-диаграммы
// v2: JWT-авторизация, промпты только на сервере, ограничение длины

const { checkAuth, logRequest } = require("./_auth_middleware");

const ALLOWED_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]);
const DEFAULT_MODEL  = "gpt-4o-mini";

const LIMITS = {
  mermaid_er: 6000,
  sql:        4000,
};

// Системный промпт — только на сервере
const ANALYZE_SYSTEM_PROMPT = `
Ты архитектор баз данных. У тебя есть ER-диаграмма в Mermaid (тип 'erDiagram').

Верни ТОЛЬКО JSON:
{
  "audit": "Текст аудита на русском (можно markdown). Включи: проверки 1NF/2NF/3NF, наличие циклов зависимостей по FK, рекомендации по индексам."
}

Требования:
- Восстанови ключи (PK/FK) по Mermaid, если они есть.
- Проверь нормальные формы 1NF/2NF/3NF.
- Проверь циклические зависимости по направлениям FK.
- Дай рекомендации по индексам под типовые операции JOIN/WHERE.
`.trim();

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function safeFloat(v, d) { const f = parseFloat(v); return isNaN(f) ? d : f; }
function clamp(v, min = 0, max = 2) { return Math.max(min, Math.min(max, v)); }
function validateModel(m) { const s = (m || "").trim(); return ALLOWED_MODELS.has(s) ? s : DEFAULT_MODEL; }
function truncate(str, limit) {
  if (!str) return "";
  const s = String(str);
  return s.length > limit ? s.slice(0, limit) + "\n[...обрезано]" : s;
}

async function callOpenAI({ apiKey, model, temperature, systemPrompt, userPrompt }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error ${response.status}: ${err?.error?.message || response.statusText}`);
  }
  const data = await response.json();
  const raw = (data.choices?.[0]?.message?.content || "").trim();
  try { return JSON.parse(raw); }
  catch { throw new Error(`Модель вернула невалидный JSON: ${raw.slice(0, 300)}`); }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const auth = checkAuth(event);
  if (!auth.ok) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: auth.error }) };

  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "OPENAI_API_KEY не задан" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Невалидный JSON" }) }; }

  const mermaidEr = truncate((body.mermaid_er || "").trim(), LIMITS.mermaid_er);
  if (!mermaidEr)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Не передан Mermaid-код (mermaid_er)." }) };

  const dialect     = (body.dialect || "PostgreSQL").trim();
  const sqlText     = truncate((body.sql || "").trim(), LIMITS.sql);
  const model       = validateModel(body.model);
  const temperature = clamp(safeFloat(body.temperature, 0.2));

  const userMessage = `DIALECT: ${dialect}

ERD (Mermaid 'erDiagram'):
${mermaidEr}

OPTIONAL_SQL:
${sqlText || "(не передан)"}`;

  try {
    const parsed = await callOpenAI({ apiKey, model, temperature, systemPrompt: ANALYZE_SYSTEM_PROMPT, userPrompt: userMessage });
    const audit = (parsed.audit || "").trim();
    if (!audit)
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "В ответе нет поля audit." }) };

    await logRequest(auth.user.sub, "analyze_architecture");
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ audit }) };
  } catch (e) {
    console.error("analyze error:", e);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `Ошибка аудита: ${e.message}` }) };
  }
};
