import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Api, nip98Login, type DeviceStatus, type AutopilotStatus, type StationInfo, type Me } from './api'
import './styles.css'

const MODES = ['off', 'eco', 'low', 'high']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function short (id: string): string { return `${id.slice(0, 10)}…` }

function Login ({ onLogin }: { onLogin: (api: Api, me: Me) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const { token, me } = await nip98Login()
      onLogin(new Api(token), me)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <h1>mdk<span>²</span></h1>
      <p>BitAir fleet control on two MDKs — Tether MDK for the devices, Marmot MDK for the people. Sign in with your Nostr identity; your npub must be the admin or a member of the fleet's Marmot group.</p>
      <button className="primary" onClick={go} disabled={busy}>{busy ? 'Signing…' : 'Sign in with Nostr (NIP-07)'}</button>
      {error && <div className="error">{error}</div>}
    </div>
  )
}

function DeviceCard ({ d, api, onChanged, actor }: { d: DeviceStatus, api: Api, onChanged: () => void, actor: 'auto' | 'manual' | 'none' }) {
  const t = d.telemetry
  const mode = t.power_mode ?? '?'
  const hot = (t.temp_c ?? 0) >= 85

  return (
    <div className={`card ${actor}`}>
      <h3>
        <span>
          {d.id}
          <span
            className="nickname"
            title="click to rename"
            onClick={() => {
              const next = window.prompt('nickname for ' + d.id, d.nickname ?? '')
              if (next !== null) void api.rename(d.id, next).then(onChanged)
            }}
          >{d.nickname ? ` · ${d.nickname}` : ' · ✎'}</span>
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {d.mock && <span className="tag mock">mock</span>}
          <span className={`modetag ${actor}`}>{actor === 'auto' ? '⚡ ' : actor === 'manual' ? '✋ ' : ''}{mode}</span>
        </span>
      </h3>
      <div className="stats">
        <div className="stat"><div className="k">PM2.5</div><div className="v">{Number(t.pm25_ugm3 ?? 0).toFixed(1)} <small>µg/m³</small></div></div>
        <div className="stat"><div className="k">Hashrate</div><div className="v">{(Number(t.hashrate_ghs ?? 0) / 1000).toFixed(2)} <small>TH/s</small></div></div>
        <div className="stat"><div className="k">Power</div><div className="v">{Number(t.power_w ?? 0).toFixed(0)} <small>W</small></div></div>
        <div className="stat"><div className="k">Temp</div><div className="v" style={hot ? { color: 'var(--bad)' } : undefined}>{Number(t.temp_c ?? 0).toFixed(0)} <small>°C</small></div></div>
        <div className="stat"><div className="k">Fan</div><div className="v">{Number(t.fan_rpm ?? 0).toFixed(0)} <small>rpm</small></div></div>
        <div className="stat"><div className="k">Filter</div><div className="v">{Number(t.filter_life_pct ?? 0).toFixed(0)} <small>%</small></div></div>
      </div>
      {actor === 'auto'
        ? <div className="muted" style={{ margin: '6px 0 10px' }}>Driven by autopilot — take manual control from the banner above.</div>
        : (
          <>
            <div className="row modes">
              {MODES.map((m) => (
                <button key={m} className={m === mode ? 'active' : ''} onClick={() => { void api.power(d.id, m).then(onChanged) }}>{m}</button>
              ))}
              <button
                className={t.mining === 'true' ? '' : 'active'}
                onClick={() => { void api.mining(d.id, t.mining !== 'true').then(onChanged) }}
                title="solo miner"
              >
                ⛏ {t.mining === 'true' ? 'on' : 'off'}
              </button>
            </div>
            <label className="fan">
              fan
              <input
                type="range" min={0} max={100} defaultValue={50}
                onMouseUp={(e) => { void api.fan(d.id, Number((e.target as HTMLInputElement).value)).then(onChanged) }}
              />
            </label>
          </>
          )}
    </div>
  )
}

function AutopilotPanel ({ status, stations, api, onChanged }: { status: AutopilotStatus | null, stations: StationInfo[], api: Api, onChanged: () => void }) {
  if (!status) return null
  const { config, engaged, readings } = status

  return (
    <div className="card">
      <h3>
        Autopilot — nostr PM2.5
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={`badge ${engaged ? 'on' : 'off'}`}>{engaged ? 'AUTO: HIGH' : status.overrideUntil && status.overrideUntil > Date.now() ? `manual ${Math.ceil((status.overrideUntil - Date.now()) / 60000)}m` : 'idle'}</span>
          <button
            className={config.enabled ? 'active small' : 'small'}
            disabled={config.stations.length === 0}
            title={config.stations.length === 0 ? 'select a station first' : undefined}
            onClick={() => { void api.updateAutopilot({ enabled: !config.enabled }).then(onChanged) }}
          >
            {config.enabled ? 'enabled' : 'disabled'}
          </button>
        </span>
      </h3>
      <div className="muted" style={{ marginBottom: 8 }}>
        {config.enabled
          ? <>Selected stations publish PM2.5 → above {config.onUgm3} µg/m³ the fleet purifies at high; below {config.offUgm3} it idles at {config.idleMode}.</>
          : <>Pick station(s) below, then enable. Thresholds unlock once the autopilot is running.</>}
      </div>
      {config.enabled && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted">demo:</span>
          <button className="small" onClick={() => { void api.simulate(45).then(onChanged).catch(() => {}) }}> spike 45 </button>
          <button className="small" onClick={() => { void api.simulate(12).then(onChanged).catch(() => {}) }}> clear 12 </button>
          <span className="muted">publishes a fake station reading on nostr</span>
        </div>
      )}
      <div className={`panel-row${config.enabled ? '' : ' disabled'}`} style={{ marginTop: 12, opacity: config.enabled ? 1 : 0.45, pointerEvents: config.enabled ? 'auto' : 'none' }}>
        <div className="field">purify ON above
          <input type="number" defaultValue={config.onUgm3} className={config.onUgm3 <= config.offUgm3 ? 'invalid' : ''} disabled={!config.enabled} onBlur={(e) => { void api.updateAutopilot({ onUgm3: Number(e.target.value) }).then(onChanged) }} /> µg/m³
        </div>
        <div className="field">idle below
          <input type="number" defaultValue={config.offUgm3} className={config.onUgm3 <= config.offUgm3 ? 'invalid' : ''} disabled={!config.enabled} onBlur={(e) => { void api.updateAutopilot({ offUgm3: Number(e.target.value) }).then(onChanged) }} /> µg/m³
        </div>
        {config.onUgm3 <= config.offUgm3 && <div className="field mode-error">ON must be above idle</div>}
        <div className="field">idle mode
          <div className="row">
            {MODES.filter((m) => m !== 'off').map((m) => (
              <button key={m} className={m === config.idleMode ? 'active small' : 'small'} onClick={() => { void api.updateAutopilot({ idleMode: m }).then(onChanged) }}>{m}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function EventLog ({ events }: { events: Array<{ ts: number, kind: string, message: string }> }) {
  return (
    <div className="card">
      <h3>Activity</h3>
      <div className="log">
        {events.slice().reverse().map((e, i) => (
          <div className="line" key={`${e.ts}-${i}`}>
            <span className="t">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={`k ${e.kind}`}>{e.kind}</span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MarmotPanel ({ status, api, me, onChanged }: { status: Record<string, unknown> | null, api: Api, me: Me, onChanged: () => void }) {
  const [npub, setNpub] = useState('')
  const [members, setMembers] = useState<Array<{ npub: string }>>([])
  if (!status) return null
  const joined = Boolean(status.groupJoined)

  return (
    <div className="card">
      <h3>Marmot group <span className={`badge ${joined ? 'on' : 'off'}`}>{joined ? 'joined' : 'awaiting invite'}</span></h3>
      <div className="muted" style={{ marginTop: 8 }}>
        {status.npub
          ? (joined
              ? <>Members of this MLS group can sign in and control the fleet. Members: {String(status.members?.length ?? 0)}. Say <code>!air status</code> in the group chat.</>
              : <>Invite this npub into your Marmot (White Noise/darkmatter) group: <code style={{ color: 'var(--accent)' }}>{String(status.npub)}</code></>)
          : <>Marmot disabled — set <code>MARMOT_ENABLED=true</code> to let an MLS group be the access list.</>}
      </div>
      {me.isAdmin && (
        <div className="row" style={{ marginTop: 12 }}>
          <input type="text" style={{ width: 320 }} placeholder="npub1… to allowlist without Marmot" value={npub} onChange={(e) => setNpub(e.target.value)} />
          <button
            className="small"
            onClick={async () => {
              if (!npub) return
              await api.addMember(npub)
              setNpub('')
              const m = await api.members()
              setMembers(m.members)
              onChanged()
            }}
          >
            allow
          </button>
          <button className="small" onClick={async () => setMembers((await api.members()).members)}>list</button>
        </div>
      )}
    </div>
  )
}

function ago (at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}


function Dashboard ({ api, me }: { api: Api, me: Me }) {
  const [tab, setTab] = useState<'overview' | 'people' | 'activity'>('overview')
  const stationsRef = useRef<HTMLDetailsElement>(null)
  const [devices, setDevices] = useState<DeviceStatus[]>([])
  const [autopilot, setAutopilot] = useState<AutopilotStatus | null>(null)
  const [modeError, setModeError] = useState<string | null>(null)
  const [autoOpen, setAutoOpen] = useState(false)
  const [stations, setStations] = useState<StationInfo[]>([])
  const [marmot, setMarmot] = useState<Record<string, unknown> | null>(null)
  const [events, setEvents] = useState<Array<{ ts: number, kind: string, message: string }>>([])
  const refresh = () => {
    // Mid-session expiry: token is already cleared by Api.call — one reload
    // lands on the login page (no loop: no token means no me() call).
    const onExpired = (err: unknown) => {
      if ((err as Error).message === 'ERR_SESSION_EXPIRED') window.location.reload()
    }
    void api.devices().then((d) => setDevices(d.devices)).catch(onExpired)
    void api.autopilot().then(setAutopilot).catch(onExpired)
    void api.marmot().then(setMarmot).catch(onExpired)
    void api.events().then((e) => setEvents(e.events)).catch(onExpired)
  }
  useEffect(() => {
    refresh()
    void api.stations().then((s) => setStations(s.stations)).catch(() => {})
    const timer = setInterval(refresh, 5000)
    const stationsTimer = setInterval(() => { void api.stations().then((s) => setStations(s.stations)).catch(() => {}) }, 60000)
    return () => { clearInterval(timer); clearInterval(stationsTimer) }
  }, [])

  const fleetState = deriveFleetState(autopilot)
  const meanPm25 = devices.length > 0
    ? devices.reduce((sum, d) => sum + Number(d.telemetry.pm25_ugm3 ?? 0), 0) / devices.length
    : null
  const totalHash = devices.reduce((sum, d) => sum + Number(d.telemetry.hashrate_ghs ?? 0), 0) / 1000
  const totalW = devices.reduce((sum, d) => sum + Number(d.telemetry.power_w ?? 0), 0)
  const lastReading = autopilot?.readings[0] ?? null

  return (
    <div className="wrap">
      <header>
        <div className="brand">mdk<span>²</span></div>
        <nav className="tabs">
          {(['overview', 'people', 'activity'] as const).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <div className="who">
          <div>{me.isAdmin ? 'admin' : 'member'} · via {me.source}</div>
          <code>{short(me.npub)}</code>
        </div>
      </header>

      {tab === 'overview' && (
        <>
          {/* Minimal mode toggle; AUTO expands to station + thresholds */}
          <div className="modebar">
            <button
              className={`modechip${fleetState.actor === 'auto' ? '' : ' on'}`}
              onClick={() => { setModeError(null); setAutoOpen(false); if (autopilot?.config.enabled) void api.updateAutopilot({ enabled: false }).then(refresh) }}
            >MANUAL</button>
            <button
              className={`modechip${fleetState.actor === 'auto' ? ' on auto' : ' auto'}`}
              onClick={() => {
                const cfg = autopilot?.config
                if (cfg?.enabled) { void api.resumeAutopilot().then(refresh); return }
                if ((cfg?.stations.length ?? 0) === 0) { setModeError('Pick a weather station first.'); setAutoOpen(true); return }
                if ((cfg?.onUgm3 ?? 0) <= (cfg?.offUgm3 ?? 0)) { setModeError('Purify threshold must be above idle threshold.'); setAutoOpen(true); return }
                setModeError(null)
                void api.updateAutopilot({ enabled: true }).then(refresh)
              }}
            >AUTO</button>
            <span className="modebar-state muted">
              {fleetState.actor === 'auto' ? fleetState.title.replace(/^AUTO · /, '') : 'you control the devices'}
            </span>
          </div>
          {modeError && <div className="mode-error">⚠️ {modeError}</div>}

          {(autoOpen || fleetState.actor === 'auto') && autopilot && (
            <div className="autosettings">
              <div className="autosettings-col">
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>weather station</div>
                {/* Configured stations missing from relay discovery stay selectable. */}
                {(autopilot.config.stations ?? []).filter((pk) => !stations.some((s) => s.pubkey === pk)).map((pk) => (
                  <label key={pk} className="stationrow sel">
                    <input type="radio" name="station" checked onChange={() => {}} />
                    <span className="stationname">station {short(pk)} · selected</span>
                  </label>
                ))}
                {stations.map((s) => {
                  const selected = (autopilot.config.stations ?? [])[0] === s.pubkey
                  const reading = (autopilot.readings ?? []).find((r) => r.station === s.pubkey)
                  return (
                    <label key={s.pubkey} className={`stationrow${selected ? ' sel' : ''}`}>
                      <input
                        type="radio" name="station" checked={selected}
                        onChange={() => { setModeError(null); void api.updateAutopilot({ stations: [s.pubkey] }).then(refresh) }}
                      />
                      <span className="stationname">{s.name ?? short(s.npub)}</span>
                      {(reading ?? s.latest) && (
                        <span className="stationval">{(reading ?? s.latest)!.value.toFixed(1)} µg/m³ · {ago((reading ?? s.latest)!.at)}</span>
                      )}
                    </label>
                  )
                })}
              </div>
              <div className="autosettings-col">
                {/* Current reading, big — colored by which band it falls in */}
                {(() => {
                  const ov = autopilot.config.overrideValue
                  const r = ov !== null && ov !== undefined
                    ? { value: ov, at: Date.now() }
                    : (autopilot.readings ?? []).find((x) => (autopilot.config.stations ?? [])[0] === x.station) ?? autopilot.readings?.[0]
                  const band = r ? (r.value >= autopilot.config.onUgm3 ? 'hot' : r.value <= autopilot.config.offUgm3 ? 'ok' : 'mid') : 'none'
                  return (
                    <div className={`pm-now ${band}`}>
                      <div className="pm-now-k">{ov !== null && ov !== undefined ? 'PM2.5 · OVERRIDE' : r ? 'PM2.5 now' : 'no reading yet'}</div>
                      <div className="pm-now-v">{r ? r.value.toFixed(1) : '—'}<small>µg/m³</small></div>
                      {r && <div className="pm-now-ago">{ov !== null && ov !== undefined ? 'manual value' : ago(r.at)}</div>}
                    </div>
                  )
                })()}
                <div className="field">purify at ≥
                  <input type="number" defaultValue={autopilot.config.onUgm3} className={autopilot.config.onUgm3 <= autopilot.config.offUgm3 ? 'invalid' : ''} onBlur={(e) => { void api.updateAutopilot({ onUgm3: Number(e.target.value) }).then(refresh) }} /> µg/m³
                </div>
                <div className="field">idle at ≤
                  <input type="number" defaultValue={autopilot.config.offUgm3} className={autopilot.config.onUgm3 <= autopilot.config.offUgm3 ? 'invalid' : ''} onBlur={(e) => { void api.updateAutopilot({ offUgm3: Number(e.target.value) }).then(refresh) }} /> µg/m³
                </div>
                {autopilot.config.onUgm3 <= autopilot.config.offUgm3 && <div className="mode-error">purify must be above idle</div>}
                <div className="field">value source
                  <label className="stationrow">
                    <input type="radio" name="valsrc" checked={autopilot.config.overrideValue === null}
                      onChange={() => { void api.updateAutopilot({ overrideValue: null }).then(refresh) }} />
                    <span className="stationname">station value</span>
                  </label>
                  <label className="stationrow">
                    <input type="radio" name="valsrc" checked={autopilot.config.overrideValue !== null}
                      onChange={() => { void api.updateAutopilot({ overrideValue: autopilot.config.overrideValue ?? 45 }).then(refresh) }} />
                    <span className="stationname">override</span>
                    <input type="number" style={{ width: 64 }} defaultValue={autopilot.config.overrideValue ?? 45}
                      onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) void api.updateAutopilot({ overrideValue: v }).then(refresh) }} />
                    <span className="muted">µg/m³</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* 3. Fleet stats + devices */}
          <div className="fleetbar">
            <div className="stat"><div className="k">indoor PM2.5 (mean)</div><div className="v">{meanPm25 !== null ? meanPm25.toFixed(1) : '—'} <small>µg/m³</small></div></div>
            <div className="stat"><div className="k">hashrate</div><div className="v">{totalHash.toFixed(2)} <small>TH/s</small></div></div>
            <div className="stat"><div className="k">power</div><div className="v">{totalW.toFixed(0)} <small>W</small></div></div>
            <div className="stat"><div className="k">devices</div><div className="v">{devices.length}</div></div>
          </div>
          <div className="grid">
            {devices.map((d) => <DeviceCard key={d.id} d={d} api={api} onChanged={refresh} actor={fleetState.actor} />)}
          </div>

          <section>
            <h2>Recent</h2>
            <EventLog events={events.slice(-8)} />
          </section>
        </>
      )}


      {tab === 'people' && (
        <section>
          <h2>People</h2>
          <MarmotPanel status={marmot} api={api} me={me} onChanged={refresh} />
        </section>
      )}

      {tab === 'activity' && (
        <section>
          <h2>Activity</h2>
          <EventLog events={events} />
        </section>
      )}
    </div>
  )
}

interface FleetState { tone: string, title: string, sub: string, action: null | 'resume' | 'enable', actor: 'auto' | 'manual' | 'none' }

function deriveFleetState (autopilot: AutopilotStatus | null): FleetState {
  if (!autopilot || !autopilot.config.enabled) {
    return { tone: 'off', title: 'AUTO is off', sub: 'Purifiers change only when you click.', action: 'enable', actor: 'none' }
  }
  if (autopilot.engaged) {
    return { tone: 'engaged', title: 'AUTO · purifying HIGH', sub: `PM2.5 is above ${autopilot.config.onUgm3} — every device set to high.`, action: null, actor: 'auto' }
  }
  if (autopilot.overrideUntil && autopilot.overrideUntil > Date.now()) {
    const mins = Math.ceil((autopilot.overrideUntil - Date.now()) / 60000)
    return { tone: 'manual', title: `MANUAL · auto paused ${mins}m`, sub: 'Your last button click is in charge. Auto resumes when the pause ends.', action: 'resume', actor: 'manual' }
  }
  return { tone: 'idle', title: 'AUTO · monitoring', sub: `Air is fine (below ${autopilot.config.offUgm3} µg/m³) — devices idle at ${autopilot.config.idleMode}.`, action: null, actor: 'auto' }
}


class CrashScreen extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor (props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError (error: Error) {
    return { error }
  }

  render () {
    if (this.state.error) {
      return (
        <div className="login">
          <h1>mdk<span>²</span> hit a bug</h1>
          <p className="error" style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error.stack ?? this.state.error.message).slice(0, 600)}</p>
          <button className="primary" onClick={() => { localStorage.removeItem('mdk2.token'); window.location.reload() }}>sign out &amp; reload</button>
        </div>
      )
    }
    return this.props.children
  }
}

function App () {
  const [state, setState] = useState<{ api: Api, me: Me } | null>(null)

  useEffect(() => {
    const token = localStorage.getItem('mdk2.token')
    if (!token) return
    const api = new Api(token)
    void api.me().then((me) => setState({ api, me })).catch(() => localStorage.removeItem('mdk2.token'))
  }, [])

  if (!state) return <Login onLogin={(api, me) => setState({ api, me })} />
  return <Dashboard api={state.api} me={state.me} />
}

window.__mdk2boot = true
createRoot(document.getElementById('root')!).render(<CrashScreen><App /></CrashScreen>)
