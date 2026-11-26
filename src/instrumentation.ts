/**
 * Hook de arranque de Next. El trabajo real vive en instrumentation-node.ts
 * (import dinámico condicionado al runtime para que el bundler edge no
 * intente resolver dependencias de Node como `postgres`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const {
      checkFfmpeg,
      checkMediaDir,
      checkR2Config,
      cleanupOrphanRuns,
      encryptLegacySecrets,
      resumeAutomations,
      resumeCalendarSync,
      resumeDispatch,
      resumeMediaMaintenance,
      resumeMediaOptimizer,
      resumeMetaAds,
      resumeOutboxSweeper,
      resumeSubscriptionSweeper,
      seedPlatformData,
    } =
      await import("./instrumentation-node");
    await checkMediaDir();
    checkR2Config();
    // Antes de aceptar nada: si MEDIA_VIDEO_OPTIMIZE está encendida, ¿hay ffmpeg que la sostenga?
    await checkFfmpeg();
    await cleanupOrphanRuns();
    await encryptLegacySecrets();
    await seedPlatformData();
    resumeDispatch();
    resumeAutomations();
    resumeMetaAds();
    resumeCalendarSync();
    resumeOutboxSweeper();
    resumeSubscriptionSweeper();
    resumeMediaMaintenance();
    resumeMediaOptimizer();
  }
}
