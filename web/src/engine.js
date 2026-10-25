import { FilesetResolver, PoseLandmarker, HandLandmarker } from '../vendor/vision_bundle.mjs';
import { analyzeFrame, IDS, distance } from './domain.js';

function lab([r, g, b]) {
  const linear = c => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const [R, G, B] = [r, g, b].map(linear);
  const f = v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), y = f(R * 0.2126 + G * 0.7152 + B * 0.0722), z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export class MediaPipeEngine {
  id = 'mediapipe-bundled-1';
  constructor(rules) {
    this.rules = rules;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.small = document.createElement('canvas'); this.small.width = 64; this.small.height = 36;
    this.smallCtx = this.small.getContext('2d', { willReadFrequently: true });
  }
  async init(delegate = 'AUTO') {
    const runtime = await FilesetResolver.forVisionTasks('/vendor/wasm');
    const create = async (Cls, path, extra) => {
      const delegates = delegate === 'AUTO' ? ['GPU', 'CPU'] : [delegate];
      let error;
      for (const selected of delegates) {
        try {
          const model = await Cls.createFromOptions(runtime, { baseOptions: { modelAssetPath: path, delegate: selected }, runningMode: 'IMAGE', ...extra });
          return { model, delegate: selected };
        } catch (e) { error = e; }
      }
      throw error;
    };
    try {
      this.pose = await create(PoseLandmarker, '/models/pose_landmarker_full.task', { numPoses: 2 });
      this.hand = await create(HandLandmarker, '/models/hand_landmarker.task', { numHands: 2, minHandDetectionConfidence: 0.5 });
    } catch (e) { this.close(); throw e; }
    return { engine: this.id, pose: this.pose.delegate, hand: this.hand.delegate };
  }
  analyze(source, options = {}) {
    const start = performance.now();
    const width = source.videoWidth || source.naturalWidth || source.width;
    const height = source.videoHeight || source.naturalHeight || source.height;
    if (!width || !height) throw new Error('图片或视频帧尚未解码');
    const scale = Math.min(1, 960 / Math.max(width, height));
    this.canvas.width = Math.round(width * scale); this.canvas.height = Math.round(height * scale);
    this.ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    const point = p => ({ x: p.x * this.canvas.width, y: p.y * this.canvas.height, nx: p.x, ny: p.y, v: p.visibility ?? 1 });
    const poseResult = this.pose.model.detect(this.canvas);
    const handResult = this.hand.model.detect(this.canvas);
    const poses = poseResult.landmarks.map(list => list.map(point));
    const handedness = handResult.handedness || handResult.handednesses || [];
    const hands = handResult.landmarks.map((list, i) => ({ points: list.map(point), side: handedness[i]?.[0]?.categoryName || 'Unknown', score: handedness[i]?.[0]?.score ?? 0 }));
    this.smallCtx.drawImage(this.canvas, 0, 0, 64, 36);
    const pixels = this.smallCtx.getImageData(0, 0, 64, 36).data;
    let brightness = 0;
    for (let i = 0; i < pixels.length; i += 4) brightness += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    brightness /= pixels.length / 4;
    const nails = options.nails ? hands.map(h => this.nails(h.points)) : [];
    const analyzed = analyzeFrame({ poses, hands, brightness, nails }, this.rules, options);
    return { ...analyzed, poses, hands, latency_ms: Math.round(performance.now() - start) };
  }
  color(x, y, radius) {
    const x0 = Math.max(0, Math.min(this.canvas.width - 1, Math.round(x - radius)));
    const y0 = Math.max(0, Math.min(this.canvas.height - 1, Math.round(y - radius)));
    const w = Math.max(1, Math.min(this.canvas.width - x0, Math.round(radius * 2)));
    const h = Math.max(1, Math.min(this.canvas.height - y0, Math.round(radius * 2)));
    const data = this.ctx.getImageData(x0, y0, w, h).data;
    const total = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) total[c] += data[i + c];
    return lab(total.map(c => c / (data.length / 4)));
  }
  nails(points) {
    const palm = distance(points[0], points[9]);
    const skin = this.color((points[0].x + points[5].x + points[17].x) / 3, (points[0].y + points[5].y + points[17].y) / 3, Math.max(4, palm * 0.08));
    return IDS.map((ids, i) => {
      const tip = points[ids[3]], dip = points[ids[2]];
      const color = this.color(tip.x + 0.3 * (dip.x - tip.x), tip.y + 0.3 * (dip.y - tip.y), Math.max(3, distance(tip, dip) * 0.18));
      return { finger: i, deltaE: Math.round(Math.hypot(...color.map((c, j) => c - skin[j]))) };
    });
  }
  snapshot() { return this.canvas.toDataURL('image/jpeg', 0.8); }
  draw(target, frame) {
    target.width = this.canvas.width; target.height = this.canvas.height;
    const ctx = target.getContext('2d'); ctx.drawImage(this.canvas, 0, 0);
    ctx.strokeStyle = '#53ead0'; ctx.fillStyle = '#ffc778'; ctx.lineWidth = 2;
    const draw = (points, edges) => {
      for (const [a, b] of edges) { ctx.beginPath(); ctx.moveTo(points[a].x, points[a].y); ctx.lineTo(points[b].x, points[b].y); ctx.stroke(); }
      for (const p of points) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
    };
    for (const p of frame.poses) draw(p, [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]]);
    for (const h of frame.hands) draw(h.points, IDS.flatMap(ids => [[0, ids[0]], ...ids.slice(1).map((id, i) => [ids[i], id])]));
  }
  close() { this.pose?.model.close(); this.hand?.model.close(); this.pose = null; this.hand = null; }
}

// Replacement point: new adapters implement init(), analyze(), draw(), snapshot(), close().
export const engines = { mediapipe: rules => new MediaPipeEngine(rules) };
