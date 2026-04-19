document.addEventListener('DOMContentLoaded', () => {
    const textInput = document.getElementById('text-input');
    const processBtn = document.getElementById('process-btn');
    const clearBtn = document.getElementById('clear-btn');
    const controlsSection = document.getElementById('controls');
    const sentencesSection = document.getElementById('sentences-container');
    const sentencesList = document.getElementById('sentences-list');
    
    // Voice settings
    const voiceSelect = document.getElementById('voice-select');
    const rateInput = document.getElementById('rate-input');
    const rateValue = document.getElementById('rate-value');
    const timeInput = document.getElementById('time-input');

    // Audio controls
    const playBtn = document.getElementById('play-btn');
    const pauseBtn = document.getElementById('pause-btn');
    const stopBtn = document.getElementById('stop-btn');
    const statusText = document.getElementById('status-text');
    const waveAnimation = document.getElementById('wave');
    const recordingPulse = document.getElementById('recording-pulse');
    const playbackContainer = document.getElementById('playback-container');
    const finalAudio = document.getElementById('final-audio');

    let sentences = [];
    let currentSentenceIndex = 0;
    const synth = window.speechSynthesis;
    let isSpeaking = false;
    let voices = [];

    // Recording variables
    let mediaStream = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let allAudioBlobs = []; // Stores complete session
    let recordingTimeout = null;
    let synthStartTime = 0;

    // Audio Feedback (Beeps)
    const AudioContextAPI = window.AudioContext || window.webkitAudioContext;
    let audioCtx = null; // initialized on interaction

    function playBeep(type) {
        if (!audioCtx) audioCtx = new AudioContextAPI();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        const now = audioCtx.currentTime;
        gainNode.gain.value = 0.2; // 20% volume is safe but very audible for square wave
        
        if (type === 'start') {
            oscillator.type = 'square';
            oscillator.frequency.value = 800;
        } else if (type === 'stop') {
            oscillator.type = 'square';
            oscillator.frequency.value = 400;
        }
        
        oscillator.start(now);
        oscillator.stop(now + 0.15); // 150ms beep
    }

    // Initialize rate from localStorage
    const savedRate = localStorage.getItem('preferredRate');
    if (savedRate) {
        rateInput.value = savedRate;
        rateValue.textContent = Number(savedRate).toFixed(1) + 'x';
    }

    // Initialize extra time from localStorage
    const savedTime = localStorage.getItem('preferredTime');
    if (savedTime) {
        timeInput.value = savedTime;
    }

    // Initialize text from localStorage
    const savedText = localStorage.getItem('savedText');
    if (savedText) {
        textInput.value = savedText;
    }

    // --- Voices handling ---
    function populateVoiceList() {
        if (typeof speechSynthesis === 'undefined') return;

        // Only get voices that start with 'en' to guarantee English
        voices = synth.getVoices().filter(v => v.lang.startsWith('en'));
        voiceSelect.innerHTML = '';

        voices.forEach((voice, i) => {
            const option = document.createElement('option');
            // Add a cloud icon if the voice requires an internet connection
            const type = voice.localService ? "" : " (Online)";
            option.textContent = `${voice.name} (${voice.lang})${type}`;
            option.value = i;
            voiceSelect.appendChild(option);
        });

        // Try restoring the saved voice first
        const savedVoiceURI = localStorage.getItem('preferredVoiceURI');
        let selectedIndex = -1;

        if (savedVoiceURI) {
            selectedIndex = voices.findIndex(v => v.voiceURI === savedVoiceURI);
        }

        // If no saved voice or it wasn't found, pick a default
        if (selectedIndex === -1 && voices.length > 0) {
            selectedIndex = 0; // The first English voice in the filtered list
        }

        if (selectedIndex !== -1) {
            voiceSelect.selectedIndex = selectedIndex;
        }
    }

    populateVoiceList();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = populateVoiceList;
    }

    // Save preferences on change
    voiceSelect.addEventListener('change', () => {
        const selectedVoice = voices[voiceSelect.value];
        if (selectedVoice) {
            localStorage.setItem('preferredVoiceURI', selectedVoice.voiceURI);
        }
    });

    rateInput.addEventListener('input', () => {
        const currentRate = Number(rateInput.value).toFixed(1);
        rateValue.textContent = currentRate + 'x';
        localStorage.setItem('preferredRate', rateInput.value);
    });

    timeInput.addEventListener('change', () => {
        let val = parseInt(timeInput.value);
        if (isNaN(val) || val < 1) val = 10;
        timeInput.value = val;
        localStorage.setItem('preferredTime', val);
    });

    textInput.addEventListener('input', () => {
        localStorage.setItem('savedText', textInput.value);
    });

    // --- Microphone & Audio Unlocking ---
    async function unlockEngineAndGetMic() {
        // Unlock Web Audio API synchronously during click event
        if (!audioCtx) audioCtx = new AudioContextAPI();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        // Unlock SpeechSynthesis synchronously
        synth.resume();
        const silent = new SpeechSynthesisUtterance('');
        silent.volume = 0;
        synth.speak(silent);

        if (!mediaStream) {
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (err) {
                console.error("Microphone access denied or failed:", err);
                let reason = "Permiso denegado por el usuario o el navegador.";
                if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                    reason = "No se ha detectado ningún micrófono conectado a esta computadora o está deshabilitado.";
                } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
                    reason = "Windows o tu Antivirus está bloqueando el micrófono (ve a Privacidad de Windows), o está siendo ocupado por otra app como Zoom.";
                } else if (err.name === 'NotAllowedError') {
                    reason = "Has denegado el permiso o necesitas permitir explícitamente el micrófono en la barra de URL de Chrome.";
                }
                
                alert(`No hemos podido usar el micrófono.\n\nPosible razón: ${reason}\n\nCódigo técnico: ${err.name} - ${err.message}`);
                return false;
            }
        }
        return true;
    }

    // --- Processing Text ---
    processBtn.addEventListener('click', () => {
        const text = textInput.value.trim();
        if (!text) {
            alert('Por favor, ingresa algún texto para procesar.');
            return;
        }

        // Split text by period or line breaks. Handle cases with multiple spaces/newlines.
        sentences = text.split(/[.\n\r]+/)
            .map(s => s.trim())
            .filter(s => s.length > 0);

        if (sentences.length === 0) {
            alert('No se encontraron oraciones válidas.');
            return;
        }

        renderSentences();
        resetPlayer();
        
        // Show sections
        controlsSection.classList.remove('hidden');
        sentencesSection.classList.remove('hidden');
    });

    clearBtn.addEventListener('click', () => {
        textInput.value = '';
        sentences = [];
        stopAudio();
        controlsSection.classList.add('hidden');
        sentencesSection.classList.add('hidden');
        playbackContainer.classList.add('hidden');
        sentencesList.innerHTML = '';
        allAudioBlobs = [];
        if (finalAudio.src) {
            URL.revokeObjectURL(finalAudio.src);
            finalAudio.src = '';
        }
        localStorage.removeItem('savedText');
    });

    // --- Rendering ---
    function renderSentences() {
        sentencesList.innerHTML = '';
        sentences.forEach((sentence, index) => {
            const li = document.createElement('li');
            li.className = 'sentence-item';
            // Store index in data attribute
            li.dataset.index = index;
            
            // Re-append the period that was removed during split, for visual clarity and speech
            li.innerHTML = `<span class="sentence-idx">${index + 1}</span><span class="sentence-text">${sentence}.</span>`;
            
            li.addEventListener('click', () => {
                // Play from this specific sentence
                playFromIndex(index);
            });
            
            sentencesList.appendChild(li);
        });
    }

    function updateActiveSentence(index) {
        document.querySelectorAll('.sentence-item').forEach((li, i) => {
            if (i === index) {
                li.classList.add('active');
                // Scroll into view if needed
                li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else {
                li.classList.remove('active');
            }
        });
    }

    // --- Text to Speech Logic ---
    function speakSentence(index) {
        if (index >= sentences.length) {
            finishEntireSession();
            return;
        }

        currentSentenceIndex = index;
        updateActiveSentence(index);

        // Cancel any current speech before starting new
        synth.cancel();

        // The text to speak (append period so intonation is correct)
        const utterance = new SpeechSynthesisUtterance(sentences[index] + '.');
        
        const selectedVoice = voices[voiceSelect.value];
        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang; // Crucial for some engines to work!
        }
        utterance.rate = parseFloat(rateInput.value);
        
        utterance.onstart = () => {
            isSpeaking = true;
            synthStartTime = Date.now();
            recordingPulse.classList.add('hidden');
            statusText.textContent = `Reproduciendo (${index + 1}/${sentences.length})`;
            waveAnimation.classList.remove('hidden');
            playBtn.classList.add('hidden');
            pauseBtn.classList.remove('hidden');
        };

        utterance.onend = () => {
            if (isSpeaking) {
                const durationMs = Date.now() - synthStartTime;
                startRecordingForSentence(index, durationMs);
            }
        };

        utterance.onerror = (e) => {
            console.error('Speech synthesis error:', e);
            if (e.error !== 'interrupted' && e.error !== 'canceled') {
                stopAudio();
            }
        };

        synth.speak(utterance);
    }

    function startRecordingForSentence(index, readDurationMs) {
        if (!mediaStream) {
            handleNextSentence(index + 1);
            return;
        }

        audioChunks = [];
        // Use webm audio if supported
        const options = MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : {};
        mediaRecorder = new MediaRecorder(mediaStream, options);
        
        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            if (!isSpeaking) return; // Discard if user stopped generally
            playBeep('stop');
            const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
            allAudioBlobs.push(blob);
            
            // Reproducir inmediatamente lo que el usuario grabó
            recordingPulse.classList.add('hidden');
            statusText.textContent = `Reproduciendo tu grabación...`;
            
            const tempUrl = URL.createObjectURL(blob);
            const tempAudio = new Audio(tempUrl);
            
            tempAudio.onended = () => {
                URL.revokeObjectURL(tempUrl);
                handleNextSentence(index + 1);
            };
            
            tempAudio.onerror = (e) => {
                console.error("Audio playback error:", e);
                URL.revokeObjectURL(tempUrl);
                handleNextSentence(index + 1);
            };
            
            tempAudio.play().catch(e => {
                console.error("Auto-play prevented or error: ", e);
                URL.revokeObjectURL(tempUrl);
                handleNextSentence(index + 1);
            });
        };

        playBeep('start');
        mediaRecorder.start();
        
        const extraWaitTimeMs = (parseInt(timeInput.value) || 10) * 1000;
        
        waveAnimation.classList.add('hidden');
        recordingPulse.classList.remove('hidden');
        statusText.textContent = `🎤 Repite... Tienes ${Math.ceil((readDurationMs + extraWaitTimeMs)/1000)} seg`;
        
        const waitTime = readDurationMs + extraWaitTimeMs;
        
        recordingTimeout = setTimeout(() => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
        }, waitTime);
    }

    function handleNextSentence(nextIndex) {
        recordingPulse.classList.add('hidden');
        if (!isSpeaking) return;
        
        if (nextIndex >= sentences.length) {
            finishEntireSession();
        } else {
            speakSentence(nextIndex);
        }
    }

    async function finishEntireSession() {
        stopAudio();
        statusText.textContent = 'Sesión finalizada';
        
        if (allAudioBlobs.length > 0) {
            // Concatenate all recorded segments
            const finalBlob = new Blob(allAudioBlobs, { type: allAudioBlobs[0].type });
            const audioUrl = URL.createObjectURL(finalBlob);
            finalAudio.src = audioUrl;
            playbackContainer.classList.remove('hidden');
        }
    }

    async function playFromIndex(index) {
        if (sentences.length === 0) return;
        
        const micReady = await unlockEngineAndGetMic();
        if (!micReady) return;
        
        currentSentenceIndex = index;
        allAudioBlobs = []; // clear previous recordings
        playbackContainer.classList.add('hidden');
        if (finalAudio.src) URL.revokeObjectURL(finalAudio.src);
        finalAudio.src = '';

        synth.cancel();
        speakSentence(currentSentenceIndex);
    }

    function resetPlayer() {
        synth.cancel();
        clearTimeout(recordingTimeout);
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        currentSentenceIndex = 0;
        isSpeaking = false;
        statusText.textContent = 'Listo para reproducir';
        waveAnimation.classList.add('hidden');
        recordingPulse.classList.add('hidden');
        playBtn.classList.remove('hidden');
        pauseBtn.classList.add('hidden');
        updateActiveSentence(-1); // remove active states
    }

    function stopAudio() {
        synth.cancel();
        clearTimeout(recordingTimeout);
        isSpeaking = false;
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        statusText.textContent = 'Detenido';
        waveAnimation.classList.add('hidden');
        recordingPulse.classList.add('hidden');
        playBtn.classList.remove('hidden');
        pauseBtn.classList.add('hidden');
        updateActiveSentence(-1);
    }

    // --- Control Buttons ---
    playBtn.addEventListener('click', async () => {
        if (sentences.length === 0) return;

        const micReady = await unlockEngineAndGetMic();
        if (!micReady) return;

        if (synth.paused) {
            // Resume - doesn't play well with recording state machine if paused mid recording, but we support TTS resume
            synth.resume();
            isSpeaking = true;
            recordingPulse.classList.add('hidden');
            statusText.textContent = `Reproduciendo (${currentSentenceIndex + 1}/${sentences.length})`;
            waveAnimation.classList.remove('hidden');
            playBtn.classList.add('hidden');
            pauseBtn.classList.remove('hidden');
        } else {
            // Start from where it stopped or beginning
            allAudioBlobs = [];
            playbackContainer.classList.add('hidden');
            speakSentence(currentSentenceIndex);
        }
    });

    pauseBtn.addEventListener('click', () => {
        if (synth.speaking && !synth.paused) {
            synth.pause();
            isSpeaking = false; // It's paused
            statusText.textContent = 'Pausado';
            waveAnimation.classList.add('hidden');
            playBtn.classList.remove('hidden');
            pauseBtn.classList.add('hidden');
        }
    });

    stopBtn.addEventListener('click', () => {
        stopAudio();
        // Return to first sentence visually without auto-playing
        currentSentenceIndex = 0;
        statusText.textContent = 'Listo para reproducir';
    });

    // Handle abrupt window close or reload
    window.addEventListener('beforeunload', () => {
        synth.cancel();
    });
});
