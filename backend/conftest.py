"""
backend/conftest.py  (root-level, loaded first by pytest)
Sets a fast scrypt work-factor before any app module is imported, so the
test suite doesn't hang on password hashing/verification.
Production keeps n=16384 (overridable via FIELDSYNC_SCRYPT_N env var).
"""
import os

# Must be set before `app.auth` is imported, since _SCRYPT_N is a module-level const.
os.environ.setdefault("FIELDSYNC_SCRYPT_N", "1024")

