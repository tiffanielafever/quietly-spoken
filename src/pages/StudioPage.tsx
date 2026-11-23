  // The video is the clock. The cleaned WAV follows it. Small drift is ignored,
  // because each correction is a seek that you can hear as a click.
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (!v || !a || !cleanUrl) return;

    v.muted = mode === 'cleaned';
    a.playbackRate = v.playbackRate;

    const MAX_DRIFT = 0.25;
    const sync = () => {
      if (Math.abs(a.currentTime - v.currentTime) > MAX_DRIFT) a.currentTime = v.currentTime;
    };
    const startAudio = () => {
      if (mode !== 'cleaned') return;
      a.currentTime = v.currentTime;
      a.play().catch(() => undefined);
    };

    if (mode === 'cleaned' && !v.paused) startAudio();
    else a.pause();

    const onPlay = () => startAudio();
    const onPause = () => a.pause();
    const onSeeked = () => { a.currentTime = v.currentTime; };
    const onRate = () => { a.playbackRate = v.playbackRate; };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRate);

    const id = window.setInterval(() => {
      if (mode === 'cleaned' && !v.paused) sync();
    }, 3000);

    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('ratechange', onRate);
      window.clearInterval(id);
    };
  }, [mode, cleanUrl]);