# Low-Latency Radar Architecture

## Goals

- Support single-site radar as the fastest and most accurate live product.
- Support MRMS as a slower mosaic lane.
- Support RapidSweep-style playback using partial sweeps, not only completed volumes.
- Minimize end-to-end latency from upstream scan completion to browser paint.

## Core recommendation

Do not build the first version around pre-rendered static image loops pulled on a timer. That architecture is simpler, but it locks in avoidable latency and makes RapidSweep-style playback much harder.

Instead, use a split pipeline:

1. Single-site live lane
2. MRMS mosaic lane
3. Client playback lane

## Pipeline design

### 1. Single-site live lane

For the lowest latency possible:

- Ingest NOAA Level II data directly.
- Decode individual messages as they arrive.
- Publish per-elevation partial sweeps.
- Build the smallest renderable output possible:
  - direct polar rendering client-side, or
  - low-overhead raster tiles for the current sweep
- Push frame metadata immediately over WebSocket.

Recommended frame manifest fields:

- `source_id`
- `product`
- `elevation`
- `scan_time`
- `publish_time`
- `frame_id`
- `completion_ratio`
- `tile_urls` or `polar_chunk_urls`

### 2. MRMS mosaic lane

MRMS is valuable, but it is usually slower upstream. Keep it separate.

- Pull MRMS products independently.
- Do not block single-site playback waiting for MRMS updates.
- Render MRMS as a contextual underlay or alternate product layer.
- Allow the client to show the age of MRMS explicitly.

### 3. Client playback lane

RapidSweep-style playback should be driven by frame availability, not a fixed archive loop.

- Maintain a ring buffer of recent frames.
- Allow partial frames into the buffer.
- Advance playback at a short cadence, around 200-300 ms for live mode.
- Prefer timestamped manifests over guessing frame order from filenames.
- Keep separate buffers per source and product.

## Latency budget

Target budget for a strong single-site live path:

- Upstream availability: 2-3 s
- Decode and product extraction: 1-2 s
- Tile or chunk generation: under 1 s
- Distribution to client: under 500 ms
- Browser compositing: under 500 ms

This yields a practical target of about 4-6 seconds total.

## Data model

Track these timestamps on every frame:

- `scan_time`
- `ingest_time`
- `decode_complete_time`
- `publish_time`
- `client_receive_time`
- `client_render_time`

From those, compute:

- ingest delay
- processing delay
- network delay
- render delay
- total end-to-end delay

## Rendering choices

### Best latency

Client-side rendering from polar or lightly processed sweep chunks.

Pros:

- Lowest server-side work
- Fastest publish path
- Best fit for partial sweep updates

Cons:

- More complex frontend rendering
- Heavier client GPU usage

### Best implementation speed

Server-side generation of lightweight raster tiles for each new frame.

Pros:

- Easier browser integration
- Easier layer compositing and caching

Cons:

- Extra processing delay
- More server cost

## Recommended first build

Phase 1:

- React frontend
- MapLibre map
- WebSocket frame manifest stream
- Server-generated tiles for single-site radar
- MRMS underlay as a separate layer
- Ring buffer and RapidSweep-style playback controller
- Full latency instrumentation

Phase 2:

- Partial sweep publishing
- Dual-pane compare mode
- Velocity and correlation coefficient products
- Alert overlays and storm tracks

Phase 3:

- Experiment with client-side polar rendering
- Regional edge fanout
- Smarter prefetch and predictive buffering

## Accuracy notes

If "accuracy" means the freshest possible view of what the radar just scanned, the largest gains come from:

- direct Level II ingest
- partial sweep publishing
- avoiding polling loops
- keeping MRMS off the live critical path
- measuring real latency instead of assuming it
