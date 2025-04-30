
import os
import logging
from app import app

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger('sesame.main')

# Make app available for gunicorn
application = app

# Add startup message with audio settings info
logger.info("Starting Sesame AI Voice Chat application")
logger.info("Audio settings loaded from static/js/audio-settings.js")

if __name__ == "__main__":
    # Get port from environment variable or default to 5000
    port = int(os.environ.get("PORT", 5000))
    logger.info(f"Starting web server on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
