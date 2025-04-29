// Web Voice Chat Client with WebSocket proxy
document.addEventListener('DOMContentLoaded', function() {
    // DOM elements
    const startButton = document.getElementById('start-button');
    const stopButton = document.getElementById('stop-button');
    const statusText = document.getElementById('status-text');
    const statusIndicator = document.getElementById('status-indicator');
    const connectionStatus = document.getElementById('connection-status');
    const statusMessagesContainer = document.getElementById('status-messages-container');
    const characterSelect = document.getElementById('character-select');
    const inputDeviceSelect = document.getElementById('input-device');
    const outputDeviceSelect = document.getElementById('output-device');
    const characterName = document.getElementById('character-name');
    const audioVisualizer = document.getElementById('audio-visualizer');

    // Initialize audio context
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    let audioContext = null;
    let socket = null;
    let mediaStream = null;
    let audioInput = null;
    let audioProcessor = null;
    let audioAnalyser = null;
    let audioVisualizerInstance = null;

    // Voice activity detection settings
    const amplitudeThreshold = 0.01;
    let silenceCounter = 0;
    const silenceLimit = 50;

    // Audio settings
    const bufferSize = 4096;
    const sampleRate = 16000;

    // Session management
    let sessionId = null;

    // Status flags
    let isRunning = false;
    let isConnected = false;

    // Initialize
    updateStatus('Disconnected');
    updateConnectionStatus('Disconnected');
    initializeAudioVisualizer();

    // Event listeners
    startButton.addEventListener('click', startVoiceChat);
    stopButton.addEventListener('click', stopVoiceChat);
    characterSelect.addEventListener('change', updateCharacterDisplay);

    // Initialize audio devices
    initializeAudioDevices();

    // Initialize character display
    updateCharacterDisplay();

    /**
     * Initialize audio devices
     */
    async function initializeAudioDevices() {
        try {
            // Request permissions to get device list
            await navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    // Stop the stream immediately
                    stream.getTracks().forEach(track => track.stop());
                });

            // Get device list
            const devices = await navigator.mediaDevices.enumerateDevices();

            // Populate inputs and outputs
            const inputDevices = devices.filter(device => device.kind === 'audioinput');
            const outputDevices = devices.filter(device => device.kind === 'audiooutput');

            // Clear select options
            inputDeviceSelect.innerHTML = '';
            outputDeviceSelect.innerHTML = '';

            // Add default option for input
            const defaultInputOption = document.createElement('option');
            defaultInputOption.value = '';
            defaultInputOption.text = 'Default Microphone';
            inputDeviceSelect.appendChild(defaultInputOption);

            // Add default option for output
            const defaultOutputOption = document.createElement('option');
            defaultOutputOption.value = '';
            defaultOutputOption.text = 'Default Speaker';
            outputDeviceSelect.appendChild(defaultOutputOption);

            // Add input devices
            inputDevices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Microphone ${inputDeviceSelect.length}`;
                inputDeviceSelect.appendChild(option);
            });

            // Add output devices
            outputDevices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Speaker ${outputDeviceSelect.length}`;
                outputDeviceSelect.appendChild(option);
            });

        } catch (error) {
            console.error('Error initializing audio devices:', error);
            logStatus('Error: Could not access audio devices. Please check permissions.');
        }
    }

    /**
     * Update character display
     */
    function updateCharacterDisplay() {
        const character = characterSelect.value;
        characterName.textContent = character;

        // Update colors based on character
        const root = document.documentElement;
        if (character === 'Miles') {
            // Set Miles blue color
            root.style.setProperty('--color-accent', 'var(--color-accent-blue)');
            root.style.setProperty('--color-accent-dark', 'var(--color-accent-blue-dark)');
        } else if (character === 'Maya') {
            // Set Maya pink color
            root.style.setProperty('--color-accent', 'var(--color-accent-pink)');
            root.style.setProperty('--color-accent-dark', 'var(--color-accent-pink-dark)');
        }
    }

    /**
     * Initialize audio visualizer
     */
    function initializeAudioVisualizer() {
        audioVisualizerInstance = new AudioVisualizer(audioVisualizer);
    }

    /**
     * Start voice chat
     */
    async function startVoiceChat() {
        if (isRunning) return;

        try {
            // Update UI
            startButton.disabled = true;
            stopButton.disabled = false;
            characterSelect.disabled = true;
            inputDeviceSelect.disabled = true;
            outputDeviceSelect.disabled = true;

            isRunning = true;
            updateStatus('Starting...');

            // Get selected character
            const character = characterSelect.value;

            // Create a new session
            await createSession(character);

            // Initialize audio context
            audioContext = new AudioContext({ sampleRate: sampleRate });

            // Set up microphone access
            await setupMicrophone();

            // Connect to WebSocket
            connectWebSocket();

            // Start visualizer
            startVisualization();

            updateStatus('Connected');
            updateConnectionStatus('Connected');

        } catch (error) {
            console.error('Error starting voice chat:', error);
            logStatus(`Error: ${error.message}`);
            stopVoiceChat();
        }
    }

    /**
     * Stop voice chat
     */
    async function stopVoiceChat() {
        if (!isRunning) return;

        try {
            isRunning = false;

            // Close WebSocket
            if (socket) {
                socket.close();
                socket = null;
            }

            // Close audio context and streams
            if (audioProcessor) {
                audioProcessor.disconnect();
                audioProcessor = null;
            }

            if (audioInput) {
                audioInput.disconnect();
                audioInput = null;
            }

            if (audioAnalyser) {
                audioAnalyser.disconnect();
                audioAnalyser = null;
            }

            if (mediaStream) {
                mediaStream.getTracks().forEach(track => track.stop());
                mediaStream = null;
            }

            if (audioContext) {
                await audioContext.close();
                audioContext = null;
            }

            // Delete session on server
            if (sessionId) {
                await deleteSession(sessionId);
                sessionId = null;
            }

            // Update UI
            startButton.disabled = false;
            stopButton.disabled = true;
            characterSelect.disabled = false;
            inputDeviceSelect.disabled = false;
            outputDeviceSelect.disabled = false;

            updateStatus('Disconnected');
            updateConnectionStatus('Disconnected');

            // Stop visualizer
            if (audioVisualizerInstance) {
                audioVisualizerInstance.stop();
            }

        } catch (error) {
            console.error('Error stopping voice chat:', error);
            logStatus(`Error stopping: ${error.message}`);
        }
    }

    /**
     * Create a session on the server
     */
    async function createSession(character) {
        try {
            const response = await fetch('/api/sessions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ character })
            });

            if (!response.ok) {
                throw new Error(`Failed to create session: ${response.statusText}`);
            }

            const data = await response.json();
            sessionId = data.session_id;

            logStatus(`Session created with ${character}`);
            return sessionId;

        } catch (error) {
            console.error('Error creating session:', error);
            throw new Error('Failed to create session');
        }
    }

    /**
     * Delete a session on the server
     */
    async function deleteSession(sid) {
        try {
            const response = await fetch(`/api/sessions/${sid}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                console.error(`Failed to delete session: ${response.statusText}`);
            }

            logStatus('Session closed');

        } catch (error) {
            console.error('Error deleting session:', error);
        }
    }

    /**
     * Connect to the WebSocket
     */
    function connectWebSocket() {
        if (!sessionId) {
            throw new Error('No session ID available');
        }

        // Create WebSocket URL
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}`;

        // Create WebSocket
        socket = new WebSocket(wsUrl);

        // Set up event handlers
        socket.onopen = handleSocketOpen;
        socket.onclose = handleSocketClose;
        socket.onerror = handleSocketError;
        socket.onmessage = handleSocketMessage;

        logStatus('Connecting to server...');
    }

    /**
     * Handle WebSocket open event
     */
    function handleSocketOpen() {
        console.log('WebSocket connected');
        isConnected = true;
        logStatus('WebSocket connected');

        // Start sending ping messages to keep the connection alive
        startPingInterval();
    }

    /**
     * Handle WebSocket close event
     */
    function handleSocketClose(event) {
        console.log('WebSocket closed:', event);
        isConnected = false;
        logStatus(`WebSocket closed: ${event.reason || 'Connection closed'}`);

        // Stop the voice chat if it's still running
        if (isRunning) {
            stopVoiceChat();
        }
    }

    /**
     * Handle WebSocket error event
     */
    function handleSocketError(error) {
        console.error('WebSocket error:', error);
        logStatus('WebSocket error occurred');
    }

    /**
     * Handle WebSocket message event
     */
    function handleSocketMessage(event) {
        try {
            const message = JSON.parse(event.data);

            // Handle different message types
            switch (message.type) {
                case 'status':
                    updateStatus(message.status);
                    updateConnectionStatus(message.connectionStatus);
                    break;

                case 'audio':
                    processAudioMessage(message);
                    break;

                case 'error':
                    logStatus(`Error: ${message.message}`);
                    break;

                case 'pong':
                    // Ping response, nothing to do
                    break;

                default:
                    console.log('Unknown message type:', message.type);
            }

        } catch (error) {
            console.error('Error processing message:', error);
        }
    }

    /**
     * Process audio message from server
     */
    function processAudioMessage(message) {
        if (!audioContext) return;

        try {
            // Decode base64 audio data
            const audioArrayBuffer = base64ToArrayBuffer(message.data);

            // Play the audio
            playAudio(message.data, message.sampleRate, message.preserveQuality);

            // Visualize the audio
            if (audioVisualizerInstance) {
                const audioData = new Float32Array(new Int16Array(audioArrayBuffer).length);
                const int16Data = new Int16Array(audioArrayBuffer);
                for (let i = 0; i < int16Data.length; i++) {
                    audioData[i] = int16Data[i] / 32768.0;
                }
                audioVisualizerInstance.updateOutputData(audioData);
            }

        } catch (error) {
            console.error('Error processing audio message:', error);
        }
    }

    /**
     * Convert base64 to ArrayBuffer
     */
    function base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);

        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        return bytes.buffer;
    }

    /**
     * Play audio data
     */
    function playAudio(audioData, sampleRate, preserveQuality = true) {
        if (!audioContext) return;

        try {
            // Decode base64 audio data
            const byteArray = base64ToArrayBuffer(audioData);
            
            // Convert byteArray to Int16Array (16-bit PCM format that Sesame AI uses)
            const int16Data = new Int16Array(byteArray);
            
            // Create an audio buffer with higher sample rate for better quality
            const frameCount = int16Data.length;
            // Use a higher sample rate when available
            const effectiveSampleRate = sampleRate || 24000;
            const audioBuffer = audioContext.createBuffer(1, frameCount, effectiveSampleRate);
            
            // Get the raw audio data and convert from Int16 to Float32 format with enhanced precision
            const channelData = audioBuffer.getChannelData(0);
            for (let i = 0; i < frameCount; i++) {
                // Convert from Int16 (-32768 to 32767) to Float32 (-1.0 to 1.0)
                // Add slight emphasis on mid-range frequencies where voice intelligibility is critical
                channelData[i] = (int16Data[i] / 32768.0);
            }
            
            // Create audio source
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            
            // Create higher quality audio pipeline
            let outputNode = source;
            
            if (preserveQuality) {
                // Add a high-quality context with enhanced voice settings
                const compressor = audioContext.createDynamicsCompressor();
                compressor.threshold.value = -50;
                compressor.knee.value = 40;
                // Dynamic compression settings optimized for voice
                compressor.threshold.value = -20;  // Slightly higher threshold for less compression
                compressor.knee.value = 25;        // Smoother compression curve
                compressor.ratio.value = 4;        // Gentler ratio for more natural sound
                compressor.attack.value = 0.005;   // Slightly slower attack
                compressor.release.value = 0.25;   // Moderate release for natural decay
                
                // Create a biquad filter for voice enhancement
                const voiceEQ = audioContext.createBiquadFilter();
                voiceEQ.type = "peaking";        // EQ bell curve
                voiceEQ.frequency.value = 2500;  // Enhance speech intelligibility range
                voiceEQ.Q.value = 1.2;           // Slightly narrower width
                voiceEQ.gain.value = 3;          // +3dB boost to this frequency range
                
                // Create a high-pass filter to remove rumble
                const highPass = audioContext.createBiquadFilter();
                highPass.type = "highpass";
                highPass.frequency.value = 80;   // Cut below 80Hz
                
                // Create a gain node to adjust the signal volume
                const gainNode = audioContext.createGain();
                gainNode.gain.value = 0.8;       // Lower volume to 80% of original
                
                // Connect through our enhanced pipeline
                source.connect(highPass);
                highPass.connect(voiceEQ);
                voiceEQ.connect(compressor);
                compressor.connect(gainNode);
                outputNode = gainNode;
            }
            
            // Connect to destination
            outputNode.connect(audioContext.destination);
            
            // Start playing
            source.start(0);
            
        } catch (error) {
            console.error('Error playing audio:', error);
        }
    }

    /**
     * Set up microphone access
     */
    async function setupMicrophone() {
        try {
            // Get selected input device
            const deviceId = inputDeviceSelect.value;

            // Set up constraints
            const constraints = {
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    sampleRate: { ideal: sampleRate },
                    channelCount: { ideal: 1 },
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            };

            // Get media stream
            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

            // Create audio source
            audioInput = audioContext.createMediaStreamSource(mediaStream);

            // Create analyser for visualization
            audioAnalyser = audioContext.createAnalyser();
            audioAnalyser.fftSize = 2048;
            audioInput.connect(audioAnalyser);

            // Create script processor for audio processing
            audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            audioInput.connect(audioProcessor);
            audioProcessor.connect(audioContext.destination);

            // Set up audio processing
            audioProcessor.onaudioprocess = processAudio;

            logStatus('Microphone connected');

        } catch (error) {
            console.error('Error setting up microphone:', error);
            throw new Error('Could not access microphone');
        }
    }

    /**
     * Process audio from microphone
     */
    function processAudio(e) {
        if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN) return;

        try {
            // Get input data
            const inputData = e.inputBuffer.getChannelData(0);

            // Calculate RMS (audio level)
            let sum = 0;
            for (let i = 0; i < inputData.length; i++) {
                sum += inputData[i] * inputData[i];
            }
            const rms = Math.sqrt(sum / inputData.length);

            // Update visualizer
            if (audioVisualizerInstance) {
                audioVisualizerInstance.updateInputData(inputData, rms);
            }

            // Voice activity detection
            if (rms > amplitudeThreshold) {
                // Voice detected, reset silence counter
                silenceCounter = 0;
            } else {
                // Increment silence counter
                silenceCounter++;
            }

            // Send audio data if we have voice or periodically during silence
            if (silenceCounter < silenceLimit || silenceCounter % 10 === 0) {
                // Convert to 16-bit PCM
                const pcmData = floatTo16BitPCM(inputData);

                // Send to server as base64
                const base64Data = arrayBufferToBase64(pcmData.buffer);
                socket.send(JSON.stringify({
                    type: 'audio',
                    data: base64Data
                }));
            }

        } catch (error) {
            console.error('Error processing audio:', error);
        }
    }

    /**
     * Convert Float32Array to Int16Array (16-bit PCM)
     */
    function floatTo16BitPCM(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            // Convert Float32 (-1.0...1.0) to Int16 (-32768...32767)
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16Array;
    }

    /**
     * Convert ArrayBuffer to base64
     */
    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Start visualization
     */
    function startVisualization() {
        if (audioVisualizerInstance) {
            audioVisualizerInstance.start();
        }
    }

    /**
     * Start sending ping messages
     */
    let pingInterval = null;
    function startPingInterval() {
        // Clear any existing interval
        if (pingInterval) {
            clearInterval(pingInterval);
        }

        // Send ping every 30 seconds
        pingInterval = setInterval(() => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    }

    /**
     * Update status display
     */
    function updateStatus(status) {
        statusText.textContent = status;

        // Update status indicator color
        if (status === 'Connected' || status.startsWith('Connected to')) {
            statusIndicator.className = 'status-indicator connected';
        } else if (status === 'Disconnected') {
            statusIndicator.className = 'status-indicator disconnected';
        } else {
            statusIndicator.className = 'status-indicator connecting';
        }
    }

    /**
     * Update connection status in footer
     */
    function updateConnectionStatus(status) {
        connectionStatus.textContent = status;

        // Update class for color styling
        if (status === 'Connected') {
            connectionStatus.className = 'connected';
        } else if (status === 'Disconnected') {
            connectionStatus.className = 'disconnected';
        } else {
            connectionStatus.className = 'connecting';
        }
    }

    /**
     * Log status message
     */
    function logStatus(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.className = 'status-message';
        logEntry.textContent = `${timestamp}: ${message}`;

        // Add to status messages container
        statusMessagesContainer.appendChild(logEntry);

        // Scroll to bottom
        statusMessagesContainer.scrollTop = statusMessagesContainer.scrollHeight;

        // Limit number of messages (keep last 20)
        while (statusMessagesContainer.children.length > 20) {
            statusMessagesContainer.removeChild(statusMessagesContainer.firstChild);
        }
    }
});
