/**
 * Audio visualizer for Sesame AI Voice Chat
 * Creates a circular visualization that pulses with audio input
 */
class AudioVisualizer {
    /**
     * Initialize the audio visualizer
     * @param {HTMLCanvasElement} canvas - Canvas element for visualization
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        
        // Audio levels
        this.inputLevel = 0;
        this.outputLevel = 0;
        this.smoothedInputLevel = 0;
        this.smoothedOutputLevel = 0;
        
        // Frequency visualization
        this.frequencyBars = [];
        this.barCount = 32;
        
        // Animation
        this.animationFrame = null;
        this.isRunning = false;
        
        // Initialize frequency bars with random heights
        for (let i = 0; i < this.barCount; i++) {
            this.frequencyBars.push(Math.random() * 0.3);
        }
        
        // Set canvas dimensions
        this.resizeCanvas();
        
        // Handle window resize
        window.addEventListener('resize', this.resizeCanvas.bind(this));
    }
    
    /**
     * Resize canvas to match container size
     */
    resizeCanvas() {
        // Get container dimensions
        const container = this.canvas.parentElement;
        this.canvas.width = container.clientWidth;
        this.canvas.height = container.clientHeight;
        
        // Redraw if running
        if (this.isRunning) {
            this.draw();
        } else {
            // Draw empty state
            this.clear();
        }
    }
    
    /**
     * Clear the canvas
     */
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    
    /**
     * Start the visualization
     */
    start() {
        this.isRunning = true;
        this.animate();
    }
    
    /**
     * Stop the visualization
     */
    stop() {
        this.isRunning = false;
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        this.clear();
    }
    
    /**
     * Animate the visualization
     */
    animate() {
        if (!this.isRunning) return;
        
        this.draw();
        this.animationFrame = requestAnimationFrame(() => this.animate());
    }
    
    /**
     * Draw the visualization
     */
    draw() {
        // Get current accent color
        const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
        
        // Clear the canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Smooth the levels for animation
        this.smoothedInputLevel = this.smoothedInputLevel * 0.8 + this.inputLevel * 0.2;
        this.smoothedOutputLevel = this.smoothedOutputLevel * 0.8 + this.outputLevel * 0.2;
        
        // Combined level for overall activity
        const combinedLevel = Math.max(this.smoothedInputLevel, this.smoothedOutputLevel);
        
        // Parameters for visualization
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;
        const maxRadius = Math.min(centerX, centerY) * 0.8;
        const activeRadius = maxRadius * (0.3 + combinedLevel * 0.7);
        
        // Draw circular background
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, maxRadius, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(${this.hexToRgb(accentColor)}, 0.05)`;
        this.ctx.fill();
        
        // Draw active circle
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, activeRadius, 0, Math.PI * 2);
        this.ctx.strokeStyle = `rgba(${this.hexToRgb(accentColor)}, 0.5)`;
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
        
        // Update frequency bars
        for (let i = 0; i < this.barCount; i++) {
            // Make bars move based on level and some randomness
            if (Math.random() < 0.1) {
                this.frequencyBars[i] = Math.random() * combinedLevel;
            } else {
                this.frequencyBars[i] = this.frequencyBars[i] * 0.95 + 
                                       (Math.random() * combinedLevel) * 0.05;
            }
        }
        
        // Draw frequency bars around circle
        const barWidth = 4;
        
        for (let i = 0; i < this.barCount; i++) {
            const angle = (i / this.barCount) * Math.PI * 2;
            const height = maxRadius * 0.5 * this.frequencyBars[i];
            
            const x1 = centerX + Math.cos(angle) * activeRadius;
            const y1 = centerY + Math.sin(angle) * activeRadius;
            const x2 = centerX + Math.cos(angle) * (activeRadius + height);
            const y2 = centerY + Math.sin(angle) * (activeRadius + height);
            
            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.strokeStyle = `rgba(${this.hexToRgb(accentColor)}, ${0.3 + this.frequencyBars[i] * 0.7})`;
            this.ctx.lineWidth = barWidth;
            this.ctx.lineCap = 'round';
            this.ctx.stroke();
        }
        
        // Draw pulsing glow
        const glowSize = 20 + Math.sin(Date.now() * 0.002) * 10;
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, activeRadius, 0, Math.PI * 2);
        this.ctx.shadowColor = `rgba(${this.hexToRgb(accentColor)}, 0.5)`;
        this.ctx.shadowBlur = glowSize * combinedLevel;
        this.ctx.strokeStyle = `rgba(${this.hexToRgb(accentColor)}, 0.2)`;
        this.ctx.lineWidth = 4;
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
    }
    
    /**
     * Convert hex color to RGB components
     * @param {string} hex - Hex color code (e.g., "#ff0000")
     * @returns {string} RGB components as "r, g, b"
     */
    hexToRgb(hex) {
        // Remove # if present
        hex = hex.replace(/^#/, '');
        
        // Parse hex values
        const bigint = parseInt(hex, 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        
        return `${r}, ${g}, ${b}`;
    }
    
    /**
     * Update input audio data for visualization
     * @param {Float32Array} data - Audio data from microphone
     * @param {number} level - Audio level (RMS)
     */
    updateInputData(data, level) {
        // Update level (0-1 range)
        this.inputLevel = Math.min(1, Math.max(0, level * 10));
    }
    
    /**
     * Update output audio data for visualization
     * @param {Float32Array} data - Audio data from AI
     */
    updateOutputData(data) {
        // Calculate level (RMS)
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i] * data[i];
        }
        const rms = Math.sqrt(sum / data.length);
        
        // Update level (0-1 range)
        this.outputLevel = Math.min(1, Math.max(0, rms * 10));
    }
}