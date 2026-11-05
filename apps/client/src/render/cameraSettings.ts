/**
 * Player-facing camera and motion settings, in one place so the settings screen can write them.
 * Everything that reads them reads them live, so a change takes effect on the next frame.
 *
 * SCREEN_SHAKE: multiplier, 0 for none, 1 as designed, up to about 1.5.
 * REDUCED_MOTION: no shake, no flights (camera moves jump), no pan momentum, no big-moment pans,
 * and the in-world marks stop animating. Starts from the system preference.
 * EDGE_SCROLL: pan when the mouse rests against the edge of the screen.
 * BIG_MOMENTS: let the camera go and look when something big happens.
 */
export const cameraSettings = {
  SCREEN_SHAKE: 1,
  REDUCED_MOTION: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  EDGE_SCROLL: true,
  BIG_MOMENTS: true,
};
