(async function () {
  'use strict';
  const SG = globalThis.SG;
  const $ = (id) => document.getElementById(id);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch (e) {
    /* about: pages */
  }
  let settings = await SG.loadSettings();

  const modelSel = $('model');
  for (const m of SG.MODELS) modelSel.append(new Option(m.name, m.id));

  function fill() {
    $('enabled').checked = settings.enabled;
    $('host').textContent = host || 'This page';
    $('siteEnabled').checked = !(settings.disabledHosts || []).includes(host);
    $('siteEnabled').disabled = !host || !settings.enabled;
    modelSel.value = settings.model;
  }

  async function save(patch) {
    settings = await SG.saveSettings(patch);
    fill();
  }

  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('siteEnabled').addEventListener('change', (e) => {
    const list = (settings.disabledHosts || []).filter((x) => x !== host);
    if (!e.target.checked) list.push(host);
    save({ disabledHosts: list });
  });
  modelSel.addEventListener('change', () => save({ model: modelSel.value }));
  for (const id of ['openOptions', 'openOptions2']) {
    $(id).addEventListener('click', (e) => {
      e.preventDefault();
      browser.runtime.openOptionsPage();
      window.close();
    });
  }

  $('openLibrary').addEventListener('click', (e) => {
    e.preventDefault();
    browser.tabs.create({ url: browser.runtime.getURL('grammar/grammar.html') });
    window.close();
  });

  async function refresh() {
    const s = await browser.runtime.sendMessage({ type: 'status', tabId: tab.id });
    $('keyWarning').hidden = s.hasKey;
    const st = s.state;
    const ul = $('tracks');
    ul.textContent = '';
    if (st && st.track) {
      const t = st.track;
      const pct = t.lines ? Math.round((t.ready / t.lines) * 100) : 0;
      $('state').textContent = `${SG.lang.langName(t.lang)}: ${t.ready} of ${t.lines} lines ready (${pct}%).`;
    } else if (s.tracks.length) {
      $('state').textContent = 'Subtitles found, none in a language you are learning yet.';
    } else {
      $('state').textContent = 'No subtitles found yet. Turn them on in the player.';
    }
    for (const t of s.tracks) {
      const li = document.createElement('li');
      li.textContent = `${SG.lang.langName(t.lang)} · ${t.lines} lines`;
      li.title = t.url;
      ul.append(li);
    }
    const err = (st && st.error) || s.lastError;
    $('error').hidden = !err;
    $('error').textContent = err ? err.message : '';
    let total = 0;
    for (const [id, u] of Object.entries(s.usage || {})) {
      const m = SG.MODELS.find((x) => id.startsWith(x.id));
      if (m) total += (u.input * m.inPrice + u.cacheRead * m.inPrice * 0.1 + u.output * m.outPrice) / 1e6;
    }
    $('spend').textContent = `Estimated spend so far: $${total.toFixed(2)}`;
  }

  fill();
  refresh();
  setInterval(refresh, 1500);
})();
