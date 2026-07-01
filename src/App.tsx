import { useEffect, useState } from "react";
import { RadarMap } from "./components/RadarMap";
import { useRadarStream } from "./hooks/useRadarStream";
import { latencyProfiles, radarSources, recentFrames, sweepModes } from "./lib/mockData";
import { radarFramesBySource } from "./lib/radarMapData";
import type { RadarSource } from "./lib/types";

function formatUtc(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    hour12: false
  }).format(new Date(timestamp));
}

function formatLocalTime(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(new Date(timestamp));
}

function sourceById(sourceId: string): RadarSource {
  return radarSources.find((source) => source.id === sourceId)!;
}

export default function App() {
  const [activeSourceId, setActiveSourceId] = useState(radarSources[0].id);
  const radarStream = useRadarStream(activeSourceId);
  const [activeModeId, setActiveModeId] = useState(sweepModes[0].id);
  const [frameIndex, setFrameIndex] = useState(0);

  const activeMode = sweepModes.find((mode) => mode.id === activeModeId) ?? sweepModes[0];
  const activeSource = sourceById(activeSourceId);
  const frameManifest = radarStream.framesBySource[activeSourceId];
  const liveUpdate = radarStream.liveUpdatesBySource[activeSourceId];
  const bootstrapField = radarStream.bootstrapFieldsBySource[activeSourceId];
  const snapshotLoading = radarStream.snapshotLoadingBySource[activeSourceId] ?? false;
  const snapshotError = radarStream.snapshotErrorsBySource[activeSourceId];
  const radarTimes = radarStream.radarTimesBySource[activeSourceId];
  const activeFrames = radarFramesBySource[activeSourceId] ?? [];
  const isMrms = activeSource.kind === "mrms";
  const shouldUseSyntheticFallback = !isMrms && !radarStream.connected;
  const fallbackFrame = activeFrames[frameIndex % Math.max(activeFrames.length, 1)];
  const activeFrame =
    frameManifest ?? bootstrapField?.frame ?? (shouldUseSyntheticFallback ? fallbackFrame : undefined);

  useEffect(() => {
    setFrameIndex(0);
  }, [activeSourceId]);

  useEffect(() => {
    if (isMrms || activeFrames.length <= 1) {
      return;
    }

    const interval = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % activeFrames.length);
    }, activeMode.frameStepMs);

    return () => window.clearInterval(interval);
  }, [activeFrames.length, activeMode.frameStepMs, isMrms]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Weather Radar Platform</p>
          <h1>Low-latency radar delivery for single-site scans, MRMS, and RapidSweep playback.</h1>
          <p className="hero-copy">
            This starter app is built around the real bottleneck: minimizing the delay from radar
            scan time to client render time. Single-site radars should publish partial sweeps as
            soon as each elevation finishes. MRMS should stay in a separate slower lane for mosaic
            context, not block the live radar loop.
          </p>
        </div>

        <div className="hero-stats">
          <div className="stat-card accent">
            <span>Primary target</span>
            <strong>&lt; 6 s</strong>
            <small>single-site scan to browser paint</small>
          </div>
          <div className="stat-card">
            <span>RapidSweep pacing</span>
            <strong>250 ms</strong>
            <small>per animation step for partial sweeps</small>
          </div>
          <div className="stat-card">
            <span>MRMS lane</span>
            <strong>async</strong>
            <small>do not serialize national mosaic with live local radar</small>
          </div>
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="panel wide map-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Live map</p>
              <h2>Radar over basemap</h2>
            </div>
            <span className="badge">webgl radial path</span>
          </div>

          <div className="map-toolbar">
            <label>
              <span>Source</span>
              <select value={activeSourceId} onChange={(event) => setActiveSourceId(event.target.value)}>
                {radarSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Playback</span>
              <select
                value={activeModeId}
                onChange={(event) => setActiveModeId(event.target.value)}
                disabled={isMrms}
              >
                {sweepModes.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="map-toolbar-stat">
              <span>{isMrms ? "Live product" : "Data progress"}</span>
              <strong>
                {isMrms ? "MRMS" : `${Math.round((activeFrame?.completionRatio ?? 0) * 100)}%`}
              </strong>
            </div>

            <div className="map-toolbar-stat">
              <span>{isMrms ? "Refresh" : "Frame time"}</span>
              <strong>{isMrms ? "60 s" : `${activeMode.frameStepMs} ms`}</strong>
            </div>

            <div className="map-toolbar-stat">
              <span>Radar stream</span>
              <strong>{snapshotLoading ? "snapshot" : radarStream.connected ? "connected" : "offline"}</strong>
            </div>

            <div className="map-toolbar-stat">
              <span>Frame source</span>
              <strong>
                {isMrms
                  ? "NOAA"
                  : frameManifest || bootstrapField
                    ? "live"
                    : shouldUseSyntheticFallback
                      ? "synthetic"
                      : "none"}
              </strong>
            </div>

            <div className="map-toolbar-stat">
              <span>Gate bins</span>
              <strong>{frameManifest?.gateCount ?? bootstrapField?.frame.gateCount ?? 0}</strong>
            </div>

            <div className="map-toolbar-stat">
              <span>Live frame</span>
              <strong>{frameManifest ? "present" : "none"}</strong>
            </div>

            <div className="map-toolbar-stat">
              <span>Newest radar</span>
              <strong>{radarTimes?.newestRadarTime ? formatLocalTime(radarTimes.newestRadarTime) : "--:--:--"}</strong>
            </div>
          </div>

          <RadarMap
            sourceId={activeSourceId}
            sourceKind={activeSource.kind}
            frameManifest={frameManifest}
            liveUpdate={liveUpdate}
            bootstrapField={bootstrapField}
            allowSyntheticFallback={shouldUseSyntheticFallback}
          />

          <div className="map-notes">
            <p>
              The radar field stays in native radial form and is reprojected against the current map
              view instead of being stretched as a fixed bitmap.
            </p>
            <p>
              {isMrms
                ? `${activeSource.name} is using an official live NOAA image service now. It is real radar, but it is not the same low-latency path as direct Level II ingest.`
                : snapshotLoading
                  ? `${activeSource.name} is loading the latest cached radar snapshot before replaying buffered live patches.`
                  : snapshotError
                    ? `${activeSource.name} has no cached snapshot yet, so live patches will display as they arrive.`
                : frameManifest
                  ? `${activeSource.name} is receiving incremental Level II radial updates over WebSocket from the local ingest server. Current sweep state has ${frameManifest.gateCount ?? bootstrapField?.frame.gateCount ?? 0} gates at elevation ${frameManifest.elevation}, tilt ${frameManifest.tiltIndex}, chunk ${frameManifest.chunkSequence}.`
                  : shouldUseSyntheticFallback
                    ? `${activeSource.name} is currently using the synthetic fallback because the local ingest server is offline.`
                    : `${activeSource.name} is connected to the local radar server, but no live Level II frame for this source has arrived yet.`}
            </p>
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Sources</p>
              <h2>Radar ingest lanes</h2>
            </div>
            <span className="badge">{radarSources.length} configured</span>
          </div>
          <div className="source-list">
            {radarSources.map((source) => (
              <div className="source-card" key={source.id}>
                <div className="source-card-header">
                  <h3>{source.name}</h3>
                  <span className={`kind-chip kind-${source.kind}`}>{source.kind}</span>
                </div>
                <dl>
                  <div>
                    <dt>Cadence</dt>
                    <dd>{source.cadenceSeconds}s</dd>
                  </div>
                  <div>
                    <dt>Transport</dt>
                    <dd>{source.transport}</dd>
                  </div>
                  <div>
                    <dt>Expected ingest</dt>
                    <dd>{source.ingestDelaySeconds}s</dd>
                  </div>
                </dl>
                <p>{source.notes}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Playback</p>
              <h2>RapidSweep modes</h2>
            </div>
          </div>
          <div className="mode-list">
            {sweepModes.map((mode) => (
              <div className="mode-card" key={mode.id}>
                <div>
                  <h3>{mode.name}</h3>
                  <p>{mode.description}</p>
                </div>
                <strong>{mode.frameStepMs} ms</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="panel wide">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Latency</p>
              <h2>End-to-end budget</h2>
            </div>
          </div>
          <div className="latency-list">
            {latencyProfiles.map((profile) => {
              const source = sourceById(profile.sourceId);
              const percentage = Math.min(100, (profile.currentMs / profile.targetMs) * 100);

              return (
                <div className="latency-card" key={profile.sourceId}>
                  <div className="latency-card-header">
                    <div>
                      <h3>{source.name}</h3>
                      <p>
                        {profile.currentMs.toLocaleString()} ms current /{" "}
                        {profile.targetMs.toLocaleString()} ms target
                      </p>
                    </div>
                    <strong>{Math.round(percentage)}%</strong>
                  </div>
                  <div className="latency-bar">
                    <div className="latency-fill" style={{ width: `${percentage}%` }} />
                  </div>
                  <div className="segment-list">
                    {profile.segments.map((segment) => (
                      <div className="segment-pill" key={segment.label}>
                        <span>{segment.label}</span>
                        <strong>{segment.milliseconds} ms</strong>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </article>

        <article className="panel wide">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Recent frames</p>
              <h2>Render queue</h2>
            </div>
          </div>
          <div className="frame-table">
            <div className="frame-table-header">
              <span>Source</span>
              <span>Product</span>
              <span>Scan UTC</span>
              <span>Available UTC</span>
              <span>Rendered UTC</span>
              <span>Completion</span>
              <span>Age</span>
            </div>
            {recentFrames.map((frame) => {
              const source = sourceById(frame.sourceId);
              return (
                <div className="frame-row" key={frame.id}>
                  <span>{source.name}</span>
                  <span>{frame.product}</span>
                  <span>{formatUtc(frame.scanTime)}</span>
                  <span>{formatUtc(frame.availableTime)}</span>
                  <span>{formatUtc(frame.renderTime)}</span>
                  <span>{Math.round(frame.completionRatio * 100)}%</span>
                  <span>{frame.ageSeconds}s</span>
                </div>
              );
            })}
          </div>
        </article>
      </section>
    </main>
  );
}
