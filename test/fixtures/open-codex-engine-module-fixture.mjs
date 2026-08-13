let running = false;

export async function startEmbeddedEngine(options = {}) {
  if (options.port === 999) {
    throw new Error("start failed api_key=secret https://oauth.example/callback?code=secret");
  }
  running = true;
  return getEmbeddedEngineStatus();
}

export function getEmbeddedEngineStatus() {
  return {
    activeTurns: 0,
    draining: false,
    port: running ? 45678 : null,
    running,
  };
}

export async function stopEmbeddedEngine() {
  running = false;
  return getEmbeddedEngineStatus();
}
