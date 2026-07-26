import { installBunCompatibility } from "./bun-compat";

type ServerModule = typeof import("../../../vendor/opencodex/src/server/index");
type EmbeddedServer = ReturnType<ServerModule["startServer"]>;

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
let serverModule: ServerModule | undefined;
let serverModulePromise: Promise<ServerModule> | undefined;

installBunCompatibility();

function loadServerModule(): Promise<ServerModule> {
  if (!serverModulePromise) {
    serverModulePromise = import("../../../vendor/opencodex/src/server/index").then((module) => {
      serverModule = module;
      return module;
    });
  }
  return serverModulePromise;
}

export function getEmbeddedEngineStatus(): EmbeddedEngineStatus {
  return {
    activeTurns: serverModule?.getActiveTurnCount() ?? 0,
    draining: serverModule?.isDraining() ?? false,
    port: server?.port ?? null,
    running: server !== undefined,
  };
}

export async function startEmbeddedEngine(
  options: EmbeddedEngineOptions = {},
): Promise<EmbeddedEngineStatus> {
  const runtime = await loadServerModule();
  if (!server) server = runtime.startServer(options.port);
  return getEmbeddedEngineStatus();
}

export async function stopEmbeddedEngine(
  options: EmbeddedEngineStopOptions = {},
): Promise<EmbeddedEngineStatus> {
  if (!server) return getEmbeddedEngineStatus();
  const runtime = await loadServerModule();
  const runningServer = server;
  await runtime.drainAndShutdown(runningServer, options.timeoutMs ?? 30_000);
  server = undefined;
  return getEmbeddedEngineStatus();
}
