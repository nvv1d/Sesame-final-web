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

        # Improved audio settings
        self.client_sample_rate = 16000
        self.server_sample_rate = 24000
        self.audio_segment_duration = 0.04  # Increased from 0.02 to 0.04 for better intelligibility

        # Enhanced buffer for smoother audio
        self.audio_buffer = []
        self.max_buffer_length = 8  # Increased from 5 to 8 for smoother playback

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

        # Reset audio buffer to prevent playback of stale audio on reconnection
        self.audio_buffer = []

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
        """Process audio received from Sesame AI and forward to browser with enhanced quality"""
        logger.debug("High-quality audio processing started")

        while self.running:
            try:
                # Get audio chunk from WebSocket buffer with a longer timeout
                if self.ws:
                    audio_chunk = self.ws.get_next_audio_chunk(timeout=0.1)  # Increased from 0.05 to 0.1
                    if audio_chunk and self.browser_ws and self.client_connected:
                        # Add to buffer for smoother playback
                        self.audio_buffer.append(audio_chunk)

                        # Process the buffer when it reaches a certain size
                        if len(self.audio_buffer) >= 4:  # Increased from 2 to 4 chunks
                            # Combine audio chunks for smoother playback
                            combined_chunk = b''.join(self.audio_buffer)
                            self.audio_buffer = []  # Clear buffer

                            # Convert to base64 for sending to browser
                            audio_base64 = base64.b64encode(combined_chunk).decode('utf-8')

                            # Create message with enhanced audio metadata
                            message = {
                                'type': 'audio',
                                'data': audio_base64,
                                'sampleRate': self.server_sample_rate,
                                'preserveQuality': True,
                                'format': 'int16',
                                'channels': 1,
                                'bitDepth': 16,
                                'priority': 'high'  # Add priority hint for browser
                            }

                            # Send to browser with try-except for better error handling
                            try:
                                self.browser_ws.send(json.dumps(message))
                            except Exception as e:
                                logger.error(f"Error sending audio to browser: {e}")
                                # Reset buffer on error
                                self.audio_buffer = []
                    else:
                        # Periodically process any buffered audio to prevent delay buildup
                        if self.audio_buffer and len(self.audio_buffer) > 0 and self.browser_ws and self.client_connected:
                            combined_chunk = b''.join(self.audio_buffer)
                            self.audio_buffer = []

                            audio_base64 = base64.b64encode(combined_chunk).decode('utf-8')
                            message = {

    def reconnect_to_ai(self):
        """Attempt to reconnect to Sesame AI WebSocket"""
        if not self.running:
            logger.info("Cannot reconnect: session not running")
            return False
            
        logger.info(f"Attempting to reconnect to {self.character}...")
        self.status = f"Reconnecting to {self.character}..."
        self.connection_status = "Reconnecting"
        self.send_status_to_browser()
        
        # Close previous connection if exists
        if self.ws and self.ws.is_connected():
            try:
                self.ws.disconnect()
            except Exception as e:
                logger.error(f"Error closing previous connection: {e}")
        
        # Clear audio buffer
        self.audio_buffer = []
        
        # Reconnect with fresh authentication
        try:
            # Re-authenticate to get a fresh token
            if not self.authenticate():
                logger.error("Reconnection failed: Authentication error")
                self.status = "Reconnection failed: Authentication error"
                self.connection_status = "Disconnected"
                self.send_status_to_browser()
                return False
                
            # Connect to AI
            return self.connect_to_ai()
        except Exception as e:
            logger.error(f"Reconnection failed: {e}", exc_info=True)
            self.status = f"Reconnection failed: {str(e)}"
            self.connection_status = "Disconnected"
            self.send_status_to_browser()
            return False

                                'type': 'audio',
                                'data': audio_base64,
                                'sampleRate': self.server_sample_rate,
                                'preserveQuality': True,
                                'format': 'int16', 
                                'channels': 1,
                                'bitDepth': 16
                            }

                            try:
                                self.browser_ws.send(json.dumps(message))
                            except Exception as e:
                                logger.error(f"Error sending buffered audio: {e}")

                        # Short sleep to prevent CPU hogging
                        time.sleep(0.01)
                else:
                    time.sleep(0.05)

                # Prevent buffer from growing too large during silence
                if len(self.audio_buffer) > self.max_buffer_length:
                    self.audio_buffer = self.audio_buffer[-self.max_buffer_length:]

            except Exception as e:
                if self.running:
                    logger.error(f"Error processing audio: {e}", exc_info=True)
                    # Reset buffer on error to avoid accumulating bad data
                    self.audio_buffer = []

    def send_audio_to_ai(self, audio_data_base64):
        """Send audio data from browser to Sesame AI"""
        if not self.ws or not self.ws.is_connected():
            return False

        try:
            # Decode base64 audio data
            audio_data = base64.b64decode(audio_data_base64)

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

    # If proxy is running but AI is not connected, try to reconnect
    if proxy.running and (not proxy.ws or not proxy.ws.is_connected()):
        logger.info("Session exists but AI connection is down. Attempting reconnection.")
        proxy.reconnect_to_ai()

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
                    elif command == 'reconnect':
                        # Handle explicit reconnection request
                        success = proxy.reconnect_to_ai()
                        ws.send(json.dumps({
                            'type': 'reconnect_result',
                            'success': success
                        }))
            except json.JSONDecodeError:
                logger.warning(f"Received invalid JSON: {message}")
            except Exception as e:
                logger.error(f"Error processing message: {e}", exc_info=True)

    except Exception as e:
        logger.info(f"WebSocket connection closed: {e}")
    finally:
        # Mark client as disconnected
        proxy.client_connected = False
