"use strict";

class SubagentActivityTracker {
  constructor({ maxThreads = 512 } = {}) {
    this.maxThreads = maxThreads;
    this.threads = new Map();
    this.active = new Set();
  }

  registerThread({ threadId, threadSource, parentThreadId = null } = {}) {
    if (!threadId || !["user", "subagent"].includes(threadSource)) return false;
    this.threads.set(threadId, { threadSource, parentThreadId: parentThreadId || null });
    while (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value;
      this.threads.delete(oldest);
      this.active.delete(oldest);
    }
    return true;
  }

  setActive(threadId, active) {
    if (!this.threads.has(threadId)) return false;
    if (active) this.active.add(threadId);
    else this.active.delete(threadId);
    return true;
  }

  removeThread(threadId) {
    this.active.delete(threadId);
    return this.threads.delete(threadId);
  }

  rootFor(threadId) {
    const visited = new Set();
    let currentId = threadId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const metadata = this.threads.get(currentId);
      if (!metadata) return null;
      if (metadata.threadSource === "user") return currentId;
      currentId = metadata.parentThreadId;
    }
    return null;
  }

  countsByRoot() {
    const counts = new Map();
    for (const threadId of this.active) {
      const metadata = this.threads.get(threadId);
      if (metadata?.threadSource !== "subagent") continue;
      const rootId = this.rootFor(threadId);
      if (rootId) counts.set(rootId, (counts.get(rootId) || 0) + 1);
    }
    return counts;
  }

  getCount(rootThreadId) {
    return this.countsByRoot().get(rootThreadId) || 0;
  }
}

module.exports = { SubagentActivityTracker };
