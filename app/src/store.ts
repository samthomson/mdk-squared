// Tiny persistence + event log. JSON files under DATA_DIR; ring buffer for
// the activity feed the UI polls.

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export interface EventEntry {
  ts: number
  kind: 'command' | 'autopilot' | 'schedule' | 'auth' | 'marmot' | 'system'
  message: string
  detail?: unknown
}

const LOG_LIMIT = 500

export class Store {
  private log: EventEntry[] = []
  readonly events = new EventEmitter()

  constructor (readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.events.setMaxListeners(50)
  }

  readJson<T> (name: string, fallback: T): T {
    const file = path.join(this.dir, name)
    if (!fs.existsSync(file)) return fallback
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T
    } catch {
      return fallback
    }
  }

  writeJson (name: string, value: unknown): void {
    const file = path.join(this.dir, name)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
  }

  record (kind: EventEntry['kind'], message: string, detail?: unknown): void {
    const entry: EventEntry = { ts: Date.now(), kind, message, detail }
    this.log.push(entry)
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT)
    this.events.emit('event', entry)
  }

  recent (limit = 200): EventEntry[] {
    return this.log.slice(-limit)
  }
}
