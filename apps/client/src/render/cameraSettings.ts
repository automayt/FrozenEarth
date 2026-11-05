import { onSettings, settings } from '../settings';

/**
 * Player-facing camera and motion settings, kept in step with the settings screen below.
 * Everything that reads them reads them live, so a change takes effect on the next frame.
 *
 * SCREEN_SHAKE: multiplier, 0 for none, 1 as designed, up to about 1.5.
 * REDUCED_MOTION: no shake, no flights (camera moves jump), no pan momentum, no big-moment pans,
 * and the in-world marks stop animating.
 * EDGE_SCROLL: pan when the mouse rests against the edge of the screen.
 * BIG_MOMENTS: let the camera go and look when something big happens.
 */
export const cameraSettings = {
  SCREEN_SHAKE: 1,
  REDUCED_MOTION: false,
  EDGE_SCROLL: true,
  BIG_MOMENTS: true,
};

function sync(): void {
  cameraSettings.SCREEN_SHAKE = settings.screenShake ? 1 : 0;
  cameraSettings.REDUCED_MOTION = settings.reducedMotion;
  cameraSettings.EDGE_SCROLL = settings.edgeScroll;
  cameraSettings.BIG_MOMENTS = settings.bigMoments;
}

sync();
onSettings(sync);
