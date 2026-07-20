"use strict";

const TRANSIENT_ERROR_CODES = new Set([
  "KIMI_USAGE_TIMEOUT",
  "KIMI_USAGE_NETWORK",
  "KIMI_USAGE_RATE_LIMIT",
  "KIMI_USAGE_SERVER",
]);

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
    } catch (error) {
      // 네트워크 계열 일시 오류만 마지막 성공값을 유지합니다. 인증·미지원·응답 오류는
      // 이미 무효한 한도를 계속 보여주지 않도록 즉시 비웁니다.
      if (
        !this.disposed &&
        this.working &&
        generation === this.generation &&
        !TRANSIENT_ERROR_CODES.has(error?.code)
      ) this.setBadges([]);
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
    // 종료 중 renderer를 다시 그리지 않도록 내부 상태만 폐기합니다.
    this.badges = [];
  }
}

module.exports = { KimiUsageController, TRANSIENT_ERROR_CODES };
