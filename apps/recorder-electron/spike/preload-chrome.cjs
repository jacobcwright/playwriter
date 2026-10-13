// E3: real Chrome exposes window.chrome in every page; Electron does not.
if (!window.chrome) {
  window.chrome = { app: { isInstalled: false, InstallState: {}, RunningState: {} }, runtime: {}, csi: () => ({}), loadTimes: () => ({}) }
}
