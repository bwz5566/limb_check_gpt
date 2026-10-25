import { angle, distance, BODY, inFrame } from './domain.js';

export const PROFILES = {
  upper: { name: '上肢与手部', steps: ['stand', 'arms', 'overhead', 'palms', 'backs', 'fist', 'open', 'challenge'] },
  full: { name: '全身与手部', steps: ['stand', 'arms', 'overhead', 'left_leg', 'right_leg', 'squat', 'rise', 'palms', 'backs', 'fist', 'open', 'challenge'] },
  hands: { name: '手部专项', steps: ['palms', 'backs', 'fist', 'open', 'challenge'] },
};
export const TITLES = { stand: '正面站立，全身入框', arms: '双臂侧平举并伸直', overhead: '双臂上举过头', left_leg: '抬起左腿', right_leg: '抬起右腿', squat: '缓慢下蹲', rise: '恢复站立', palms: '掌心朝前，双手五指张开', backs: '翻转为手背朝前，五指张开', fist: '双手握拳', open: '再次张开双手', challenge: '随机手势挑战' };
export const isHandStep = id => ['palms', 'backs', 'fist', 'open', 'challenge'].includes(id);
const orientation = p => Math.sign((p[5].x - p[0].x) * (p[17].y - p[0].y) - (p[5].y - p[0].y) * (p[17].x - p[0].x));

export class Workflow {
  constructor(profile, rules, now = performance.now()) {
    this.rules = rules; this.steps = PROFILES[profile].steps; this.index = 0; this.started = now; this.holdStart = null;
    this.results = []; this.baseline = null; this.palms = null;
    const random = new Uint32Array(1); crypto.getRandomValues(random); this.target = 1 + random[0] % 4;
  }
  get id() { return this.steps[this.index]; }
  get done() { return this.index >= this.steps.length; }
  get title() { return this.id === 'challenge' ? `任意一只手伸出 ${this.target} 根手指（本地动作挑战）` : TITLES[this.id]; }
  check(frame) {
    if (frame.detail.brightness < this.rules.minBrightness || frame.detail.brightness > this.rules.maxBrightness) return '请调整光照';
    if (frame.poses.length > 1) return '画面只能有一人';
    if (isHandStep(this.id)) {
      const hands = frame.hands;
      if (hands.length !== 2 || hands.some(h => h.score < this.rules.minHandScore || h.points.some(p => !inFrame(p)) || distance(h.points[0], h.points[9]) < this.rules.minHandPixels)) return '请让双手完整清晰入框并靠近镜头';
      const counts = frame.detail.hands.map(h => h.extended);
      if (this.id === 'challenge') return counts.includes(this.target) ? null : `请伸出 ${this.target} 根手指`;
      if (this.id === 'fist') return counts.every(n => n <= 1) ? null : '请握拳';
      if (counts.some(n => n !== 5)) return '请张开五指';
      if (this.id === 'backs') {
        if (!this.palms) return '缺少掌心基准，请跳过并在报告中复核';
        // Use tracked handedness when unique; do not assign anatomy by screen x.
        if (new Set(hands.map(h => h.side)).size !== 2) return '左右手识别不稳定，请分开双手';
        if (hands.some(h => !this.palms[h.side] || this.palms[h.side] === orientation(h.points))) return '请将双手翻转为手背朝前';
      }
      return null;
    }
    if (frame.poses.length !== 1) return '请全身入框';
    const p = frame.poses[0];
    if (BODY.some(i => p[i].v < this.rules.minVisibility || !inFrame(p[i]))) return '身体关节需清晰完整入框';
    const torso = (distance(p[11], p[23]) + distance(p[12], p[24])) / 2;
    if (this.id === 'stand') return p[15].y > p[13].y && p[16].y > p[14].y ? null : '双臂自然下垂';
    if (this.id === 'arms' || this.id === 'overhead') {
      for (const [s, e, w] of [[11, 13, 15], [12, 14, 16]]) {
        if (angle(p[s], p[e], p[w]) < 150) return '请伸直手臂';
        if (this.id === 'arms' && Math.abs(p[w].y - p[s].y) > 0.3 * torso) return '手腕抬至与肩同高';
        if (this.id === 'overhead' && p[w].y >= p[0].y) return '双手举过头顶';
      }
      return null;
    }
    if (this.id.endsWith('_leg')) {
      const [h, k] = this.id === 'left_leg' ? [23, 25] : [24, 26];
      return (p[k].y - p[h].y) / Math.max(distance(p[h], p[k]), 1e-6) < 0.5 ? null : '膝盖再抬高一些';
    }
    if (!this.baseline) return '缺少站立基准，请跳过并复核';
    const depth = ((p[23].y + p[24].y) / 2 - this.baseline.hipY) / this.baseline.leg;
    return this.id === 'squat' ? (depth > 0.25 ? null : '在舒适范围内缓慢下蹲，也可跳过') : (depth < 0.08 ? null : '请恢复站立');
  }
  update(frame, now) {
    const hint = this.check(frame);
    this.holdStart = hint ? null : (this.holdStart ?? now);
    const progress = this.holdStart === null ? 0 : Math.min(1, (now - this.holdStart) / this.rules.holdMs);
    if (progress === 1) return this.complete('completed', frame, now);
    if (now - this.started > (this.id === 'challenge' ? 10000 : this.rules.stepTimeoutMs)) return this.complete('timeout', frame, now);
    return { hint: hint || '保持动作…', progress };
  }
  complete(status, frame, now) {
    const result = { id: this.id, title: this.title, status, duration_ms: Math.round(now - this.started) };
    if (status === 'completed' && frame) {
      if (this.id === 'stand') { const p = frame.poses[0]; this.baseline = { hipY: (p[23].y + p[24].y) / 2, leg: Math.max(1, distance(p[23], p[27])) }; }
      if (this.id === 'palms') this.palms = Object.fromEntries(frame.hands.map(h => [h.side, orientation(h.points)]));
    }
    this.results.push(result); this.index++; this.started = now; this.holdStart = null;
    return { completed: result, progress: 0, hint: '' };
  }
}
