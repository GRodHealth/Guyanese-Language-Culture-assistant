
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, GenerateContentResponse } from '@google/genai';
import { decode, encode, decodeAudioData, createBlob } from './utils/audioHelpers';
import { API_KEY_BILLING_URL } from './constants';

// Define helper components outside the main App component to prevent re-rendering issues.
interface TranscriptionProps {
  label: string;
  isSpeaking?: boolean;
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
  <div className="mt-4 p-4 bg-white/50 dark:bg-zinc-800/50 rounded-xl border border-emerald-100 dark:border-emerald-900/30">
    <h3 className="font-bold text-sm mb-2 text-emerald-800 dark:text-emerald-400 uppercase tracking-wider">Web Sources</h3>
    <ul className="space-y-1">
      {urls.map((url, index) => (
        <li key={index} className="text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 transition-colors">
          <a href={url.uri} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            {url.title || url.uri}
          </a>
        </li>
      ))}
    </ul>
  </div>
);

const GUYANESE_LANGUAGES = ['English', 'Macushi', 'Patamona', 'Wapishana', 'Arekuna', 'Carib', 'Warrau', 'Wai-Wai', 'Akawaio'];
const AVAILABLE_VOICES = ['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir'];
const SUGGESTIONS = [
  "How do I say 'Hello' and 'Thank you'?",
  "Tell me about the history of the Wai-Wai tribe.",
  "What are some traditional Arekuna foods?",
  "What is the meaning of 'Maimy' in Macushi?",
];

const getSystemInstruction = (inputLang: string, outputLang: string): string => {
  let instruction = `You are a helpful, knowledgeable, and engaging teacher specializing in Guyanese tribal languages, culture, and history. Your primary goal is to educate English speakers about these fascinating topics. You have deep expertise in the nine indigenous tribes of Guyana: Wai-Wai, Macushi, Patamona, Lokono, Kalina, Wapishana, Arekuna, Akawaio, and Warrau.`;

  if (inputLang !== outputLang) {
    instruction += ` The user will communicate in ${inputLang}. You must translate or interpret their input and respond in ${outputLang}.`;
    if (outputLang !== 'English') {
      instruction += ` When responding in ${outputLang}, always provide an English translation for clarity.`;
    }
  } else {
    instruction += ` You will converse with the user entirely in ${inputLang}.`;
  }

  instruction += `

When providing information:
*   Share cultural context: customs, traditional music, and storytelling.
*   Give phonetic approximations for tribal words to help the learner pronounce them.
*   Discuss the environment of the tribes, from the Amazonian interior to the Rupununi savannahs.
*   Be respectful and fostering of curiosity.
*   Keep formatting clean with bullet points where appropriate.`;

return instruction;
};

const suicideKeywords = ['suicidal', 'kill myself', 'ending it', 'want to die', 'suicide'];

const checkSuicidalIntent = (text: string): boolean => {
  const lowerText = text.toLowerCase();
  return suicideKeywords.some(keyword => lowerText.includes(keyword));
};

interface VocabularyItem {
  id: string;
  word: string;
  wordLanguage: string;
  translation: string;
  translationLanguage: string;
  phoneticTranscription: string | null;
  audioBase64: string | null;
  imageBase64?: string | null;
  timestamp: number;
}

const INITIAL_VOCAB: VocabularyItem[] = [
  {
    id: 'starter-1',
    word: 'Maimy',
    wordLanguage: 'Macushi',
    translation: 'Water',
    translationLanguage: 'English',
    phoneticTranscription: '/ˈmaɪ.mi/',
    audioBase64: null,
    timestamp: Date.now()
  },
  {
    id: 'starter-2',
    word: 'Kwe-Kwe',
    wordLanguage: 'English (Creolese Context)',
    translation: 'Traditional pre-wedding dance',
    translationLanguage: 'English',
    phoneticTranscription: '/kweɪ kweɪ/',
    audioBase64: null,
    timestamp: Date.now() - 1000
  }
];

function App() {
  const [textPrompt, setTextPrompt] = useState<string>('');
  const [textResponse, setTextResponse] = useState<string>('');
  const [groundingUrls, setGroundingUrls] = useState<{ uri: string; title: string }[]>([]);
  const [isLoadingText, setIsLoadingText] = useState<boolean>(false);
  const [textError, setTextError] = useState<string | null>(null);

  const [selectedTextInputLanguage, setSelectedTextInputLanguage] = useState<string>('English');
  const [selectedTextOutputLanguage, setSelectedTextOutputLanguage] = useState<string>('Macushi');
  const [selectedTextVoice, setSelectedTextVoice] = useState<string>(AVAILABLE_VOICES[0]);

  const [isLiveApiSupported, setIsLiveApiSupported] = useState<boolean>(false);
  const [isLiveApiConnected, setIsLiveApiConnected] = useState<boolean>(false);
  const [liveApiConnecting, setLiveApiConnecting] = useState<boolean>(false);
  const [liveInputTranscription, setLiveInputTranscription] = useState<string>('');
  const [liveOutputTranscription, setLiveOutputTranscription] = useState<string>('');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [selectedLiveVoice, setSelectedLiveVoice] = useState<string>(AVAILABLE_VOICES[0]);
  const [playingPreviewVoice, setPlayingPreviewVoice] = useState<string | null>(null);
  const [isAssistantSpeaking, setIsAssistantSpeaking] = useState<boolean>(false);
  const [isPreviewingVoice, setIsPreviewingVoice] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);

  const [selectedLiveInputLanguage, setSelectedLiveInputLanguage] = useState<string>('English');
  const [selectedLiveOutputLanguage, setSelectedLiveOutputLanguage] = useState<string>('English');

  const [vocabularyList, setVocabularyList] = useState<VocabularyItem[]>([]);
  const [showAddVocabularyModal, setShowAddVocabularyModal] = useState<boolean>(false);
  const [currentVocabularyWord, setCurrentVocabularyWord] = useState<string>('');
  const [currentVocabularyTranslation, setCurrentVocabularyTranslation] = useState<string>('');
  const [currentVocabularyWordLanguage, setCurrentVocabularyWordLanguage] = useState<string>('English');
  const [currentVocabularyTranslationLanguage, setCurrentVocabularyTranslationLanguage] = useState<string>('English');
  const [generatingVocabAudio, setGeneratingVocabAudio] = useState<boolean>(false);
  const [playingVocabAudioId, setPlayingVocabAudioId] = useState<string | null>(null);
  const [generatingTranscriptionId, setGeneratingTranscriptionId] = useState<string | null>(null);
  const [generatingImageId, setGeneratingImageId] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const textAbortControllerRef = useRef<AbortController | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const volumeMeterRef = useRef<HTMLDivElement>(null);

  const getOutputAudioContext = useCallback(() => {
    if (!outputAudioContextRef.current) {
      const context = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const gainNode = context.createGain();
      gainNode.gain.setValueAtTime(isMuted ? 0 : volume, context.currentTime);
      gainNode.connect(context.destination);
      gainNodeRef.current = gainNode;
      outputAudioContextRef.current = context;
      context.resume();
    }
    return outputAudioContextRef.current;
  }, [volume, isMuted]);

  // Synchronize gain node with volume state
  useEffect(() => {
    if (gainNodeRef.current) {
      const context = outputAudioContextRef.current;
      if (context) {
        gainNodeRef.current.gain.setValueAtTime(isMuted ? 0 : volume, context.currentTime);
      }
    }
  }, [volume, isMuted]);

  const stopAllAudioPlayback = useCallback(() => {
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsAssistantSpeaking(false);
    setPlayingVocabAudioId(null);
  }, []);

  const playGeneratedAudio = useCallback(async (base64Audio: string, itemId: string | null = null) => {
    stopAllAudioPlayback();
    const outputAudioContext = getOutputAudioContext();
    try {
      const decodedBytes = decode(base64Audio);
      const audioBuffer = await decodeAudioData(decodedBytes, outputAudioContext, 24000, 1);
      const source = outputAudioContext.createBufferSource();
      source.buffer = audioBuffer;
      if (gainNodeRef.current) source.connect(gainNodeRef.current);
      else source.connect(outputAudioContext.destination);

      source.addEventListener('ended', () => {
        sourcesRef.current.delete(source);
        if (sourcesRef.current.size === 0) {
          setIsAssistantSpeaking(false);
          setPlayingVocabAudioId(null);
        }
      });
      source.start(outputAudioContext.currentTime);
      sourcesRef.current.add(source);
      setIsAssistantSpeaking(true);
      if (itemId) setPlayingVocabAudioId(itemId);
      return true;
    } catch (error) {
      console.error("Audio playback error:", error);
      return false;
    }
  }, [getOutputAudioContext, stopAllAudioPlayback]);

  const handleApiError = useCallback((error: any, context: string) => {
    console.error(`Error in ${context}:`, error);
    let msg = error.message || String(error);
    if (msg.includes("Requested entity was not found.")) {
      window.aistudio.openSelectKey();
    }
    setTextError(`Error in ${context}: ${msg}`);
  }, []);

  const handlePreviewVoice = useCallback(async () => {
    if (isPreviewingVoice || isLiveApiConnected || liveApiConnecting) return;
    setIsPreviewingVoice(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: "Hello! I am ready to help you learn Guyanese tribal languages." }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: selectedLiveVoice },
            },
          },
        },
      });
      const audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audio) {
        await playGeneratedAudio(audio);
      }
    } catch (e) {
      handleApiError(e, 'Voice Preview');
    } finally {
      setIsPreviewingVoice(false);
    }
  }, [selectedLiveVoice, isPreviewingVoice, isLiveApiConnected, liveApiConnecting, playGeneratedAudio, handleApiError]);

  const handleTextToSpeech = useCallback(async (text: string, voiceName: string = 'Kore') => {
    if (!text) return false;
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      });
      const audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audio) {
        await playGeneratedAudio(audio);
        return true;
      }
    } catch (e) {
      handleApiError(e, 'TTS');
    }
    return false;
  }, [handleApiError, playGeneratedAudio]);

  const handleTextQuery = useCallback(async (modelName: string, useSearch: boolean = false, customPrompt?: string) => {
    const prompt = customPrompt || textPrompt;
    if (!prompt) return;

    setIsLoadingText(true);
    setTextError(null);
    setTextResponse(''); // Clear for streaming
    setGroundingUrls([]);

    if (checkSuicidalIntent(prompt)) {
      setTextResponse("If you are in crisis, please call 988 in the US or your local Guyanese health authorities at +592 226 1328.");
      setIsLoadingText(false);
      return;
    }

    const controller = new AbortController();
    textAbortControllerRef.current = controller;

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const stream = await ai.models.generateContentStream({
        model: modelName,
        contents: prompt,
        config: {
          systemInstruction: getSystemInstruction(selectedTextInputLanguage, selectedTextOutputLanguage),
          tools: useSearch ? [{ googleSearch: {} }] : undefined,
          signal: controller.signal,
        },
      });

      let fullText = '';
      for await (const chunk of stream) {
        const chunkText = chunk.text;
        fullText += chunkText;
        setTextResponse(fullText);

        // Check for grounding metadata once the stream is deep enough or finished
        const chunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
        if (chunks && groundingUrls.length === 0) {
          setGroundingUrls(chunks.map((c: any) => ({ uri: c.web?.uri, title: c.web?.title })).filter((u: any) => u.uri));
        }
      }

      // Automatically play TTS of the response
      await handleTextToSpeech(fullText, selectedTextVoice);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      handleApiError(e, 'text query');
    } finally {
      setIsLoadingText(false);
    }
  }, [textPrompt, selectedTextInputLanguage, selectedTextOutputLanguage, selectedTextVoice, handleTextToSpeech, handleApiError, groundingUrls]);

  const stopLiveConversation = useCallback(() => {
    sessionPromiseRef.current?.then(s => s.close());
    sessionPromiseRef.current = null;
    if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(t => t.stop());
    if (scriptProcessorRef.current) scriptProcessorRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();
    stopAllAudioPlayback();
    setIsLiveApiConnected(false);
    setLiveApiConnecting(false);
  }, [stopAllAudioPlayback]);

  const startLiveConversation = useCallback(async () => {
    setLiveApiConnecting(true);
    try {
      if (!await window.aistudio.hasSelectedApiKey()) await window.aistudio.openSelectKey();
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = inputCtx;
      const outputCtx = getOutputAudioContext();

      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setIsLiveApiConnected(true);
            setLiveApiConnecting(false);
            const source = inputCtx.createMediaStreamSource(mediaStreamRef.current!);
            const script = inputCtx.createScriptProcessor(4096, 1, 1);
            script.onaudioprocess = (e) => {
              const blob = createBlob(e.inputBuffer.getChannelData(0));
              sessionPromiseRef.current?.then(s => s.sendRealtimeInput({ media: blob }));
            };
            source.connect(script);
            script.connect(inputCtx.destination);
            scriptProcessorRef.current = script;
          },
          onmessage: async (m: LiveServerMessage) => {
            if (m.serverContent?.outputTranscription) setLiveOutputTranscription(p => p + m.serverContent!.outputTranscription!.text);
            if (m.serverContent?.inputTranscription) setLiveInputTranscription(p => p + m.serverContent!.inputTranscription!.text);
            const audio = m.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buffer = await decodeAudioData(decode(audio), outputCtx, 24000, 1);
              const src = outputCtx.createBufferSource();
              src.buffer = buffer;
              src.connect(gainNodeRef.current || outputCtx.destination);
              src.addEventListener('ended', () => {
                sourcesRef.current.delete(src);
                if (sourcesRef.current.size === 0) setIsAssistantSpeaking(false);
              });
              src.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(src);
              setIsAssistantSpeaking(true);
            }
            if (m.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              setIsAssistantSpeaking(false);
            }
          },
          onclose: () => setIsLiveApiConnected(false),
          onerror: (e) => handleApiError(e, 'Live API'),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedLiveVoice } } },
          systemInstruction: getSystemInstruction(selectedLiveInputLanguage, selectedLiveOutputLanguage),
        },
      });
    } catch (e) {
      handleApiError(e, 'Live setup');
      stopLiveConversation();
    }
  }, [getOutputAudioContext, selectedLiveVoice, selectedLiveInputLanguage, selectedLiveOutputLanguage, handleApiError, stopLiveConversation]);

  const handleGenerateTranscription = useCallback(async (item: VocabularyItem) => {
    setGeneratingTranscriptionId(item.id);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Provide the IPA (International Phonetic Alphabet) phonetic transcription for the word "${item.word}" in the ${item.wordLanguage} language. Return ONLY the transcription inside slashes, e.g., /waɪ/.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              transcription: { type: Type.STRING, description: 'The IPA phonetic transcription.' }
            },
            required: ['transcription']
          }
        }
      });
      const result = JSON.parse(response.text);
      if (result.transcription) {
        setVocabularyList(prev => prev.map(i => i.id === item.id ? { ...i, phoneticTranscription: result.transcription } : i));
      }
    } catch (e) {
      handleApiError(e, 'phonetic transcription generation');
    } finally {
      setGeneratingTranscriptionId(null);
    }
  }, [handleApiError]);

  const handleGenerateImageForItem = useCallback(async (item: VocabularyItem) => {
    setGeneratingImageId(item.id);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      // Culturally focused prompt for Guyanese Tribal context
      const prompt = `A clear, vibrant educational illustration of '${item.translation}' in a Guyanese indigenous context. The setting should be the ${item.wordLanguage === 'Macushi' ? 'Rupununi savannah' : 'Amazonian rainforest'} of Guyana. Style: Realistic digital art, high contrast, clean background, culturally respectful representation of tribal life or nature.`;
      
      const response = await ai.models.generateImages({
        model: 'imagen-4.0-generate-001',
        prompt: prompt,
        config: { numberOfImages: 1, outputMimeType: 'image/jpeg', aspectRatio: '1:1' },
      });

      const base64 = response.generatedImages?.[0]?.image?.imageBytes;
      if (base64) {
        setVocabularyList(prev => prev.map(i => i.id === item.id ? { ...i, imageBase64: base64 } : i));
      }
    } catch (e) {
      handleApiError(e, 'image generation');
    } finally {
      setGeneratingImageId(null);
    }
  }, [handleApiError]);

  const handleAddVocabularyItem = useCallback(() => {
    if (!currentVocabularyWord || !currentVocabularyTranslation) return;
    const newItem: VocabularyItem = {
      id: Date.now().toString(),
      word: currentVocabularyWord,
      wordLanguage: currentVocabularyWordLanguage,
      translation: currentVocabularyTranslation,
      translationLanguage: currentVocabularyTranslationLanguage,
      phoneticTranscription: null,
      audioBase64: null,
      timestamp: Date.now(),
    };
    setVocabularyList(p => [newItem, ...p]);
    setShowAddVocabularyModal(false);
    setCurrentVocabularyWord('');
    setCurrentVocabularyTranslation('');
    
    // Automatically trigger transcription generation for the new item
    handleGenerateTranscription(newItem);
  }, [currentVocabularyWord, currentVocabularyTranslation, currentVocabularyWordLanguage, currentVocabularyTranslationLanguage, handleGenerateTranscription]);

  useEffect(() => {
    const stored = localStorage.getItem('guyanese_vocab_v2');
    if (stored) setVocabularyList(JSON.parse(stored));
    else setVocabularyList(INITIAL_VOCAB);
    setIsLiveApiSupported(!!(navigator.mediaDevices && window.AudioContext));
    return () => stopLiveConversation();
  }, [stopLiveConversation]);

  useEffect(() => {
    localStorage.setItem('guyanese_vocab_v2', JSON.stringify(vocabularyList));
  }, [vocabularyList]);

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans">
      {/* Header */}
      <header className="bg-emerald-800 text-white p-6 shadow-lg border-b-4 border-yellow-500">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <h1 className="text-3xl font-black tracking-tight flex items-center gap-3">
            <span className="text-4xl">🇬🇾</span> Guyanese Tribal Lingua
          </h1>
          <div className="hidden md:block text-emerald-200 text-sm italic font-medium">
            Preserving Akawaio, Macushi, Wai-Wai, and more.
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 sm:p-8 space-y-12">
        {/* Assistant Section */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-xl border border-zinc-200 dark:border-zinc-800 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
                Text Learning Assistant
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Target Language</span>
                <select 
                  value={selectedTextOutputLanguage} 
                  onChange={e => setSelectedTextOutputLanguage(e.target.value)}
                  className="bg-zinc-100 dark:bg-zinc-800 p-1.5 px-3 rounded-full text-xs font-bold border-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                >
                  {GUYANESE_LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>
            
            <div className="space-y-4 flex-grow flex flex-col">
              <div className="relative">
                <textarea
                  value={textPrompt}
                  onChange={e => setTextPrompt(e.target.value)}
                  placeholder="Ask about tribal history, grammar, or vocabulary..."
                  className="w-full h-32 bg-zinc-50 dark:bg-zinc-800 p-4 pb-12 rounded-2xl border border-zinc-100 dark:border-zinc-700 focus:ring-2 focus:ring-emerald-500 transition-all resize-none text-sm placeholder:text-zinc-400"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleTextQuery('gemini-3-flash-preview', true);
                    }
                  }}
                />
                <div className="absolute bottom-3 right-3 flex gap-2">
                  {isLoadingText ? (
                    <button
                      onClick={() => textAbortControllerRef.current?.abort()}
                      className="bg-red-500 hover:bg-red-600 text-white p-2 rounded-lg transition-colors shadow-lg"
                      title="Stop Generation"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  ) : (
                    <button
                      onClick={() => handleTextQuery('gemini-3-flash-preview', true)}
                      disabled={!textPrompt.trim()}
                      className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-30 text-white p-2 rounded-lg transition-all shadow-lg shadow-emerald-600/20 active:scale-95"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Suggestions Chips */}
              {!textResponse && !isLoadingText && (
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setTextPrompt(s);
                        handleTextQuery('gemini-3-flash-preview', true, s);
                      }}
                      className="text-[11px] font-medium bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-3 py-1.5 rounded-full transition-all border border-emerald-100 dark:border-emerald-800"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {/* Response Display */}
              {(textResponse || isLoadingText) && (
                <div className="flex-grow space-y-4">
                  <div className="p-5 bg-zinc-50 dark:bg-zinc-800/50 rounded-2xl border border-zinc-100 dark:border-zinc-800 relative group animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {isLoadingText && !textResponse && (
                      <div className="flex flex-col gap-2 py-2">
                        <div className="h-4 bg-emerald-100 dark:bg-emerald-900/30 rounded animate-pulse w-3/4"></div>
                        <div className="h-4 bg-emerald-100 dark:bg-emerald-900/30 rounded animate-pulse w-1/2"></div>
                      </div>
                    )}
                    <div className="text-sm prose dark:prose-invert max-w-none prose-p:leading-relaxed prose-li:my-1 whitespace-pre-wrap">
                      {textResponse}
                      {isLoadingText && <span className="inline-block w-1.5 h-4 bg-emerald-500 ml-1 animate-pulse" />}
                    </div>
                    
                    {textResponse && !isLoadingText && (
                      <div className="mt-4 flex items-center justify-between border-t border-zinc-200 dark:border-zinc-700 pt-4 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button 
                          onClick={() => {
                            const firstLine = textResponse.split('\n')[0].substring(0, 30);
                            setCurrentVocabularyWord(firstLine);
                            setCurrentVocabularyTranslation(textPrompt.substring(0, 30));
                            setCurrentVocabularyWordLanguage(selectedTextOutputLanguage);
                            setShowAddVocabularyModal(true);
                          }}
                          className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 uppercase tracking-widest"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
                          Save as Card
                        </button>
                        <button 
                          onClick={() => navigator.clipboard.writeText(textResponse)}
                          className="text-[10px] font-bold text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 uppercase tracking-widest"
                        >
                          Copy Response
                        </button>
                      </div>
                    )}
                  </div>
                  {groundingUrls.length > 0 && <UrlDisplay urls={groundingUrls} />}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-xl border border-zinc-200 dark:border-zinc-800 relative overflow-hidden flex flex-col">
            <div className={`absolute inset-0 bg-emerald-500/5 transition-opacity ${isLiveApiConnected ? 'opacity-100' : 'opacity-0'}`} />
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                Live Immersion
              </h2>
              <div className="flex items-center gap-3">
                {/* Volume Control */}
                <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800 px-3 py-1 rounded-full shadow-inner">
                  <button 
                    onClick={() => setIsMuted(!isMuted)}
                    className="text-yellow-600 dark:text-yellow-400 hover:scale-110 transition-transform"
                    title={isMuted ? "Unmute" : "Mute"}
                  >
                    {isMuted || volume === 0 ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9 9 0 0119 10a9 9 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7 7 0 0017 10a7 7 0 00-2.343-5.657 1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5 5 0 0115 10a5 5 0 01-1.757 3.536 1 1 0 01-1.415-1.415A3 3 0 0013 10a3 3 0 00-1.172-2.475 1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                    )}
                  </button>
                  <input 
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={isMuted ? 0 : volume}
                    onChange={(e) => {
                      setVolume(parseFloat(e.target.value));
                      if (isMuted) setIsMuted(false);
                    }}
                    className="w-16 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-yellow-500"
                  />
                </div>

                <select 
                  value={selectedLiveVoice} 
                  onChange={e => setSelectedLiveVoice(e.target.value)}
                  disabled={isLiveApiConnected || liveApiConnecting}
                  className="text-xs bg-zinc-100 dark:bg-zinc-800 border-none rounded-lg px-2 py-1 focus:ring-2 focus:ring-yellow-500 disabled:opacity-50 font-semibold cursor-pointer"
                >
                  {AVAILABLE_VOICES.map(voice => (
                    <option key={voice} value={voice}>{voice} Voice</option>
                  ))}
                </select>
                <button
                  onClick={handlePreviewVoice}
                  disabled={isLiveApiConnected || liveApiConnecting || isPreviewingVoice}
                  className="p-1 text-yellow-600 hover:text-yellow-700 disabled:opacity-30 transition-all active:scale-90"
                  title="Preview Voice"
                >
                  {isPreviewingVoice ? (
                    <div className="w-4 h-4 border-2 border-yellow-600 border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <div className="space-y-6 flex flex-col flex-grow">
              <div className="flex-grow space-y-4">
                <div className="flex justify-center py-4">
                  <div className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${isLiveApiConnected ? 'bg-red-500 animate-pulse scale-110 shadow-xl shadow-red-500/30' : 'bg-zinc-100 dark:bg-zinc-800 border-4 border-zinc-50 dark:border-zinc-700'}`}>
                    <svg className={`w-10 h-10 ${isLiveApiConnected ? 'text-white' : 'text-zinc-300'}`} fill="currentColor" viewBox="0 0 20 20"><path d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0 5 5 0 01-10 0 1 1 0 10-2 0 7.001 7.001 0 005.93 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" /></svg>
                  </div>
                </div>
                {isLiveApiConnected ? (
                  <div className="space-y-3 px-2 overflow-y-auto max-h-[300px]">
                    <TranscriptionDisplay label="You" text={liveInputTranscription} />
                    <TranscriptionDisplay label="Assistant" text={liveOutputTranscription} isSpeaking={isAssistantSpeaking} />
                  </div>
                ) : (
                  <p className="text-center text-zinc-500 text-sm px-8 leading-relaxed">Connect to have a real-time conversation about Guyanese culture. The AI can translate your voice into tribal languages instantly.</p>
                )}
              </div>
              <button
                onClick={isLiveApiConnected ? stopLiveConversation : startLiveConversation}
                disabled={liveApiConnecting}
                className={`w-full py-4 rounded-2xl font-black text-sm uppercase tracking-widest transition-all shadow-lg active:scale-95 ${isLiveApiConnected ? 'bg-red-600 hover:bg-red-700 text-white shadow-red-600/20' : 'bg-yellow-500 hover:bg-yellow-600 text-zinc-900 shadow-yellow-500/20'}`}
              >
                {liveApiConnecting ? 'Opening Bridge...' : isLiveApiConnected ? 'Close Conversation' : 'Begin Immersion'}
              </button>
            </div>
          </div>
        </section>

        {/* Vocabulary Builder */}
        <section>
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-3xl font-black text-emerald-800 dark:text-emerald-400">My Vocabulary</h2>
            <button 
              onClick={() => setShowAddVocabularyModal(true)}
              className="bg-emerald-100 hover:bg-emerald-200 dark:bg-emerald-900 dark:hover:bg-emerald-800 text-emerald-800 dark:text-emerald-200 px-5 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-all shadow-md active:scale-95"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
              New Word
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {vocabularyList.map((item) => (
              <div key={item.id} className="group bg-white dark:bg-zinc-900 rounded-[2.5rem] overflow-hidden shadow-md hover:shadow-2xl transition-all border border-zinc-200 dark:border-zinc-800 flex flex-col animate-in zoom-in-95 duration-300">
                <div className="aspect-square relative bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                  {item.imageBase64 ? (
                    <img src={`data:image/jpeg;base64,${item.imageBase64}`} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" alt={item.word} />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center">
                      <div className="text-emerald-500/20 mb-2">
                        <svg className="w-20 h-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                      </div>
                      <button 
                        onClick={() => handleGenerateImageForItem(item)}
                        disabled={generatingImageId === item.id}
                        className="text-[10px] font-black uppercase tracking-widest text-emerald-600 bg-emerald-50 dark:bg-emerald-950 px-6 py-2.5 rounded-full border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 transition-all shadow-sm"
                      >
                        {generatingImageId === item.id ? 'Thinking...' : 'Visualize'}
                      </button>
                    </div>
                  )}
                  <div className="absolute top-4 right-4 flex gap-2">
                    <button 
                      onClick={() => setVocabularyList(prev => prev.filter(i => i.id !== item.id))}
                      className="p-2 bg-white/90 dark:bg-black/90 rounded-full text-red-500 opacity-0 group-hover:opacity-100 transition-all shadow-lg hover:scale-110"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                    </button>
                  </div>
                  <div className="absolute bottom-4 left-4">
                    <span className="bg-emerald-600/90 text-white text-[9px] font-black uppercase tracking-tighter px-3 py-1 rounded-full shadow-lg backdrop-blur-sm">
                      {item.wordLanguage}
                    </span>
                  </div>
                </div>
                <div className="p-8 relative">
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="text-3xl font-black text-emerald-800 dark:text-emerald-300 leading-none tracking-tight">{item.word}</h3>
                    <button 
                      onClick={() => handleTextToSpeech(item.word, 'Kore')}
                      className="text-emerald-500 hover:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/40 p-2 rounded-full transition-all active:scale-90 shadow-sm"
                    >
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9 9 0 0119 10a9 9 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7 7 0 0017 10a7 7 0 00-2.343-5.657 1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5 5 0 0115 10a5 5 0 01-1.757 3.536 1 1 0 01-1.415-1.415A3 3 0 0013 10a3 3 0 00-1.172-2.475 1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                    </button>
                  </div>
                  
                  <div className="flex items-center gap-2 mb-6 h-6">
                    {generatingTranscriptionId === item.id ? (
                      <div className="flex gap-1">
                        {[1, 2, 3].map(i => <div key={i} className="w-1 h-1 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 100}ms` }} />)}
                      </div>
                    ) : item.phoneticTranscription ? (
                      <p className="text-zinc-400 font-mono text-xs">{item.phoneticTranscription}</p>
                    ) : (
                      <button 
                        onClick={() => handleGenerateTranscription(item)}
                        className="text-[10px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-950 px-3 py-1 rounded-lg hover:bg-emerald-100 transition-all uppercase tracking-widest"
                      >
                        Add Pronunciation
                      </button>
                    )}
                  </div>

                  <div className="pt-6 border-t border-zinc-100 dark:border-zinc-800">
                    <p className="text-zinc-600 dark:text-zinc-400 font-semibold text-lg italic leading-tight">"{item.translation}"</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-zinc-100 dark:bg-zinc-900 p-12 mt-20 border-t border-zinc-200 dark:border-zinc-800 text-center text-zinc-400 text-xs">
        <p className="font-bold mb-2 uppercase tracking-widest">Guyanese Tribal Lingua Project</p>
        <p>© 2024 Powered by Google Gemini & Imagen • Preserving Indigenous Culture</p>
      </footer>

      {/* Modal */}
      {showAddVocabularyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
          <div className="bg-white dark:bg-zinc-900 rounded-[3rem] p-10 w-full max-w-md shadow-2xl space-y-8 animate-in zoom-in-95 duration-300 border border-zinc-100 dark:border-zinc-800">
            <div>
              <h2 className="text-3xl font-black tracking-tight text-emerald-800 dark:text-emerald-400">Add to Lexicon</h2>
              <p className="text-sm text-zinc-500 mt-1 italic">Save this word to your personalized study deck.</p>
            </div>
            
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-2 ml-1">Tribal Word</label>
                  <input 
                    value={currentVocabularyWord} 
                    onChange={e => setCurrentVocabularyWord(e.target.value)}
                    placeholder="e.g. Maimy"
                    className="w-full bg-zinc-50 dark:bg-zinc-800 p-4 rounded-2xl border-none focus:ring-2 focus:ring-emerald-500 font-bold"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-2 ml-1">Dialect/Language</label>
                  <select 
                    value={currentVocabularyWordLanguage} 
                    onChange={e => setCurrentVocabularyWordLanguage(e.target.value)}
                    className="w-full bg-zinc-50 dark:bg-zinc-800 p-4 rounded-2xl border-none font-bold"
                  >
                    {GUYANESE_LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-2 ml-1">English Translation</label>
                  <input 
                    value={currentVocabularyTranslation} 
                    onChange={e => setCurrentVocabularyTranslation(e.target.value)}
                    placeholder="e.g. Water"
                    className="w-full bg-zinc-50 dark:bg-zinc-800 p-4 rounded-2xl border-none focus:ring-2 focus:ring-emerald-500 font-bold"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-4 pt-4">
              <button 
                onClick={() => setShowAddVocabularyModal(false)}
                className="flex-1 py-4 font-black text-xs uppercase tracking-widest text-zinc-400 hover:text-zinc-600 transition-all"
              >
                Discard
              </button>
              <button 
                onClick={handleAddVocabularyItem}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-emerald-600/20 transition-all active:scale-95"
              >
                Save Card
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
