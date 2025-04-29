"""
Simplified module with mock implementations of the Sesame AI classes
for demo purposes in the web application
"""

import threading
import queue
import logging
import time
import random
import numpy as np

logger = logging.getLogger('sesame.mock')

# Exceptions
class SesameAIError(Exception):
    """Base exception for SesameAI API errors"""
    pass

class AuthenticationError(SesameAIError):
    """Raised when authentication fails"""
    pass

class APIError(SesameAIError):
    """Raised when the API returns an error response"""
    def __init__(self, code, message, errors=None):
        self.code = code
        self.message = message
        self.errors = errors or []
        super().__init__(f"API Error {code}: {message}")

class InvalidTokenError(AuthenticationError):
    """Raised when an ID token is invalid or expired"""
    def __init__(self):
        super().__init__("Invalid or expired ID token")

class NetworkError(SesameAIError):
    """Raised when network communication fails"""
    pass

# API Client
class SesameAI:
    """Mock SesameAI API Client"""
    
    def __init__(self, api_key=None):
        self.api_key = api_key
        
    def create_anonymous_account(self):
        """Create an anonymous account (mock)"""
        logger.info("Creating anonymous account (mock)")
        return {
            'kind': 'identitytoolkit#SignupNewUserResponse',
            'idToken': 'mock-id-token-' + str(random.randint(10000, 99999)),
            'refreshToken': 'mock-refresh-token-' + str(random.randint(10000, 99999)),
            'expiresIn': '3600',
            'localId': 'mock-user-' + str(random.randint(10000, 99999))
        }
    
    def refresh_authentication_token(self, refresh_token):
        """Refresh an ID token using a refresh token (mock)"""
        logger.info(f"Refreshing token (mock): {refresh_token[:10]}...")
        return {
            'access_token': 'mock-access-token-' + str(random.randint(10000, 99999)),
            'expires_in': '3600',
            'token_type': 'Bearer',
            'refresh_token': 'mock-refresh-token-' + str(random.randint(10000, 99999)),
            'id_token': 'mock-id-token-' + str(random.randint(10000, 99999)),
            'user_id': 'mock-user-' + str(random.randint(10000, 99999)),
            'project_id': 'mock-project'
        }
    
    def get_account_info(self, id_token):
        """Get account information using an ID token (mock)"""
        logger.info(f"Getting account info (mock): {id_token[:10]}...")
        return {
            'kind': 'identitytoolkit#GetAccountInfoResponse',
            'users': [{
                'localId': 'mock-user-' + str(random.randint(10000, 99999)),
                'lastLoginAt': str(int(time.time() * 1000)),
                'createdAt': str(int(time.time() * 1000) - 86400000),
                'lastRefreshAt': str(int(time.time() * 1000))
            }]
        }

# Token Manager
class TokenManager:
    """Manages authentication tokens for SesameAI API (mock)"""
    
    def __init__(self, api_client=None, token_file=None):
        self.api_client = api_client if api_client else SesameAI()
        self.token_file = token_file
        self.tokens = {}
    
    def get_valid_token(self, force_new=False):
        """Get a valid ID token (mock)"""
        if force_new or not self.tokens.get('id_token'):
            signup_response = self.api_client.create_anonymous_account()
            self.tokens = {
                'id_token': signup_response['idToken'],
                'refresh_token': signup_response['refreshToken'],
                'user_id': signup_response['localId'],
                'expires_in': signup_response['expiresIn'],
                'timestamp': int(time.time())
            }
        return self.tokens['id_token']
    
    def clear_tokens(self):
        """Clear stored tokens"""
        self.tokens = {}

# WebSocket Client
class SesameWebSocket:
    """WebSocket client for real-time communication with SesameAI (mock)"""
    
    def __init__(self, id_token, character="Miles", client_name="RP-Web"):
        self.id_token = id_token
        self.character = character
        self.client_name = client_name
        
        # Audio settings
        self.client_sample_rate = 16000
        self.server_sample_rate = 24000
        
        # Audio buffer for received audio
        self.audio_buffer = queue.Queue(maxsize=1000)
        
        # Connection state
        self.connected = False
        self.connected_event = threading.Event()
        
        # Callbacks
        self.on_connect_callback = None
        self.on_disconnect_callback = None
        
        # Mock audio generation thread
        self.mock_audio_thread = None
        self.running = False
    
    def connect(self, blocking=True):
        """Connect to the SesameAI WebSocket server (mock)"""
        logger.info(f"Connecting to mock SesameAI WebSocket as {self.character}")
        
        # Simulate connection delay
        time.sleep(1)
        
        # Set connected state
        self.connected = True
        self.connected_event.set()
        
        # Start mock audio generation
        self.running = True
        self.mock_audio_thread = threading.Thread(target=self._generate_mock_audio)
        self.mock_audio_thread.daemon = True
        self.mock_audio_thread.start()
        
        # Call the connect callback
        if self.on_connect_callback:
            self.on_connect_callback()
        
        return True
    
    def _generate_mock_audio(self):
        """Generate mock audio data"""
        logger.info("Starting mock audio generation")
        while self.running:
            # Generate some silence and some audio alternately
            if random.random() < 0.3:  # 30% chance of "speaking"
                # Generate ~1 second of mock audio (simulated speech)
                for _ in range(10):  # 10 chunks at ~100ms each
                    if not self.running:
                        break
                    
                    # Create a sine wave
                    duration = 0.1  # 100ms
                    samples = int(duration * self.server_sample_rate)
                    t = np.linspace(0, duration, samples, False)
                    
                    # Create a random tone
                    freq = random.uniform(200, 400)
                    amplitude = random.uniform(0.1, 0.3) * 32767  # Scale to 16-bit PCM range
                    
                    # Generate audio with variation
                    audio = amplitude * np.sin(2 * np.pi * freq * t)
                    audio = audio.astype(np.int16).tobytes()
                    
                    # Add to buffer
                    try:
                        self.audio_buffer.put_nowait(audio)
                    except queue.Full:
                        try:
                            self.audio_buffer.get_nowait()
                            self.audio_buffer.put_nowait(audio)
                        except queue.Empty:
                            pass
                    
                    time.sleep(0.1)
            else:
                # Pause between speech
                time.sleep(random.uniform(0.5, 2.0))
    
    def send_audio_data(self, raw_audio_bytes):
        """Send raw audio data (mock - just logs it)"""
        if not self.connected:
            return False
        
        # In a real implementation, this would send the audio to the server
        logger.debug(f"Mock: Sent {len(raw_audio_bytes)} bytes of audio")
        return True
    
    def disconnect(self):
        """Disconnect from the server (mock)"""
        logger.info("Disconnecting from mock WebSocket")
        self.running = False
        self.connected = False
        self.connected_event.clear()
        
        # Call the disconnect callback
        if self.on_disconnect_callback:
            self.on_disconnect_callback()
        
        return True
    
    def get_next_audio_chunk(self, timeout=None):
        """Get the next audio chunk from the buffer"""
        try:
            return self.audio_buffer.get(timeout=timeout)
        except queue.Empty:
            return None
    
    def set_connect_callback(self, callback):
        """Set callback for connection established events"""
        self.on_connect_callback = callback
    
    def set_disconnect_callback(self, callback):
        """Set callback for disconnection events"""
        self.on_disconnect_callback = callback
    
    def is_connected(self):
        """Check if the WebSocket is connected"""
        return self.connected