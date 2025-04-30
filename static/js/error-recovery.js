
/**
 * Error Recovery Module for Sesame AI Voice Chat
 * Handles automatic recovery from common failure scenarios
 * Manual recovery button removed as requested
 */

class ErrorRecovery {
    constructor(config = {}) {
        // Configuration with defaults
        this.config = {
            maxReconnectAttempts: config.maxReconnectAttempts || 5,
            reconnectInterval: config.reconnectInterval || 2000,
            exponentialBackoff: config.exponentialBackoff || true,
            audioContextRecoveryEnabled: config.audioContextRecoveryEnabled || true,
            networkRecoveryEnabled: config.networkRecoveryEnabled || true,
            ...config
        };
        
        // State tracking
        this.reconnectAttempts = 0;
        this.lastErrorTime = 0;
        this.errorHistory = [];
        this.recoveryInProgress = false;
        
        // Callbacks
        this.onRecoveryStarted = null;
        this.onRecoveryProgress = null;
        this.onRecoveryComplete = null;
        this.onRecoveryFailed = null;
        
        // Bind methods
        this.recoverAudioContext = this.recoverAudioContext.bind(this);
        this.recoverWebSocket = this.recoverWebSocket.bind(this);
    }
    
    /**
     * Reset error recovery state
     */
    reset() {
        this.reconnectAttempts = 0;
        this.lastErrorTime = 0;
        this.errorHistory = [];
        this.recoveryInProgress = false;
    }
    
    /**
     * Track error for pattern detection
     * @param {string} type - Error type
     * @param {string} message - Error message
     */
    trackError(type, message) {
        const now = Date.now();
        
        this.errorHistory.push({
            type,
            message,
            timestamp: now
        });
        
        // Keep last 10 errors only
        if (this.errorHistory.length > 10) {
            this.errorHistory.shift();
        }
        
        this.lastErrorTime = now;
        
        // Analyze patterns
        this.analyzeErrorPatterns();
    }
    
    /**
     * Analyze error patterns for potential automatic recovery
     */
    analyzeErrorPatterns() {
        // If recovery is already in progress, don't start another
        if (this.recoveryInProgress) return;
        
        const lastMinuteErrors = this.errorHistory.filter(
            err => Date.now() - err.timestamp < 60000
        );
        
        // Check for audio context errors
        const audioContextErrors = lastMinuteErrors.filter(
            err => err.type === 'audioContext'
        );
        
        // Check for network errors
        const networkErrors = lastMinuteErrors.filter(
            err => err.type === 'network' || err.type === 'websocket'
        );
        
        // If we have multiple audio context errors, try to recover
        if (audioContextErrors.length >= 2 && this.config.audioContextRecoveryEnabled) {
            console.log('Multiple audio context errors detected, attempting recovery');
            this.recoverAudioContext();
        }
        
        // If we have multiple network errors, try to recover
        if (networkErrors.length >= 3 && this.config.networkRecoveryEnabled) {
            console.log('Multiple network errors detected, attempting recovery');
            this.recoverWebSocket();
        }
    }
    
    /**
     * Recover audio context
     * @param {AudioContext} audioContext - The audio context to recover
     * @returns {Promise<boolean>} - Success or failure
     */
    async recoverAudioContext(audioContext) {
        if (!audioContext) {
            console.error('Cannot recover null audio context');
            return false;
        }
        
        this.recoveryInProgress = true;
        if (this.onRecoveryStarted) this.onRecoveryStarted('audioContext');
        
        try {
            // Perform a safe state check
            const currentState = audioContext.state || 'unknown';
            console.log(`Attempting to recover audio context from state: ${currentState}`);
            
            // First try resuming
            if (currentState === 'suspended' || currentState === 'unknown') {
                if (this.onRecoveryProgress) this.onRecoveryProgress('Resuming suspended audio context');
                try {
                    await audioContext.resume();
                    
                    // Check if successful
                    if (audioContext.state === 'running') {
                        this.recoveryInProgress = false;
                        if (this.onRecoveryComplete) this.onRecoveryComplete('audioContext');
                        return true;
                    }
                } catch (resumeErr) {
                    console.warn('Resume attempt failed:', resumeErr);
                    // Continue to context recreation
                }
            }
            
            // If that didn't work or state wasn't suspended, close and create new
            if (this.onRecoveryProgress) this.onRecoveryProgress('Creating new audio context');
            
            // Close old context
            await audioContext.close();
            
            // Create new context with same sample rate
            const sampleRate = audioContext.sampleRate;
            const newContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: sampleRate
            });
            
            // Ensure it's running
            await newContext.resume();
            
            this.recoveryInProgress = false;
            if (this.onRecoveryComplete) this.onRecoveryComplete('audioContext', newContext);
            return true;
            
        } catch (err) {
            console.error('Audio context recovery failed:', err);
            this.recoveryInProgress = false;
            if (this.onRecoveryFailed) this.onRecoveryFailed('audioContext', err);
            return false;
        }
    }
    
    /**
     * Recover WebSocket connection
     * @param {function} reconnectCallback - Callback to reconnect the WebSocket
     * @returns {Promise<boolean>} - Success or failure
     */
    async recoverWebSocket(reconnectCallback) {
        if (!reconnectCallback || typeof reconnectCallback !== 'function') {
            console.error('WebSocket recovery requires a reconnect callback function');
            return false;
        }
        
        this.recoveryInProgress = true;
        if (this.onRecoveryStarted) this.onRecoveryStarted('network');
        
        try {
            // Implement exponential backoff
            const delay = this.config.exponentialBackoff 
                ? this.config.reconnectInterval * Math.pow(1.5, this.reconnectAttempts)
                : this.config.reconnectInterval;
                
            if (this.onRecoveryProgress) 
                this.onRecoveryProgress(`Reconnecting in ${Math.round(delay/1000)} seconds`);
                
            // Wait before attempting reconnection
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Attempt reconnection
            const success = await reconnectCallback();
            
            if (success) {
                this.reconnectAttempts = 0;
                this.recoveryInProgress = false;
                if (this.onRecoveryComplete) this.onRecoveryComplete('network');
                return true;
            } else {
                this.reconnectAttempts++;
                
                // If we've reached max attempts, give up
                if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
                    console.error('WebSocket recovery failed after max attempts');
                    this.recoveryInProgress = false;
                    if (this.onRecoveryFailed) 
                        this.onRecoveryFailed('network', new Error('Max reconnect attempts reached'));
                    return false;
                }
                
                // Try again
                return this.recoverWebSocket(reconnectCallback);
            }
            
        } catch (err) {
            console.error('WebSocket recovery failed:', err);
            this.reconnectAttempts++;
            this.recoveryInProgress = false;
            if (this.onRecoveryFailed) this.onRecoveryFailed('network', err);
            return false;
        }
    }
}

// Make available globally
window.ErrorRecovery = ErrorRecovery;
