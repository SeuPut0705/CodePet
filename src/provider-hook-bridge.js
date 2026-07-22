"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const MAX_BODY_BYTES = 512 * 1024;
const ROUTE = /^\/codepet\/v1\/events\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)$/;

function sameToken(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function send(response, statusCode) {
  response.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end("{}\n");
}

class ProviderHookBridge {
  constructor({ watchers = {}, port = 43721, token = crypto.randomBytes(24).toString("hex") } = {}) {
    this.watchers = watchers;
    this.port = port;
    this.token = token;
    this.server = null;
  }

  info() {
    const address = this.server?.address();
    return {
      port: address && typeof address === "object" ? address.port : this.port,
      token: this.token,
    };
  }

  start() {
    if (this.server) return Promise.resolve(this.info());
    this.server = http.createServer((request, response) => this.handle(request, response));
    return new Promise((resolve, reject) => {
      const server = this.server;
      const onError = (error) => {
        server.removeListener("listening", onListening);
        if (this.server === server) this.server = null;
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(this.info());
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, "127.0.0.1");
    });
  }

  stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    server.close();
  }

  handle(request, response) {
    if (request.method !== "POST") {
      send(response, 405);
      return;
    }
    const match = String(request.url || "").match(ROUTE);
    const watcher = match ? this.watchers[match[1]] : null;
    if (!match || !watcher || typeof watcher.ingest !== "function") {
      request.resume();
      send(response, 404);
      return;
    }
    if (!sameToken(request.headers["x-codepet-token"], this.token)) {
      request.resume();
      send(response, 403);
      return;
    }

    let size = 0;
    const chunks = [];
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (rejected) {
        send(response, 413);
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid");
        watcher.ingest(match[2], payload);
        send(response, 202);
      } catch {
        send(response, 400);
      }
    });
    request.on("error", () => {
      if (!response.headersSent) send(response, 400);
    });
  }
}

module.exports = { MAX_BODY_BYTES, ProviderHookBridge, sameToken };
