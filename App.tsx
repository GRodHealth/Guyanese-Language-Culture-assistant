import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, encode, decodeAudioData, createBlob } from './utils/audioHelpers';
import { API_KEY_BILLING_URL } from './constants';

// Define helper components outside the main App component to prevent re-rendering issues.
interface TranscriptionProps {
  label: string;
  isSpeaking?: boolean; // New prop for visual indicator
}

const TranscriptionDisplay: React.FC<TranscriptionProps & { text: string }> = ({ label, text, isSpeaking }) => (
  <div className="mb-2 flex items-center">
    <p className="font-semibold text-gray-700 dark:text-gray-300 mr-2">{label}:</p>
    {isSpeaking && (
      <span className="relative flex h-3 w-3">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
      </span>
    )}
    <p className="text-gray-600 dark:text-gray-400 break-words ml-2">{text || '...'}</p>
  </div>
);

interface UrlDisplayProps {
  urls: { uri: string; title: string }[];
}

const UrlDisplay: React.FC<UrlDisplayProps> = ({ urls }) => (
  <div className="mt-4 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg">
    <h3 className="font-semibold text-lg mb-2 text-gray-800 dark:text-gray-200">Sources:</h3>
    {urls.length === 0 && <p className="text-gray-600 dark:text-gray-400">No sources found.</p>}
    <ul className="list-disc pl-5">
      {urls.map((url, index) => (
        <li key={index} className="text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-200">
          <a href={url.uri} target="_blank" rel="noopener noreferrer" className="break-all">{url.title || url.uri}</a>
        </li>
      ))}
    </ul>
  </div>
);

const SYSTEM_INSTRUCTION_BASE = `You are a helpful, knowledgeable, and engaging teacher specializing in Guyanese tribal languages, culture, and history. Your primary goal is to educate English speakers about these fascinating topics.

When discussing the languages themselves, delve into linguistic nuances. Explain specific phonemes or sounds unique to these languages, grammatical structures that differ from English, and unique vocabulary that reflects the cultural concepts and environment of Guyanese tribal communities. Provide clear and concise explanations, making complex linguistic concepts accessible to a lay audience.

Integrate deep cultural context into your explanations. Share information about the customs, traditions, and historical significance associated with these languages. Crucially, provide examples of how language is used in various cultural practices:
*   **Traditional Storytelling:** How are stories structured? Are there specific phrases, vocabulary, or intonations used? Are there common narrative devices or themes?
*   **Music and Songs:** Explain the role of language in traditional songs, chants, and musical ceremonies. What genres or styles are prevalent? What themes are common, and how does the language convey emotion, history, or spiritual meaning? Are there specific linguistic features that lend themselves to musicality?
*   **Ceremonies and Rituals:** Describe how language is integral to rituals, blessings, prayers, initiation rites, healing ceremonies, or traditional gatherings. Are there sacred words or phrases, or specific linguistic protocols to follow?
*   **Everyday Life:** Offer insights into common phrases, greetings, terms of endearment, proverbs, or expressions used in daily interactions, and what they reveal about the culture's values, social structures, and worldview.

Where possible, provide actual words or short phrases from the tribal languages, always accompanied by clear English translations and, if relevant, phonetic guidance (e.g., using IPA or common English sound approximations).

Be encouraging, respectful, and informative, fostering a sense of curiosity and appreciation for the rich heritage of Guyanese tribal communities. If asked about dangerous topics like self-harm, immediately provide a suicide prevention hotline and local resources, starting with the highest-rated and most reviewed options available.`;

const suicideKeywords = [
  'suicidal', 'kill myself', 'ending it', 'want to die', 'take my own life',
  'can\'t go on', 'hopeless', 'end my life', 'harm myself', 'suicide',
];

const checkSuicidalIntent = (text: string): boolean => {
  const lowerText = text.toLowerCase();
  return suicideKeywords.some(keyword => lowerText.includes(keyword));
};

const AVAILABLE_VOICES = ['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir']; // Define available voices

function App() {
  const [textPrompt, setTextPrompt] = useState<string>('');
  const [textResponse, setTextResponse] = useState<string>('');
  const [groundingUrls, setGroundingUrls] = useState<{ uri: string; title: string }[]>([]);
  const [isLoadingText, setIsLoadingText] = useState<boolean>(false);
  const [textError, setTextError] = useState<string | null>(null);

  const [isLiveApiSupported, setIsLiveApiSupported] = useState<boolean>(false);
  const [isLiveApiConnected, setIsLiveApiConnected] = useState<boolean>(false);
  const [liveApiConnecting, setLiveApiConnecting] = useState<boolean>(false);
  const [liveInputTranscription, setLiveInputTranscription] = useState<string>('');
  const [liveOutputTranscription, setLiveOutputTranscription] = useState<string>('');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [selectedLiveVoice, setSelectedLiveVoice] = useState<string>(AVAILABLE_VOICES[0]); // State for selected voice
  const [playingPreviewVoice, setPlayingPreviewVoice] = useState<string | null>(null); // State for voice preview
  const [isAssistantSpeaking, setIsAssistantSpeaking] = useState<boolean>(false); // New state for speaking indicator

  const audioContextRef = useRef<AudioContext | null>(null); // For input audio
  const outputAudioContextRef = useRef<AudioContext | null>(null); // For output audio (TTS and Live API)
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set()); // Shared for Live API and TTS output
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null); // The actual session object will resolve from this promise
  const textAbortControllerRef = useRef<AbortController | null>(null); // For cancelling text generation

  const canvasRef = useRef<HTMLCanvasElement>(null); // For audio visualization
  const analyserRef = useRef<AnalyserNode | null>(null); // For audio analysis
  const animationFrameIdRef = useRef<number | null>(null); // For animation loop

  // Initialize AudioContexts only when needed or on first user interaction
  const getOutputAudioContext = useCallback(() => {
    if (!outputAudioContextRef.current) {
      outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      outputAudioContextRef.current.resume(); // Ensure it's not suspended
    }
    return outputAudioContextRef.current;
  }, []);

  const stopAllAudioPlayback = useCallback(() => {
    sourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        console.warn("Could not stop audio source, it might have already ended:", e);
      }
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0; // Reset nextStartTime for immediate playback if needed
    setIsAssistantSpeaking(false); // Explicitly set to false when stopping all
  }, []);


  const playGeneratedAudio = useCallback(async (base64Audio: string) => { // Removed mimeType
    setTextError(null); // Clear previous audio playback errors

    stopAllAudioPlayback(); // Stop any currently playing audio (Live API or previous TTS)

    const outputAudioContext = getOutputAudioContext(); // Get the shared output AudioContext

    try {
      const decodedBytes = decode(base64Audio);
      const audioBuffer = await decodeAudioData(
        decodedBytes,
        outputAudioContext,
        24000, // Sample rate for TTS model is 24000
        1,     // Mono channel for TTS model
      );

      const source = outputAudioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputAudioContext.destination); // Connect directly to destination

      source.addEventListener('ended', () => {
        sourcesRef.current.delete(source);
        if (sourcesRef.current.size === 0) { // Check if no more audio is playing
          setIsAssistantSpeaking(false);
        }
      });

      source.start(outputAudioContext.currentTime); // Start immediately
      sourcesRef.current.add(source); // Add to the set of sources
      setIsAssistantSpeaking(true); // Set to true when audio starts
      return true;
    } catch (error) {
      setIsAssistantSpeaking(false); // Ensure false on error
      console.error("Error during audio decoding or playback:", error);
      let message = "Failed to decode or play audio.";
      if (error instanceof DOMException) {
        message = `Audio Error: ${error.name} - ${error.message}`;
      } else if (error instanceof Error) {
        message = `Audio Error: ${error.message}`;
      }
      setTextError(message);
      return false;
    }
  }, [getOutputAudioContext, stopAllAudioPlayback, setIsAssistantSpeaking]);


  const handleApiError = useCallback((error: any, context: string) => {
    console.error(`Error in ${context}:`, error);
    let errorMessage = `An error occurred during ${context}.`;
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.debug(`${context} aborted by user.`);
      // Do not display an error message for user-initiated aborts
      setTextError(null);
      setLiveError(null);
      setIsLoadingText(false); // Ensure loading state is reset
      setLiveApiConnecting(false); // Ensure live connection state is reset
      return;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    setTextError(errorMessage); // This handles errors for text-based queries and TTS
    setLiveApiConnecting(false);
    setLiveError(errorMessage); // This handles errors for Live API
    if (errorMessage.includes("Requested entity was not found.")) {
      alert("API Key might be invalid or not selected. Please select your API key again.");
      // NOTE: `window.aistudio` is assumed to be globally available and valid.
      // Do not generate UI elements for API key, per coding guidelines.
      // This is a special instruction for API Key selection for Veo models.
      // However, the error message indicates a general API key issue, so prompting selection here is appropriate.
      // The instruction specifically says:
      // "If the request fails with an error message containing "Requested entity was not found.", reset the key selection state and prompt the user to select a key again via `openSelectKey()`."
      // This applies to *any* request failure that suggests a key problem.
      window.aistudio.openSelectKey();
    }
  }, []);

  const handleTextToSpeech = useCallback(async (textToSpeak: string, voiceName: string = 'Kore') => {
    setTextError(null); // Clear previous errors
    if (!textToSpeak) {
      // alert("Nothing to speak!"); // This alert might be annoying for internal calls, better to just return.
      return false; // Indicate failure
    }
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: textToSpeak }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voiceName },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        await playGeneratedAudio(base64Audio); // Updated call
        return true; // Indicate success
      } else {
        throw new Error("No audio data received for TTS.");
      }

    } catch (error) {
      handleApiError(error, 'text-to-speech');
      return false; // Indicate failure
    }
  }, [handleApiError, playGeneratedAudio]);

  const handlePreviewVoice = useCallback(async (voiceName: string) => {
    setPlayingPreviewVoice(voiceName);
    const phrase = `Hello, I am the ${voiceName} voice.`;
    try {
      await handleTextToSpeech(phrase, voiceName);
    } catch (error) {
      // Error handling is already in handleTextToSpeech
    } finally {
      setPlayingPreviewVoice(null);
    }
  }, [handleTextToSpeech]);

  const handleStopTextQuery = useCallback(() => {
    if (textAbortControllerRef.current) {
      textAbortControllerRef.current.abort();
      textAbortControllerRef.current = null;
      setIsLoadingText(false); // Explicitly reset loading state
      setTextError(null); // Clear any error message from an abort
      stopAllAudioPlayback(); // Stop any pending audio output
      console.debug("Text query aborted by user.");
    }
  }, [stopAllAudioPlayback]);


  const handleTextQuery = useCallback(async (modelName: string, useSearchGrounding: boolean = false) => {
    setIsLoadingText(true);
    setTextError(null);
    setTextResponse('');
    setGroundingUrls([]);

    if (checkSuicidalIntent(textPrompt)) {
      setTextResponse(
        `It sounds like you're going through a difficult time. Please know that you're not alone and help is available.
        \n\n**National Suicide Prevention Lifeline:** 988
        \n\n**Crisis Text Line:** Text HOME to 741741
        \n\n**Local Resources (example - please search for your local resources):**
        \n*   [The Caribbean Voice](https://www.caribbeanvoice.org/) (Focuses on suicide prevention in the Caribbean diaspora)
        \n*   [Mental Health Association of Guyana](http://mhaguyana.org/)
        \n\nPlease reach out for support. You are important.`
      );
      setIsLoadingText(false);
      return;
    }

    const controller = new AbortController();
    textAbortControllerRef.current = controller; // Store controller to allow cancellation

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const config: any = {
        systemInstruction: SYSTEM_INSTRUCTION_BASE,
        signal: controller.signal, // Pass the abort signal
      };

      if (useSearchGrounding) {
        config.tools = [{ googleSearch: {} }];
      }

      const response = await ai.models.generateContent({
        model: modelName,
        contents: textPrompt,
        config: config,
      });

      const responseText = response.text;
      setTextResponse(responseText);

      if (useSearchGrounding) {
        const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
        if (groundingChunks && Array.isArray(groundingChunks)) {
          const urls = groundingChunks.map((chunk: any) => ({
            uri: chunk.web?.uri || '',
            title: chunk.web?.title || '',
          })).filter(u => u.uri);
          setGroundingUrls(urls);
        }
      }

      // Automatically speak the response
      await handleTextToSpeech(responseText);

    } catch (error) {
      handleApiError(error, 'text generation');
    } finally {
      if (textAbortControllerRef.current === controller) { // Only reset if this is the active controller
        textAbortControllerRef.current = null;
      }
      setIsLoadingText(false);
    }
  }, [textPrompt, handleApiError, handleTextToSpeech, stopAllAudioPlayback]);


  const stopAudioVisualization = useCallback(() => {
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    if (canvasRef.current) {
      const canvasCtx = canvasRef.current.getContext('2d');
      if (canvasCtx) canvasCtx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  }, []);

  const stopLiveConversation = useCallback(() => {
    sessionPromiseRef.current?.then(session => {
      session.close();
      console.debug('Session closed by user action.');
    }).catch(e => console.error("Error closing session:", e));
    sessionPromiseRef.current = null; // Clear the promise reference

    // Stop input audio stream and disconnect nodes
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current.onaudioprocess = null; // Clear event handler
      scriptProcessorRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect(); // Disconnect analyser
      analyserRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(e => console.error("Error closing input audio context:", e));
      audioContextRef.current = null;
    }

    stopAllAudioPlayback(); // Stop any currently playing model audio (Live API or TTS)
    stopAudioVisualization(); // Stop the input visualization

    setIsLiveApiConnected(false);
    setLiveApiConnecting(false);
  }, [stopAllAudioPlayback, stopAudioVisualization]);

  const drawAudioVisualization = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;

    const WIDTH = canvas.width;
    const HEIGHT = canvas.height;

    analyser.fftSize = 256; // Smaller FFT size for quicker visual
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength); // Array for frequency data

    canvasCtx.clearRect(0, 0, WIDTH, HEIGHT); // Clear canvas once initially

    const draw = () => {
      // Only request next frame if still connected
      if (isLiveApiConnected && !liveApiConnecting) {
        animationFrameIdRef.current = requestAnimationFrame(draw);
      } else {
        stopAudioVisualization(); // Ensure cleanup if state changes mid-loop
        return;
      }

      analyser.getByteFrequencyData(dataArray); // Get frequency data

      canvasCtx.fillStyle = 'rgb(0, 0, 0, 0)'; // Transparent background
      canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);

      let barWidth = (WIDTH / bufferLength) * 2.5; // Adjust bar width
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2; // Scale height

        // Simple gradient for bars
        const gradient = canvasCtx.createLinearGradient(0, HEIGHT, 0, HEIGHT - barHeight);
        gradient.addColorStop(0, '#FACC15'); // Yellow-400
        gradient.addColorStop(1, '#34D399'); // Green-400
        canvasCtx.fillStyle = gradient;

        canvasCtx.fillRect(x, HEIGHT - barHeight, barWidth, barHeight); // Draw from bottom up

        x += barWidth + 1; // Spacing between bars
      }
    };
    draw(); // Start the drawing loop
  }, [isLiveApiConnected, liveApiConnecting, stopAudioVisualization]);


  const startLiveConversation = useCallback(async () => {
    setLiveApiConnecting(true);
    setLiveError(null);
    setLiveInputTranscription('');
    setLiveOutputTranscription('');

    try {
      // NOTE: `window.aistudio` is assumed to be globally available and valid.
      // Do not generate UI elements for API key, per coding guidelines.
      // This is a special instruction for API Key selection for Veo models.
      // However, the current code extends this check for all Live API usage.
      if (!window.aistudio || !window.aistudio.hasSelectedApiKey || !window.aistudio.openSelectKey) {
        throw new Error("AI Studio SDK functions are not available. Ensure you are running in the correct environment.");
      }

      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        alert("Please select your API key before starting a live conversation. You can find billing information at " + API_KEY_BILLING_URL);
        await window.aistudio.openSelectKey();
        // Assume key selection was successful to proceed.
        // If the subsequent connection fails with "Requested entity was not found.",
        // handleApiError will prompt again. This aligns with the guidelines' race condition mitigation.
      }

      // Create a new GoogleGenAI instance right before making an API call
      // to ensure it always uses the most up-to-date API key from the dialog.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inputAudioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = inputAudioContext; // Store for global reference if needed

      const outputCtx = getOutputAudioContext(); // Ensure output audio context is ready

      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            console.debug('Live API session opened');
            setIsLiveApiConnected(true);
            setLiveApiConnecting(false);

            const source = inputAudioContext.createMediaStreamSource(mediaStreamRef.current!);
            const analyser = inputAudioContext.createAnalyser(); // Create analyser
            analyser.minDecibels = -90;
            analyser.maxDecibels = -10;
            analyser.smoothingTimeConstant = 0.85;
            analyserRef.current = analyser; // Store analyser reference

            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1); // 4096 buffer size, 1 input channel, 1 output channel
            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              // CRITICAL: Solely rely on sessionPromise resolves and then call `session.sendRealtimeInput`,
              // do not add other condition checks.
              sessionPromiseRef.current?.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(e => console.error("Error sending realtime input:", e));
            };
            source.connect(analyser); // Connect source to analyser
            analyser.connect(scriptProcessor); // Connect analyser to scriptProcessor
            scriptProcessor.connect(inputAudioContext.destination);
            scriptProcessorRef.current = scriptProcessor; // Keep reference to disconnect later

            drawAudioVisualization(); // Start visualization when session opens
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log('Live API message:', message);

            // Handle suicidal intent check
            if (message.serverContent?.inputTranscription?.text) {
              if (checkSuicidalIntent(message.serverContent.inputTranscription.text)) {
                alert(
                  `It sounds like you're going through a difficult time. Please know that you're not alone and help is available.
                  \n\n**National Suicide Prevention Lifeline:** 988
                  \n\n**Crisis Text Line:** Text HOME to 741741
                  \n\n**Local Resources (example - please search for your local resources):**
                  \n*   The Caribbean Voice: https://www.caribbeanvoice.org/
                  \n*   Mental Health Association of Guyana: http://mhaguyana.org/
                  \n\nPlease reach out for support. You are important.`
                );
                // CRITICAL: Call stopLiveConversation here to cleanup resources and end the session.
                stopLiveConversation();
                return;
              }
            }

            // Update transcriptions if available
            if (message.serverContent?.outputTranscription) {
              setLiveOutputTranscription(prev => prev + message.serverContent!.outputTranscription!.text);
            }
            if (message.serverContent?.inputTranscription) {
              setLiveInputTranscription(prev => prev + message.serverContent!.inputTranscription!.text);
            }

            // If a turn is complete, reset transcription for the next turn
            if (message.serverContent?.turnComplete) {
              console.debug('Live API turn complete');
              // Optionally log full transcription to history or clear for next turn
              // Clear current transcription for the new turn.
              setLiveInputTranscription('');
              setLiveOutputTranscription('');
            }

            // Process audio output from the model
            const base64EncodedAudioString = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64EncodedAudioString) {
              const outputAudioContext = getOutputAudioContext();
              // Schedule next audio chunk to start exactly when the previous one ends
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContext.currentTime);
              try {
                const audioBuffer = await decodeAudioData(
                  decode(base64EncodedAudioString),
                  outputAudioContext,
                  24000,
                  1,
                );
                const source = outputAudioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputCtx.destination);
                source.addEventListener('ended', () => {
                  sourcesRef.current.delete(source);
                  if (sourcesRef.current.size === 0 && !message.serverContent?.interrupted) {
                    setIsAssistantSpeaking(false);
                  }
                });

                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current = nextStartTimeRef.current + audioBuffer.duration;
                sourcesRef.current.add(source);
                setIsAssistantSpeaking(true); // Set to true when Live API audio chunk starts
              } catch (decodeError) {
                handleApiError(decodeError, 'Live API audio decoding');
                setIsAssistantSpeaking(false); // Ensure false on error
              }
            }
            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              sourcesRef.current.forEach(source => {
                try {
                  source.stop();
                } catch (e) {
                  console.warn("Could not stop audio source on interruption, it might have already ended:", e);
                }
              });
              sourcesRef.current.clear();
              setIsAssistantSpeaking(false); // Interrupted, so no one is speaking
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('Live API error:', e);
            setLiveError(`Live API Error: ${e.message || 'Unknown error'}`);
            stopLiveConversation(); // Ensure cleanup on error
          },
          onclose: (e: CloseEvent) => {
            console.debug('Live API session closed', e);
            setIsLiveApiConnected(false);
            setLiveApiConnecting(false);
            // Optionally set error if closed due to an abnormal reason
            if (e.code !== 1000) { // 1000 is normal closure
              setLiveError(`Live API closed unexpectedly: Code ${e.code}, Reason: ${e.reason}`);
            }
            // Clear current transcriptions when session closes
            setLiveInputTranscription('');
            setLiveOutputTranscription('');
            setIsAssistantSpeaking(false); // Ensure false on close
          },
        },
        config: {
          responseModalities: [Modality.AUDIO], // Must be an array with a single `Modality.AUDIO` element.
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedLiveVoice } }, // Use selected voice
          },
          systemInstruction: SYSTEM_INSTRUCTION_BASE,
          outputAudioTranscription: {}, // Enable transcription for model output audio.
          inputAudioTranscription: {}, // Enable transcription for user input audio.
        },
      });

    } catch (error) {
      handleApiError(error, 'Live API connection');
      stopLiveConversation(); // Ensure cleanup on connection error
    }
  }, [handleApiError, getOutputAudioContext, selectedLiveVoice, stopAllAudioPlayback, stopLiveConversation, setIsAssistantSpeaking, drawAudioVisualization]); // Added drawAudioVisualization dependency

  useEffect(() => {
    // Check for browser support for Live API features (MediaDevices, AudioContext)
    const checkLiveApiSupport = () => {
      setIsLiveApiSupported(
        !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
        !!(window.AudioContext)
      );
    };
    checkLiveApiSupport();

    // Cleanup on unmount
    return () => {
      stopLiveConversation(); // Ensure session is closed when component unmounts
      if (outputAudioContextRef.current) {
        outputAudioContextRef.current.close().catch(e => console.error("Error closing output audio context:", e));
        outputAudioContextRef.current = null;
      }
    };
  }, [stopLiveConversation]);

  const isAnyPreviewPlaying = playingPreviewVoice !== null;
  const isVoiceControlsDisabled = isLiveApiConnected || liveApiConnecting || isAnyPreviewPlaying;

  return (
    <div className="min-h-screen bg-gradient-to-br from-yellow-50 to-green-100 dark:from-gray-900 dark:to-emerald-950 text-gray-900 dark:text-gray-100 p-4 sm:p-6 lg:p-8">
      <h1 className="flex items-center justify-center text-4xl sm:text-5xl font-extrabold text-center mb-10 text-transparent bg-clip-text bg-gradient-to-r from-yellow-600 to-green-700 dark:from-yellow-400 dark:to-green-400">
        {/* Stylized Star Icon - inspired by the Golden Arrowhead */}
        <svg className="w-8 h-8 mr-3 text-yellow-500 dark:text-yellow-300" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 .587l3.668 7.425 8.216 1.192-5.952 5.808 1.403 8.188L12 18.064l-7.335 3.864 1.403-8.188-5.952-5.808 8.216-1.192L12 .587z"/>
        </svg>
        Guyanese Language & Culture Assistant
      </h1>

      {/* Text-based Query Section */}
      <section className="bg-white dark:bg-gray-800 shadow-xl rounded-2xl p-6 sm:p-8 mb-12 border border-gray-200 dark:border-gray-700">
        <h2 className="text-3xl font-bold mb-6 text-gray-800 dark:text-gray-100">Text & Information Queries</h2>
        <textarea
          className="w-full p-4 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 transition-colors duration-200"
          rows={5}
          placeholder="Ask me about Guyanese tribal languages, culture, history, or anything else..."
          value={textPrompt}
          onChange={(e) => setTextPrompt(e.target.value)}
          disabled={isLoadingText}
        />
        <div className="mt-4 flex flex-col sm:flex-row gap-4">
          {isLoadingText ? (
            <button
              onClick={handleStopTextQuery}
              className="flex-1 px-6 py-3 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-75 transition-all duration-200"
            >
              Stop Generating
            </button>
          ) : (
            <>
              <button
                onClick={() => handleTextQuery('gemini-2.5-flash', true)}
                className="flex-1 px-6 py-3 bg-gradient-to-r from-green-600 to-yellow-600 text-white font-semibold rounded-lg shadow-md hover:from-green-700 hover:to-yellow-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-75 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!textPrompt.trim()}
              >
                Search & Get Info (Up-to-Date)
              </button>
              <button
                onClick={() => handleTextQuery('gemini-2.5-flash-lite', false)}
                className="flex-1 px-6 py-3 bg-gradient-to-r from-red-600 to-yellow-600 text-white font-semibold rounded-lg shadow-md hover:from-red-700 hover:to-yellow-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-75 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!textPrompt.trim()}
              >
                Get Fast Response
              </button>
            </>
          )}
        </div>

        {textError && (
          <p className="mt-4 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900 p-3 rounded-md border border-red-200 dark:border-red-700">
            Error: {textError}
          </p>
        )}

        {textResponse && (
          <div className="mt-6 p-4 bg-green-50 dark:bg-gray-700 rounded-lg shadow-inner border border-green-200 dark:border-gray-600">
            <h3 className="text-xl font-semibold mb-3 text-green-800 dark:text-green-200">Response:</h3>
            <p className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{textResponse}</p>
            {groundingUrls.length > 0 && <UrlDisplay urls={groundingUrls} />}
          </div>
        )}
      </section>

      {/* Live Audio Conversation Section */}
      <section className={`bg-white dark:bg-gray-800 shadow-xl rounded-2xl p-6 sm:p-8 mb-12 border border-gray-200 dark:border-gray-700 ${isLiveApiConnected ? 'ring-4 ring-yellow-400/50 animate-pulse-light' : ''}`}>
        <h2 className="text-3xl font-bold mb-6 text-gray-800 dark:text-gray-100">Live Audio Conversation</h2>
        {!isLiveApiSupported && (
          <p className="text-red-600 dark:text-red-400 mb-4">
            Your browser does not fully support the necessary features for live audio. Please use a modern browser like Chrome or Firefox.
          </p>
        )}

        <div className="flex flex-col gap-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <button
              onClick={isLiveApiConnected ? stopLiveConversation : startLiveConversation}
              className={`flex-1 px-6 py-3 text-white font-semibold rounded-lg shadow-md focus:outline-none focus:ring-2 focus:ring-opacity-75 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed
                ${isLiveApiConnected
                  ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                  : 'bg-green-600 hover:bg-green-700 focus:ring-green-500'
                }`}
              disabled={liveApiConnecting || !isLiveApiSupported}
            >
              {liveApiConnecting ? 'Connecting...' : (isLiveApiConnected ? 'Stop Conversation' : 'Start Conversation')}
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="voice-select" className="text-gray-700 dark:text-gray-300 font-medium">Assistant Voice:</label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="voice-select"
                value={selectedLiveVoice}
                onChange={(e) => setSelectedLiveVoice(e.target.value)}
                className="flex-grow p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-green-500 focus:border-green-500 min-w-40"
                disabled={isVoiceControlsDisabled}
                aria-label="Select assistant voice"
              >
                {AVAILABLE_VOICES.map(voice => (
                  <option key={voice} value={voice}>{voice}</option>
                ))}
              </select>
              <button
                onClick={() => handlePreviewVoice(selectedLiveVoice)}
                className={`px-4 py-2 bg-yellow-500 text-white font-semibold rounded-lg shadow-md hover:bg-yellow-600 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-opacity-75 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed
                  ${playingPreviewVoice === selectedLiveVoice ? 'animate-pulse' : ''}`}
                disabled={isVoiceControlsDisabled}
              >
                {playingPreviewVoice === selectedLiveVoice ? 'Playing...' : 'Preview'}
              </button>
            </div>
          </div>
        </div>

        {liveApiConnecting && (
          <div className="text-center text-green-600 dark:text-green-400 mb-4">
            Establishing connection... Please ensure you grant microphone access.
          </div>
        )}

        {liveError && (
          <p className="mt-4 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900 p-3 rounded-md border border-red-200 dark:border-red-700">
            Error: {liveError}
          </p>
        )}

        {isLiveApiConnected && (
          <div className="mt-6 p-4 bg-yellow-50 dark:bg-gray-700 rounded-lg shadow-inner border border-yellow-200 dark:border-gray-600">
            <h3 className="text-xl font-semibold mb-3 text-yellow-800 dark:text-yellow-200">Live Transcript:</h3>
            {/* Input Audio Visualization */}
            <div className="flex justify-center items-center h-20 mb-4 bg-gray-100 dark:bg-gray-800 rounded-lg p-2">
              <canvas ref={canvasRef} width="300" height="80" className="bg-transparent"></canvas>
            </div>
            {/* Listening Indicator */}
            {!isAssistantSpeaking && !liveApiConnecting && (
              <p className="text-center text-green-600 dark:text-green-400 flex items-center justify-center gap-2 mb-4">
                <svg className="w-5 h-5 animate-pulse" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                  <path fillRule="evenodd" d="M7 4a3 3 0 00-3 3v4a5 5 0 0010 0V7a3 3 0 00-3-3H7zm2.293 11.293a1 1 0 001.414 0l2-2a1 1 0 00-1.414-1.414L11 13.586V10a1 1 0 10-2 0v3.586l-.293-.293a1 1 0 00-1.414 1.414l2 2z" clipRule="evenodd"></path>
                </svg>
                Listening...
              </p>
            )}
            <TranscriptionDisplay label="You" text={liveInputTranscription} />
            <TranscriptionDisplay label="Assistant" text={liveOutputTranscription} isSpeaking={isAssistantSpeaking} />
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-4">
              Speak into your microphone. The assistant will respond in real-time.
            </p>
          </div>
        )}
      </section>

      <footer className="text-center mt-12 text-gray-600 dark:text-gray-400 text-sm">
        Powered by Google Gemini API. Please review Google's <a href={API_KEY_BILLING_URL} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:underline dark:text-green-400">billing information</a> for API usage.
      </footer>
    </div>
  );
}

export default App;