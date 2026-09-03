const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractColumnMeta,
  parseDdlTables,
  buildSchemaDiff,
  ensureAltersFromDiff,
  ensureFksFromDiff,
  cleanupMigrationSql,
} = require("../netlify/functions/_sql_migrate");

describe("extractColumnMeta DECIMAL", () => {
  it("keeps precision DECIMAL(10, 2)", () => {
    const meta = extractColumnMeta("daily_limit DECIMAL(10, 2) NOT NULL");
    assert.equal(meta.type, "DECIMAL(10, 2)");
    assert.equal(meta.notNull, true);
  });
});

describe("cleanupMigrationSql shame script", () => {
  const dirty = `
BEGIN;

CREATE TABLE "Transaction" (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE
);

CREATE TABLE "Notification" (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE
);

ALTER TABLE card ADD COLUMN account_id INT NOT NULL;
ALTER TABLE limit ADD COLUMN account_id INT NOT NULL;
ALTER TABLE limit ADD COLUMN daily_limit DECIMAL(10 NOT NULL;
ALTER TABLE "Card" ADD COLUMN account_id INT NOT NULL;
ALTER TABLE "Limit" ADD COLUMN account_id INT NOT NULL;
ALTER TABLE "Limit" ADD COLUMN daily_limit DECIMAL(10, 2) NOT NULL;

ALTER TABLE transaction ADD CONSTRAINT fk_transaction_account_id FOREIGN KEY (account_id) REFERENCES account(id);
ALTER TABLE notification ADD CONSTRAINT fk_notification_user_id FOREIGN KEY (user_id) REFERENCES user(id);
ALTER TABLE "Transaction" ADD CONSTRAINT FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE;

COMMIT;
`;

  it("fixes broken DECIMAL, drops duplicate alters/FKs, softens NOT NULL, names constraints", () => {
    const out = cleanupMigrationSql(dirty, {
      oldTableNames: ["card", "limit", "account", "user"],
    });
    assert.doesNotMatch(out, /DECIMAL\(10\s+NOT/i);
    assert.match(out, /DECIMAL\(10,\s*2\)/i);
    assert.doesNotMatch(out, /ADD\s+CONSTRAINT\s+FOREIGN\s+KEY/i);
    // FK новых таблиц не дублируются ALTER-ом
    assert.doesNotMatch(out, /ALTER\s+TABLE\s+"?Transaction"?\s+ADD\s+CONSTRAINT/i);
    assert.doesNotMatch(out, /ALTER\s+TABLE\s+"?Notification"?\s+ADD\s+CONSTRAINT/i);
    // дубли card/"Card" — одна колонка account_id
    const cardAdds = out.match(/ALTER\s+TABLE\s+["']?card["']?\s+ADD\s+COLUMN\s+account_id/gi) || [];
    const CardAdds = out.match(/ALTER\s+TABLE\s+"Card"\s+ADD\s+COLUMN\s+account_id/gi) || [];
    assert.ok(cardAdds.length + CardAdds.length === 1, "one account_id alter for card");
    // NOT NULL снят у существующих таблиц без DEFAULT
    const limitLine = out.split(/\n/).find(l => /ADD\s+COLUMN\s+daily_limit/i.test(l));
    assert.ok(limitLine);
    assert.doesNotMatch(limitLine, /NOT\s+NULL/i);
    // reserved limit quoted if unquoted form kept
    assert.doesNotMatch(out, /ALTER\s+TABLE\s+limit\s+/i);
  });
});

describe("ensureFks skips new tables and quoted REFERENCES", () => {
  it("does not inject ALTER FK when CREATE already has REFERENCES \"Parent\"", () => {
    const oldDdl = `CREATE TABLE "Account" (id INT PRIMARY KEY);`;
    const newDdl = `
CREATE TABLE "Account" (id INT PRIMARY KEY);
CREATE TABLE "Transaction" (
  id INT PRIMARY KEY,
  account_id INT REFERENCES "Account"(id)
);`;
    const diff = buildSchemaDiff(oldDdl, newDdl);
    const sql = `
CREATE TABLE "Transaction" (
  id INT PRIMARY KEY,
  account_id INT REFERENCES "Account"(id)
);`;
    const withFk = ensureFksFromDiff(sql, diff);
    assert.doesNotMatch(withFk, /ALTER\s+TABLE/i);
  });
});

describe("ensureAlters uses full DECIMAL type from diff", () => {
  it("parses DECIMAL(10, 2) into addedCols", () => {
    const oldDdl = `CREATE TABLE limits (id INT PRIMARY KEY);`;
    const newDdl = `CREATE TABLE limits (id INT PRIMARY KEY, daily_limit DECIMAL(10, 2) NOT NULL);`;
    const diff = buildSchemaDiff(oldDdl, newDdl);
    const col = diff.addedCols.find(c => c.col === "daily_limit");
    assert.ok(col);
    assert.equal(col.type, "DECIMAL(10, 2)");
    const sql = "BEGIN;\n-- ШАГ 1: cols\n\nCOMMIT;";
    const out = ensureAltersFromDiff(sql, diff);
    assert.match(out, /DECIMAL\(10,\s*2\)/);
    assert.doesNotMatch(out, /DECIMAL\(10\s+NOT/i);
  });
});
