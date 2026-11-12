(async function () {
  'use strict';
  const SG = globalThis.SG;
  const $ = (id) => document.getElementById(id);
  let settings = await SG.loadSettings();

  const CHECKS = ['enabled', 'showMeaning', 'showParts', 'showReading', 'showRoles', 'showTranslation', 'hideNative', 'hoverPause', 'resumeOnLeave', 'autoDeep'];
  const TEXTS = ['apiKey', 'baseURL', 'nativeLang'];

  const modelSel = $('model');
  for (const m of SG.MODELS) modelSel.append(new Option(m.name, m.id));

  function fill() {
    for (const id of CHECKS) $(id).checked = Boolean(settings[id]);
    for (const id of TEXTS) $(id).value = settings[id] || '';
    modelSel.value = settings.model;
    $('effort').value = settings.effort;
    $('learning').value = (settings.learning || []).join(', ');
    $('fontScale').value = settings.fontScale;
    $('fontScaleValue').textContent = Math.round(settings.fontScale * 100) + '%';
    $('lookaheadMin').value = String(settings.lookaheadMin);
    $('chunkSize').value = settings.chunkSize;
    $('concurrency').value = settings.concurrency;
    const m = SG.MODELS.find((x) => x.id === settings.model);
    $('modelNote').textContent = m ? `${m.note} $${m.inPrice} / $${m.outPrice} per million input / output tokens.` : '';
    renderHosts();
  }

  let savedTimer = null;
  async function save(patch) {
    settings = await SG.saveSettings(patch);
    fill();
    $('saved').classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $('saved').classList.remove('show'), 1200);
  }

  for (const id of CHECKS) $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  for (const id of TEXTS) $(id).addEventListener('change', (e) => save({ [id]: e.target.value.trim() }));
  modelSel.addEventListener('change', () => save({ model: modelSel.value }));
  $('effort').addEventListener('change', (e) => save({ effort: e.target.value }));
  $('lookaheadMin').addEventListener('change', (e) => save({ lookaheadMin: Number(e.target.value) }));
  $('learning').addEventListener('change', (e) => {
    const list = e.target.value.split(/[\s,]+/).map((v) => SG.lang ? SG.lang.langCode(v) : v.toLowerCase()).filter(Boolean);
    save({ learning: list });
  });
  $('fontScale').addEventListener('input', (e) => {
    $('fontScaleValue').textContent = Math.round(Number(e.target.value) * 100) + '%';
  });
  $('fontScale').addEventListener('change', (e) => save({ fontScale: Number(e.target.value) }));
  const clampInt = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  $('chunkSize').addEventListener('change', (e) => save({ chunkSize: clampInt(e.target.value, 2, 25, 8) }));
  $('concurrency').addEventListener('change', (e) => save({ concurrency: clampInt(e.target.value, 1, 8, 3) }));

  function renderHosts() {
    const ul = $('disabledHosts');
    ul.textContent = '';
    const hosts = settings.disabledHosts || [];
    if (!hosts.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'None';
      ul.append(li);
    }
    for (const host of hosts) {
      const li = document.createElement('li');
      li.textContent = host;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Turn on';
      btn.addEventListener('click', () => save({ disabledHosts: hosts.filter((x) => x !== host) }));
      li.append(btn);
      ul.append(li);
    }
  }

  $('testKey').addEventListener('click', async () => {
    const out = $('testResult');
    // Save first so the test uses what is in the box.
    await save({ apiKey: $('apiKey').value.trim(), baseURL: $('baseURL').value.trim(), model: modelSel.value });
    out.className = 'note';
    out.textContent = 'Testing…';
    const res = await browser.runtime.sendMessage({ type: 'testKey' });
    out.className = 'note ' + (res.ok ? 'ok' : 'bad');
    out.textContent = res.ok ? `Works (${res.model}).` : res.error;
  });

  async function renderUsage() {
    const status = await browser.runtime.sendMessage({ type: 'status', tabId: -1 });
    const usage = status.usage || {};
    const box = $('usage');
    box.textContent = '';
    const ids = Object.keys(usage);
    if (!ids.length) {
      box.textContent = 'No requests yet.';
      return;
    }
    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Model</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th><th>Estimate</th></tr>';
    let total = 0;
    for (const id of ids) {
      const u = usage[id];
      const m = SG.MODELS.find((x) => id.startsWith(x.id)) || { name: id, inPrice: 0, outPrice: 0 };
      const cost = (u.input * m.inPrice + u.cacheRead * m.inPrice * 0.1 + u.output * m.outPrice) / 1e6;
      total += cost;
      const tr = document.createElement('tr');
      for (const v of [m.name, u.requests, (u.input + u.cacheRead).toLocaleString(), u.output.toLocaleString(), '$' + cost.toFixed(2)]) {
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.append(td);
      }
      table.append(tr);
    }
    box.append(table);
    const p = document.createElement('p');
    p.textContent = `Estimated total: $${total.toFixed(2)}`;
    box.append(p);
  }

  $('resetUsage').addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'resetUsage' });
    renderUsage();
  });
  $('clearCache').addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'clearCache' });
    $('cacheResult').textContent = 'Cleared.';
  });

  fill();
  renderUsage();
})();
