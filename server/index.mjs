import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { RadarIngestService } from "./radar-ingest-service.mjs";
import {
  normalizeRadarProduct,
  normalizeRadarStationId,
  normalizeRadarTilt
} from "./radar-state-cache.mjs";

const port = Number(process.env.RADAR_SERVER_PORT ?? 8787);
const app = express();

app.use((_request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/healthz", (_request, response) => {
  response.json({ ok: true, now: new Date().toISOString() });
});

app.get("/status", (_request, response) => {
  response.json({
    ok: true,
    sites: ingestService.getConfiguredSites(),
    ingest: ingestService.getStatus()
  });
});

const server = createServer(app);
const websocketServer = new WebSocketServer({ server, path: "/ws" });
const ingestService = new RadarIngestService({
  sites: (process.env.RADAR_SITES ?? "KDMX,KEAX,KTLX")
    .split(",")
    .map((site) => site.trim().toUpperCase()),
  pollIntervalMs: Number(process.env.RADAR_POLL_MS ?? 15000)
});
const socketSubscriptions = new Map();

app.get("/api/radar/:stationId/latest", (request, response) => {
  const stationId = normalizeRadarStationId(request.params.stationId);
  const product = normalizeRadarProduct(request.query.product ?? "REF");
  const tilt = normalizeRadarTilt(request.query.tilt ?? 0.5);
  const snapshot = ingestService.getLatestRadarSnapshot(stationId, product, tilt);

  if (!snapshot) {
    response.status(404).json({
      ok: false,
      error: "radar_snapshot_not_found",
      stationId,
      product,
      tilt
    });
    return;
  }

  response.json(snapshot);
});

function normalizeSiteFromSourceId(sourceId) {
  return sourceId.split("-")[0].trim().toUpperCase();
}

function refreshRequestedSites() {
  const requestedSites = [...socketSubscriptions.values()]
    .flat()
    .map((subscription) => subscription.stationId);
  ingestService.setRequestedSites(requestedSites);
}

function subscriptionFromSourceId(sourceId) {
  const stationId = normalizeSiteFromSourceId(sourceId);
  return {
    stationId,
    product: "REF",
    tilt: 0.5,
    sourceId
  };
}

function subscriptionFromRadarMessage(message) {
  return {
    stationId: normalizeRadarStationId(message.stationId),
    product: normalizeRadarProduct(message.product ?? "REF"),
    tilt: normalizeRadarTilt(message.tilt ?? 0.5),
    afterSequence: Number.isFinite(Number(message.afterSequence))
      ? Number(message.afterSequence)
      : undefined,
    sourceId: `${normalizeRadarStationId(message.stationId).toLowerCase()}-ref`
  };
}

function updateMatchesSubscription(update, subscription) {
  const stationId = normalizeRadarStationId(update.stationId ?? update.frame.site);
  const product = normalizeRadarProduct(update.product ?? update.frame.product);
  const tilt = normalizeRadarTilt(update.tilt ?? 0.5);

  return (
    stationId === subscription.stationId &&
    product === subscription.product &&
    tilt === subscription.tilt &&
    (subscription.afterSequence == null || (update.sequence ?? 0) > subscription.afterSequence)
  );
}

websocketServer.on("connection", (socket) => {
  socketSubscriptions.set(socket, []);
  socket.send(
    JSON.stringify({
      type: "hello",
      serverTime: new Date().toISOString(),
      sites: ingestService.getConfiguredSites()
    })
  );

  const unsubscribe = ingestService.subscribe((manifest) => {
    const subscriptions = socketSubscriptions.get(socket) ?? [];

    if (
      socket.readyState === socket.OPEN &&
      (subscriptions.length === 0 ||
        subscriptions.some((subscription) => updateMatchesSubscription(manifest, subscription)))
    ) {
      socket.send(JSON.stringify({ type: "radar-frame", payload: manifest.frame }));
      socket.send(JSON.stringify({ type: "radar-radials", payload: manifest }));
      socket.send(
        JSON.stringify({
          type: "radar-patch",
          payload: {
            type: "radial_batch",
            stationId: manifest.stationId,
            product: manifest.product,
            tilt: manifest.tilt,
            sequence: manifest.sequence,
            frame: manifest.frame,
            radials: manifest.radials
          }
        })
      );
    }
  });

  socket.on("message", (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());

      if (message.type === "subscribe_radar") {
        const subscription = subscriptionFromRadarMessage(message);
        socketSubscriptions.set(socket, [subscription]);
        refreshRequestedSites();
        socket.send(
          JSON.stringify({
            type: "subscribed_radar",
            stationId: subscription.stationId,
            product: subscription.product,
            tilt: subscription.tilt,
            sequence: ingestService.getRadarSequence(
              subscription.stationId,
              subscription.product,
              subscription.tilt
            )
          })
        );
        void ingestService.refreshSite(subscription.stationId);
        return;
      }

      if (message.type !== "subscribe" || typeof message.sourceId !== "string") {
        return;
      }

      const subscription = subscriptionFromSourceId(message.sourceId);
      const site = subscription.stationId;
      socketSubscriptions.set(socket, [subscription]);
      refreshRequestedSites();
      socket.send(JSON.stringify({ type: "subscribed", sourceId: message.sourceId }));
      const latestManifest = ingestService.getLatestManifest(message.sourceId);
      const latestSweepState = ingestService.getLatestSweepState(message.sourceId);

      if (latestManifest && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "radar-frame", payload: latestManifest }));
      }

      if (latestSweepState && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "radar-bootstrap", payload: latestSweepState }));
      }

      void ingestService.refreshSite(site);
    } catch {
      // Ignore malformed control messages.
    }
  });

  socket.on("close", () => {
    socketSubscriptions.delete(socket);
    refreshRequestedSites();
    unsubscribe();
  });
});

server.listen(port, () => {
  ingestService.start();
  console.log(`Radar server listening on http://localhost:${port}`);
});
