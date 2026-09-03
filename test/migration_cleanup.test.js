const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractColumnMeta,
  parseDdlTables,
  buildSchemaDiff,
  ensureAltersFromDiff,
  ensureFksFromDiff,
  cleanupMigrationSql,
  extractTableNames,
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
    const accountIdAlters = out.match(/ALTER\s+TABLE\s+(?:"Card"|card)\s+ADD\s+COLUMN\s+account_id/gi) || [];
    assert.equal(accountIdAlters.length, 1, "one account_id alter for card");
    // NOT NULL снят у существующих таблиц без DEFAULT
    const limitLine = out.split(/\n/).find(l => /ADD\s+COLUMN\s+daily_limit/i.test(l));
    assert.ok(limitLine);
    assert.doesNotMatch(limitLine, /NOT\s+NULL/i);
    // reserved limit quoted if unquoted form kept
    assert.doesNotMatch(out, /ALTER\s+TABLE\s+limit\s+/i);
  });
});

describe("cleanupMigrationSql production-safe review script", () => {
  const almostGood = `
BEGIN;

-- ШАГ 0: Новые таблицы
CREATE TABLE "Transaction" (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE
);

CREATE TABLE "Notification" (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE
);

-- ШАГ 1: Добавление новых колонок в СУЩЕСТВУЮЩИЕ таблицы
ALTER TABLE "Card" ADD COLUMN account_id INT NOT NULL;

ALTER TABLE "Limit" ADD COLUMN account_id INT NOT NULL;

ALTER TABLE "Limit" ADD COLUMN daily_limit DECIMAL(10, 2) NOT NULL;

-- ШАГ 2: Перенос данных
-- Данные для новых колонок account_id не могут быть перенесены

-- ШАГ 5: Constraints на существующих таблицах

-- ШАГ 6: Удаление таблиц

COMMIT;
`;

  it("strips bare NOT NULL even with step comments, injects FKs before COMMIT", () => {
    const oldDdl = `
CREATE TABLE "User" (id SERIAL PRIMARY KEY);
CREATE TABLE "Account" (id SERIAL PRIMARY KEY);
CREATE TABLE "Card" (id SERIAL PRIMARY KEY);
CREATE TABLE "Limit" (id SERIAL PRIMARY KEY, monthly_limit DECIMAL(10, 2));
`;
    const newDdl = `
CREATE TABLE "User" (id SERIAL PRIMARY KEY);
CREATE TABLE "Account" (id SERIAL PRIMARY KEY);
CREATE TABLE "Card" (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES "Account"(id) ON DELETE CASCADE
);
CREATE TABLE "Limit" (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES "Account"(id) ON DELETE CASCADE,
  monthly_limit DECIMAL(10, 2),
  daily_limit DECIMAL(10, 2) NOT NULL
);
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
`;
    const diff = buildSchemaDiff(oldDdl, newDdl);
    const out = cleanupMigrationSql(almostGood, {
      oldTableNames: [...extractTableNames(oldDdl)],
      schemaDiff: diff,
    });

    const cardLine = out.split(/\n/).find(l => /ADD\s+COLUMN\s+account_id/i.test(l) && /"Card"/i.test(l));
    assert.ok(cardLine, "Card account_id alter kept");
    assert.doesNotMatch(cardLine, /NOT\s+NULL/i);

    const dailyLine = out.split(/\n/).find(l => /ADD\s+COLUMN\s+daily_limit/i.test(l));
    assert.ok(dailyLine);
    assert.doesNotMatch(dailyLine, /NOT\s+NULL/i);

    assert.match(out, /ALTER\s+TABLE\s+"Card"\s+ADD\s+CONSTRAINT\s+fk_card_account_id\s+FOREIGN\s+KEY\s*\(\s*account_id\s*\)\s*REFERENCES\s+"Account"\s*\(\s*id\s*\)/i);
    assert.match(out, /ALTER\s+TABLE\s+"Limit"\s+ADD\s+CONSTRAINT\s+fk_limit_account_id\s+FOREIGN\s+KEY\s*\(\s*account_id\s*\)\s*REFERENCES\s+"Account"\s*\(\s*id\s*\)/i);
    assert.doesNotMatch(out, /ALTER\s+TABLE\s+"Transaction"\s+ADD\s+CONSTRAINT/i);

    const commitIdx = out.search(/\bCOMMIT\s*;/i);
    const fkIdx = out.search(/fk_card_account_id/i);
    assert.ok(fkIdx >= 0 && commitIdx > fkIdx, "FK before COMMIT");
    assert.match(out, /CREATE\s+INDEX\s+idx_card_account_id\s+ON\s+"Card"\s*\(\s*account_id\s*\)/i);
    assert.match(out, /CREATE\s+INDEX\s+idx_transaction_account_id\s+ON\s+"Transaction"\s*\(\s*account_id\s*\)/i);
    assert.match(out, /CREATE\s+INDEX\s+idx_notification_user_id\s+ON\s+"Notification"\s*\(\s*user_id\s*\)/i);
  });
});

describe("cleanupMigrationSql FK indexes", () => {
  it("adds index for CREATE TABLE FK and skips when index already covers column", () => {
    const sql = `
BEGIN;
CREATE TABLE "Transaction" (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE
);
CREATE INDEX already_there ON "Transaction"(account_id);
COMMIT;
`;
    const out = cleanupMigrationSql(sql, {});
    const idxs = out.match(/CREATE\s+INDEX\s+\w+\s+ON\s+"Transaction"\s*\(\s*account_id\s*\)/gi) || [];
    assert.equal(idxs.length, 1, "no duplicate index on account_id");
    assert.match(out, /already_there/i);
  });

  it("adds index for ALTER FK on existing table", () => {
    const sql = `
BEGIN;
ALTER TABLE "Card" ADD COLUMN account_id INT;
ALTER TABLE "Card" ADD CONSTRAINT fk_card_account_id FOREIGN KEY (account_id) REFERENCES "Account"(id);
COMMIT;
`;
    const out = cleanupMigrationSql(sql, {});
    assert.match(out, /CREATE\s+INDEX\s+idx_card_account_id\s+ON\s+"Card"\s*\(\s*account_id\s*\)/i);
    const commitIdx = out.search(/\bCOMMIT\s*;/i);
    const idxIdx = out.search(/idx_card_account_id/i);
    assert.ok(idxIdx >= 0 && commitIdx > idxIdx);
  });

  it("does not invent composite FK indexes", () => {
    const sql = `
BEGIN;
ALTER TABLE orders ADD CONSTRAINT fk_orders_pair FOREIGN KEY (a_id, b_id) REFERENCES other(a_id, b_id);
COMMIT;
`;
    const out = cleanupMigrationSql(sql, {});
    assert.doesNotMatch(out, /CREATE\s+INDEX/i);
  });
});

describe("infer FK when NEW DDL has account_id without REFERENCES", () => {
  const userSql = `
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
ALTER TABLE "Card" ADD COLUMN account_id INT;
ALTER TABLE "Limit" ADD COLUMN account_id INT;
ALTER TABLE "Limit" ADD COLUMN daily_limit DECIMAL(10, 2);
-- ШАГ 5: Constraints на существующих таблицах
COMMIT;
`;

  it("buildSchemaDiff infers FK from *_id + known parent table", () => {
    const oldDdl = `
CREATE TABLE "User" (id SERIAL PRIMARY KEY);
CREATE TABLE "Account" (id SERIAL PRIMARY KEY);
CREATE TABLE "Card" (id SERIAL PRIMARY KEY);
CREATE TABLE "Limit" (id SERIAL PRIMARY KEY);
`;
    const newDdl = `
CREATE TABLE "User" (id SERIAL PRIMARY KEY);
CREATE TABLE "Account" (id SERIAL PRIMARY KEY);
CREATE TABLE "Card" (id SERIAL PRIMARY KEY, account_id INT NOT NULL);
CREATE TABLE "Limit" (id SERIAL PRIMARY KEY, account_id INT NOT NULL, daily_limit DECIMAL(10,2) NOT NULL);
CREATE TABLE "Transaction" (id SERIAL PRIMARY KEY, account_id INT NOT NULL, FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE);
CREATE TABLE "Notification" (id SERIAL PRIMARY KEY, user_id INT NOT NULL, FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE);
`;
    const diff = buildSchemaDiff(oldDdl, newDdl);
    const cardFk = diff.addedFks.find(f => f.child === "card" && f.col === "account_id");
    const limitFk = diff.addedFks.find(f => f.child === "limit" && f.col === "account_id");
    assert.ok(cardFk, "inferred card.account_id FK");
    assert.ok(limitFk, "inferred limit.account_id FK");
    assert.equal(cardFk.parent, "account");
  });

  it("cleanup injects FK+indexes for Card/Limit even when NEW has no REFERENCES", () => {
    const oldDdl = `
CREATE TABLE "User" (id SERIAL PRIMARY KEY);
CREATE TABLE "Account" (id SERIAL PRIMARY KEY);
CREATE TABLE "Card" (id SERIAL PRIMARY KEY);
CREATE TABLE "Limit" (id SERIAL PRIMARY KEY);
`;
    const newDdl = `
CREATE TABLE "User" (id SERIAL PRIMARY KEY);
CREATE TABLE "Account" (id SERIAL PRIMARY KEY);
CREATE TABLE "Card" (id SERIAL PRIMARY KEY, account_id INT NOT NULL);
CREATE TABLE "Limit" (id SERIAL PRIMARY KEY, account_id INT NOT NULL, daily_limit DECIMAL(10,2));
CREATE TABLE "Transaction" (id SERIAL PRIMARY KEY, account_id INT, FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE);
CREATE TABLE "Notification" (id SERIAL PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE);
`;
    const diff = buildSchemaDiff(oldDdl, newDdl);
    const out = cleanupMigrationSql(userSql, {
      oldTableNames: [...extractTableNames(oldDdl)],
      schemaDiff: diff,
    });
    assert.match(out, /ALTER\s+TABLE\s+"Card"\s+ADD\s+CONSTRAINT\s+fk_card_account_id\s+FOREIGN\s+KEY/i);
    assert.match(out, /ALTER\s+TABLE\s+"Limit"\s+ADD\s+CONSTRAINT\s+fk_limit_account_id\s+FOREIGN\s+KEY/i);
    assert.match(out, /CREATE\s+INDEX\s+idx_card_account_id\s+ON\s+"Card"\s*\(\s*account_id\s*\)/i);
    assert.match(out, /CREATE\s+INDEX\s+idx_limit_account_id\s+ON\s+"Limit"\s*\(\s*account_id\s*\)/i);
    assert.doesNotMatch(out, /ALTER\s+TABLE\s+"Transaction"\s+ADD\s+CONSTRAINT/i);
    // оба FK до индексов и до COMMIT
    const cardFk = out.search(/fk_card_account_id/i);
    const limitFk = out.search(/fk_limit_account_id/i);
    const idxCard = out.search(/CREATE\s+INDEX\s+idx_card_account_id/i);
    const commitIdx = out.search(/\bCOMMIT\s*;/i);
    assert.ok(cardFk < idxCard && limitFk < idxCard && idxCard < commitIdx);
  });
});

describe("cleanup drops bogus INSERT and moves FK to step 5", () => {
  const dirty = `
BEGIN;
CREATE TABLE "Transaction" (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE
);
CREATE TABLE "Notification" (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE
);
ALTER TABLE "Card" ADD COLUMN account_id INT;
ALTER TABLE "Limit" ADD COLUMN account_id INT;
ALTER TABLE "Limit" ADD COLUMN daily_limit DECIMAL(10, 2);

-- ШАГ 2: Перенос
INSERT INTO "Transaction" (account_id, type, amount, created_at)
SELECT account_id, type, amount, created_at FROM "Account";

INSERT INTO "Notification" (user_id, message, is_read, created_at)
SELECT user_id, message, is_read, created_at FROM "User";

ALTER TABLE "Card" ADD CONSTRAINT fk_card_account_id FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE;
ALTER TABLE "Limit" ADD CONSTRAINT fk_limit_account_id FOREIGN KEY (account_id) REFERENCES "Account"(id) ON DELETE CASCADE;
CREATE INDEX idx_transaction_account_id ON "Transaction"(account_id);
CREATE INDEX idx_notification_user_id ON "Notification"(user_id);
CREATE INDEX idx_card_account_id ON "Card"(account_id);
CREATE INDEX idx_limit_account_id ON "Limit"(account_id);

-- ШАГ 5: Constraints на существующих таблицах
COMMIT;
`;

  const oldDdl = `
CREATE TABLE "User" (id SERIAL PRIMARY KEY, email VARCHAR(255));
CREATE TABLE "Account" (id SERIAL PRIMARY KEY, balance DECIMAL(10,2));
CREATE TABLE "Card" (id SERIAL PRIMARY KEY);
CREATE TABLE "Limit" (id SERIAL PRIMARY KEY);
`;

  it("removes INSERT…SELECT with columns missing on source tables", () => {
    const out = cleanupMigrationSql(dirty, { oldSchema: oldDdl, oldTableNames: ["user", "account", "card", "limit"] });
    assert.doesNotMatch(out, /INSERT\s+INTO\s+"Transaction"/i);
    assert.doesNotMatch(out, /INSERT\s+INTO\s+"Notification"/i);
    assert.match(out, /пропущено:\s*INSERT\s+FROM\s+"Account"/i);
    assert.match(out, /пропущено:\s*INSERT\s+FROM\s+"User"/i);
  });

  it("moves FK and indexes to step 5 after step 2 area", () => {
    const out = cleanupMigrationSql(dirty, {
      oldSchema: oldDdl,
      oldTableNames: ["user", "account", "card", "limit"],
      schemaDiff: buildSchemaDiff(oldDdl, oldDdl + `
CREATE TABLE "Transaction" (id INT, account_id INT);
CREATE TABLE "Notification" (id INT, user_id INT);
CREATE TABLE "Card" (id INT, account_id INT);
CREATE TABLE "Limit" (id INT, account_id INT, daily_limit DECIMAL(10,2));
`),
    });
    const step2 = out.search(/ШАГ\s*2/i);
    const cardFk = out.search(/fk_card_account_id/i);
    const step5 = out.search(/ШАГ\s*5/i);
    const commitIdx = out.search(/\bCOMMIT\s*;/i);
    assert.ok(cardFk > step2, "FK after step 2 marker");
    assert.ok(step5 < 0 || cardFk > step5 || cardFk > step2, "FK near step 5");
    assert.ok(cardFk < commitIdx && cardFk >= 0);
    // после вырезания INSERT не должно быть FK сразу после ADD COLUMN без шага 5
    const addColEnd = out.search(/ADD\s+COLUMN\s+daily_limit/i);
    const between = out.slice(addColEnd, cardFk);
    assert.doesNotMatch(between, /INSERT\s+INTO/i);
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
