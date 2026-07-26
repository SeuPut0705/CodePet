const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

function runtimeModule(name) {
  return import(pathToFileURL(path.resolve(__dirname, `../src/open-codex/runtime/${name}.ts`)).href);
}

test("SQLite alias는 OpenCodex history와 Kiro query, transaction 계약을 실행한다", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-node-sqlite-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.sqlite");
  const { Database, constants } = await runtimeModule("node-sqlite");
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, source TEXT, has_user_event INTEGER, first_user_message TEXT);
    CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO threads VALUES ('one', 'openai', 'cli', 0, 'hello');
    INSERT INTO auth_kv VALUES ('kiro:token', '{"accessToken":"fixture"}');
  `);

  assert.deepEqual(
    db.query("SELECT id, model_provider FROM threads WHERE source IN (?, ?) ORDER BY id").all("cli", "vscode"),
    [{ id: "one", model_provider: "openai" }]
  );
  assert.deepEqual(
    db.query("SELECT key, value FROM auth_kv WHERE key LIKE ? ORDER BY key ASC").get("%:token"),
    { key: "kiro:token", value: '{"accessToken":"fixture"}' }
  );
  const update = db.transaction(() => {
    db.query("UPDATE threads SET model_provider = ?, has_user_event = ? WHERE id = ?")
      .run("opencodex", 1, "one");
  });
  update();
  assert.deepEqual(db.query("SELECT count(*) AS n FROM threads").get(), { n: 1 });
  db.close();

  const uri = `${pathToFileURL(filePath).href}?immutable=1`;
  const readonly = new Database(uri, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
  assert.deepEqual(readonly.query("SELECT model_provider FROM threads WHERE id = ?").get("one"), {
    model_provider: "opencodex",
  });
  assert.throws(() => readonly.exec("DELETE FROM threads"));
  readonly.close();
});

test("JSC alias는 scalar heap 통계를 반환한다", async () => {
  const { heapStats } = await runtimeModule("node-jsc");
  const stats = heapStats();
  assert.ok(Number.isFinite(stats.heapSize) && stats.heapSize > 0);
  assert.ok(Number.isFinite(stats.heapCapacity) && stats.heapCapacity >= stats.heapSize);
  assert.ok(Number.isInteger(stats.objectCount) && stats.objectCount >= 0);
});

test("FFI alias는 foreign process를 열지 않고 이름 있는 오류를 낸다", async () => {
  const { dlopen, ptr } = await runtimeModule("node-ffi");
  const buffer = new ArrayBuffer(8);
  assert.equal(ptr(buffer), buffer);
  assert.throws(
    () => dlopen("foreign-library", {}),
    (error) => error?.code === "OPENCODEX_CAPABILITY_UNAVAILABLE" && error?.capability === "bun-ffi"
  );
});
