const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const WebSocket = require("ws");

const serverModuleUrl = pathToFileURL(
  path.resolve(__dirname, "../src/open-codex/runtime/node-bun-server.ts")
).href;

async function loadServerModule() {
  return import(serverModuleUrl);
}

function once(target, event) {
  return new Promise((resolve, reject) => {
    target.once(event, resolve);
    target.once("error", reject);
  });
}

test("Node Bun server는 port 0, 반복 header, stream body와 request abort를 지원한다", async (t) => {
  const { createNodeBunServer } = await loadServerModule();
  let observeAbort;
  let observeAbortHandler;
  const aborted = new Promise((resolve) => { observeAbort = resolve; });
  const abortHandlerStarted = new Promise((resolve) => { observeAbortHandler = resolve; });
  const server = createNodeBunServer({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/headers") {
        const headers = new Headers();
        headers.append("set-cookie", "first=1; Path=/");
        headers.append("set-cookie", "second=2; Path=/");
        return new Response("headers", { status: 201, headers });
      }
      if (pathname === "/stream") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("one"));
            queueMicrotask(() => {
              controller.enqueue(Buffer.from("-two"));
              controller.close();
            });
          },
        }));
      }
      if (pathname === "/abort") {
        observeAbortHandler();
        await new Promise((resolve) => {
          request.signal.addEventListener("abort", () => {
            observeAbort();
            resolve();
          }, { once: true });
        });
        return new Response(null, { status: 499 });
      }
      return new Response("missing", { status: 404 });
    },
  });
  t.after(() => server.stop(true));
  await server.ready;

  assert.ok(server.port > 0);
  const baseUrl = `http://${server.hostname}:${server.port}`;
  const headersResponse = await fetch(`${baseUrl}/headers`);
  assert.equal(headersResponse.status, 201);
  assert.deepEqual(headersResponse.headers.getSetCookie(), ["first=1; Path=/", "second=2; Path=/"]);
  assert.equal(await headersResponse.text(), "headers");
  assert.equal(await (await fetch(`${baseUrl}/stream`)).text(), "one-two");

  const request = http.get(`${baseUrl}/abort`);
  request.on("error", () => {});
  await abortHandlerStarted;
  request.destroy();
  await aborted;
});

test("Node Bun server는 WebSocket upgrade와 text, binary, close 계약을 보존한다", async (t) => {
  const { createNodeBunServer } = await loadServerModule();
  const events = [];
  let observeServerClose;
  const serverClosed = new Promise((resolve) => { observeServerClose = resolve; });
  const server = createNodeBunServer({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, requestServer) {
      if (request.headers.get("upgrade") === "websocket") {
        if (requestServer.upgrade(request, { data: { connectionId: "fixture" } })) return undefined;
      }
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        events.push(["open", socket.data.connectionId]);
      },
      message(socket, message) {
        events.push(["message", typeof message === "string" ? message : Buffer.from(message).toString("hex")]);
        socket.send(message);
      },
      close(socket, code, reason) {
        events.push(["close", socket.data.connectionId, code, reason]);
        observeServerClose();
      },
    },
  });
  t.after(() => server.stop(true));
  await server.ready;
  const baseUrl = `http://${server.hostname}:${server.port}`;

  const refusal = await fetch(`${baseUrl}/socket`);
  assert.equal(refusal.status, 426);

  const client = new WebSocket(`ws://${server.hostname}:${server.port}/socket`);
  await once(client, "open");
  client.send("hello");
  const text = await once(client, "message");
  assert.equal(text.toString(), "hello");
  client.send(Buffer.from([0, 1, 2]));
  const binary = await once(client, "message");
  assert.deepEqual(Buffer.from(binary), Buffer.from([0, 1, 2]));
  client.close(1000, "done");
  await once(client, "close");
  await serverClosed;

  assert.deepEqual(events, [
    ["open", "fixture"],
    ["message", "hello"],
    ["message", "000102"],
    ["close", "fixture", 1000, "done"],
  ]);
});
