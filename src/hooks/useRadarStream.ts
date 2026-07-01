import { useEffect, useRef, useState } from "react";
import type {
  LiveRadarFrameManifest,
  LiveRadarRadialBatch,
  RadarPatch,
  RadarSnapshot
} from "../lib/types";

interface RadarStreamState {
  connected: boolean;
  framesBySource: Record<string, LiveRadarFrameManifest>;
  bootstrapFieldsBySource: Record<string, LiveRadarRadialBatch>;
  liveUpdatesBySource: Record<string, LiveRadarRadialBatch>;
  snapshotLoadingBySource: Record<string, boolean>;
  snapshotErrorsBySource: Record<string, string | null>;
  radarTimesBySource: Record<
    string,
    { newestRadarTime?: string; oldestVisibleRadarTime?: string; updatedAt?: string }
  >;
  lastMessageAt: string | null;
}

type WorkerResponse =
  | { type: "bootstrap-field"; payload: LiveRadarRadialBatch }
  | { type: "live-update"; payload: LiveRadarRadialBatch };

type WorkerRequest =
  | { type: "bootstrap"; payload: LiveRadarRadialBatch }
  | { type: "radials"; payload: LiveRadarRadialBatch };

const defaultUrl = "ws://localhost:8787/ws";
const defaultApiUrl = "http://localhost:8787";

function stationIdFromSourceId(sourceId: string) {
  return sourceId.split("-")[0].trim().toUpperCase();
}

function sourceIdFromStationId(stationId: string) {
  return `${stationId.trim().toLowerCase()}-ref`;
}

function sequenceOf(batch: Pick<LiveRadarRadialBatch, "sequence" | "frame">) {
  return batch.sequence ?? batch.frame.sequence ?? 0;
}

function toBootstrapBatch(snapshot: RadarSnapshot): LiveRadarRadialBatch {
  return {
    type: "radial_batch",
    stationId: snapshot.stationId,
    product: snapshot.product,
    tilt: snapshot.tilt,
    sequence: snapshot.sequence,
    frame: {
      ...snapshot.frame,
      sourceId: snapshot.frame.sourceId ?? sourceIdFromStationId(snapshot.stationId),
      site: snapshot.stationId,
      product: snapshot.product,
      sequence: snapshot.sequence
    },
    radials: snapshot.radials
  };
}

export function useRadarStream(sourceId: string) {
  const [state, setState] = useState<RadarStreamState>({
    connected: false,
    framesBySource: {},
    bootstrapFieldsBySource: {},
    liveUpdatesBySource: {},
    snapshotLoadingBySource: {},
    snapshotErrorsBySource: {},
    radarTimesBySource: {},
    lastMessageAt: null
  });
  const socketRef = useRef<WebSocket | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const sourceIdRef = useRef(sourceId);
  const switchTokenRef = useRef(0);
  const bufferingRef = useRef(false);
  const bufferedPatchesRef = useRef<RadarPatch[]>([]);
  const latestSequenceBySourceRef = useRef(new Map<string, number>());
  const applyPatchRef = useRef<((patch: RadarPatch) => void) | null>(null);

  sourceIdRef.current = sourceId;

  useEffect(() => {
    const worker = new Worker(new URL("../workers/radarFieldWorker.ts", import.meta.url), {
      type: "module"
    });
    workerRef.current = worker;

    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === "bootstrap-field") {
        setState((current) => ({
          ...current,
          lastMessageAt: new Date().toISOString(),
          bootstrapFieldsBySource: {
            ...current.bootstrapFieldsBySource,
            [message.payload.frame.sourceId]: message.payload
          }
        }));
        return;
      }

      if (message.type !== "live-update") {
        return;
      }

      setState((current) => ({
        ...current,
        lastMessageAt: new Date().toISOString(),
        liveUpdatesBySource: {
          ...current.liveUpdatesBySource,
          [message.payload.frame.sourceId]: message.payload
        }
      }));
    });

    const url = import.meta.env.VITE_RADAR_WS_URL ?? defaultUrl;
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      const stationId = stationIdFromSourceId(sourceIdRef.current);
      socket.send(
        JSON.stringify({
          type: "subscribe_radar",
          stationId,
          product: "REF",
          tilt: 0.5
        })
      );
      setState((current) => ({ ...current, connected: true }));
    });

    socket.addEventListener("close", () => {
      setState((current) => ({ ...current, connected: false }));
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    });

    const applyPatch = (patch: RadarPatch) => {
      const patchSourceId = patch.frame.sourceId ?? sourceIdFromStationId(patch.stationId);
      const sequence = sequenceOf(patch);
      const lastSequence = latestSequenceBySourceRef.current.get(patchSourceId) ?? 0;

      if (sequence <= lastSequence) {
        return;
      }

      latestSequenceBySourceRef.current.set(patchSourceId, sequence);
      setState((current) => ({
        ...current,
        connected: true,
        lastMessageAt: new Date().toISOString(),
        framesBySource: {
          ...current.framesBySource,
          [patchSourceId]: patch.frame
        }
      }));
      workerRef.current?.postMessage({
        type: "radials",
        payload: patch
      } satisfies WorkerRequest);
    };
    applyPatchRef.current = applyPatch;

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as
        | { type: "hello"; serverTime: string }
        | { type: "subscribed"; sourceId: string }
        | {
            type: "subscribed_radar";
            stationId: string;
            product: string;
            tilt: number;
            sequence: number;
          }
        | { type: "radar-frame"; payload: LiveRadarFrameManifest }
        | { type: "radar-radials"; payload: LiveRadarRadialBatch }
        | { type: "radar-bootstrap"; payload: LiveRadarRadialBatch }
        | { type: "radar-patch"; payload: RadarPatch };

      if (message.type === "radar-frame") {
        setState((current) => ({
          ...current,
          connected: true,
          lastMessageAt: new Date().toISOString(),
          framesBySource: {
            ...current.framesBySource,
            [message.payload.sourceId]: message.payload
          }
        }));
        return;
      }

      if (message.type === "radar-patch") {
        const patch = message.payload;
        const patchSourceId = patch.frame.sourceId ?? sourceIdFromStationId(patch.stationId);

        if (patchSourceId !== sourceIdRef.current) {
          return;
        }

        if (bufferingRef.current) {
          bufferedPatchesRef.current.push(patch);
          return;
        }

        applyPatchRef.current?.(patch);
        return;
      }

      if (message.type === "radar-bootstrap") {
        workerRef.current?.postMessage({
          type: "bootstrap",
          payload: message.payload
        } satisfies WorkerRequest);
      }
    });

    return () => {
      socket.close();
      worker.terminate();

      if (socketRef.current === socket) {
        socketRef.current = null;
      }

      if (workerRef.current === worker) {
        workerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    const stationId = stationIdFromSourceId(sourceId);
    const token = switchTokenRef.current + 1;
    const apiBase = import.meta.env.VITE_RADAR_API_URL ?? defaultApiUrl;

    switchTokenRef.current = token;
    sourceIdRef.current = sourceId;
    bufferingRef.current = true;
    bufferedPatchesRef.current = [];
    setState((current) => ({
      ...current,
      snapshotLoadingBySource: {
        ...current.snapshotLoadingBySource,
        [sourceId]: true
      },
      snapshotErrorsBySource: {
        ...current.snapshotErrorsBySource,
        [sourceId]: null
      }
    }));

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "subscribe_radar",
        stationId,
        product: "REF",
        tilt: 0.5
      })
    );

    const snapshotUrl = `${apiBase}/api/radar/${encodeURIComponent(
      stationId
    )}/latest?product=REF&tilt=0.5`;

    void fetch(snapshotUrl)
      .then(async (response) => {
        if (response.status === 404) {
          return null;
        }

        if (!response.ok) {
          throw new Error(`Snapshot request failed: ${response.status}`);
        }

        return (await response.json()) as RadarSnapshot;
      })
      .then((snapshot) => {
        if (switchTokenRef.current !== token) {
          return;
        }

        if (snapshot) {
          const bootstrapBatch = toBootstrapBatch(snapshot);
          latestSequenceBySourceRef.current.set(sourceId, snapshot.sequence);
          setState((current) => ({
            ...current,
            lastMessageAt: new Date().toISOString(),
            framesBySource: {
              ...current.framesBySource,
              [sourceId]: bootstrapBatch.frame
            },
            radarTimesBySource: {
              ...current.radarTimesBySource,
              [sourceId]: {
                newestRadarTime: snapshot.newestRadarTime,
                oldestVisibleRadarTime: snapshot.oldestVisibleRadarTime,
                updatedAt: snapshot.updatedAt
              }
            }
          }));
          workerRef.current?.postMessage({
            type: "bootstrap",
            payload: bootstrapBatch
          } satisfies WorkerRequest);
        }

        const replayAfterSequence = snapshot?.sequence ?? latestSequenceBySourceRef.current.get(sourceId) ?? 0;
        const bufferedPatches = bufferedPatchesRef.current
          .filter((patch) => sequenceOf(patch) > replayAfterSequence)
          .sort((left, right) => sequenceOf(left) - sequenceOf(right));

        bufferingRef.current = false;
        bufferedPatchesRef.current = [];

        for (const patch of bufferedPatches) {
          applyPatchRef.current?.(patch);
        }

        setState((current) => ({
          ...current,
          snapshotLoadingBySource: {
            ...current.snapshotLoadingBySource,
            [sourceId]: false
          }
        }));
      })
      .catch((error) => {
        if (switchTokenRef.current !== token) {
          return;
        }

        bufferingRef.current = false;
        const bufferedPatches = bufferedPatchesRef.current
          .sort((left, right) => sequenceOf(left) - sequenceOf(right));
        bufferedPatchesRef.current = [];

        for (const patch of bufferedPatches) {
          applyPatchRef.current?.(patch);
        }

        setState((current) => ({
          ...current,
          snapshotLoadingBySource: {
            ...current.snapshotLoadingBySource,
            [sourceId]: false
          },
          snapshotErrorsBySource: {
            ...current.snapshotErrorsBySource,
            [sourceId]: error instanceof Error ? error.message : "Snapshot request failed"
          }
        }));
      });
  }, [sourceId, state.connected]);

  return state;
}
