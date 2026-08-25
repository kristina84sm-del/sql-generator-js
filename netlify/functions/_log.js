function isTransientDbError(err) {
  const code = String(err && (err.code || err.errno) || "");
  const msg = String(err && err.message || "");
  return /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|timeout|Connection terminated|Connection ended unexpectedly/i.test(code + " " + msg);
}

function publicDbError(err) {
  if (isTransientDbError(err)) {
    return {
      statusCode: 503,
      error: "База данных сейчас недоступна (таймаут сети или firewall). Подождите минуту и войдите снова. Если ошибка повторяется — разрешите входящие подключения к Postgres с IP сервера приложения (у serverless исходящие адреса часто динамические).",
    };
  }
  return { statusCode: 500, error: "Внутренняя ошибка сервера" };
}

function trackError(scope, err, extra) {
  const payload = {
    ts: new Date().toISOString(),
    scope,
    code: err && err.code,
    message: err && err.message,
    extra: extra || undefined,
  };
  console.error(JSON.stringify({ level: "error", ...payload }));
  const hook = (process.env.ERROR_WEBHOOK_URL || "").trim();
  if (!hook) return;
  fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

module.exports = { isTransientDbError, publicDbError, trackError };
