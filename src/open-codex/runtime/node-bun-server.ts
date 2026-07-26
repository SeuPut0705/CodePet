import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

interface BunWebSocketHandler {
  open?(socket: NodeBunWebSocket): void;
  message?(socket: NodeBunWebSocket, message: string | Buffer): void;
  close?(socket: NodeBunWebSocket, code: number, reason: string): void;
}

export interface NodeBunServerOptions {
  fetch(request: Request, server: NodeBunServer): Response | undefined | Promise<Response | undefined>;
  hostname?: string;
  idleTimeout?: number;
  port?: number;
  websocket?: BunWebSocketHandler;
}

interface UpgradeContext {
  accepted: boolean;
  data: unknown;
  head: Buffer;
  request: IncomingMessage;
  socket: Socket;
}

interface RequestContext {
  request: IncomingMessage;
}

export interface NodeBunWebSocket {
  data: any;
  readonly readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export interface NodeBunServer {
  readonly hostname: string;
  readonly port: number;
  readonly ready: Promise<void>;
  stop(force?: boolean): Promise<void>;
  timeout(request: Request, seconds: number): void;
  upgrade(request: Request, options?: { data?: unknown }): boolean;
}

function requestUrl(request: IncomingMessage, hostname: string, port: number): string {
  const authority = request.headers.host || `${hostname}:${port}`;
  return `http://${authority}${request.url || "/"}`;
}

function webRequestFromNode(
  request: IncomingMessage,
  hostname: string,
  port: number,
  abortController: AbortController,
): Request {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
  }
  const method = request.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(requestUrl(request, hostname, port), {
    body: hasBody ? Readable.toWeb(request) as ReadableStream : undefined,
    duplex: hasBody ? "half" : undefined,
    headers,
    method,
    signal: abortController.signal,
  } as RequestInit);
}

function setResponseHeaders(response: Response, target: ServerResponse): void {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") target.setHeader(name, value);
  }
  if (cookies.length > 0) target.setHeader("set-cookie", cookies);
}

async function sendNodeResponse(response: Response, target: ServerResponse): Promise<void> {
  if (target.destroyed) return;
  target.statusCode = response.status;
  if (response.statusText) target.statusMessage = response.statusText;
  setResponseHeaders(response, target);
  if (!response.body) {
    target.end();
    return;
  }
  try {
    for await (const chunk of response.body) {
      if (target.destroyed) return;
      if (!target.write(chunk)) await once(target, "drain");
    }
    if (!target.destroyed) target.end();
  } catch (error) {
    if (!target.destroyed) target.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

function responseHeaderLines(response: Response): string[] {
  const lines: string[] = [];
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") lines.push(`${name}: ${value}`);
  }
  for (const cookie of cookies) lines.push(`set-cookie: ${cookie}`);
  lines.push("connection: close");
  return lines;
}

async function rejectUpgrade(socket: Socket, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const headers = responseHeaderLines(response);
  if (!response.headers.has("content-length")) headers.push(`content-length: ${body.length}`);
  socket.end([
    `HTTP/1.1 ${response.status} ${response.statusText || "Upgrade Rejected"}`,
    ...headers,
    "",
    body.toString("binary"),
  ].join("\r\n"), "binary");
}

function wrapWebSocket(socket: WebSocket, data: unknown): NodeBunWebSocket {
  return {
    data,
    get readyState() {
      return socket.readyState;
    },
    send(value) {
      socket.send(value as WebSocket.RawData);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
  };
}

export function createNodeBunServer(options: NodeBunServerOptions): NodeBunServer {
  if (!options || typeof options.fetch !== "function") {
    throw new TypeError("Bun.serve requires a fetch handler");
  }
  const hostname = options.hostname || "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const requestContexts = new WeakMap<Request, RequestContext>();
  const upgradeContexts = new WeakMap<Request, UpgradeContext>();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const nodeServer = createServer(async (nodeRequest, nodeResponse) => {
    const abortController = new AbortController();
    const abortRequest = () => abortController.abort(new Error("client disconnected"));
    nodeRequest.once("aborted", abortRequest);
    nodeResponse.once("close", () => {
      if (!nodeResponse.writableEnded) abortRequest();
    });
    const webRequest = webRequestFromNode(nodeRequest, hostname, server.port, abortController);
    requestContexts.set(webRequest, { request: nodeRequest });
    try {
      const response = await options.fetch(webRequest, server);
      await sendNodeResponse(response ?? new Response(null, { status: 204 }), nodeResponse);
    } catch (error) {
      if (!nodeResponse.headersSent && !nodeResponse.destroyed) {
        await sendNodeResponse(new Response("Internal Server Error", { status: 500 }), nodeResponse);
      } else if (!nodeResponse.destroyed) {
        nodeResponse.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  const server: NodeBunServer = {
    hostname,
    get port() {
      const address = nodeServer.address();
      return address && typeof address === "object" ? address.port : requestedPort;
    },
    ready,
    async stop(force = false) {
      for (const socket of sockets) socket.close(1001, "server shutdown");
      if (force) nodeServer.closeAllConnections?.();
      if (!nodeServer.listening) return;
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((error) => error ? reject(error) : resolve());
      });
      webSocketServer.close();
    },
    timeout(request, seconds) {
      requestContexts.get(request)?.request.socket.setTimeout(Math.max(0, seconds) * 1000);
    },
    upgrade(request, upgradeOptions = {}) {
      const context = upgradeContexts.get(request);
      if (!context || context.accepted) return false;
      context.accepted = true;
      context.data = upgradeOptions.data;
      return true;
    },
  };

  nodeServer.on("upgrade", async (nodeRequest, socket, head) => {
    const abortController = new AbortController();
    socket.once("close", () => abortController.abort(new Error("client disconnected")));
    const webRequest = webRequestFromNode(nodeRequest, hostname, server.port, abortController);
    const context: UpgradeContext = {
      accepted: false,
      data: undefined,
      head,
      request: nodeRequest,
      socket,
    };
    upgradeContexts.set(webRequest, context);
    requestContexts.set(webRequest, { request: nodeRequest });
    try {
      const response = await options.fetch(webRequest, server);
      if (!context.accepted) {
        await rejectUpgrade(socket, response ?? new Response("Upgrade Required", { status: 426 }));
        return;
      }
      webSocketServer.handleUpgrade(nodeRequest, socket, head, (webSocket) => {
        sockets.add(webSocket);
        const wrapped = wrapWebSocket(webSocket, context.data);
        webSocket.on("message", (message, binary) => {
          options.websocket?.message?.(wrapped, binary ? Buffer.from(message) : message.toString());
        });
        webSocket.on("close", (code, reason) => {
          sockets.delete(webSocket);
          options.websocket?.close?.(wrapped, code, reason.toString());
        });
        options.websocket?.open?.(wrapped);
      });
    } catch {
      if (!socket.destroyed) {
        await rejectUpgrade(socket, new Response("Internal Server Error", { status: 500 }));
      }
    }
  });

  nodeServer.once("error", (error) => rejectReady(error));
  nodeServer.listen(requestedPort, hostname, () => {
    if (options.idleTimeout) nodeServer.keepAliveTimeout = options.idleTimeout * 1000;
    resolveReady();
  });
  return server;
}
