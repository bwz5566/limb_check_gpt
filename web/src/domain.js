// Pure domain functions. No DOM/model dependency: shared by live, replay and tests.
export const CHECKS = { limbs: '四肢', fingers: '手指', nails: '美甲', tattoo: '纹身', scar: '疤痕', hair: '发色' };
export const STATUS = { clear: '未见规则疑点', flag: '发现疑点', uncertain: '无法判断 / 需复核', not_assessed: '未评估' };
export const FINGERS = ['拇指', '食指', '中指', '无名指', '小指'];
export const IDS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
export const BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const round = n => Math.round(n * 100) / 100;
export function angle(a, b, c) {
  const den = distance(a, b) * distance(c, b);
  if (den < 1e-6) return 0;
  return Math.acos(Math.max(-1, Math.min(1, ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) / den))) * 180 / Math.PI;
}
export const finding = (status, reason, metrics = {}) => ({ status, reason, metrics });
export const emptyChecks = () => Object.fromEntries(Object.keys(CHECKS).map(k => [k, finding('not_assessed', '本次未评估')]));
export function defaultEvidenceIndices(evidence) {
  const selected = [];
  for (const keyword of ['手背', '掌心', '站立']) {
    const index = evidence.findIndex(e => e.label.includes(keyword));
    if (index >= 0 && !selected.includes(index)) selected.push(index);
  }
  evidence.forEach((_, i) => { if (selected.length < 3 && !selected.includes(i)) selected.push(i); });
  return selected;
}
export const inFrame = p => p.nx > 0.015 && p.nx < 0.985 && p.ny > 0.015 && p.ny < 0.985;

export function fingerMetrics(points, rules) {
  const palm = distance(points[0], points[9]);
  const lengths = IDS.map(ids => ids.slice(1).reduce((sum, id, i) => sum + distance(points[ids[i]], points[id]), 0));
  const fingers = IDS.map((ids, i) => {
    const [a, b, , tip] = ids;
    const extended = i === 0
      ? angle(points[a], points[b], points[tip]) > 140 && distance(points[tip], points[5]) > 0.45 * palm
      : angle(points[a], points[b], points[tip]) > 145 && distance(points[0], points[tip]) > distance(points[0], points[b]) * 1.1;
    const ratio = lengths[i] / Math.max(lengths[2], 1e-6);
    return { name: FINGERS[i], ratio: round(ratio), extended, short: ratio < rules.fingerRef[i] * rules.fingerShortFactor };
  });
  const middleToPalm = lengths[2] / Math.max(palm, 1e-6);
  fingers[2].short = middleToPalm < rules.middleToPalmMin;
  return { palm, middleToPalm: round(middleToPalm), fingers, extended: fingers.filter(f => f.extended).length };
}

export function analyzeFrame({ poses, hands, brightness, nails = [] }, rules, options = {}) {
  const checks = emptyChecks();
  const detail = { hands: [], limbRatios: {}, poseCount: poses.length, handCount: hands.length, brightness: round(brightness) };
  const badLight = brightness < rules.minBrightness || brightness > rules.maxBrightness;
  if (badLight) {
    for (const key of ['limbs', 'fingers', ...(options.nails ? ['nails'] : [])]) checks[key] = finding('uncertain', '光照不符合阈值，请调整光线');
    return { checks, detail };
  }
  if (poses.length !== 1) {
    checks.limbs = finding('uncertain', poses.length ? '检测到多人，无法归属身体关键点' : '未检测到人体；不能据此判断肢体缺失');
  } else {
    const pose = poses[0];
    if (BODY.some(i => pose[i].v < rules.minVisibility || !inFrame(pose[i]))) {
      checks.limbs = finding('uncertain', '部分身体关节遮挡、出画或置信度不足');
    } else {
      const pairs = { 上臂: [11, 13, 12, 14], 前臂: [13, 15, 14, 16], 大腿: [23, 25, 24, 26], 小腿: [25, 27, 26, 28] };
      for (const [name, [a, b, c, d]] of Object.entries(pairs)) detail.limbRatios[name] = round(distance(pose[a], pose[b]) / Math.max(distance(pose[c], pose[d]), 1e-6));
      const flags = Object.entries(detail.limbRatios).filter(([, v]) => v < rules.limbSymmetry[0] || v > rules.limbSymmetry[1]).map(([k]) => k);
      checks.limbs = finding(flags.length ? 'flag' : 'clear', flags.length ? `${flags.join('、')}二维长度比例异常，需排除透视和姿态影响` : '可见关键点与左右长度比例未触发规则；不能证明肢体完整', detail.limbRatios);
    }
  }
  detail.hands = hands.map(h => ({ side: h.side, score: h.score, ...fingerMetrics(h.points, rules) }));
  const invalidHands = poses.length > 1 || hands.length !== 2 || hands.some(h => h.score < rules.minHandScore || h.points.some(p => !inFrame(p)) || distance(h.points[0], h.points[9]) < rules.minHandPixels);
  if (invalidHands) {
    checks.fingers = finding('uncertain', '需要单人、双手完整清晰入框；手部未检出不等于缺失');
  } else {
    const flags = detail.hands.flatMap((h, i) => h.fingers.filter(f => f.short).map(f => `手${i + 1}${f.name}`));
    const folded = detail.hands.some(h => h.extended !== 5);
    checks.fingers = flags.length && !folded
      ? finding('flag', `${flags.join('、')}长度比例触发阈值，需人工查看证据`)
      : folded ? finding('uncertain', '手指弯曲或遮挡，不能据此判断缺失；请张开后重拍')
        : finding('clear', '张手关键点比例未触发规则；关键点模型可能补全不存在的手指');
  }
  if (options.nails) {
    const values = nails.flat();
    if (invalidHands || detail.hands.some(h => h.extended !== 5) || values.length !== 10) {
      checks.nails = finding('uncertain', '美甲色差需要双手手背朝前、手指张开且指甲清晰可见');
    } else {
      const flags = values.filter(n => n.deltaE > rules.nailDeltaE);
      checks.nails = finding(flags.length ? 'flag' : 'clear', flags.length ? `${flags.length} 个指甲区域色差超阈值；阴影和肤色差异也会触发` : '色差未触发阈值；透明和裸色甲可能漏检', { nails });
    }
  }
  return { checks, detail };
}

export function aggregate(frames) {
  const checks = emptyChecks();
  for (const key of Object.keys(CHECKS)) {
    const relevant = frames.map(f => f.checks[key]).filter(f => f.status !== 'not_assessed');
    if (!relevant.length) continue;
    const flags = relevant.filter(f => f.status === 'flag');
    const clear = relevant.filter(f => f.status === 'clear');
    const coverage = (flags.length + clear.length) / relevant.length;
    if (flags.length) checks[key] = finding('flag', `${flags.length}/${relevant.length} 个评估帧触发疑点，需人工复核：${flags[0].reason}`, { evaluated: relevant.length, flags: flags.length, coverage });
    else if (coverage < 0.8) checks[key] = finding('uncertain', `可判断帧占比 ${Math.round(coverage * 100)}%，低于 80%，不能以局部正常代替整体结果`, { evaluated: relevant.length, coverage });
    else checks[key] = finding('clear', `${clear.length}/${relevant.length} 个评估帧未触发规则；请结合动作完成度与证据`, { evaluated: relevant.length, coverage });
  }
  return checks;
}

export function arbitrate(local, review) {
  const output = structuredClone(local);
  for (const [key, remote] of Object.entries(review.checks)) {
    if (!(key in CHECKS)) continue;
    const current = local[key];
    if (current.status === 'not_assessed') output[key] = { ...remote, reason: `仅视觉模型观察，未经本场景效果评测：${remote.reason}`, source: 'vlm' };
    else if (remote.status === current.status && ['clear', 'flag'].includes(remote.status)) output[key] = { ...current, reason: `${current.reason}；模型状态一致，仅作第二意见`, source: 'agreement' };
    else output[key] = finding('uncertain', `本地=${current.status}，模型=${remote.status}；存在分歧或无法判断，需人工复核`);
  }
  return output;
}

export function makeReport(frames, options) {
  return { schema_version: '1.0', run_id: crypto.randomUUID(), created_at: new Date().toISOString(),
    source: options.source, sample_name: options.name, engine: options.engine, rule_version: options.rules.version,
    rules: structuredClone(options.rules), synthetic: options.source === 'synthetic',
    checks: aggregate(frames), frames: frames.map(({ checks, detail, latency_ms, time_seconds }) => ({ checks, detail, latency_ms, time_seconds })),
    latency_ms: frames.length ? round(frames.reduce((s, f) => s + f.latency_ms, 0) / frames.length) : 0,
    evidence: options.evidence || [], steps: options.steps || [], effect_validated: false,
    limitations: ['关键点和二维规则不能确认真实肢体完整性', '未建立真实场景准确率', '外观项仅记录', '所有结果由人工确认'] };
}
