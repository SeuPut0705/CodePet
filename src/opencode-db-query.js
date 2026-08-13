"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

class OpenCodeDbQuery {
  constructor(file) {
    this.file = file;
    this.worker = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, "opencode-db-worker.js"));
    worker.on("message", (message) => {
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(Array.isArray(message.rows) ? message.rows : []);
    });
    const rejectPending = (error) => {
      if (this.worker === worker) this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on("error", rejectPending);
    worker.on("exit", (code) => {
      if (code !== 0) rejectPending(new Error(`OpenCode DB worker exited (${code}).`));
      else if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  query(sql) {
    const worker = this.ensureWorker();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, file: this.file, sql });
    });
  }

  close() {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("OpenCode DB watcher stopped."));
    }
    this.pending.clear();
    void worker?.terminate();
  }
}

module.exports = { OpenCodeDbQuery };
