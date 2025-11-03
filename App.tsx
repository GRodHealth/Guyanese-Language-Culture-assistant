import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, encode, decodeAudioData, createBlob } from './utils/audioHelpers';
import { API_KEY_BILLING_URL } from './constants';

// Define helper components outside the main App component to prevent re-rendering issues.
interface TranscriptionProps {
  label: string;
}

const TranscriptionDisplay: React.FC<TranscriptionProps & { text: string }> = ({ label, text }) => (
  <div className="mb-2">
    <p className="font-semibold text-gray-700 dark:text-gray-300">{label}:</p>
    <p className="text-gray-600 dark:text-gray-400 break-words">{text || '...'}</p>
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
        <li key={index} className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200">
          <a href={url.uri} target="_blank" rel="noopener noreferrer" className="break-all">{url.title || url.uri}</a>
        </li>
      ))}
    </ul>
  </div>
);

const SYSTEM_INSTRUCTION_BASE = `You are a helpful, knowledgeable, and engaging teacher specializing in Guyanese tribal languages, culture, and history. Your primary goal is to educate English speakers about these fascinating topics.

When discussing the languages themselves, delve into linguistic nuances. Explain specific phonemes or sounds unique to these languages, grammatical structures that differ from English, and unique vocabulary that reflects the cultural concepts and environment of Guyanese tribal communities. Provide clear and concise explanations, making complex linguistic concepts accessible to a lay audience.

Integrate deep cultural context into your explanations. Share information about the customs, traditions, and historical significance associated with these languages. Crucially, provide examples of how language is used in various cultural practices:
*   **Traditional Storytelling:** How are stories structured? Are there specific phrases, vocabulary, or intonations used?
*   **Music and Songs:** Explain the role of language in traditional songs, chants, and musical ceremonies. What themes are common, and how does the language convey emotion or meaning?
*   **Ceremonies and Rituals:** Describe how language is integral to rituals, greetings, blessings, or traditional gatherings.
*   **Everyday Life:** Offer insights into common phrases, greetings, or expressions used in daily interactions, and what they reveal about the culture.

Where possible, provide actual words or short phrases from the tribal languages, always accompanied by clear English translations and, if relevant, phonetic guidance.

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

  const audioContextRef = useRef<AudioContext | null>(null); // For input audio
  const outputAudioContextRef = useRef<AudioContext | null>(null); // For output audio (TTS and Live API)
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set()); // Shared for Live API and TTS output
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null); // The actual session object will resolve from this promise

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
      });

      source.start(outputAudioContext.currentTime); // Start immediately
      sourcesRef.current.add(source); // Add to the set of sources
      return true;
    } catch (error) {
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
  }, [getOutputAudioContext, stopAllAudioPlayback]);


  const handleApiError = useCallback((error: any, context: string) => {
    console.error(`Error in ${context}:`, error);
    let errorMessage = `An error occurred during ${context}.`;
    if (error instanceof Error) {
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
      // This part is for Veo models, but since the error message indicates a key problem, it's used more broadly.
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

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const config: any = {
        systemInstruction: SYSTEM_INSTRUCTION_BASE,
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
      setIsLoadingText(false);
    }
  }, [textPrompt, handleApiError, handleTextToSpeech]);

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
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(e => console.error("Error closing input audio context:", e));
      audioContextRef.current = null;
    }

    stopAllAudioPlayback(); // Stop any currently playing model audio (Live API or TTS)

    setIsLiveApiConnected(false);
    setLiveApiConnecting(false);
  }, [stopAllAudioPlayback]); // Dependency: stopAllAudioPlayback


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
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext.destination);
            scriptProcessorRef.current = scriptProcessor; // Keep reference to disconnect later
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
                });

                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current = nextStartTimeRef.current + audioBuffer.duration;
                sourcesRef.current.add(source);
              } catch (decodeError) {
                handleApiError(decodeError, 'Live API audio decoding');
              }
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
  }, [handleApiError, getOutputAudioContext, selectedLiveVoice, stopLiveConversation, stopAllAudioPlayback]); // Added stopAllAudioPlayback as dependency

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
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-100 dark:from-gray-900 dark:to-gray-800 text-gray-900 dark:text-gray-100 p-4 sm:p-6 lg:p-8">
      {/* Removed <audio ref={playAudioRef} className="hidden" /> */}

      <h1 className="text-4xl sm:text-5xl font-extrabold text-center mb-10 text-transparent bg-clip-text bg-gradient-to-r from-green-600 to-blue-600 dark:from-green-400 dark:to-blue-400">
        Guyanese Language & Culture Assistant
      </h1>

      {/* Text-based Query Section */}
      <section className="bg-white dark:bg-gray-800 shadow-xl rounded-2xl p-6 sm:p-8 mb-12 border border-gray-200 dark:border-gray-700">
        <h2 className="text-3xl font-bold mb-6 text-gray-800 dark:text-gray-100">Text & Information Queries</h2>
        <textarea
          className="w-full p-4 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 transition-colors duration-200"
          rows={5}
          placeholder="Ask me about Guyanese tribal languages, culture, history, or anything else..."
          value={textPrompt}
          onChange={(e) => setTextPrompt(e.target.value)}
          disabled={isLoadingText}
        />
        <div className="mt-4 flex flex-col sm:flex-row gap-4">
          <button
            onClick={() => handleTextQuery('gemini-2.5-flash', true)}
            className="flex-1 px-6 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-semibold rounded-lg shadow-md hover:from-purple-700 hover:to-indigo-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-75 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isLoadingText || !textPrompt.trim()}
          >
            {isLoadingText ? 'Searching...' : 'Search & Get Info (Up-to-Date)'}
          </button>
          <button
            onClick={() => handleTextQuery('gemini-2.5-flash-lite', false)}
            className="flex-1 px-6 py-3 bg-gradient-to-r from-pink-600 to-red-600 text-white font-semibold rounded-lg shadow-md hover:from-pink-700 hover:to-red-700 focus:outline-none focus:ring-2 focus:ring-pink-500 focus:ring-opacity-75 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isLoadingText || !textPrompt.trim()}
          >
            {isLoadingText ? 'Thinking...' : 'Get Fast Response'}
          </button>
        </div>

        {textError && (
          <p className="mt-4 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900 p-3 rounded-md border border-red-200 dark:border-red-700">
            Error: {textError}
          </p>
        )}

        {textResponse && (
          <div className="mt-6 p-4 bg-blue-50 dark:bg-gray-700 rounded-lg shadow-inner border border-blue-200 dark:border-gray-600">
            <h3 className="text-xl font-semibold mb-3 text-blue-800 dark:text-blue-200">Response:</h3>
            <p className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{textResponse}</p>
            {groundingUrls.length > 0 && <UrlDisplay urls={groundingUrls} />}
          </div>
        )}
      </section>

      {/* Live Audio Conversation Section */}
      <section className="bg-white dark:bg-gray-800 shadow-xl rounded-2xl p-6 sm:p-8 mb-12 border border-gray-200 dark:border-gray-700">
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
                className="flex-grow p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500 min-w-40"
                disabled={isVoiceControlsDisabled}
                aria-label="Select assistant voice"
              >
                {AVAILABLE_VOICES.map(voice => (
                  <option key={voice} value={voice}>{voice}</option>
                ))}
              </select>
              <button
                onClick={() => handlePreviewVoice(selectedLiveVoice)}
                className={`px-4 py-2 bg-blue-500 text-white font-semibold rounded-lg shadow-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-75 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed
                  ${playingPreviewVoice === selectedLiveVoice ? 'animate-pulse' : ''}`}
                disabled={isVoiceControlsDisabled}
              >
                {playingPreviewVoice === selectedLiveVoice ? 'Playing...' : 'Preview'}
              </button>
            </div>
          </div>
        </div>

        {liveApiConnecting && (
          <div className="text-center text-blue-600 dark:text-blue-400 mb-4">
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
            <TranscriptionDisplay label="You" text={liveInputTranscription} />
            <TranscriptionDisplay label="Assistant" text={liveOutputTranscription} />
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-4">
              Speak into your microphone. The assistant will respond in real-time.
            </p>
          </div>
        )}
      </section>

      <footer className="text-center mt-12 text-gray-600 dark:text-gray-400 text-sm">
        Powered by Google Gemini API. Please review Google's <a href={API_KEY_BILLING_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">billing information</a> for API usage.
      </footer>
    </div>
  );
}

export default App;