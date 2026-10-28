// Sound-only search for fillers / stutters / retakes (src/audiologic.js) off the main thread.
import { scanSound } from './audiologic.js';

self.onmessage = e => {
  const { id, samples } = e.data;
  try { self.postMessage({ id, cands: scanSound(samples) }); }
  catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
