// @ts-nocheck

function isMutableNemoClawImageReference(image) {
  const reference = String(image || "").trim();
  if (!reference || reference.includes("@")) return false;
  const lastSlash = reference.lastIndexOf("/");
  const tagSeparator = reference.lastIndexOf(":");
  if (tagSeparator <= lastSlash) return true;
  return reference.slice(tagSeparator + 1).toLowerCase() === "latest";
}

async function pullNemoClawImage(docker, image, log) {
  log(`Pulling image ${image}...`);
  await new Promise((resolve, reject) => {
    docker.pull(image, (error, stream) => {
      if (error) return reject(error);
      docker.modem.followProgress(stream, (progressError) => {
        if (progressError) return reject(progressError);
        log(`Image ${image} pulled successfully`);
        resolve();
      });
    });
  });
}

async function ensureNemoClawImage({ docker, image, state, log = () => {} } = {}) {
  if (!docker || !state) throw new Error("docker and state are required");
  if (state.pending) return state.pending;

  state.pending = (async () => {
    let imagePresent = false;
    try {
      await docker.getImage(image).inspect();
      imagePresent = true;
    } catch {
      // Pull below when the configured image is not present.
    }

    if (imagePresent && (!isMutableNemoClawImageReference(image) || state.refreshed)) {
      log(`Image ${image} already present`);
      return;
    }

    await pullNemoClawImage(docker, image, log);
    state.refreshed = true;
  })();

  try {
    await state.pending;
  } catch (error) {
    state.pending = null;
    throw error;
  }
  state.pending = null;
}

module.exports = {
  ensureNemoClawImage,
  isMutableNemoClawImageReference,
};
