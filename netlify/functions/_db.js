const { Client } = require("pg");
const { isTransientDbError } = require("./_log");

const CONNECT_MS = Number(process.env.DB_CONNECT_TIMEOUT_MS || 8000);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dbConfig() {
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECT_MS,
  };
}

async function connectOnce() {
  const client = new Client(dbConfig());
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    client.end().catch(() => {});
  }, CONNECT_MS);
  try {
    await client.connect();
    if (timedOut) {
      const e = new Error("ETIMEDOUT");
      e.code = "ETIMEDOUT";
      throw e;
    }
    return client;
  } catch (e) {
    client.end().catch(() => {});
    if (timedOut && !e.code) e.code = "ETIMEDOUT";
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getClient() {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      return await connectOnce();
    } catch (e) {
      last = e;
      if (!isTransientDbError(e) || i === 1) throw e;
      await sleep(400);
    }
  }
  throw last;
}

module.exports = { getClient, dbConfig, isTransientDbError };
