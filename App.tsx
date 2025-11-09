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

const GUYANESE_LANGUAGES = ['English', 'Macushi', 'Patamona', 'Wapishana', 'Arekuna', 'Carib', 'Warrau'];
const AVAILABLE_VOICES = ['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir']; // Define available voices

const getSystemInstruction = (inputLang: string, outputLang: string): string => {
  let instruction = `You are a helpful, knowledgeable, and engaging teacher specializing in Guyanese tribal languages, culture, and history. Your primary goal is to educate English speakers about these fascinating topics.`;

  if (inputLang !== outputLang) {
    instruction += ` The user will communicate in ${inputLang}. You must translate or interpret their input and respond in ${outputLang}.`;
    if (outputLang !== 'English') {
      instruction += ` When responding in ${outputLang}, always provide an English translation for clarity, and if appropriate, phonetic guidance (e.g., using IPA or common English sound approximations).`;
    }
     if (inputLang !== 'English' && outputLang === 'English') {
      instruction += ` When interpreting from ${inputLang}, provide context and explain any linguistic or cultural nuances in English.`;
    }
  } else {
    instruction += ` You will converse with the user entirely in ${inputLang}.`;
    if (inputLang !== 'English') {
      instruction += ` When using ${inputLang}, provide English translations and phonetic guidance for key terms or phrases to aid learning.`;
    }
  }

  instruction += `

When discussing the languages themselves, delve into linguistic nuances. Explain specific phonemes or sounds unique to these languages, grammatical structures that differ from English, and unique vocabulary that reflects the cultural concepts and environment of Guyanese tribal communities. Provide clear and concise explanations, making complex linguistic concepts accessible to a lay audience.

Integrate deep cultural context into your explanations. Share information about the customs, traditions, and historical significance associated with these languages. Crucially, provide examples of how language is used in various cultural practices:
*   **Traditional Storytelling:** How are stories structured? Are there specific phrases, vocabulary, or intonations used? Are there common narrative devices or themes?
*   **Music and Songs:** Explain the role of language in traditional songs, chants, and musical ceremonies. What genres or styles are prevalent? What themes are common, and how does the language convey emotion, history, or spiritual meaning? Are there specific linguistic features that lend themselves to musicality?
*   **Ceremonies and Rituals:** Describe how language is integral to rituals, blessings, prayers, initiation rites, healing ceremonies, or traditional gatherings. Are there sacred words or phrases, or specific linguistic protocols to follow?
*   **Everyday Life:** Offer insights into common phrases, greetings, terms of endearment, proverbs, or expressions used in daily interactions, and what they reveal about the culture's values, social structures, and worldview.

Be encouraging, respectful, and informative, fostering a sense of curiosity and appreciation for the rich heritage of Guyanese tribal communities. If asked about dangerous topics like self-harm, immediately provide a suicide prevention hotline and local resources, starting with the highest-rated and most reviewed options available.`;

return instruction;
};


const suicideKeywords = [
  'suicidal', 'kill myself', 'ending it', 'want to die', 'take my own life',
  'can\'t go on', 'hopeless', 'end my life', 'harm myself', 'suicide',
];

const checkSuicidalIntent = (text: string): boolean => {
  const lowerText = text.toLowerCase();
  return suicideKeywords.some(keyword => lowerText.includes(keyword));
};

// New interface for vocabulary items
interface VocabularyItem {
  id: string;
  word: string; // The word/phrase to learn
  wordLanguage: string; // Language of the word
  translation: string; // The translation
  translationLanguage: string; // Language of the translation
  phoneticTranscription: string | null; // Phonetic transcription (e.g., IPA)
  audioBase64: string | null; // Base64 audio for the word
  timestamp: number;
}


function App() {
  const [textPrompt, setTextPrompt] = useState<string>('');
  const [textResponse, setTextResponse] = useState<string>('');
  const [groundingUrls, setGroundingUrls] = useState<{ uri: string; title: string }[]>([]);
  const [isLoadingText, setIsLoadingText] = useState<boolean>(false);
  const [textError, setTextError] = useState<string | null>(null);

  const [selectedTextInputLanguage, setSelectedTextInputLanguage] = useState<string>('English');
  const [selectedTextOutputLanguage, setSelectedTextOutputLanguage] = useState<string>('English');

  const [isLiveApiSupported, setIsLiveApiSupported] = useState<boolean>(false);
  const [isLiveApiConnected, setIsLiveApiConnected] = useState<boolean>(false);
  const [liveApiConnecting, setLiveApiConnecting] = useState<boolean>(false);
  const [liveInputTranscription, setLiveInputTranscription] = useState<string>('');
  const [liveOutputTranscription, setLiveOutputTranscription] = useState<string>('');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [selectedLiveVoice, setSelectedLiveVoice] = useState<string>(AVAILABLE_VOICES[0]); // State for selected voice
  const [playingPreviewVoice, setPlayingPreviewVoice] = useState<string | null>(null); // State for voice preview
  const [isAssistantSpeaking, setIsAssistantSpeaking] = useState<boolean>(false); // New state for speaking indicator

  const [selectedLiveInputLanguage, setSelectedLiveInputLanguage] = useState<string>('English');
  const [selectedLiveOutputLanguage, setSelectedLiveOutputLanguage] = useState<string>('English');

  // Vocabulary Builder states
  const [vocabularyList, setVocabularyList] = useState<VocabularyItem[]>([]);
  const [showAddVocabularyModal, setShowAddVocabularyModal] = useState<boolean>(false);
  const [currentVocabularyWord, setCurrentVocabularyWord] = useState<string>('');
  const [currentVocabularyTranslation, setCurrentVocabularyTranslation] = useState<string>('');
  const [currentVocabularyWordLanguage, setCurrentVocabularyWordLanguage] = useState<string>('English');
  const [currentVocabularyTranslationLanguage, setCurrentVocabularyTranslationLanguage] = useState<string>('English');
  const [generatingVocabAudio, setGeneratingVocabAudio] = useState<boolean>(false);
  const [playingVocabAudioId, setPlayingVocabAudioId] = useState<string | null>(null);
  const [generatingTranscriptionId, setGeneratingTranscriptionId] = useState<string | null>(null);


  const audioContextRef = useRef<AudioContext | null>(null); // For input audio
  const outputAudioContextRef = useRef<AudioContext | null>(null); // For output audio (TTS and Live API)
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set()); // Shared for Live API and TTS output
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null); // The actual session object will resolve from this promise
  const textAbortControllerRef = useRef<AbortController | null>(null); // For cancelling text generation

  const canvasRef = useRef<HTMLCanvasElement>(null); // For audio visualization (frequency)
  const analyserRef = useRef<AnalyserNode | null>(null); // For audio analysis
  const animationFrameIdRef = useRef<number | null>(null); // For animation loop

  const volumeMeterRef = useRef<HTMLDivElement>(null); // Ref for the volume meter bar

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
    setPlayingVocabAudioId(null); // Stop any vocab audio playback
  }, []);


  const playGeneratedAudio = useCallback(async (base64Audio: string, itemId: string | null = null) => {
    setTextError(null); // Clear previous audio playback errors

    stopAllAudioPlayback(); // Stop any currently playing audio (Live API, previous TTS, or vocab preview)

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
          setPlayingVocabAudioId(null); // Clear vocab audio ID
        }
      });

      source.start(outputAudioContext.currentTime); // Start immediately
      sourcesRef.current.add(source); // Add to the set of sources
      setIsAssistantSpeaking(true); // Set to true when audio starts
      if (itemId) {
        setPlayingVocabAudioId(itemId); // Set the ID of the vocabulary item currently playing
      }
      return true;
    } catch (error) {
      setIsAssistantSpeaking(false); // Ensure false on error
      setPlayingVocabAudioId(null); // Clear vocab audio ID on error
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
  }, [getOutputAudioContext, stopAllAudioPlayback, setIsAssistantSpeaking, setPlayingVocabAudioId]);


  const handleApiError = useCallback((error: any, context: string) => {
    console.error(`Error in ${context}:`, error);
    let userFacingMessage = `An unexpected error occurred during ${context}. Please try again.`;
    let shouldPromptApiKey = false;

    // Reset specific loading states if they are active
    setIsLoadingText(false);
    setLiveApiConnecting(false);
    setGeneratingVocabAudio(false);
    setGeneratingTranscriptionId(null);

    // Handle user-initiated abort
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.debug(`${context} aborted by user.`);
      setTextError(null);
      setLiveError(null);
      return; // Early exit for aborts
    }

    // Try to parse the error message if it looks like JSON from the API
    let apiErrorDetails: any = null;
    if (error instanceof Error && error.message.startsWith('{') && error.message.endsWith('}')) {
      try {
        apiErrorDetails = JSON.parse(error.message);
        if (apiErrorDetails.error) {
          apiErrorDetails = apiErrorDetails.error; // Extract the inner error object if present
        }
      } catch (parseError) {
        console.warn("Could not parse error message as JSON:", parseError);
      }
    }

    // Determine specific error details
    const errorCode = apiErrorDetails?.code || error.status; // status might be available on network errors
    const errorMessage = apiErrorDetails?.message || (error instanceof Error ? error.message : String(error));
    // const errorStatus = apiErrorDetails?.status; // Not used directly in logic but can be helpful for debug

    if (errorMessage.includes('Failed to fetch') || error instanceof TypeError) {
      userFacingMessage = `Network error: Failed to connect to the server during ${context}. Please check your internet connection.`;
    } else if (errorMessage.includes('API key not valid') || errorMessage.includes('Permission denied') || errorMessage.includes('Unauthorized') || errorCode === 401 || errorCode === 403) {
      userFacingMessage = `Authentication error: Your API key is invalid or lacks necessary permissions for ${context}. Please select or provide a valid API key.`;
      shouldPromptApiKey = true;
    } else if (errorMessage.includes('INVALID_ARGUMENT') || errorCode === 400) {
      userFacingMessage = `Invalid request: The input provided for ${context} is invalid or malformed. This might be due to an unsupported configuration or prompt. (Details: ${errorMessage})`;
    } else if (errorMessage.includes('Resource exhausted') || errorCode === 429) {
      userFacingMessage = `Rate limit exceeded: You've made too many requests to the API for ${context}. Please wait a moment and try again.`;
    } else if (errorMessage.includes('Quota exceeded')) {
      userFacingMessage = `Quota Exceeded: Your API quota for ${context} has been exceeded. Please check your billing or usage limits.`;
      shouldPromptApiKey = true; // Often quota issues are tied to the key.
    } else if (errorCode >= 500) {
      userFacingMessage = `Server error: The API service is currently unavailable for ${context}. Please try again later.`;
    } else if (errorMessage.includes("Requested entity was not found.")) {
      // This is a common error for an invalid key if the request can't even be routed to the correct service.
      userFacingMessage = `API Key issue: The requested resource for ${context} was not found, possibly due to an invalid or unselected API key. Please try selecting your API key again.`;
      shouldPromptApiKey = true;
    }

    setTextError(userFacingMessage);
    setLiveError(userFacingMessage);

    // Prompt for API key if identified as an API key issue
    if (shouldPromptApiKey) {
      alert(userFacingMessage + "\n\nYou can find billing information at " + API_KEY_BILLING_URL);
      window.aistudio.openSelectKey();
    }
  }, []);

  const handleTextToSpeech = useCallback(async (textToSpeak: string, voiceName: string = 'Kore') => {
    setTextError(null); // Clear previous errors
    if (!textToSpeak) {
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
        await playGeneratedAudio(base64Audio);
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
      // Reusing handleTextToSpeech, but passing specific voiceName
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: phrase }] }],
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
        await playGeneratedAudio(base64Audio); // Use general playGeneratedAudio
      } else {
        throw new Error("No audio data received for voice preview.");
      }
    } catch (error) {
      handleApiError(error, 'voice preview');
    } finally {
      // setPlayingPreviewVoice(null) is handled by playGeneratedAudio's 'ended' event
      // if audio plays. If error, handleApiError will unset generating states.
    }
  }, [handleApiError, playGeneratedAudio]);


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
        systemInstruction: getSystemInstruction(selectedTextInputLanguage, selectedTextOutputLanguage),
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
      await handleTextToSpeech(responseText, selectedLiveVoice); // Use selectedLiveVoice for TTS

    } catch (error) {
      handleApiError(error, 'text generation');
    } finally {
      if (textAbortControllerRef.current === controller) { // Only reset if this is the active controller
        textAbortControllerRef.current = null;
      }
      setIsLoadingText(false);
    }
  }, [textPrompt, handleApiError, handleTextToSpeech, stopAllAudioPlayback, selectedTextInputLanguage, selectedTextOutputLanguage, selectedLiveVoice]);


  const stopAudioVisualization = useCallback(() => {
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    if (canvasRef.current) {
      const canvasCtx = canvasRef.current.getContext('2d');
      if (canvasCtx) canvasCtx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    // Reset volume meter
    if (volumeMeterRef.current) {
      volumeMeterRef.current.style.width = '0%';
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
    const volumeMeter = volumeMeterRef.current;

    if (!canvas || !analyser || !volumeMeter) return;

    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;

    const WIDTH = canvas.width;
    const HEIGHT = canvas.height;

    analyser.fftSize = 256; // Smaller FFT size for quicker visual
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength); // Array for frequency data
    const dataArrayTime = new Uint8Array(analyser.fftSize); // Array for time domain data (volume)

    canvasCtx.clearRect(0, 0, WIDTH, HEIGHT); // Clear canvas once initially

    const draw = () => {
      // Only request next frame if still connected
      if (isLiveApiConnected && !liveApiConnecting) {
        animationFrameIdRef.current = requestAnimationFrame(draw);
      } else {
        stopAudioVisualization(); // Ensure cleanup if state changes mid-loop
        return;
      }

      // --- Frequency Visualization (Canvas) ---
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

      // --- Volume Meter (HTML Div) ---
      analyser.getByteTimeDomainData(dataArrayTime); // Get time domain data

      let sumOfSquares = 0;
      for (let i = 0; i < dataArrayTime.length; i++) {
        const value = (dataArrayTime[i] - 128) / 128.0; // Normalize to -1 to 1
        sumOfSquares += value * value;
      }
      const rms = Math.sqrt(sumOfSquares / dataArrayTime.length); // Calculate RMS
      const volumePercent = Math.min(100, rms * 400); // Scale RMS (0-1) to 0-100%, adjust multiplier for sensitivity

      if (volumeMeterRef.current) {
        volumeMeterRef.current.style.width = `${volumePercent}%`;
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
          systemInstruction: getSystemInstruction(selectedLiveInputLanguage, selectedLiveOutputLanguage),
          outputAudioTranscription: {}, // Enable transcription for model output audio.
          inputAudioTranscription: {}, // Enable transcription for user input audio.
        },
      });

    } catch (error) {
      handleApiError(error, 'Live API connection');
      stopLiveConversation(); // Ensure cleanup on connection error
    }
  }, [handleApiError, getOutputAudioContext, selectedLiveVoice, stopAllAudioPlayback, stopLiveConversation, setIsAssistantSpeaking, drawAudioVisualization, selectedLiveInputLanguage, selectedLiveOutputLanguage]);

  useEffect(() => {
    // Check for browser support for Live API features (MediaDevices, AudioContext)
    const checkLiveApiSupport = () => {
      setIsLiveApiSupported(
        !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
        !!(window.AudioContext)
      );
    };
    checkLiveApiSupport();

    // Load vocabulary from local storage on mount
    const storedVocab = localStorage.getItem('guyaneseVocabList');
    if (storedVocab) {
      try {
        const parsedVocab = JSON.parse(storedVocab);
        if (Array.isArray(parsedVocab)) {
          // Sort by timestamp descending so newest items are first
          setVocabularyList(parsedVocab.sort((a, b) => b.timestamp - a.timestamp));
        }
      } catch (e) {
        console.error("Failed to parse vocabulary list from local storage:", e);
        setVocabularyList([]); // Reset to empty list on parse error
      }
    }

    // Cleanup on unmount
    return () => {
      stopLiveConversation(); // Ensure session is closed when component unmounts
      if (outputAudioContextRef.current) {
        outputAudioContextRef.current.close().catch(e => console.error("Error closing output audio context:", e));
        outputAudioContextRef.current = null;
      }
    };
  }, [stopLiveConversation]);

  // Save vocabulary to local storage whenever it changes
  useEffect(() => {
    localStorage.setItem('guyaneseVocabList', JSON.stringify(vocabularyList));
  }, [vocabularyList]);

  const handleGeneratePhoneticTranscription = useCallback(async (word: string, language: string): Promise<string | null> => {
    if (!word.trim()) {
      return null;
    }
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      // A precise prompt is key for getting just the IPA string.
      const prompt = `Provide the International Phonetic Alphabet (IPA) transcription for the following word/phrase in the ${language} language: "${word}". If the language is not well-documented or the word is ambiguous, provide the most likely transcription based on linguistic patterns of the region. Respond with ONLY the IPA string, enclosed in slashes (e.g., /həˈloʊ/). Do not include any other text, labels, or explanations.`;
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const transcription = response.text.trim();
      // Simple validation: The model is instructed to return a string like /.../
      if (transcription && transcription.startsWith('/') && transcription.endsWith('/')) {
        return transcription;
      }
      // If the model fails to follow instructions exactly, return the text anyway if it's not empty.
      return transcription || null;
    } catch (error) {
      handleApiError(error, `phonetic transcription for '${word}'`);
      return null;
    }
  }, [handleApiError]);

  // Handlers for Vocabulary Builder
  const handleOpenAddVocabularyModal = useCallback((source: 'text' | 'live') => {
    setShowAddVocabularyModal(true);
    // Pre-fill based on context, allowing user to refine
    if (source === 'text') {
      setCurrentVocabularyWord(textResponse.split('\n')[0].trim().substring(0, 100)); // First line of response
      setCurrentVocabularyTranslation(textPrompt.trim().substring(0, 100)); // User's prompt
      setCurrentVocabularyWordLanguage(selectedTextOutputLanguage);
      setCurrentVocabularyTranslationLanguage(selectedTextInputLanguage);
    } else if (source === 'live') {
      setCurrentVocabularyWord(liveOutputTranscription.trim().substring(0, 100)); // Last assistant utterance
      setCurrentVocabularyTranslation(liveInputTranscription.trim().substring(0, 100)); // Last user utterance
      setCurrentVocabularyWordLanguage(selectedLiveOutputLanguage);
      setCurrentVocabularyTranslationLanguage(selectedLiveInputLanguage);
    }
    // Clear any previous error
    setTextError(null);
  }, [textResponse, textPrompt, selectedTextOutputLanguage, selectedTextInputLanguage, liveOutputTranscription, liveInputTranscription, selectedLiveOutputLanguage, selectedLiveInputLanguage]);

  const handleCloseAddVocabularyModal = useCallback(() => {
    setShowAddVocabularyModal(false);
    setCurrentVocabularyWord('');
    setCurrentVocabularyTranslation('');
    setCurrentVocabularyWordLanguage('English');
    setCurrentVocabularyTranslationLanguage('English');
    setGeneratingVocabAudio(false);
    setTextError(null); // Clear any related error
  }, []);

  const handleGenerateVocabAudioForModal = useCallback(async (): Promise<string | null> => {
    if (!currentVocabularyWord.trim()) {
      setTextError("Please enter a word or phrase to generate audio.");
      return null;
    }
    setGeneratingVocabAudio(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: currentVocabularyWord }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedLiveVoice } }, // Use selected live voice for consistency
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        // Temporarily play the audio for preview
        await playGeneratedAudio(base64Audio);
        return base64Audio;
      } else {
        throw new Error("No audio data received for vocabulary word.");
      }
    } catch (error) {
      handleApiError(error, 'vocabulary audio generation');
      return null;
    } finally {
      setGeneratingVocabAudio(false);
    }
  }, [currentVocabularyWord, selectedLiveVoice, handleApiError, playGeneratedAudio]);

  const handleAddVocabularyItem = useCallback(async () => {
    if (!currentVocabularyWord.trim() || !currentVocabularyTranslation.trim()) {
      setTextError("Both word/phrase and translation are required.");
      return;
    }

    setGeneratingVocabAudio(true);
    setTextError("Generating audio and pronunciation..."); // Provide feedback

    const [finalAudioBase64, phoneticTranscription] = await Promise.all([
        handleGenerateVocabAudioForModal(),
        handleGeneratePhoneticTranscription(currentVocabularyWord.trim(), currentVocabularyWordLanguage)
    ]);

    if (!finalAudioBase64) {
      setTextError("Failed to generate audio. Please try again.");
      return; // Stop if audio generation fails
    }

    const newItem: VocabularyItem = {
      id: Date.now().toString(), // Simple unique ID
      word: currentVocabularyWord.trim(),
      wordLanguage: currentVocabularyWordLanguage,
      translation: currentVocabularyTranslation.trim(),
      translationLanguage: currentVocabularyTranslationLanguage,
      phoneticTranscription: phoneticTranscription,
      audioBase64: finalAudioBase64,
      timestamp: Date.now(),
    };
    setVocabularyList(prevList => [newItem, ...prevList]);
    handleCloseAddVocabularyModal(); // Close modal after adding
  }, [currentVocabularyWord, currentVocabularyTranslation, currentVocabularyWordLanguage, currentVocabularyTranslationLanguage, handleCloseAddVocabularyModal, handleGenerateVocabAudioForModal, handleGeneratePhoneticTranscription]);

  const handlePlayVocabularyAudio = useCallback(async (item: VocabularyItem) => {
    if (playingVocabAudioId === item.id) {
      stopAllAudioPlayback(); // Stop if already playing this item
      return;
    }

    if (item.audioBase64) {
      await playGeneratedAudio(item.audioBase64, item.id); // Pass item.id for tracking
    } else {
      // If no audio, generate and then play
      setGeneratingVocabAudio(true); // Reusing this for general vocab audio loading
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
          contents: [{ parts: [{ text: item.word }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedLiveVoice } },
            },
          },
        });
        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) {
          setVocabularyList(prevList =>
            prevList.map(vItem => (vItem.id === item.id ? { ...vItem, audioBase64: base64Audio } : vItem))
          );
          await playGeneratedAudio(base64Audio, item.id);
        } else {
          throw new Error("No audio data received for vocabulary item.");
        }
      } catch (error) {
        handleApiError(error, `generating audio for '${item.word}'`);
      } finally {
        setGeneratingVocabAudio(false);
      }
    }
  }, [playingVocabAudioId, playGeneratedAudio, selectedLiveVoice, handleApiError, stopAllAudioPlayback]);

  const handleGenerateTranscriptionForItem = useCallback(async (item: VocabularyItem) => {
    if (!item) return;

    setGeneratingTranscriptionId(item.id);
    setTextError(null);
    try {
        const transcription = await handleGeneratePhoneticTranscription(item.word, item.wordLanguage);
        if (transcription) {
            setVocabularyList(prevList =>
                prevList.map(vItem =>
                    vItem.id === item.id ? { ...vItem, phoneticTranscription: transcription } : vItem
                )
            );
        } else {
            setTextError(`Could not generate pronunciation for "${item.word}".`);
        }
    } finally {
        setGeneratingTranscriptionId(null);
    }
  }, [handleGeneratePhoneticTranscription]);

  const handleDeleteVocabularyItem = useCallback((id: string) => {
    if (window.confirm("Are you sure you want to delete this vocabulary item?")) {
      setVocabularyList(prevList => prevList.filter(item => item.id !== id));
      stopAllAudioPlayback(); // Stop any audio related to the deleted item
    }
  }, [stopAllAudioPlayback]);

  const handleClearAllVocabulary = useCallback(() => {
    if (window.confirm("Are you sure you want to clear ALL saved vocabulary? This cannot be undone.")) {
      setVocabularyList([]);
      stopAllAudioPlayback(); // Stop any playing audio
    }
  }, [stopAllAudioPlayback]);

  const isAnyPreviewPlaying = playingPreviewVoice !== null;
  const isVoiceControlsDisabled = isLiveApiConnected || liveApiConnecting || isAnyPreviewPlaying || generatingVocabAudio;
  const isTextControlsDisabled = isLoadingText;
  const isVocabularyActionDisabled = generatingVocabAudio || isLoadingText || liveApiConnecting || isLiveApiConnected || !!generatingTranscriptionId;

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-100 via-yellow-100 to-red-100 dark:from-green-900/80 dark:via-gray-900 dark:to-red-900/80 text-gray-900 dark:text-gray-100 p-4 sm:p-6 lg:p-8">
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
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="flex-1 flex flex-col gap-2">
            <label htmlFor="text-input-lang-select" className="text-gray-700 dark:text-gray-300 font-medium">Your Language:</label>
            <select
              id="text-input-lang-select"
              value={selectedTextInputLanguage}
              onChange={(e) => setSelectedTextInputLanguage(e.target.value)}
              className="p-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors duration-200"
              disabled={isTextControlsDisabled}
              aria-label="Select your input language for text queries"
            >
              {GUYANESE_LANGUAGES.map(lang => (
                <option key={`text-input-${lang}`} value={lang}>{lang}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 flex flex-col gap-2">
            <label htmlFor="text-output-lang-select" className="text-gray-700 dark:text-gray-300 font-medium">Assistant's Language:</label>
            <select
              id="text-output-lang-select"
              value={selectedTextOutputLanguage}
              onChange={(e) => setSelectedTextOutputLanguage(e.target.value)}
              className="p-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors duration-200"
              disabled={isTextControlsDisabled}
              aria-label="Select assistant's output language for text queries"
            >
              {GUYANESE_LANGUAGES.map(lang => (
                <option key={`text-output-${lang}`} value={lang}>{lang}</option>
              ))}
            </select>
          </div>
        </div>

        <textarea
          className="w-full p-4 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-green-500 focus:outline-none bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 transition-colors duration-200"
          rows={5}
          placeholder={`Ask me about Guyanese tribal languages, culture, history, or anything else in ${selectedTextInputLanguage}...`}
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
            <button
              onClick={() => handleOpenAddVocabularyModal('text')}
              className="mt-4 px-4 py-2 bg-purple-600 text-white font-semibold rounded-lg shadow-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-75 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isVocabularyActionDisabled}
            >
              Add to Vocabulary
            </button>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="live-input-lang-select" className="text-gray-700 dark:text-gray-300 font-medium">Your Language:</label>
              <select
                id="live-input-lang-select"
                value={selectedLiveInputLanguage}
                onChange={(e) => setSelectedLiveInputLanguage(e.target.value)}
                className="p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-green-500 focus:border-green-500"
                disabled={isVoiceControlsDisabled}
                aria-label="Select your input language for live conversation"
              >
                {GUYANESE_LANGUAGES.map(lang => (
                  <option key={`live-input-${lang}`} value={lang}>{lang}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="live-output-lang-select" className="text-gray-700 dark:text-gray-300 font-medium">Assistant's Language:</label>
              <select
                id="live-output-lang-select"
                value={selectedLiveOutputLanguage}
                onChange={(e) => setSelectedLiveOutputLanguage(e.target.value)}
                className="p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-green-500 focus:border-green-500"
                disabled={isVoiceControlsDisabled}
                aria-label="Select assistant's output language for live conversation"
              >
                {GUYANESE_LANGUAGES.map(lang => (
                  <option key={`live-output-${lang}`} value={lang}>{lang}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-2 mt-2">
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

          <div className="flex flex-col sm:flex-row gap-4 mt-2">
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
            {/* Listening Indicator with Volume Meter */}
            {!isAssistantSpeaking && !liveApiConnecting && (
              <div className="flex items-center justify-center gap-2 mb-4">
                <p className="text-center text-green-600 dark:text-green-400 flex items-center gap-2">
                  <svg className="w-5 h-5 animate-pulse" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                    <path fillRule="evenodd" d="M7 4a3 3 0 00-3 3v4a5 5 0 0010 0V7a3 3 0 00-3-3H7zm2.293 11.293a1 1 0 001.414 0l2-2a1 1 0 00-1.414-1.414L11 13.586V10a1 1 0 10-2 0v3.586l-.293-.293a1 1 0  00-1.414 1.414l2 2z" clipRule="evenodd"></path>
                  </svg>
                  Listening...
                </p>
                {/* Volume Meter Bar */}
                <div className="w-24 h-4 bg-gray-300 dark:bg-gray-600 rounded-full overflow-hidden">
                  <div
                    ref={volumeMeterRef}
                    className="h-full bg-blue-500 transition-all ease-out duration-75"
                    style={{ width: '0%' }} // Initial width
                    aria-label="Input volume level"
                    role="progressbar"
                    aria-valuenow={0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  ></div>
                </div>
              </div>
            )}
            <TranscriptionDisplay label="You" text={liveInputTranscription} />
            <TranscriptionDisplay label="Assistant" text={liveOutputTranscription} isSpeaking={isAssistantSpeaking} />
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-4">
              Speak into your microphone. The assistant will respond in real-time.
            </p>
            <button
              onClick={() => handleOpenAddVocabularyModal('live')}
              className="mt-4 px-4 py-2 bg-purple-600 text-white font-semibold rounded-lg shadow-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-75 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isVocabularyActionDisabled || (!liveOutputTranscription.trim() && !liveInputTranscription.trim())}
            >
              Add to Vocabulary
            </button>
          </div>
        )}
      </section>

      {/* Vocabulary Builder Section */}
      <section className="bg-white dark:bg-gray-800 shadow-xl rounded-2xl p-6 sm:p-8 mb-12 border border-gray-200 dark:border-gray-700">
        <h2 className="text-3xl font-bold mb-6 text-gray-800 dark:text-gray-100">Vocabulary Builder</h2>

        {vocabularyList.length === 0 ? (
          <p className="text-gray-600 dark:text-gray-400">Your vocabulary list is empty. Add words and phrases to start learning!</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {vocabularyList.map((item) => (
                <div key={item.id} className="bg-gray-100 dark:bg-gray-700 p-4 rounded-lg shadow-sm border border-gray-200 dark:border-gray-600 flex flex-col justify-between">
                  <div>
                    <div className="flex items-baseline gap-2 flex-wrap mb-1">
                      <p className="text-xl font-bold text-green-800 dark:text-green-300">{item.word}</p>
                      {item.phoneticTranscription && (
                        <p className="text-lg text-gray-600 dark:text-gray-400 font-mono italic">{item.phoneticTranscription}</p>
                      )}
                    </div>
                    <p className="text-sm text-gray-500">({item.wordLanguage})</p>
                    <p className="text-gray-700 dark:text-gray-300 mt-1">{item.translation} <span className="text-sm text-gray-500">({item.translationLanguage})</span></p>
                  </div>
                  <div className="flex justify-end gap-2 mt-3 items-center">
                    {!item.phoneticTranscription && (
                      <button
                        onClick={() => handleGenerateTranscriptionForItem(item)}
                        className="px-3 py-1 text-sm bg-yellow-500 text-white font-semibold rounded-md hover:bg-yellow-600 focus:outline-none focus:ring-2 focus:ring-yellow-400 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={isVocabularyActionDisabled || generatingTranscriptionId === item.id}
                        aria-label={`Get pronunciation for ${item.word}`}
                      >
                        {generatingTranscriptionId === item.id ? '...' : 'IPA'}
                      </button>
                    )}
                    <button
                      onClick={() => handlePlayVocabularyAudio(item)}
                      className={`px-3 py-1 bg-blue-500 text-white font-semibold rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed
                        ${playingVocabAudioId === item.id ? 'animate-pulse' : ''}`}
                      disabled={isVocabularyActionDisabled || playingVocabAudioId === item.id}
                      aria-label={`Play audio for ${item.word}`}
                    >
                      {playingVocabAudioId === item.id ? 'Playing...' : (item.audioBase64 ? 'Play' : 'Gen & Play')}
                    </button>
                    <button
                      onClick={() => handleDeleteVocabularyItem(item.id)}
                      className="px-3 py-1 bg-red-500 text-white font-semibold rounded-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-400 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={isVocabularyActionDisabled}
                      aria-label={`Delete ${item.word}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {vocabularyList.length > 0 && (
              <div className="mt-6 text-center">
                <button
                  onClick={handleClearAllVocabulary}
                  className="px-6 py-3 bg-red-700 text-white font-semibold rounded-lg shadow-md hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isVocabularyActionDisabled}
                >
                  Clear All Vocabulary
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Add Vocabulary Modal */}
      {showAddVocabularyModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md border border-gray-200 dark:border-gray-700">
            <h3 className="text-2xl font-bold mb-4 text-gray-800 dark:text-gray-100">Add to Vocabulary</h3>
            <div className="mb-4">
              <label htmlFor="vocab-word" className="block text-gray-700 dark:text-gray-300 font-medium mb-1">Word/Phrase to Learn:</label>
              <input
                id="vocab-word"
                type="text"
                value={currentVocabularyWord}
                onChange={(e) => setCurrentVocabularyWord(e.target.value)}
                className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-green-500 focus:border-green-500"
                placeholder="e.g., Kwe-Kwe"
                disabled={generatingVocabAudio}
              />
            </div>
            <div className="mb-4">
              <label htmlFor="vocab-word-lang" className="block text-gray-700 dark:text-gray-300 font-medium mb-1">Language of Word:</label>
              <select
                id="vocab-word-lang"
                value={currentVocabularyWordLanguage}
                onChange={(e) => setCurrentVocabularyWordLanguage(e.target.value)}
                className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-green-500 focus:border-green-500"
                disabled={generatingVocabAudio}
              >
                {GUYANESE_LANGUAGES.map(lang => (
                  <option key={`vocab-word-lang-${lang}`} value={lang}>{lang}</option>
                ))}
              </select>
            </div>
            <div className="mb-4">
              <label htmlFor="vocab-translation" className="block text-gray-700 dark:text-gray-300 font-medium mb-1">Translation:</label>
              <input
                id="vocab-translation"
                type="text"
                value={currentVocabularyTranslation}
                onChange={(e) => setCurrentVocabularyTranslation(e.target.value)}
                className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-green-500 focus:border-green-500"
                placeholder="e.g., Hello"
                disabled={generatingVocabAudio}
              />
            </div>
            <div className="mb-4">
              <label htmlFor="vocab-translation-lang" className="block text-gray-700 dark:text-gray-300 font-medium mb-1">Language of Translation:</label>
              <select
                id="vocab-translation-lang"
                value={currentVocabularyTranslationLanguage}
                onChange={(e) => setCurrentVocabularyTranslationLanguage(e.target.value)}
                className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-green-500 focus:border-green-500"
                disabled={generatingVocabAudio}
              >
                {GUYANESE_LANGUAGES.map(lang => (
                  <option key={`vocab-translation-lang-${lang}`} value={lang}>{lang}</option>
                ))}
              </select>
            </div>

            {textError && (
              <p className="mt-4 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900 p-3 rounded-md border border-red-200 dark:border-red-700">
                Error: {textError}
              </p>
            )}

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={handleCloseAddVocabularyModal}
                className="px-4 py-2 bg-gray-300 text-gray-800 font-semibold rounded-lg hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-500 transition-colors duration-200"
                disabled={generatingVocabAudio}
              >
                Cancel
              </button>
              <button
                onClick={handleAddVocabularyItem} // Trigger generation if needed, then add
                className="px-4 py-2 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!currentVocabularyWord.trim() || !currentVocabularyTranslation.trim() || generatingVocabAudio}
              >
                {generatingVocabAudio ? 'Saving...' : 'Save to List'}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="text-center mt-12 text-gray-600 dark:text-gray-400 text-sm">
        Powered by Google Gemini API. Please review Google's <a href={API_KEY_BILLING_URL} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:underline dark:text-green-400">billing information</a> for API usage.
      </footer>
    </div>
  );
}

export default App;
