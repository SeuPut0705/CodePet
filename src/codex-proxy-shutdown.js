class CodexProxyShutdownCoordinator {
  constructor({
    isCodexWorking,
    prepareForQuit,
    finishQuit,
    notifyWaiting = () => {},
    notifyError = () => {},
    waitForIdleConfirmation = async () => {},
  } = {}) {
    this.isCodexWorking = isCodexWorking || (() => false);
    this.prepareForQuit = prepareForQuit || (async () => {});
    this.finishQuit = finishQuit || (() => {});
    this.notifyWaiting = notifyWaiting;
    this.notifyError = notifyError;
    this.waitForIdleConfirmation = waitForIdleConfirmation;
    this.waiting = false;
    this.quitRequested = false;
    this.readyToQuit = false;
    this.finalizePromise = null;
  }

  markWaiting() {
    if (this.waiting) return;
    this.waiting = true;
    this.notifyWaiting();
  }

  async requestQuit() {
    if (this.readyToQuit) return true;
    this.quitRequested = true;
    if (this.finalizePromise) return this.finalizePromise;

    if (this.isCodexWorking()) {
      this.markWaiting();
      return false;
    }

    return this.finalize();
  }

  async handleWorkingChanged(isWorking) {
    if (!this.quitRequested || this.readyToQuit) return false;
    if (isWorking) {
      this.markWaiting();
      return false;
    }
    if (!this.waiting) return false;
    return this.finalize();
  }

  finalize() {
    if (this.finalizePromise) return this.finalizePromise;

    this.waiting = false;
    this.finalizePromise = (async () => {
      try {
        await this.waitForIdleConfirmation();
        if (this.isCodexWorking()) {
          this.markWaiting();
          return false;
        }
        await this.prepareForQuit();
        this.readyToQuit = true;
        this.finishQuit();
        return true;
      } catch (error) {
        this.readyToQuit = false;
        this.notifyError(error);
        return false;
      } finally {
        this.finalizePromise = null;
      }
    })();
    return this.finalizePromise;
  }
}

async function prepareCodexProxyForQuit({
  proxyActive,
  isDesktopRunning,
  disableProxyConfig,
  stopDesktop,
  waitForDesktopExit,
  launchDesktop,
  stopProxy,
  restoreProxyConfig,
} = {}) {
  if (!proxyActive) {
    disableProxyConfig();
    stopProxy();
    return;
  }

  const desktopWasRunning = await isDesktopRunning();
  let configDisabled = false;
  let desktopStopped = false;

  try {
    disableProxyConfig();
    configDisabled = true;

    if (desktopWasRunning) {
      await stopDesktop();
      await waitForDesktopExit();
      desktopStopped = true;
      await launchDesktop();
    }

    stopProxy();
  } catch (error) {
    if (configDisabled) restoreProxyConfig();
    if (desktopStopped) {
      try {
        await launchDesktop();
      } catch {
        // 원래 종료 실패를 유지합니다. CodePet은 종료되지 않아 사용자가 다시 시도할 수 있습니다.
      }
    }
    throw error;
  }
}

module.exports = {
  CodexProxyShutdownCoordinator,
  prepareCodexProxyForQuit,
};
