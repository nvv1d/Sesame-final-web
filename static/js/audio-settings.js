
/**
 * Audio Settings Configuration
 * This file contains all settings related to audio processing and voice chat
 */

// Audio context settings
const AUDIO_SETTINGS = {
    // Sample rates
    sampleRate: 16000,              // Audio context sample rate
    clientSampleRate: 16000,        // Client-side sample rate
    serverSampleRate: 24000,        // Expected server sample rate
    
    // Buffer settings
    bufferSize: 512,                // Reduced from 1024 for lower latency
    
    // Voice activity detection
    amplitudeThreshold: 0.008,      // Slightly reduced threshold for better sensitivity
    silenceLimit: 40,               // Reduced frames of silence before stopping transmission
    
    // Audio queue settings
    minGapBetweenChunks: 20,        // Reduced from 50ms to decrease gaps between chunks
    maxQueueSize: 10,               // Maximum queue size to prevent memory buildup
    
    // Audio processing quality settings
    audioEnhancements: {
        enableHighPassFilter: true,
        highPassFrequency: 70,      // Reduced from 80Hz for more natural voice
        
        enableLowPassFilter: true,
        lowPassFrequency: 14000,    // Increased from 12kHz for more detail
        
        enableCompressor: true,     // Speech optimized compressor
        compressorSettings: {
            threshold: -20,         // More aggressive to ensure consistent volume
            knee: 6,                // Gentler knee for more natural sound
            ratio: 4,               // Increased ratio for more consistent levels
            attack: 0.002,          // Faster attack to reduce pops
            release: 0.1            // Quicker release to reduce artifacts
        },
        
        enableClarityEQ: true,      // Mid-range boost for voice clarity
        clarityEQSettings: {
            frequency: 2500,        // Adjusted for better speech intelligibility
            Q: 0.8,                 // Wider width for more natural sound
            gain: 3                 // Reduced from 4dB to sound more natural
        },
        
        enablePresenceEQ: true,     // Presence boost
        presenceEQSettings: {
            frequency: 5500,        // Slight adjustment for better presence
            Q: 1.2,
            gain: 2                 // Maintained at 2dB
        },
        
        // New settings to reduce glitches
        enableAntiGlitchFilter: true,
        antiGlitchSettings: {
            predelay: 0.01,         // Small pre-delay to allow buffer to fill
            fadeIn: 0.01,           // Quick fade-in to reduce clicks
            fadeOut: 0.01,          // Quick fade-out to reduce artifacts
        },
        
        // Buffer management for smoother playback
        bufferManagement: {
            initialBufferSize: 2,   // Initial buffer size (audio chunks)
            dynamicBuffering: true, // Enable dynamic buffer adjustment
            maxBufferSize: 4,       // Maximum buffer size during poor network
        },
        
        masterGain: 1.05            // Slight boost (5%) for better audibility
    },
    
    // Network and performance optimizations
    networkOptimizations: {
        reconnectInterval: 1500,    // Quicker reconnection after drop (milliseconds)
        maxReconnectAttempts: 5,    // Maximum reconnection attempts
        pingInterval: 15000,        // Reduced ping interval for better connection monitoring (milliseconds)
        processingPriority: true,   // Prioritize audio processing thread
    }
};

// Function to dynamically adjust settings based on performance
AUDIO_SETTINGS.adjustForPerformance = function(performance) {
    // performance should be 'high', 'medium', or 'low'
    switch(performance) {
        case 'high':
            this.bufferSize = 256;  // Smallest buffer for lowest latency
            this.minGapBetweenChunks = 10;
            this.audioEnhancements.bufferManagement.initialBufferSize = 1;
            this.audioEnhancements.bufferManagement.maxBufferSize = 2;
            break;
        case 'medium':
            // Default settings
            break;
        case 'low':
            this.bufferSize = 1024;  // Larger buffer for stability
            this.minGapBetweenChunks = 40;
            this.audioEnhancements.bufferManagement.initialBufferSize = 3;
            this.audioEnhancements.bufferManagement.maxBufferSize = 6;
            break;
    }
    return this;
};

// Export settings - ensure it's available globally
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AUDIO_SETTINGS;
} else {
    // Make sure it's added to the window object for browser context
    window.AUDIO_SETTINGS = AUDIO_SETTINGS;
}

// Add initialization safety check
(function() {
    // Check if AUDIO_SETTINGS is accessible
    if (typeof AUDIO_SETTINGS === 'undefined') {
        console.error('AUDIO_SETTINGS failed to initialize properly');
        // Create a fallback
        window.AUDIO_SETTINGS = {
            // Basic defaults
            sampleRate: 16000,
            bufferSize: 512,
            minGapBetweenChunks: 20,
            maxQueueSize: 10,
            audioEnhancements: {
                enableHighPassFilter: true,
                highPassFrequency: 70,
                enableLowPassFilter: true,
                lowPassFrequency: 14000,
                enableCompressor: true,
                masterGain: 1.0
            }
        };
        console.log('Created fallback AUDIO_SETTINGS');
    } else {
        console.log('AUDIO_SETTINGS initialized successfully');
    }
})();
