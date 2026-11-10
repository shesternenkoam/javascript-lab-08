/// <reference types="vite/client" />

declare const __GIT_SHA__: string;
declare const __APP_VERSION__: string;

declare interface Window {
  simSelfTest?: (steps?: number, seed?: number) => number;
}
