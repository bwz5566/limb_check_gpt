import { engines } from './engine.js';
import { CHECKS, STATUS, finding, makeReport, arbitrate, defaultEvidenceIndices } from './domain.js';
import { Workflow, PROFILES, TITLES, isHandStep } from './workflow.js';
import { deadline } from './async.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = value => `<span class="status ${escape(value)}">${escape(STATUS[value] || value)}</span>`;
const state = { config: null, engine: null, busy: false, camera: null, workflow: null, frames: [], evidence: [], report: null, reportId: null, batch: [], cancel: false, offset: 0 };
let lastSpeech = '';

function notice(message, error = false) { $('#notice').textContent = message; $('#notice').classList.toggle('error', error); }
function say(text) {
  if (!$('#voice').checked || !window.speechSynthesis || lastSpeech === text) return;
  lastSpeech = text; speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(text); speech.lang = 'zh-CN'; speechSynthesis.speak(speech);
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.config?.csrf_token || '', ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}
function bind(id, fn) { $(id).addEventListener('click', async () => { try { await fn(); } catch (e) { notice(e.message, true); } }); }
function controls() {
  $('#load-model').disabled = state.busy || Boolean(state.camera);
  $('#delegate').disabled = state.busy || Boolean(state.camera);
  $('#profile').disabled = Boolean(state.camera);
  $('#camera-start').disabled = !state.engine || state.busy || Boolean(state.camera) || !$('#camera-consent').checked;
  $('#analyze-files').disabled = !state.engine || state.busy || Boolean(state.camera);
  $('#synthetic-check').disabled = !state.engine || state.busy || Boolean(state.camera);
  $('#sample-files').disabled = state.busy || Boolean(state.camera);
  $('#nail-view').disabled = state.busy || Boolean(state.camera);
  $('#sample-synthetic').disabled = state.busy || Boolean(state.camera);
  $('#sample-cancel').disabled = !state.busy;
  $('#camera-stop').disabled = !state.camera;
  $('#camera-skip').disabled = !state.camera;
  $('#review-report').disabled = !state.config?.vlm.enabled || !state.report || state.busy || Boolean(state.camera);
  $('#save-report').disabled = !state.report || Boolean(state.reportId) || state.busy || Boolean(state.camera);
  $('#history-prev').disabled = state.offset === 0;
}
async function showTab(id) {
  document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== id; });
  document.querySelectorAll('nav button').forEach(el => el.classList.toggle('active', el.dataset.tab === id));
  if (id === 'history') await history();
  if (id === 'evaluation') await evaluation();
}
document.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => showTab(el.dataset.tab).catch(e => notice(e.message, true))));

async function loadModel() {
  if (state.busy || state.camera) return;
  state.busy = true; controls(); notice('正在加载本地模型和运行库，首次加载可能需要一些时间…');
  state.engine?.close(); state.engine = null;
  const engine = engines.mediapipe(state.config.rules);
  try {
    const info = await engine.init($('#delegate').value); state.engine = engine;
    $('#model-status').textContent = `人体 ${info.pose} · 手部 ${info.hand}`;
    notice('模型已就绪，可以开始检测或导入测试样本。');
  } catch (e) { engine.close(); $('#model-status').textContent = '模型加载失败'; throw new Error(`模型加载失败：${e.message}。可选择强制 CPU 重试，或运行 scripts/doctor.py 校验文件。`); }
  finally { state.busy = false; controls(); }
}

function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function checksTable(checks) {
  return `<table><thead><tr><th>检测项</th><th>观察结果</th><th>理由 / 局限</th></tr></thead><tbody>${Object.entries(CHECKS).map(([key, name]) => `<tr><td>${name}${['tattoo', 'scar', 'hair'].includes(key) ? '<br><small>仅记录 · 未评测</small>' : ''}</td><td>${badge(checks[key].status)}</td><td>${escape(checks[key].reason)}</td></tr>`).join('')}</tbody></table>`;
}
function showReport(report, identity = null, annotation = null) {
  state.report = report; state.reportId = identity;
  $('#report-panel').hidden = false; $('#report-title').textContent = report.sample_name;
  $('#save-consent').checked = false; $('#review-consent').checked = false;
  $('#save-state').textContent = identity ? `已保存：${identity}` : '尚未保存；刷新页面会丢失未保存报告';
  $('#report-content').innerHTML = `<p>${escape(report.created_at)} · ${escape(report.engine)} · ${escape(report.rule_version)} · ${report.frames.length} 帧 · 平均推理 ${report.latency_ms} ms${report.synthetic ? ' · 模拟自检（不计入效果统计）' : ''}</p>
    <div class="scroll">${checksTable(report.checks)}</div>
    ${report.steps?.length ? `<h3>动作流程</h3><div class="scroll"><table><tr><th>动作</th><th>完成情况</th><th>耗时</th></tr>${report.steps.map(s => `<tr><td>${escape(s.title)}</td><td>${escape({ completed: '已完成', timeout: '超时未完成', skipped: '已跳过', interrupted: '中断' }[s.status] || s.status)}</td><td>${(s.duration_ms / 1000).toFixed(1)} 秒</td></tr>`).join('')}</table></div>` : '<p class="small">样本分析不验证引导动作完成情况。</p>'}
    <h3>证据帧</h3><p class="small">可勾选最多 3 张用于可选模型复核。只会在授权并点击复核后发送。</p><div class="evidence">${report.evidence.map((e, i) => `<figure><img src="${e.image}" alt="${escape(e.label)}"><figcaption>${escape(e.label)}</figcaption><label class="check"><input type="checkbox" data-evidence="${i}" ${defaultEvidenceIndices(report.evidence).includes(i) ? 'checked' : ''}>用于模型复核</label></figure>`).join('') || '<p>未采集证据</p>'}</div>
    ${report.review ? `<details><summary>视觉模型输出与原始本地观察</summary><pre>${escape(JSON.stringify({ review: report.review, local_checks: report.local_checks }, null, 2))}</pre></details>` : ''}
    <details><summary>查看帧指标与阈值</summary><pre>${escape(JSON.stringify({ rules: report.rules, frames: report.frames }, null, 2))}</pre></details>
    <p class="small">${report.limitations.map(escape).join('；')}。真实缺失检出能力尚待授权样本验证。</p>`;
  $('#annotation-form').hidden = !identity;
  $('#annotation-labels').innerHTML = Object.entries(CHECKS).map(([key, label]) => `<label>${label}<select data-label="${key}"><option value="">未标注</option>${Object.entries(STATUS).map(([value, name]) => `<option value="${value}" ${annotation?.labels?.[key] === value ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select></label>`).join('');
  $('#reviewer').value = annotation?.reviewer || ''; $('#dataset').value = annotation?.dataset || '';
  $('#subject-id').value = annotation?.subject_id || ''; $('#annotation-note').value = annotation?.note || '';
  controls();
}

function maskFrame(frame, id) {
  const output = { ...frame, checks: structuredClone(frame.checks) };
  if (isHandStep(id)) output.checks.limbs = finding('not_assessed', '手部近景不评估全身');
  else { output.checks.fingers = finding('not_assessed', '全身远景不评估手指'); output.checks.nails = finding('not_assessed', '全身远景不评估美甲'); }
  if (['fist', 'challenge'].includes(id)) output.checks.fingers = finding('not_assessed', '握拳与随机手势只验证动作，不评估手指结构');
  return output;
}
function updateSteps() {
  const flow = state.workflow;
  $('#step-list').innerHTML = flow.steps.map((id, i) => `<li class="${i === flow.index ? 'current' : ''}">${escape(TITLES[id])}${flow.results[i] ? ` · ${{ completed: '完成', timeout: '超时', skipped: '跳过', interrupted: '中断' }[flow.results[i].status]}` : ''}</li>`).join('');
}
function completeStep(event, frame) {
  const id = event.completed.id;
  state.frames.push(maskFrame(frame, id));
  if (state.evidence.length < 6 && ['stand', 'arms', 'palms', 'backs', 'squat', 'open'].includes(id)) state.evidence.push({ label: event.completed.title, image: state.engine.snapshot() });
  updateSteps();
  if (state.workflow.done) stopCamera(false);
  else { $('#step-title').textContent = state.workflow.title; say(state.workflow.title); }
}
async function startCamera() {
  if (!state.engine || state.busy || state.camera || !$('#camera-consent').checked) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('摄像头不可用，请从本机 localhost 用 Chrome / Edge 打开');
  state.busy = true; controls();
  try {
    notice('正在请求摄像头权限并等待画面…');
    state.camera = await deadline(navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false }), 30000, '摄像头授权等待超时', stream => stream.getTracks().forEach(t => t.stop()));
    const video = $('#source-video'); video.srcObject = state.camera;
    await deadline(video.play(), 10000, '摄像头未产生视频画面');
    state.workflow = new Workflow($('#profile').value, state.config.rules); state.frames = []; state.evidence = []; lastSpeech = '';
    state.lastFrame = null;
    $('#step-title').textContent = state.workflow.title; updateSteps(); say(state.workflow.title);
    state.camera.getVideoTracks()[0].addEventListener('ended', () => { if (state.camera) { notice('摄像头已断开，本次采集已中断', true); stopCamera(true); } });
    notice('采集中。可随时跳过当前动作或结束采集。');
    let last = 0;
    const loop = now => {
      if (!state.camera) return;
      if (now - last < state.config.rules.inferenceIntervalMs) { requestAnimationFrame(loop); return; }
      last = now;
      try {
        const frame = state.engine.analyze(video, { nails: state.workflow.id === 'backs' });
        state.lastFrame = frame; state.engine.draw($('#live-canvas'), frame);
        $('#live-metrics').textContent = `人体 ${frame.detail.poseCount} · 手 ${frame.detail.handCount} · 推理 ${frame.latency_ms} ms · 亮度 ${frame.detail.brightness}`;
        const event = state.workflow.update(frame, performance.now());
        $('#hold').value = event.progress; $('#step-hint').textContent = event.hint;
        if (event.completed) completeStep(event, frame);
      } catch (e) { notice(`采集中断：${e.message}`, true); stopCamera(true); return; }
      if (state.camera) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } catch (e) {
    state.camera?.getTracks().forEach(t => t.stop()); state.camera = null;
    $('#source-video').pause(); $('#source-video').srcObject = null;
    throw new Error(`摄像头启动失败：${e.message}。检查浏览器和系统摄像头权限，或改用样本回放。`);
  } finally { state.busy = false; controls(); }
}
function stopCamera(interrupted = true) {
  if (!state.camera) return;
  state.camera.getTracks().forEach(t => t.stop()); state.camera = null; $('#source-video').srcObject = null;
  window.speechSynthesis?.cancel();
  const flow = state.workflow;
  if (interrupted) while (!flow.done) flow.complete('interrupted', null, performance.now());
  const report = makeReport(state.frames, { source: 'camera', name: `${PROFILES[$('#profile').value].name} ${new Date().toLocaleString('zh-CN')}`, engine: state.engine.id, rules: state.config.rules, evidence: state.evidence, steps: flow.results });
  for (const step of report.steps.filter(s => s.status !== 'completed')) {
    const key = isHandStep(step.id) ? 'fingers' : 'limbs';
    if (report.checks[key].status !== 'flag') report.checks[key] = finding('uncertain', '相关动作未全部完成，需重拍或人工复核');
    if (step.id === 'backs') report.checks.nails = finding('uncertain', '手背采集未完成，不能判断美甲');
  }
  $('#step-title').textContent = interrupted ? '采集已中断，结果见下方' : '采集完成，结果见下方';
  $('#step-hint').textContent = ''; $('#hold').value = 0; updateSteps(); showReport(report); controls();
  notice(interrupted ? '采集已结束，未完成动作已标记，报告见下方。' : '采集完成，报告见下方。请结合证据进行人工复核。');
}

function mediaEvent(element, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); element.removeEventListener(event, ok); element.removeEventListener('error', fail); };
    const ok = () => { clear(); resolve(); };
    const fail = () => { clear(); reject(new Error('文件解码失败，尝试 PNG/JPEG 或 H.264 MP4')); };
    const timer = setTimeout(() => { clear(); reject(new Error('媒体解码超时')); }, timeout);
    element.addEventListener(event, ok, { once: true }); element.addEventListener('error', fail, { once: true });
  });
}
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
async function analyzeFile(file, nails) {
  if (file.size > 250 * 1024 * 1024) throw new Error('单个文件限制为 250 MB');
  const url = URL.createObjectURL(file); const frames = [], evidence = [];
  const addFrame = (source, time = 0, capture = true) => {
    const frame = state.engine.analyze(source, { nails }); frame.time_seconds = time;
    frames.push(frame); state.engine.draw($('#sample-canvas'), frame);
    if (capture && evidence.length < 6) evidence.push({ label: `${file.name} @ ${time.toFixed(2)}s`, image: state.engine.snapshot() });
  };
  let video;
  try {
    if (file.type.startsWith('image/')) {
      const image = new Image(); const loaded = mediaEvent(image, 'load'); image.src = url; await loaded;
      if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('图片像素过大，请缩小至 4000 万像素以内');
      addFrame(image);
    } else if (file.type.startsWith('video/')) {
      video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.playsInline = true;
      const loaded = mediaEvent(video, 'loadeddata'); video.src = url; await loaded;
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('无法读取视频时长');
      const count = Math.min(state.config.rules.maxVideoFrames, Math.max(1, Math.ceil(video.duration / state.config.rules.videoSampleSeconds)));
      for (let i = 0; i < count; i++) {
        if (state.cancel) break;
        const time = count === 1 ? 0 : i * Math.max(0, video.duration - 0.05) / (count - 1);
        if (Math.abs(video.currentTime - time) > 0.001) { const seek = mediaEvent(video, 'seeked'); video.currentTime = time; await seek; }
        addFrame(video, time, i % Math.max(1, Math.ceil(count / 6)) === 0);
        $('#batch-progress').textContent = `${file.name}：抽帧 ${i + 1}/${count}（${time.toFixed(1)}s）`; await yieldUI();
      }
    } else throw new Error('不支持的文件类型');
    if (!frames.length) return null;
    const report = makeReport(frames, { source: file.type.startsWith('image/') ? 'image' : 'video', name: file.name, rules: state.config.rules, engine: state.engine.id, evidence });
    report.synthetic = $('#sample-synthetic').checked;
    report.sample_sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    report.sampling = { analyzed_frames: frames.length, cancelled: state.cancel, duration_seconds: video?.duration ?? null, max_frames: state.config.rules.maxVideoFrames };
    if (state.cancel) {
      for (const check of Object.values(report.checks)) if (check.status === 'clear') { check.status = 'uncertain'; check.reason = '分析被取消，只完成部分抽帧'; }
    }
    return report;
  } finally { if (video) { video.removeAttribute('src'); video.load(); } URL.revokeObjectURL(url); }
}
function batchList() {
  $('#batch-results').hidden = !state.batch.length;
  $('#batch-results').innerHTML = `<h3>本轮样本（${state.batch.length}）</h3><p class="small">逐条查看并保存，或先导出整批 JSON。未保存数据只存在当前页面中。</p><label class="check"><input type="checkbox" id="batch-consent">授权将本轮全部报告及证据保存到本机</label><div class="button-row"><button id="download-batch" class="secondary">导出本轮全部报告</button><button id="save-batch">保存本轮全部报告</button></div><ol>${state.batch.map((r, i) => `<li><button class="secondary" data-batch="${i}">${escape(r.sample_name)}</button></li>`).join('')}</ol>`;
  $('#batch-results').querySelectorAll('[data-batch]').forEach(el => el.addEventListener('click', () => { showReport(state.batch[Number(el.dataset.batch)]); $('#report-panel').scrollIntoView({ behavior: 'smooth' }); }));
  bind('#download-batch', () => download('limb-check-batch.json', state.batch));
  bind('#save-batch', async () => {
    if (!$('#batch-consent').checked) throw new Error('请先勾选“授权将本轮全部报告及证据保存到本机”');
    let saved = 0;
    for (const report of state.batch) { await api('/api/reports', { method: 'POST', body: JSON.stringify({ consent: true, report }) }); saved++; }
    notice(`已保存 ${saved} 份报告（重复点击不会重复建档）`);
  });
}
async function analyzeFiles() {
  const files = [...$('#sample-files').files];
  if (!files.length) throw new Error('请先选择图片或视频');
  if (!$('#sample-consent').checked) throw new Error('请确认样本使用授权');
  if (state.busy || state.camera || !state.engine) return;
  state.busy = true; state.cancel = false; state.batch = []; controls();
  const errors = [];
  try {
    for (const file of files) {
      if (state.cancel) break;
      $('#batch-progress').textContent = `正在分析 ${file.name}`; await yieldUI();
      try { const report = await analyzeFile(file, $('#nail-view').checked); if (report) { state.batch.push(report); showReport(report); } }
      catch (e) { errors.push(`${file.name}：${e.message}`); }
    }
    batchList();
    $('#batch-progress').textContent = `${state.cancel ? '已停止' : '分析完成'}：${state.batch.length}/${files.length} 个文件${errors.length ? `；失败：${errors.join('；')}` : ''}`;
    notice(errors.length ? '部分文件分析失败，原因见样本进度区。' : '分析完成。请查看证据并保存需要标注的报告。', errors.length > 0);
  } finally { state.busy = false; controls(); }
}
async function syntheticCheck() {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 640, 480);
  const frame = state.engine.analyze(canvas); state.engine.draw($('#sample-canvas'), frame);
  showReport(makeReport([frame], { source: 'synthetic', name: '空白画面自检', engine: state.engine.id, rules: state.config.rules, evidence: [{ label: '合成灰色画面，无人体', image: state.engine.snapshot() }] }));
  notice('自检完成。正确行为是人体与手部“无法判断”；此样本自动排除于效果统计。');
}

async function history() {
  const data = await api(`/api/reports?limit=20&offset=${state.offset}`);
  $('#history-count').textContent = `共 ${data.total} 条 · 第 ${Math.floor(state.offset / 20) + 1} 页`;
  $('#history-next').disabled = state.offset + 20 >= data.total;
  $('#history-list').innerHTML = data.items.length ? `<table><tr><th>样本</th><th>来源 / 规则</th><th>标注</th><th>操作</th></tr>${data.items.map(r => `<tr><td>${escape(r.sample_name)}${r.synthetic ? '（模拟）' : ''}</td><td>${escape(r.source)} / ${escape(r.rule_version)}</td><td>${r.annotation ? escape(r.annotation.reviewer) : '待标注'}</td><td><button class="secondary" data-open="${r.id}">查看 / 标注</button></td></tr>`).join('')}</table>` : '<p>暂无已保存报告。先进行采集或样本分析，再点击保存。</p>';
  $('#history-list').querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', async () => {
    try { const row = await api(`/api/reports/${el.dataset.open}`); showReport(row.report, row.id, row.annotation); $('#report-panel').scrollIntoView({ behavior: 'smooth' }); }
    catch (e) { notice(e.message, true); }
  })); controls();
}
async function evaluation() {
  const query = new URLSearchParams({ dataset: $('#filter-dataset').value.trim(), rule_version: $('#filter-rules').value.trim(), engine: $('#filter-engine').value.trim() });
  const data = await api(`/api/evaluation?${query}`);
  const percentage = n => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
  $('#evaluation-results').innerHTML = `<p>${data.samples} 份非模拟报告。${data.mixed_versions ? '⚠ 当前包含多个引擎 / 规则版本，请按版本筛选再比较。' : ''}</p><table><tr><th>检查项</th><th>有效标签</th><th>可判断覆盖率</th><th>准确率¹</th><th>召回率¹</th><th>全阳性检出率²</th><th>误报率¹</th><th>TP / TN / FP / FN</th><th>无法判断</th></tr>${Object.entries(data.checks).map(([key, m]) => `<tr><td>${CHECKS[key]}</td><td>${m.labelled}</td><td>${percentage(m.coverage)}</td><td>${percentage(m.accuracy_decided)}</td><td>${percentage(m.recall_decided)}</td><td>${percentage(m.detection_rate_all_positive)}</td><td>${percentage(m.false_positive_rate_decided)}</td><td>${m.tp} / ${m.tn} / ${m.fp} / ${m.fn}</td><td>${m.abstained}</td></tr>`).join('')}</table><p class="small">¹ 分母仅含有确定人工标签且系统作出 clear/flag 判断的记录，必须结合覆盖率阅读。² TP / 全部人工阳性，包含系统无法判断的阳性样本。无分母显示 —。</p><p class="small">${escape(data.note)} 同一样本多次保存会按记录计数；同一人的数据应按受试者编号划分数据集，避免混入训练和验证集。</p>`;
}
async function saveReport() {
  if (!$('#save-consent').checked) throw new Error('请先授权保存本报告及证据');
  const report = state.report;
  const result = await api('/api/reports', { method: 'POST', body: JSON.stringify({ consent: true, report }) });
  if (state.report === report) showReport(report, result.id);
  notice('报告已保存，可以在下方填写人工标签。');
}
async function reviewReport() {
  if (!$('#review-consent').checked) throw new Error('请先授权向配置的模型服务发送证据');
  const report = state.report;
  if (!report.evidence.length) throw new Error('当前报告没有可发送的证据');
  const evidence = [...document.querySelectorAll('[data-evidence]:checked')].map(el => report.evidence[Number(el.dataset.evidence)]);
  if (!evidence.length || evidence.length > 3) throw new Error('请在证据区勾选 1–3 张图片');
  state.busy = true; controls(); notice('视觉模型正在复核证据…');
  try {
    const result = await api('/api/review', { method: 'POST', body: JSON.stringify({ consent: true, checks: Object.keys(CHECKS), images: evidence.map(e => e.image) }) });
    result.evidence_labels = evidence.map(e => e.label);
    const updated = structuredClone(report);
    updated.local_checks = report.local_checks || report.checks; updated.review = result;
    updated.checks = arbitrate(updated.local_checks, result); updated.run_id = crypto.randomUUID(); updated.parent_run_id = report.run_id;
    updated.engine = `${report.engine.split('+vlm:')[0]}+vlm:${result.model}`;
    showReport(updated); notice('复核完成。原始已保存报告保留，当前复核版本可另行保存。');
  } catch (e) { notice(`复核失败，原始报告保留：${e.message}`, true); }
  finally { state.busy = false; controls(); }
}
$('#annotation-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const labels = Object.fromEntries([...document.querySelectorAll('[data-label]')].filter(el => el.value).map(el => [el.dataset.label, el.value]));
    await api(`/api/reports/${state.reportId}/annotation`, { method: 'POST', body: JSON.stringify({ labels, reviewer: $('#reviewer').value.trim(), dataset: $('#dataset').value.trim(), subject_id: $('#subject-id').value.trim(), note: $('#annotation-note').value }) });
    notice('人工标注已保存。效果评测将使用最新标签，修改历史保留。');
  } catch (e) { notice(e.message, true); }
});
bind('#load-model', loadModel); bind('#camera-start', startCamera); bind('#camera-stop', () => stopCamera(true));
bind('#camera-skip', () => { if (state.camera && state.lastFrame) completeStep(state.workflow.complete('skipped', state.lastFrame, performance.now()), state.lastFrame); });
bind('#analyze-files', analyzeFiles); bind('#sample-cancel', () => { state.cancel = true; }); bind('#synthetic-check', syntheticCheck);
bind('#save-report', saveReport); bind('#review-report', reviewReport);
bind('#download-report', () => download(`limb-check-${state.report.run_id}.json`, state.report)); bind('#print-report', () => window.print());
bind('#refresh-history', history); bind('#refresh-evaluation', evaluation);
bind('#history-prev', () => { state.offset = Math.max(0, state.offset - 20); return history(); });
bind('#history-next', () => { state.offset += 20; return history(); });
$('#camera-consent').addEventListener('change', controls);
window.addEventListener('pagehide', () => { state.camera?.getTracks().forEach(t => t.stop()); window.speechSynthesis?.cancel(); });
try {
  state.config = await api('/api/config'); $('#server-status').textContent = `v${state.config.version} · ${state.config.environment} · 本机存储`;
  $('#max-frames').textContent = state.config.rules.maxVideoFrames; controls();
  notice('服务已连接。点击“加载模型”，或先查看使用说明。');
} catch (e) { $('#load-model').disabled = true; notice(`初始化失败：${e.message}。请通过 python3 server.py 启动后访问 localhost。`, true); }
