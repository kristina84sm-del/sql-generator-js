const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeTargetDialectSql,
  parseDdlTables,
  buildSchemaDiff,
  ensureFksFromDiff,
  lintMigrationSql,
  ddlTransactionalNote,
  buildConstraintFacts,
  lintIntegritySql,
  quoteReservedTableIdents,
} = require("../netlify/functions/_sql_migrate");

describe("sanitizeTargetDialectSql", () => {
  it("does not rewrite types inside comments for mysql", () => {
    const sql = `-- Типы данных: BOOLEAN → BOOLEAN, VARCHAR → VARCHAR
CREATE TABLE t (flag BOOLEAN, name VARCHAR, id SERIAL PRIMARY KEY);`;
    const out = sanitizeTargetDialectSql(sql, "mysql");
    assert.match(out, /TINYINT\(1\)/);
    assert.match(out, /VARCHAR\(\d+\)/);
    assert.match(out, /AUTO_INCREMENT/);
    assert.doesNotMatch(out, /TINYINT\(1\)\s*→\s*TINYINT\(1\)/);
    assert.match(out, /применены на бэкенде/);
  });

  it("maps mssql and oracle without touching comment banners", () => {
    const sql = `-- note BOOLEAN stays in this comment
CREATE TABLE t (flag BOOLEAN);`;
    const mssql = sanitizeTargetDialectSql(sql, "mssql");
    assert.match(mssql, /flag BIT/);
    assert.match(mssql, /note BOOLEAN stays/);
    const oracle = sanitizeTargetDialectSql(sql, "oracle");
    assert.match(oracle, /flag NUMBER\(1\)/);
    assert.match(oracle, /note BOOLEAN stays/);
  });

  it("leaves postgresql sql unchanged except no mysql header", () => {
    const sql = "CREATE TABLE t (flag BOOLEAN, name VARCHAR);";
    const out = sanitizeTargetDialectSql(sql, "postgresql");
    assert.equal(out, sql);
  });

  it("lints remaining mysql VARCHAR without length in code only", () => {
    const warnings = lintMigrationSql("CREATE TABLE t (name VARCHAR); -- VARCHAR", "mysql");
    assert.ok(warnings.some(w => /VARCHAR/.test(w)));
    const ok = lintMigrationSql("CREATE TABLE t (name VARCHAR(255)); -- VARCHAR", "mysql");
    assert.equal(ok.filter(w => /VARCHAR/.test(w)).length, 0);
  });
});

describe("FK parse and inject", () => {
  it("extracts inline and table-level FKs", () => {
    const ddl = `
CREATE TABLE category (id INT PRIMARY KEY);
CREATE TABLE brand (
  id INT PRIMARY KEY,
  category_id INT REFERENCES category(id)
);
CREATE TABLE pickup_point_customer (
  pickup_id INT,
  customer_id INT,
  FOREIGN KEY (customer_id) REFERENCES customer(id)
);
`;
    const tables = parseDdlTables(ddl);
    assert.equal(tables.brand.fks[0].parent, "category");
    assert.equal(tables.pickup_point_customer.fks[0].col, "customer_id");
  });

  it("puts added FKs into SCHEMA_DIFF and injects missing ALTER", () => {
    const oldDdl = "CREATE TABLE category (id INT PRIMARY KEY);";
    const newDdl = `CREATE TABLE category (id INT PRIMARY KEY);
CREATE TABLE brand (id INT PRIMARY KEY, category_id INT REFERENCES category(id));`;
    const diff = buildSchemaDiff(oldDdl, newDdl);
    assert.ok(diff.addedFks.some(f => f.child === "brand" && f.col === "category_id"));
    assert.match(diff.text, /FK brand\.category_id/);
    const sql = "CREATE TABLE brand (id INT PRIMARY KEY, category_id INT);";
    const withFk = ensureFksFromDiff(sql, diff);
    assert.match(withFk, /FOREIGN KEY \(category_id\) REFERENCES category/);
  });
});

describe("ddlTransactionalNote", () => {
  it("warns for mysql not postgres", () => {
    assert.equal(ddlTransactionalNote("postgresql"), "");
    assert.match(ddlTransactionalNote("mysql"), /неявный COMMIT/i);
  });
});

describe("buildConstraintFacts", () => {
  it("labels CASCADE vs default FK so tests must not expect an error on cascade", () => {
    const ddl = `
CREATE TABLE student (id SERIAL PRIMARY KEY);
CREATE TABLE progress (
  student_id INT REFERENCES student(id) ON DELETE CASCADE
);
CREATE TABLE lesson (
  module_id INT REFERENCES module(id)
);
`;
    const facts = buildConstraintFacts(ddl);
    assert.match(facts, /progress\.student_id[\s\S]*CASCADE[\s\S]*ошибку НЕ ожидать/i);
    assert.match(facts, /lesson\.module_id[\s\S]*NO ACTION[\s\S]*УПАСТЬ/i);
    assert.doesNotMatch(facts, /Certificate/i);
  });
});

describe("lintIntegritySql", () => {
  it("flags cascade check via deleted parent subquery", () => {
    const sql = `
BEGIN;
INSERT INTO Course (title) VALUES ('Course2');
INSERT INTO Module (title, course_id) VALUES ('M', 1);
DELETE FROM Course WHERE title = 'Course2';
SELECT COUNT(*) FROM Module WHERE course_id = (SELECT id FROM Course WHERE title = 'Course2');
ROLLBACK;
`;
    const w = lintIntegritySql(sql);
    assert.ok(w.some(x => /удалённой таблицы Course/i.test(x) || /уже удалённой/i.test(x)));
  });

  it("flags subquery to a table not inserted in the same BEGIN", () => {
    const sql = `
BEGIN;
INSERT INTO Module (title, course_id) VALUES (NULL, (SELECT id FROM Course WHERE title = 'Course1'));
ROLLBACK;
`;
    const w = lintIntegritySql(sql);
    assert.ok(w.some(x => /course/i.test(x) && /без INSERT/i.test(x)));
  });

  it("accepts cascade check by child id", () => {
    const sql = `
BEGIN;
INSERT INTO Course (id, title, category, price) VALUES (900001, 't_c', 'x', 1);
INSERT INTO Module (id, title, course_id) VALUES (900101, 't_m', 900001);
DELETE FROM Course WHERE id = 900001;
SELECT COUNT(*) AS should_be_zero FROM Module WHERE id = 900101;
ROLLBACK;
`;
    assert.equal(lintIntegritySql(sql).length, 0);
  });

  it("warns when cascade is checked via parent FK value instead of child pk", () => {
    const sql = `
BEGIN;
INSERT INTO "User" (id, name, email) VALUES (900001, 'User1', 'a@b.c');
INSERT INTO "Account" (id, user_id, currency, balance) VALUES (900101, 900001, 'USD', 1);
DELETE FROM "User" WHERE id = 900001;
SELECT COUNT(*) AS should_be_zero FROM "Account" WHERE user_id = 900001;
ROLLBACK;
`;
    const w = lintIntegritySql(sql);
    assert.ok(w.some(x => /дочерней строки/i.test(x) || /по FK/i.test(x)));
  });
});

describe("quoteReservedTableIdents", () => {
  it("quotes unquoted User for postgres and leaves UserRole", () => {
    const sql = `INSERT INTO User (id) VALUES (1);\nINSERT INTO UserRole (user_id) VALUES (1);`;
    const out = quoteReservedTableIdents(sql, "postgresql");
    assert.match(out, /INSERT INTO "User"/);
    assert.match(out, /INSERT INTO UserRole/);
  });
});
