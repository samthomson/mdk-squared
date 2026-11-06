// Device reads and writes over the MDK client. Commands are never retried
// (the Kernel de-duplicates by command id); we poll the command status until
// a terminal state, which is the documented read-back path.

import type { DeviceSpec } from './config'

// The slice of @tetherto/mdk-client this app uses, as a named contract.
export interface MdkClient {
  connect: (opts?: { warmup?: boolean }) => Promise<void>
  close: () => Promise<void>
  getStatus: () => Promise<{ workers: Array<{ workerId: string, state: string, healthState: string, deviceIds: string[], deviceCount: number }>, totalDevices: number }>
  pullTelemetry: (deviceId: string, query?: string | object) => Promise<unknown>
  sendCommand: (deviceId: string, command: string, params?: object) => Promise<{ commandId: string, status: string, error?: string }>
  getCommandStatus: (commandId: string) => Promise<{ status: string, result?: unknown, error?: string | null }>
}

export interface DeviceTelemetry {
  hashrate_ghs?: number
  power_w?: number
  fan_rpm?: number
  temp_c?: number
  filter_life_pct?: number
  pm25_ugm3?: string
  power_mode?: string
  mining?: string
}

export interface DeviceHealth {
  reachable: boolean | null
  lastSuccessAt: number | null
  lastError: string | null
  lastErrorAt: number | null
}

export interface CommandOutcome {
  commandId: string
  status: string
  result?: unknown
  error?: string | null
}

const COMMAND_POLL_MS = 200
const COMMAND_TIMEOUT_MS = 15000
const TERMINAL: Record<string, true> = { SUCCESS: true, FAILED: true, TIMEOUT: true }

export class DeviceService {
  constructor (
    private readonly client: MdkClient,
    readonly specs: DeviceSpec[]
  ) {}

  async telemetry (deviceId: string): Promise<DeviceTelemetry> {
    const reply = (await this.client.pullTelemetry(deviceId, { type: 'metrics' })) as { metrics?: DeviceTelemetry } | null
    return reply?.metrics ?? {}
  }

  async health (deviceId: string): Promise<DeviceHealth | null> {
    const reply = (await this.client.pullTelemetry(deviceId, 'health').catch(() => null)) as { value?: DeviceHealth } | DeviceHealth | null
    if (!reply) return null
    if ('value' in reply && reply.value) return reply.value
    return reply as DeviceHealth
  }

  async command (deviceId: string, name: string, params: Record<string, unknown> = {}): Promise<CommandOutcome> {
    const accepted = await this.client.sendCommand(deviceId, name, params)
    if (accepted.status === 'REJECTED') {
      return { commandId: accepted.commandId, status: 'FAILED', error: accepted.error || 'ERR_COMMAND_REJECTED' }
    }
    const deadline = Date.now() + COMMAND_TIMEOUT_MS
    for (;;) {
      const entry = await this.client.getCommandStatus(accepted.commandId)
      if (TERMINAL[entry.status]) {
        return { commandId: accepted.commandId, status: entry.status, result: entry.result ?? undefined, error: entry.error ?? undefined }
      }
      if (Date.now() > deadline) {
        return { commandId: accepted.commandId, status: 'TIMEOUT', error: 'ERR_COMMAND_POLL_TIMEOUT' }
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, COMMAND_POLL_MS)
      await promise
    }
  }

  async commandAll (name: string, params: Record<string, unknown> = {}): Promise<CommandOutcome[]> {
    return Promise.all(this.specs.map((s) => this.command(s.deviceId, name, params)))
  }

  async workers (): Promise<Array<{ workerId: string, state: string, healthState: string, deviceIds: string[], deviceCount: number }>> {
    return (await this.client.getStatus()).workers
  }
}
