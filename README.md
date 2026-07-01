# Weather Radar

Starter project for a low-latency weather radar web app focused on:

- Single-site radar ingest and playback
- MRMS mosaic/context products
- RapidSweep-style partial sweep animation
- Tight end-to-end latency measurement

## Product direction

The fastest path to an accurate live radar experience is to treat radar as a streaming system, not a batch map tile app.

- Single-site radar should be the primary live lane.
- MRMS should be a secondary asynchronous lane for context and gap fill.
- Partial sweeps should publish immediately after each elevation, without waiting for a full volume.
- Latency should be measured from `scan_time` to `client_render_time` for every frame.

## Suggested stack

- Frontend: React + TypeScript + Vite
- Map renderer: MapLibre GL JS or deck.gl raster layers
- Stream transport: WebSocket or WebTransport for frame metadata
- Edge cache: Cloudflare, Fastly, or regional reverse proxies
- Radar processing service: JVM or Rust service for Level II decode and tile generation
- Storage:
  - Hot path: in-memory frame ring buffer and object storage for current tiles
  - Warm path: short-retention archive for replay and compare

## Latency targets

- Single-site direct Level II: under 6 seconds scan-to-screen
- Velocity products: under 7 seconds
- MRMS: as low as upstream allows, usually much slower than single-site

## Development

```bash
npm install
npm run dev
```

## Live Level II path

Start the local ingest server in a second terminal:

```bash
npm run server
```

Optional environment variables:

- `RADAR_SITES=KDMX,KTLX` to choose sites
- `RADAR_POLL_MS=15000` to control feed polling
- `RADAR_SERVER_PORT=8787` to change the WebSocket server port
- `VITE_RADAR_WS_URL=ws://localhost:8787/ws` to point the frontend at a different ingest host

What is implemented now:

- polls the official `unidata-nexrad-level2-chunks` bucket first
- falls back to `noaa-nexrad-level2` archive objects if no chunk objects are found
- decodes Level II server-side
- streams reflectivity sweep manifests over WebSocket
- renders those gates in the existing browser canvas overlay

Current limitation:

- chunk bucket layouts vary, so the chunk prefix search is best-effort
- the stream currently publishes reflectivity only
- true production latency will require persistent chunk grouping, station-specific tuning, and likely a more efficient transport than polling public S3 listings

## Next implementation priorities

1. Add a real map canvas and radar layer compositing.
2. Implement a backend ingest service for Level II and MRMS feeds.
3. Publish partial sweep manifests over WebSocket.
4. Add a ring buffer for recent frames and a scrubber UI for loop control.
5. Instrument scan time, ingest time, publish time, and render time.
