(() => {
  if (window.__micMaxInjectorReady) return;
  window.__micMaxInjectorReady = true;

  // Extreme profile based on Omni DC Lord, with clamps to keep controls recoverable.
  // Omni WhatsApp Lord V4 extreme 200000x profile, with clamps to keep controls recoverable.
  const DEFAULTS = {
    profileVersion: 5,
    enabled: true,
    gainDb: 106.0206,
    thresholdDb: -60,
    knee: 40,
    ratio: 20,
    attack: 0.0001,
    release: 0.03,
    lowShelfDb: 14,
    presenceDb: 20,
    highShelfDb: 16,
    limiterDb: -0.1,
    drive: 1.2,
    loudness: 1.0,
    maxBoost: 200000,
    sustain: true,
    sustainTargetDb: 5,
    sustainMaxGain: 120,
    forceRawMic: true,
    reverbEnabled: true,
    reverbDelay: 0.045,
    reverbFeedback: 0.35,
    reverbWet: 0.18,
    keepAlive: true,
    keepAliveGain: 0.00035,
    senderRefreshMs: 500
  };
  const MSG_CFG = 'MIC_MAXIMIZER_CONFIG';
  const AUDIO_SEND_MAX_BITRATE = 512000;
  const state = {
    config: { ...DEFAULTS },
    origMD: null,
    origLegacy: null,
    pipelines: new Set(),
    trackMap: new WeakMap(),
    processedTracks: new WeakSet(),
    processedMeta: new WeakMap(),
    senderWatchTracks: new WeakSet(),
    peerConnections: new Set(),
    senderRecords: new Set(),
    senderBySender: new WeakMap(),
    refreshingSenders: new WeakSet(),
    recoverTimers: new Set(),
    lastAudioConstraints: { audio: true },
    sourceTracks: new Set(),
    origApplyConstraints: null
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
  const dbToLinear = (db) => Math.pow(10, db / 20);

  function cfg(input = state.config) {
    const merged = { ...DEFAULTS, ...(input || {}) };
    merged.enabled = Boolean(merged.enabled);
    merged.maxBoost = clamp(merged.maxBoost, 1, 200000);
    merged.loudness = clamp(merged.loudness, 0.5, merged.maxBoost);
    merged.gainDb = clamp(merged.gainDb, 0, 120);
    merged.drive = clamp(merged.drive, 0, 10);
    merged.thresholdDb = clamp(merged.thresholdDb, -100, 0);
    merged.knee = clamp(merged.knee, 0, 40);
    // DynamicsCompressorNode.ratio has a nominal browser range of [1, 20].
    // Values above 20 trigger Quetta/Chromium extension errors/warnings at setTargetAtTime.
    merged.ratio = clamp(merged.ratio, 1, 20);
    merged.attack = clamp(merged.attack, 0.0001, 1);
    merged.release = clamp(merged.release, 0.01, 1);
    merged.lowShelfDb = clamp(merged.lowShelfDb, -60, 60);
    merged.presenceDb = clamp(merged.presenceDb, -60, 60);
    merged.highShelfDb = clamp(merged.highShelfDb, -60, 60);
    merged.limiterDb = clamp(merged.limiterDb, -24, 0);
    merged.sustain = Boolean(merged.sustain);
    merged.sustainTargetDb = clamp(merged.sustainTargetDb, -40, 20);
    merged.sustainMaxGain = clamp(merged.sustainMaxGain, 1, 120);
    merged.forceRawMic = Boolean(merged.forceRawMic);
    merged.reverbEnabled = Boolean(merged.reverbEnabled);
    merged.reverbDelay = clamp(merged.reverbDelay, 0.01, 0.25);
    merged.reverbFeedback = clamp(merged.reverbFeedback, 0, 0.85);
    merged.reverbWet = clamp(merged.reverbWet, 0, 0.8);
    merged.keepAlive = Boolean(merged.keepAlive);
    merged.keepAliveGain = clamp(merged.keepAliveGain, 0, 0.01);
    merged.senderRefreshMs = clamp(merged.senderRefreshMs, 250, 5000);
    return merged;
  }

  function makeSaturationCurve(amount = 0.5) {
    const k = Math.max(0.0001, amount * 100);
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  function setParam(param, value, ctx) {
    if (!param) return;
    const safeValue = clamp(value, param.minValue ?? -Infinity, param.maxValue ?? Infinity);
    const now = ctx?.currentTime || 0;
    try {
      if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
      if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(safeValue, now, 0.005);
      else param.value = safeValue;
    } catch (_) {
      try { param.value = safeValue; } catch (_) {}
    }
  }

  function applyPipeline(pipeline, inputConfig = state.config) {
    const raw = cfg(inputConfig);
    const c = raw.enabled ? raw : {
      ...raw,
      lowShelfDb: 0,
      presenceDb: 0,
      highShelfDb: 0,
      thresholdDb: -6,
      knee: 0,
      ratio: 1,
      loudness: 1,
      gainDb: 0,
      drive: 0,
      limiterDb: -0.5
    };
    const { ctx, nodes } = pipeline;
    setParam(nodes.low.gain, c.lowShelfDb, ctx);
    setParam(nodes.pres.gain, c.presenceDb, ctx);
    setParam(nodes.high.gain, c.highShelfDb, ctx);
    setParam(nodes.comp1.threshold, c.thresholdDb, ctx);
    setParam(nodes.comp1.knee, c.knee, ctx);
    setParam(nodes.comp1.ratio, c.ratio, ctx);
    setParam(nodes.comp1.attack, c.attack, ctx);
    setParam(nodes.comp1.release, c.release, ctx);
    setParam(nodes.loudness.gain, c.loudness, ctx);
    setParam(nodes.gain.gain, dbToLinear(c.gainDb), ctx);
    nodes.saturator.curve = makeSaturationCurve(c.drive);
    if (nodes.sustain) setParam(nodes.sustain.gain, c.sustain ? Math.min(dbToLinear(c.sustainTargetDb), c.sustainMaxGain) : 1, ctx);
    if (nodes.reverbDelay) setParam(nodes.reverbDelay.delayTime, c.reverbDelay, ctx);
    if (nodes.reverbFeedback) setParam(nodes.reverbFeedback.gain, c.reverbEnabled ? c.reverbFeedback : 0, ctx);
    if (nodes.reverbWet) setParam(nodes.reverbWet.gain, c.reverbEnabled ? c.reverbWet : 0, ctx);
    if (nodes.keepAliveGain) setParam(nodes.keepAliveGain.gain, c.keepAlive ? c.keepAliveGain : 0, ctx);
    setParam(nodes.limiter.threshold, c.limiterDb, ctx);
  }

  function updateAllPipelines(inputConfig = state.config) {
    for (const pipeline of state.pipelines) applyPipeline(pipeline, inputConfig);
  }

  function resumePipeline(pipeline) {
    const ctx = pipeline?.ctx;
    if (!ctx || ctx.state === 'closed' || typeof ctx.resume !== 'function') return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  function resumeAllPipelines() {
    for (const pipeline of state.pipelines) resumePipeline(pipeline);
  }

  function createAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      return new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch (_) {
      return new AC({ latencyHint: 'interactive' });
    }
  }

  function build(stream, inputConfig) {
    const ctx = createAudioContext();
    if (!ctx || !stream.getAudioTracks().length) return stream;

    const source = ctx.createMediaStreamSource(stream);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 75;
    hp.Q.value = 0.7;

    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 200;

    const pres = ctx.createBiquadFilter();
    pres.type = 'peaking';
    pres.frequency.value = 3200;
    pres.Q.value = 1.5;

    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 6000;

    const comp1 = ctx.createDynamicsCompressor();
    const comp2 = ctx.createDynamicsCompressor();
    comp2.threshold.value = -10;
    comp2.knee.value = 5;
    comp2.ratio.value = 12;
    comp2.attack.value = 0.001;
    comp2.release.value = 0.05;

    const sustain = ctx.createGain();
    const loudness = ctx.createGain();
    const gain = ctx.createGain();
    const saturator = ctx.createWaveShaper();
    saturator.oversample = '4x';

    const reverbDelay = ctx.createDelay(0.25);
    const reverbFeedback = ctx.createGain();
    const reverbWet = ctx.createGain();
    const keepAliveOsc = ctx.createOscillator();
    const keepAliveGain = ctx.createGain();
    keepAliveOsc.type = 'sine';
    keepAliveOsc.frequency.value = 18;
    try { keepAliveOsc.start(); } catch (_) {}

    const limiter = ctx.createDynamicsCompressor();
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0001;
    limiter.release.value = 0.01;

    const dst = ctx.createMediaStreamDestination();
    source.connect(hp);
    hp.connect(low);
    low.connect(pres);
    pres.connect(high);
    high.connect(comp1);
    comp1.connect(comp2);
    comp2.connect(sustain);
    sustain.connect(loudness);
    sustain.connect(reverbDelay);
    reverbDelay.connect(reverbFeedback);
    reverbFeedback.connect(reverbDelay);
    reverbDelay.connect(reverbWet);
    reverbWet.connect(loudness);
    keepAliveOsc.connect(keepAliveGain);
    keepAliveGain.connect(loudness);
    loudness.connect(gain);
    gain.connect(saturator);
    saturator.connect(limiter);
    limiter.connect(dst);

    const pipeline = { ctx, nodes: { low, pres, high, comp1, sustain, loudness, gain, saturator, reverbDelay, reverbFeedback, reverbWet, keepAliveGain, limiter } };
    applyPipeline(pipeline, inputConfig);
    state.pipelines.add(pipeline);
    resumePipeline(pipeline);

    const outAudioTracks = dst.stream.getAudioTracks();
    outAudioTracks.forEach((track) => {
      state.processedTracks.add(track);
      state.processedMeta.set(track, { source: stream, pipeline });
    });

    const out = new MediaStream([
      ...outAudioTracks,
      ...stream.getTracks().filter((track) => track.kind !== 'audio')
    ]);

    const stop = () => {
      state.pipelines.delete(pipeline);
      try { keepAliveOsc.stop(); } catch (_) {}
      try { ctx.close(); } catch (_) {}
    };
    stream.getTracks().forEach((track) => track.addEventListener('ended', stop, { once: true }));
    return out;
  }

  function normalizeConstraints(constraints) {
    if (constraints === true) constraints = { audio: true };
    if (!constraints || typeof constraints !== 'object') return constraints;
    const next = { ...constraints };
    if (next.audio === true) next.audio = {};
    if (typeof next.audio === 'object' && cfg().forceRawMic) {
      next.audio = {
        ...next.audio,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false,
        channelCount: 1,
        sampleRate: { ideal: 48000 },
        sampleSize: { ideal: 16 }
      };
    }
    return next;
  }

  function wantsAudio(constraints) {
    if (constraints === true) return true;
    if (!constraints || typeof constraints !== 'object') return false;
    return 'audio' in constraints ? Boolean(constraints.audio) : true;
  }

  function processedStreamFor(originalStream, rawTrack, processedTrack) {
    if (!originalStream || typeof originalStream.getTracks !== 'function') return new MediaStream([processedTrack]);
    return new MediaStream(originalStream.getTracks().map((track) => (track === rawTrack ? processedTrack : track)));
  }

  function liveAudioTrack(stream) {
    if (!stream || typeof stream.getAudioTracks !== 'function') return null;
    return stream.getAudioTracks().find((track) => track.readyState !== 'ended') || null;
  }

  function processedSourceIsLive(track) {
    if (!track || !state.processedTracks.has(track)) return true;
    const meta = state.processedMeta.get(track);
    if (!meta) return true;
    resumePipeline(meta.pipeline);
    return Boolean(liveAudioTrack(meta.source));
  }

  function trackNeedsRefresh(track) {
    if (!track || track.kind !== 'audio') return true;
    if (track.readyState === 'ended') return true;
    if (!state.processedTracks.has(track)) return true;
    return !processedSourceIsLive(track);
  }

  function rebuildProcessedTrack(track) {
    const meta = state.processedMeta.get(track);
    const sourceTrack = liveAudioTrack(meta?.source);
    if (!sourceTrack) return track;
    try {
      const rebuiltStream = build(new MediaStream([sourceTrack]), state.config);
      return liveAudioTrack(rebuiltStream) || track;
    } catch (_) {
      return track;
    }
  }

  function cloneForSender(track) {
    const liveTrack = track?.readyState === 'ended' ? rebuildProcessedTrack(track) : track;
    if (!liveTrack || liveTrack.readyState === 'ended' || typeof liveTrack.clone !== 'function') return liveTrack;
    try {
      const clone = liveTrack.clone();
      state.processedTracks.add(clone);
      const meta = state.processedMeta.get(liveTrack);
      if (meta) state.processedMeta.set(clone, meta);
      return clone;
    } catch (_) {
      return liveTrack;
    }
  }

  function processAudioTrack(track, forSender = false) {
    if (!track || track.kind !== 'audio') return track;
    if (state.processedTracks.has(track)) {
      const nextTrack = track.readyState === 'ended' ? rebuildProcessedTrack(track) : track;
      return forSender ? cloneForSender(nextTrack) : nextTrack;
    }

    const existing = state.trackMap.get(track);
    if (existing) {
      const nextTrack = existing.readyState === 'ended' ? rebuildProcessedTrack(existing) : existing;
      if (nextTrack && nextTrack !== existing && nextTrack.readyState !== 'ended') state.trackMap.set(track, nextTrack);
      if (nextTrack && nextTrack.readyState !== 'ended') return forSender ? cloneForSender(nextTrack) : nextTrack;
    }

    const processedStream = build(new MediaStream([track]), state.config);
    const processedTrack = liveAudioTrack(processedStream) || track;
    if (processedTrack !== track) {
      state.processedTracks.add(processedTrack);
      state.trackMap.set(track, processedTrack);
      state.sourceTracks.add(track);
      track.addEventListener('ended', () => {
        state.sourceTracks.delete(track);
        try { processedTrack.stop(); } catch (_) {}
      }, { once: true });
    }
    return forSender ? cloneForSender(processedTrack) : processedTrack;
  }

  function tuneAudioSender(sender) {
    if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    try {
      const params = sender.getParameters() || {};
      const encodings = Array.isArray(params.encodings) && params.encodings.length ? params.encodings : [{}];
      params.encodings = encodings.map((encoding) => ({
        ...encoding,
        active: encoding.active !== false,
        dtx: false,
        maxBitrate: Math.max(Number(encoding.maxBitrate) || 0, AUDIO_SEND_MAX_BITRATE),
        networkPriority: 'high',
        priority: 'high'
      }));
      sender.setParameters(params).catch(() => {});
    } catch (_) {}
  }

  function rememberPeerConnection(pc) {
    if (!pc || state.peerConnections.has(pc)) return;
    state.peerConnections.add(pc);
    if (typeof pc.addEventListener === 'function') {
      pc.addEventListener('connectionstatechange', () => {
        if (['closed', 'failed'].includes(pc.connectionState)) state.peerConnections.delete(pc);
      });
    }
  }

  function rememberSender(sender, track, pc = null) {
    if (!sender) return null;
    let record = state.senderBySender.get(sender);
    if (!record) {
      record = { sender, track: null, pc: null };
      state.senderBySender.set(sender, record);
      state.senderRecords.add(record);
    }
    if (track) record.track = track;
    if (pc) record.pc = pc;
    return record;
  }

  function recordIsClosed(record) {
    const pc = record?.pc;
    if (!pc) return false;
    return ['closed', 'failed'].includes(pc.connectionState || pc.iceConnectionState || '');
  }

  async function reacquireProcessedTrackForSender() {
    if (!state.origMD) return null;
    try {
      const constraints = normalizeConstraints(state.lastAudioConstraints || { audio: true });
      const stream = await state.origMD(constraints);
      const rawTrack = liveAudioTrack(stream);
      if (!rawTrack) return null;
      return processAudioTrack(rawTrack, true);
    } catch (_) {
      return null;
    }
  }

  async function replaceSenderTrack(sender, track) {
    if (!sender || typeof sender.replaceTrack !== 'function') return null;
    rememberSender(sender, track);
    const current = track || sender.track;
    let replacement = null;

    if (current && current.kind === 'audio' && !trackNeedsRefresh(current)) {
      replacement = current;
    } else if (current && current.kind === 'audio' && current.readyState !== 'ended' && !state.processedTracks.has(current)) {
      replacement = processAudioTrack(current, true);
    }

    if (!replacement || trackNeedsRefresh(replacement)) replacement = await reacquireProcessedTrackForSender();
    if (!replacement || replacement.readyState === 'ended') return null;

    try {
      await sender.replaceTrack(replacement);
      tuneAudioSender(sender);
      rememberSender(sender, replacement);
      watchSenderTrack(sender, replacement);
      return replacement;
    } catch (_) {
      return null;
    }
  }

  function queueSenderRefresh(sender, track) {
    resumeAllPipelines();
    if (!sender || state.refreshingSenders.has(sender)) return;
    state.refreshingSenders.add(sender);
    setTimeout(() => {
      replaceSenderTrack(sender, track).finally(() => state.refreshingSenders.delete(sender));
    }, cfg().senderRefreshMs);
  }

  function watchSenderTrack(sender, track) {
    if (!sender || !track || track.kind !== 'audio') return;
    rememberSender(sender, track);
    if (!state.processedTracks.has(track) || state.senderWatchTracks.has(track)) return;
    state.senderWatchTracks.add(track);
    track.addEventListener('ended', () => queueSenderRefresh(sender, track), { once: true });
  }

  function scheduleRecoveryPasses() {
    for (const timer of state.recoverTimers) clearTimeout(timer);
    state.recoverTimers.clear();
    [0, 150, 500, 1200, 2500].forEach((delay) => {
      const timer = setTimeout(() => {
        state.recoverTimers.delete(timer);
        resumeAllPipelines();
        reconcileLiveSenders();
      }, delay);
      state.recoverTimers.add(timer);
    });
  }

  function reconcileLiveSenders() {
    if (!cfg().enabled) return;
    resumeAllPipelines();
    for (const pc of [...state.peerConnections]) {
      if (typeof pc.getSenders !== 'function') continue;
      try {
        for (const sender of pc.getSenders()) {
          const track = sender?.track;
          if (track?.kind === 'audio') rememberSender(sender, track);
        }
      } catch (_) {}
    }

    for (const record of [...state.senderRecords]) {
      if (recordIsClosed(record)) {
        state.senderRecords.delete(record);
        continue;
      }
      const sender = record.sender;
      const track = sender?.track || record.track;
      if (!sender || !track || track.kind !== 'audio') continue;
      if (trackNeedsRefresh(track)) queueSenderRefresh(sender, track);
      else {
        tuneAudioSender(sender);
        watchSenderTrack(sender, track);
      }
    }
  }


  function patchTrackApplyConstraints() {
    const Track = window.MediaStreamTrack;
    if (!Track?.prototype || Track.prototype.__micMaxConstraintsPatched) return;
    const original = Track.prototype.applyConstraints;
    if (typeof original === 'function') {
      state.origApplyConstraints = original;
      Track.prototype.applyConstraints = function applyConstraints(constraints) {
        if (this?.kind === 'audio' && cfg().forceRawMic) {
          return original.call(this, normalizeConstraints({ audio: constraints || {} }).audio || constraints);
        }
        return original.call(this, constraints);
      };
    }
    Track.prototype.__micMaxConstraintsPatched = true;
  }

  function patchPeerConnectionPaths() {
    const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (PC?.prototype && !PC.prototype.__micMaxPcPatched) {
      const originalAddTrack = PC.prototype.addTrack;
      if (typeof originalAddTrack === 'function') {
        PC.prototype.addTrack = function addTrack(track, ...streams) {
          rememberPeerConnection(this);
          if (cfg().enabled && track?.kind === 'audio') {
            const processedTrack = processAudioTrack(track, true);
            const patchedStreams = streams.length
              ? streams.map((stream) => processedStreamFor(stream, track, processedTrack))
              : [new MediaStream([processedTrack])];
            const sender = originalAddTrack.call(this, processedTrack, ...patchedStreams);
            tuneAudioSender(sender);
            rememberSender(sender, processedTrack, this);
            if (typeof sender?.replaceTrack === 'function') watchSenderTrack(sender, processedTrack);
            return sender;
          }
          return originalAddTrack.call(this, track, ...streams);
        };
      }

      const originalAddTransceiver = PC.prototype.addTransceiver;
      if (typeof originalAddTransceiver === 'function') {
        PC.prototype.addTransceiver = function addTransceiver(trackOrKind, init = undefined) {
          rememberPeerConnection(this);
          if (cfg().enabled && trackOrKind?.kind === 'audio') {
            const processedTrack = processAudioTrack(trackOrKind, true);
            const patchedInit = init?.streams
              ? { ...init, streams: init.streams.map((stream) => processedStreamFor(stream, trackOrKind, processedTrack)) }
              : init;
            const transceiver = originalAddTransceiver.call(this, processedTrack, patchedInit);
            tuneAudioSender(transceiver?.sender);
            rememberSender(transceiver?.sender, processedTrack, this);
            if (typeof transceiver?.sender?.replaceTrack === 'function') watchSenderTrack(transceiver.sender, processedTrack);
            return transceiver;
          }
          return originalAddTransceiver.call(this, trackOrKind, init);
        };
      }
      PC.prototype.__micMaxPcPatched = true;
    }

    const Sender = window.RTCRtpSender;
    if (Sender?.prototype && !Sender.prototype.__micMaxSenderPatched) {
      const originalReplaceTrack = Sender.prototype.replaceTrack;
      if (typeof originalReplaceTrack === 'function') {
        Sender.prototype.replaceTrack = function replaceTrack(track) {
          const nextTrack = cfg().enabled && track?.kind === 'audio' ? processAudioTrack(track, true) : track;
          const result = originalReplaceTrack.call(this, nextTrack);
          if (nextTrack?.kind === 'audio') {
            rememberSender(this, nextTrack);
            Promise.resolve(result).then(() => {
              tuneAudioSender(this);
              watchSenderTrack(this, nextTrack);
            }).catch(() => {});
          }
          return result;
        };
      }
      Sender.prototype.__micMaxSenderPatched = true;
    }
  }

  async function getStreamWithFallback(orig, constraints, ctx) {
    try {
      return await orig.call(ctx, normalizeConstraints(constraints));
    } catch (_) {
      return orig.call(ctx, constraints);
    }
  }

  async function wrapped(orig, constraints, ctx) {
    if (wantsAudio(constraints)) state.lastAudioConstraints = constraints || { audio: true };
    const stream = await getStreamWithFallback(orig, constraints, ctx);
    if (!cfg().enabled || !wantsAudio(constraints)) return stream;
    try {
      return build(stream, state.config);
    } catch (_) {
      return stream;
    }
  }

  patchTrackApplyConstraints();
  patchPeerConnectionPaths();

  if (navigator.mediaDevices?.getUserMedia) {
    state.origMD = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => wrapped(state.origMD, constraints, navigator.mediaDevices);
  }

  if (navigator.getUserMedia) {
    state.origLegacy = navigator.getUserMedia.bind(navigator);
    navigator.getUserMedia = (constraints, ok, fail) => {
      wrapped(state.origLegacy, constraints, navigator).then(ok).catch((err) => fail && fail(err));
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== MSG_CFG) return;
    state.config = cfg(event.data.payload);
    updateAllPipelines(state.config);
    scheduleRecoveryPasses();
  });

  ['focus', 'pageshow', 'online', 'pointerdown', 'touchstart'].forEach((type) => {
    window.addEventListener(type, scheduleRecoveryPasses, { passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRecoveryPasses();
  });

  setInterval(reconcileLiveSenders, 2000);
  window.postMessage({ type: 'MIC_MAXIMIZER_READY' }, '*');
})();
