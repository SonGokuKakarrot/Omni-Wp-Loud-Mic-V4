const EXT = globalThis.browser ?? globalThis.chrome;
const HAS_PROMISE_API = typeof globalThis.browser !== 'undefined' && EXT === globalThis.browser;
const DEFAULTS = {
  profileVersion: 6,
  enabled: true,
  gainDb: 18,
  loudness: 2,
  maxBoost: 16,
  drive: 0.2,
  thresholdDb: -36,
  ratio: 8,
  limiterDb: -0.1,
  presenceDb: 6,
  lowShelfDb: 3,
  highShelfDb: 5,
  sustain: true,
  sustainTargetDb: -8,
  sustainMaxGain: 8,
  forceRawMic: true,
  reverbEnabled: false,
  reverbDelay: 0.045,
  reverbFeedback: 0.35,
  reverbWet: 0.03,
  keepAlive: false,
  keepAliveGain: 0,
  senderRefreshMs: 1000
};
const PRESETS = {
  royal: {
    ...DEFAULTS,
    gainDb: 32,
    loudness: 8,
    maxBoost: 16,
    drive: 0.35,
    thresholdDb: -42,
    ratio: 12,
    limiterDb: -1.5,
    presenceDb: 10,
    lowShelfDb: 5,
    highShelfDb: 8,
    sustainTargetDb: -3,
    sustainMaxGain: 24,
    reverbWet: 0.05,
    keepAliveGain: 0.0001
  },
  lord: { ...DEFAULTS }
};
const ids = Object.keys(DEFAULTS).filter((id) => id !== 'profileVersion' && id !== 'senderRefreshMs');
const STORAGE_DEBOUNCE_MS = 120;
let pendingConfig = null;
let pendingSaveTimer = 0;


function storageGet(key) {
  if (HAS_PROMISE_API) return EXT.storage.local.get(key);
  return new Promise((resolve) => {
    try {
      EXT.storage.local.get(key, (res) => {
        if (EXT.runtime?.lastError) resolve({});
        else resolve(res || {});
      });
    } catch (_) {
      resolve({});
    }
  });
}

function storageSet(value) {
  if (HAS_PROMISE_API) return EXT.storage.local.set(value);
  return new Promise((resolve) => {
    try {
      EXT.storage.local.set(value, () => resolve(!EXT.runtime?.lastError));
    } catch (_) {
      resolve(false);
    }
  });
}

function sendMessage(message) {
  if (HAS_PROMISE_API) return EXT.runtime.sendMessage(message);
  return new Promise((resolve) => {
    try {
      EXT.runtime.sendMessage(message, (res) => {
        if (EXT.runtime?.lastError) resolve(null);
        else resolve(res || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function numberText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) < 0.01 && n !== 0) return n.toFixed(5);
  if (Math.abs(n) < 10 && !Number.isInteger(n)) return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return String(n);
}

function updateLabels() {
  ids.forEach((id) => {
    const el = document.getElementById(id);
    const label = document.getElementById(`${id}Val`);
    if (label && el?.type !== 'checkbox') label.textContent = numberText(el.value);
  });
}

function presetMatches(config, preset) {
  return Object.entries(preset).every(([key, value]) => Number(config[key]) === Number(value) || config[key] === value);
}

function activePreset(config) {
  if (presetMatches(config, PRESETS.royal)) return 'royal';
  if (presetMatches(config, PRESETS.lord)) return 'lord';
  return 'custom';
}

function updatePresetState(config) {
  const active = activePreset(config);
  document.body.dataset.theme = active;
  const royalButton = document.getElementById('royalPreset');
  const lordButton = document.getElementById('lordPreset');
  royalButton?.classList.toggle('active', active === 'royal');
  royalButton?.setAttribute('aria-pressed', String(active === 'royal'));
  lordButton?.classList.toggle('active', active === 'lord');
  lordButton?.setAttribute('aria-pressed', String(active === 'lord'));
}

function applyToControls(config) {
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(config[id]);
    else el.value = config[id];
  });
  updateLabels();
  updatePresetState(config);
}

async function readConfig() {
  const stored = await storageGet('micMaximizerConfig');
  const config = stored.micMaximizerConfig || {};
  if (config.profileVersion !== DEFAULTS.profileVersion) return { ...DEFAULTS };
  return { ...DEFAULTS, ...config };
}

async function persistConfig(config) {
  const merged = { ...DEFAULTS, ...config, profileVersion: DEFAULTS.profileVersion };
  pendingConfig = merged;
  await storageSet({ micMaximizerConfig: merged });
  if (pendingConfig === merged) pendingConfig = null;
  return merged;
}

async function saveConfig(config, { render = true } = {}) {
  clearTimeout(pendingSaveTimer);
  pendingSaveTimer = 0;
  const merged = await persistConfig(config);
  if (render) applyToControls(merged);
  return merged;
}

function queueSave(config) {
  clearTimeout(pendingSaveTimer);
  pendingConfig = { ...DEFAULTS, ...config, profileVersion: DEFAULTS.profileVersion };
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = 0;
    persistConfig(pendingConfig).catch(() => {});
  }, STORAGE_DEBOUNCE_MS);
}

async function currentConfig() {
  return pendingConfig ? { ...DEFAULTS, ...pendingConfig } : readConfig();
}

async function onControlInput(id, el, immediate = false) {
  const merged = await currentConfig();
  merged[id] = el.type === 'checkbox' ? el.checked : Number(el.value);
  updateLabels();
  updatePresetState(merged);
  if (immediate) await saveConfig(merged, { render: false });
  else queueSave(merged);
}

async function init() {
  if (!EXT?.storage?.local) return;
  applyToControls(await readConfig());
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => onControlInput(id, el));
    el.addEventListener('change', () => onControlInput(id, el, true));
  });
  document.getElementById('royalPreset')?.addEventListener('click', () => saveConfig(PRESETS.royal));
  document.getElementById('lordPreset')?.addEventListener('click', () => saveConfig(PRESETS.lord));
}

async function refreshHookStatus() {
  const el = document.getElementById('hookStatus');
  if (!el || !EXT?.runtime) return;
  try {
    const status = await sendMessage({ type: 'MICMAX_STATUS_REQUEST' });
    const ageMs = status?.lastHeartbeat ? Date.now() - status.lastHeartbeat : Infinity;
    if (status?.ok && ageMs < 12000) {
      el.textContent = 'Hook status: ACTIVE on WhatsApp Web';
      el.className = 'status ok';
    } else {
      el.textContent = 'Hook status: waiting — open or reload WhatsApp Web';
      el.className = 'status warn';
    }
  } catch (_) {
    el.textContent = 'Hook status: unavailable';
    el.className = 'status warn';
  }
}

init();
setInterval(refreshHookStatus, 3000);
refreshHookStatus();
