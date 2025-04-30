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
    
    // Add recovery button
    addRecoveryButton();

    // Initialize audio context
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    let audioContext = null;
    let socket = null;
    let mediaStream = null;
    let audioInput = null;
    let audioProcessor = null;
    let audioAnalyser = null;

    let audioQueue = [];
    let isPlayingFromQueue = false;
    let lastPlayTime = 0;
    const MIN_GAP_BETWEEN_CHUNKS = 50; // milliseconds

    let audioVisualizerInstance = null;

    // Voice activity detection settings
    const amplitudeThreshold = 0.01;
    let silenceCounter = 0;
    const silenceLimit = 50;

    // Audio settings - reduce buffer size for less latency
    const bufferSize = 1024; // Changed from 4096 to 1024 for less lag
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

    // Add audio context resume function to handle suspended state - MOVED OUTSIDE OF INITIALIZATION
    function ensureAudioContextRunning() {
        if (audioContext && audioContext.state !== 'running') {
            audioContext.resume().then(() => {
                console.log('AudioContext resumed successfully');
            }).catch(err => {
                console.error('Failed to resume AudioContext:', err);
            });
        }
    }

    // Call this when handling user interaction - MOVED OUTSIDE OF INITIALIZATION
    document.addEventListener('click', ensureAudioContextRunning);

    // Initialize audio devices with error handling
    initializeAudioDevices().catch(err => {
        console.error('Failed to initialize audio devices:', err);
        logStatus('Error initializing audio devices. Please check permissions and try again.');
        // Still enable the start button to allow retry
        startButton.disabled = false;
    });

    // Initialize character display
    updateCharacterDisplay();

    /**
     * Initialize audio devices with improved error handling
     */
    async function initializeAudioDevices() {
        try {
            logStatus('Initializing audio devices...');

            // Request permissions to get device list - with timeout
            const permissionPromise = navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    // Stop the stream immediately after getting permission
                    stream.getTracks().forEach(track => track.stop());
                    return true;
                });

            // Add timeout to avoid hanging indefinitely
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Timeout requesting microphone permission')), 10000);
            });

            // Race between permission and timeout
            await Promise.race([permissionPromise, timeoutPromise]);

            // Get device list
            const devices = await navigator.mediaDevices.enumerateDevices();

            // Populate inputs and outputs
            const inputDevices = devices.filter(device => device.kind === 'audioinput');
            const outputDevices = devices.filter(device => device.kind === 'audiooutput');

            // Log device counts for debugging
            console.log(`Found ${inputDevices.length} input devices and ${outputDevices.length} output devices`);

            if (inputDevices.length === 0) {
                logStatus('Warning: No microphone devices detected');
            }

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

            logStatus('Audio devices loaded successfully');

        } catch (error) {
            console.error('Error initializing audio devices:', error);
            logStatus(`Error: Could not access audio devices. ${error.message}`);
            // Re-throw to be handled by the caller
            throw error;
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

            // Ensure audio context is running
            if (audioContext.state !== 'running') {
                await audioContext.resume();
            }

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
     * Handle WebSocket close event with reconnection logic
     */
    function handleSocketClose(event) {
        console.log('WebSocket closed:', event);
        isConnected = false;
        logStatus(`WebSocket closed: ${event.reason || 'Connection closed'}`);
        
        updateConnectionStatus('Disconnected');
        
        // If it's an abnormal closure and we're still running, try to reconnect the browser WebSocket
        if (event.code !== 1000 && isRunning) {
            logStatus('Attempting to reconnect browser WebSocket...');
            setTimeout(function() {
                if (isRunning && sessionId) {
                    connectWebSocket();
                }
            }, 2000); // Wait 2 seconds before reconnecting
        } else if (!isRunning) {
            // Clean stop requested
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
                    
                case 'reconnect_result':
                    if (message.success) {
                        logStatus('Reconnection successful');
                        // Try to restart audio context
                        if (audioContext && audioContext.state !== 'running') {
                            audioContext.resume().then(() => {
                                logStatus('Audio context resumed');
                            }).catch(err => {
                                logStatus('Failed to resume audio context: ' + err.message);
                            });
                        }
                    } else {
                        logStatus('Reconnection failed');
                    }
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

            // Convert byteArray to Int16Array (16-bit PCM format)
            const int16Data = new Int16Array(byteArray);

            // Use provided sample rate or default to high quality
            const effectiveSampleRate = sampleRate || 24000;
            const frameCount = int16Data.length;

            // Calculate duration of this audio chunk
            const durationMs = (frameCount / effectiveSampleRate) * 1000;

            // Create audio processing object
            const audioChunk = {
                data: int16Data,
                sampleRate: effectiveSampleRate,
                frameCount: frameCount,
                duration: durationMs,
                preserveQuality: preserveQuality
            };

            // Add to queue for sequential playback
            audioQueue.push(audioChunk);

            // Start playing if not already
            if (!isPlayingFromQueue) {
                processAudioQueue();
            }

        } catch (error) {
            console.error('Error queuing audio:', error);
        }
    }

    function processAudioQueue() {
        if (audioQueue.length === 0) {
            isPlayingFromQueue = false;
            return;
        }

        isPlayingFromQueue = true;
        const now = Date.now();

        // Respect minimum gap between audio chunks
        const timeSinceLastPlay = now - lastPlayTime;
        if (timeSinceLastPlay < MIN_GAP_BETWEEN_CHUNKS && lastPlayTime !== 0) {
            // Wait before playing next chunk
            setTimeout(processAudioQueue, MIN_GAP_BETWEEN_CHUNKS - timeSinceLastPlay);
            return;
        }

        // Get next audio chunk
        const chunk = audioQueue.shift();
        lastPlayTime = now;

        try {
            // Create an audio buffer
            const audioBuffer = audioContext.createBuffer(1, chunk.frameCount, chunk.sampleRate);

            // Get the raw audio data and convert from Int16 to Float32 format
            const channelData = audioBuffer.getChannelData(0);
            for (let i = 0; i < chunk.frameCount; i++) {
                // Convert from Int16 (-32768 to 32767) to Float32 (-1.0 to 1.0) with improved precision
                channelData[i] = chunk.data[i] / 32768.0;
            }

            // Create audio source
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;

            // Create higher quality audio pipeline
            let outputNode = source;

            if (chunk.preserveQuality) {
                // Create a high-pass filter to remove rumble
                const highPass = audioContext.createBiquadFilter();
                highPass.type = "highpass";
                highPass.frequency.value = 80;    // Cut below 80Hz

                // Create a low-pass filter to remove high-frequency noise
                const lowPass = audioContext.createBiquadFilter();
                lowPass.type = "lowpass";
                lowPass.frequency.value = 12000;  // Cut above 12kHz

                // Add vocal clarity filter - improved for speech intelligibility
                const clarityEQ = audioContext.createBiquadFilter();
                clarityEQ.type = "peaking";
                clarityEQ.frequency.value = 2500; // Focus on speech intelligibility
                clarityEQ.Q.value = 0.8;          // Wider filter for natural sound
                clarityEQ.gain.value = 3;         // +3dB boost for clarity

                // Add second vocal presence filter
                const presenceEQ = audioContext.createBiquadFilter();
                presenceEQ.type = "peaking";
                presenceEQ.frequency.value = 5000; // Higher vocal presence
                presenceEQ.Q.value = 1.2;
                presenceEQ.gain.value = 2;        // +2dB boost

                // Add bass reduction for clearer speech
                const bassReduction = audioContext.createBiquadFilter();
                bassReduction.type = "peaking";
                bassReduction.frequency.value = 250;
                bassReduction.Q.value = 1.0;
                bassReduction.gain.value = -2;    // -2dB cut to reduce muddiness

                // Add compressor with speech-optimized settings
                const compressor = audioContext.createDynamicsCompressor();
                compressor.threshold.value = -20;  // Lower threshold for more consistent volume
                compressor.knee.value = 6;         // Gentler knee for more natural compression
                compressor.ratio.value = 4;        // Higher ratio for more consistent levels
                compressor.attack.value = 0.005;   // Fast attack to catch transients
                compressor.release.value = 0.15;   // Short release for speech

                // Master gain with slight boost
                const gainNode = audioContext.createGain();
                gainNode.gain.value = 1.1;        // Slight volume boost

                // Connect through enhanced pipeline for clearest speech
                source.connect(highPass);
                highPass.connect(bassReduction);
                bassReduction.connect(clarityEQ);
                clarityEQ.connect(presenceEQ);
                presenceEQ.connect(lowPass);
                lowPass.connect(compressor);
                compressor.connect(gainNode);
                outputNode = gainNode;
            }

            // Connect to destination
            outputNode.connect(audioContext.destination);

            // When playback ends, process next chunk
            source.onended = processAudioQueue;

            // Start playing with slight delay to prevent clicks
            source.start(audioContext.currentTime + 0.01);

            // Visualize the audio

    /**
     * Request server to reconnect the AI WebSocket
     */
    function requestReconnection() {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            logStatus('Cannot reconnect: WebSocket not connected');
            return false;
        }

        logStatus('Requesting reconnection to the AI...');
        socket.send(JSON.stringify({
            type: 'command',
            command: 'reconnect'
        }));
        
        return true;
    }
    
    /**
     * Add a recovery button to the UI for manual reconnection
     */
    function addRecoveryButton() {
        // Check if button already exists
        if (document.getElementById('recovery-button')) {
            return;
        }
        
        const controlsContainer = document.querySelector('.controls');
        if (!controlsContainer) return;
        
        const recoveryButton = document.createElement('button');
        recoveryButton.id = 'recovery-button';
        recoveryButton.className = 'secondary-button';
        recoveryButton.textContent = 'Reconnect Audio';
        recoveryButton.addEventListener('click', function() {
            // Try to reconnect the audio pipeline
            logStatus('Manual audio reconnection requested');
            
            if (isRunning) {
                // Try to request server reconnection
                if (requestReconnection()) {
                    logStatus('Reconnection request sent');
                } else {
                    // If server connection is down, try to restart the audio context
                    if (audioContext) {
                        audioContext.close().then(() => {
                            audioContext = new AudioContext({ sampleRate: sampleRate });
                            addAudioContextStateListener();
                            audioContext.resume().then(() => {
                                logStatus('Audio context restarted');
                            });
                        }).catch(err => {
                            logStatus('Failed to restart audio: ' + err.message);
                        });
                    }
                }
            } else {
                logStatus('Cannot reconnect when not running');
            }
        });
        
        // Insert before the stop button
        controlsContainer.insertBefore(recoveryButton, stopButton);
    }
    
    /**
     * Add audio context state listener for debugging
     */
    function addAudioContextStateListener() {
        if (audioContext) {
            audioContext.onstatechange = function() {
                console.log('Audio context state changed to:', audioContext.state);
                logStatus(`Audio state: ${audioContext.state}`);
                
                // If it becomes suspended, try to resume it automatically
                if (audioContext.state === 'suspended' && isRunning) {
                    audioContext.resume().then(() => {
                        logStatus('Audio context resumed automatically');
                    }).catch(err => {
                        logStatus('Failed to auto-resume: ' + err.message);
                    });
                }
            };
        }
    }

            if (audioVisualizerInstance) {
                const visualData = new Float32Array(chunk.frameCount);
                for (let i = 0; i < chunk.frameCount; i++) {
                    visualData[i] = chunk.data[i] / 32768.0;
                }
                audioVisualizerInstance.updateOutputData(visualData);
            }

        } catch (error) {
            console.error('Error playing audio chunk:', error);
            // Continue with queue even if one chunk fails
            processAudioQueue();
        }
    }

    /**
     * Set up microphone access
     */
    async function setupMicrophone() {
        try {
            // Get selected input device
            const deviceId = inputDeviceSelect.value;

            // Set up constraints with improved audio quality settings
            const constraints = {
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    sampleRate: { ideal: 44100 }, // Higher sample rate for better quality
                    channelCount: { ideal: 1 },
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            };

            // Get media stream with timeout
            const streamPromise = navigator.mediaDevices.getUserMedia(constraints);
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Timeout getting microphone stream')), 10000);
            });

            mediaStream = await Promise.race([streamPromise, timeoutPromise]);

            // Create audio source
            audioInput = audioContext.createMediaStreamSource(mediaStream);

            // Create analyser for visualization
            audioAnalyser = audioContext.createAnalyser();
            audioAnalyser.fftSize = 2048;
            audioInput.connect(audioAnalyser);

            // Create script processor for audio processing with smaller buffer size
            audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            audioInput.connect(audioProcessor);
            audioProcessor.connect(audioContext.destination);

            // Set up audio processing
            audioProcessor.onaudioprocess = processAudio;
            
            // Add audio context state listener
            addAudioContextStateListener();

            logStatus('Microphone connected with enhanced quality settings');

        } catch (error) {
            console.error('Error setting up microphone:', error);
            throw new Error('Could not access microphone: ' + error.message);
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

/**
 * Request server to reconnect the AI WebSocket
 */
function requestReconnection() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        logStatus('Cannot reconnect: WebSocket not connected');
        return false;
    }

    logStatus('Requesting reconnection to the AI...');
    socket.send(JSON.stringify({
        type: 'command',
        command: 'reconnect'
    }));
    
    return true;
}

/**
 * Handle socket close event with reconnection logic
 */
function handleSocketClose(event) {
    console.log('WebSocket closed:', event);
    isConnected = false;
    logStatus(`WebSocket closed: ${event.reason || 'Connection closed'}`);
    
    updateConnectionStatus('Disconnected');
    
    // If it's an abnormal closure and we're still running, try to reconnect the browser WebSocket
    if (event.code !== 1000 && isRunning) {
        logStatus('Attempting to reconnect browser WebSocket...');
        setTimeout(function() {
            if (isRunning && sessionId) {
                connectWebSocket();
            }
        }, 2000); // Wait 2 seconds before reconnecting
    } else if (!isRunning) {
        logStatus('Session stopped');
    }
}

// Make sure to update your socket event handler to use the new close handler
// Add this to your connectWebSocket function:
// socket.onclose = handleSocketClose;
