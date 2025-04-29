"""
This file provides wrappers for Sesame AI APIs, handling all imports correctly
for better compatibility when running locally.
"""

import os
import sys
import json
import base64
import time
import random
import uuid
import urllib.parse
import logging
import queue
import threading
import ssl
import requests
import websocket as websocket_module
from datetime import datetime

logger = logging.getLogger('sesame.wrapper')

# Paths for file operations
HOME_DIR = os.path.expanduser("~")
TOKEN_FILE_PATH = os.path.join(HOME_DIR, '.sesame_tokens.json')

# API Constants
DEFAULT_API_KEY = "AIzaSyDtC7Uwb5pGAsdmrH2T4Gqdk5Mga07jYPM"
FIREBASE_AUTH_BASE_URL = "https://identitytoolkit.googleapis.com/v1/accounts"
FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token"

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

# Helper functions
def get_firebase_client_header():
    """Generate the x-firebase-client header value"""
    x_firebase_client = {
        "version": 2,
        "heartbeats": [
            {
                "agent": "fire-core/0.11.1 fire-core-esm2017/0.11.1 fire-js/ fire-js-all-app/11.3.1 fire-auth/1.9.0 fire-auth-esm2017/1.9.0",
                "dates": [f"{datetime.now().strftime('%Y-%m-%d')}"]
            }
        ]
    }
    x_firebase_client_json = json.dumps(x_firebase_client, separators=(",", ":"))
    return base64.b64encode(x_firebase_client_json.encode()).decode()

def get_user_agent():
    """Get the standard user agent string"""
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

def get_headers(request_type):
    """Get headers for API requests"""
    common_headers = {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'user-agent': get_user_agent(),
        'x-firebase-client': get_firebase_client_header(),
        'x-client-data': 'COKQywE=',
        'x-client-version': 'Chrome/JsCore/11.3.1/FirebaseCore-web',
        'x-firebase-gmpid': '1:1072000975600:web:75b0bf3a9bb8d92e767835',
    }
    return common_headers

def get_params(request_type, api_key=None):
    """Get URL parameters for API requests"""
    key = api_key if api_key else DEFAULT_API_KEY
    return {'key': key}

def get_endpoint_url(request_type):
    """Get the full URL for a specific request type"""
    if request_type == 'refresh':
        return FIREBASE_TOKEN_URL
    else:
        endpoint = 'signUp' if request_type == 'signup' else request_type
        return f"{FIREBASE_AUTH_BASE_URL}:{endpoint}"

# Response models
class BaseResponse:
    """Base class for API responses"""
    def __init__(self, response_json):
        self.raw_response = response_json
    
    def __repr__(self):
        class_name = self.__class__.__name__
        attributes = ', '.join(f"{k}={v}" for k, v in self.__dict__.items() 
                              if k != 'raw_response' and not k.startswith('_'))
        return f"{class_name}({attributes})"

class SignupResponse(BaseResponse):
    """Response from the signup endpoint"""
    def __init__(self, response_json):
        super().__init__(response_json)
        self.kind = response_json.get('kind')
        self.id_token = response_json.get('idToken')
        self.refresh_token = response_json.get('refreshToken')
        self.expires_in = response_json.get('expiresIn')
        self.local_id = response_json.get('localId')

class RefreshTokenResponse(BaseResponse):
    """Response from the token refresh endpoint"""
    def __init__(self, response_json):
        super().__init__(response_json)
        self.access_token = response_json.get('access_token')
        self.expires_in = response_json.get('expires_in')
        self.token_type = response_json.get('token_type')
        self.refresh_token = response_json.get('refresh_token')
        self.id_token = response_json.get('id_token')
        self.user_id = response_json.get('user_id')
        self.project_id = response_json.get('project_id')

class LookupResponse(BaseResponse):
    """Response from the account lookup endpoint"""
    def __init__(self, response_json):
        super().__init__(response_json)
        self.kind = response_json.get('kind')
        
        # Extract users data if available
        users = response_json.get('users', [])
        if users and len(users) > 0:
            user = users[0]
            self.local_id = user.get('localId')
            self.last_login_at = user.get('lastLoginAt')
            self.created_at = user.get('createdAt')
            self.last_refresh_at = user.get('lastRefreshAt')

# API Client
class SesameAI:
    """SesameAI API Client"""
    
    def __init__(self, api_key=None):
        """
        Initialize the SesameAI API client
        
        Args:
            api_key (str, optional): Firebase API key. If not provided, 
                                     will use the default key from config.
        """
        self.api_key = api_key
    
    def _make_auth_request(self, request_type, payload, is_form_data=False):
        """
        Make a request to the Firebase Authentication API
        
        Args:
            request_type (str): Type of request ('signup', 'lookup', etc.)
            payload (dict): Request payload
            is_form_data (bool): Whether payload should be sent as form data
            
        Returns:
            dict: API response as JSON
            
        Raises:
            NetworkError: If a network error occurs
            APIError: If the API returns an error response
            InvalidTokenError: If a token is invalid
        """
        headers = get_headers(request_type)
        params = get_params(request_type, self.api_key)
        url = get_endpoint_url(request_type)
        
        try:
            if is_form_data:
                response = requests.post(
                    url,
                    params=params,
                    headers=headers,
                    data=payload,
                )
            else:
                response = requests.post(
                    url,
                    params=params,
                    headers=headers,
                    json=payload,
                )
            
            # Check for HTTP errors
            response.raise_for_status()
            
            # Parse the response
            response_json = response.json()
            
            # Check for API errors
            if 'error' in response_json:
                self._handle_api_error(response_json['error'])
                
            return response_json
            
        except requests.exceptions.RequestException as e:
            raise NetworkError(f"Network error: {str(e)}")
    
    def _handle_api_error(self, error):
        """
        Handle API error responses
        
        Args:
            error (dict): Error information from API
            
        Raises:
            InvalidTokenError: If a token is invalid
            APIError: For other API errors
        """
        error_code = error.get('code', 400)
        error_message = error.get('message', 'Unknown error')
        error_details = error.get('errors', [])
        
        # Handle specific error types
        if error_message in ('INVALID_ID_TOKEN', 'INVALID_REFRESH_TOKEN'):
            raise InvalidTokenError()
        
        # Generic API error
        raise APIError(error_code, error_message, error_details)
    
    def create_anonymous_account(self):
        """
        Create an anonymous account
        
        Returns:
            SignupResponse: Object containing authentication tokens
            
        Raises:
            NetworkError: If a network error occurs
            APIError: If the API returns an error response
        """
        payload = {
            'returnSecureToken': True,
        }
        response_json = self._make_auth_request('signup', payload)
        return SignupResponse(response_json)
    
    def refresh_authentication_token(self, refresh_token):
        """
        Refresh an ID token using a refresh token
        
        Args:
            refresh_token (str): Firebase refresh token
            
        Returns:
            RefreshTokenResponse: Object containing new tokens
            
        Raises:
            NetworkError: If a network error occurs
            APIError: If the API returns an error response
            InvalidTokenError: If the refresh token is invalid
        """
        payload = {
            'grant_type': 'refresh_token',
            'refresh_token': refresh_token
        }
        
        response_json = self._make_auth_request('refresh', payload, is_form_data=True)
        return RefreshTokenResponse(response_json)
        
    def get_account_info(self, id_token):
        """
        Get account information using an ID token
        
        Args:
            id_token (str): Firebase ID token
            
        Returns:
            LookupResponse: Object containing account information
            
        Raises:
            NetworkError: If a network error occurs
            APIError: If the API returns an error response
            InvalidTokenError: If the ID token is invalid
        """
        payload = {
            'idToken': id_token
        }
        
        response_json = self._make_auth_request('lookup', payload)
        return LookupResponse(response_json)

# Token Manager
class TokenManager:
    """
    Manages authentication tokens for SesameAI API
    
    Handles:
    - Token storage and retrieval
    - Token validation
    - Automatic token refresh
    """
    
    def __init__(self, api_client=None, token_file=None):
        """
        Initialize the token manager
        
        Args:
            api_client (SesameAI, optional): API client instance. If None, creates a new one.
            token_file (str, optional): Path to token storage file.
        """
        self.api_client = api_client if api_client else SesameAI()
        self.token_file = token_file if token_file else TOKEN_FILE_PATH
        self.tokens = self._load_tokens()
    
    def _load_tokens(self):
        """
        Load tokens from storage file
        
        Returns:
            dict: Token data or empty dict if file doesn't exist
        """
        if self.token_file and os.path.exists(self.token_file):
            try:
                with open(self.token_file, 'r') as f:
                    logger.debug(f"Loading tokens from {self.token_file}")
                    return json.load(f)
            except (json.JSONDecodeError, IOError) as e:
                logger.warning(f"Failed to load tokens: {e}")
                return {}
        return {}
    
    def _save_tokens(self):
        """Save tokens to storage file"""
        try:
            # If no token file is specified, use default
            if not self.token_file:
                self.token_file = TOKEN_FILE_PATH
                
            # Make sure the directory exists
            directory = os.path.dirname(self.token_file)
            if directory:  # Only try to create directory if there is one
                os.makedirs(directory, exist_ok=True)
            
            # Write the tokens to the file
            with open(self.token_file, 'w') as f:
                logger.debug(f"Saving tokens to {self.token_file}")
                json.dump(self.tokens, f)
                logger.debug(f"Tokens successfully saved to {self.token_file}")
        except Exception as e:
            logger.warning(f"Could not save tokens: {e}", exc_info=True)
    
    def _is_token_expired(self, id_token):
        """
        Check if an ID token is expired
        
        Args:
            id_token (str): Firebase ID token
            
        Returns:
            bool: True if token is expired or invalid
        """
        try:
            # Try to look up the token
            self.api_client.get_account_info(id_token)
            return False
        except InvalidTokenError:
            return True
        except (NetworkError, APIError) as e:
            # If lookup fails, raise the error
            raise e
    
    def get_valid_token(self, force_new=False):
        """
        Get a valid ID token, refreshing if necessary
        
        Args:
            force_new (bool): If True, creates a new account regardless of existing tokens
            
        Returns:
            str: Valid ID token
            
        Raises:
            InvalidTokenError: If token refresh fails
            NetworkError: If a network error occurs
            APIError: If the API returns an error
        """
        # If force_new is True, create a new account
        if force_new:
            logger.debug("Forcing creation of new account")
            return self._create_new_account()
            
        # Check if we have an existing ID token
        id_token = self.tokens.get('id_token')
        refresh_token = self.tokens.get('refresh_token')
        
        if id_token:
            # Check if the token is still valid
            try:
                logger.debug("Checking if existing token is valid")
                if not self._is_token_expired(id_token):
                    logger.info("Using existing valid token")
                    return id_token
            except (NetworkError, APIError) as e:
                logger.warning(f"Error checking token validity: {e}")
                # If we can't check, assume it's still valid
                return id_token
            
            # Token is expired, try to refresh
            if refresh_token:
                try:
                    logger.info("Refreshing expired token")
                    refresh_response = self.api_client.refresh_authentication_token(refresh_token)
                    
                    # Update tokens
                    self.tokens = {
                        'id_token': refresh_response.id_token,
                        'refresh_token': refresh_response.refresh_token,
                        'user_id': refresh_response.user_id,
                        'expires_in': refresh_response.expires_in,
                        'timestamp': int(time.time())
                    }
                    self._save_tokens()
                    
                    logger.info("Token refreshed successfully")
                    return refresh_response.id_token
                except (InvalidTokenError, NetworkError, APIError) as e:
                    logger.error(f"Token refresh failed: {e}")
                    raise InvalidTokenError()
            else:
                logger.warning("Token expired and no refresh token available")
                raise InvalidTokenError()
        else:
            # No existing token, create a new account
            logger.debug("No existing token, creating new account")
            return self._create_new_account()

    def _create_new_account(self):
        """
        Create a new anonymous account
        
        Returns:
            str: New ID token
            
        Raises:
            NetworkError: If a network error occurs
            APIError: If the API returns an error
        """
        logger.debug("Creating new anonymous account")
        signup_response = self.api_client.create_anonymous_account()
        
        # Save the new tokens
        self.tokens = {
            'id_token': signup_response.id_token,
            'refresh_token': signup_response.refresh_token,
            'user_id': signup_response.local_id,
            'expires_in': signup_response.expires_in,
            'timestamp': int(time.time())
        }
        self._save_tokens()
        
        logger.debug("New account created successfully")
        return signup_response.id_token

    def clear_tokens(self):
        """Clear stored tokens"""
        logger.info("Clearing stored tokens")
        self.tokens = {}
        self._save_tokens()

# WebSocket Client
class SesameWebSocket:
    """
    WebSocket client for real-time communication with SesameAI
    """
    
    def __init__(self, id_token, character="Miles", client_name="RP-Web"):
        """
        Initialize the WebSocket client
        
        Args:
            id_token (str): Firebase ID token for authentication
            character (str, optional): Character to interact with. Defaults to "Miles".
            client_name (str, optional): Client identifier. Defaults to "RP-Web".
        """
        self.id_token = id_token
        self.character = character
        self.client_name = client_name
        
        # WebSocket connection
        self.ws = None
        self.session_id = None
        self.call_id = None
        
        # Audio settings
        self.client_sample_rate = 16000
        self.server_sample_rate = 24000  # Default, will be updated from server
        self.audio_codec = "none"
        
        # Connection state
        self.reconnect = False
        self.is_private = False
        self.user_agent = get_user_agent()
        
        # Audio buffer for received audio
        self.audio_buffer = queue.Queue(maxsize=1000)
        
        # Message tracking
        self.last_sent_message_type = None
        self.received_since_last_sent = False
        self.first_audio_received = False
        
        # Event for tracking connection state
        self.connected_event = threading.Event()
        
        # Callbacks
        self.on_connect_callback = None
        self.on_disconnect_callback = None
    
    def connect(self, blocking=True):
        """
        Connect to the SesameAI WebSocket server
        
        Args:
            blocking (bool, optional): If True, blocks until connected. Defaults to True.
            
        Returns:
            bool: True if connection was successful
        """
        # Reset connection state
        self.connected_event.clear()
        
        # Start connection in a separate thread
        connection_thread = threading.Thread(target=self._connect_websocket)
        connection_thread.daemon = True
        connection_thread.start()
        
        if blocking:
            # Wait for connection to be established
            return self.connected_event.wait(timeout=10)
        
        return True
    
    def _connect_websocket(self):
        """Internal method to establish WebSocket connection"""
        headers = {
            'Origin': 'https://www.sesame.com',
            'User-Agent': self.user_agent,
        }

        params = {
            'id_token': self.id_token,
            'client_name': self.client_name,
            'usercontext': json.dumps({"timezone": "America/Chicago"}),
            'character': self.character,
        }

        # Construct the WebSocket URL with query parameters
        base_url = 'wss://sesameai.app/agent-service-0/v1/connect'
        
        # Convert params to URL query string
        query_string = '&'.join([f"{key}={urllib.parse.quote(value)}" for key, value in params.items()])
        ws_url = f"{base_url}?{query_string}"
        
        # Create WebSocket connection
        self.ws = websocket_module.WebSocketApp(
            ws_url,
            header=headers,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close
        )

        # Run the WebSocket
        self.ws.run_forever(
            sslopt={"cert_reqs": ssl.CERT_NONE}, 
            skip_utf8_validation=True,
            suppress_origin=False
        )
    
    def _on_open(self, ws):
        """Callback when WebSocket connection is opened"""
        logger.debug("WebSocket connection opened")
    
    def _on_message(self, ws, message):
        """Callback when a message is received from the WebSocket"""
        try:
            # Parse the message as JSON
            data = json.loads(message)
            
            # Handle different message types
            message_type = data.get('type')
            
            if message_type == 'initialize':
                self._handle_initialize(data)
            elif message_type == 'call_connect_response':
                self._handle_call_connect_response(data)
            elif message_type == 'ping_response':
                self._handle_ping_response(data)
            elif message_type == 'audio':
                self._handle_audio(data)
            elif message_type == 'call_disconnect_response':
                self._handle_call_disconnect_response(data)
            else:
                logger.debug(f"Received message type: {message_type}")
                
        except json.JSONDecodeError:
            logger.warning(f"Received non-JSON message: {message}")
        except Exception as e:
            logger.error(f"Error handling message: {e}", exc_info=True)
    
    def _on_error(self, ws, error):
            """Callback when a WebSocket error occurs"""
            logger.error(f"WebSocket error: {error}")
            self.connected_event.clear()
    
    def _on_close(self, ws, close_status_code, close_msg):
        """Callback when the WebSocket connection is closed"""
        logger.debug(f"WebSocket closed: {close_status_code} - {close_msg}")
        self.connected_event.clear()
        
        # Call the disconnect callback if set
        if self.on_disconnect_callback:
            self.on_disconnect_callback()
    
    # Message handlers
    def _handle_initialize(self, data):
        """Handle initialize message from server"""
        self.session_id = data.get('session_id')
        logger.debug(f"Session ID: {self.session_id}")

        # Send location and call_connect
        self._send_client_location_state()
        self._send_call_connect()
    
    def _handle_call_connect_response(self, data):
        """Handle call_connect_response message from server"""
        self.session_id = data.get('session_id')
        self.call_id = data.get('call_id')
        content = data.get('content', {})
        self.server_sample_rate = content.get('sample_rate', self.server_sample_rate)
        self.audio_codec = content.get('audio_codec', 'none')

        logger.debug(f"Connected: Session ID: {self.session_id}, Call ID: {self.call_id}")
        
        # Signal that we're connected
        self.connected_event.set()
        
        # Call the connect callback if set
        if self.on_connect_callback:
            self.on_connect_callback()
    
    
    def _handle_ping_response(self, data):
        """Handle ping_response message from server"""
        pass
    
    def _handle_audio(self, data):
        """Handle audio message from server"""
        audio_data = data.get('content', {}).get('audio_data', '')
        if audio_data:
            try:
                audio_bytes = base64.b64decode(audio_data)
                # Use put_nowait to avoid blocking if buffer is full
                # This prevents audio processing delays
                try:
                    self.audio_buffer.put_nowait(audio_bytes)
                except queue.Full:
                    # If buffer is full, discard oldest audio to make room
                    try:
                        self.audio_buffer.get_nowait()
                        self.audio_buffer.put_nowait(audio_bytes)
                    except queue.Empty:
                        pass
                
                if not self.first_audio_received:
                    self.first_audio_received = True
                    logger.debug("First audio received, sending initialization chunks")
                    # Send 2 all-A chunks to initialize audio stream
                    chunk_of_As = "A" * 1707 + "="
                    self._send_audio(chunk_of_As)
                    self._send_audio(chunk_of_As)
            except Exception as e:
                logger.error(f"Error processing audio: {e}", exc_info=True)
    
    def _handle_call_disconnect_response(self, data):
        """Handle call_disconnect_response message from server"""
        logger.debug("Call disconnected")
        self.call_id = None
        
        # Call the disconnect callback if set
        if self.on_disconnect_callback:
            self.on_disconnect_callback()
    
    # Methods to send messages
    def _send_ping(self):
        """Send ping message to server"""
        if not self.session_id:
            return

        message = {
            "type": "ping",
            "session_id": self.session_id,
            "call_id": self.call_id,
            "request_id": self._generate_request_id(),
            "content": "ping"
        }

        self._send_data(message)
    
    def _send_client_location_state(self):
        """Send client_location_state message to server"""
        if not self.session_id:
            return

        message = {
            "type": "client_location_state",
            "session_id": self.session_id,
            "call_id": None,
            "content": {
                "latitude": 0,
                "longitude": 0,
                "address": "",
                "timezone": "America/Chicago"
            }
        }
        self._send_data(message)
    
    def _send_audio(self, data):
        """
        Send audio data to server
        
        Args:
            data (str): Base64-encoded audio data
        """
        if not self.session_id or not self.call_id:
            return

        message = {
            "type": "audio",
            "session_id": self.session_id,
            "call_id": self.call_id,
            "content": {
                "audio_data": data
            }
        }

        self._send_data(message)
    
    def _send_call_connect(self):
        """Send call_connect message to server"""
        if not self.session_id:
            return
            
        message = {
            "type": "call_connect",
            "session_id": self.session_id,
            "call_id": None,
            "request_id": self._generate_request_id(),
            "content": {
                "sample_rate": self.client_sample_rate,
                "audio_codec": "none",
                "reconnect": self.reconnect,
                "is_private": self.is_private,
                "client_name": self.client_name,
                "settings": {
                    "preset": f"{self.character}"
                },
                "client_metadata": {
                    "language": "en-US",
                    "user_agent": self.user_agent,
                    "mobile_browser": False,
                    "media_devices": self._get_media_devices()
                }
            }
        }
        
        self._send_data(message)
    
    def send_audio_data(self, raw_audio_bytes):
        """
        Send raw audio data to the AI
        
        Args:
            raw_audio_bytes (bytes): Raw audio data (16-bit PCM)
            
        Returns:
            bool: True if audio was sent successfully
        """
        if not self.session_id or not self.call_id:
            return False
            
        # Encode the raw audio data in base64
        encoded_data = base64.b64encode(raw_audio_bytes).decode('utf-8')
        self._send_audio(encoded_data)
        return True
    
    def disconnect(self):
        """
        Disconnect from the server
        
        Returns:
            bool: True if disconnect message was sent successfully
        """
        if not self.session_id or not self.call_id:
            logger.warning("Cannot disconnect: Not connected")
            return False
            
        message = {
            "type": "call_disconnect",
            "session_id": self.session_id,
            "call_id": self.call_id,
            "request_id": self._generate_request_id(),
            "content": {
                "reason": "user_request"
            }
        }
        
        logger.debug("Sending disconnect request")
        self._send_data(message)
        return True
    
    def _send_message(self, message):
        """Send a raw message to the WebSocket"""
        if not self.ws:
            logger.warning("Cannot send message: WebSocket not connected")
            return False
        
        try:
            message_json = json.dumps(message)
            self.ws.send(message_json)
            return True
        except Exception as e:
            logger.error(f"Error sending message: {e}", exc_info=True)
            return False
    
    def _send_data(self, message):
        """Send data with proper message tracking"""
        self.last_sent_message_type = message['type']
        self.received_since_last_sent = False
        self._send_message(message)
    
    def _generate_request_id(self):
        """Generate a unique request ID"""
        return str(uuid.uuid4())
    
    def _get_media_devices(self):
        """Get a list of media devices for the client metadata"""
        return {
            "audioinput": ["default"],
            "audiooutput": ["default"],
            "videoinput": []
        }
    
    def get_next_audio_chunk(self, timeout=None):
        """
        Get the next audio chunk from the buffer
        
        Args:
            timeout (float, optional): Timeout in seconds. None means block indefinitely.
            
        Returns:
            bytes: Audio data, or None if timeout occurred
        """
        try:
            return self.audio_buffer.get(timeout=timeout)
        except queue.Empty:
            return None
    
    def set_connect_callback(self, callback):
        """
        Set callback for connection established events
        
        Args:
            callback (callable): Function with no arguments
        """
        self.on_connect_callback = callback
    
    def set_disconnect_callback(self, callback):
        """
        Set callback for disconnection events
        
        Args:
            callback (callable): Function with no arguments
        """
        self.on_disconnect_callback = callback
    
    def is_connected(self):
        """
        Check if the WebSocket is connected
        
        Returns:
            bool: True if connected
        """
        return self.session_id is not None and self.call_id is not None