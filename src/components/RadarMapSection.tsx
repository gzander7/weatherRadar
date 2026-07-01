import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useRadarStream } from "../hooks/useRadarStream";
import { radarFramesBySource, radarSites } from "../lib/radarMapData";
import { radarSources, sweepModes } from "../lib/mockData";
import type { RadarSource } from "../lib/types";

const RadarMap = lazy(() => import("./RadarMap").then((module) => ({ default: module.RadarMap })));

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

interface RadarMapSectionProps {
  activeSourceId: string;
  activeSource: RadarSource;
  activeModeId: string;
  setActiveSourceId: (value: string) => void;
  setActiveModeId: (value: string) => void;
}

export function RadarMapSection({
  activeSourceId,
  activeSource,
  activeModeId,
  setActiveSourceId,
  setActiveModeId
}: RadarMapSectionProps) {
  const radarStream = useRadarStream(activeSourceId);
  const [frameIndex, setFrameIndex] = useState(0);
  const [shouldMountMap, setShouldMountMap] = useState(false);

  const activeMode = useMemo(
    () => sweepModes.find((mode) => mode.id === activeModeId) ?? sweepModes[0],
    [activeModeId]
  );
  const selectableRadarSites = useMemo(
    () =>
      radarSources
        .filter((source) => source.kind === "single-site")
        .map((source) => {
          const siteCode = source.id.split("-")[0].toLowerCase();
          const site = radarSites.find((entry) => entry.id === siteCode);

          if (!site) {
            return null;
          }

          return {
            sourceId: source.id,
            code: site.id.toUpperCase(),
            name: source.name,
            latitude: site.latitude,
            longitude: site.longitude
          };
        })
        .filter((site): site is NonNullable<typeof site> => site !== null),
    []
  );
  const mrmsSource = useMemo(
    () => radarSources.find((source) => source.kind === "mrms") ?? null,
    []
  );

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
    const timer = window.setTimeout(() => setShouldMountMap(true), 250);
    return () => window.clearTimeout(timer);
  }, []);

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
    <article className="panel wide map-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Live map</p>
          <h2>Radar over basemap</h2>
        </div>
        <span className="badge">webgl radial path</span>
      </div>

      <div className="map-toolbar">
        <div className="map-toolbar-stat active-radar-stat">
          <span>Active radar</span>
          <strong>{isMrms ? "MRMS" : activeSourceId.split("-")[0].toUpperCase()}</strong>
        </div>

        {mrmsSource ? (
          <button
            className={`map-toolbar-action${isMrms ? " is-active" : ""}`}
            type="button"
            onClick={() => setActiveSourceId(mrmsSource.id)}
            disabled={isMrms}
          >
            MRMS
          </button>
        ) : null}

        <label>
          <span>Playback</span>
          <select value={activeModeId} onChange={(event) => setActiveModeId(event.target.value)} disabled={isMrms}>
            {sweepModes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name}
              </option>
            ))}
          </select>
        </label>

        <div className="map-toolbar-stat">
          <span>{isMrms ? "Live product" : "Data progress"}</span>
          <strong>{isMrms ? "MRMS" : `${Math.round((activeFrame?.completionRatio ?? 0) * 100)}%`}</strong>
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

      {shouldMountMap ? (
        <Suspense fallback={<div className="radar-map-loading">Loading live radar view…</div>}>
          <RadarMap
            sourceId={activeSourceId}
            sourceKind={activeSource.kind}
            frameManifest={frameManifest}
            liveUpdate={liveUpdate}
            bootstrapField={bootstrapField}
            allowSyntheticFallback={shouldUseSyntheticFallback}
            selectableSites={selectableRadarSites}
            activeSourceId={activeSourceId}
            onSourceSelect={setActiveSourceId}
          />
        </Suspense>
      ) : (
        <div className="radar-map-loading">Preparing live radar view…</div>
      )}

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
  );
}
