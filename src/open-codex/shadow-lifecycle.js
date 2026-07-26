const { sanitizeErrorMessage } = require("./engine-interface");

function createOpenCodexShadowLifecycle({
  enabled = false,
  createHost,
  log = () => {},
  stopTimeoutMs = 30_000,
} = {}) {
  let host = null;
  let startPromise = null;
  let status = enabled ? { state: "stopped" } : { state: "disabled" };

  async function start() {
    if (!enabled) return status;
    if (status.state === "ready") return status;
    if (startPromise) return startPromise;
    status = { state: "starting" };
    startPromise = (async () => {
      try {
        host = createHost();
        status = await host.start({ port: 0 });
        log(`OpenCodex shadow engine ready on 127.0.0.1:${status.port}`);
      } catch (error) {
        const message = sanitizeErrorMessage(error?.message || error);
        host = null;
        status = { state: "failed", error: message };
        log(`OpenCodex shadow engine failed: ${message}`);
      } finally {
        startPromise = null;
      }
      return status;
    })();
    return startPromise;
  }

  async function stop() {
    if (!enabled) return status;
    if (startPromise) await startPromise;
    if (!host) return status;
    const stoppingHost = host;
    const stopped = await stoppingHost.quiesceAndStop({ timeoutMs: stopTimeoutMs });
    if (host === stoppingHost) host = null;
    status = stopped;
    log("OpenCodex shadow engine stopped");
    return status;
  }

  function getStatus() {
    return { ...status };
  }

  return { getStatus, start, stop };
}

module.exports = { createOpenCodexShadowLifecycle };
