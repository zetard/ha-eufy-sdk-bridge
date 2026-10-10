// /clip/<sn>: the recording a HomeBase 2 stored for a camera's latest detection, as an mp4. The push names
// the recording (`payload.p`) and its key (`cipher`); the SDK's `downloadRecording` fetches it over the
// station's P2P session without waking the camera, and the bundled ffmpeg muxes the elementary streams
// it returns (no re-encode). One file per camera holds the latest clip, so nothing needs pruning.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mux Annex-B H.264 (+ ADTS AAC when present) into `out` with ffmpeg, stream copy only. */
export async function muxMp4({ video, audio, fps }, out) {
  const inputs = [`${out}.h264`, `${out}.aac`];
  await fs.promises.writeFile(inputs[0], video);
  if (audio?.length) await fs.promises.writeFile(inputs[1], audio);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-fflags", "+genpts"];
  if (fps > 0) args.push("-framerate", String(fps));
  args.push("-f", "h264", "-i", inputs[0]);
  if (audio?.length) args.push("-f", "aac", "-i", inputs[1], "-map", "0:v", "-map", "1:a");
  args.push("-c", "copy", "-movflags", "+faststart", "-f", "mp4", out);
  try {
    await new Promise((resolve, reject) =>
      execFile("ffmpeg", args, { timeout: 60_000 }, (e, _out, err) => {
        if (!e) return resolve();
        const detail = String(err || e.message).trim();
        reject(new Error(`ffmpeg: ${detail.slice(-200)}`));
      }),
    );
  } catch (e) {
    await fs.promises.rm(out, { force: true }); // no half-written file left behind
    throw e;
  } finally {
    for (const f of inputs) await fs.promises.rm(f, { force: true });
  }
}

export function createClips(ctx) {
  const { cfg, eufy, eventImageDir } = ctx;
  const mux = ctx.muxClip ?? muxMp4;
  const log = (...a) => ctx.eventLog?.(...a);
  const latest = new Map(); // sn -> latest indexed event
  const historyFile = path.join(eventImageDir, "recording-history.json");
  const history = new Map(); // sn -> newest-first entries containing sensitive cipherId
  const MAX_PER_CAMERA = 50;
  const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
  // The mounted data directory survives bridge restarts. Keep encryption references private:
  // never expose cipherId in HTTP responses, logs, or a source-controlled file.
  try {
    const saved = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    if (saved?.version === 1 && Array.isArray(saved.cameras)) {
      for (const camera of saved.cameras) {
        if (!validId(camera.sn) || !Array.isArray(camera.events)) continue;
        const events = camera.events.filter((e) =>
          validId(e.recording) && Number.isFinite(e.at) && e.cipherId !== undefined
        ).slice(0, MAX_PER_CAMERA);
        if (events.length) {
          history.set(camera.sn, events);
          latest.set(camera.sn, events[0]);
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") log(`recording history load failed: ${error.message}`);
  }
  function persist() {
    fs.mkdirSync(eventImageDir, { recursive: true });
    const tmp = historyFile + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        cameras: [...history].map(([sn, events]) => ({ sn, events })),
      }), { mode: 0o600 });
      fs.renameSync(tmp, historyFile);
    } catch (error) {
      log(`recording history save failed: ${error.message}`);
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }
  function listRecordings(sn) {
    if (!validId(sn)) return null;
    return (history.get(sn) ?? []).map(({ recording, at }) => ({ id: recording, detectedAt: new Date(at).toISOString() }));
  }
  const made = new Map(); // file -> recording stored there
  const builds = new Map(); // file -> { recording, done } for the build in progress

  /** `push` listener: remember the recording a detection named. */
  function noteRecording(ev) {
    const recording = ev?.payload?.p;
    if (!validId(ev?.deviceSn) || !validId(recording) || ev.cipher === undefined) return;
    const events = history.get(ev.deviceSn) ?? [];
    if (events.some((entry) => entry.recording === recording)) return; // repeated notification
    const entry = { recording, cipherId: ev.cipher, at: Date.now() };
    events.unshift(entry);
    events.length = Math.min(events.length, MAX_PER_CAMERA);
    history.set(ev.deviceSn, events);
    latest.set(ev.deviceSn, entry);
    persist();
  }

  async function build(sn, cam, { recording, cipherId, at }, file) {
    // The station is still writing the recording right after the push; how it answers then is not
    // established, so wait until the clip length has elapsed.
    const wait = at + cfg.clipSettleMs - Date.now();
    if (wait > 0) await sleep(wait);
    const clip = await cam.downloadRecording({ recording, cipherId });
    const tmp = `${file}.tmp`;
    await mux(clip, tmp);
    await fs.promises.rename(tmp, file);
    made.set(file, recording);
    log(
      `/clip ${sn} → recording ${recording}: ${clip.frames} frames, ${clip.missingFrames} missing, ` +
        `${clip.durationMs} ms${clip.audio?.length ? ", with audio" : ""}`,
    );
    return fs.promises.readFile(file);
  }

  /** The latest detection's clip for `sn`: `{ mp4 }`, or `{ status, error, reason? }`. */
  async function clipFor(sn, recordingId) {
    let cam;
    try {
      cam = (await eufy.getDevice(sn)).camera?.();
    } catch (e) {
      return { status: 404, error: String(e?.message ?? e) };
    }
    if (typeof cam?.downloadRecording !== "function")
      return { status: 404, error: "no stored recordings on this device" };
    if (!validId(sn) || (recordingId !== undefined && !validId(recordingId)))
      return { status: 400, error: "invalid recording request" };
    const last = recordingId === undefined
      ? latest.get(sn)
      : history.get(sn)?.find((entry) => entry.recording === recordingId);
    if (!last) return { status: recordingId === undefined ? 409 : 404, error: "recording not indexed" };
    const file = recordingId === undefined
      ? path.join(eventImageDir, `last-clip-${sn}.mp4`)
      : path.join(eventImageDir, `indexed-clip-${sn}-${recordingId}.mp4`);
    if (made.get(file) === last.recording) {
      try {
        return { mp4: await fs.promises.readFile(file) };
      } catch {
        made.delete(file); // gone from disk: build it again
      }
    }
    // One build per camera at a time: callers asking for the same recording share it, and a newer
    // recording waits for the one in progress so the file ends up holding the newer clip.
    let current = builds.get(file);
    if (current?.recording !== last.recording) {
      const previous = current?.done.catch(() => {}) ?? Promise.resolve();
      const entry = { recording: last.recording };
      entry.done = previous.then(() => build(sn, cam, last, file));
      entry.done.finally(() => builds.get(file) === entry && builds.delete(file)).catch(() => {});
      builds.set(file, (current = entry));
    }
    try {
      return { mp4: await current.done };
    } catch (e) {
      log(`/clip ${sn} → recording ${last.recording} failed: ${e?.message ?? e}`);
      return e?.reason
        ? { status: 502, error: String(e.message), reason: e.reason }
        : { status: 500, error: String(e?.message ?? e) };
    }
  }

  return { noteRecording, clipFor, listRecordings };
}
