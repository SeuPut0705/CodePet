"use strict";

function badgesEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((badge, index) => (
      badge.key === right[index].key &&
      badge.remainingPercent === right[index].remainingPercent &&
      badge.ariaLabel === right[index].ariaLabel
    ))
  );
}

function copyBadges(badges) {
  return Array.isArray(badges) ? badges.map((badge) => ({ ...badge })) : [];
}

class KimiUsageController {
  constructor({
    client,
    pollMs = 60_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onBadgesChanged = () => {},
  } = {}) {
    this.client = client;
    this.pollMs = pollMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onBadgesChanged = onBadgesChanged;
    this.badges = [];
    this.timerId = null;
    this.inFlight = null;
    this.working = false;
    this.disposed = false;
    this.generation = 0;
  }

  setWorking(working) {
    if (this.disposed) return false;
    if (Boolean(working) === this.working) return false;

    this.working = Boolean(working);
    if (this.working) {
      this.refresh();
      return true;
    }

    this.generation += 1;
    this.inFlight = null;
    this.cancelTimer();
    this.setBadges([]);
    return true;
  }

  refresh() {
    if (this.disposed || !this.working) return Promise.resolve();
    if (this.inFlight) return this.inFlight;

    const generation = this.generation;
    let resolveInFlight;
    const inFlight = new Promise((resolve) => {
      resolveInFlight = resolve;
    });
    this.inFlight = inFlight;
    void this.fetchBadges(generation, inFlight, resolveInFlight);
    return inFlight;
  }

  async fetchBadges(generation, inFlight, resolveInFlight) {
    try {
      const badges = await this.client.fetchBadges();
      if (!this.disposed && this.working && generation === this.generation) {
        this.setBadges(copyBadges(badges));
      }
    } catch {
      // Keep the last successful values and retry on the next scheduled poll.
    } finally {
      if (this.inFlight === inFlight) {
        this.inFlight = null;
        if (!this.disposed && this.working && generation === this.generation) {
          this.schedule();
        }
      }
      resolveInFlight();
    }
  }

  schedule() {
    this.cancelTimer();
    if (this.disposed || !this.working) return;
    this.timerId = this.setTimer(() => {
      this.timerId = null;
      this.refresh();
    }, this.pollMs);
  }

  cancelTimer() {
    if (this.timerId === null) return;
    this.clearTimer(this.timerId);
    this.timerId = null;
  }

  setBadges(nextBadges) {
    if (badgesEqual(this.badges, nextBadges)) return;
    this.badges = copyBadges(nextBadges);
    this.onBadgesChanged(this.buildBadges());
  }

  buildBadges() {
    return copyBadges(this.badges);
  }

  whenIdle() {
    return this.inFlight || Promise.resolve();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.working = false;
    this.generation += 1;
    this.inFlight = null;
    this.cancelTimer();
    this.setBadges([]);
  }
}

module.exports = { KimiUsageController };
