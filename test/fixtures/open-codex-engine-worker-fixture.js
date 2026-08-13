const { parentPort } = require("node:worker_threads");

let configuration = {};
let startCount = 0;

function reply(id, result, delayMs = 0) {
  setTimeout(() => parentPort.postMessage({ id, ok: true, result }), delayMs);
}

parentPort.on("message", ({ id, type, payload = {} }) => {
  if (type === "start") {
    configuration = payload.configuration || {};
    startCount += 1;
    if (configuration.crash) {
      setImmediate(() => {
        throw new Error("fixture crash access_token=secret https://oauth.example/callback?code=secret");
      });
      return;
    }
    reply(id, { activeTurns: 0, draining: false, port: 43123, running: true, startCount }, configuration.startDelayMs);
    return;
  }
  if (type === "getStatus") {
    reply(id, { activeTurns: 0, draining: false, port: 43123, running: true, startCount }, 35);
    return;
  }
  if (type === "getCapabilities") {
    reply(id, { protocolVersion: 1, transports: ["http", "websocket"] }, 5);
    return;
  }
  if (type === "reload") {
    configuration = payload.configuration || {};
    reply(id, { activeTurns: 0, draining: false, port: 43123, running: true, reloaded: true });
    return;
  }
  if (type === "quiesceAndStop") {
    reply(id, { activeTurns: 0, draining: false, port: null, running: false }, configuration.stopDelayMs);
  }
});
