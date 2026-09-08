/**
 * Backward-compatible export surface.
 *
 * All tunable values now live under ./inputs so classifier engine files do not
 * become an archaeology project. New code may import DEFAULT_MISHIT_INPUTS;
 * existing callers can continue using DEFAULT_MISHIT_CONFIG.
 */
export {
  DEFAULT_MISHIT_INPUTS as DEFAULT_MISHIT_CONFIG,
  MISHIT_INPUT_VERSION,
} from './inputs/defaults'
