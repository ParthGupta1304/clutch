import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Volume2, VolumeX, Sparkles, X, Activity, MessageSquare, Send, Headphones, Check } from 'lucide-react';

interface BodyDoubleVoiceProps {
  onClose?: () => void;
  activeTaskTitle: string;
  activeTaskConsequence: string;
}

export function BodyDoubleVoice({ onClose, activeTaskTitle, activeTaskConsequence }: BodyDoubleVoiceProps) {
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [isMicActive, setIsMicActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');
  const [voiceName, setVoiceName] = useState<string>('Zephyr');
  const [chatLog, setChatLog] = useState<{ sender: 'user' | 'ai' | 'system'; text: string }[]>([
    { sender: 'system', text: 'Live Voice Body-Double is ready. Connect to start your calm focus session.' }
  ]);

  const wsRef = useRef<WebSocket | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Cleanup helper
  const disconnect = () => {
    // Close WebSocket
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    // Stop mic recording processor
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsMicActive(false);

    // Stop and clear any scheduled audio sources
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // ignore
      }
    });
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;

    // Reset AudioContext states
    if (outputAudioCtxRef.current && outputAudioCtxRef.current.state !== 'closed') {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }
    if (inputAudioCtxRef.current && inputAudioCtxRef.current.state !== 'closed') {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }

    setConnectionStatus('disconnected');
    setIsSpeaking(false);
  };

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  // Playback PCM chunks
  const playAudioPCM = (base64Data: string) => {
    try {
      if (!outputAudioCtxRef.current) {
        outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      const audioCtx = outputAudioCtxRef.current;
      
      // Resume if suspended (browser security autoplay policies)
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      // Convert base64 to binary
      const binaryString = window.atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Convert 16-bit signed PCM to Float32
      const numSamples = len / 2;
      const float32Data = new Float32Array(numSamples);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < numSamples; i++) {
        const val = view.getInt16(i * 2, true); // true for little-endian
        float32Data[i] = val / 32768.0;
      }

      // Create AudioBuffer
      const audioBuffer = audioCtx.createBuffer(1, numSamples, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      // Playback Scheduler to avoid clicked overlaps
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);

      const currentTime = audioCtx.currentTime;
      if (nextStartTimeRef.current < currentTime) {
        nextStartTimeRef.current = currentTime;
      }

      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += audioBuffer.duration;

      activeSourcesRef.current.push(source);
      setIsSpeaking(true);

      source.onended = () => {
        // Remove from tracked active sources
        activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
        if (activeSourcesRef.current.length === 0) {
          setIsSpeaking(false);
        }
      };

    } catch (err: any) {
      console.error('PCM playback failed:', err);
    }
  };

  const handleInterrupt = () => {
    setIsSpeaking(false);
    // Stop all scheduled playback
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // ignore
      }
    });
    activeSourcesRef.current = [];
    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    }
  };

  // Capture Microphone Audio at 16kHz
  const startMicCapture = async (ws: WebSocket) => {
    try {
      if (!inputAudioCtxRef.current) {
        inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      const audioCtx = inputAudioCtxRef.current;
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // 2048 sample buffer script processor
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const channelData = e.inputBuffer.getChannelData(0);
        // Convert Float32Array (-1.0 to 1.0) to signed 16-bit Int (little-endian bytes)
        const buffer = new ArrayBuffer(channelData.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < channelData.length; i++) {
          const s = Math.max(-1, Math.min(1, channelData[i]));
          const intSample = s < 0 ? s * 0x8000 : s * 0x7FFF;
          view.setInt16(i * 2, intSample, true); // true for little endian
        }

        // Convert byte buffer to base64
        const uint8 = new Uint8Array(buffer);
        let binary = '';
        const len = uint8.length;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        const base64 = btoa(binary);

        ws.send(JSON.stringify({ audio: base64 }));
      };

      setIsMicActive(true);
      setChatLog(prev => [...prev, { sender: 'system', text: 'Microphone stream is live.' }]);
    } catch (err: any) {
      console.error('Failed to capture microphone:', err);
      setErrorMessage(`Microphone access denied or error: ${err.message || err}. You can still interact with text!`);
      // Fail gracefully so they can type instead
      setIsMicActive(false);
    }
  };

  const stopMicCapture = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsMicActive(false);
    setChatLog(prev => [...prev, { sender: 'system', text: 'Microphone muted.' }]);
  };

  const connectToLiveBodyDouble = () => {
    try {
      disconnect();
      setConnectionStatus('connecting');
      setErrorMessage(null);

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/live-body-double?voice=${voiceName}`;
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('connected');
        setChatLog([
          { sender: 'system', text: `Connected! Let's get focused.` },
          { sender: 'ai', text: `Hi there! I am your gentle voice companion today. What is the single tiny thing you'll start on right now?` }
        ]);
        
        // Auto-greet user using Web Speech fallback if the Live audio stream hasn't started, or initiate mic capture
        startMicCapture(ws);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          if (msg.type === 'audio' && msg.audio) {
            playAudioPCM(msg.audio);
          } else if (msg.type === 'interrupted') {
            handleInterrupt();
          } else if (msg.type === 'status' && msg.status === 'ready') {
            // Keep in connection active state
          } else if (msg.type === 'text') {
            setChatLog(prev => [...prev, { sender: 'ai', text: msg.text }]);
          } else if (msg.type === 'error') {
            setErrorMessage(msg.error);
            setConnectionStatus('error');
          }
        } catch (e) {
          console.error('Error parsing WebSocket message:', e);
        }
      };

      ws.onerror = (e) => {
        console.error('WebSocket connection error:', e);
        setErrorMessage('Could not connect to voice companion server.');
        setConnectionStatus('error');
      };

      ws.onclose = () => {
        setConnectionStatus('disconnected');
        setChatLog(prev => [...prev, { sender: 'system', text: 'Voice companion session ended.' }]);
      };

    } catch (err: any) {
      setErrorMessage(err.message || 'WebSocket configuration failed.');
      setConnectionStatus('error');
    }
  };

  const sendTextMessage = () => {
    if (!textInput.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    const textToSend = textInput.trim();
    setChatLog(prev => [...prev, { sender: 'user', text: textToSend }]);
    
    // Also send through WebSocket as text input if supported by downstream parser
    wsRef.current.send(JSON.stringify({ text: textToSend }));
    setTextInput('');
  };

  return (
    <div className="bg-slate-50 border border-slate-150 rounded-2xl p-5 md:p-6 space-y-4" id="body-double-widget">
      <div className="flex items-center justify-between border-b border-slate-200 pb-3">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 rounded-lg bg-rose-50 text-rose-600">
            <Headphones className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-slate-800 font-mono flex items-center gap-1.5 leading-tight">
              Gemini Voice Body-Double
              <span className="text-[9px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                Live API
              </span>
            </h4>
            <p className="text-[10px] text-slate-500 font-mono">Calm, non-judgmental partner for task unblocking</p>
          </div>
        </div>

        {onClose && (
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Voice selection & main trigger */}
      {connectionStatus === 'disconnected' ? (
        <div className="space-y-4 py-2 text-center" id="voice-companion-unconnected">
          <p className="text-xs text-slate-600 max-w-sm mx-auto leading-relaxed font-mono">
            Planning to start working on <strong>"{activeTaskTitle}"</strong>? Let's connect the Voice Body-Double companion, who will greet you, stay present silently, and gently check in of your progress.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <div className="flex items-center space-x-2 font-mono text-xs">
              <span className="text-slate-450 text-[10px] uppercase font-bold">Voice:</span>
              <select 
                value={voiceName} 
                onChange={(e) => setVoiceName(e.target.value)}
                className="bg-white border border-slate-250 hover:border-slate-350 text-slate-700 text-xs rounded px-2.5 py-1 outline-none font-mono font-medium"
              >
                <option value="Zephyr">Zephyr (Calm Warm Male)</option>
                <option value="Kore">Kore (Clear Energetic Female)</option>
                <option value="Puck">Puck (Cheerful Bright)</option>
                <option value="Charon">Charon (Deep Solid)</option>
                <option value="Fenrir">Fenrir (Relaxed Soft)</option>
              </select>
            </div>

            <button
              onClick={connectToLiveBodyDouble}
              className="bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold font-mono px-5 py-2 rounded-lg cursor-pointer flex items-center gap-1.5 shadow"
            >
              <Sparkles className="w-3.5 h-3.5 fill-white" />
              <span>Connect Companion</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4" id="voice-companion-active">
          
          {/* Status Indicator Bar */}
          <div className="p-3 bg-white border border-slate-150 rounded-xl flex items-center justify-between gap-3 text-xs font-mono">
            <div className="flex items-center space-x-2">
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  connectionStatus === 'connected' ? 'bg-emerald-400' : 'bg-rose-400'
                }`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${
                  connectionStatus === 'connected' ? 'bg-emerald-500' : 'bg-amber-500'
                }`}></span>
              </span>

              <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px]">
                {connectionStatus === 'connecting' ? 'Connecting...' : `Companion (${voiceName}) Live`}
              </span>
            </div>

            {/* Speaking/listening pulses */}
            <div className="flex items-center gap-2">
              {isSpeaking && (
                <span className="flex items-center gap-1 bg-rose-50 text-rose-600 px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider">
                  <Volume2 className="w-3 h-3 animate-bounce" />
                  <span>Speaking</span>
                </span>
              )}

              {isMicActive ? (
                <button
                  onClick={stopMicCapture}
                  className="flex items-center gap-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider cursor-pointer"
                  title="Click to mute microphone"
                >
                  <Activity className="w-3 h-3 animate-pulse" />
                  <span>Mic ON • Listening</span>
                </button>
              ) : (
                connectionStatus === 'connected' && (
                  <button
                    onClick={() => {
                      if (wsRef.current) startMicCapture(wsRef.current);
                    }}
                    className="flex items-center gap-1 bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider cursor-pointer"
                    title="Click to unmute microphone"
                  >
                    <MicOff className="w-3 h-3" />
                    <span>Muted • Unmute</span>
                  </button>
                )
              )}
            </div>

            <button
              onClick={disconnect}
              className="text-[10px] uppercase font-bold text-slate-500 hover:text-slate-800 transition-colors cursor-pointer underline"
            >
              End Session
            </button>
          </div>

          {/* Activity Dialog Feed */}
          <div className="bg-slate-900 rounded-xl p-3 h-40 overflow-y-auto space-y-2 text-xs font-mono select-none" id="voice-dialog-box">
            {chatLog.map((log, idx) => (
              <div 
                key={idx} 
                className={`py-0.5 ${
                  log.sender === 'system' ? 'text-slate-500 text-center text-[10px]' :
                  log.sender === 'user' ? 'text-blue-300' : 'text-rose-100 font-medium'
                }`}
              >
                {log.sender === 'user' && <span>You: </span>}
                {log.sender === 'ai' && <span className="text-amber-400 font-bold">Companion: </span>}
                <span>{log.text}</span>
              </div>
            ))}
          </div>

          {/* Text input channel fallback (if mic blocked) */}
          <div className="flex gap-2" id="voice-companion-text-fallback">
            <input
              type="text"
              placeholder="Or type a supportive response here..."
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendTextMessage();
              }}
              disabled={connectionStatus !== 'connected'}
              className="flex-grow bg-white border border-slate-200 text-xs rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-rose-500 font-mono text-slate-700"
            />
            <button
              onClick={sendTextMessage}
              disabled={connectionStatus !== 'connected'}
              className="bg-slate-900 hover:bg-slate-800 text-white p-2 px-3 rounded-lg text-xs font-mono flex items-center justify-center cursor-pointer transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>

        </div>
      )}

      {errorMessage && (
        <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-[11px] text-red-600 font-mono leading-relaxed" id="voice-error-log">
          ⚠️ {errorMessage}
        </div>
      )}
    </div>
  );
}
