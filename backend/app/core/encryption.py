import base64
import os
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from app.core.config import settings

def encrypt_password(plain_password: str) -> str:
    # Upgrade to AES-256-GCM
    key_bytes = base64.urlsafe_b64decode(settings.ENCRYPTION_KEY)
    aesgcm = AESGCM(key_bytes)
    nonce = os.urandom(12)
    ciphertext = aesgcm.encrypt(nonce, plain_password.encode(), None)
    # Format: v1:nonce_base64:ciphertext_base64
    nonce_b64 = base64.b64encode(nonce).decode()
    ciphertext_b64 = base64.b64encode(ciphertext).decode()
    return f"v1:{nonce_b64}:{ciphertext_b64}"

def decrypt_password(encrypted_password: str) -> str:
    if encrypted_password.startswith("v1:"):
        try:
            parts = encrypted_password.split(":")
            if len(parts) == 3:
                nonce = base64.b64decode(parts[1])
                ciphertext = base64.b64decode(parts[2])
                key_bytes = base64.urlsafe_b64decode(settings.ENCRYPTION_KEY)
                aesgcm = AESGCM(key_bytes)
                return aesgcm.decrypt(nonce, ciphertext, None).decode()
        except Exception as e:
            raise ValueError(f"AES-256-GCM Decryption failed: {e}")

    # Fallback to Fernet for legacy passwords
    try:
        key = settings.ENCRYPTION_KEY
        if isinstance(key, str):
            key = key.encode()
        f = Fernet(key)
        return f.decrypt(encrypted_password.encode()).decode()
    except Exception as e:
        raise ValueError(f"Fernet Decryption failed: {e}")

