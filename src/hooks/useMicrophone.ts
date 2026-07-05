import { useState, useEffect, useCallback, useRef } from 'react';

export function useMicrophone() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const isInitialMount = useRef(true);

  const stopStream = useCallback(() => {
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach(t => t.stop());
      activeStreamRef.current = null;
    }
    setStream(null);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devs.filter(d => d.kind === 'audioinput');
      setDevices(audioInputs);
      setSelectedDeviceId(current => current || audioInputs[0]?.deviceId || '');
    } catch (err) {
      console.error('Error enumerating microphones:', err);
    }
  }, []);

  const requestMicrophone = useCallback(async (deviceId?: string) => {
    try {
      const targetDeviceId = deviceId !== undefined ? deviceId : selectedDeviceId;

      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: targetDeviceId ? { ideal: targetDeviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        }
      });

      stopStream();
      activeStreamRef.current = s;
      setStream(s);

      await refreshDevices();

      if (!targetDeviceId) {
        const activeDeviceId = s.getAudioTracks()[0]?.getSettings().deviceId;
        if (activeDeviceId) {
          setSelectedDeviceId(activeDeviceId);
        }
      }

      return s;
    } catch (err) {
      console.error('Error accessing microphone:', err);
      return null;
    }
  }, [refreshDevices, selectedDeviceId, stopStream]);

  useEffect(() => {
    void refreshDevices();

    const handleDeviceChange = () => {
      void refreshDevices();
    };

    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);

    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
      stopStream();
    };
  }, [refreshDevices, stopStream]);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (selectedDeviceId && activeStreamRef.current) {
      void requestMicrophone(selectedDeviceId);
    }
  }, [selectedDeviceId, requestMicrophone]);

  return { devices, selectedDeviceId, setSelectedDeviceId, stream, requestMicrophone, refreshDevices };
}
