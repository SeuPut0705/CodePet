const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

let readCodexThreadTitle = async () => null;
let CodexThreadTitleResolver = class {
  get() { return null; }
  async resolve() { return null; }
};
try {
  ({ readCodexThreadTitle, CodexThreadTitleResolver } = require("../src/codex-thread-title"));
} catch {
  // RED 단계에서는 모듈이 아직 없습니다.
}

const THREAD_ID = "019f6e52-b6c3-7330-9312-03ae4ef25386";

function fakeAppServer(thread) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writes: [],
    write(line) {
      this.writes.push(line);
      const message = JSON.parse(line);
      if (message.id === 1) {
        queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify({ id: 1, result: {} })}\n`));
      }
      if (message.id === 2) {
        const response = JSON.stringify({ id: 2, result: { thread } });
        queueMicrotask(() => {
          child.stdout.emit("data", response.slice(0, 19));
          child.stdout.emit("data", `${response.slice(19)}\n`);
        });
      }
    },
    end() {},
  };
  child.kill = () => { child.killed = true; };
  return child;
}

test("Codex app-server에서 사이드바 작업 제목을 thread ID로 읽는다", async () => {
  const child = fakeAppServer({ id: THREAD_ID, name: "CodePet" });
  const title = await readCodexThreadTitle(THREAD_ID, {
    command: "/mock/codex",
    spawnProcess: () => child,
    timeoutMs: 100,
  });

  assert.equal(title, "CodePet");
  assert.deepEqual(
    child.stdin.writes.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "thread/read"]
  );
  assert.equal(JSON.parse(child.stdin.writes[2]).params.includeTurns, false);
  assert.equal(child.killed, true);
});

test("작업 제목 resolver는 조회 결과를 캐시하고 실패를 화면 오류로 전파하지 않는다", async () => {
  let calls = 0;
  const resolver = new CodexThreadTitleResolver({
    loadTitle: async () => {
      calls += 1;
      return calls === 1 ? "CodePet" : null;
    },
    ttlMs: 60_000,
  });

  assert.equal(await resolver.resolve(THREAD_ID), "CodePet");
  assert.equal(await resolver.resolve(THREAD_ID), "CodePet");
  assert.equal(resolver.get(THREAD_ID), "CodePet");
  assert.equal(calls, 1);
  assert.equal(await resolver.resolve("agy:session"), null);
});

test("작업 제목 조회 실패도 잠시 캐시해 app-server 반복 실행을 막는다", async () => {
  let calls = 0;
  const resolver = new CodexThreadTitleResolver({
    loadTitle: async () => {
      calls += 1;
      return null;
    },
    failureTtlMs: 5_000,
  });

  assert.equal(await resolver.resolve(THREAD_ID), null);
  assert.equal(await resolver.resolve(THREAD_ID), null);
  assert.equal(calls, 1);
});
