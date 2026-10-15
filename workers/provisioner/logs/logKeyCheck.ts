// @ts-nocheck
// Boot-time check that stored-log encryption is usable.
//
// The segment writer loads NORA_LOG_ENCRYPTION_KEY lazily, on the first flush
// (see worker.ts), so a missing or malformed key does not stop the worker and
// the healthcheck stays green. The only signal is one error per flush attempt
// roughly every 15 minutes. This lets the worker say so once, at startup.

const { loadLogEncryptionKeys } = require("./segmentWriter");

/**
 * Returns a human-readable reason log segments cannot be encrypted with the
 * current environment, or null when the key ring loads cleanly.
 */
function logEncryptionKeyProblem(env = process.env) {
  try {
    loadLogEncryptionKeys(env);
    return null;
  } catch (error) {
    return error.message;
  }
}

module.exports = { logEncryptionKeyProblem };
