/**
 * Build metadata injected by vite `define` (see vite.config.ts). In test and
 * dev contexts where the defines are absent, the values fall back to 'dev'.
 */
declare const __APP_VERSION__: string | undefined;
declare const __GIT_SHA__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const GIT_SHA = typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'dev';
export const BUILD_TIME = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'dev';

export function describeBuild(): string {
  return `tether-io-dashboard ${APP_VERSION} (${GIT_SHA}, ${BUILD_TIME})`;
}
