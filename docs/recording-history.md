# Indexed event recordings (experimental)

The bridge's existing `GET /clip/<camera-serial>` continues to serve the latest pushed recording.

For detections received **while this bridge runs**, the push provides a recording
identifier and cipher reference. The bridge persists up to **50 references per camera**
under the mounted data directory as `recording-history.json` (private permissions on
creation) so they survive restarts.

New endpoints:

- `GET /recordings/<camera-serial>` lists newest-first `{id, detectedAt}` values
  associated with this camera, without exposing cipher references.
- `GET /recordings/<camera-serial>/<recording-id>` downloads the matching MP4
  from HomeBase and caches it locally for further requests.

The recording ID must have arrived in a push from **that camera**. Requests cannot
choose an arbitrary recording or provide a cipher reference. If HomeBase has removed
the requested recording, downloading it may fail. Records received before the bridge
started cannot be discovered from this index. A separate SDK history-listing feature
would be necessary for that.

## Operational cautions

- This is an **experimental development-branch feature**, not active in the installed
  Home Assistant add-on until a build based on this fork is deployed.
- As with the existing live stream and `/clip` API, these HTTP routes have **no
  separate authentication**. Do not expose the bridge port to the internet. In
  particular, historical clips are more sensitive than a single live snapshot.
  Restrict the bridge to trusted networks or add API authentication before general
  deployment.
- The index contains sensitive recording decryption references. Treat
  `recording-history.json` and the MP4 cache as private data, keep them out of
  source control and backups shared outside the household.
- The index is a bounded set of observed event references, **not a browseable
  HomeBase library**. It doesn't guarantee events can be replayed indefinitely.
- To verify on an isolated test instance: trigger two separate detections, call
  the index endpoint and then fetch both identifiers. Check they produce distinct
  correct recordings. Restart the bridge and repeat. Verify that the original
  `/clip/<camera-serial>` still returns the latest recording.
- Do not run a second Eufy bridge against the same account without understanding
  the SDK session/device-identity interaction; another bridge may steal push events.

## Tests

```sh
npm ci
npm run lint
npm test
for f in $(git ls-files '*.mjs'); do node --check "$f" || exit 1; done
```
