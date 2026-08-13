function isAutoLaunchSupported({ platform, isPackaged }) {
  return platform !== "darwin" || Boolean(isPackaged);
}

function getLoginItemOptions({
  platform,
  isPackaged,
  execPath,
  appPath,
  portableExecutableFile,
}) {
  if (platform === "darwin") return {};
  if (portableExecutableFile) return { path: portableExecutableFile };
  return isPackaged ? {} : { path: execPath, args: [appPath] };
}

function clearUnsupportedAutoLaunch(app, context) {
  if (isAutoLaunchSupported(context)) return false;
  const settings = app.getLoginItemSettings();
  const registered = settings.openAtLogin ||
    !["not-registered", "not-found", undefined].includes(settings.status);
  if (!registered) return false;
  app.setLoginItemSettings({ openAtLogin: false });
  return true;
}

module.exports = {
  clearUnsupportedAutoLaunch,
  getLoginItemOptions,
  isAutoLaunchSupported,
};
