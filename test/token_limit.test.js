const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultDailyTokenLimit,
  resolveDailyTokenLimit,
} = require("../netlify/functions/_rate_limit_check");

describe("daily token limit", () => {
  it("defaults to 100000", () => {
    const prev = process.env.DAILY_TOKEN_LIMIT;
    delete process.env.DAILY_TOKEN_LIMIT;
    assert.equal(defaultDailyTokenLimit(), 100000);
    if (prev !== undefined) process.env.DAILY_TOKEN_LIMIT = prev;
  });

  it("NULL user limit uses default", () => {
    assert.equal(resolveDailyTokenLimit(null), defaultDailyTokenLimit());
    assert.equal(resolveDailyTokenLimit(undefined), defaultDailyTokenLimit());
  });

  it("0 means unlimited", () => {
    assert.equal(resolveDailyTokenLimit(0), 0);
  });

  it("positive override wins", () => {
    assert.equal(resolveDailyTokenLimit(50000), 50000);
  });
});
