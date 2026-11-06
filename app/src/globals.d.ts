// The @tetherto packages are CJS without shipped type declarations; the app
// consumes them through the named MdkClient contract in devices.ts, so an
// ambient any here is scoped to the import boundary only.
declare module '@tetherto/mdk-core'
declare module '@tetherto/mdk-worker'
declare module 'hyperdht'
declare module '@tetherto/mdk-client'
