import React, { useEffect, useState } from 'react'
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
        {d.id}
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
    </div>
  )
}

function AutopilotPanel ({ status, stations, api, onChanged }: { status: AutopilotStatus | null, stations: StationInfo[], api: Api, onChanged: () => void }) {
  if (!status) return null
  const { config, engaged, readings } = status
  const readingOf = (station: string) => readings.find((r) => r.station === station)

  return (
    <div className="card">
      <h3>
        Autopilot — nostr PM2.5
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={`badge ${engaged ? 'on' : 'off'}`}>{engaged ? 'AUTO: HIGH' : status.overrideUntil && status.overrideUntil > Date.now() ? `manual ${Math.ceil((status.overrideUntil - Date.now()) / 60000)}m` : 'idle'}</span>
          <button
            className={config.enabled ? 'active small' : 'small'}
            onClick={() => { void api.updateAutopilot({ enabled: !config.enabled }).then(onChanged) }}
          >
            {config.enabled ? 'enabled' : 'disabled'}
          </button>
        </span>
      </h3>
      <div className="muted" style={{ marginBottom: 8 }}>Selected stations publish PM2.5 → above {config.onUgm3} µg/m³ the fleet purifies at high; below {config.offUgm3} it idles at {config.idleMode}. Any manual button click pauses this for 30 min.</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">demo:</span>
        <button className="small" onClick={() => { void api.simulate(45).then(onChanged).catch(() => {}) }}> spike 45 </button>
        <button className="small" onClick={() => { void api.simulate(12).then(onChanged).catch(() => {}) }}> clear 12 </button>
        <span className="muted">publishes a fake station reading on nostr</span>
      </div>
      <div className="panel-row" style={{ marginTop: 12 }}>
        <div className="field">purify ON above
          <input type="number" defaultValue={config.onUgm3} onBlur={(e) => { void api.updateAutopilot({ onUgm3: Number(e.target.value) }).then(onChanged) }} /> µg/m³
        </div>
        <div className="field">idle below
          <input type="number" defaultValue={config.offUgm3} onBlur={(e) => { void api.updateAutopilot({ offUgm3: Number(e.target.value) }).then(onChanged) }} /> µg/m³
        </div>
        <div className="field">idle mode
          <div className="row">
            {MODES.filter((m) => m !== 'off').map((m) => (
              <button key={m} className={m === config.idleMode ? 'active small' : 'small'} onClick={() => { void api.updateAutopilot({ idleMode: m }).then(onChanged) }}>{m}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="stations">
        {stations.length === 0 && <div className="muted">No kind-16158 PM2.5 stations found on the configured relays yet. Run <code>node app/tools/seed-weather.mjs station</code> or point at your own weather station.</div>}
        {stations.map((s) => {
          const selected = config.stations.includes(s.pubkey)
          const reading = readingOf(s.pubkey)
          return (
            <div className="station" key={s.pubkey}>
              <button
                className={selected ? 'active small' : 'small'}
                onClick={() => {
                  const next = selected ? config.stations.filter((k) => k !== s.pubkey) : [...config.stations, s.pubkey]
                  void api.updateAutopilot({ stations: next }).then(onChanged)
                }}
              >
                {selected ? '✓' : '+'}
              </button>
              <div>
                <div>{s.name ?? short(s.npub)} <span className="muted">{s.geohash ? `· ${s.geohash}` : ''}</span></div>
                <div className="npub">{short(s.npub)}</div>
              </div>
              {(reading ?? s.latest) && (
                <div className="reading">
                  {reading ? reading.value.toFixed(1) : s.latest!.value.toFixed(1)} µg/m³
                  <span className="muted" style={{ display: 'block', fontSize: 10, fontWeight: 400 }}>
                    {ago((reading ?? s.latest)!.at)}{reading ? ' · live' : ''}
                  </span>
                </div>
              )}
            </div>
          )
        })}
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
  const [tab, setTab] = useState<'overview' | 'devices' | 'automation' | 'people' | 'activity'>('overview')
  const [devices, setDevices] = useState<DeviceStatus[]>([])
  const [autopilot, setAutopilot] = useState<AutopilotStatus | null>(null)
  const [stations, setStations] = useState<StationInfo[]>([])
  const [marmot, setMarmot] = useState<Record<string, unknown> | null>(null)
  const [events, setEvents] = useState<Array<{ ts: number, kind: string, message: string }>>([])
  const refresh = () => {
    void api.devices().then((d) => setDevices(d.devices)).catch(() => {})
    void api.autopilot().then(setAutopilot).catch(() => {})
    void api.marmot().then(setMarmot).catch(() => {})
    void api.events().then((e) => setEvents(e.events)).catch(() => {})
  }

  useEffect(() => {
    refresh()
    void api.stations().then((s) => setStations(s.stations)).catch(() => {})
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
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
          {(['overview', 'devices', 'automation', 'people', 'activity'] as const).map((t) => (
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
          <div className={`banner ${fleetState.tone}`}>
            <div>
              <div className="banner-title">{fleetState.title}</div>
              <div className="banner-sub">{fleetState.sub}</div>
            </div>
            <div className="banner-actions">
              {fleetState.action === 'resume' && <button className="small" onClick={() => { void api.resumeAutopilot().then(refresh) }}>resume auto</button>}
              {fleetState.action === 'enable' && <button className="small" onClick={() => { void api.updateAutopilot({ enabled: true }).then(refresh) }}>enable auto</button>}
              {lastReading && <span className="banner-reading">PM2.5 {lastReading.value.toFixed(1)} · {ago(lastReading.at)}</span>}
            </div>
          </div>
          <div className="fleetbar">
            <div className="stat"><div className="k">indoor PM2.5 (mean)</div><div className="v">{meanPm25 !== null ? meanPm25.toFixed(1) : '—'} <small>µg/m³</small></div></div>
            <div className="stat"><div className="k">hashrate</div><div className="v">{totalHash.toFixed(2)} <small>TH/s</small></div></div>
            <div className="stat"><div className="k">power</div><div className="v">{totalW.toFixed(0)} <small>W</small></div></div>
            <div className="stat"><div className="k">devices</div><div className="v">{devices.length}</div></div>
          </div>
          <div className="minidevices">
            {devices.map((d) => (
              <div className={`minidevice ${fleetState.actor}`} key={d.id}>
                <span className="id">{d.id}</span>
                <span className={`modetag ${fleetState.actor}`}>{fleetState.actor === 'auto' ? '⚡' : fleetState.actor === 'manual' ? '✋' : ''} {String(d.telemetry.power_mode ?? '?')}</span>
                <span className="pm">{Number(d.telemetry.pm25_ugm3 ?? 0).toFixed(1)} µg/m³</span>
                <span className="temp">{Number(d.telemetry.temp_c ?? 0).toFixed(0)}°C</span>
              </div>
            ))}
          </div>
          <section>
            <h2>Recent</h2>
            <EventLog events={events.slice(-8)} />
          </section>
        </>
      )}

      {tab === 'devices' && (
        <section>
          <h2>{fleetState.actor === 'auto' ? 'Under AUTO control' : fleetState.actor === 'manual' ? 'Under MANUAL control — auto paused' : 'Manual control'}</h2>
          <div className="grid">
            {devices.map((d) => <DeviceCard key={d.id} d={d} api={api} onChanged={refresh} actor={fleetState.actor} />)}
          </div>
        </section>
      )}

      {tab === 'automation' && (
        <section>
          <h2>Automation</h2>
          <AutopilotPanel status={autopilot} stations={stations} api={api} onChanged={refresh} />
        </section>
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

createRoot(document.getElementById('root')!).render(<App />)
