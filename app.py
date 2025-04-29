import os
import json
import base64
import logging
import threading
import queue
import time
import uuid
import numpy as np
from flask import Flask, render_template, request, jsonify
from flask_sock import Sock  # For WebSocket support

# Import the wrapper module with all necessary classes
from wrapper import SesameAI, SesameWebSocket, TokenManager, InvalidTokenError, NetworkError, APIError

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger('sesame.webapp')

# Initialize Flask app
app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET", "sesame-ai-voice-chat-dev-key")
sock = Sock(app)  # Initialize Flask-Sock

# Session management
active_sessions = {}  # Map session IDs to voice chat proxies
session_lock = threading.Lock()  # Lock for thread-safe session management

class VoiceChatProxy:
    """Proxy between browser WebSocket and Sesame AI WebSocket"""

    # Available characters
    AVAILABLE_CHARACTERS = ["Miles", "Maya"]

    def __init__(self, session_id, character="Miles", token_file=None):
        """
        Initialize the voice chat proxy

        Args:
            session_id (str): Unique session identifier
            character (str): Character to chat with ("Miles" or "Maya")
            token_file (str, optional): Path to token storage file
        """
        self.session_id = session_id
        self.character = character
        self.token_file = token_file

        # Audio settings
        self.client_sample_rate = 16000  # Expected from browser
        self.server_sample_rate = 24000  # Will be updated from Sesame AI server
        self.audio_segment_duration = 0.03  # 30ms segments for better responsiveness

        # SesameAI client
        self.api_client = SesameAI()
        self.token_manager = TokenManager(self.api_client, token_file=self.token_file)
        self.id_token = None
        self.ws = None

        # Queues for audio data
        self.output_queue = queue.Queue(maxsize=100)  # Audio from AI to browser

        # State management
        self.running = False
        self.browser_ws = None  # Reference to the browser WebSocket
        self.client_connected = False

        # Status
        self.status = "Initialized"
        self.connection_status = "Disconnected"

        logger.debug(f"VoiceChatProxy initialized with session ID: {session_id}, character: {character}")

    def authenticate(self):
        """Authenticate with SesameAI and get a token"""
        self.status = "Authenticating..."
        logger.info("Authenticating with SesameAI...")
        try:
            # If no token file is specified, force a new token
            force_new = self.token_file is None

            # Get a valid token using the token manager
            self.id_token = self.token_manager.get_valid_token(force_new=force_new)
            logger.info("Authentication successful!")
            self.status = "Authentication successful"
            return True
        except InvalidTokenError:
            logger.error("Authentication failed: Token expired and couldn't be refreshed")
            self.status = "Authentication failed: Token expired"
            return False
        except (NetworkError, APIError) as e:
            logger.error(f"Authentication failed: {e}")
            self.status = f"Authentication failed: {str(e)}"
            return False

    def on_ai_connect(self):
        """Callback when WebSocket connection to Sesame AI is established"""
        logger.info(f"Connected to {self.character}!")
        self.connection_status = "Connected"
        self.status = f"Connected to {self.character}"

        # Update sample rate from server
        self.server_sample_rate = self.ws.server_sample_rate
        logger.debug(f"Server sample rate: {self.server_sample_rate}")

        # Send status update to browser
        self.send_status_to_browser()

    def on_ai_disconnect(self):
        """Callback when WebSocket connection to Sesame AI is disconnected"""
        logger.info(f"Disconnected from {self.character}")
        self.connection_status = "Disconnected"
        self.status = f"Disconnected from {self.character}"

        # Send status update to browser
        self.send_status_to_browser()

        # Stop the session if it's still running
        if self.running:
            self.stop()

    def connect_to_ai(self):
        """Connect to Sesame AI WebSocket"""
        self.status = f"Connecting to {self.character}..."
        self.connection_status = "Connecting"
        logger.info(f"Connecting to SesameAI as character '{self.character}'...")

        # Create WebSocket client
        self.ws = SesameWebSocket(
            id_token=self.id_token,
            character=self.character
        )

        # Set up callbacks
        self.ws.set_connect_callback(self.on_ai_connect)
        self.ws.set_disconnect_callback(self.on_ai_disconnect)

        # Connect to server
        if self.ws.connect():
            logger.debug("WebSocket connection to Sesame AI established")
            # Start audio processing thread
            self.start_audio_thread()
            return True
        else:
            logger.error("Failed to connect to SesameAI")
            self.status = "Failed to connect to SesameAI"
            self.connection_status = "Disconnected"
            self.send_status_to_browser()
            return False

    def start_audio_thread(self):
        """Start thread to process audio from Sesame AI"""
        audio_thread = threading.Thread(target=self.process_ai_audio)
        audio_thread.daemon = True
        audio_thread.start()
        logger.debug("Audio processing thread started")

    def process_ai_audio(self):
        """Process audio received from Sesame AI with buffering and quality enhancement"""
        logger.debug("Enhanced audio processing started")

        # Audio buffer for smoother playback
        audio_buffer = []
        buffer_size_ms = 120  # Buffer size in milliseconds
        last_send_time = 0

        # Stats for adaptive buffering
        network_jitter = []
        last_chunk_time = 0

        while self.running:
            try:
                # Get audio chunk from WebSocket buffer with a short timeout
                if self.ws:
                    audio_chunk = self.ws.get_next_audio_chunk(timeout=0.05)

                    if audio_chunk:
                        # Track network stats
                        now = time.time()
                        if last_chunk_time > 0:
                            gap = now - last_chunk_time
                            network_jitter.append(gap)
                            # Keep only last 20 measurements
                            if len(network_jitter) > 20:
                                network_jitter.pop(0)
                        last_chunk_time = now

                        # Add to buffer
                        audio_buffer.append(audio_chunk)

                        # Calculate buffer duration
                        total_bytes = sum(len(chunk) for chunk in audio_buffer)
                        # Each sample is 2 bytes (16-bit)
                        total_samples = total_bytes // 2
                        buffer_duration_ms = (total_samples / self.server_sample_rate) * 1000

                        # Adaptive buffer sizing based on network conditions
                        if len(network_jitter) >= 5:
                            avg_jitter = sum(network_jitter) / len(network_jitter)
                            jitter_ms = avg_jitter * 1000

                            # Adjust buffer size based on network jitter
                            if jitter_ms > 50:  # High jitter
                                buffer_size_ms = min(300, buffer_size_ms + 20)
                            elif jitter_ms < 20 and buffer_size_ms > 100:  # Low jitter
                                buffer_size_ms = max(80, buffer_size_ms - 10)

                        # Send buffered audio if buffer is full or enough time has passed
                        if (buffer_duration_ms >= buffer_size_ms or 
                            (now - last_send_time > 0.2 and len(audio_buffer) > 0)):

                            # Combine all chunks
                            combined_audio = b''.join(audio_buffer)

                            # Enhance audio quality
                            enhanced_audio = self.enhance_audio_quality(combined_audio)

                            # Send to browser
                            if self.browser_ws and self.client_connected:
                                self.send_audio_to_browser(enhanced_audio)

                            # Reset buffer
                            audio_buffer = []
                            last_send_time = now
                else:
                    time.sleep(0.1)
            except Exception as e:
                if self.running:
                    logger.error(f"Error processing audio: {e}", exc_info=True)
                    time.sleep(0.1)

    def enhance_audio_quality(self, audio_chunk):
        """Enhance audio quality for better intelligibility"""
        try:
            # If audio enhancement libraries not available, just return the original
            try:
                import numpy as np
            except ImportError:
                return audio_chunk

            # Convert bytes to numpy array (16-bit PCM)
            audio_array = np.frombuffer(audio_chunk, dtype=np.int16)

            if len(audio_array) > 0:
                # Normalize audio (increase volume without clipping)
                max_val = np.max(np.abs(audio_array))
                if max_val > 0:
                    scale = min(32767 / max_val * 0.9, 2.0)  # Scale up to 90% of max
                    audio_array = np.clip(audio_array * scale, -32768, 32767).astype(np.int16)

                # Simple, fast DC offset removal
                audio_array = audio_array - np.mean(audio_array)

                # Optional: Apply simple filtering to enhance voice frequencies
                # This is a simple approach that doesn't require scipy
                if len(audio_array) > 64:
                    # Simple high-pass filter (average subtraction)
                    window_size = 16
                    avg = np.convolve(audio_array, np.ones(window_size)/window_size, mode='same')
                    audio_array = audio_array - avg.astype(np.int16)

            # Convert back to bytes
            return audio_array.tobytes()
        except Exception as e:
            logger.warning(f"Audio enhancement failed, using original: {e}")
            return audio_chunk

    def send_audio_to_browser(self, audio_chunk):
        """Send audio chunk to browser with metadata"""
        if not self.browser_ws or not self.client_connected:
            return

        try:
            # Convert to base64 for sending to browser
            audio_base64 = base64.b64encode(audio_chunk).decode('utf-8')

            # Create message with audio data and metadata
            message = {
                'type': 'audio',
                'data': audio_base64,
                'sampleRate': self.server_sample_rate,
                'timestamp': time.time(),
                'preserveQuality': True,
                'format': 'int16',
                'channels': 1,
                'bitDepth': 16
            }

            # Send to browser
            self.browser_ws.send(json.dumps(message))
        except Exception as e:
            logger.error(f"Error sending audio to browser: {e}")

    def send_audio_to_ai(self, audio_data_base64):
        """Send audio data from browser to Sesame AI"""
        if not self.ws or not self.ws.is_connected():
            return False

        try:
            # Decode base64 audio data
            audio_data = base64.b64decode(audio_data_base64)

            # Ensure the audio data is in the correct format (16-bit PCM)
            # Check and fix the data if needed
            try:
                import numpy as np
                # Convert to numpy array to process
                audio_array = np.frombuffer(audio_data, dtype=np.int16)

                # Check for extreme values that might cause static
                threshold = 32000  # Near max for 16-bit audio
                if np.max(np.abs(audio_array)) > threshold:
                    # Normalize the audio to prevent screeching
                    scale_factor = threshold / np.max(np.abs(audio_array))
                    audio_array = (audio_array * scale_factor).astype(np.int16)
                    # Convert back to bytes
                    audio_data = audio_array.tobytes()
            except ImportError:
                # If numpy isn't available, continue with original data
                pass

            # Send to Sesame AI
            self.ws.send_audio_data(audio_data)
            return True
        except Exception as e:
            logger.error(f"Error sending audio to AI: {e}")
            return False

    def set_browser_ws(self, ws):
        """Set the browser WebSocket connection"""
        self.browser_ws = ws
        self.client_connected = True
        self.send_status_to_browser()

    def send_status_to_browser(self):
        """Send current status to browser"""
        if not self.browser_ws or not self.client_connected:
            return

        try:
            status_msg = {
                'type': 'status',
                'status': self.status,
                'connectionStatus': self.connection_status
            }
            self.browser_ws.send(json.dumps(status_msg))
        except Exception as e:
            logger.error(f"Error sending status to browser: {e}")

    def start(self):
        """Start the voice chat proxy"""
        # Authenticate
        if not self.authenticate():
            return False

        # Set running flag
        self.running = True

        # Connect to AI (will trigger on_connect callback)
        if not self.connect_to_ai():
            self.running = False
            return False

        logger.info(f"Voice chat proxy with {self.character} started!")
        return True

    def stop(self):
        """Stop the voice chat proxy"""
        if not self.running:
            return

        logger.info("Stopping voice chat proxy...")
        self.running = False

        # Disconnect from WebSocket
        if self.ws and self.ws.is_connected():
            self.ws.disconnect()

        self.client_connected = False
        logger.info("Voice chat proxy stopped")
        self.status = "Voice chat stopped"
        self.connection_status = "Disconnected"

def create_session(character):
    """Create a new voice chat session"""
    with session_lock:
        session_id = str(uuid.uuid4())
        proxy = VoiceChatProxy(session_id, character)
        active_sessions[session_id] = proxy

        # Start the proxy
        if not proxy.start():
            del active_sessions[session_id]
            return None

        return session_id

def get_session(session_id):
    """Get a voice chat session by ID"""
    with session_lock:
        return active_sessions.get(session_id)

def end_session(session_id):
    """End a voice chat session"""
    with session_lock:
        proxy = active_sessions.pop(session_id, None)
        if proxy:
            proxy.stop()
            return True
        return False

@app.route('/')
def index():
    """Render the main page"""
    return render_template('index.html')

@app.route('/api/characters')
def get_characters():
    """Get available characters"""
    return jsonify({
        "characters": VoiceChatProxy.AVAILABLE_CHARACTERS
    })

@app.route('/api/sessions', methods=['POST'])
def create_chat_session():
    """Create a new chat session"""
    try:
        data = request.json
        character = data.get('character', 'Miles')

        session_id = create_session(character)
        if not session_id:
            return jsonify({"error": "Failed to create session"}), 500

        return jsonify({
            "session_id": session_id,
            "character": character
        })
    except Exception as e:
        logger.error(f"Error creating session: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/api/sessions/<session_id>', methods=['DELETE'])
def delete_chat_session(session_id):
    """Delete a chat session"""
    try:
        success = end_session(session_id)
        return jsonify({"success": success})
    except Exception as e:
        logger.error(f"Error deleting session: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@sock.route('/ws/<session_id>')
def ws_chat(ws, session_id):
    """WebSocket endpoint for chat session"""
    logger.info(f"Browser connected to session: {session_id}")

    # Get the session proxy
    proxy = get_session(session_id)
    if not proxy:
        ws.send(json.dumps({
            'type': 'error',
            'message': 'Invalid session'
        }))
        return

    # Set browser WebSocket connection
    proxy.set_browser_ws(ws)

    # Send initial status
    proxy.send_status_to_browser()

    # Process messages from browser
    try:
        while True:
            message = ws.receive()

            # Parse message
            try:
                data = json.loads(message)
                msg_type = data.get('type')

                if msg_type == 'audio':
                    # Process audio data
                    audio_data = data.get('data')
                    proxy.send_audio_to_ai(audio_data)
                elif msg_type == 'ping':
                    # Respond to ping
                    ws.send(json.dumps({'type': 'pong'}))
                elif msg_type == 'command':
                    # Handle command
                    command = data.get('command')
                    if command == 'status':
                        proxy.send_status_to_browser()
            except json.JSONDecodeError:
                logger.warning(f"Received invalid JSON: {message}")
            except Exception as e:
                logger.error(f"Error processing message: {e}", exc_info=True)

    except Exception as e:
        logger.info(f"WebSocket connection closed: {e}")
    finally:
        # Mark client as disconnected
        proxy.client_connected = False
