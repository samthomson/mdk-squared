// The Tether-MDK plane, in one process: a private HyperDHT bootstrap on
// loopback, the Kernel (with an RBAC policy and one app service account), the
// bitair WorkerRuntimeV2 hosting the Worker plugin plus one mock BitAir per
// configured device, and an @tetherto/mdk-client the app uses for every
// device read and write.
//
// In-process registration (kernel.registerWorker) is the same in-process
// topology `mdk run` uses: the worker's allowlist admits exactly the Kernel's
// client key, so every command flows through the Kernel's RBAC check and
// write-command log even though nothing leaves this process over HRPC.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import HyperDHT from 'hyperdht'
// The @tetherto packages are CJS; named ESM imports of their exports do not
// resolve statically, so destructure the default import at runtime.
import mdkCore from '@tetherto/mdk-core'
import mdkWorker from '@tetherto/mdk-worker'
import mdkClientPkg from '@tetherto/mdk-client'
import { createServer as createMockBitair } from '../../worker/mock/server.js'
import { fileURLToPath } from 'node:url'
import type { Config, DeviceSpec } from './config'
import type { MdkClient } from './devices'

const { getKernel, startDhtBootstrap } = mdkCore as Record<string, Function>
const { createMdkClient } = mdkClientPkg as Record<string, Function>

interface RuntimeLike {
  start: () => Promise<void>
  stop: () => Promise<void>
  getPublicKey: () => { toString: (encoding: string) => string }
}
const { WorkerRuntimeV2 } = mdkWorker as unknown as { WorkerRuntimeV2: new (dir: string, opts: Record<string, unknown>) => RuntimeLike }

const APP_ACCOUNT = 'app:mdk2'

export interface MockHandle { deviceId: string; port: number; state: unknown; exit: () => void }

export interface MdkPlane {
  kernelKey: string
  workerId: string
  client: MdkClient
  mocks: MockHandle[]
  stop: () => Promise<void>
}

export async function bootMdk (cfg: Config, devices: DeviceSpec[]): Promise<MdkPlane> {
  const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'worker')
  if (!fs.existsSync(path.join(workerDir, 'mdk-contract.json'))) {
    throw new Error(`ERR_WORKER_DIR: ${workerDir} has no mdk-contract.json`)
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true })

  // 1. Private DHT on loopback: nothing in this process touches the public
  //    HyperDHT bootstrap nodes.
  const dht = await startDhtBootstrap({ host: cfg.dhtHost, port: cfg.dhtPort })
  const hrpc = { bootstrap: dht.bootstrap, dhtHost: cfg.dhtHost }

  // 2. App service account: one ed25519 keypair generated per boot (the
  //    Kernel re-reads serviceAccounts from its boot options, so no stable
  //    credential file is needed in this single-process topology).
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const credential = {
    name: APP_ACCOUNT,
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  }
  const serviceAccount = {
    name: APP_ACCOUNT,
    publicKey: Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('hex')
  }
  const rbac = {
    enforcement: 'deny',
    roles: [
      {
        name: 'mdk2-app',
        rules: [
          { resources: ['workers'], verbs: ['list', 'read'] },
          { resources: ['devices'], verbs: ['read', 'write'] },
          { resources: ['commands'], verbs: ['read'] }
        ]
      }
    ],
    bindings: [
      { role: 'mdk2-app', subjects: [{ kind: 'ServiceAccount', name: APP_ACCOUNT }] }
    ]
  }

  // 3. Kernel.
  const kernel = await getKernel({
    root: cfg.dataDir,
    storeDir: path.join(cfg.dataDir, 'kernel-db'),
    handleSignals: false,
    rbac,
    serviceAccounts: [serviceAccount],
    hrpc,
    discovery: { mode: 'local' }
  })
  const kernelKey = kernel.getPublicKey().toString('hex')

  // The Kernel's HRPC listener is fail-closed: it admits callers whose public
  // key appears in the trusted-keys rendezvous dir. Publish this process's
  // client keypair there so the app's client is allowed to connect.
  const clientKeyPair = HyperDHT.keyPair()
  const trustedDir = path.join(cfg.dataDir, '.trusted-keys')
  fs.mkdirSync(trustedDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(trustedDir, 'app-mdk2.pub'), `${clientKeyPair.publicKey.toString('hex')}\n`, { mode: 0o600 })

  // 4. Mock BitAirs (skipped entirely when REAL_DEVICES is set).
  const mocks: MockHandle[] = []
  if (!cfg.realDevices) {
    for (const spec of devices) {
      const port = spec.config.port
      const mock = createMockBitair({ host: spec.config.host, port, serial: spec.deviceId })
      mocks.push({ deviceId: spec.deviceId, port, state: mock.state, exit: () => mock.exit() })
    }
  }


  // 5. The Worker: fail-closed, admitting only the Kernel's client key.
  const storeDir = path.join(cfg.dataDir, 'workers', cfg.workerId, 'store')
  fs.mkdirSync(storeDir, { recursive: true })
  const runtime = new WorkerRuntimeV2(workerDir, {
    workerId: cfg.workerId,
    devices,
    allowedKeys: [kernel.getClientPublicKey()],
    storeDir,
    ...hrpc
  })
  await runtime.start()
  await kernel.registerWorker(runtime.getPublicKey())

  // 6. The client every app-side read/write goes through.
  const client = createMdkClient({
    kernelKey,
    kernelKeyPair: clientKeyPair,
    kernelCredential: credential,
    kernelBootstrap: dht.bootstrap,
    kernelDhtHost: cfg.dhtHost
  })
  await client.connect({ warmup: true })

  const stop = async () => {
    await client.close()
    await runtime.stop()
    for (const mock of mocks) mock.exit()
    await kernel.stop()
    await dht.close()
  }

  return { kernelKey, workerId: cfg.workerId, client, mocks, stop }
}
