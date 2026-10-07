// Connection health follows decoded playback, not iframe load or a retained frame.
export function nativeStreamState(started = Date.now(), inherited = null) {
  let connected = false, stopped = false, transportLost = false, attempts = 0;
  let deadline = started + 120000, retryAt = started + 20000, lastFrame = started;
  if (inherited) {
    ({ deadline, retryAt, attempts, stopped } = inherited);
  }
  return {
    get connected() { return connected; },
    get stopped() { return stopped; },
    nextTransport(now) {
      return nativeStreamState(now, { deadline, retryAt, attempts, stopped });
    },
    transportDisconnected(now) {
      if (stopped || transportLost) return;
      const wasConnected = connected;
      this.disconnected(now);
      transportLost = true;
      // The first failed connection can retry promptly. Later attempts retain
      // their backoff and deadline, even if each new transport closes at once.
      if (!wasConnected && attempts === 0)
        retryAt = Math.min(retryAt, now + 5000);
    },
    progress(now) {
      if (stopped || transportLost) return false;
      const recovered = !connected;
      connected = true;
      lastFrame = now;
      deadline = 0;
      attempts = 0;
      return recovered;
    },
    disconnected(now) {
      if (stopped || transportLost || (!connected && deadline)) return;
      connected = false;
      deadline = now + 120000;
      retryAt = now + 5000;
    },
    stop() { stopped = true; connected = false; },
    tick(now, visible = true) {
      if (stopped) return null;
      if (connected && visible && now - lastFrame > 8000) this.disconnected(now);
      if (connected) return null;
      if (now >= deadline || (attempts >= 5 && now >= retryAt)) {
        this.stop();
        return 'failed';
      }
      if (now < retryAt) return null;
      attempts += 1;
      retryAt = now + Math.min(30000, 5000 * 2 ** attempts);
      return 'reload';
    },
  };
}

export function decodedPlaybackProgress(previousTime, video) {
  return previousTime !== null && video.readyState >= 2 &&
    video.videoWidth > 0 && video.videoHeight > 0 &&
    video.currentTime > previousTime;
}
