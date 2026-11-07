"use strict";

const STORAGE_SCHEMA_VERSION = 2;
const PROFILE_CONFIG_KEY = "profileConfig";
const CONFIG_UPDATE_LOCK = "immich-image2image-profile-config";

let configInitializationPromise = null;

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Profile configuration is invalid.");
  }

  if (config.schemaVersion !== STORAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported profile storage schema: ${config.schemaVersion}.`);
  }

  if (!Array.isArray(config.profiles)) {
    throw new Error("Profile configuration has no valid profiles list.");
  }

  const ids = new Set();

  for (const profile of config.profiles) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("Profile configuration contains an invalid profile.");
    }

    if (typeof profile.id !== "string" || !profile.id.trim() || ids.has(profile.id)) {
      throw new Error("Profile configuration contains a missing or duplicate profile ID.");
    }

    if (typeof profile.name !== "string" || !profile.name.trim()) {
      throw new Error(`Profile ${profile.id} has no valid display name.`);
    }

    if (typeof profile.serverUrl !== "string" || typeof profile.apiKey !== "string") {
      throw new Error(`Profile ${profile.id} has invalid server or API key settings.`);
    }

    if (profile.immichUserId !== null && typeof profile.immichUserId !== "string") {
      throw new Error(`Profile ${profile.id} has an invalid verified user ID.`);
    }

    if (typeof profile.albumId !== "string") {
      throw new Error(`Profile ${profile.id} has an invalid album ID.`);
    }

    ids.add(profile.id);
  }

  if (config.profiles.length === 0) {
    if (config.activeProfileId !== null) {
      throw new Error("An empty profile list must not have an active profile.");
    }
  } else if (
    typeof config.activeProfileId !== "string" ||
    !ids.has(config.activeProfileId)
  ) {
    throw new Error("The active profile does not exist. Select a valid profile in Settings.");
  }

  return config;
}

function cloneConfig(config) {
  return {
    ...config,
    profiles: config.profiles.map(profile => ({ ...profile }))
  };
}

function valuesEqual(left, right) {
  if (left === right) return true;

  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  if (Array.isArray(left) !== Array.isArray(right)) return false;

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  if (leftKeys.length !== rightKeys.length) return false;

  for (let i = 0; i < leftKeys.length; i++) {
    if (leftKeys[i] !== rightKeys[i]) return false;

    const key = leftKeys[i];
    if (!valuesEqual(left[key], right[key])) return false;
  }

  return true;
}

async function loadConfig() {
  if (!configInitializationPromise) {
    configInitializationPromise = initializeConfig().catch(error => {
      configInitializationPromise = null;
      throw error;
    });
  }

  await configInitializationPromise;

  const saved = await chrome.storage.local.get(PROFILE_CONFIG_KEY);

  if (saved[PROFILE_CONFIG_KEY] === undefined) {
    throw new Error("Profile configuration is missing after initialization.");
  }

  return validateConfig(saved[PROFILE_CONFIG_KEY]);
}

async function initializeConfig() {
  const locks = globalThis.navigator?.locks;

  if (!locks || typeof locks.request !== "function") {
    throw new Error(
      "Safe profile initialization requires browser Web Locks support. No settings were changed."
    );
  }

  return locks.request("immich-image2image-profile-migration", async () => {
    const saved = await chrome.storage.local.get(PROFILE_CONFIG_KEY);

    if (saved[PROFILE_CONFIG_KEY] !== undefined) {
      return validateConfig(saved[PROFILE_CONFIG_KEY]);
    }

    return migrateLegacyConfig();
  });
}

async function migrateLegacyConfig() {
  const legacy = await chrome.storage.local.get([
    "serverUrl",
    "apiKey",
    "albumId"
  ]);

  const hasLegacySettings = ["serverUrl", "apiKey", "albumId"].some(
    key => legacy[key] !== undefined
  );

  const profiles = [];

  if (hasLegacySettings) {
    profiles.push({
      id: "legacy-default",
      name: "Legacy account",
      serverUrl: typeof legacy.serverUrl === "string" ? legacy.serverUrl : "",
      apiKey: typeof legacy.apiKey === "string" ? legacy.apiKey : "",
      immichUserId: null,
      albumId: typeof legacy.albumId === "string" ? legacy.albumId : ""
    });
  }

  const config = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    profiles,
    activeProfileId: profiles.length ? profiles[0].id : null
  };

  validateConfig(config);

  await chrome.storage.local.set({
    [PROFILE_CONFIG_KEY]: config
  });

  const verification = await chrome.storage.local.get(PROFILE_CONFIG_KEY);

  if (!verification[PROFILE_CONFIG_KEY]) {
    throw new Error("Profile migration could not be verified after saving.");
  }

  return validateConfig(verification[PROFILE_CONFIG_KEY]);
}

async function updateConfig(mutator) {
  if (typeof mutator !== "function") {
    throw new Error("Configuration update requires a mutation function.");
  }

  await loadConfig();

  const locks = globalThis.navigator?.locks;

  if (!locks || typeof locks.request !== "function") {
    throw new Error(
      "Safe configuration updates require browser Web Locks support. No settings were changed."
    );
  }

  return locks.request(CONFIG_UPDATE_LOCK, async () => {
    const saved = await chrome.storage.local.get(PROFILE_CONFIG_KEY);

    if (saved[PROFILE_CONFIG_KEY] === undefined) {
      throw new Error("Profile configuration is missing. No update was applied.");
    }

    const latest = validateConfig(saved[PROFILE_CONFIG_KEY]);
    const draft = cloneConfig(latest);
    const result = mutator(draft);

    if (result && typeof result.then === "function") {
      throw new Error("Configuration mutation callbacks must be synchronous.");
    }

    validateConfig(draft);

    const intended = cloneConfig(draft);

    await chrome.storage.local.set({
      [PROFILE_CONFIG_KEY]: intended
    });

    const verification = await chrome.storage.local.get(PROFILE_CONFIG_KEY);

    if (verification[PROFILE_CONFIG_KEY] === undefined) {
      throw new Error("Profile configuration could not be verified after saving.");
    }

    const verified = validateConfig(verification[PROFILE_CONFIG_KEY]);

    if (!valuesEqual(intended, verified)) {
      throw new Error(
        "Profile configuration changed unexpectedly during verification. Reload Settings before continuing."
      );
    }

    return cloneConfig(verified);
  });
}

function getActiveProfile(config) {
  validateConfig(config);

  if (config.activeProfileId === null) {
    return null;
  }

  const profile = config.profiles.find(
    item => item.id === config.activeProfileId
  );

  if (!profile) {
    throw new Error("The active profile could not be found. Select a profile in Settings.");
  }

  return profile;
}
