import React, { useRef, useEffect } from 'react';

interface WaveformProps {
  stream: MediaStream | null;
}

export function Waveform({ stream }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    if (!stream || !canvasRef.current) return;

    let cancelled = false;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;

    const startMonitoring = async () => {
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = audioCtx;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.8;

        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
          if (cancelled) return;
          const width = canvas.width;
          const height = canvas.height;

          analyser.getByteFrequencyData(dataArray);
          ctx.clearRect(0, 0, width, height);

          const barWidth = (width / bufferLength) * 2.5;
          let x = 0;

          for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * height;

            const gradient = ctx.createLinearGradient(0, height, 0, 0);
            gradient.addColorStop(0, '#3b82f6');
            gradient.addColorStop(1, '#8b5cf6');

            ctx.fillStyle = gradient;
            const y = (height - barHeight) / 2;

            ctx.beginPath();
            ctx.roundRect(x, y, barWidth - 1, barHeight || 2, 2);
            ctx.fill();

            x += barWidth;
          }

          animationRef.current = requestAnimationFrame(draw);
        };

        draw();
      } catch (err) {
        console.error('Waveform monitor error:', err);
      }
    };

    void startMonitoring();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationRef.current);

      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    };
  }, [stream]);

  return (
    <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-1.5 h-8">
      <canvas ref={canvasRef} width={120} height={28} className="w-[120px] h-[28px]" />
    </div>
  );
}
