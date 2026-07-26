import {
  drainAndShutdown,
  getActiveTurnCount,
  isDraining,
  startServer,
} from "../../../vendor/opencodex/src/server/index";

type EmbeddedServer = ReturnType<typeof startServer>;

export interface EmbeddedEngineOptions {
  port?: number;
}

export interface EmbeddedEngineStopOptions {
  timeoutMs?: number;
}

export interface EmbeddedEngineStatus {
  activeTurns: number;
  draining: boolean;
  port: number | null;
  running: boolean;
}

let server: EmbeddedServer | undefined;

export function getEmbeddedEngineStatus(): EmbeddedEngineStatus {
  return {
    activeTurns: getActiveTurnCount(),
    draining: isDraining(),
    port: server?.port ?? null,
    running: server !== undefined,
  };
}

export function startEmbeddedEngine(options: EmbeddedEngineOptions = {}): EmbeddedEngineStatus {
  if (!server) server = startServer(options.port);
  return getEmbeddedEngineStatus();
}

export async function stopEmbeddedEngine(
  options: EmbeddedEngineStopOptions = {},
): Promise<EmbeddedEngineStatus> {
  if (!server) return getEmbeddedEngineStatus();
  const runningServer = server;
  await drainAndShutdown(runningServer, options.timeoutMs ?? 30_000);
  server = undefined;
  return getEmbeddedEngineStatus();
}
